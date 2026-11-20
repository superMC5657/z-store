# Issue 05: `StarredFeed` Cold-Start L2 Hydration, Multi-User L1 Cache & SWR Sync Loop

Status: resolved
Blocked by: 02, 03, 04

## Summary

Upgrade `FavoritesView/StarredFeed` from a transient single-slot memory view into a full **M1 Paginated Cache + SQLite L2 Snapshot (`starred_feed_cache`) + ETag SWR Sync** pipeline on par with `TrendsView`:

1. **Cold-Start Instant L2 Hydration**: Restarting ZStore and opening「收藏 → Star 同步」renders the previously synced rich-card list in 0 network requests from SQLite `starred_feed_cache`, automatically backfilling local confirmed `data:` icons via `getConfirmedIconsBatch` and hydrating `repoEnrichCache` + `searchListCache(ns='starred')`.
2. **Multi-Target L1/L2 Cache Read**: Switching the username input (e.g. `torvalds` → `@me:alice` → `torvalds`) reads L1 `searchListCache(ns='starred')` (5m fresh / 30m SWR) and L2 `starred_feed_cache` instead of wiping and re-fetching blindly.
3. **Non-Destructive SWR Manual Sync**: Clicking「立即同步」on an already-displayed target keeps existing cards on screen while revalidating page 1 via `listGithubStarred(..., forceRefresh: true)` (which uses `If-None-Match` on the backend: `304` costs 0 quota, `200` updates cards and writes through to L1 + L2).
4. **Logout Privacy Cleanup**: Listening to `zstore:oauth-changed` / account logout clears M1 `'starred'` `@me:` entries and resets private `@me` view state immediately (complementing Rust `clear_oauth_session` L2 purge from Issue 02).

## Scope

- Allowed to create / modify:
  - `src/services/starred/starredCache.ts` (new)
  - `src/services/starred/starredCache.test.ts` (new)
  - `src/views/FavoritesView/StarredFeed.tsx`
  - `src/views/FavoritesView/StarredFeed.test.tsx`
  - `src/app/hooks/useAppSubscriptions.ts` (optional: call `clearSearchListCacheNamespace('starred', '@me:')` on `zstore:oauth-changed` when user logs out)
- Do not modify:
  - `src-tauri/*`
  - `src/views/TrendsView*`

## Implementation Details

### 1. Starred L2 Envelope & Target Memory (`src/services/starred/starredCache.ts`)

- **Target preference storage (`localStorage['zstore.starred.opts']`)**:
  - Persist `{ mode: 'self' } | { mode: 'user'; username: string }` safely (try/catch for privacy/quota mode, matching `TREND_BOARD_STORAGE_KEY` in `useTrendBoard.ts`). Never store private repo data in `localStorage` — only the last chosen query mode / public username.
- **L2 Snapshot Envelope (`StarredCacheEnvelope`)**:
  ```ts
  export interface StarredCacheEnvelope {
    v: 1;
    rows: AppSummary[];
    pages: number;
    hasMore: boolean;
    emptyPages?: number[];
    confirmedOther?: string[];
  }
  ```
  - Constants:
    - `STARRED_L2_TTL_MS = 12 * 60 * 60 * 1000` (12h fresh TTL, aligned with `TREND_DB_TTL_MS`).
    - `STARRED_L2_MAX_PERSISTED_PAGES = 3` / `STARRED_L2_MAX_PERSISTED_ROWS = 60` (keeps cold-start snapshot fast and well under 256KB; users can pull-to-load-more from `pages + 1` seamlessly!).
    - Reuse `TREND_DB_PAYLOAD_MAX_BYTES = 256 * 1024` and `utf8ByteLength`:
      - Strip `data:` icons (`icon: ''`) and strip runtime catalog annotations (`source`, `status`, `is_cataloged`) before `JSON.stringify` (exact same invariant as `saveDbTrendCache`).
      - If byte length exceeds `256KB`, truncate `description` / `description_en` / `homepage` to 500 chars, then slice to first page (`20` rows); if still over limit, skip saving cleanly.
  - `readDbStarredCache(cacheKey: string, opts?: { allowStale?: boolean }): Promise<{ envelope: StarredCacheEnvelope; cachedAt: number; isFresh: boolean } | undefined>`:
    - Calls `tauriApi.getStarredFeedCache(cacheKey)`.
    - Validates `v === 1` and `Array.isArray(envelope.rows)` (`rows.length > 0`).
    - Rejects negative clock skew (`elapsedMs < 0`); when `!opts?.allowStale` and `elapsedMs >= STARRED_L2_TTL_MS`, returns `{ envelope, cachedAt, isFresh: false }` (or `undefined` if `allowStale` is strictly false — design cleanly so `StarredFeed` can use `isFresh` for 0-network cold start and `allowStale` for SWR / offline fallback!).
  - `saveDbStarredCache(cacheKey: string, ownerScope: string, envelope: StarredCacheEnvelope): Promise<void>`:
    - Serialized per `cacheKey` (Promise chain, preventing concurrent race overwrites) calling `tauriApi.saveStarredFeedCache(cacheKey, ownerScope, payloadJson)`.

### 2. `StarredFeed.tsx` Lifecycle, L1/L2 Read & Write-Through

- **Cold-start hydration (`useEffect` on mount / `login` resolution)**:
  - If synchronous `restoreLastQuery(login)` already hydrated M1 rows, use them directly.
  - Otherwise resolve initial target from `loadPersistedStarredOpts()` + `login` (if logged in and no persisted public user, default target is `@me:${login.toLowerCase()}`; if persisted public user `u`, target is `u.toLowerCase()`).
  - If a valid target exists, read `readDbStarredCache(target.key, { allowStale: true })`:
    - If hit:
      - Hydrate `confirmedOther` (`recordSharedConfirmedOthers`) and concrete platforms (`recordSharedRepoPlatforms(envelope.rows)`).
      - Slice `envelope.rows` into 20-item pages and seed `writeSearchListCache({ namespace: 'starred', query: target.key, page: p, perPage: STARRED_PER_PAGE }, pageSlice)` so pagination & `lastQuery` stay aligned.
      - Assemble rows via `assembleOnlineRowsWithIcons([], envelope.rows)` and render immediately (`pages = envelope.pages`, `hasMore = envelope.hasMore`, `queryKey = target.key`).
      - For any hydrated rows with missing icons (`icon === ''`), call `tauriApi.getConfirmedIconsBatch(missingIds)` (DB-only, 0 network) and admit hits via `admitIconHit({ id, icon, via: 'm2' })` so local cached icons appear instantaneously!
      - Do **not** auto-fire network on cold-start L2 hit (honoring ADR-0019 manual sync expectation on Favorites); if L2 has no snapshot at all, remain on the clean `not_synced` EmptyState waiting for user click.
- **Multi-user L1/L2 lookup & SWR manual sync in `handleQuery`**:
  - Persist chosen target mode via `persistStarredOpts(...)`.
  - Distinguish **switching target** (`target.key !== queryKey`) vs **re-syncing active target** (`target.key === queryKey`):
    - **Switching target (`target.key !== queryKey`)**:
      1. Check L1 `readSearchListCacheEntry({ namespace: 'starred', query: target.key, page: 1, perPage: STARRED_PER_PAGE })`:
         - If `isFresh` (`< 5m`): restore cached pages from L1 immediately with **0 network**!
         - If stale (`5..30m`): render cached pages immediately (SWR), then revalidate page 1 in background (`forceRefresh: false`).
      2. If L1 misses, check `readDbStarredCache(target.key)`: if `isFresh` (`< 12h`), render L2 snapshot + DB icon backfill immediately! Otherwise SWR-render stale L2 (if any) and fetch page 1 (`forceRefresh: false`).
    - **Re-syncing active target (`target.key === queryKey`, user explicitly clicked「立即同步」)**:
      - Keep current `rows` visible (`loading = true` spins the button icon without blanking `rows` to empty skeleton/loading text!).
      - Call `fetchPage(target, 1, /* forceRefresh */ true)`. When page 1 returns, replace `rows` with assembled page 1, set `pages = 1`, `hasMore = res.has_more`, and write through to L1 + L2! If network fails and `rows` were already displayed, show `error` banner while preserving existing `rows`.
- **Debounced L2 Write-Through**:
  - Whenever `rows` (up to first 60 rows / 3 pages), `pages <= 3`, `hasMore`, or `resolvedOtherIds` settle/upgrade (via `fetchPage`, `useListPlatformBackfill`, `subscribeIconWrites`, or `subscribeSearchListCachePatches`), schedule an 800ms debounced `saveDbStarredCache(target.key, target.key, ...)` (plus flush on unmount) so newly deduced platforms and remote icon URLs are persisted into `starred_feed_cache`!
- **Logout / Account-Switch Hygiene**:
  - When `login` becomes `undefined` or changes to a different user, call `clearSearchListCacheNamespace('starred', '@me:')`, reset `lastQuery` if `!belongsToLogin`, and clear displayed rows if the active `target` was `@me:*`.

## Acceptance Criteria

- [x] Unit tests in `src/services/starred/starredCache.test.ts` verify envelope sanitization (`data:` icon stripped to `''`, `is_cataloged`/`source`/`status` stripped, `> 60` rows capped to 3 pages, `> 256KB` truncated safely) and 12h freshness calculation.
- [x] Component tests in `src/views/FavoritesView/StarredFeed.test.tsx` verify:
  - Cold mount with a mocked `get_starred_feed_cache` snapshot renders rich cards + backfilled DB icons immediately with **0** calls to `list_github_starred`.
  - Switching input `alice` → `bob` → `alice` within 5 minutes serves `alice` from L1 cache without re-calling `list_github_starred`.
  - Clicking「立即同步」on an already-loaded feed keeps existing cards visible during in-flight request, calls `list_github_starred` with `forceRefresh: true`, and updates L1 + `save_starred_feed_cache`.
  - Logging out (`oauthUser` changing from `{ login: 'alice' }` to `null`) clears `@me:alice` state and memory cache immediately.
- [x] `npx tsc --noEmit` and `npx vitest run src/services/starred/ src/views/FavoritesView/` pass with 0 errors.
