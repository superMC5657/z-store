# Issue 02: Frontend Homepage URL Guard, Repo-URL Deduplication & Detail Cache Sync

Status: resolved
Blocked by: none

## Summary

Implement the frontend single source of truth for constructing an app's repository URL, validating `homepage` as a safe `http(s)` URL distinct from the current repository address, and keeping `selectedApp.homepage` synchronized across 0ms cache-first modal opens and silent background ETag refreshes:

1. **Pure URL helpers in `src/utils/appHelper.ts`**:
   - `buildAppRepoUrl(app)`: canonical web URL builder for the current repository (`https://{forge_host || 'github.com'}/{owner}/{repo}`).
   - `resolveExternalHomepageUrl(homepage, repoUrl)`: strict `http(s)` validator + multi-forge repository URL deduplicator returning the full normalized URL when distinct, or `null` when invalid or pointing to the current repository.
2. **Detail modal state synchronization in `src/app/hooks/useDetailCacheSync.ts`**:
   - Update `selectedApp` when `detail.homepage` changes during `isBackgroundSilent` ETag revalidation;
   - Heal blank `cachedForShow.homepage` from `catalogHit.homepage` on memory-cache hits, and prefill `initialDetail.homepage` from `snapshotTrendEnrichCache()` when opening enriched uncataloged cards (e.g. from `TrendsView` or `StarredFeed`).

## Scope

- Allowed to modify:
  - `src/utils/appHelper.ts`
  - `src/utils/appHelper.homepage.test.ts` (new file)
  - `src/app/hooks/useDetailCacheSync.ts`
  - `src/app/hooks/useDetailCacheSync.test.tsx`
- Do not modify:
  - `src/components/AppDetailModal/**`, `src/locales/**`, `src/styles/**` (belong to Issue 03)
  - `src-tauri/**` (belongs to Issue 01)

## Implementation Details

### 1. Repository URL Builder & External Homepage Resolver (`src/utils/appHelper.ts`)

1. `export function buildAppRepoUrl(app: { forge_host?: string | null; owner?: string | null; repo?: string | null }): string`
   - Strip leading/trailing whitespace from `forge_host`, remove any accidental leading `http://` or `https://` (case-insensitive) and trailing `/`, fallback to `'github.com'` if empty.
   - Trim `owner` and `repo` (stripping leading/trailing `/`); if either is empty, return `''`.
   - Return `https://${host}/${owner}/${repo}`.

2. `export function resolveExternalHomepageUrl(homepage: unknown, repoUrl: string): string | null`
   - Return `null` unless `typeof homepage === 'string'`.
   - `const trimmed = homepage.trim();` — return `null` if `!trimmed` or `/\s/.test(trimmed)` (reject embedded spaces such as `"https://example.com (official)"`).
   - Parse with `new URL(trimmed)` (without a base URL so relative paths like `"/docs"` or scheme-less `"zed.dev"` throw and return `null`).
   - Protocol check: allow ONLY `parsed.protocol === 'http:' || parsed.protocol === 'https:'` (reject `javascript:`, `data:`, `vbscript:`, `mailto:`, `ftp:`, `file:`, `zstore:`, etc.).
   - Credential check: if `parsed.username || parsed.password`, return `null`.
   - Host validity check:
     - `const cleanHost = parsed.hostname.replace(/\.+$/, '').toLowerCase();`
     - Reject if `!cleanHost` or `cleanHost.startsWith('.')`.
     - Require `cleanHost.includes('.') || cleanHost === 'localhost' || (cleanHost.startsWith('[') && cleanHost.endsWith(']'))` (rejects bogus single-label placeholders like `https://none`).
   - Deduplicate against `repoUrl`:
     - If `repoUrl.trim()` parses cleanly via `new URL(repoUrl.trim())`:
       - `comparableHost(u: URL)`: `u.hostname.replace(/\.+$/, '').toLowerCase().replace(/^www\./, '')` + `(u.port ? `:${u.port}` : '')` (note: WHATWG `URL` already normalizes default `:80` for `http:` and `:443` for `https:` to `''`, while keeping custom self-hosted ports like `:8443`).
       - `comparableRepoPath(pathname: string)`: safely `decodeURIComponent(pathname)` (fallback to raw `pathname` on malformed `%`), collapse consecutive slashes `/\/+/g` → `'/'`, strip trailing `'/'`, strip optional case-insensitive `.git` suffix (`/\.git$/i`), and `.toLowerCase()`.
       - If `comparableHost(parsed) === comparableHost(repoParsed)` AND `comparableRepoPath(parsed.pathname) === comparableRepoPath(repoParsed.pathname)`, return `null` (treats `http` vs `https`, `www.`, mixed-case `Owner/Repo`, trailing `/`, `.git`, `#readme`, and `?tab=readme-ov-file` on the same repository as identical to `repoUrl`).
   - Return `trimmed.replace(/^https?:/i, (scheme) => scheme.toLowerCase())` so uppercase `HTTPS://` becomes `https://` while preserving the authored full URL (without injecting unwanted trailing slashes on bare origins like `https://zed.dev`).

### 2. Sync `homepage` in `useDetailCacheSync` (`src/app/hooks/useDetailCacheSync.ts`)

1. **Silent background refresh (`patchDetailMemoryAndLists`, around lines 206–216)**:
   - Add `(prev.homepage ?? null) !== (detail.homepage ?? null)` to the `setSelectedApp` condition when `isBackgroundSilent === true`, matching `patchSummary` (line 283) so `selectedApp.homepage` updates immediately if remote revalidation discovers a new/updated homepage.
2. **Memory-cache hit healing (`handleOpenDetail`, around lines 525–546)**:
   - If `(!cachedForShow.homepage || cachedForShow.homepage.trim() === '') && catalogHit?.homepage && catalogHit.homepage.trim() !== ''`, set `cachedForShow = { ...cachedForShow, homepage: catalogHit.homepage }`.
3. **Initial detail prefill from `trendEnrichCache` (`handleOpenDetail`, around lines 591–675)**:
   - While scanning `snapshotTrendEnrichCache()` for `enrichInitialDesc` / `enrichInitialDescEn`, also capture `enrichInitialHomepage` (`typeof hit.homepage === 'string' && hit.homepage.trim() !== '' ? hit.homepage : undefined`).
   - In `initialDetail`:
     - When `existing` is found: `homepage: (existing.homepage && existing.homepage.trim() !== '') ? existing.homepage : (enrichInitialHomepage ?? null)`.
     - When `existing` is absent: `homepage: enrichInitialHomepage ?? null`.

## Acceptance Criteria

- [x] Unit tests in `src/utils/appHelper.homepage.test.ts` cover:
  - `buildAppRepoUrl`: default GitHub host when `forge_host` is empty/null, custom/non-GitHub hosts (`codeberg.org`, `gitlab.com`, `git.example.com:8443`), accidental `https://` or trailing `/` in `forge_host`, and empty `owner`/`repo` returning `''`.
  - `resolveExternalHomepageUrl` **valid & distinct cases**:
    - Standard `https://rustdesk.com` and `https://www.videolan.org/vlc/` (preserving trailing slash policy of input);
    - Valid `http://gitup.co`;
    - Surrounding spaces + uppercase scheme `'  HTTPS://Example.com/docs?lang=zh#intro  '` → `'https://Example.com/docs?lang=zh#intro'`;
    - Same host, distinct path: `'https://github.com/apps/desktop'` vs `'https://github.com/desktop/desktop'`, and `'https://github.com/owner/repo/wiki'` vs `'https://github.com/owner/repo'`;
    - Cross-forge homepage: `'https://gitlab.com/OpenMW/openmw'` vs `'https://github.com/OpenMW/openmw'`, and GitHub Pages `'https://clash-verge-rev.github.io'` vs `'https://github.com/clash-verge-rev/clash-verge-rev'`.
  - `resolveExternalHomepageUrl` **invalid cases returning `null`**:
    - `null`, `undefined`, `''`, `'   '`, non-string values;
    - Bare domain without scheme (`'zed.dev'`), relative path (`'/docs'`), malformed URL (`'https://'`, `'http://[bad'`), URL with internal whitespace (`'https://zed.dev (official)'`);
    - Unsafe / non-http(s) protocols (`'javascript:alert(1)'`, `'data:text/html,<h1>x</h1>'`, `'vbscript:msgbox(1)'`, `'mailto:hi@example.com'`, `'ftp://files.example.com'`, `'file:///C:/test'`, `'zstore://app/o/r'`);
    - Embedded credentials (`'https://github.com@evil.example.com'`) and single-label bogus host (`'https://none'`).
  - `resolveExternalHomepageUrl` **same-repository deduplication cases returning `null`**:
    - Exact match, mixed-case `Owner/Repo` (`'https://github.com/BurntSushi/ripgrep'` vs `'https://github.com/burntsushi/ripgrep'`), trailing slashes (`'/'`, `'///'`), `http://` vs `https://`, `www.github.com`, `.git` suffix (`'https://github.com/BurntSushi/ripgrep.git'`), `#readme` hash, `?tab=readme-ov-file` query, default port `:443` / `:80`, Codeberg (`'https://codeberg.org/FreeTubeApp/FreeTube/'`), and self-hosted Gitea with non-default port (`'https://git.example.com:8443/Org/Repo'` vs `'https://git.example.com:8443/org/repo'`, while `'https://git.example.com:9443/org/repo'` is preserved as distinct).
- [x] Hook tests in `src/app/hooks/useDetailCacheSync.test.tsx` verify:
  - Silent background revalidation (`handleOpenDetail` hitting `appDetailMemoryCache` followed by `getAppDetails` returning a changed `homepage`) updates `selectedApp.homepage`;
  - Opening an uncataloged trend repo whose richcard in `trendEnrichCache` already carries `homepage: 'https://atlas.dev'` populates `selectedApp.homepage` immediately on the initial synchronous frame before `getAppDetails` resolves.
- [x] `pnpm check` passes cleanly.

## Comments

- 2026-11-15 已实现：`appHelper.ts` 新增 `buildAppRepoUrl` / `resolveExternalHomepageUrl`（`appHelper.homepage.test.ts`）；`useDetailCacheSync` 静默重验比对 homepage、内存命中用目录主页治愈、富卡主页预填首帧（3 条 hook 用例）。`pnpm run check` 通过。
