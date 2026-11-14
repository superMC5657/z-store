# Issue 04: Bridge `fetch_or_cache_asset_url` via `data:` URI & Eliminate Dual-Fetch in README / Changelog

Status: resolved
Blocked by: none

## Summary

Fix the broken general image disk-cache bridge (`fetch_or_cache_asset_url`) and eliminate duplicate WebView + Rust requests when rendering Markdown images in **App Details (`ReadmeSection`)** and **My Apps (`ChangelogDrawer`)**:

1. **Broken return contract (`src-tauri/src/github/asset_fetch.rs:337` & `src/components/AppDetailModal/useDetailReadme.ts:247-253`)**:
   - `asset_fetch.rs` downloads images through `new_icon_client` (with system proxy) into `cache/assets/` and returns a **raw OS filesystem path** (`C:\Users\...\xxxx.png`), which `useDetailReadme.ts` rejects because it checks `startsWith('asset:' | 'tauri:' | 'asset.localhost')`. The cached file on disk is never used.
2. **First-paint WebView race causing 2× bandwidth waste (`useDetailReadme.ts:225`)**:
   - `setResolvedReadmeHtml(baseReadmeHtml)` immediately mounts raw remote `https://raw.githubusercontent.com/...` `<img src>` tags into the live DOM, causing the WebView to fire direct HTTP requests at the exact same moment the backend `fetchOrCacheAssetUrl` downloads them again.
3. **Uncached `.gif` demos and `ChangelogDrawer` images**:
   - `useDetailReadme.ts:238` skips `.gif` URLs even though `asset_fetch.rs` already supports `gif` up to `MAX_ASSET_BYTES` (5 MB), and `ChangelogDrawer.tsx` bypasses `fetchOrCacheAssetUrl` altogether.

## Scope

- Allowed to modify / create:
  - `src-tauri/src/github/asset_fetch.rs`
  - `src/services/assetCache.ts` (new shared frontend asset cache + Markdown HTML image resolver)
  - `src/services/assetCache.test.ts` (new unit tests)
  - `src/components/AppDetailModal/useDetailReadme.ts`
  - `src/views/InstalledView/ChangelogDrawer.tsx`
  - `src/components/AppDetailModal.readme.test.tsx`
- Do not modify:
  - `src/components/AppIcon.tsx` / `src/services/iconStore.ts` / `Sidebar.tsx` / `OAuthAccountCard.tsx` / `DeveloperProfileModal.tsx` (belongs to Issue 05)
  - `src-tauri/src/proxy/*` / `src-tauri/src/mirror.rs` (belongs to Issues 01–02)

## Implementation Details

### 1. Return validated `data:<mime>;base64,...` from `fetch_or_cache_asset_url_inner` (`src-tauri/src/github/asset_fetch.rs`)

- Keep existing sharded disk persistence (`cache/assets/<2-hex>/<16-hex>.<ext>`), 30-day TTL, ETag / `Last-Modified` conditional revalidation (`304 Not Modified`), `MAX_ASSET_BYTES = 5 * 1024 * 1024` (5 MB) cap, and LRU quota enforcement intact.
- Add a helper `read_cached_asset_data_uri(path: &std::path::Path) -> Option<String>`:
  - Reads file bytes via `crate::icons::read_valid_image_file(path)` and encodes via `crate::icons::bytes_to_data_uri(&bytes)` (zero `assetProtocol` filesystem exposure, 100% consistent across Windows/macOS/Linux).
- Update `fetch_asset_inner` / `store_fresh_asset` return values:
  - On fresh cache hit, `304 Not Modified` revalidation hit, stale offline fallback hit, or newly stored fresh download: return `data:<mime>;base64,...`!
  - Only when `!should_cache_asset(trimmed)` (e.g. `shields.io` / `camo` / `badge` dynamic URLs, `.mp4`), or download fails with no cached file on disk (including `> 5 MB` oversize assets): fall back to returning `trimmed.to_string()` (the original remote `https://` URL).
- Update `asset_fetch.rs` unit tests to assert `data:image/...;base64,` output on cache hit/store and original URL fallback on dynamic/oversize/failed inputs.

### 2. Shared bounded frontend asset cache & race-free Markdown HTML resolver (`src/services/assetCache.ts`)

- Export runtime detector `isRealTauriAssetRuntime(): boolean`:
  - Returns `true` only when `typeof window !== 'undefined'`, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, and `!window.__ZSTORE_DEMO_MOCK__` (so Vitest `jsdom` tests without IPC and the live web Demo build keep synchronous remote URLs untouched!).
- Maintain a bounded in-memory LRU/FIFO map `resolvedAssetMemCache` (`MAX_ENTRIES = 120`, keyed by normalized HTTP(S) URL) + single-flight `inflightAssetPromises` map:
  - Expose `resolveCachedAssetUri(url: string, appId?: string): Promise<string>` (reusable by Issue 05's `<CachedAvatar>`):
    - Returns cached `data:` URI immediately on memory hit;
    - Deduplicates concurrent requests for the same `url` via `inflightAssetPromises`;
    - Calls `tauriApi.fetchOrCacheAssetUrl(url, appId ?? '')`, caches `data:` hits in `resolvedAssetMemCache`, and returns either the `data:` URI or the fallback `url`.
  - Expose `getSyncCachedAssetUri(url: string): string | undefined` and `__resetAssetCacheForTests(): void`.
- Provide race-free Markdown HTML image resolution hook `useResolvedMarkdownImages(baseHtml: string, appId?: string): string`:
  - **Non-Tauri / Demo mode (`!isRealTauriAssetRuntime()`)**: return `baseHtml` synchronously unchanged.
  - **Real Tauri mode**:
    1. **Synchronous pass (`prepareInitialHtml`)**: Parse `baseHtml` with `DOMParser`. For every `<img src="https://...">` (and `<source srcset>` if present, leaving dynamic `shields.io` / `camo` / `badge` / `workflow` URLs untouched so badges still load directly):
       - Do **not** skip `.gif` anymore (backend caps at 5 MB and falls back to original URL if larger)!
       - If `getSyncCachedAssetUri(src)` hits: set `img.setAttribute('src', hit)` immediately (0ms zero-flicker paint).
       - Otherwise: store original URL in `data-zstore-src={src}` and set `src` to a tiny transparent 1×1 GIF/SVG placeholder `data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7` so the WebView renders text at 0ms **without** firing a duplicate direct network request!
    2. **Bounded async pass (`concurrency = 4`)**: Resolve each pending `data-zstore-src` via `resolveCachedAssetUri(src, appId)`. Whether it returns a `data:` URI or falls back to the original `https://` URL (e.g. `> 5 MB` GIF), write it to `src`, remove `data-zstore-src`, and update state once (or per batch) if not cancelled.

### 3. Wire into `useDetailReadme.ts` and `ChangelogDrawer.tsx`

- In `src/components/AppDetailModal/useDetailReadme.ts`:
  - Replace the broken `asset:` / `tauri:` / `asset.localhost` `useEffect` block (lines 223–267) with `useResolvedMarkdownImages(baseReadmeHtml, appId)`.
- In `src/views/InstalledView/ChangelogDrawer.tsx`:
  - Pass sanitized `baseHtml` and `update.app_id` through `useResolvedMarkdownImages(baseHtml, update.app_id)` before rendering `dangerouslySetInnerHTML`.

## Acceptance Criteria

- [ ] Rust unit test: `fetch_or_cache_asset_url_inner` stores a mocked PNG/GIF image and returns a `data:image/png;base64,...` / `data:image/gif;base64,...` string on both initial fetch and subsequent 30-day cache hit; dynamic badge URLs (`shields.io`) return the original URL without network fetch.
- [ ] Frontend unit test (`assetCache.test.ts`): in simulated real Tauri runtime (`__TAURI_INTERNALS__.invoke` mocked), initial render of Markdown with `<img src="https://raw.githubusercontent.com/o/r/main/demo.png">` and `demo.gif` does **not** expose raw `https://raw.githubusercontent.com/...` on `<img src>` before `fetchOrCacheAssetUrl` resolves, and updates `<img src>` to the returned `data:image/...` URI once resolved (bounded to concurrency `<= 4` and single-flight per unique URL).
- [ ] Existing `AppDetailModal.readme.test.tsx` and `InstalledView.test.tsx` pass without regression.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` and `npx vitest run` pass.

## Comments

- 2026-11-14 (agent): 已落地：`asset_fetch` 所有命中/落盘路径返回 `data:` URI（缓存根可注入，测试用 tempdir）；`src/services/assetCache.ts`（有界 120 条 + ~48MB、单飞、`useResolvedMarkdownImages` 占位 + 并发 4 + 200ms 节流回填，含 `srcset`）；`useDetailReadme` 与 `ChangelogDrawer` 接入。
