Status: done
Blocked by: 01

## Goal

Make backend rich-card resolution (`enrich_trend_repos`, `CatalogService::fetch_online_repo`, and `backfill_uncataloged_card`) local-cache-first with ETag conditional reuse (`If-None-Match` + `304 Not Modified`) and offline/network-jitter fallback so rich-card metadata (stars, forks, description, version, license, platforms, homepage, icon) renders from local SQLite caches when the network fluctuates.

## Context

- Spec: `.scratch/icon-and-cache-local-first/spec.md` (Root Cause 4; Goals 3 & 4)
- Key files:
  - `src-tauri/src/commands/catalog_search.rs` (`enrich_trend_repos`, `backfill_uncataloged_card`)
  - `src-tauri/src/github/search.rs` (`CatalogService::fetch_online_repo`)
  - `src-tauri/src/github/http.rs` (`CatalogService::get_with_etag`, `resolve_confirmed_icon_from_db`)
  - `src-tauri/src/db/cache.rs` (`get_cached_app_detail`, `get_etag_cache`, `save_etag_cache`)

## Acceptance Criteria

1. **Local-Cache-First in `enrich_trend_repos` (`src-tauri/src/commands/catalog_search.rs`)**:
   - Before spawning an external network call to `state.catalog.fetch_online_repo(owner, repo)`, when `!is_force`:
     1. Check `state.catalog.get_catalog_item(&id)` (in-memory catalog hydrated with latest detail overrides).
     2. Check `state.db.get_cached_app_detail(&id, None)` (SQLite `app_details_cache`, regardless of 1-hour freshness TTL).
     3. Check `state.db.get_etag_cache(&format!("https://api.github.com/repos/{}/{}", owner, repo))` and parse `payload_json` into an `AppSummary` via existing repo-summary mapping if present.
   - When any local source hits, merge confirmed icon from `pre_confirmed` / `resolve_confirmed_icon_from_db` and fields from `app_details_cache` (`platforms`, `latest_version`, non-placeholder `description`/`description_en`, `license`, `homepage`), and return the enriched `AppSummary` immediately without hitting the external network.
   - When `is_force == true`, or on a cold miss across all local caches, proceed to `fetch_online_repo` with ETag support; if the network call fails during `is_force`, still fall back to any available local cache entry rather than dropping the repo from the result array.

2. **Shared Client, ETag Reuse & Stale Fallback in `CatalogService::fetch_online_repo` (`src-tauri/src/github/search.rs`)**:
   - Replace per-call `reqwest::Client::builder()` construction in `fetch_online_repo` with `crate::shared_http_client()`.
   - Route `https://api.github.com/repos/{owner}/{repo}` through `CatalogService::get_with_etag(client, &url, db, false)` (or pass `db: Option<&Database>` / add `fetch_online_repo_cached(&self, owner, repo, db: &Database, force_refresh: bool)`) so:
     - Stored ETag is sent via `If-None-Match`, `304 Not Modified` reuses `api_etag_cache.payload_json` without consuming GitHub REST rate limits, and `200 OK` saves the new ETag + payload.
     - Transient network/5xx errors get the built-in 200ms -> 800ms retry and fall back to cached `api_etag_cache.payload_json` or `db.get_cached_app_detail` when offline or when network jitter occurs.

3. **Full Metadata Backfill in `backfill_uncataloged_card` (`src-tauri/src/commands/catalog_search.rs`)**:
   - Change `state.db.get_cached_app_detail(&item.core.id, Some(3600))` to `state.db.get_cached_app_detail(&item.core.id, None)` so local detail cache data remains available for card assembly after 60 minutes.
   - In addition to `platforms`, backfill from `detail`:
     - `latest_version`: if card is empty or `"latest"` and `detail.core.latest_version` is concrete (`!is_empty() && != "latest"`).
     - `description` / `description_en`: if card holds a placeholder (`No description available` / `暂无描述` / empty) and `detail` has non-placeholder text.
     - `license`: if card is empty, `"OpenSource"`, or `"unknown"` and `detail.license` is concrete.
     - `homepage`: if card `homepage` is `None`/empty and `detail.homepage` is `Some`.
     - `icon`: if card `icon` is empty and `detail.core.icon` is non-empty (prioritizing `resolve_confirmed_icon_from_db` first).

4. **Unit & Integration Tests**:
   - Add Rust tests in `src-tauri/src/commands/catalog_search.rs` (or `src-tauri/src/github/search.rs`) verifying:
     - `backfill_uncataloged_card` backfills `platforms`, `latest_version`, `description`, `license`, `homepage`, and `icon` from `app_details_cache` even when `cached_at` is older than 3600s.
     - `enrich_trend_repos` (with `!is_force`) returns cached `AppSummary` from `app_details_cache` + `resolve_confirmed_icon_from_db` without making external HTTP calls.

## Out of Scope

- Detail fetch write-through and frontend `useDetailCacheSync` / `useTrendEnrichment` updates (Issue 05).
