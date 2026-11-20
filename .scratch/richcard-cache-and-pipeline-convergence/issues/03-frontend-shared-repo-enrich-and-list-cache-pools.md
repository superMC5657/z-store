# Issue 03: Frontend Shared Single-Repo Enrich Pool & Namespace-Isolated `searchListCache`

Status: resolved
Blocked by: none

## Summary

Establish the two pure-frontend caching primitives shared by Online Search, Trends, and GitHub Star:

1. **Three-Pipeline Shared Single-Repo Rich Card & Platform Pool (`src/services/repoEnrichCache.ts` + `src/services/trends/enrich.ts` + `src/services/search/onlineRows.ts`)**:
   - Promote the concrete-platform `AppSummary` cache and `confirmedOther` 12h memory cache into a clean shared module seam so uncataloged repositories enriched or platform-verified in **any** of the three views (`TrendsView`, `SearchResultsView`, `StarredFeed`) immediately share concrete `platforms`, non-placeholder `latest_version`, and `confirmedOther` status without duplicate `get_platforms_lite` IPC calls.
2. **Namespace-Isolated `searchListCache` with 5-Minute Fresh Tier (`src/services/search/searchListCache.ts`)**:
   - Separate FIFO capacity per `namespace` (`'search'` vs `'starred'`, 50 pages each) so deep Star pagination never evicts Search results and vice versa.
   - Add a 5-minute fresh tier (`SEARCH_LIST_FRESH_MS = 5 * 60 * 1000`) within the 30-minute TTL (`SEARCH_LIST_TTL_MS = 30 * 60 * 1000`) and namespace/prefix invalidation (`clearSearchListCacheNamespace`) for OAuth logout / account switches.

## Scope

- Allowed to create / modify:
  - `src/services/repoEnrichCache.ts` (new, clean shared interface delegating to / unifying with `trends/enrich.ts`)
  - `src/services/repoEnrichCache.test.ts` (new)
  - `src/services/trends/enrich.ts`
  - `src/services/search/onlineRows.ts`
  - `src/services/search/searchListCache.ts`
  - `src/services/search/searchListCache.patch.test.ts`
- Do not modify:
  - `src-tauri/*` (backend files)
  - `src/app/hooks/*` & `src/views/*` (belong to Issues 04 & 05)

## Implementation Details

### 1. Shared Single-Repo Rich Card & Platform Pool (`src/services/repoEnrichCache.ts` & `src/services/trends/enrich.ts`)

- Raise `TREND_ENRICH_CACHE_MAX_ENTRIES` and `TREND_CONFIRMED_OTHER_MAX_ENTRIES` in `src/services/trends/enrich.ts` from `500` to `600` (matching `ICON_STORE_MAX_ENTRIES = 600` in `iconStore.ts`), keeping TTL `12h` (`TREND_ENRICH_CACHE_TTL_MS`).
- Ensure `putTrendEnrichCache` strips runtime catalog annotations (`source`, `status`, `is_cataloged`) in addition to `data:` icons so shared entries never leak stale catalog stamps across local collect/revert transitions.
- Expose `src/services/repoEnrichCache.ts` as the cross-view shared seam (backed by the single underlying store in `trends/enrich.ts` so Trends, Search, Starred, and `useDetailCacheSync` read/write one source of truth with zero duplicate Maps):
  - `readSharedRepoEnrich(idOrCoord: string): AppSummary | undefined` — returns fresh (`< 12h`) entry if present.
  - `isSharedRepoConfirmedOther(idOrCoord: string): boolean` — delegates to `isTrendConfirmedOtherFresh`.
  - `hydrateRowFromSharedEnrich(row: AppSummary): AppSummary` — pure helper:
    - Looks up `normalizeId(row.id)` and `owner/repo` in the shared pool.
    - If `(!row.platforms || row.platforms.length === 0)` and the cached entry has concrete `platforms.length > 0`, returns a shallow copy with `platforms: [...hit.platforms]` (and if `(row.latest_version === '' || row.latest_version === 'latest')` while `hit.latest_version` is non-empty and not `'latest'`/`'...'`, upgrades `latest_version` as well).
    - Otherwise returns `row` unchanged (preserving reference identity).
  - `recordSharedRepoPlatforms(rows: readonly AppSummary[], patched?: ReadonlyMap<string, string[]>): void`:
    - For rows with concrete `platforms.length > 0` (either already on `row` or via `patched` map), writes them into the shared pool via `putTrendEnrichMemory` (automatically evicting any stale `confirmedOther` mark).
  - `recordSharedConfirmedOthers(ids: readonly string[]): void` — delegates to `markTrendConfirmedOthers`.
- **Wire into `assembleOnlineRowsWithIcons` (`src/services/search/onlineRows.ts`)**:
  - After `resolveIconWithBuffer(prevById.get(k), m)`, pipe the row through `hydrateRowFromSharedEnrich(...)` so any Search or Starred row whose repo already has concrete platforms in the shared pool paints its OS icons immediately on frame 1!

### 2. Namespace-Isolated `searchListCache` & Freshness Tiers (`src/services/search/searchListCache.ts`)

- Export constants:
  - `export const SEARCH_LIST_FRESH_MS = 5 * 60 * 1000;` (5 min fresh short-circuit window)
  - `export const SEARCH_LIST_TTL_MS = 30 * 60 * 1000;` (30 min SWR / max retention window)
  - `export const SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE = 50;`
- Replace the single global `Map` with `Map<string /* namespace */, Map<string /* cacheKey */, SearchListCacheEntry>>` so `'search'` and `'starred'` each hold up to `50` pages FIFO independently without evicting each other.
- Add `readSearchListCacheEntry(key: SearchListKey): { rows: AppSummary[]; at: number; isFresh: boolean } | undefined`:
  - Applies existing clock-rollback (`elapsed < 0`) and `elapsed >= SEARCH_LIST_TTL_MS` eviction guards.
  - Sets `isFresh = elapsed < SEARCH_LIST_FRESH_MS`.
  - Keep `readSearchListCache(key)` returning `readSearchListCacheEntry(key)?.rows` so all existing callers and tests stay 100% compatible.
- Add `touchSearchListCache(key: SearchListKey): void` to refresh `at = Date.now()` when a background revalidation confirms no row changes.
- Add `clearSearchListCacheNamespace(namespace: string, queryPrefix?: string): void`:
  - Clears an entire namespace bucket (or only entries whose normalized `norm` starts with `queryPrefix.trim().toLowerCase()`, e.g. `'@me:'` when logging out).
- Ensure `findInSearchListCache`, `sweepExpiredSearchListCache`, `clearSearchListCache`, `patchSearchListCacheIcon`, and `patchSearchListCacheRows` iterate cleanly across all namespace buckets.

## Acceptance Criteria

- [x] Unit tests in `src/services/repoEnrichCache.test.ts` verify:
  - A concrete-platform summary written from Trends (`putTrendEnrichMemory`) immediately hydrates `platforms` and `latest_version` in `assembleOnlineRowsWithIcons` for Search/Starred rows while stripping `data:` icons and catalog annotations (`is_cataloged`/`source`/`status`).
  - Concrete platforms recorded via `recordSharedRepoPlatforms` clear `isSharedRepoConfirmedOther` and never get overwritten by empty-platform loading rows.
- [x] Unit tests in `src/services/search/searchListCache.patch.test.ts` verify:
  - Writing 60 `'starred'` entries evicts only `'starred'` FIFO entries beyond 50 and leaves `'search'` entries 100% intact.
  - `readSearchListCacheEntry` reports `isFresh: true` at `< 5min`, `isFresh: false` at `5min..30min`, and `undefined` at `>= 30min` or negative clock skew.
  - `clearSearchListCacheNamespace('starred', '@me:')` removes `@me:alice` entries while preserving public `'starred|torvalds|...'` and `'search|...'` entries.
- [x] `npx tsc --noEmit` and `npx vitest run src/services/repoEnrichCache.test.ts src/services/search/ src/services/trends/` pass with 0 errors.
