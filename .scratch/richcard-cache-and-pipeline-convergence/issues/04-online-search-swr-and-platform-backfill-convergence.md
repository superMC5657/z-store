# Issue 04: Online Search Fresh/SWR Cache Gating & Platform Backfill Quota Convergence

Status: resolved
Blocked by: 02, 03

## Summary

Wire the namespace-isolated `searchListCache` (with 5-minute fresh tier + 30-minute SWR window), backend ETag conditional search, and the shared single-repo enrich pool into Online Search and list platform backfill:

1. **Bidirectional Shared Enrich Sync in `usePlatformBackfill.ts`**:
   - Pre-resolve any `confirmedOther` keys already fresh in `isSharedRepoConfirmedOther` before dispatching `getPlatformsLite` IPC calls.
   - Write newly deduced concrete `platforms` (`recordSharedRepoPlatforms`) and confirmed empty-asset `Other` repos (`recordSharedConfirmedOthers`) back into the shared pool so Trends, Search, and Starred stay mutually warm.
2. **Fresh Short-Circuit, SWR & `forceRefresh` Discipline in `useSearchState.ts` & `SearchResultsView.tsx`**:
   - Eliminate hardcoded `forceRefresh = true` on normal online searches, pagination, and `lazyBackfillPlatforms` calls.
   - Short-circuit network completely when `readSearchListCacheEntry` hits within the 5-minute fresh window (`!forceRefresh`); perform background ETag SWR revalidation (`forceRefresh = false`) in the 5–30 minute window; pass `forceRefresh = true` only when the user explicitly clicks retry/re-search on an already-performed online search.

## Scope

- Allowed to modify:
  - `src/app/hooks/usePlatformBackfill.ts`
  - `src/app/hooks/useSearchState.ts`
  - `src/views/SearchResultsView.tsx`
  - `src/App.tsx` (only if forwarding `{ forceRefresh: true }` on retry callback)
  - `src/views/HomeView.search-icon.test.tsx` & `src/views/SearchResultsView.online-more.test.tsx` (add/update tests for fresh short-circuit, SWR & `forceRefresh` semantics)
- Do not modify:
  - `src-tauri/*`
  - `src/views/FavoritesView/StarredFeed.tsx` (belongs to Issue 05)

## Implementation Details

### 1. Shared Enrich Integration in `src/app/hooks/usePlatformBackfill.ts`

- In `executeLiteBackfillBatch`:
  - Before calling `selectListLiteTargets(candidates, ...)`, scan `candidates` with empty `platforms`:
    - If `isSharedRepoConfirmedOther(k)` is `true` and `!opts.forceRefresh` and `!opts.resolvedOther.has(k)`, collect into `preConfirmedEmpty: string[]`.
    - Immediately invoke `opts.onConfirmedEmpty(preConfirmedEmpty)` and exclude them from `selectListLiteTargets` so zero `getPlatformsLite` IPC is sent for repos already confirmed as `Other` in Trends or another view!
  - After `runLiteBatch` resolves (and `!opts.seqGuard.isStale(opts.seq)`):
    - When `patched.size > 0`: call `recordSharedRepoPlatforms(opts.summaries, patched)` in addition to `patchSearchListCacheRows` and `opts.onPatched(patched)`.
    - When `confirmedEmpty.length > 0`: call `recordSharedConfirmedOthers(confirmedEmpty)` in addition to `opts.onConfirmedEmpty(confirmedEmpty)`.

### 2. Online Search Fresh/SWR Gating & `forceRefresh` Discipline (`src/app/hooks/useSearchState.ts` & `src/views/SearchResultsView.tsx`)

- Update `handleSearchSubmit(queryToSubmit?: string, opts?: { forceRefresh?: boolean })`:
  - Determine `const forceRefresh = opts?.forceRefresh === true;`.
  - Read `const cacheHit = !forceRefresh ? readSearchListCacheEntry({ query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE }) : undefined;`.
  - When `cacheHit && cacheHit.rows.length > 0`:
    - Assemble via `const assembledCached = assembleOnlineRowsWithIcons([], cacheHit.rows);` (which also hydrates any newly discovered platforms/icons from `iconStore` + `repoEnrichCache`).
    - Populate `onlineApps`, `onlineSearchPerformed = true`, `isOnlineResultSet = true`, `onlinePageRef = 1`, `onlineQueryRef = q`, `onlineHasMore = cacheHit.rows.length >= ONLINE_SEARCH_PER_PAGE`.
    - Trigger `lazyBackfillPlatforms(assembledCached, seq, false)` (only checks rows that still lack platforms and aren't confirmed `Other`).
    - **If `cacheHit.isFresh` (`< 5 min`)**: return early in `try` (zero `searchAppsOnline` network call, zero duplicate success toast)!
    - **If `!cacheHit.isFresh` (`5..30 min` SWR)**: keep `hadCacheHit = true` and proceed to background `tauriApi.searchAppsOnline(q, searchId, 1, ONLINE_SEARCH_PER_PAGE, false)` (which sends `If-None-Match` on backend; suppress the noisy `search.online_success` toast when `hadCacheHit` is true so background SWR feels seamless!).
  - On cache miss or `forceRefresh === true`:
    - Call `tauriApi.searchAppsOnline(q, searchId, 1, ONLINE_SEARCH_PER_PAGE, forceRefresh)`.
    - Call `lazyBackfillPlatforms(deduped, seq, forceRefresh)` (`false` on normal search, `true` only on explicit `forceRefresh`).
    - Also call `recordSharedRepoPlatforms(deduped)` for any rows that already carry concrete platforms (e.g. curated projections or `releases/latest` ETag backfills from Issue 01/02).
- In `handleOnlineLoadMore`:
  - On `readSearchListCache` hit: call `lazyBackfillPlatforms(fresh, seq, false)` (was `true`).
  - On cache miss: call `tauriApi.searchAppsOnline(q, currentSearchIdRef.current || undefined, nextPage, ONLINE_SEARCH_PER_PAGE, false)` (was `true`) and `lazyBackfillPlatforms(assembledMore, seq, false)` (was `true`), plus `recordSharedRepoPlatforms(assembledMore)`.
- In `src/views/SearchResultsView.tsx`:
  - Update `onSearchOnline?: (opts?: { forceRefresh?: boolean }) => void`:
    - When `onlineSearchPerformed` is `true` (the button label is `t('search.retry_online')`), invoke `onSearchOnline({ forceRefresh: true })`; on initial `t('search.search_online_btn')`, invoke `onSearchOnline({ forceRefresh: false })`.

## Acceptance Criteria

- [ ] Vitest tests verify:
  - First online search for `"rustdesk"` calls `searchAppsOnline(..., false)` and `getPlatformsLite(..., false)` (never `forceRefresh = true` on initial search).
  - Re-searching `"rustdesk"` within 5 minutes renders cached rows immediately and makes **0** calls to `searchAppsOnline`.
  - Re-searching `"rustdesk"` after advancing fake timers by 6 minutes (within 30m) immediately paints cached rows and triggers background `searchAppsOnline(..., false)` SWR revalidation.
  - Clicking `search-online-trigger` when `onlineSearchPerformed` is `true` (`retry_online`) passes `forceRefresh = true` to bypass the 5-minute cache short-circuit.
  - A repo already marked in `repoEnrichCache` (concrete platforms or `confirmedOther`) skips `getPlatformsLite` when appearing in online search results.
- [ ] `npx tsc --noEmit` and `npx vitest run` pass with 0 regressions.
