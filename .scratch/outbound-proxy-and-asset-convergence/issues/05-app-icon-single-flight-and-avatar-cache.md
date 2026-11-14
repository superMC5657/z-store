# Issue 05: Eliminate `<AppIcon>` Frontend/Backend Dual-Fetch in Tauri & Cache GitHub Avatars

Status: resolved
Blocked by: 04

## Summary

Converge the remaining two frontend-originated image channels onto backend proxy-aware disk caching:

1. **`<AppIcon>` dual-fetch race in Tauri (`src/components/AppIcon.tsx` & `src/services/iconStore.ts`)**:
   - Currently, whenever `activeIcon` is a remote `http(s)` URL not yet in `iconDataCache`, `<AppIcon>` renders `<img src="https://...">` directly in the WebView **at the exact same time** `requestIconLocalCache` invokes backend `get_or_fetch_icon`. Every uncached icon is requested twice (once by WebView, once by Rust `reqwest`), and without a proxy both stall and flash broken states.
2. **Uncached GitHub avatars (`avatars.githubusercontent.com`) in `Sidebar`, `OAuthAccountCard`, and `DeveloperProfileModal`**:
   - All three render raw `<img src={avatar_url}>` from the WebView with no local disk cache and no fallback when `avatars.githubusercontent.com` is DNS-poisoned or offline.

## Scope

- Allowed to modify / create:
  - `src/services/iconStore.ts`
  - `src/components/AppIcon.tsx`
  - `src/components/CachedAvatar.tsx` (new reusable avatar component)
  - `src/components/CachedAvatar.test.tsx` (new unit tests)
  - `src/components/Sidebar.tsx`
  - `src/components/OAuthAccountCard.tsx`
  - `src/components/DeveloperProfileModal.tsx`
  - `src/components/AppIcon.simplify.test.tsx` / `src/services/iconStore.*.test.ts` (add Tauri single-flight assertions while keeping all existing tests green)
- Do not modify:
  - `src-tauri/*` (backend commands `get_or_fetch_icon` and `fetch_or_cache_asset_url` already support icons and extensionless `avatars.githubusercontent.com/u/<id>?v=4` URLs)

## Implementation Details

### 1. Single-flight backend-first `<AppIcon>` in real Tauri runtime (`iconStore.ts` & `AppIcon.tsx`)

- **Runtime boundary (`isRealTauriIconRuntime`)**:
  - True **only** when `typeof window !== 'undefined'`, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, and `!(window as Record<string, unknown>).__ZSTORE_DEMO_MOCK__`.
  - In Vitest (`jsdom` without `__TAURI_INTERNALS__`) and the live web Demo (`__ZSTORE_DEMO_MOCK__ === true`), `<AppIcon>` and `resolveDisplaySrc` must preserve 100% of their current synchronous `<img src={remoteUrl}>` behavior!
- **Backoff query & failure wakeup (`src/services/iconStore.ts`)**:
  - Export `isIconInPreloadBackoff(url: string): boolean` (checks `iconPreloadBackoffUntil` by `url` and `normalizeIconKey(url)` against `Date.now()`).
  - In `startIconFetch(url, ids)` `.catch(...)`: after setting `iconPreloadBackoffUntil`, call `notifyIconDataReady(...)` with `url`, `normUrl`, and `aliases` so any mounted `<AppIcon>` awaiting backend resolution wakes up immediately on backend failure instead of waiting forever.
- **Defer raw remote `<img>` while backend fetch is pending/in-flight (`src/components/AppIcon.tsx`)**:
  - When `isRealTauriIconRuntime()` is `true` **and** `iconOverride === undefined` **and** `isRemoteHttpIconUrl(activeIcon)` **and** `!displaySrc.startsWith('data:')`:
    - If `!isIconInPreloadBackoff(activeIcon)`: treat the icon as awaiting local/backend `data:` resolution (`requestIconLocalCache` runs in `useEffect`), render the clean container / initials tile instead of mounting `<img src="https://...">` in the WebView (**0 WebView remote requests**; local disk hits resolve in ~1ms and immediately paint `<img src="data:...">`).
    - If `isIconInPreloadBackoff(activeIcon)` is `true` (backend `get_or_fetch_icon` failed): allow fallback to `<img src={activeIcon}>` (and if WebView `onError` also fires, settle cleanly onto `isFallbackBadge` initials without re-looping).

### 2. `<CachedAvatar>` component for GitHub user & developer avatars (`src/components/CachedAvatar.tsx`)

- Create `CachedAvatar` accepting `{ src?: string | null; login: string; size: number; style?: React.CSSProperties; className?: string; dimmed?: boolean }`:
  - Uses `getSyncCachedAssetUri(src)` / `resolveCachedAssetUri(src)` from `src/services/assetCache.ts` (Issue 04), which routes through `tauriApi.fetchOrCacheAssetUrl` in real Tauri runtime (30-day sharded disk cache + dynamic system proxy) and passes through directly in non-Tauri / Demo mode.
  - Note: Respect `noDirectInvoke.test.ts` — `CachedAvatar` lives in `src/components/`, so import from `../services/assetCache` (never `api/client`).
  - While awaiting cache resolution in real Tauri runtime or when `src` is empty / fails `onError`, render a crisp monochrome circular fallback badge displaying the uppercase first character of `login` (matching D4 Linear monochrome tokens: `var(--bg-card-hover)`, `var(--border-subtle)`, `var(--text-secondary)`), preventing broken image icons in the sidebar or modals.
- Replace raw `<img src={...avatar_url}>` in:
  1. `src/components/Sidebar.tsx` (account capsule avatar, `18px`, preserving `oauthUser.is_expired` dimming & warning dot);
  2. `src/components/OAuthAccountCard.tsx` (settings account row avatar, `28px`, preserving `user.is_expired` dimming & warning dot);
  3. `src/components/DeveloperProfileModal.tsx` (developer profile header avatar, `76px`).

## Acceptance Criteria

- [ ] In simulated real Tauri runtime (`__TAURI_INTERNALS__.invoke` mocked, `__ZSTORE_DEMO_MOCK__` unset), mounting `<AppIcon icon="https://raw.githubusercontent.com/o/r/main/icon.png" name="Demo" appId="o/r" />` invokes `get_or_fetch_icon` **once** and does **not** mount `<img src="https://raw.githubusercontent.com/...">` while the backend call is in flight; once `get_or_fetch_icon` resolves `data:image/png;base64,...`, `<img src="data:image/png;base64,...">` is rendered.
- [ ] In simulated real Tauri runtime, if `get_or_fetch_icon` rejects, `<AppIcon>` wakes up via `notifyIconDataReady`, falls back gracefully, and settles on the initials badge on `img` error without infinite retry loops.
- [ ] In non-Tauri (`jsdom`) and Demo (`__ZSTORE_DEMO_MOCK__ = true`) modes, all existing tests in `AppIcon.simplify.test.tsx`, `Sidebar.test.tsx`, and `OAuthAccountCard.poll-leak.test.tsx` pass unchanged.
- [ ] Unit tests in `CachedAvatar.test.tsx` verify `data:` cache resolution via `assetCache`, non-Tauri passthrough, and initials fallback on missing/errored avatar URLs.
- [ ] `noDirectInvoke.test.ts` and `npx vitest run` pass with 0 failures.

## Comments

- 2026-11-14 (agent): 已落地：`iconStore` 导出 `isRealTauriIconRuntime` / `isIconInPreloadBackoff` / `isRemoteHttpIconUrl`，失败（含非 data: 返回）即退避 + `notifyIconDataReady` 唤醒；`AppIcon` 在途渲染 `.app-icon-pending` 空底板；新增 `CachedAvatar` 接入 Sidebar / OAuthAccountCard / DeveloperProfileModal；测试见 `AppIcon.tauri.test.tsx`、`CachedAvatar.test.tsx`。
