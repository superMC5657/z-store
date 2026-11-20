# Issue 03: Cross-Pipeline Repo Cache Seeding, 12h Soft-TTL Revalidation & Own-Starred Offline Fallback

Status: resolved
Blocked by: 02

## Summary

Bridge cache silos between Online Search, GitHub Star, Affinity Sync, and Trend Enrichment while restoring periodic `304 Not Modified` revalidation on stale repo ETag entries:

1. **Trend `enrich_trend_repos` never revalidates `api_etag_cache` (`src-tauri/src/commands/catalog_search.rs:784-796`)**:
   - Currently, when `!is_force`, `enrich_trend_repos` reads `db.get_cached_payload(&repo_url)` without checking `last_checked_at`. Once a repo enters `api_etag_cache`, `resolve_local_enrich_hit` short-circuits forever (until manual force refresh or 1000-row LRU eviction), leaving `stars`, `forks`, and `description` frozen for days instead of running a zero-quota `304 Not Modified` check after the 12-hour board TTL window.
2. **Search & Starred discard fresh single-repo JSON that Trend Enrichment immediately re-fetches**:
   - Both `search_github_online` (`/search/repositories` `items[]`) and `list_github_starred` (`/user(s)/starred` `items[]`) receive full GitHub repository JSON objects compatible with `OnlineRepoResponse`, yet discard them after building `AppSummary` cards. If the user subsequently visits `TrendsView` containing any of those uncataloged repos, `enrich_trend_repos` issues redundant `GET /repos/{owner}/{repo}` calls.
3. **Logged-in user's own `StarredFeed` fails offline even when `affinity` already synced `/user/starred`**:
   - Background `sync_github_affinity_signals_bg` (`src-tauri/src/github/affinity.rs`) caches `/user/starred?per_page=100&page=N` in `api_etag_cache`. When `list_github_starred` queries self (`username: None`, `per_page=20`) while offline and the `per_page=20` key has not been cached yet, it can slice from the locally cached `per_page=100` pages instead of failing.

## Scope

- `src-tauri/src/db/etag.rs`
- `src-tauri/src/commands/catalog_search.rs`
- `src-tauri/src/github/search.rs`
- `src-tauri/src/commands/forge.rs`
- `src-tauri/src/github/developer_starred.rs`

## Implementation Details

### 1. Rich `EtagCacheEntry` DAO & non-destructive repo JSON seeding (`src-tauri/src/db/etag.rs`)

- Define `pub struct EtagCacheEntry { pub etag: String, pub payload_json: String, pub last_checked_at: i64 }` and add `pub fn get_etag_entry(&self, endpoint_url: &str) -> Result<Option<EtagCacheEntry>>` to read all three columns in one query.
- Add `pub fn seed_repo_payload_if_absent_or_untagged(&self, endpoint_url: &str, payload_json: &str, timestamp: i64) -> Result<()>` (plus batch transaction helper `seed_repo_payloads_batch`):
  - `INSERT INTO api_etag_cache (endpoint_url, etag, payload_json, last_checked_at) VALUES (?1, '', ?2, ?3) ON CONFLICT(endpoint_url) DO UPDATE SET payload_json = excluded.payload_json, last_checked_at = excluded.last_checked_at WHERE api_etag_cache.etag = ''`
  - Crucial invariant: **never** overwrite a non-empty HTTP `etag` with an untagged list item payload, keeping `etag ↔ payload_json` pairing 100% consistent for HTTP `304 Not Modified`.

### 2. 12-hour soft-TTL on `api_etag_cache` in `enrich_trend_repos` (`src-tauri/src/commands/catalog_search.rs`)

- Define `pub(crate) const ENRICH_ETAG_SOFT_TTL_SECS: i64 = 12 * 3600;` (aligned with `TREND_DB_TTL_MS` 12h).
- During the pre-read DB lock in `enrich_trend_repos` (when `!is_force`):
  - Check `CatalogService` and `app_details` first (unchanged).
  - For `api_etag_cache`, read `db.get_etag_entry(&repo_url)`:
    - If `now.saturating_sub(entry.last_checked_at) < ENRICH_ETAG_SOFT_TTL_SECS` (and `now >= entry.last_checked_at`), pass `Some(&entry.payload_json)` to `resolve_local_enrich_hit` for an instant 0-network hit.
    - If `entry` is older than 12 hours: pass `None` for `cached_payload` into `resolve_local_enrich_hit` so the repo enters `batch_jobs` with `cached_etag = Some(entry.etag).filter(|e| !e.is_empty())` and `cached_payload = Some(entry.payload_json)`.
  - In `fetch_online_repo_with_etag` / `enrich_trend_repos`: when `EtagGetOutcome::NotModified` occurs, return a touch marker (or `etag_to_touch`) so the post-batch DB lock calls `db.touch_etag(&url, now)`, renewing the 12-hour soft-TTL window with **zero GitHub quota cost**! And if offline/failed, `fetch_online_repo_with_etag` already falls back to `cached_payload`.

### 3. Seed repo JSON payloads from Keyword Search & Starred (`src-tauri/src/github/search.rs`, `src-tauri/src/commands/catalog_search.rs`, `src-tauri/src/commands/forge.rs`)

- In `search_github_online` (`src-tauri/src/github/search.rs`): parse `/search/repositories` `items` as `Vec<serde_json::Value>` (or return raw repo JSON alongside `AppSummary`) and in `search_apps_online`'s single DB lock call `db.seed_repo_payloads_batch(...)` for uncataloged repos (`https://api.github.com/repos/{urlencoding::encode(owner)}/{urlencoding::encode(repo)}`).
- In `list_github_starred` (`src-tauri/src/commands/forge.rs`): inside the existing `state.db()` block alongside `cards_from_repo_payloads`, batch-seed `fetched.repos` payloads via `seed_repo_payloads_batch` (unwrapping `{ starred_at, repo }` if wrapped so stored JSON is always a bare repo object).

### 4. Own-Starred offline fallback from cached `affinity` pages (`src-tauri/src/github/developer_starred.rs` & `src-tauri/src/commands/forge.rs`)

- Add a pure DB helper `slice_self_starred_from_affinity_cache(db: &Database, page: u32, per_page: u32) -> Option<StarredPage>`:
  - Computes global item range `[start, end)` for `(page, per_page)` and maps it to 100-item `CatalogService::affinity_starred_page_endpoint(affinity_page)` entries in `api_etag_cache`.
  - If the required `per_page=100` cached payload(s) exist in `api_etag_cache`, parses via `parse_starred_payloads`, slices `[start..end]`, and computes `has_more` (true if current 100-item page has remaining items after `end` or the next 100-item page exists in `api_etag_cache`).
- Only invoke this fallback when `username` is empty/self **and** `fetch_starred_page_with_etag` fails due to network/upstream error without a `per_page=20` cached page—normal online behavior and `Link` pagination remain unchanged.

## Acceptance Criteria

- [x] `enrich_trend_repos` serves `api_etag_cache` entries younger than 12h with 0 HTTP requests; entries ≥ 12h old send `If-None-Match`, `touch_etag` on `304 Not Modified`, update payload on `200 OK`, and fall back to stale payload on network error.
- [x] Uncataloged repos returned by `search_apps_online` or `list_github_starred` share cross-pipeline富卡 cache without overwriting existing non-empty ETags. （已由 ADR-0027 独立 `repo_card_cache` 12h 富卡缓存承接跨链路复用；`api_etag_cache` 裸 JSON 反哺可按需决定是否保留）
- [x] When offline and querying own stars (`username: None`) with no `per_page=20` ETag entry, `list_github_starred` successfully slices cards from cached `affinity` `/user/starred?per_page=100` pages if present.
- [x] All Rust unit and integration tests pass under `cargo test --manifest-path src-tauri/Cargo.toml`.
