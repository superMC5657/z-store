# Issue 04: Trends `v: 2` Slim Ranking Index & `repo_card_cache` Batch Hydration Refactor

Status: resolved
Blocked by: 03

## Summary

Slim `trend_board_cache` down to a pure `v: 2` ranking/stars-gained index (`{ v: 2, items: [{ id, stars, starsGained?, forks? }] }`), eliminate all `saveBoardCacheMerged` read-modify-write and 256KB text-truncation machinery, and wire `TrendBoardSession` to hydrate uncataloged board repos in batch from `repo_card_cache` (`hydrateCardsByIds` / `getRepoCardsBatch`):

1. **Slim `v: 2` `trend_board_cache` Envelope (`src/services/trends/cache.ts`)**:
   - Store only `{ v: 2, items: Array<{ id: string; stars: number; starsGained?: number; forks?: number }> }` (`TREND_DB_PAYLOAD_MAX_BYTES = 32 * 1024`).
   - Treat non-`v: 2` payloads as cache misses; reconstruct `TrendRepo[]` (`id`, `name`, `owner`, `repo`, `stars`, `starsGained`, `forks`, `url`) on read without touching `repoEnrichCache` inside `getDbTrendCache`.
   - Remove `saveBoardCacheMerged`, the 4-stage `AppSummary` truncation ladder, `persistBoardCacheFromDetailIfPresent` (keep a no-op export only if temporarily imported by `useDetailCacheSync.ts` until Issue 05 removes the import), and all debounced/pagehide L2 board rewrites triggered by icon/platform/settle/heal mutations.
2. **Batch Hydration from `repo_card_cache` in `TrendBoardSession` (`src/services/trends/board.ts`)**:
   - When a board loads (from L1, L2 `trend_board_cache`, or network), batch-hydrate uncataloged board `id`s via `hydrateCardsByIds(uncatalogedIds, { uncatalogedOnly: true })` (`get_repo_cards_batch`).
   - Immediately merge hydrated cards (`summary` + `confirmed_other` + confirmed `data:`/URL icons) into `enrichedApps` and `confirmedOtherIds`.
   - In `syncEnrichment`, skip `enrichTrendRepos` network calls for any repo whose card was freshly hydrated (`freshCardIds` / fresh M1 within 12h) unless `forceRefresh === true`; only genuinely missing or expired (>12h) repos enter `enrichTrendRepos` (capped at 40).

## Scope

- Allowed to modify:
  - `src/services/trends/cache.ts`
  - `src/services/trends/board.ts`
  - `src/services/trends/index.ts`
  - `src/services/trends/cache.test.ts`
  - `src/services/trends/swr.test.ts`
  - `src/services/trends/swr-view.test.tsx`
  - `src/services/trends/phase1b.test.ts`
  - `src/services/trends/phase2.test.ts`
  - `src/services/trends/paint-sync.test.ts`
  - `src/services/trends/board.heal.test.ts`
  - `src/views/TrendsView.test.tsx`
  - `src/views/TrendsView.paintSync.test.tsx`
  - `src/views/TrendsView.badges.test.tsx`
  - `src/views/TrendsView.localBadge.test.tsx`
- Do not modify:
  - `src-tauri/*`
  - `src/views/FavoritesView/*`, `src/services/starred/*`, `src/app/hooks/*` (belong to Issue 05)

## Implementation Details

### 1. Slim `v: 2` Board Index Serialization (`src/services/trends/cache.ts`)

- Define `TrendRankIndexItem` & `TrendBoardIndexEnvelope`:
  ```ts
  export interface TrendRankIndexItem {
    id: string;
    stars: number;
    starsGained?: number;
    forks?: number;
  }

  export interface TrendBoardIndexEnvelope {
    v: 2;
    items: TrendRankIndexItem[];
  }
  ```
- `saveDbTrendCache(key: string, board: string, repos: readonly TrendRepo[]): Promise<void>`:
  - Map each valid `TrendRepo` (`owner` & `repo` or `owner/repo` `id`) to `{ id: normalizeId(coord), stars: Math.max(0, Math.round(r.stars || 0)), ...(r.starsGained !== undefined ? { starsGained: r.starsGained } : null), ...(r.forks !== undefined ? { forks: r.forks } : null) }` (deduped in rank order).
  - Precheck `utf8ByteLength(payloadJson) <= 32 * 1024`; serialize writes per `key` via a lightweight Promise chain and call `tauriInvoke(CMD.saveTrendBoardCache, { cacheKey: key, board, payloadJson })`.
- `getDbTrendCache(key: string, board?: string, opts?: { allowStale?: boolean }): Promise<TrendRepo[] | undefined>`:
  - Enforce existing per-board L2 effective TTL (`daily` 1h, others 12h minus 0–30s jitter) and `elapsedMs < 0` clock-skew guard when `!opts?.allowStale`.
  - Accept only `{ v: 2, items: [...] }` with non-empty valid items; reconstruct `TrendRepo` objects (`{ id, name: id, owner, repo, stars, starsGained, forks, url: \`https://github.com/${id}\` }`).
- In `fetchBoardWithL2` and `fetchDoforceShared` (`src/services/trends/board.ts`):
  - Replace `saveBoardCacheMerged(key, board, repos)` with `saveDbTrendCache(key, board, repos)` — called **only** when upstream network fetch succeeds (`result.status === 'ok'` / `repos.length > 0`).

### 2. `TrendBoardSession` Unified Batch Hydration (`src/services/trends/board.ts`)

- In `syncBoard`:
  - First synchronously fill from warm M1 `repoEnrichCache` (`buildSwrFill`).
  - Collect all uncataloged `id`s on the board that missed warm M1 (or are missing display icons), and invoke `hydrateCardsByIds(missingIds, { uncatalogedOnly: true })` (guarded by `sessionEpoch` & `swrBackfillToken`):
    - Merge returned `byId` into `enrichedApps` and `confirmedOtherIds` into `confirmedOtherIds` (`addConfirmedMirror`);
    - Record `freshCardIds` in the session so `syncEnrichment` treats freshly hydrated SQLite cards just like warm M1 hits (skipping `enrichTrendRepos` unless `forceRefresh === true`)!
    - Note: coordinate `syncBoard` hydration and `syncEnrichment` so on cold L2 load, `syncEnrichment` awaits the in-flight DB batch hydration for the current `trendResult` **before** deciding which repos are actually missing and calling `enrichTrendRepos`! (This prevents firing redundant `/repos/{o}/{r}` network requests during the 1–2ms SQLite `get_repo_cards_batch` read!)
- Remove all `scheduleSessionPersist`, `flushSessionPersist`, `pagehide` board rewrites, and L2 board rewrites inside `maybePersistLitePatched`, `confirmLiteEmpty`, `scheduleSettle`, `attachHealBus`, `attachStreamIconListener`, and `subscribeIconWrites` (while keeping all in-memory mirror + M1 `repoEnrichCache` updates intact!).

## Acceptance Criteria

- [ ] Unit tests in `src/services/trends/cache.test.ts` verify:
  - `saveDbTrendCache` writes `{ v: 2, items: [{ id, stars, starsGained, forks }] }` containing zero `AppSummary` fields (`description`, `icon`, `platforms`, `enrich`, `confirmedOther` are absent);
  - `getDbTrendCache` parses `v: 2` envelopes (preserving `stars`, `starsGained`, and `forks` for `doforce` `rising`/`healthy` sorting), rejects legacy `v: 1` or malformed payloads as misses, and honors `daily` 1h / others 12h TTL + jitter + `allowStale`.
- [ ] Session & view tests (`swr.test.ts`, `swr-view.test.tsx`, `board.heal.test.ts`, `TrendsView*.test.tsx`) verify:
  - Cold start with L2 `trend_board_cache` (`v: 2`) + `getRepoCardsBatch` renders full `<AppCard>`s (including persisted `platforms`, `confirmed_other` `Other` badges, and `data:` confirmed icons) and makes **0** `enrichTrendRepos` or `getPlatformsLite` network calls for fresh settled cards;
  - Repos hydrated in State 0 (`platforms: []`, `confirmed_other: false`, fresh `updated_at`) render `<AppCard>` with `platformLoading = true`, skip `enrichTrendRepos`, and run `getPlatformsLite` to deduce platforms;
  - Streaming icons, lite platform patches, and detail healing update `TrendBoardSession` & M1 `repoEnrichCache` immediately **without** invoking `save_trend_board_cache`.
- [ ] `npx tsc --noEmit` and `npx vitest run` pass 100%.
