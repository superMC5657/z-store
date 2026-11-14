# Issue 03: `AppDetailModal` Header Official Homepage Entry, i18n, Monochrome Visual Adaptation & Regression Tests

Status: resolved
Blocked by: 01, 02

## Summary

Render the conditional 「官方主页」 (`Homepage`) external link entry in the top info bar of `AppDetailModal`, route clicks through ZStore's unified external URL channel (`handleOpenExternal` → `tauriApi.openUrl`), add full `zh-CN` / `en-US` internationalization, unify `.modal-app-repo` metadata links under D4 Linear Monochrome tokens, and lock all behaviors with automated tests.

## Scope

- Allowed to modify:
  - `src/components/AppDetailModal/Header.tsx`
  - `src/locales/zh-CN.json`
  - `src/locales/en-US.json`
  - `src/styles/components-modal.css`
  - `src/components/AppDetailModal/Header.homepage.test.tsx` (new file)
  - `src/components/AppDetailModal/AppDetailModal.i18n.test.tsx`
  - `src/styles/buttons.parity.test.tsx`
- Do not modify:
  - `src-tauri/**` (covered in Issue 01)
  - `src/utils/appHelper.ts` & `src/app/hooks/useDetailCacheSync.ts` (covered in Issue 02)

## Implementation Details

### 1. Bilingual Locale Keys (`src/locales/zh-CN.json` & `src/locales/en-US.json`)

Add two aligned keys under `"detail"` (right next to `"repo_open_title"` / `"latest_release"`):

- `src/locales/zh-CN.json`:
  ```json
  "homepage_link": "官方主页",
  "homepage_open_title": "访问官方主页: {{url}}",
  ```
- `src/locales/en-US.json`:
  ```json
  "homepage_link": "Homepage",
  "homepage_open_title": "Open official homepage: {{url}}",
  ```

Ensure key sets in `zh-CN.json` and `en-US.json` remain 100% identical and `Header.tsx` introduces zero hardcoded CJK literals (`src/components/components.i18n.scan.test.ts` enforces both).

### 2. Top Info Area Entry & Unified External Link Channel (`src/components/AppDetailModal/Header.tsx`)

1. **Harden `handleOpenExternal`**:
   ```ts
   export function handleOpenExternal(e: React.MouseEvent, url: string): void {
     e.preventDefault();
     e.stopPropagation();
     void tauriApi.openUrl(url).catch(() => {});
   }
   ```
   (Also attach `.catch(() => {})` via `void tauriApi.openUrl(...)` in `handleOpenIssueFeedback` for consistent rejection safety.)

2. **Compute `repoUrl` & `homepageUrl` via Issue 02 helpers**:
   - Import `Globe` and `ExternalLink` from `lucide-react`.
   - Import `buildAppRepoUrl` and `resolveExternalHomepageUrl` from `../../utils/appHelper`.
   - Compute:
     ```ts
     const repoUrl = useMemo(
       () => buildAppRepoUrl(app),
       [app.forge_host, app.owner, app.repo],
     );
     const homepageUrl = useMemo(
       () => resolveExternalHomepageUrl(app.homepage, repoUrl),
       [app.homepage, repoUrl],
     );
     ```
   - Reuse `repoUrl` for the `{app.repo} ↗` repository link and `${repoUrl}/issues/new` in `handleOpenIssueFeedback` / feedback `href`.

3. **Render conditional 「官方主页」 link in `.modal-header-info` → `.modal-app-repo`**:
   - Place between `<span>{t('detail.latest_release', { version: app.latest_version })}</span>` and the `detail.issue_link` anchor:
     ```tsx
     {homepageUrl && (
       <>
         <span className="modal-meta-sep" aria-hidden="true">·</span>
         <a
           href={homepageUrl}
           onClick={(e) => handleOpenExternal(e, homepageUrl)}
           target="_blank"
           rel="noopener noreferrer"
           className="modal-meta-link modal-homepage-link"
           data-testid="detail-homepage-link"
           title={t('detail.homepage_open_title', { url: homepageUrl })}
         >
           <Globe size={12} strokeWidth={1.5} aria-hidden="true" />
           <span>{t('detail.homepage_link')}</span>
           <ExternalLink size={11} strokeWidth={1.5} aria-hidden="true" />
         </a>
       </>
     )}
     ```
   - Remove legacy inline `color: 'var(--brand-primary)'` from the developer profile button (`btn-fluent btn-secondary btn-sm` already provides the D4 monochrome secondary token styling) and from the `detail.issue_link` anchor; apply `className="modal-meta-link"` to the `{app.repo} ↗` anchor, the official homepage anchor, and the `detail.issue_link` anchor (removing inline layout styles on `.modal-app-repo` in favor of CSS).

### 3. D4 Linear Monochrome CSS Styling (`src/styles/components-modal.css`)

Update `.modal-app-repo` and add `.modal-meta-link` / `.modal-meta-sep` in `src/styles/components-modal.css`:

```css
.modal-app-repo {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
  margin-bottom: 6px;
  letter-spacing: -0.011em;
}

.modal-meta-sep {
  color: var(--text-tertiary);
  user-select: none;
}

/* 详情顶栏单色外链入口（仓库 / 官方主页 / 问题反馈统一 D4 去彩单色交互） */
.modal-meta-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-weight: 510;
  line-height: 1.3;
  text-decoration: none;
  cursor: pointer;
  transition: color 0.12s var(--ease-smooth),
              background 0.12s var(--ease-smooth),
              border-color 0.12s var(--ease-smooth),
              transform 0.12s var(--ease-smooth);
}

.modal-meta-link svg {
  flex-shrink: 0;
  color: currentColor;
}

.modal-meta-link:hover {
  color: var(--text-primary);
  background: var(--bg-acrylic-hover);
  border-color: var(--border-subtle);
}

.modal-meta-link:active {
  transform: scale(0.97);
}

.modal-meta-link:focus-visible {
  outline: 2px solid var(--border-highlight);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .modal-meta-link {
    transition: none;
  }
}
```

### 4. Tests & Regression Gates

1. **New component behavioral test file `src/components/AppDetailModal/Header.homepage.test.tsx`**:
   - **Displays official homepage entry**:
     - Valid external `https://zed.dev` and `http://gitup.co` render `data-testid="detail-homepage-link"` inside `.modal-header-info .modal-app-repo` with visible text `"官方主页"`, `href` matching the normalized URL, and `title` containing the full URL (`"访问官方主页: https://zed.dev"`);
     - Same-host distinct path (`https://github.com/apps/desktop` for `desktop/desktop`) and cross-forge homepage (`https://gitlab.com/OpenMW/openmw` for GitHub `OpenMW/openmw`) render the entry.
   - **Suppresses official homepage entry**:
     - `homepage: null`, `""`, `"   "`, `"zed.dev"` (no scheme), `"javascript:alert(1)"`, `"ftp://files.example.com"`, `"mailto:dev@example.com"` do NOT render `detail-homepage-link`;
     - Same-repository URLs across GitHub (`https://github.com/Test/Demo-App`, `https://github.com/test/demo-app/`, `http://www.github.com/test/demo-app.git`, `https://github.com/test/demo-app#readme`, `https://github.com/test/demo-app?tab=readme-ov-file`) and non-GitHub forges (`forge: 'codeberg', forge_host: 'codeberg.org', homepage: 'https://codeberg.org/test/demo-app/'`) do NOT render `detail-homepage-link`.
   - **Unified external link channel & event isolation**:
     - Clicking `detail-homepage-link` inside `<AppDetailModal>` calls `tauriApi.openUrl('https://zed.dev')` once, does NOT invoke `window.open`, and does NOT trigger `onClose` on `.modal-backdrop`.
   - **Monochrome visual style contract**:
     - `detail-homepage-link` has class `modal-meta-link`, carries no inline `color` override, and renders monochrome `currentColor` SVGs (`stroke-width="1.5"`).

2. **Extend `src/components/AppDetailModal/AppDetailModal.i18n.test.tsx`**:
   - Assert that when `app.homepage` is `'https://demo.example.org/docs?ref=zstore'`, `Header` renders `"官方主页"` with `title="访问官方主页: https://demo.example.org/docs?ref=zstore"` in `zh-CN`, and switches to `"Homepage"` with `title="Open official homepage: https://demo.example.org/docs?ref=zstore"` in `en-US` (while `FIXTURE_APP` with `homepage: null` continues to omit the link in both languages).

3. **Extend `src/styles/buttons.parity.test.tsx`**:
   - Assert `components-modal.css` defines `.modal-meta-link`, `.modal-meta-link:hover`, and `.modal-meta-link:focus-visible` using monochrome tokens (`var(--text-secondary)`, `var(--text-primary)`, `var(--bg-acrylic-hover)`, `var(--border-highlight)`) and never `--brand-primary`;
   - In the `AppDetailModal` render parity test (with a valid `homepage` and `onOpenDeveloperProfile` supplied), assert `.modal-app-repo` links and developer button carry zero inline `var(--brand-primary)` color overrides.

## Acceptance Criteria

- [x] `Header.homepage.test.tsx` passes all display, suppression, hover full-URL tooltip, unified `tauriApi.openUrl` click channel, backdrop non-propagation, and monochrome class/icon assertions.
- [x] `AppDetailModal.i18n.test.tsx` and `components.i18n.scan.test.ts` pass (bilingual switching verified, locale keys aligned, zero hardcoded CJK literals).
- [x] `buttons.parity.test.tsx`, `noDirectInvoke.test.ts`, `ipcArgsNaming.test.ts`, and `countDisplay.test.ts` all pass.
- [x] Full verification suite passes cleanly:
  - `pnpm check` (`tsc --noEmit && vitest run`)
  - `pnpm build` & `pnpm build:demo`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib`

## Comments

- 2026-11-15 已实现：Header 官方主页入口、`.modal-meta-link` / `.modal-meta-sep` 单色样式、中英 i18n；新增 `Header.homepage.test.tsx`，扩展 i18n 与 buttons.parity 用例。`pnpm run check`（1135 passed）、`pnpm build`、`pnpm build:demo`、clippy、cargo test 全部通过；demo 预览中 PowerToys 详情顶栏正确展示。
