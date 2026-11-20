# Issue 09: Consolidate `App.tsx` Multi-List State & Large-Interface Hooks

Status: resolved
Blocked by: 05, 06, 08

## Summary

`src/App.tsx` currently owns four overlapping `AppSummary[]` state arrays (`apps`, `onlineApps`, `recentlyViewedApps`, `uncatalogedExtraApps`) plus `installedApps`, `updates`, and `updateRules`. Because each feature slice was extracted into a hook without consolidating the underlying state ownership, those hooks expose bloated, shallow **Large Interfaces**:

- `src/app/hooks/useAppSubscriptions.ts` (442 lines): requires **27 input parameters** (`setApps`, `setOnlineApps`, `setRecentlyViewedApps`, `setUncatalogedExtraApps`, `appsRef`, `onlineAppsRef`, `recentsRef`, `uncatalogedExtraAppsRef`, etc.).
- `src/app/hooks/useUpdateActions.ts` (198 lines): owns **0 state** of its own, accepts **10 parameters** (5 setters + `updates` + `searchQuery` + `showToast` + `t`), and simply wraps 11 repetitive `tauriApi.* → getUpdateRules → setUpdateRules → checkForUpdates → setUpdates → toast` calls.
- `src/app/hooks/usePlatformBackfill.ts` (193 lines): accepts **9 parameters** to patch those same 3 list arrays + refs in lockstep.
- `src/app/hooks/useDetailCacheSync.ts` (705 lines): accepts **11 parameters** to patch the same 4 list arrays + refs + `selectedApp` + `platformResolvedOtherIds`.

Every cross-cutting event (`zstore://icon-ready`, detail refresh, platform lite backfill, catalog sync) must manually synchronize 3–4 separate React state arrays across multiple hooks.

## Scope

- `src/App.tsx`
- `src/app/hooks/mountCtx.ts`
- `src/app/hooks/useCatalogLists.ts`
- `src/app/hooks/useUpdatesState.ts`
- `src/app/hooks/useWatchState.ts`
- `src/app/hooks/useAppSubscriptions.ts`
- `src/app/hooks/usePlatformBackfill.ts`
- `src/app/hooks/useDetailCacheSync.ts`
- `src/app/hooks/useDeepLink.ts`
- `src/app/hooks/useSearchState.ts`
- `src/app/hooks/useInstallState.ts`
- `src/app/favoritesUncataloged.ts`
- `src/app/selectors.ts`
- `src/App.*.test.tsx` & `src/app/hooks/*.test.tsx` & `src/app/*.test.ts`

## Implementation Details (Design Proposal for Triage)

### 1. Deepen list/entity state behind a single `useCatalogLists` / Store module
- Replace the 4 separate `useState` + `useRef` pairs in `App.tsx` with a single cohesive catalog-list store/reducer module that holds `{ catalogApps, onlineApps, recentApps, uncatalogedApps }` and exposes narrow, high-leverage operations:
  - `patchSummary(id, patcher)` / `patchIcons(targets, icon)` (single update path replacing duplicated 3x/4x `setApps` + `setOnlineApps` + `setRecentlyViewedApps` loops in `usePlatformBackfill`, `useDetailCacheSync`, and `useAppSubscriptions`)
  - `applyPlatforms(patchedMap)` / `confirmOthers(ids)`
- Dramatically shrink `usePlatformBackfill` and `useDetailCacheSync` parameter counts from ~10–11 down to 2–3.

### 2. Consolidate `useUpdateActions` with updates state ownership
- Move `updates`, `updateRules`, `isCheckingUpdates`, and `updateCheckProgress` state ownership *into* `useUpdatesState` (merging `useUpdateActions` + update state currently scattered in `App.tsx`), collapsing the repetitive rule-mutation boilerplate (`runRuleMutation(rpcCall, { refreshCatalog, toastKey })`) inside the module.

### 3. Shrink `useAppSubscriptions`
- Instead of accepting 27 raw setters/refs from `App.tsx`, subscribe against the unified catalog store + domain state hooks (or split genuine lifecycle listeners into their owning hooks: updates events into `useUpdatesState`, watch/oauth/catalog sync into `useAppSubscriptions`).

## Why `needs-triage`

This refactor changes internal state ownership across `App.tsx` and 4+ hook test suites (`src/App.*.test.tsx`, `src/app/hooks/*.test.tsx`), so maintainer alignment on store shape vs hook-colocation style is needed before AFK execution (could benefit from `/grill-me` or `/plan` if expanding scope).

## Acceptance Criteria

- [x] No hook under `src/app/hooks/` requires > 6 parameters or duplicates 3–4 list `setState` patching blocks.
- [x] `useUpdateActions` owns its `updates` / `updateRules` state or is merged into a cohesive `useUpdatesState` deep module.
- [x] All `src/App.*.test.tsx`, `src/app/hooks/*.test.tsx`, `pnpm test`, and `pnpm build` pass.
