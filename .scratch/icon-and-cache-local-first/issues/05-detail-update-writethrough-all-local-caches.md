Status: done
Blocked by: 01, 02, 03, 04

## Goal

Ensure that clicking any app card to open `AppDetailModal` and receiving updated detail data writes through to **all** local caches — backend (`app_details_cache`, `CatalogService` in-memory `items` + `collected`, `app_icon_cycles` + on-disk `icons/`) and frontend (`detailMemoryCache`, `iconDataCache`, `trendEnrichCache`, SQLite `trend_board_cache` whether `TrendsView` is mounted or unmounted, `searchListCache`, and all active list views).

## Context

- Spec: `.scratch/icon-and-cache-local-first/spec.md` (Root Causes 5 & 6; Goal 5)
- Key files:
  - Backend:
    - `src-tauri/src/github/detail_fetch.rs` (`fetch_app_detail`, `probe_repo_icon`)
    - `src-tauri/src/commands/catalog_detail.rs` (`persist_github_detail`, `get_app_detail`)
    - `src-tauri/src/github/catalog_service.rs` (`CatalogService::update_catalog_item_stats`, startup hydration)
    - `src-tauri/src/db/icon_cycle.rs` (`merge_detail_icon`)
    - `src-tauri/src/lib.rs` (startup catalog initialization)
  - Frontend:
    - `src/app/hooks/useDetailCacheSync.ts` (`patchDetailMemoryAndLists`, `mergeCardWithDetail`)
    - `src/views/TrendsView/useTrendEnrichment.ts` (`onRichcardHeal`, `onPlatformsHeal`, `subscribeIconWrites`, `subscribeTrendHealBus`)
    - `src/services/trends/board.ts` (`persistTrendHealRichcardIfPresent`, `persistDetailToBoardCacheIfPresent`)
    - `src/services/search/searchListCache.ts` (`patchSearchListCacheRows`)

## Acceptance Criteria

1. **Backend 304 Release Reuse Merges Fresh `repo_info` (`src-tauri/src/github/detail_fetch.rs`)**:
   - In `fetch_app_detail` (around lines 581–593), when the `/releases` endpoint returns `304 Not Modified` (`reuse_304_cached`), do **not** return before applying `repo_info`.
   - Merge any fresh `repo_info` (`stars`, `forks`, `license`, `homepage`, non-placeholder `description`/`description_en`) into `cached_d`, call `self.update_catalog_item_from_detail(&cached_d)`, and return the updated `AppDetail` so `persist_github_detail` writes the refreshed stats and metadata to `app_details_cache`.

2. **Backend `CatalogService` Full Detail Sync & Startup Hydration (`src-tauri/src/github/catalog_service.rs` & `src-tauri/src/lib.rs`)**:
   - Upgrade `CatalogService::update_catalog_item_stats` (or add `update_catalog_item_from_detail(&self, detail: &AppDetail)`) to update **both** `self.items` and `self.collected` with:
     - `stars`, `forks`
     - `default_version` (when `detail.core.latest_version` is concrete and not `"latest"`)
     - `platforms` (when `detail.core.platforms` has concrete OS entries)
     - `license` (when concrete)
     - `homepage` (when `Some` and non-empty)
     - `icon` (when `detail.core.icon` is non-empty and not a placeholder)
   - Add `CatalogService::hydrate_from_details_cache(&self, db: &Database)` that reads all cached `AppDetail` rows from `app_details_cache` and applies `update_catalog_item_from_detail` + confirmed icon from `resolve_confirmed_icon_from_db`.
   - Invoke `hydrate_from_details_cache` on app startup in `src-tauri/src/lib.rs` (after loading `catalog.json`) and at the end of `CatalogService::sync_catalog` so `get_home_feed`, `get_apps`, and `search_apps` immediately serve detail-updated fields across restarts.

3. **Backend Detail Icon Preservation, Tokenless L2 Probe & Eager Disk Write (`detail_fetch.rs`, `db/icon_cycle.rs`, `catalog_detail.rs`)**:
   - In `probe_repo_icon` (`src-tauri/src/github/detail_fetch.rs:291-300`), run `probe_l2_simple` (which only hits `cdn.simpleicons.org` and does not require a GitHub token) even when `!has_token`, only skipping GitHub-API-dependent L3/L4 probes when unauthenticated and rate-limited.
   - In `merge_detail_icon` (`src-tauri/src/db/icon_cycle.rs:506-535`), when `cycle.selected_url` changes to a different URL, update `cycle.cache_file` to the matching on-disk hash filename if already present in `icons/`, or clear `cycle.cache_file` to `""` so stale cache filenames from an older URL are never served.
   - In `persist_github_detail` (`src-tauri/src/commands/catalog_detail.rs:845-875`):
     - If `detail.core.icon` is empty after probing, check existing `db.get_icon_cycle(&detail.core.id)`; if `cycle.selected_url` is non-empty and `cycle.level != 5`, preserve `detail.core.icon = resolve_confirmed_icon_from_db(...)` instead of saving an empty icon over `app_details_cache`.
     - If `detail.core.icon` is an `http(s)://` URL whose hash file is not yet on disk in `icons/`, spawn a background task via `fetch_and_cache_icon_bytes` to persist the image file and set `cycle.cache_file` + `icon_cache_meta`.

4. **Frontend Fix Stale-Ref Clobber in `useTrendEnrichment.ts` & Unmounted Board Persistence (`src/views/TrendsView/useTrendEnrichment.ts`, `src/services/trends/board.ts`, `src/app/hooks/useDetailCacheSync.ts`)**:
   - In `useTrendEnrichment.ts`:
     - In `onRichcardHeal` (lines 410–416), compute `const next = applyRichcardHealToMirror(enrichedAppsRef.current, payload, repoKeys); enrichedAppsRef.current = next; setEnrichedApps(next); maybePersistRichcardHeal(next, payload, repoKeys);` so `maybePersistRichcardHeal` receives the **updated** array (`next`) instead of the stale pre-render `enrichedAppsRef.current`.
     - In `onPlatformsHeal` (line 401) and `subscribeIconWrites` (line 425), also update `enrichedAppsRef.current` synchronously and persist the updated card to `putTrendEnrichMemory` + `persistTrendHealRichcardIfPresent`.
     - In `subscribeTrendHealBus` (line 201), allow `confirmedOther` and `platforms` updates to fire `onRichcardHeal` even when `dirtyFields` is empty (when the user opens `AppDetailModal` on an already-clean card and gets newer stars/version/description/icon).
   - In `src/services/trends/board.ts`:
     - Export `persistDetailToBoardCacheIfPresent(detail: AppDetail)` (or extend `persistTrendHealRichcardIfPresent`) so `useDetailCacheSync.ts` directly updates matching rows in `boardMemory` (`all` / `monthly` / `weekly`) and calls `saveDbTrendCache` even when `TrendsView` is **not** currently mounted.

5. **Frontend `searchListCache` Full Row Sync (`src/services/search/searchListCache.ts` & `src/app/hooks/useDetailCacheSync.ts`)**:
   - Add `patchSearchListCacheRows(patcher: (rows: AppSummary[]) => AppSummary[]): void` to `src/services/search/searchListCache.ts` that updates every cached search entry's `data` array in-place.
   - Call `patchSearchListCacheRows((rows) => patchSummaryListWithDetail(rows, d))` inside `patchDetailMemoryAndLists` in `src/app/hooks/useDetailCacheSync.ts`.
   - When `d.icon` is a `data:` URI, call `seedResolvedIconEntry(d.id, d.icon, d.icon)` so both `d.id` and any previous `http(s)` icon URL for that app map to the `data:` URI in `iconDataCache`.

6. **Unit & Integration Tests**:
   - Update/add tests in `src/app/hooks/useDetailCacheSync.test.tsx` and `src/services/trends/swr-view.test.tsx` verifying:
     - Opening detail and receiving updated `stars`, `latest_version`, `description`, `platforms`, `license`, `homepage`, and `icon` updates `trendEnrichCache` and `trend_board_cache` with the **new** values (no clobber by stale `enrichedAppsRef.current`), both when `TrendsView` is mounted and when unmounted.
     - `searchListCache` entries are updated with all detail fields via `patchSearchListCacheRows`.
   - Add Rust unit tests verifying `CatalogService::update_catalog_item_from_detail`, `hydrate_from_details_cache`, and `merge_detail_icon` `cache_file` handling.

## Out of Scope

- ADR and domain documentation updates (Issue 06).
