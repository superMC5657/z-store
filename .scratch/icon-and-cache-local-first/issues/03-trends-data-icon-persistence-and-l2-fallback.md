# Issue 03: Trends Rich-Card `data:` Icon Persistence Fix & L2 Stale Fallback Under Network Fluctuation

Status: done
Blocked by: 01, 02

## Summary

Fix two critical caching defects in `TrendsView` (`src/services/trends/enrich.ts`, `src/services/trends/cache.ts`, `src/services/trends/boards.ts`, `src/services/trends/board.ts`, `src-tauri/src/db/cache.rs`) that cause rich cards and their cached icons to vanish when the network fluctuates:

1. **Rich cards with local confirmed icons (`data:`) are completely dropped from `trendEnrichCache` (L1) and `trend_board_cache` (L2)**:
   - When `enrich_trend_repos` returns a rich card whose icon was resolved from local disk as `data:image/...`:
     - `enrichTrendReposCore` (`src/services/trends/enrich.ts:503`) executes `if (typeof s.icon === 'string' && s.icon.startsWith('data:')) return;`, skipping `putTrendEnrichCache`!
     - `putTrendEnrichMemory` (`src/services/trends/enrich.ts:320`) executes `if (typeof summary.icon === 'string' && summary.icon.startsWith('data:')) continue;`, skipping the entire rich card when `flushBoardPersistWithMirror` hydrates from the view mirror!
     - `saveDbTrendCache` (`src/services/trends/cache.ts:316`) executes `if (isDataIcon(summary.icon)) continue;`, dropping the entire rich card from the SQLite `trend_board_cache` envelope!
   - As a result, any rich card that has both concrete platforms and a local `data:` icon is never persisted to L1 or L2 cache. On the next board switch or reload during network fluctuation, those cards miss L1/L2 cache and fall back to network `enrich_trend_repos`, degrading to bare rows if the network is unstable.
2. **Expired L2 `trend_board_cache` is not used as a stale fallback when network fetch fails, and `prune_expired_trend_board_cache` deletes rows too aggressively**:
   - In `boards.ts` (`fetchBoardWithL2` and `fetchDoforceShared`), when L2 cache is expired (or on `forceRefresh`) and the network fetch fails (`status === 'error'`), it immediately shows the error screen instead of falling back to the local SQLite `trend_board_cache` row (`stale: true`).
   - In `src-tauri/src/db/cache.rs:333`, `prune_expired_trend_board_cache` deletes `trend_board_cache` rows as soon as `cached_at` exceeds 1h (`daily`) or 12h (other), leaving nothing on disk for offline/weak-network fallback.

## Scope

- `src/services/trends/enrich.ts`
- `src/services/trends/cache.ts`
- `src/services/trends/boards.ts`
- `src/services/trends/board.ts`
- `src-tauri/src/db/cache.rs`
- `src/services/trends/enrich.simplify.test.ts`
- `src/services/trends/cache.test.ts`
- `src/services/trends/swr-view.test.tsx`

## Implementation Details

### 1. Strip `data:` to `icon: ''` instead of dropping the entire rich card (`src/services/trends/enrich.ts` & `cache.ts`)

- In `src/services/trends/enrich.ts`:
  - In `enrichTrendReposCore` (around line 502):
    - Remove `if (typeof s.icon === 'string' && s.icon.startsWith('data:')) return;`.
    - When `hasConcretePlatforms(s.platforms)` is `true`, call `putTrendEnrichCache(key, { timestamp: at, data: s })` — `putTrendEnrichCache` (lines 249–253) **already** resolves sticky icon and strips `data:` to `icon: ''` (`typeof resolved.icon === 'string' && resolved.icon.startsWith('data:') ? { ...resolved, icon: '' } : resolved`) while keeping `data:` in `iconStore` M1 (`admitIconHit({ id: key, icon: rawIcon, via: 'm2' })` at line 493)!
  - In `putTrendEnrichMemory` (around line 320):
    - Replace `if (typeof summary.icon === 'string' && summary.icon.startsWith('data:')) continue;` with stripping `data:` (or delegating directly to `putTrendEnrichCache`, which already strips `data:` to `icon: ''`), after admitting the `data:` icon into `iconStore` (`admitIconHit({ id: key, icon: summary.icon, via: 'm2' })`).
- In `src/services/trends/cache.ts`:
  - In `saveDbTrendCache` (around line 316):
    - Instead of `if (isDataIcon(summary.icon)) continue;`, sanitize the icon field:
      ```ts
      const cleanSummary = isDataIcon(summary.icon) ? { ...summary, icon: '' } : summary;
      sanitizedEnrich[cleanKey] = stripCatalogAnnotations(cleanSummary);
      ```
    - This guarantees that `trend_board_cache` never contains base64 `data:` strings (preserving the 256KB payload budget and all `not.toContain('data:image/')` invariants) while **never dropping the rich card itself**!
- In `src/services/trends/board.ts`:
  - Increase default `cap` in `collectEmptyIconKeys(mirror, cap = 200)` from `ASSEMBLED_ROW_ICON_QUEUE_CAP` (30) to `200` so that all cards on a trend board get their confirmed icons restored via the single DB-only `getConfirmedIconsBatch` call on remount.

### 2. L2 Stale Fallback on Network Error (`src/services/trends/cache.ts` & `boards.ts`)

- In `src/services/trends/cache.ts`:
  - Update `getDbTrendCache(key: string, board?: string, opts?: { allowStale?: boolean }): Promise<TrendRepo[] | undefined>`:
    - When `opts?.allowStale !== true`, keep the existing `elapsedMs >= trendL2EffectiveTtlMs(...)` freshness check.
    - When `opts?.allowStale === true`, skip the TTL upper-bound check (still requiring valid `v === 1` envelope and non-empty `repos`) so expired L2 rows can be recovered when the network is down or fluctuating.
- In `src/services/trends/boards.ts`:
  - In `fetchBoardWithL2`:
    - When `const result = await load();` returns `result.status === 'error'`:
      - Attempt `const staleHit = await getDbTrendCache(key, board, { allowStale: true });`
      - If `staleHit && staleHit.length > 0`, hydrate `enrich` and `confirmedOther` into memory, call `emitBoardHydrated(board, key)`, and return `{ repos: staleHit, status: 'ok', stale: true }`.
  - In `fetchDoforceShared`:
    - Wrap `fetchDoforceWithRetry()` in a `try/catch`: if it throws, attempt `const staleHit = await getDbTrendCache(key, 'doforce', { allowStale: true });`. If `staleHit && staleHit.length > 0`, hydrate `enrich` and `confirmedOther`, call `emitBoardHydrated('doforce', key)`, and return `staleHit` (otherwise rethrow the original error).

### 3. Extend SQLite `prune_expired_trend_board_cache` retention window (`src-tauri/src/db/cache.rs`)

- In `src-tauri/src/db/cache.rs::prune_expired_trend_board_cache`:
  - Retain `trend_board_cache` rows for **7 days (`7 * 86400 = 604800` seconds)** instead of deleting them at `3600` (1h) / `43200` (12h) on startup (update unit tests in `src-tauri/src/db/tests.rs` if any assert the cutoff timestamp). Freshness is already enforced on the frontend by `trendL2EffectiveTtlMs`, so keeping rows for 7 days costs only a few KB while providing reliable offline/fluctuating-network fallback.

## Acceptance Criteria

- [ ] When `enrichTrendRepos` returns a rich card with `platforms: ['windows']` and `icon: 'data:image/png;base64,...'`, `admitIconHit` stores the `data:` icon in `iconStore`, AND `snapshotTrendEnrichCache()` contains the rich card with `icon: ''` (no `data:` string in `trendEnrichCache` or `trend_board_cache`, and the rich card is NOT dropped).
- [ ] When `saveDbTrendCache` or `putTrendEnrichMemory` is called with a summary whose `icon` is `data:...`, the summary is persisted with `icon: ''` rather than skipped.
- [ ] When L2 `trend_board_cache` is expired and the network fetch fails (`fetchTrendsText` rejects), `fetchTrendsResult` falls back to the stale L2 cache (`status: 'ok', stale: true`) and renders the cached rich cards and icons.
- [ ] Update `src/services/trends/enrich.simplify.test.ts`, `src/services/trends/cache.test.ts`, and `src/services/trends/swr-view.test.tsx` to lock in the new behavior; all frontend and Rust tests pass.
