# Issue 01: Backend Rich-Card Backfill Convergence, ETag Pool Expansion, Trend Double-Probe Fix & `new` Board Auth

Status: resolved
Blocked by: none

## Summary

Converge the backend rich-card (`AppSummary`) assembly foundation shared across Online Search, Trends, and GitHub Star, and eliminate two wasteful network bottlenecks in Trends:

1. **Expand `api_etag_cache` LRU cap (`src-tauri/src/db/etag.rs`)**: Raise `API_ETAG_CACHE_MAX_ROWS` from `1000` to `3000` so affinity sync pagination, trend 40-repo enrichment, search ETag, starred ETag, and `releases/latest` ETag entries do not prematurely evict each other.
2. **Cross-restart `releases/latest` platform & version backfill (`src-tauri/src/commands/catalog_search.rs`)**: `get_platforms_lite` persists `/repos/{owner}/{repo}/releases/latest` JSON into `api_etag_cache` without writing `app_details`. Enhance `backfill_uncataloged_card` so when `app_details` has no entry (leaving `item.core.platforms` empty or `latest_version == "latest"`), it performs a zero-network synchronous lookup of `api_etag_cache` for `https://api.github.com/repos/{owner}/{repo}/releases/latest` and backfills deduced `platforms` and `tag_name`.
3. **Eliminate `enrich_trend_repos` 2x icon probing (`src-tauri/src/commands/catalog_search.rs` & `src-tauri/src/github/search.rs`)**: Currently `fetch_enrich_batch` calls `fetch_online_repo_with_etag`, which passes `probe = true` into `build_summary_from_repo_json` (serially probing SimpleIcons + Git Trees inside `buffered(5)`), and then `enrich_trend_repos` immediately spawns `fetch_icons_stream(Trend)` for every `pre_confirmed.is_none()` repo to probe the exact same icons a second time. Decouple `probe_icons: bool` so `fetch_enrich_batch` passes `false` (fast-returning `/repos/{o}/{r}` summaries immediately) and delegates icon probing once to `fetch_icons_stream(Trend)`.
4. **Attach active GitHub token on `api.github.com` in `fetch_trends_text` (`src-tauri/src/commands/network.rs`)**: The `new` trend board queries `https://api.github.com/search/repositories?...` via `fetch_trends_text`. Attach the active GitHub token (if logged in / configured) and report rate limits **only** when `host == "api.github.com"`, keeping `github.com` HTML and `trend.doforce.dpdns.org` strictly unauthenticated.

## Scope

- Allowed to modify:
  - `src-tauri/src/db/etag.rs`
  - `src-tauri/src/github/search.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/commands/network.rs`
- Do not modify:
  - `src/*` (frontend files)
  - `src-tauri/src/db/schema.rs` (belongs to Issue 02)
  - `src-tauri/src/github/developer_starred.rs` & `src-tauri/src/commands/forge.rs` (belong to Issue 02)

## Implementation Details

### 1. Expand `API_ETAG_CACHE_MAX_ROWS` (`src-tauri/src/db/etag.rs`)

- Update `pub const API_ETAG_CACHE_MAX_ROWS: usize = 3000;`.

### 2. Zero-network `releases/latest` backfill in `backfill_uncataloged_card` (`src-tauri/src/commands/catalog_search.rs`)

- In `backfill_uncataloged_card(db: &crate::db::Database, item: &mut AppSummary)`:
  - Keep existing `resolve_confirmed_icon_from_db`, staged `AppIconCycle` construction, and `db.get_app_detail(&item.core.id, None)` backfill unchanged.
  - When `item.core.platforms.is_empty()` or `item.core.latest_version.trim().is_empty()` or `item.core.latest_version == "latest"`:
    - Only for GitHub repos (`item.core.forge.as_deref().unwrap_or("github").eq_ignore_ascii_case("github")` and non-empty `owner`/`repo`):
    - Construct `let release_ep = format!("https://api.github.com/repos/{}/{}/releases/latest", item.core.owner, item.core.repo);` (also try lowercase `owner`/`repo` fallback if exact case misses in `api_etag_cache`).
    - If `let Ok(Some(payload)) = db.get_cached_payload(&release_ep)`:
      - Parse the cached GitHub release JSON via `crate::github::release_fetch` / `GitHubRelease` (or a lightweight serde struct extracting `tag_name` + `assets` mapped through `crate::github::detail_assets::parse_release_assets` / `platforms_from_assets`, matching `decide_shallow_release` logic in `src-tauri/src/github/release_fetch.rs`).
      - If `item.core.platforms.is_empty()` and deduced `platforms` is non-empty, set `item.core.platforms = platforms`.
      - If `(item.core.latest_version.is_empty() || item.core.latest_version == "latest")` and `!tag_name.trim().is_empty()`, set `item.core.latest_version = tag_name`.

### 3. Fix `enrich_trend_repos` double icon probing (`src-tauri/src/github/search.rs` & `src-tauri/src/commands/catalog_search.rs`)

- In `src-tauri/src/github/search.rs`:
  - Add `probe_icons: bool` to `CatalogService::fetch_online_repo_with_etag` (passing `probe_icons` instead of hardcoded `true` into `Self::build_summary_from_repo_json` across `Fresh`, `NotModified`, and fallback branches).
  - Keep `CatalogService::fetch_online_repo` passing `probe_icons: true` for single-repo direct callers.
- In `src-tauri/src/commands/catalog_search.rs`:
  - In `fetch_enrich_batch`, call `catalog.fetch_online_repo_with_etag(..., false)` so batch summary fetching never blocks on inline SimpleIcons / Git Trees requests.
  - When building background `fetch_icons_stream(Trend)` `jobs` in `enrich_trend_repos` (around line 870), filter with:
    `!state.catalog.is_cataloged(&coord.id) && pre.is_none()`
    so cataloged items resolved via `resolve_local_enrich_hit` never spawn redundant icon probes.

### 4. Authenticated `api.github.com` branch in `fetch_trends_text` (`src-tauri/src/commands/network.rs`)

- Change `pub async fn fetch_trends_text(state: State<'_, AppState>, url: String) -> Result<String, String>` (Tauri injects `State` automatically; frontend `{ url }` payload and `cmdAlignment.test.ts` remain untouched).
- In `send_trends_once` (or a header-accepting variant):
  - When `host.eq_ignore_ascii_case("api.github.com")`:
    - Resolve token via `crate::commands::resolve_active_github_token(&state)` and build headers via `crate::github::http::token_headers(token.as_deref())`.
    - Upon receiving `TrendSend::Resp(ref resp)`, call `crate::notify_rate_limit("github.com", resp.headers())`.
  - When `host` is `github.com` or `trend.doforce.dpdns.org`:
    - **Never** attach any `Authorization` header (preserving ADR-0011 & ADR-0012 token hygiene boundaries).

## Acceptance Criteria

- [ ] Unit test in `commands/catalog_search.rs` verifies `backfill_uncataloged_card` populates `platforms` and `latest_version` from a cached `https://api.github.com/repos/{o}/{r}/releases/latest` entry in `api_etag_cache` when `app_details` has no row, while `app_details` still takes precedence when present.
- [ ] Unit / mock HTTP test verifies `fetch_online_repo_with_etag(..., probe_icons = false)` makes 0 icon CDN / Git Trees requests and returns `icon = ""` when `pre_confirmed` is `None`.
- [ ] Unit test in `commands/network.rs` verifies `api.github.com` requests attach token headers when a token is present, while `github.com` and `trend.doforce.dpdns.org` never carry `Authorization`.
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml --lib` pass cleanly.
