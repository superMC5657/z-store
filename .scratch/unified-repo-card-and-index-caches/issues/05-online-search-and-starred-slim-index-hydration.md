# Issue 05: Online Search L2 Slim Index Hydration & `StarredFeed` `v: 2` Index Refactor

Status: resolved
Blocked by: 03, 04

## Summary

Complete the slim ID-index + `repo_card_cache` batch hydration refactor across Online Search (`useSearchState.ts`, `useDetailCacheSync.ts`, `usePlatformBackfill.ts`) and GitHub Star (`src/services/starred/starredCache.ts`, `src/views/FavoritesView/StarredFeed.tsx`):

1. **Online Search L2 Snapshot Persistence & Cold-Start Hydration (`useSearchState.ts`)**:
   - On `handleSearchSubmit` (`!forceRefresh`): after checking L1 `searchListCache`, fall back on L1 miss to SQLite `readDbSearchListCache` (`{ v: 2, ids, hasMore }`) + `hydrateCardsByIds(ids)` from `CatalogService` and `repo_card_cache` (`< 5min` zero-network instant return; `≥ 5min` instant SWR first paint + silent background `searchAppsOnline(..., forceRefresh = false)` ETag `304` revalidation).
   - On `handleOnlineLoadMore`: check L1 → fresh L2 (`withinTtl` < 30min) + `hydrateCardsByIds` → else network `searchAppsOnline`.
   - On live non-stale `searchAppsOnline` response: record `confirmed_other_ids` and `private_ids` into `repoEnrichCache` & `platformResolvedOtherIds`, write L1 `searchListCache`, and persist slim `{ v: 2, ids, hasMore }` to SQLite `saveDbSearchListCache` (`hasPrivate = (res.private_ids?.length ?? 0) > 0`).
2. **GitHub Star Slim `v: 2` Index & One-Pass Hydration (`starredCache.ts` & `StarredFeed.tsx`)**:
   - Slim `StarredCacheEnvelope` to `{ v: 2, pages: Array<{ page: number; ids: string[] }>, hasMore: boolean }` (first 3 pages / max 60 IDs, 32KB FE precheck, zero `AppSummary` fields, zero text-truncation ladder).
   - Hydrate cold-mount and target-switch snapshots in a single pass via `hydrateCardsByIds` (recovering curated cards, uncataloged `repo_card_cache` cards, `platforms`, `confirmed_other`, and confirmed `data:` icons without a separate `getConfirmedIconsBatch` IPC roundtrip).
   - Write slim `{ v: 2, pages, hasMore }` directly when network sync (`syncFirstPage` / `handleLoadMore`) resolves (removing the 800ms debounced full-row rewrite `useEffect` on `[rows, resolvedOtherIds]`, while keeping logout protection so `@me:` never saves after logout).
3. **Detail Sync Cleanup (`useDetailCacheSync.ts`)**:
   - Remove obsolete `persistBoardCacheFromDetailIfPresent` call/export now that `get_app_details` directly updates `repo_card_cache` on the backend and `trend_board_cache` holds only slim ranking IDs.

## Scope

- Allowed to modify:
  - `src/app/hooks/useSearchState.ts`
  - `src/app/hooks/useSearchState.test.tsx`
  - `src/app/hooks/usePlatformBackfill.ts`
  - `src/app/hooks/usePlatformBackfill.test.tsx`
  - `src/app/hooks/useDetailCacheSync.ts`
  - `src/app/hooks/useDetailCacheSync.test.tsx`
  - `src/services/starred/starredCache.ts`
  - `src/services/starred/starredCache.test.ts`
  - `src/views/FavoritesView/StarredFeed.tsx`
  - `src/views/FavoritesView/StarredFeed.test.tsx`
  - `src/views/SearchResultsView.online-more.test.tsx`
  - `src/views/HomeView.search-icon.test.tsx`
  - `src/services/trends/board.ts` & `src/services/trends/index.ts` (only to remove any temporary `persistBoardCacheFromDetailIfPresent` shim if kept in Issue 04)
- Do not modify:
  - `src-tauri/*`

## Implementation Details

### 1. Online Search L1 + L2 Slim Index & Hydration (`src/app/hooks/useSearchState.ts`)

- Inject or pass `catalogAppsRef` (i.e. `fullCatalogAppsRef` / `appsRef` from `App.tsx`, optional with safe empty default so standalone hook tests require zero boilerplate changes!) into `useSearchState` for zero-IPC catalog card resolution during hydration.
- In `handleSearchSubmit(queryToSubmit?, opts?: { forceRefresh?: boolean })`:
  - **Path A — Warm L1 hit (`!forceRefresh`)**:
    - `readSearchListCacheEntry({ query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE })`
    - Hydrate any missing IDs via `hydrateCardsByIds` if needed, assemble via `assembleOnlineRowsWithIcons`, mark `confirmedOtherIds` via `confirmPlatformOtherIds`, run `lazyBackfillPlatforms(assembled, seq, false)`, and short-circuit if `cacheHit.isFresh` (`< 5min`).
  - **Path B — Cold L2 SQLite hit (`!forceRefresh` and L1 missed)**:
    - Query `await readDbSearchListCache({ query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE }, { allowStale: true })`; guard `guardFreshSearch(seq)`.
    - If hit with non-empty `ids`:
      - Call `const hydrated = await hydrateCardsByIds(l2Hit.ids, { catalogApps: catalogBase })`; guard `guardFreshSearch(seq)`.
      - Only paint the L2 snapshot if `hydrated.rows.length > 0` (if `hydrated.rows.length === l2Hit.ids.length`, all cards hydrated cleanly; if partial LRU eviction occurred, only short-circuit zero-network when `l2Hit.isFresh && hydrated.rows.length === l2Hit.ids.length`, otherwise paint available cards and let background SWR `searchAppsOnline` refresh the full page!).
      - Mark `hydrated.confirmedOtherIds` on `confirmPlatformOtherIds`, seed L1 `writeSearchListCache` when `l2Hit.withinTtl`, call `lazyBackfillPlatforms(assembled, seq, false)`, set `hadCacheHit = true`, and `if (l2Hit.isFresh && hydrated.rows.length === l2Hit.ids.length) return;`.
  - **Path C — Live `searchAppsOnline` response**:
    - Record `pageRes.confirmed_other_ids` via `recordSharedConfirmedOthers` + `confirmPlatformOtherIds`, and `pageRes.private_ids` via `recordSharedPrivateRepos`.
    - Record `deduped` into M1 `repoEnrichCache`.
    - When `!pageRes.is_stale` and `deduped.length > 0`:
      - Write L1 `writeSearchListCache({ query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE }, deduped, { hasMore, hasPrivate })`;
      - Write L2 `void saveDbSearchListCache({ query: q, page: 1, perPage: ONLINE_SEARCH_PER_PAGE }, deduped.map((r) => normalizeId(r.id)), hasMore, hasPrivate)`.
- Apply the symmetric L1 → fresh L2 (`allowStale: false`, `< 30min` + full hydration) → network `searchAppsOnline` + `saveDbSearchListCache` flow in `handleOnlineLoadMore`.

### 2. `StarredFeed` & `starredCache.ts` Slim `v: 2` Index Refactor

- Update `src/services/starred/starredCache.ts`:
  ```ts
  export interface StarredPageIds {
    page: number;
    ids: string[];
  }

  export interface StarredCacheEnvelope {
    v: 2;
    pages: StarredPageIds[];
    hasMore: boolean;
  }
  ```
  - `buildStarredEnvelopeJson(envelope)`:
    - Normalize and deduplicate `ids` across pages, cap at `STARRED_L2_MAX_PERSISTED_PAGES = 3` and `STARRED_L2_MAX_PERSISTED_ROWS = 60` total IDs (setting `hasMore = true` whenever truncated by page count or total ID count).
    - Drop all `AppSummary` sanitization/truncation helpers; reject if total IDs across pages is `0` or UTF-8 length exceeds `32 * 1024`.
  - `parseEnvelope(json)`: accept only `v === 2` with non-empty valid `pages` containing at least one canonical `id`; legacy `v: 1` returns `undefined`.
- Update `src/views/FavoritesView/StarredFeed.tsx`:
  - Track per-page ordered IDs `pageIdsRef = useRef<StarredPageIds[]>([])` alongside `StarredQueryMemory`.
  - `hydrateSnapshot(target, hit)`:
    - Flatten `allIds` across `hit.envelope.pages`.
    - Call `const hydrated = await hydrateCardsByIds(allIds, { catalogApps, localApps })` (guarded by `gen === queryGenRef.current` and `belongsToLogin(target, loginRef.current)`!).
    - If `hydrated.confirmedOtherIds.length > 0`, notify `onConfirmPlatformOtherIds?.(hydrated.confirmedOtherIds)`.
    - Reconstruct per-page slices using `hydrated.byId`, seed L1 `searchListCache(ns='starred')` if `hit.isFresh`, and call `showQuery` with `assembleOnlineRowsWithIcons([], hydrated.rows)`.
  - On `fetchPage` / `syncFirstPage` / `handleLoadMore`:
    - Record `res.confirmed_other_ids` (`recordSharedConfirmedOthers` + `onConfirmPlatformOtherIds`) and `res.private_ids` (`recordSharedPrivateRepos`).
    - Update `pageIdsRef.current` for the synced page(s), and if `belongsToLogin(target, loginRef.current)` & `isNetworkSynced(target.key)`, immediately persist slim `{ v: 2, pages: pageIdsRef.current, hasMore }` via `void saveDbStarredCache(target.key, target.key, envelope)` (only when total IDs > 0 and `!res.is_stale`).
    - Delete the 800ms debounced `useEffect` + `pendingSaveRef` unmount flush that previously rewrote `starred_feed_cache` on every row/icon/platform mutation!

## Acceptance Criteria

- [x] Unit tests in `starredCache.test.ts` verify `buildStarredEnvelopeJson` produces `{ v: 2, pages: [{ page, ids }], hasMore }`, caps at 3 pages / 60 IDs with `hasMore: true`, contains zero `AppSummary` fields, and `readDbStarredCache` rejects `v: 1` envelopes, future timestamps, and >12h stale rows unless `allowStale: true`.
- [x] Component tests in `StarredFeed.test.tsx` verify:
  - Cold mount reads `getStarredFeedCache` (`v: 2` IDs) + `getRepoCardsBatch` once to render full `<AppCard>`s with persisted `platforms`, `confirmed_other` badges, and `data:`/URL icons with **0** `listGithubStarred` calls and **0** `getPlatformsLite` calls for already-settled repos;
  - Manual re-sync keeps old cards on screen, writes slim `v: 2` `{ pages, hasMore }` to `saveStarredFeedCache`, and platform/icon updates do not trigger redundant `saveStarredFeedCache` writes;
  - Logging out clears `@me:` UI state, L1 memory, and private cards in `repoEnrichCache`, and never writes `@me:` back to `saveStarredFeedCache`.
- [x] Hook tests in `useSearchState.test.tsx` verify:
  - Cold search (empty L1 memory, populated L2 `getSearchListCache` + `getRepoCardsBatch`) paints hydrated cards immediately: `< 5min` makes **0** `searchAppsOnline` calls, while `> 5min` paints immediately (SWR) and revalidates silently via `searchAppsOnline(..., forceRefresh = false)`;
  - Live non-stale search writes `{ v: 2, ids, hasMore }` (and `hasPrivate = true` when `private_ids` is non-empty) to `saveSearchListCache`, and honors `confirmed_other_ids` so settled `Other` rows skip `getPlatformsLite`.
- [x] `npx tsc --noEmit` and `npx vitest run` pass 100%.
