# Issue 05: Real-Catalog Adversarial & Recall Evaluation Suite, ADR-0028, Domain Docs Sync & Full Regression Gates

Status: ready-for-agent
Blocked by: 01, 02, 03, 04

## Summary

Lock down matching quality against the repository's real `catalog.json` via a dedicated evaluation test suite (mirroring `affinity_eval_tests.rs`), record the architecture contract in `docs/adr/0028-inverted-index-and-boundary-safe-local-app-matching.md`, synchronize `CONTEXT.md`, mark `spec.md` as `Implemented`, and pass every full-stack gate.

## Scope

- Allowed to modify:
  - `src-tauri/src/scanner/matcher_eval_tests.rs` (new file)
  - `src-tauri/src/scanner/mod.rs` (wire `#[cfg(test)] mod matcher_eval_tests;`)
  - `docs/adr/0028-inverted-index-and-boundary-safe-local-app-matching.md` (new file)
  - `CONTEXT.md`
  - `.scratch/local-app-matcher-v2/spec.md`
- Do not modify:
  - Production logic in `src/*` or `src-tauri/*` unless fixing a genuine edge case uncovered by the real-catalog evaluation suite.

## Implementation Details

### 1. Real-Catalog Precision & Recall Evaluation Suite (`src-tauri/src/scanner/matcher_eval_tests.rs`)

Load the real root `catalog.json` (`concat!(env!("CARGO_MANIFEST_DIR"), "/../catalog.json")`) and enforce three benchmark invariants:

1. **`adversarial_non_catalog_apps_produce_zero_false_positives`**:
   Construct realistic `ScannedRawApp` fixtures for common proprietary, OS-bundled, and similarly named software installed on user machines:
   - `Miniconda3 py311_24.1.2-0` at `C:\Users\admin\miniconda3` (tests short repo `min` + `admin` user path)
   - `WPS Office (12.1.0.17827)` at `C:\Program Files\WPS Office` & `Microsoft Office Professional Plus` (tests `ice` substring)
   - `Microsoft Visual Studio IDE 2022` with `publisher = Some("Microsoft Corporation")` (tests `ide` alias + `Microsoft` publisher)
   - `Factorio` at `C:\Program Files\Factorio` (tests `rio` substring)
   - `Twitch` at `C:\Users\admin\AppData\Roaming\Twitch` (tests `itch` substring)
   - `Dolby Atmos` at `C:\Program Files\Dolby\Dolby Atmos` (tests `mos` substring)
   - `AnyDesk`, `TeamViewer`, `1Password 8`, `Postman x86_64`, `Mozilla Firefox (x64 zh-CN)`, `Epic Games Launcher`, `WinRAR 7.01 (64-bit)`, `Navicat Premium 17`, `NVIDIA Graphics Driver 560.94`, `Realtek Audio Console`
   - Official upstream `7-Zip 24.08 (x64)` (`publisher = Some("Igor Pavlov")`, `install_location = Some(r"C:\Program Files\7-Zip")`, `display_icon = Some(r"C:\Program Files\7-Zip\7zFM.exe")`) — must **not** match `mcmilk/7-zip-zstd` (unless upstream `ip7z/7zip` itself is ever added to `catalog.json`)!
   - Assert `AppScanner::match_apps(&adversarial, &catalog)` returns **0 matches** (`assert!(matches.is_empty(), "unexpected false positives: {matches:#?}")`).

2. **`curated_real_world_installed_variants_recall_accurately`**:
   Construct realistic messy registry/system fixtures against real `catalog.json` items (including older local versions, `(User)` / `(64-bit x64)` suffixes, missing `InstallLocation`, NSIS `UninstallString`, Squirrel paths, and Chinese display names where applicable):
   - `"Microsoft Visual Studio Code (User)"` (`1.92.0`, `Microsoft Corporation`, `...\Microsoft VS Code\Code.exe`) → `microsoft/vscode` (`high`)
   - `"VSCodium (User)"` (`1.92.0`, `...\VSCodium\VSCodium.exe`) → `vscodium/vscodium` (`high`) — verify **both** VS Code and VSCodium coexist side-by-side in the same scan without colliding!
   - `"Notepad++ (64-bit x64)"` (`8.6.9`, `...\Notepad++\notepad++.exe`) & `"Notepad Next"` (`0.7`, `...\NotepadNext\NotepadNext.exe`) → `notepad-plus-plus/notepad-plus-plus` and `dail8859/notepadnext` simultaneously!
   - `"Motrix 1.8.18"` (older version, `publisher = Some("Dr_rOot")`, `install_location = None`, `display_icon = None`) → `agalwood/motrix`
   - `"GitHub Desktop"` (`3.4.8`, `GitHub, Inc.`, `...\AppData\Local\GitHubDesktop`) → `desktop/desktop`
   - `"VLC media player 3.0.20"` (`VideoLAN`, `...\VideoLAN\VLC\vlc.exe,0`) → `videolan/vlc`
   - `"RustDesk"` (`1.3.0`, `...\RustDesk\rustdesk.exe`) → `rustdesk/rustdesk`
   - `"Clash Verge"` (`1.7.7`, `...\Clash Verge\Clash Verge.exe`) → `clash-verge-rev/clash-verge-rev`
   - `"Bulk Crap Uninstaller"` (`5.8`, `...\BCUninstaller\Bulk-Crap-Uninstaller.exe`) → `klocman/bulk-crap-uninstaller`

3. **`inverted_index_matches_full_catalog_in_bounded_time`**:
   Simulate a 400-entry realistic Windows Registry snapshot against the full `catalog.json` and assert `match_apps` completes deterministically (same result order across repeated runs) in well under `100ms` in debug test builds.

### 2. Author `docs/adr/0028-inverted-index-and-boundary-safe-local-app-matching.md` & Update `CONTEXT.md`

- Follow `AGENTS.md` documentation rules (describe present behavior concisely, explain *why* only when non-obvious, no change-history prose):
  - Document the 4-stage pipeline in `ADR-0028`:
    1. Multi-source discovery across Windows (merged 3-hive Uninstall registry + `registry_key` + `UninstallString` parent inference + Scoop manifests + unregistered Start Menu `.lnk`), Linux (XDG `.desktop` ignoring spec `Version=` + `dpkg`/`rpm` package version lookup + `AppImage`), and macOS (`/Applications` & `~/Applications` `Info.plist`);
    2. Upfront managed/platform filtering, installer-asset identifier sanitization, and four-way `CatalogMatchIndex` inverted retrieval;
    3. Title normalization, token/path-component boundary scoring, short-name corroboration gate, competitor/category alias isolation, fork/variant penalty guard, and global 1-to-1 assignment with `match_reasons`;
    4. Unicode/CP_ACP `.lnk` resolution, Squirrel `app-*` & auxiliary-binary filtering, 2-segment SemVer coercion, single-pass `registry_entries` reuse in `get_installed_apps`, and `AppImportModal` local-name explainability (`high`-only default check).
- Update `CONTEXT.md` §35 **存量应用管理 (`External App Management`)** so its glossary definition accurately reflects multi-platform discovery (Windows 注册表/Scoop/快捷方式、Linux `.desktop`/AppImage、macOS `.app`)、内存四路倒排索引、词与路径段边界打分及本机原名核验导入（引用 ADR-0028）。
- Update `.scratch/local-app-matcher-v2/spec.md` header status from `Draft` to `Implemented（见 docs/adr/0028-inverted-index-and-boundary-safe-local-app-matching.md）`.

### 3. Run All Repository Verification Gates

1. `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings`
2. `cargo test --manifest-path src-tauri/Cargo.toml`
3. `npx tsc --noEmit`
4. `npx vitest run`
5. `npx vite build --config vite.demo.config.ts`

## Acceptance Criteria

- [ ] `matcher_eval_tests.rs` passes 100% against the real `catalog.json` with zero adversarial false positives and full side-by-side disambiguation (`VS Code` + `VSCodium`, `Notepad++` + `Notepad Next`, standard `7-Zip` rejected from `7-Zip-zstd`).
- [ ] `docs/adr/0028-inverted-index-and-boundary-safe-local-app-matching.md` and `CONTEXT.md` §35 are concise, present-tense, and aligned with domain terminology.
- [ ] All 5 verification gates (`cargo clippy`, `cargo test`, `npx tsc --noEmit`, `npx vitest run`, `npx vite build --config vite.demo.config.ts`) exit 0 with zero warnings.
