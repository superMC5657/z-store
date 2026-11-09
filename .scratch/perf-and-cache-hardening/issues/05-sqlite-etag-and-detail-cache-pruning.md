# Issue 05: SQLite `api_etag_cache` & `app_details_cache` Startup LRU Pruning

Status: resolved
Blocked by: none

## Summary

While `trend_board_cache` and `asset_cache` are pruned on startup (`src-tauri/src/lib.rs:444-449`), `api_etag_cache` (which stores full GitHub API JSON payloads) and `app_details_cache` (which stores full `AppDetail` JSON including README Markdown) currently have no row-count bounds and grow indefinitely as users browse online search results and trending repositories.

## Scope

- `src-tauri/src/db/cache.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/db/tests.rs`

## Implementation Details

### 1. Add bounded pruning helpers in `src-tauri/src/db/cache.rs`

- Define default row-count watermarks:
  - `pub const API_ETAG_CACHE_MAX_ROWS: usize = 1000;`
  - `pub const APP_DETAILS_CACHE_MAX_ROWS: usize = 500;`
- Implement `pub fn prune_api_etag_cache(&self, max_rows: usize) -> Result<usize>`:
  - Evict rows older than the most recent `max_rows` ordered by `last_checked_at DESC`:
    ```sql
    DELETE FROM api_etag_cache
    WHERE endpoint_url NOT IN (
        SELECT endpoint_url FROM api_etag_cache
        ORDER BY last_checked_at DESC
        LIMIT ?1
    )
    ```
- Implement `pub fn prune_app_details_cache(&self, max_rows: usize) -> Result<usize>`:
  - Evict rows older than the most recent `max_rows` ordered by `cached_at DESC` (while preserving rows referenced by `installed_apps`, `user_favorites`, or `watched_apps` so uncataloged user assets never lose their offline detail cache):
    ```sql
    DELETE FROM app_details_cache
    WHERE app_id NOT IN (
        SELECT app_id FROM app_details_cache
        ORDER BY cached_at DESC
        LIMIT ?1
    )
    AND app_id NOT IN (SELECT app_id FROM installed_apps)
    AND app_id NOT IN (SELECT app_id FROM user_favorites)
    AND app_id NOT IN (SELECT app_id FROM watched_apps)
    ```

### 2. Wire into startup maintenance (`src-tauri/src/lib.rs`)

- In `src-tauri/src/lib.rs` around line 446 (alongside `prune_expired_trend_board_cache` and `enforce_asset_quota_lru`), invoke:
  ```rust
  let _ = db.prune_api_etag_cache(crate::db::cache::API_ETAG_CACHE_MAX_ROWS);
  let _ = db.prune_app_details_cache(crate::db::cache::APP_DETAILS_CACHE_MAX_ROWS);
  ```

## Acceptance Criteria

- [x] `prune_api_etag_cache` trims `api_etag_cache` to `max_rows` ordered by `last_checked_at DESC`.
- [x] `prune_app_details_cache` trims `app_details_cache` to `max_rows` ordered by `cached_at DESC` while protecting installed, favorited, and watched app IDs.
- [x] Startup maintenance in `src-tauri/src/lib.rs` runs both pruners best-effort without blocking startup.
- [x] Unit tests in `src-tauri/src/db/tests.rs` verify LRU eviction and asset protection.
