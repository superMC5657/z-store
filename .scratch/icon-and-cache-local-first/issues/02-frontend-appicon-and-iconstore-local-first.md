# Issue 02: Frontend `AppIcon` & `iconStore` Local-Cache-First Rendering, Reactive Fan-Out & Backoff Deadlock Fix

Status: done
Blocked by: 01

## Summary

Fix the frontend icon rendering and preloading pipeline so that cached icons on local disk are always displayed even when the network fluctuates:

1. **`startIconFetch` (`get_or_fetch_icon`) completion never notifies `AppIcon`**:
   - In `src/services/iconStore.ts` (`startIconFetch`, lines 637–653), when `getOrFetchIcon` finishes loading the `data:` URI from Rust's local `icons/` disk cache into `iconDataCache`, it does not notify any subscriber. Mounted `<AppIcon>` components remain stuck on the remote `https://...` URL (or in error state).
2. **`AppIcon` `hasError` permanently locks into initials badge on transient network failure**:
   - In `src/components/AppIcon.tsx` (lines 124–138), `<AppIcon>` initially renders `<img src="https://...">` when `iconDataCache` has not yet populated. If the browser's direct HTTP request fails during network fluctuation, `onError` sets `hasError = true`. Because `useEffect(() => { setHasError(false); }, [activeIcon])` only watches `activeIcon` (not `displaySrc`), `hasError` never resets when `displaySrc` upgrades from `https://...` to `data:image/...` in `iconDataCache`.
3. **Cards beyond index 30 and asset views (`FavoritesView` / `InstalledView` / `UpdatesView` / `Header`) never load local disk icons**:
   - `AppIcon` is passive and never requests `iconStore` to load its local disk cache if the parent view didn't include it in the first 30 rows of `queueAssembledRowIcons`.
   - `FavoritesView.tsx`, `InstalledView.tsx`, `UpdatesView.tsx`, and `AppDetailModal/Header.tsx` guard `queueAssembledRowIcons` / `restoreOrFetchIconCycle` behind `if (MANUAL_ONLY_NETWORK) return;` (`MANUAL_ONLY_NETWORK === true`), completely disabling local disk icon cache loading in those views.
4. **Backoff zombie slot-starvation in `queueAssembledRowIcons`**:
   - In `src/services/iconStore.ts` (lines 500–548), `isIconPersistedOrQueued` returns `false` for URLs in `iconPreloadBackoffUntil`. When 30 URLs fail during a network blip, they fill all 30 slots of `batch` in `queueAssembledRowIcons` and are then immediately skipped in `queueIconFetches` (line 461), starving all subsequent cards in the list from reading their local disk cache for 30 seconds.

## Scope

- `src/services/iconStore.ts`
- `src/components/AppIcon.tsx`
- `src/views/FavoritesView.tsx`
- `src/views/InstalledView.tsx`
- `src/views/UpdatesView.tsx`
- `src/components/AppDetailModal/Header.tsx`
- `src/components/AppIcon.simplify.test.tsx`
- `src/services/iconStore.deepen.test.ts`
- `src/services/iconStore.bounds.test.ts`

## Implementation Details

### 1. Reactive `iconDataCache` notification & `admitMemoryOnlyHit` dual-write (`src/services/iconStore.ts`)

- In `admitMemoryOnlyHit` (`src/services/iconStore.ts:881`):
  - When `icon.startsWith('data:')`, in addition to `rememberBufferedIcon(t, icon)`, also call `rememberIconData(t, icon)` so `getCachedIconDataUri(t)` hits immediately.
- In `startIconFetch` (`src/services/iconStore.ts:625`):
  - When `getOrFetchIcon(firstId ?? undefined, url)` resolves with a non-empty `dataUri`:
    - After calling `rememberIconData(url, dataUri)` and `rememberIconData(id, dataUri)` / `rememberIconData(nid, dataUri)` for all aliases, notify subscribers so mounted `AppIcon` components re-render:
      - Add a lightweight data-cache subscriber set `iconDataSubscribers` (`export function subscribeIconDataReady(fn: (keys: string[]) => void): () => void`) or emit via `notifyIconWrites` / `notifyIconDataReady` with `[url, normalizeIconKey(url), ...aliases]`.
      - Using a dedicated `subscribeIconDataReady` (also cleared in `__resetIconStoreForTests` / `__resetIconWriteSubscribersForTests`) avoids perturbing `subscribeIconWrites` assertions in existing unit tests that count exact `admitIconHit` write events!
- Export a helper `requestIconLocalCache(appId: string | undefined, iconUrl: string): void` and `retryIconFromLocalOrBackend(appId: string | undefined, iconUrl: string): void`:
  - `requestIconLocalCache` calls `queueIconFetches([appId ? { id: appId, icon: iconUrl } : iconUrl])` if `isRemoteHttpIconUrl(iconUrl)` and `!getCachedIconDataUri(iconUrl)`.
  - `retryIconFromLocalOrBackend` clears `iconPreloadBackoffUntil.delete(iconUrl)` and calls `queueIconFetches([appId ? { id: appId, icon: iconUrl } : iconUrl])`.

### 2. Fix backoff slot starvation in `isIconPersistedOrQueued` (`src/services/iconStore.ts`)

- Update `isIconPersistedOrQueued(url: unknown): boolean`:
  - Check `iconPreloadBackoffUntil.get(url)` (and normalized `nid`): if `typeof backoffUntil === 'number' && backoffUntil > Date.now()`, return `true` (treat active backoff as covered during batch selection so backed-off URLs do not consume the 30-slot quota in `queueAssembledRowIcons` and starve items 31+!). Once `Date.now() >= backoffUntil`, delete the expired backoff entry and return `false` so it can be retried.

### 3. Make `AppIcon` resilient to network fluctuation & reactive to `iconDataCache` (`src/components/AppIcon.tsx`)

- Subscribe to `subscribeIconDataReady` in `AppIcon`:
  ```tsx
  const [, setDataTick] = useState(0);
  useEffect(() => {
    return subscribeIconDataReady((keys) => {
      const activeNorm = normalizeIconKey(activeIcon);
      if (
        (appIdNorm && keys.includes(appIdNorm)) ||
        (activeNorm && keys.includes(activeNorm)) ||
        (activeIcon && keys.includes(activeIcon))
      ) {
        setDataTick((c) => c + 1);
      }
    });
  }, [appIdNorm, activeIcon]);
  ```
- On mount / when `activeIcon` is a remote HTTP URL not yet in `iconDataCache` (`!displaySrc.startsWith('data:')` and `iconOverride === undefined`):
  - Call `requestIconLocalCache(appIdNorm, activeIcon)` inside a `useEffect` so every rendered `<AppIcon>` (even beyond the first 30 cards) automatically loads from local disk cache in Tauri (in jsdom unit tests where `isTauriAvailable()` is false, `drainIconPreloadQueue` is a no-op with 0 IPC calls).
- Reset `hasError` whenever **either `activeIcon` or `displaySrc`** changes:
  ```tsx
  useEffect(() => {
    setHasError(false);
  }, [activeIcon, displaySrc]);
  ```
- In `handleError`:
  - Set `setHasError(true)`;
  - If `!displaySrc.startsWith('data:')` and `isRemoteIcon(activeIcon)` and not yet retried for this `activeIcon` (`retriedRef.current !== activeIcon`), set `retriedRef.current = activeIcon` and call `retryIconFromLocalOrBackend(appIdNorm, activeIcon)`. When `get_or_fetch_icon` resolves `data:` from disk or backend fallback, `displaySrc` changes to `data:...`, `hasError` resets to `false`, and the icon recovers automatically!

### 4. Unblock local icon cache loading in `FavoritesView`, `InstalledView`, `UpdatesView`, and `Header`

- In `src/views/FavoritesView.tsx` (lines 72–83), `src/views/InstalledView.tsx` (lines 74–84), and `src/views/UpdatesView.tsx` (lines 91–111):
  - Remove `if (MANUAL_ONLY_NETWORK) return;` before `queueAssembledRowIcons(...)` so local cached icons are loaded into `iconDataCache`.
- In `src/components/AppDetailModal/Header.tsx` (lines 83–89):
  - Remove the `if (MANUAL_ONLY_NETWORK) { setIsIconCycleReady(true); return ... }` early return so opening `AppDetailModal` restores the app's icon cycle from local DB/disk (`restoreOrFetchIconCycle(app.id)`). (Note: check `Header.l5cycle.test.tsx` to ensure all existing Header tests pass.)

## Acceptance Criteria

- [x] When `<AppIcon icon="https://..." appId="o/r" />` experiences an `<img onError>` due to network fluctuation, and `iconStore` subsequently populates `iconDataCache` for `"https://..."` or `"o/r"`, `<AppIcon>` automatically resets `hasError`, re-renders, and displays `<img src="data:image/..." />`.
- [x] When `startIconFetch` resolves `getOrFetchIcon`, mounted `<AppIcon>` components waiting on that URL or `appId` re-render with the `data:` URI without requiring a parent component re-render.
- [x] In `queueAssembledRowIcons`, URLs currently within their 30s backoff window do not consume slots in the 30-item batch, allowing items at index 30+ to be queued.
- [x] `FavoritesView`, `InstalledView`, `UpdatesView`, and `AppDetailModal/Header` load local cached icons normally.
- [x] All tests in `AppIcon.simplify.test.tsx`, `iconStore.deepen.test.ts`, `iconStore.bounds.test.ts`, and `Header.l5cycle.test.tsx` pass under `npx vitest run`.
