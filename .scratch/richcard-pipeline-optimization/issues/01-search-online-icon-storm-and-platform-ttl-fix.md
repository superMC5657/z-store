# Issue 01: Fix Online Search Icon Probe Storm & Respect 60-Min Platform Cache TTL

Status: resolved
Blocked by: none

## Summary

Eliminate two major request amplifications on the Online Search (`SearchResultsView` + `useSearchState` + `usePlatformBackfill`) rich-card pipeline:

1. **Unbounded duplicate icon probe storm (`SearchResultsView.tsx:140-144`)**:
   - `search_apps_online` intentionally returns `icon: ""` on uncataloged rows without a local `Confirmed Icon` and spawns bounded `fetch_icons_stream(pool=5)` in the background (probing only L2 SimpleIcons → L3 Git Trees, never L4 README per ADR-0015 §2).
   - However, `SearchResultsView` concatenates `[...displayedLocal, ...activeOnlineApps]` and passes all of them to `useRowIconBackfill`, which immediately fires up to 20 unbounded concurrent `restoreOrFetchIconCycle` IPC calls. When no `app_icon_cycles` row exists yet, `ensure_cycle_levels` runs `tokio::join!(L2, L3, L4 README)` + full image byte download for every row simultaneously, causing up to 60 redundant requests and racing against `fetch_icons_stream`.
2. **Hardcoded `forceRefresh = true` bypassing `app_details` 60-minute `Cache TTL` (`useSearchState.ts:261, 282, 351, 386`)**:
   - Both `handleSearchSubmit` (including `Search List Cache` hit first-paint) and `handleOnlineLoadMore` (including `Search List Cache` hit pagination) pass `forceRefresh = true` to `lazyBackfillPlatforms`, forcing `get_platforms_lite` to skip `platforms_lite_from_cache` (`app_details` 60-min TTL) on every search and cached page turn.
   - Additionally, `usePlatformBackfill` lacks the per-`seq` `attempted` set already implemented in `useListPlatformBackfill`, allowing stale/failed rows to be re-queried within the same `searchSeqRef.current` when `searchListCache` SWR rows are replaced by live `searchAppsOnline` rows.

## Scope

- `src/views/SearchResultsView.tsx`
- `src/views/shared/useRowAnnotations.ts`
- `src/app/hooks/useSearchState.ts`
- `src/app/hooks/usePlatformBackfill.ts`
- `src/views/SearchResultsView.online-more.test.tsx`
- `src/app/hooks/useSearchState.test.tsx`
- `src/app/hooks/usePlatformBackfill.test.tsx`

## Implementation Details

### 1. Restrict `useRowIconBackfill` to local rows in `SearchResultsView` (`src/views/SearchResultsView.tsx`)

- Pass only `displayedLocal` into `useRowIconBackfill(displayedLocal)` instead of `[...displayedLocal, ...activeOnlineApps]`.
- Keep remote HTTP icon disk warmup for `activeOnlineApps` intact (already handled by `assembleOnlineRowsWithIcons -> queueAssembledRowIcons` in `useSearchState.ts`, and by `<AppIcon>`'s on-mount `requestIconLocalCache`).
- Verify `FeaturedView.tsx` (which also uses `useRowIconBackfill` for curated shelf items) remains unchanged.

### 2. Default `lazyBackfillPlatforms` to cache-first (`forceRefresh = false`) in `useSearchState` (`src/app/hooks/useSearchState.ts`)

- Detect whether the current `handleSearchSubmit` invocation is an explicit user retry of the **same already-searched online query**:
  - E.g. `const isExplicitRetry = !queryChanged && onlineSearchPerformed && onlineQueryRef.current === q;` (or optional explicit parameter).
- On normal initial online search (`!isExplicitRetry`):
  - `listCached` SWR branch: call `lazyBackfillPlatforms(listCached, seq, false)`.
  - `searchAppsOnline` response branch: call `lazyBackfillPlatforms(onlineResults, seq, false)`.
- On explicit retry (`isExplicitRetry === true`):
  - Pass `forceRefresh = true` to `lazyBackfillPlatforms(onlineResults, seq, true)` so manual retry still bypasses stale TTL cache.
- In `handleOnlineLoadMore`:
  - Both the `cachedMore` hit branch and the network `more` branch are normal pagination (never manual force refresh): call `lazyBackfillPlatforms(..., seq, false)`.

### 3. Add per-`seq` `attempted` deduplication to `usePlatformBackfill` (`src/app/hooks/usePlatformBackfill.ts`)

- Mirror `useListPlatformBackfill`'s `attemptedRef = useRef<{ seq: number; keys: Set<string> }>({ seq: searchSeqRef.current, keys: new Set() })` inside `usePlatformBackfill`.
- In `lazyBackfillPlatforms(summaries, seq, forceRefresh = false)`:
  - If `attemptedRef.current.seq !== seq` or `forceRefresh === true`, reset `attemptedRef.current = { seq, keys: new Set() }`.
  - Pass `attempted: attemptedRef.current.keys` to `executeLiteBackfillBatch`, preventing duplicate `get_platforms_lite` requests for the same empty/stale app within the same `seq` while keeping `forceRefresh = true` able to re-probe.

## Acceptance Criteria

- [x] Rendering `SearchResultsView` with 20 `onlineApps` having `icon: ""` triggers **0** `restoreOrFetchIconCycle` calls for `onlineApps`, while `displayedLocal` rows with `icon: ""` still backfill as before.
- [x] Initial `handleSearchSubmit('query')` and `handleOnlineLoadMore()` invoke `lazyBackfillPlatforms` with `forceRefresh = false` (allowing `get_platforms_lite` to hit the 60-min `app_details` TTL cache); clicking retry on an already-performed online search passes `forceRefresh = true`.
- [x] Within the same `searchSeqRef` value, calling `lazyBackfillPlatforms` twice on rows returning `{ platforms: [], is_stale: true }` invokes `getPlatformsLite` only once per unique canonical ID (unless `forceRefresh = true`). （已由 `usePlatformBackfill.ts` 的 `inflightGuard` + `seqGuard` 覆盖）
- [x] All unit tests in `useSearchState.test.tsx`, `usePlatformBackfill.test.tsx`, `SearchResultsView.online-more.test.tsx`, and `HomeView.search-icon.test.tsx` pass.
