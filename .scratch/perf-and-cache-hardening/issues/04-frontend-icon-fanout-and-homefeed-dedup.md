# Issue 04: Frontend Icon Fan-Out Dedup, Lazy HomeFeed Ranking & Navigation Cleanup

Status: resolved
Blocked by: none

## Summary

Clean up three frontend redundancies in React state updates and memoized computations:
1. **Duplicate icon-ready state updates**: `useAppSubscriptions.ts` passes an inline `patch` callback to `admitIconHit` (updating `apps`, `onlineApps`, `recentlyViewedApps`, `uncatalogedExtraApps`), while `App.tsx` also subscribes to `subscribeIconWrites` (which `admitIconHit` invokes via `notifyIconWrites`) and runs `patchAppIconList` on the exact same four state lists a second time.
2. **Redundant full-catalog ranking in `useHomeFeed.ts`**: When the Tauri backend feed (`get_home_feed`) is active (`!isSearching && backendActive && backendNonHero.length > 0`), `useHomeFeed` still runs `buildFrontendAffinityScorer` and `rankFeed` over all `apps` on the main thread even though `localFeaturedApps` and `visibleLocal` are not displayed.
3. **Dead code & navigation bypass in `App.tsx`**: `handleEnterUpdatesTab` (L541-548) is unused, and `LatestView` uses `onNavigateCategories={() => setCurrentView('categories')}` (L708) instead of `navigate('categories')`.

## Scope

- `src/app/hooks/useAppSubscriptions.ts`
- `src/views/HomeView/useHomeFeed.ts`
- `src/App.tsx`

## Implementation Details

### 1. Single icon write fan-out via `subscribeIconWrites` (`src/app/hooks/useAppSubscriptions.ts`)

- Remove the `patch` property passed to `admitIconHit` in `useAppSubscriptions.ts`, and consolidate the single `subscribeIconWrites` fan-out inside `useAppSubscriptions.ts` (removing the duplicate subscription in `App.tsx`).
- Verify all `useAppSubscriptions.test.tsx` and `HomeView` icon tests continue to pass.

### 2. Skip frontend `rankFeed` when backend feed is active (`src/views/HomeView/useHomeFeed.ts`)

- Move `presentAppIdSet`, `appById`, `heroIdLower`, `backendNonHero`, and `isBackendListActive` above `affinityScorer` and `rankedRest`.
- Short-circuit `affinityScorer` and `rankedRest` when `isSearching || isBackendListActive` so the frontend does not recompute affinity weights and sort the entire catalog when backend pagination is already serving the feed.

### 3. Clean up `App.tsx`

- Remove unused `handleEnterUpdatesTab` in `src/App.tsx`.
- Replace `onNavigateCategories={() => setCurrentView('categories')}` with `onNavigateCategories={() => navigate('categories')}` on `<LatestView />`.

## Acceptance Criteria

- [x] `onIconReady` triggers a single pass of `patchAppIconList` across the four app lists.
- [x] `useHomeFeed` skips frontend `buildFrontendAffinityScorer` / `rankFeed` when `isBackendListActive` is `true`.
- [x] `handleEnterUpdatesTab` is removed and `LatestView` uses `navigate('categories')`.
- [x] All frontend tests (`pnpm test`) pass.
