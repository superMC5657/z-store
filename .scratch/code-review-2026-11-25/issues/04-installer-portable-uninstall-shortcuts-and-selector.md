# Issue 04: Installer — Portable Uninstall, Desktop Shortcuts, Asset Selector & Registry Matching

Status: resolved
Severity: High (F-03 [High], F-04 [High], F-06 [High], Test Gap #1)
Fix Track: Track 2 (`fix-rust-installer`)
Findings: F-03, F-04, F-06, Test Gap #1

## Findings

### F-03 [High]: Portable uninstall fails on `portable_tarball`, orphans custom `portable_dir`, and mismatches/traverses desktop `.lnk` shortcuts
- **Locations**:
  - `src-tauri/src/commands/installer_uninstall.rs:68-93, 139-145, 176-188`
  - `src-tauri/src/installer/executor_portable.rs:210, 402`
  - `src-tauri/src/installer/paths.rs:168-174`
- **Trigger**:
  1. `uninstall_app:139` checks only `if app.install_method == "portable_zip"`. Any `"portable_tarball"` app falls into the system-uninstaller `else` branch and fails with `"未在系统中检测到 ... 的官方卸载程序"`.
  2. `uninstall_app:142` hardcodes `dirs_or_fallback(&app.app_id)` instead of loading the configured `portable_dir` setting. For apps installed under a custom `portable_dir`, `is_owned_portable_dir` returns `false`, so `cleanup_portable_path:53-60` deletes only the single `.exe`, leaving sibling DLLs/data directories orphaned.
  3. Portable install creates `Desktop/{sanitize_shortcut_name(app_id)}.lnk`, `uninstall_app:188` removes only `sanitize_shortcut_name(app_name).lnk` (orphaning portable shortcuts whenever `app_name != app_id`), and `find_desktop_shortcut` (`paths.rs:168-174`) joins raw unsanitized `app_name`/`app_id` (missing sanitized portable `.lnk` files and permitting `..` path traversal).
- **Impact**: Portable tarball apps cannot be uninstalled; custom `portable_dir` uninstalls leave orphaned directories and Desktop `.lnk` files; `find_desktop_shortcut` allows relative path traversal outside Desktop and breaks launch fallback.

### F-04 [High]: `classify_asset` bare `contains("install")` misclassifies non-Windows assets as `SetupExe`
- **Locations**:
  - `src-tauri/src/installer/selector.rs:28-35`
- **Trigger**: Any release asset containing `"install"` without `.exe` — e.g., `App-macos-installer.dmg`, `app-linux-installer.AppImage`, `foo-install.deb`, `tool-installer.zip`, `install.sh` — matches `|| name_lower.contains("install")` (line 32) before OS-specific extension checks (lines 36-61).
- **Impact**: Misclassified as `(AssetKind::SetupExe, "windows", arch)`. On macOS/Linux, `select_best_asset` drops valid native installers; on Windows, `SetupExe` (+15) outranks `PortableZip` (+10) so ZStore selects and tries to execute a `.dmg`/`.deb`/`.zip`/`.sh` as a Windows `.exe`; `platforms_from_assets` derives wrong OS support.

### F-06 [High]: Bidirectional substring match in `uninstall_display_name_matches` can invoke an unrelated Windows uninstaller
- **Locations**:
  - `src-tauri/src/installer/paths.rs:292-305, 366, 384`
- **Trigger**: Uninstalling an app without a saved `uninstall_command` when `app_name` is short or a substring of another installed program's registry `DisplayName` (or vice versa): `disp_lower.contains(&name_lower) || name_lower.contains(&disp_lower)` (e.g., `"Go"` matches `"Google Chrome"`, `"Git"` matches `"Logitech G HUB"`, `"fd"` matches `"PDF..."`).
- **Impact**: `resolve_uninstaller_command_in` returns an unrelated program's `UninstallString`, and `execute_uninstallation` invokes that unrelated uninstaller.

### Test Gap #1: Broken security regression test inspects wrong file
- **Locations**:
  - `src-tauri/src/installer/tests.rs:373-381`
- **Issue**: `test_uninstall_unix_path_never_shells_command_string` reads `include_str!("executor.rs")`, whereas Unix uninstall logic moved to `executor_uninstall.rs` — the test trivially passes even if `sh -c` were reintroduced.

## Acceptance Criteria

- [ ] `uninstall_app` handles both `"portable_zip"` and `"portable_tarball"`, resolves custom `portable_dir` (plus default fallback) with strict path-containment validation before directory deletion, and removes desktop shortcuts for both `sanitize_shortcut_name(app_name)` and `sanitize_shortcut_name(app_id)`.
- [ ] `find_desktop_shortcut` sanitizes shortcut names and verifies canonical parent containment inside Desktop (preventing `..` traversal while locating sanitized portable `.lnk` files).
- [ ] `classify_asset` requires `name_lower.ends_with(".exe")` for `AssetKind::SetupExe` so `.dmg`/`.deb`/`.rpm`/`.AppImage`/`.zip`/`.sh` containing `"install"` classify by their true extension/OS.
- [ ] `resolve_uninstaller_command_in` matches `install_path` against registry `InstallLocation`/`DisplayIcon`/`UninstallString` parent directory first; `uninstall_display_name_matches` requires exact equality or strict word-boundary match with safe minimum length (no bidirectional raw `.contains()`).
- [ ] `test_uninstall_unix_path_never_shells_command_string` inspects `executor_uninstall.rs`.
- [ ] Regression tests cover F-03, F-04, F-06, and Test Gap #1; `cargo test` and `cargo clippy --all-targets` pass.

## Comments

- **Resolved in `61556c2`** (Track 2 `fix-rust-installer`: `fix(installer,scanner): atomic upgrades, safe uninstall, asset selector, and scanner matching`).
- Handled both `"portable_zip"` and `"portable_tarball"` in `uninstall_app`, resolved custom `portable_dir` with containment checks, sanitized/canonical-checked `find_desktop_shortcut` and cleaned both `app_name` and `app_id` `.lnk` files (F-03); required `.exe` suffix for `AssetKind::SetupExe` in `installer/selector.rs` (F-04); hardened registry uninstaller lookup and word-boundary display-name fallback in `installer/paths.rs` (F-06); pointed `test_uninstall_unix_path_never_shells_command_string` to `executor_uninstall.rs` in `installer/tests.rs` (Test Gap #1).
- **Integrated verification on `main`**: `cargo test` 875 passed / 3 ignored, `cargo clippy --all-targets` 0 warnings.
