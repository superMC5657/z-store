# Issue 02: ETag Cache for GitHub Starred & Direct Repo Search, Plus Authenticated Trends `new` Board

Status: resolved
Blocked by: none

## Summary

Close three backend GitHub API quota, caching, and latency gaps across GitHub Star (`list_github_starred`), Online Direct Repo Search (`search_apps_online` `owner/repo`), and the Trends `new` board (`fetch_trends_text`):

1. **GitHub Starred pages lack `ETag Cache` & retry (`src-tauri/src/github/developer_starred.rs`)**:
   - `CatalogService::fetch_starred_page` currently performs a raw `client.get().send()` without `If-None-Match`, 429/5xx bounded retry (D7), or `api_etag_cache` persistence. Re-querying a user's Star list always downloads full 20-repo JSON payloads and deducts GitHub rate-limit quota.
2. **Online Search `owner/repo` direct lookup bypasses ETag, `app_details` backfill, and streaming icons (`src-tauri/src/commands/catalog_search.rs:361-424` & `src-tauri/src/github/search.rs:92-107, 356-366`)**:
   - Direct `owner/repo` lookup calls `fetch_online_repo` with `cached_etag = None, cached_payload = None`, discards the response ETag, skips `backfill_uncataloged_card` (losing cached `platforms` / concrete `latest_version` from `app_details`), and blocks first-paint RTT on synchronous `probe = true` icon probing.
3. **Trends `new` board hits GitHub Search API anonymously (`src-tauri/src/commands/network.rs:110`)**:
   - `fetch_trends_text` sends requests to `https://api.github.com/search/repositories?q=created:...` with only a browser User-Agent and no GitHub token, falling into GitHub Search API's 10 req/min anonymous rate limit instead of 30 req/min authenticated quota, and does not report `X-RateLimit-*` headers via `notify_rate_limit`.

## Scope

- `src-tauri/src/github/http.rs`
- `src-tauri/src/github/developer_starred.rs`
- `src-tauri/src/github/developer_starred_tests.rs`
- `src-tauri/src/commands/forge.rs`
- `src-tauri/src/commands/catalog_search.rs`
- `src-tauri/src/github/search.rs`
- `src-tauri/src/commands/network.rs`

## Implementation Details

### 1. Expose `get_with_etag_diag_with_link` (`src-tauri/src/github/http.rs`)

- Export `pub(crate) async fn get_with_etag_diag_with_link(...) -> (EtagGetOutcome, crate::log_support::HttpDiag, bool)` wrapping `get_with_etag_diag_inner`, so callers needing both `Link: rel="next"` pagination and HTTP status codes (`diag.status` for 403/404 user hints) use the unified D7 retry + ETag helper.

### 2. Add ETag conditional fetch & `has_more` preservation to `fetch_starred_page` (`src-tauri/src/github/developer_starred.rs` & `src-tauri/src/commands/forge.rs`)

- Update `parse_starred_payloads` to unwrap `{ "starred_at": ..., "repo": { ... } }` (`item.get("repo").unwrap_or(&item)`) as well as bare repo objects so both `v3+json` and `star+json` payloads parse identically.
- Add `fetch_starred_page_with_etag` on `CatalogService` (keep existing `fetch_starred_page` delegating with `None, None` so existing unit tests stay source-compatible):
  - Accept `cached_etag: Option<&str>` and `cached_payload: Option<&str>`, returning `Result<(StarredPage, StarredCacheEffect), String>` where `StarredCacheEffect` indicates `Save { url, etag, payload_json }`, `Touch { url }`, or `None`.
  - Encode cached page envelopes as `{"has_more": bool, "items": <raw JSON array>}` (and when reading `cached_payload`, accept both the `{ "has_more", "items" }` envelope and a raw `[...]` array fallback) so that a `304 Not Modified` response (which may omit the `Link` header) faithfully preserves `has_more`—including `has_more: false` on an exact 20-item final page!
  - Preserve exact existing Chinese error messages for `401` (`EtagGetOutcome::Unauthorized` + `crate::check_auth_expired`), `403` (`diag.status == Some(403)`), and `404` (`diag.status == Some(404)` with username).
  - On transient network/5xx failure (`diag.status` is `None` or `>= 500`), if `cached_payload` is present, fall back to parsing `cached_payload` instead of failing.
- Wire `list_github_starred` (`src-tauri/src/commands/forge.rs`) to pre-read `(etag, payload)` from `state.db()` in a short synchronous lock before `await`, and apply `save_etag` / `touch_etag` after `await`.

### 3. Align `owner/repo` direct lookup in `search_apps_online` (`src-tauri/src/commands/catalog_search.rs` & `src-tauri/src/github/search.rs`)

- In `CatalogService::build_summary_from_repo_json` / `fetch_online_repo_with_etag`:
  - Support fast-return shell mode (`probe = false` when caller will run `fetch_icons_stream`), or pass `Some(pre_confirmed.unwrap_or_default())` from `search_apps_online` just like `enrich_trend_repos` does.
- Consolidate the duplicate `owner/repo` direct-lookup handling between `commands/catalog_search.rs:349-424` and `github/search.rs:92-107` so a direct GitHub repo query in `search_apps_online`:
  1. Pre-reads `pre_confirmed` icon, `cached_etag`, and `cached_payload` for `https://api.github.com/repos/{owner}/{repo}` in a single short DB lock (and checks `resolve_local_enrich_hit` when `!is_force`, or sends `If-None-Match` via `fetch_online_repo_with_etag`);
  2. Saves any fresh `(url, etag, text)` to `api_etag_cache`, runs `backfill_uncataloged_card` + `flush_icon_cycle_staged` (joining `app_details` platforms/version/description), filters `hidden_rule_ids`, and stamps via `stamp_summary`;
  3. Spawns `fetch_icons_stream(IconFetchCtx::Search { search_id, gen })` when uncataloged and missing a confirmed/SimpleIcons icon, instead of blocking first paint on synchronous `probe_single_live`.

### 4. Attach GitHub auth headers strictly for `api.github.com` in `fetch_trends_text` (`src-tauri/src/commands/network.rs`)

- Add `state: State<'_, AppState>` to `pub async fn fetch_trends_text(state: State<'_, AppState>, url: String) -> Result<String, String>` (Tauri injects `State` automatically; frontend IPC argument `{ url }` does not change).
- Extract a testable inner helper taking `token: Option<&str>`:
  - When `parsed.host_str()` equals `"api.github.com"` (ASCII case-insensitive): attach `crate::github::http::token_headers(token)` and call `crate::notify_rate_limit("github.com", resp.headers())` upon receiving the response.
  - When `host` is `"github.com"` or `"trend.doforce.dpdns.org"`: keep existing `BROWSER_UA_VALUE` header and **never** attach `Authorization` (preserving strict D5 & ADR-0011 token hygiene).

## Acceptance Criteria

- [x] `fetch_starred_page_with_etag` sends `If-None-Match` when `cached_etag` is provided, returns cached `StarredPage` with exact `has_more` on `304 Not Modified` (zero body re-transfer), and preserves 401/403/404 error messages (`developer_starred_tests.rs`). （已以 `CatalogService::fetch_starred_page` 实现，单测通过）
- [x] Searching `owner/repo` via `search_apps_online` reads/writes `api_etag_cache`, backfills `platforms` and `latest_version` from `app_details` via `backfill_uncataloged_card`, and streams missing icons in the background without blocking first paint. （已通过 `direct_github_lookup` + `backfill_uncataloged_card_in` 实现）
- [x] `fetch_trends_text` attaches `Authorization: token ...` **only** for `https://api.github.com/...` when a token is active and **never** attaches `Authorization` for `https://github.com/...` or `https://trend.doforce.dpdns.org/...` (verified by unit tests with a local mock server).
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passes with new unit tests covering all three paths.
