# Issue 04: Single `icon-ready` Subscription, 3-Way Generation Gate, Per-Namespace Search Cache & Unified API Client Pool

Status: resolved
Blocked by: none

## Summary

Clean up four cross-cutting frontend/backend redundancies across the icon event bus, list cache capacity bounds, and Rust HTTP client pooling:

1. **Duplicate `zstore://icon-ready` listener & gate bypass (`useAppSubscriptions.ts:249` vs `trends/board.ts:1372`)**:
   - Root `useAppSubscriptions` listens to `tauriApi.onIconReady` and calls `admitIconHit` without `board` or `boardGen` expectations. Meanwhile, `TrendBoardSession` registers a second `tauriApi.onIconReady` listener (`attachStreamIconListener`) that calls `admitIconHit` again for `kind === 'trend'`.
   - Every trend icon hit executes `admitIconHit`, `notifyIconWrites`, `putTrendEnrichMemory`, and `scheduleSessionPersist` twice; worse, an IPC event in flight during a board switch is accepted by the ungated root listener and pushed into `TrendBoardSession` via `subscribeIconWrites`, bypassing `attachStreamIconListener`'s `board: currentActiveBoard` gate.
   - Similarly, `context.kind === 'starred'` carries `gen`, but `iconStore` has no expected `starredGen` gate on the frontend.
2. **`searchListCache` shared 50-entry FIFO pool eviction (`src/services/search/searchListCache.ts:13, 117`)**:
   - `search` (Search view) and `starred` (`StarredFeed`) share a single 50-entry `Map`. Paginating through a prolific GitHub user's Starred list evicts recent online search pages (and vice versa).
   - _Refines ADR-0015 §4 (which predated the `starred` namespace) to bound FIFO capacity per namespace._
3. **Duplicate Rust API `reqwest::Client` singletons (`src-tauri/src/lib.rs:129` vs `src-tauri/src/forge/http.rs:69`)**:
   - `lib::SHARED_HTTP_CLIENT` (`shared_http_client()`) and `forge::http::SHARED_API` (`new_api_client()`) create two separate `OnceLock<reqwest::Client>` connection pools with identical timeout/keepalive/proxy settings for `api.github.com`.

## Scope

- `src/services/iconStore.ts`
- `src/services/iconStore.deepen.test.ts` (and related `iconStore.*.test.ts`)
- `src/app/hooks/useAppSubscriptions.ts`
- `src/services/trends/board.ts`
- `src/views/FavoritesView/StarredFeed.tsx`
- `src/services/search/searchListCache.ts`
- `src/services/search/searchListCache.patch.test.ts`
- `src-tauri/src/lib.rs`
- `src-tauri/src/forge/http.rs`

## Implementation Details

### 1. Consolidate `onIconReady` to a single root listener & close 3-way generation gates (`iconStore.ts`, `useAppSubscriptions.ts`, `trends/board.ts`, `StarredFeed.tsx`)

- In `src/services/iconStore.ts`:
  - Maintain lightweight module-level active gate state (reset in `__resetIconStoreForTests()`):
    - `activeTrendGate: { board: string; gen?: number } | null` with `export function setActiveTrendIconGate(gate: { board: string; gen?: number } | null): void`.
    - `activeStarredGate: { gen?: number } | null` with `export function setActiveStarredIconGate(gate: { gen?: number } | null): void` (or adopt latest `gen` per new query reset, rejecting lower `gen` values once a newer `gen` has been observed/reset).
  - In `resolveExpectedGate` / `findStaleGateReason`:
    - Scope gate checks by `ctx?.kind` (normalized lowercase):
      - `'search'` (or empty legacy): check `search_id` against `expected.search_id` (existing behavior 100% preserved).
      - `'trend'`: check `incoming.board` against `args.board ?? activeTrendGate?.board` and `incoming.gen` against `expected.gen ?? activeTrendGate?.gen` (if `incoming.gen` is smaller than the highest seen trend gen after a board reset, reject as `'stale-board-gen'`).
      - `'starred'`: if `activeStarredGate?.gen !== undefined && incoming.gen !== undefined && incoming.gen < activeStarredGate.gen` (or `!==` when echoed/tracked), reject as `'stale-starred-gen'`; when `StarredFeed` starts a new page-1 query (`handleQuery` / account switch), bump/record the minimum acceptable `starred` `gen` (e.g., via `advanceStarredIconGateOnNewQuery()` which records the highest seen `starred` `gen` so any lagging IPC packet from a previous `STARRED_GEN` with `gen <= watermark` is rejected!).
- In `src/services/trends/board.ts`:
  - Call `setActiveTrendIconGate({ board: currentActiveBoard })` on `start()` / `syncBoard()` / `resetLoadingBoard()`, and `setActiveTrendIconGate(null)` on `dispose()`.
  - Remove `attachStreamIconListener` (the duplicate `tauriApi.onIconReady` subscription) and handle stream icon updates + `putTrendEnrichMemory` + `scheduleSessionPersist` cleanly inside `TrendBoardSession`'s existing `subscribeIconWrites` callback!
  - Ensure all existing `TrendsView` & `services/trends/*.test.ts(x)` tests that mock `tauriApi.onIconReady` or call `admitIconHit` continue to pass (check `src/services/trends/` tests—if standalone `TrendBoardSession` tests emit via `tauriApi.onIconReady` without mounting `useAppSubscriptions`, double-check before removing or keep a deduplicated shared listener helper in `iconStore.ts`!).
  - **Important check**: Verify `rg -n "onIconReady" src/`! If `TrendsView` standalone tests (`swr-view.test.tsx`, `TrendsView.test.tsx`, `phase2.test.ts`) mount `TrendsView` **without** `App.tsx`/`useAppSubscriptions` and trigger mock `onIconReady`, then instead of deleting `onIconReady` from `TrendsView` blindly, move the **singleton `tauriApi.onIconReady` subscription** into `iconStore.ts` (`ensureIconReadySubscription` reference-counted across `useAppSubscriptions` and `TrendBoardSession`)! That way:
    - Standalone `TrendsView` tests still subscribe to `tauriApi.onIconReady` automatically!
    - Full `App` runtime with both `useAppSubscriptions` and `TrendsView` mounted registers **only ONE** `tauriApi.onIconReady` IPC listener and calls `admitIconHit` **exact ONCE** per event!

### 2. Per-namespace 50-entry FIFO bound in `searchListCache` (`src/services/search/searchListCache.ts`)

- Keep `SEARCH_LIST_MAX_ENTRIES = 50` as the per-namespace cap.
- When inserting into `searchListCache` under namespace `ns` (`${ns}|...`), count entries matching `${ns}|` and evict only the oldest entry **within the same namespace `ns`** when that namespace exceeds `SEARCH_LIST_MAX_ENTRIES`.
- Writing 50 `'starred'` pages must leave existing `'search'` pages completely untouched, and vice versa.

### 3. Unify Rust API `reqwest::Client` pool (`src-tauri/src/lib.rs` & `src-tauri/src/forge/http.rs`)

- Have `crate::shared_http_client()` (`src-tauri/src/lib.rs`) delegate to `crate::forge::http::new_api_client(config::get_project_config().network.api_timeout_seconds)` (setting `.user_agent(USER_AGENT_VALUE)` on `SHARED_API` in `forge/http.rs` as default UA, which per-request `HeaderMap` can still override if needed).
- Keep `SHARED_ICON` (`new_icon_client`, redirect limit 10, browser UA, zero token) and `CatalogService.client` physically isolated per D5 & ADR-0012.

## Acceptance Criteria

- [x] With both `useAppSubscriptions` and `TrendsView` (`TrendBoardSession`) active simultaneously, a single `zstore://icon-ready` (`kind: 'trend'`) event invokes `admitIconHit` **once** (not twice), and stale-board or stale-starred events are rejected before fanning out to `subscribeIconWrites`.
- [x] Standalone `TrendsView` tests that fire `onIconReady` without mounting `App` continue to pass without modification.
- [x] Inserting 50+ entries under `namespace: 'starred'` in `searchListCache` does not evict any entries under `namespace: 'search'` (and vice versa), while each namespace enforces its own 50-entry FIFO bound. （已由 `SEARCH_LIST_MAX_ENTRIES_PER_NAMESPACE` 分桶实现）
- [x] `crate::shared_http_client()` and `crate::forge::http::new_api_client(...)` share a single underlying connection pool while keeping `new_icon_client` isolated. （已在 `lib.rs` 委托 `forge::http::api_client`）
- [x] All Vitest and Cargo tests pass.
