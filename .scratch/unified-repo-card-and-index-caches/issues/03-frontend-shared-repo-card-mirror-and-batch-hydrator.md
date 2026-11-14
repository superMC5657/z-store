# Issue 03: Frontend Shared Repo-Card M1 Mirror Upgrade, Unified Batch Hydrator & Slim Page-Index Cache Foundation

Status: resolved
Blocked by: 02

## Summary

Upgrade the shared frontend cache services (`src/services/repoEnrichCache.ts`, `src/services/trends/enrich.ts`, `src/services/search/searchListCache.ts`, `src/services/starred/starredMemory.ts`) so all three views share a single in-memory M1 mirror of `repo_card_cache`, a unified batch hydration pipeline by canonical `id[]`, and a slim ID-only page list cache (`v: 2`):

1. **Three-State Uncataloged Card Mirror (`trends/enrich.ts` & `repoEnrichCache.ts`)**:
   - Allow M1 `repoEnrichCache` to store lightweight uncataloged cards across all three platform states (`concrete platforms` > `confirmedOther` > `unknown []`), obeying monotonic non-destructive field merge (`fillMissingFromPrev`, never letting empty/placeholder fields or unknown `[]` overwrite real fields, concrete platforms, or `confirmedOther`), stripping `data:` icons (while admitting `data:`/URL into `iconStore` M1 buffer) and catalog annotations (`is_cataloged`/`source`/`status`), tracking `updatedAt` and in-memory `privateIds`, and purging `privateIds` on logout.
2. **Unified Batch Hydrator by Ordered `id[]` (`hydrateCardsByIds` in `repoEnrichCache.ts`)**:
   - Given an ordered list of `ids`, resolve cataloged hits from `catalogApps`/`localApps` first, warm uncataloged hits from M1 `repoEnrichCache` + `iconStore`, and M1 misses via a single `tauriApi.getRepoCardsBatch(missingIds)` IPC call, returning aligned `{ rows, byId, confirmedOtherIds }`.
3. **Slim ID-Only `searchListCache` (L1 Memory + L2 SQLite `search_list_cache` Envelope `v: 2`)**:
   - Refactor `searchListCache.ts` so L1 buckets store slim `{ at, ids: string[], hasMore: boolean, hasPrivate?: boolean }` instead of duplicated `AppSummary[]` arrays, delegating card storage to M1 `repoEnrichCache` and adding `readDbSearchListCache` / `saveDbSearchListCache` (`{ v: 2, ids, hasMore }`, 32KB FE precheck).

## Scope

- Allowed to modify:
  - `src/services/repoEnrichCache.ts`
  - `src/services/repoEnrichCache.test.ts`
  - `src/services/trends/enrich.ts`
  - `src/services/trends/index.ts` (if re-exporting shared helpers)
  - `src/services/search/searchListCache.ts`
  - `src/services/search/searchListCache.patch.test.ts`
  - `src/services/search/onlineRows.ts`
  - `src/services/starred/starredMemory.ts`
  - `src/services/starred/starredMemory.test.ts`
- Do not modify:
  - `src-tauri/*` (backend completed in Issues 01–02)
  - `src/services/trends/cache.ts`, `src/services/trends/board.ts`, `src/views/TrendsView*` (belong to Issue 04)
  - `src/app/hooks/*`, `src/services/starred/starredCache.ts`, `src/views/FavoritesView/*`, `src/views/SearchResultsView*` (belong to Issue 05; keep backwards-compatible function signatures on `readSearchListCache` / `writeSearchListCache` / `patchSearchListCacheRows` / `patchSearchListCacheIcon` until Issue 05 migrates callers, or make existing signatures seamlessly backed by the slim ID index + M1 card pool so the entire test suite stays green at the end of Issue 03!)

## Implementation Details

### 1. Three-State M1 `repoEnrichCache` & Privacy Tracking (`trends/enrich.ts` & `repoEnrichCache.ts`)

- Update `putTrendEnrichCache` / `putTrendEnrichMemory` in `src/services/trends/enrich.ts` and `repoEnrichCache.ts`:
  - Accept valid uncataloged `AppSummary` cards (`id`, `owner`, `repo` non-empty, `is_stale !== true`, `is_cataloged !== true`) even when `platforms` is `[]` and not yet `confirmedOther` (State 0: card shell known, platform pending), merging onto any existing entry via `fillMissingFromPrev` + `resolveIconWithBuffer`:
    - Strip `is_cataloged`, `source`, `status` via `stripCatalogAnnotations`;
    - If `icon` starts with `data:`, admit into `admitIconHit({ id, icon, via: 'm2' })` and strip `data.icon = ''` in the card pool;
    - If existing entry has concrete `platforms` and incoming has `platforms: []`, preserve existing `platforms` and `latest_version`;
    - If incoming has concrete `platforms`, automatically unmark `trendConfirmedOtherCache`.
  - Distinguish **card presence** (`peekFreshRepoCard(id)`: returns State 0 / State 1 / State 2 card within 12h TTL) from **platform-settled presence** (`readSharedRepoEnrich(id)` / `hasSettledRepoPlatforms(id)`):
    - Ensure `hydrateRowFromSharedEnrich(row)` backfills `platforms` + non-placeholder `latest_version` when pooled card has concrete platforms, and backfills missing non-placeholder `description`/`license`/`homepage`/`icon` when incoming row is a bare shell, while keeping `row` reference unchanged if nothing improved.
  - Track `privateRepoIds = new Set<string>()` in `repoEnrichCache.ts`:
    - `recordSharedPrivateRepos(ids: readonly string[])`: records canonical lowercase IDs;
    - `clearPrivateSharedRepoCards()`: deletes every ID in `privateRepoIds` from `trendEnrichCache` and `trendConfirmedOtherCache`, then clears `privateRepoIds`.

### 2. Unified Batch Hydrator (`hydrateCardsByIds` in `src/services/repoEnrichCache.ts`)

- Export `HydrateCardsOptions` & `HydrateCardsResult`:
  ```ts
  export interface HydrateCardsOptions {
    catalogApps?: readonly AppSummary[];
    localApps?: readonly AppSummary[];
    /** Trends 场景下仅水合未收录项时可设为 true，跳过本地 catalogApps 数组扫描而交由后端或调用方匹配。 */
    uncatalogedOnly?: boolean;
  }

  export interface HydrateCardsResult {
    /** 按入参有序返回已水合的卡片（缺失 id 跳过）。 */
    rows: AppSummary[];
    /** 归一小写 id → 已水合卡片（图标已过 M1 缓冲合并）。 */
    byId: Map<string, AppSummary>;
    /** 本批命中已确认 Other 的归一小写 id 集。 */
    confirmedOtherIds: string[];
    /** 数据库 `updated_at` 仍在 12h 新鲜窗口内的归一小写 id 集（供趋势榜跳过重复 enrich_trend_repos）。 */
    freshCardIds: Set<string>;
  }
  ```
- Flow inside `hydrateCardsByIds(ids: readonly string[], opts?: HydrateCardsOptions)`:
  1. Deduplicate normalized non-empty `ids` while remembering original order.
  2. Resolve catalog hits from `opts.catalogApps` / `opts.localApps` (when `!opts.uncatalogedOnly` and non-empty catalog passed).
  3. Check M1 `peekFreshRepoCard(id)` for remaining IDs (merging buffered icon from `resolveIconWithBuffer`, collecting `isSharedRepoConfirmedOther(id)` into `confirmedOtherIds`, and marking `freshCardIds`).
  4. For IDs still missing from M1, call `tauriApi.getRepoCardsBatch(missingIds)` once:
     - For each returned `HydratedRepoCard`:
       - If `card.summary.icon` is non-empty (`data:` or `http(s)`), call `admitIconHit({ id, icon: card.summary.icon, via: 'm2' })`;
       - If `card.is_private`, call `recordSharedPrivateRepos([id])`;
       - If `card.confirmed_other`, call `markConfirmedOthersFreshNow([id])` and push to `confirmedOtherIds`;
       - Upsert uncataloged `card.summary` into M1 `repoEnrichCache` preserving its backend `card.updated_at * 1000` timestamp (if `Date.now() - card.updated_at * 1000 < TREND_ENRICH_CACHE_TTL_MS`, add `id` to `freshCardIds`).
  5. Assemble ordered `rows` + `byId` (applying `resolveIconWithBuffer` so `data:` icons admitted in step 4 appear on the returned `AppSummary` objects in memory!).

### 3. Slim `searchListCache` L1 + L2 (`src/services/search/searchListCache.ts` & `starredMemory.ts`)

- Slim L1 bucket entry to:
  ```ts
  interface SearchListIndexEntry {
    at: number;
    ids: string[];
    hasMore: boolean;
    hasPrivate?: boolean;
  }
  ```
- Keep `writeSearchListCache(key, rows, opts?: { hasMore?: boolean; hasPrivate?: boolean; catalogApps?: readonly AppSummary[] })` backwards-compatible:
  - Push uncataloged `rows` into M1 `repoEnrichCache` (and cataloged `rows` into a lightweight ephemeral lookup or M1 lookup so synchronous `readSearchListCacheEntry` / `findInSearchListCache` resolves `ids → AppSummary[]` seamlessly without storing per-bucket copies!).
  - Consequently, `patchSearchListCacheIcon` and `patchSearchListCacheRows` update the single shared card store (and notify `searchListPatchSubscribers`) without O(buckets × pages × rows) duplicate array cloning!
- Add L2 SQLite `search_list_cache` helpers (`v: 2`):
  - `export const SEARCH_LIST_DB_MAX_BYTES = 32 * 1024;`
  - `export interface SearchListIndexEnvelope { v: 2; ids: string[]; hasMore: boolean }`
  - `export function buildSearchListDbKey(query: string, page: number, perPage: number): { cacheKey: string; normQuery: string }` (`cacheKey = "${normQuery}|${page}|${perPage}"`)
  - `export async function readDbSearchListCache(key: SearchListKey, opts?: { allowStale?: boolean; now?: number }): Promise<{ ids: string[]; hasMore: boolean; cachedAt: number; isFresh: boolean; withinTtl: boolean } | undefined>`
  - `export function saveDbSearchListCache(key: SearchListKey, ids: readonly string[], hasMore: boolean, hasPrivate = false): Promise<void>` (per-key serialized chain, skips empty `ids` or `> 32KB`).
- In `src/services/starred/starredMemory.ts`:
  - In `forgetPrivateStarredQueries()`, also call `clearPrivateSharedRepoCards()` and `clearPrivateSearchListCacheEntries()` (evicting any L1 `search` bucket entries marked `hasPrivate: true`).

## Acceptance Criteria

- [ ] Unit tests in `repoEnrichCache.test.ts` verify:
  - State 0 (empty unconfirmed platforms), State 1 (`confirmedOther`), and State 2 (concrete platforms) cards round-trip in M1 without `data:` icons or catalog annotations (`is_cataloged`, `source`, `status`), and State 0 / State 1 writes never overwrite existing concrete platforms or real versions/descriptions;
  - `hydrateCardsByIds` resolves warm M1 cards with 0 IPC calls, batch-fetches only M1 misses via `getRepoCardsBatch`, restores `data:` icons via `iconStore` onto returned `rows` while keeping M1 card storage `data:`-free, restores `confirmedOtherIds` & `freshCardIds`, and `clearPrivateSharedRepoCards` purges private cards on logout.
- [ ] Unit tests in `searchListCache.patch.test.ts` and `starredMemory.test.ts` verify L1 stores slim `ids` indexes, single-source patching reflects immediately on `readSearchListCache`, L2 `readDbSearchListCache` / `saveDbSearchListCache` round-trips `{ v: 2, ids, hasMore }`, and logout clears both `@me:` starred entries and `hasPrivate` search entries + private repo cards.
- [ ] `npx tsc --noEmit` and `npx vitest run` pass 100%.
