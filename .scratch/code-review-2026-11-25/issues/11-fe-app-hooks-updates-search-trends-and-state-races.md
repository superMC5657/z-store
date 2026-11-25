# Issue 11: Frontend App Hooks, Updates, Search/Trends Filters & State Races

Status: resolved
Severity: High (F-26 [High], F-27 [High], F-28 [High], F-29 [High], F-30 [High], F-31 [Medium], F-33 [Medium], F-34 [Medium], F-38 [Medium])
Fix Track: Track 5A (`fix-fe-app-views`) + Track 5B (`fix-fe-components` for F-31 components part & F-38 `OAuthAccountCard` part)
Findings: F-26, F-27, F-28, F-29, F-30, F-31, F-33, F-34, F-38

## Findings

### F-26 [High]: "Load info" on uncataloged Favorite/Watched card discards fetched detail
- **Locations**: `src/app/favoritesUncataloged.ts:186, 189-234, 272-287`
- **Trigger**: Favorite/watch an uncataloged repo absent from local detail cache (`useEffect` inserts a placeholder row into `uncatalogedExtraApps`), then click "Load info". After `tauriApi.getAppDetails(raw)` resolves, lines 209-214 find the existing placeholder matching `normalizeId(e.id) === k` and early-return `prev` unchanged! Additionally `withLocalMarkOuter` (`:186`) closes over stale initial `apps = []` due to `[]` deps on `:234`.
- **Impact**: Clicking "Load info" performs a full GitHub API request and silently throws away the returned metadata, leaving the card stuck as an empty placeholder.

### F-27 [High]: My Apps Update & Update All bypass `InstallConfirmDialog` (`UNVERIFIED_ASSET_MARKER`) and global install lock
- **Locations**: `src/app/hooks/useUpdatesState.ts:169-179, 211-238`, `src/views/InstalledView.tsx:194-195, 302-320`
- **Trigger**: (A) Clicking "Update" or "Update All" for an app lacking a checksum manifest calls `tauriApi.installApp(id)` directly instead of going through `useInstallState`'s `UNVERIFIED_ASSET_MARKER` → `InstallConfirmDialog` prompt. (B) Navigating away from My Apps and returning resets `InstalledView`'s local `updatingId`/`isUpdatingAll` while `installingRef`/`installingAppIds` were never set.
- **Impact**: Unverified-asset updates always fail with raw `UNVERIFIED_ASSET:...` errors (no confirm flow); view switching re-enables update buttons and permits duplicate concurrent installs.

### F-28 [High]: `zstore://launchpad/{id}` deep link immediately cancels its own scroll & highlight-clear timers
- **Locations**: `src/views/LaunchpadView.tsx:114-128`
- **Trigger**: Once `feed` is ready, the `useEffect` sets `highlightId`, synchronously calls `onFocusConsumed?.()` (clearing `focusAppId` in `App.tsx`), and schedules 60ms scroll and 4000ms highlight-clear timers. Because `focusAppId` is in the effect dependency array, the immediate re-render runs cleanup and cancels both timers before 60ms.
- **Impact**: Deep-linked Launchpad card never scrolls into view and its highlight border stays stuck permanently.

### F-29 [High]: Search view traps user when platform filter is `[]` or filters out all results
- **Locations**: `src/App.tsx:498-533`
- **Trigger**: With a non-empty `searchQuery`, uncheck all platforms (`selectedPlatforms = []`) or pick a platform with 0 matches among search hits. `App.tsx:498` renders `EmptyState` ("No local results" / "No online results") instead of `FilterEmptyState` with platform reset. Clicking "Search online" with `selectedPlatforms = []` fetches results that are immediately filtered back to `[]`.
- **Impact**: Violates `CONTEXT.md` Bi-dimensional Filter invariant; traps user in a dead-end empty state with no platform reset action.

### F-30 [High]: Online search downgrades `is_cataloged: true` → `false`; `TrendsView` hides valid uncataloged items when `apps.length === 0`
- **Locations**: `src/views/SearchResultsView.tsx:86-90`, `src/views/TrendsView.tsx:169, 219-228`
- **Trigger**: (A) `SearchResultsView.tsx:88` re-runs `annotateOnlineCataloged(activeOnlineApps, apps, localApps)` against local search hits (`apps`) instead of full catalog, overwriting `is_cataloged: true` back to `false` for cataloged apps absent from local search hits. (B) `TrendsView.tsx:219` checks `apps.length === 0 || displayItems.length === 0`, hiding valid uncataloged trend items while line 169 renders `<CountBadge value={displayItems.length} />` > 0.
- **Impact**: Already-cataloged apps show "Move to catalog" and permit duplicate drafts; TrendsView header badge contradicts its empty state.

### F-31 [Medium]: Case-sensitive `.has(app.id)` breaks favorite/watch/installing indicators & duplicate-install guard on mixed-case IDs
- **Locations**: `src/App.tsx:707-710`, `src/app/hooks/useInstallState.ts:65-95, 121`, `src/views/TrendsView.tsx:244`, sibling views (`FeaturedView`, `LatestView`, `CategoriesView`, `SearchResultsView`, `LaunchpadView`), and `src/components/**` (Track 5B)
- **Trigger**: `get_developer_profile` (`RustDesk/RustDesk`) and client-parsed Trends repos (`Tencent/LoopForge`) return mixed-case `app.id`, whereas `favoriteIds`/`watchedIds` store lowercase `normalizeId(id)` and `installingAppIds`/`installingRef` store raw `id`.
- **Impact**: Broken favorite/watch/installing UI states and bypassed duplicate-install lock on mixed-case IDs.

### F-33 [Medium]: `handleOpenDetail` lacks request sequence guard; out-of-order fetch overwrites fresher detail/error
- **Locations**: `src/app/hooks/useDetailCacheSync.ts:465-469, 561-572`
- **Trigger**: Open App A (slow fetch #1), then click Refresh (`forceRefresh=true`, fetch #2). Both check only `activeDetailIdRef.current === id`; when fetch #1 settles after fetch #2, it overwrites `appDetailMemoryCache`, `selectedApp`, and list items (or replaces fresh detail with `loadError`).
- **Impact**: Stale detail or spurious error overwrites freshly refreshed app details.

### F-34 [Medium]: Cold-startup race stamps `recentlyViewedApps` as `is_cataloged: false`; deleted drafts stay permanently hidden from "Move to catalog"
- **Locations**: `src/app/hooks/useAppSubscriptions.ts:111, 128-134, 185-192`, `src/app/hooks/useCustomApps.ts:55, 60-91, 110-113`
- **Trigger**: (A) `getRecentlyViewedApps()` resolving before `searchApps('')` populates `fullCatalogAppsRef` stamps recents against empty catalog and stale `localApps` closure without restamping after catalog load. (B) Moving an uncataloged app to draft adds its aliases to `movedInIds`, and deleting that draft in `PendingView` never prunes `movedInIds`.
- **Impact**: Cataloged recents appear uncataloged until manual sync; deleted drafts cannot be re-added for the rest of the session.

### F-38 [Medium]: Uncaught rule/unmanage IPC rejections, blank `FeaturedView` on load failure, and post-unmount `OAuthAccountCard` `openUrl`/timer
- **Locations**: `src/app/hooks/useUpdatesState.ts:149-209`, `src/app/hooks/useInstallState.ts:210-218`, `src/views/FeaturedView.tsx:78, 294` (Track 5A); `src/components/OAuthAccountCard.tsx:117-146` (Track 5B)
- **Trigger**: (A) Rule/unmanage IPC failures throw unhandled rejections with no error toast. (B) `FeaturedView` ignores `featured.failed`, rendering a blank screen when load fails with no recents. (C) Unmounting `OAuthAccountCard` before `await oauthDeviceStart()` settles still invokes `openUrl` and starts a dangling polling timer.
- **Impact**: Silent failures + unhandled promise rejections, blank home screen on load failure, and unexpected browser popup / leaked timer after leaving Settings.

## Acceptance Criteria

- [ ] `favoritesUncataloged.ts` replaces matching entries (`prev.map(...)`) instead of early-returning `prev`, and reads `apps` via ref (F-26).
- [ ] Single & batch updates route through `useInstallState`'s `UNVERIFIED_ASSET_MARKER` confirmation flow and `installingRef` lock; batch-updating state is lifted out of `InstalledView` (F-27).
- [ ] `LaunchpadView` splits scroll (60ms) and highlight-clear (4000ms) timers into a separate `useEffect` keyed on `highlightId` (F-28).
- [ ] Search view renders `FilterEmptyState` with platform reset when `selectedPlatforms.size === 0` or raw search results were non-empty before platform filtering (F-29).
- [ ] `SearchResultsView` annotates online results against full catalog IDs without downgrading `is_cataloged: true` → `false`; `TrendsView` gates empty state on `displayItems.length === 0` only (F-30).
- [ ] All reads/writes on `favoriteIds`, `watchedIds`, `installingIds`, `installingRef`, `uninstallingAppIds` normalize IDs via `normalizeId(id)` across hooks, views, and components (F-31).
- [ ] `handleOpenDetail` uses a monotonic `detailReqSeqRef` guard before applying detail/error updates (F-33).
- [ ] `recentlyViewedApps` restamps via `localAppsRef.current` after initial catalog load; `movedInIds` is pruned/cleared once `reloadCustomApps` completes (F-34).
- [ ] Rule/unmanage mutations catch errors and show error toast; `FeaturedView` renders error `EmptyState` + Retry when `featured.failed`; `OAuthAccountCard` checks `pollCancelledRef.current` after `await oauthDeviceStart()` (F-38).
- [ ] Regression tests cover every finding; `pnpm exec tsc --noEmit` and `pnpm exec vitest run` pass.

## Comments

- **Resolved in `0dd2671`** (Track 5A `fix-fe-app-views`), **`8004696`** (Track 5B `fix-fe-components`), and **`555a09e`** (`integrator`: `fix(integration): propagate rule mutation status and purge private RAM caches on OAuth revoke`).
- Fixed uncataloged "Load info" replacement + ref read (F-26), My Apps single/batch update confirmation & global lock + lifted batch state (F-27), Launchpad deep-link timer split (F-28), Search platform filter empty state (F-29), online search `is_cataloged` preservation & `TrendsView` empty-state gating (F-30), normalized ID set lookups across views & components (F-31), `handleOpenDetail` monotonic sequence guard (F-33), recents cold-startup restamp & `movedInIds` pruning (F-34), and rule/unmanage error toasts with `Promise<boolean>` status propagation from `useUpdatesState` to `RulesManagerModal` (`555a09e`), `FeaturedView` error state, and `OAuthAccountCard` post-unmount guard (F-38) with unit/regression tests.
- **Integrated verification on `main`** (`verifier` `verdict=PASS`): `tsc` 0 errors, `vitest` 142/142 files (1497/1497 tests).
