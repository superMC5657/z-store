# Issue 02: Backend ETag 304 Conditional Caching for Search & Starred + SQLite `starred_feed_cache` L2 Table

Status: resolved
Blocked by: 01

## Summary

Bring full HTTP ETag `304 Not Modified` conditional request caching, curated catalog projection, and SQLite L2 snapshot persistence to Online Search and GitHub Star:

1. **Online Search ETag 304 + Curated Projection (`src-tauri/src/github/search.rs` & `src-tauri/src/commands/catalog_search.rs`)**:
   - Route `search_github_online` through `github::http::get_with_etag_diag` backed by `api_etag_cache` (short-circuiting on `304 NotModified` with zero quota cost and falling back to cached payload on transient error).
   - Route single-repo direct lookup (`owner/repo`, `https://github.com/...`, `gh:...`) through `!is_force` `resolve_local_enrich_hit` + `fetch_online_repo_with_etag` + `save_etag` + `backfill_uncataloged_card`.
   - Project cataloged hits in keyword search results using `CatalogService` curated metadata (Chinese description, L1 official icon, curated category, pre-known `platforms`, while keeping fresher live `stars`/`forks`).
2. **GitHub Star ETag 304 & Retry Convergence (`src-tauri/src/github/developer_starred.rs` & `src-tauri/src/commands/forge.rs`)**:
   - Switch `CatalogService::fetch_starred_page` to `github::http::get_with_etag_with_link` (inheriting D7 bounded retry, proxy hot-reload, and `If-None-Match` 304 zero-quota validation).
   - Add `force_refresh: Option<bool>` to `list_github_starred` and `is_stale: Option<bool>` to `StarredPageResult`.
3. **SQLite `starred_feed_cache` L2 Table, IPC Commands & Logout Privacy Purge (`db/schema.rs`, `db/cache.rs`, `commands/forge.rs`, `oauth/mod.rs`, `lib.rs`, and frontend API/mock wiring)**:
   - Persist Starred feed envelopes in a dedicated `starred_feed_cache` table with `512KiB` hard cap, startup pruning (7-day retention + max 15 targets), and atomic `@me:` purge inside `oauth::clear_oauth_session`.

## Scope

- Allowed to modify:
  - `src-tauri/src/db/schema.rs`
  - `src-tauri/src/db/cache.rs`
  - `src-tauri/src/github/search.rs`
  - `src-tauri/src/github/developer_starred.rs`
  - `src-tauri/src/github/developer_starred_tests.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/commands/forge.rs`
  - `src-tauri/src/models.rs`
  - `src-tauri/src/oauth/mod.rs`
  - `src-tauri/src/oauth/tests.rs`
  - `src-tauri/src/lib.rs`
  - `src/types/index.ts` (only `StarredPageResult` optional `is_stale` & `StarredFeedCacheEntry` type)
  - `src/services/api.ts`, `src/services/api/social.ts`, `src/services/api/ipcArgsNaming.test.ts`
  - `src/demo/tauri-mock.ts`, `src/demo/handlers/social.ts`
- Do not modify:
  - `src/views/*`, `src/app/*`, `src/services/search/*`, `src/services/trends/*` (belong to Issues 03–05)

## Implementation Details

### 1. Online Search ETag & Curated Projection (`github/search.rs` & `commands/catalog_search.rs`)

- **Keyword search ETag**:
  - Extract a pure URL builder `pub(crate) fn online_search_endpoint(query: &str, page: Option<u32>, per_page: Option<u32>) -> Option<String>` in `github/search.rs`.
  - Update `CatalogService::search_github_online` (or add `search_github_online_with_etag`) to accept `cached_etag: Option<&str>` and `cached_payload: Option<&str>` (zero DB access inside `async` HTTP call, preserving ADR-0015 lock discipline):
    - Call `super::http::get_with_etag_diag(&client, &url, None, &headers, cached_etag).await`.
    - `Fresh { text, etag }` → parse `OnlineSearchResponse`, return `(summaries, etag.map(|e| (url, e, text)), false /* touched */)`.
    - `NotModified` → parse `cached_payload` if `Some`, return `(summaries, None, true /* touched */)`.
    - `Unauthorized | Failed` → if `Unauthorized`, call `crate::check_auth_expired(401, "op=search_online")`; if `cached_payload` parses cleanly, return cached `summaries` as offline/rate-limit fallback; otherwise return explicit `Err(...)` preserving error lane semantics.
  - In `commands/catalog_search.rs::search_apps_online`:
    - When `!is_force`, pre-read `(cached_etag, cached_payload)` for `online_search_endpoint` under a short `state.db()` lock.
    - After `await`, inside the existing post-fetch `state.db()` lock, call `db.save_etag` on fresh ETag or `db.touch_etag` on `NotModified`.
    - **Curated catalog projection**: For each result in `results`, if `let Some(cat_item) = state.catalog.get_catalog_item(&item.core.id)`, project via `state.catalog.item_to_stamped_summary(&cat_item)` while keeping `stars = item.core.stars.max(cat_item.stars)` and `forks = item.core.forks.max(cat_item.forks)`, then run `backfill_uncataloged_card` only on uncataloged rows (and apply confirmed icon override on cataloged rows via `resolve_confirmed_icon_from_db` if user cycled icon).
- **Single-repo direct lookup (`owner/repo`, `https://github.com/...`, `gh:...`)**:
  - Consolidate the duplicate `owner/repo` handling between `search_apps_online` (`catalog_search.rs:349-424`) and `search_github_online` (`github/search.rs:92-107`):
    - Pre-read `pre_confirmed`, `cached_etag` (when `!is_force`), `cached_payload`, and `!is_force` `resolve_local_enrich_hit` under a short DB lock.
    - If `resolve_local_enrich_hit` misses (or `is_force`), call `fetch_online_repo_with_etag(..., probe_icons = true)` and save returned `(url, etag, text)` into `api_etag_cache`.
    - Run `backfill_uncataloged_card(&db, &mut item)` + `flush_icon_cycle_staged` + `stamp_summary` so single-repo direct lookups also get `app_details` / `releases/latest` platform backfill!

### 2. GitHub Star ETag 304 & Retry Convergence (`github/developer_starred.rs`, `commands/forge.rs`, `models.rs`)

- Add `#[serde(skip_serializing_if = "Option::is_none")] pub is_stale: Option<bool>` to `StarredPageResult` in `src-tauri/src/models.rs` (and `is_stale?: boolean` in `src/types/index.ts`).
- Update `CatalogService::fetch_starred_page`:
  - Accept `cached_etag: Option<&str>`, `cached_payload: Option<&str>` and return `StarredFetchOutcome { page: StarredPage, etag_write: Option<(String, String, String)>, touched_url: Option<String>, is_stale: Option<bool> }`.
  - Use `super::http::get_with_etag_with_link(&client, &target_url, api_base, &headers, cached_etag).await`.
  - **ETag behavior on sync**: Pass `cached_etag` whenever `cached_payload` is valid JSON unless `force_refresh == Some(true)` explicitly requests bypassing local ETag. Wait: note that sending `If-None-Match` to GitHub `/user(s)/starred` ALWAYS validates live server state (returning `200` immediately if the user starred/unstarred anything, and `304` with 0 quota cost if unchanged). Therefore:
    - When `force_refresh != Some(true)`: pass `cached_etag`, and on network/rate-limit failure fall back to `cached_payload` with `is_stale: Some(true)`.
    - When `force_refresh == Some(true)`: STILL pass `cached_etag` if `cached_payload` is valid so unchanged manual syncs cost 0 quota via `304`, and only fall back to `cached_payload` (`is_stale: Some(true)`) if network fails; if `304` occurs with missing/corrupt `cached_payload`, retry once with `cached_etag = None`.
  - **`304 NotModified` `has_more` guard**: Parse `raw_items: Vec<serde_json::Value>` first to get `raw_len = raw_items.len()`, then set `has_more = has_next || raw_len >= (per_page.clamp(1, STARRED_PAGE_MAX) as usize)` (handling servers/proxies that omit `Link` on `304`).
  - On `Unauthorized`, call `crate::check_auth_expired(401, "op=list_github_starred")` and return the clear 401 message.
- Update `commands::list_github_starred` (`commands/forge.rs`):
  - Signature: `(app_handle, state, username: Option<String>, page: Option<u32>, per_page: Option<u32>, force_refresh: Option<bool>)`.
  - Short-lock pre-read `(cached_etag, cached_payload)` from `db` for `starred_page_url(...)`, call `fetch_starred_page`, then under a single `state.db()` lock persist `save_etag` / `touch_etag` and run `cards_from_repo_payloads`.

### 3. SQLite `starred_feed_cache` L2 Table, Startup Pruning & Logout Purge

- **`src-tauri/src/db/schema.rs` (`init_schema`)**:
  ```sql
  CREATE TABLE IF NOT EXISTS starred_feed_cache (
      cache_key TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL DEFAULT 0,
      cached_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_starred_feed_cache_cached_at ON starred_feed_cache(cached_at DESC);
  ```
- **`src-tauri/src/db/cache.rs`**:
  - `pub const STARRED_FEED_CACHE_MAX_BYTES: usize = 512 * 1024;`
  - `pub const STARRED_FEED_CACHE_MAX_ROWS: usize = 15;`
  - `get_starred_feed_cache(&self, cache_key: &str) -> Result<Option<(String, i64)>>`
  - `save_starred_feed_cache(&self, cache_key: &str, owner_scope: &str, payload: &str) -> Result<()>` (reject `> STARRED_FEED_CACHE_MAX_BYTES` with `starred_feed_payload_too_large`; trim and skip empty strings).
  - `delete_starred_feed_cache_by_scope_prefix(&self, prefix: &str) -> Result<usize>` (`DELETE FROM starred_feed_cache WHERE substr(owner_scope, 1, length(?1)) = ?1`).
  - `prune_starred_feed_cache(&self, now: i64) -> Result<usize>` (delete rows with `cached_at <= now - 7 * 86400`, then keep top `STARRED_FEED_CACHE_MAX_ROWS` by `cached_at DESC`).
- **Startup pruning (`src-tauri/src/lib.rs`)**:
  - Call `let _ = db.prune_starred_feed_cache(now);` right next to `prune_expired_trend_board_cache`.
- **OAuth logout privacy purge (`src-tauri/src/oauth/mod.rs::clear_oauth_session`)**:
  - Add `let _ = db.delete_starred_feed_cache_by_scope_prefix("@me:");` alongside `delete_etags_by_prefix("https://api.github.com/user/")`.
- **Tauri commands & Frontend IPC alignment**:
  - Add `get_starred_feed_cache(state, cache_key: String) -> AppResult<Option<StarredFeedCacheEntry>>` and `save_starred_feed_cache(state, cache_key: String, owner_scope: String, payload_json: String) -> AppResult<()>` in `commands/forge.rs` (`#[tauri::command(rename_all = "camelCase")]`), re-export in `commands/mod.rs`, and register in `lib.rs` `generate_handler!`.
  - Add `getStarredFeedCache: 'get_starred_feed_cache'` and `saveStarredFeedCache: 'save_starred_feed_cache'` to `CMD` in `src/services/api.ts`, wrap in `src/services/api/social.ts` (and re-export on `tauriApi`), add `forceRefresh = false` param to `listGithubStarred`, mock in `src/demo/handlers/social.ts` + `src/demo/tauri-mock.ts`, and cover in `src/services/api/ipcArgsNaming.test.ts`.

## Acceptance Criteria

- [x] Mock server tests in `developer_starred_tests.rs` verify: first `fetch_starred_page` stores ETag + payload; second call sends `If-None-Match` and recovers `StarredPage` on `304 Not Modified` (including `has_more = true` when a full page of `per_page` items returns `304` without a `Link` header); transient 500/offline falls back to cached payload with `is_stale == Some(true)`.
- [x] Unit/mock tests verify `search_github_online` sends `If-None-Match`, recovers on `304`, and projects curated `CatalogItem` fields when a search hit matches `CatalogService`.
- [x] DB & OAuth tests verify `save_starred_feed_cache` (512KiB cap), `prune_starred_feed_cache` (7d + 15 rows), and that `clear_oauth_session` deletes `@me:alice` rows while preserving public `torvalds` rows.
- [x] `cmdAlignment.test.ts` and `ipcArgsNaming.test.ts` pass 100%, along with `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml --lib`.
