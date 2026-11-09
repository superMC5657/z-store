# Issue 02: Conditional ETag Revalidation in Manual Update Checks

Status: resolved
Blocked by: none

## Summary

`fetch_app_latest_version_lightweight` (`src-tauri/src/commands/updates_check.rs`) currently passes `None` for `cached_etag` when `force_refresh == Some(true)` (manual update check in UpdatesView), even though it saves the resulting ETag and payload via `db.save_etag(&ep, &etag_val, &payload_text, ...)` on line 128. Because `cached_etag` and `cached_payload` are never read on the manual check path, every manual update check forces a full `200 OK` response from GitHub and consumes rate-limit quota instead of leveraging `If-None-Match` for free `304 Not Modified` responses.

## Scope

- `src-tauri/src/commands/updates_check.rs`
- `src-tauri/src/commands/tests.rs` (or module tests in `updates_check.rs`)

## Implementation Details

### 1. Read `cached_etag` and `cached_payload` from `api_etag_cache` (`src-tauri/src/commands/updates_check.rs`)

- In `fetch_app_latest_version_lightweight` when `is_force == true`:
  - Continue skipping `get_cached_app_detail` TTL short-circuit so every manual check revalidates against the remote server.
  - Before calling `crate::github::http::get_with_etag`, read `(cached_etag, cached_payload)` from `state.db()`:
    ```rust
    let (cached_etag, cached_payload) = if let Ok(db) = state.db() {
        (
            db.get_etag(&ep).ok().flatten().filter(|s| !s.trim().is_empty()),
            db.get_cached_payload(&ep).ok().flatten(),
        )
    } else {
        (None, None)
    };
    ```
  - Pass `cached_etag.as_deref()` into `get_with_etag(&state.http, &ep, None, &base_headers, cached_etag.as_deref(), "updates")`.
  - Pass `cached_payload.as_deref()` into `crate::github::release_fetch::decide_shallow_release(&outcome, cached_payload.as_deref(), stale_row.as_ref(), catalog_default.as_deref())`.

### 2. Graceful fallback when `304` has corrupt/missing cached payload

- If `decide_shallow_release` returns `ShallowError::PayloadCorrupt` or `ShallowMiss::NotModifiedWithoutCache` (e.g. an old row had an ETag without valid payload), fall back to `stale_row` / `catalog_default` if available, or retry once without ETag so a corrupt cache entry self-heals.

## Acceptance Criteria

- [x] Manual update check (`force_refresh = Some(true)`) sends `If-None-Match` when `api_etag_cache` has an ETag for `releases/latest`.
- [x] When GitHub responds with `304 Not Modified`, `fetch_app_latest_version_lightweight` restores `(tag_name, body)` from `cached_payload` without consuming rate-limit quota.
- [x] Unit test verifies `304 Not Modified` recovery and corrupt-payload fallback on the update check path.
