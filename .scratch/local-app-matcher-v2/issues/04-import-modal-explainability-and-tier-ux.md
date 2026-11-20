# Issue 04: Import Modal Local-Name Explainability, Match Reason Tags, 3-Tier Confidence UX & Demo Alignment

Status: resolved
Blocked by: 03

## Summary

Upgrade `src/components/AppImportModal.tsx`, TypeScript types, i18n copy, and the live web demo mock so the human confirmation step clearly exposes what local entry was detected, *why* it matched, and distinguishes all three confidence tiers (`high` / `medium` / `low`) while adhering strictly to `CONTEXT.md` D4 Linear monochrome rules and `docs/count-display.md`:

1. **Safer Default Selection (`>= 0.70`)**: Auto-select only `high`-confidence matches (`r.confidence_tier === 'high'` / `r.confidence >= 0.70`) on scan completion, leaving `medium` (`0.55–0.69`) and `low` (`0.45–0.54`) unchecked for explicit user opt-in.
2. **Local Detected Name & Publisher Transparency**: When `item.scanned.display_name` (trimmed, case-insensitive) differs from `item.name`, display a clear metadata item showing the local detected name (e.g. `本机名称: Microsoft Visual Studio Code (User)`), plus `item.scanned.publisher` when available.
3. **Structured Match Evidence Tags (`match_reasons`)**: Render concise monochrome metadata pills/text from `item.match_reasons` (e.g. `主程序命中`、`名称一致`、`发布者一致`、`应用标识命中`、`安装目录命中`).
4. **Three-Tier Confidence Presentation (`high` / `medium` / `low`)**:
   - `high` (`>= 0.70`): `ShieldCheck` icon + subtle success border/text;
   - `medium` (`0.55–0.69`): `Sparkles` icon + neutral monochrome tag;
   - `low` (`0.45–0.54`): `AlertTriangle` icon + subtle warning status tone (`--status-warning` / amber accent per D4 status-color exception) with concise "建议核对路径" / "Verify path" hint.
5. **Live Demo Handler (`src/demo/handlers/catalog.ts`) & Component Tests (`src/components/AppImportModal.test.tsx`)**: Return realistic sample unmanaged matches in Demo mode (excluding apps already in Demo's installed list, and supporting `handleImportMatchedApps` adding them to Demo state!) and add Vitest tests locking selection, explainability rendering, and `countDisplay.test.ts` compliance.

## Scope

- Allowed to modify:
  - `src/types/index.ts`
  - `src/components/AppImportModal.tsx`
  - `src/components/AppImportModal.test.tsx` (new file)
  - `src/locales/zh-CN.json`
  - `src/locales/en-US.json`
  - `src/demo/handlers/catalog.ts`
- Do not modify:
  - `src-tauri/*` (backend files)
  - `src/components/CountBadge.tsx`, `src/styles/components-count-badge.css`

## Implementation Details

### 1. TypeScript Contract Sync (`src/types/index.ts`)

- Update `ScannedRawApp` and `AppMatchResult` in `src/types/index.ts`:
  ```ts
  export interface ScannedRawApp {
    display_name: string;
    display_version: string;
    publisher?: string;
    install_location?: string;
    display_icon?: string;
    uninstall_string?: string;
    installed_at?: number;
    registry_key?: string;
    source_kind?: string;
  }

  export interface AppMatchResult {
    scanned: ScannedRawApp;
    catalog_id: string;
    name: string;
    owner: string;
    repo: string;
    icon: string;
    icon_bg: string;
    description: string;
    local_version: string;
    catalog_version: string;
    confidence: number;
    confidence_tier: 'high' | 'medium' | 'low';
    resolved_executable_path?: string;
    match_reasons?: string[];
  }
  ```

### 2. i18n Keys (`src/locales/zh-CN.json` & `src/locales/en-US.json`)

- Under `import_modal`, add keys **without any parenthesized interpolation** (must obey `docs/count-display.md` — never write `({{name}})` or `({{count}})`):
  - `detected_name`: `"本机名称: {{name}}"` / `"Installed as: {{name}}"`
  - `low_confidence_hint`: `"低置信度，请核对路径"` / `"Low confidence, verify path"`
  - `reasons`:
    - `exact_name`: `"名称精确"` / `"Exact name"`
    - `prefix_name`: `"名称近似"` / `"Similar name"`
    - `alias`: `"别名匹配"` / `"Alias match"`
    - `executable`: `"主程序命中"` / `"Binary match"`
    - `bundle_id`: `"包标识命中"` / `"Bundle ID"`
    - `install_dir`: `"目录命中"` / `"Folder match"`
    - `publisher`: `"发布者一致"` / `"Publisher"`
    - `version`: `"版本吻合"` / `"Same version"`

### 3. `AppImportModal.tsx` UX & D4 Monochrome Styling

- **Default checked set**:
  ```ts
  const initialSelected = new Set(
    results
      .filter((r) => r.confidence_tier === 'high' || r.confidence >= 0.7)
      .map((r) => r.catalog_id)
  );
  ```
- **Three-tier confidence badge**:
  - `high`: `ShieldCheck` (`size={11}`, `strokeWidth={1.5}`), `--status-success` text / `--status-success-bg` background;
  - `medium`: `Sparkles` (`size={11}`, `strokeWidth={1.5}`), `--text-secondary` text / `--bg-acrylic-hover` background / `--border-subtle` border (pure Linear monochrome instead of brand blue!);
  - `low`: `AlertTriangle` (`size={11}`, `strokeWidth={1.5}`), amber warning status tone (`#d97706` / `rgba(245, 158, 11, 0.12)` background, `rgba(245, 158, 11, 0.3)` border) + inline `t('import_modal.low_confidence_hint')`.
- **Local detected name & match evidence line**:
  - Compare `item.scanned.display_name.trim().toLowerCase() !== item.name.trim().toLowerCase()`: when different (and `item.scanned.display_name.trim()` is non-empty), render `t('import_modal.detected_name', { name: item.scanned.display_name.trim() })` in the secondary metadata row so users immediately see what local software matched.
  - Render up to 3 mapped labels from `item.match_reasons` (ignoring unknown keys gracefully) as compact `.status-tag` or subtle hairline tags.
- Ensure no view imports `api/client` directly (`noDirectInvoke.test.ts`), and the `"添加"` / `"Add"` primary footer button carries no count (`docs/count-display.md` §74).

### 4. Demo Mode Support (`src/demo/handlers/catalog.ts`)

- Implement `handleScanAndMatchLocalApps()` and `handleImportMatchedApps(a: InvokeArgs)` using Demo's catalog & installed state (`demoState.ts`) with camelCase-only arg access:
  - `handleScanAndMatchLocalApps()` picks 3 representative catalog apps not yet in Demo's `installedApps` (1 `high` confidence e.g. `microsoft/vscode` scanned as `"Microsoft Visual Studio Code (User)"`, 1 `high` e.g. `obsproject/obs-studio`, 1 `medium` `0.62` unchecked by default) so Demo visitors can test scanning and importing end-to-end.
  - `handleImportMatchedApps(a)` reads `apps` array from `a`, appends non-duplicate `InstalledApp` entries into Demo's installed state, and returns the imported count.

## Acceptance Criteria

- [x] `src/components/AppImportModal.test.tsx` verifies:
  - Only `high` (`>= 0.70`) items are pre-checked on open; `medium` (`0.62`) and `low` (`0.48`) items start unchecked and can be toggled manually;
  - When `scanned.display_name` (`"Microsoft Visual Studio Code (User)"`) differs from `name` (`"VS Code"`), the local detected name is rendered; when identical (`"OBS Studio"`), it is not redundantly duplicated;
  - Known `match_reasons` render localized labels and `low` tier displays the verification warning hint;
  - Selecting items and clicking Import sends the expected `ImportAppRequest[]` payload via `tauriApi.importMatchedApps`.
- [x] `npx tsc --noEmit`, `npx vitest run` (including `countDisplay.test.ts`, `noDirectInvoke.test.ts`, `ipcArgsNaming.test.ts`, `cmdAlignment.test.ts`), and `npx vite build --config vite.demo.config.ts` all pass cleanly.
