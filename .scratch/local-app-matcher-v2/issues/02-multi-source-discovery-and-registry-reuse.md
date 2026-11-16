# Issue 02: Multi-Source System Discovery (Windows Scoop/Shortcuts/Registry Merge, Linux Real Package Versions, macOS `.app` Bundles) & Registry Snapshot Reuse

Status: ready-for-agent
Blocked by: 01

## Summary

Upgrade Stage 1 (`AppScanner::scan_system_apps`) across Windows, Linux, and macOS and eliminate redundant synchronous registry scans in `get_installed_apps`:

1. **Enrich `ScannedRawApp` (`scanner/types.rs`)**: Add backwards-compatible optional fields `registry_key: Option<String>` and `source_kind: Option<String>` (`"registry"`, `"scoop"`, `"shortcut"`, `"desktop"`, `"appimage"`, `"macos_app"`).
2. **Windows Registry Field Merging, `UninstallString` Directory Inference & WiX Fix (`scanner/registry.rs`)**:
   - Merge metadata across `HKLM` / `Wow6432Node` / `HKCU` when `(lower_name, display_version)` collides instead of dropping later hives;
   - Record non-GUID `key_name` into `registry_key`;
   - Infer `install_location` from `UninstallString` parent directory when `InstallLocation` is absent (fixing NSIS apps installed in custom directories);
   - Fix WiX `component_locations` backfill to use `BTreeMap` + strict normalized name / word-boundary matching instead of raw `contains`.
3. **Windows Supplementary Discovery — Scoop & Standalone Start Menu Shortcuts (`scanner/registry.rs` / `scanner/executable.rs`)**:
   - Scan Scoop installations (`$SCOOP/apps/*/current/manifest.json` and `%USERPROFILE%/scoop/apps/*/current/manifest.json`);
   - Scan Start Menu `.lnk` shortcuts (`%APPDATA%\...\Programs` and `%ProgramData%\...\Programs`) to discover green/portable apps that lack Uninstall registry entries, deduplicating by normalized target `.exe` / install directory so Registry/Scoop apps are never duplicated.
4. **Linux `.desktop` Version Bug Fix & AppImage Discovery (`scanner/executable.rs`)**:
   - Stop reading Freedesktop Desktop Entry spec `Version=` (e.g. `1.0`) into `display_version`; read `X-AppImage-Version=` instead, and resolve real installed package versions for system binaries via `dpkg-query` / `rpm -qf` (stripping epoch `N:` and distro revision `-1ubuntu1` suffixes);
   - Populate `registry_key` from `.desktop` stem (e.g. `org.videolan.VLC`) and supplement standalone `*.AppImage` files in `~/Applications` & `~/AppImages`.
5. **macOS Application Bundle Scanner (`scanner/macos.rs`, `scanner/mod.rs`)**:
   - Scan `/Applications` and `~/Applications` `*.app` bundles by parsing `Contents/Info.plist` (pure cross-platform XML plist parser + macOS `/usr/bin/plutil -convert json -o -` fallback for binary plists).
6. **Eliminate Synchronous `O(K × R)` Registry Re-Enumeration in `get_installed_apps` (`commands/installer_query.rs`)**:
   - Reuse the cached `registry_entries` slice in `get_installed_apps` to backfill `installed_at` via `find_registry_entry_for_path` + `detect_path_installed_at` instead of calling `resolve_app_installed_at` per `system_import` app on the main thread.

## Scope

- Allowed to modify:
  - `src-tauri/src/scanner/types.rs`
  - `src-tauri/src/scanner/mod.rs`
  - `src-tauri/src/scanner/registry.rs`
  - `src-tauri/src/scanner/executable.rs`
  - `src-tauri/src/scanner/macos.rs` (new file)
  - `src-tauri/src/scanner/version.rs` (if adding `detect_installed_at_from_entries` helper alongside `detect_installed_version`)
  - `src-tauri/src/scanner/tests.rs`
  - `src-tauri/src/commands/installer_query.rs`
- Do not modify:
  - `src/*` (frontend files)
  - `src-tauri/src/scanner/matcher.rs` (only add default `None` fields in test literals if needed; scoring changes belong to Issue 03)

## Implementation Details

### 1. Extend `ScannedRawApp` (`src-tauri/src/scanner/types.rs`)

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScannedRawApp {
    pub display_name: String,
    pub display_version: String,
    pub publisher: Option<String>,
    pub install_location: Option<String>,
    pub display_icon: Option<String>,
    pub uninstall_string: Option<String>,
    #[serde(default)]
    pub installed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
}
```

### 2. Windows Registry Enhancements + Scoop & Start Menu Discovery (`scanner/registry.rs`)

- **Field-merging deduplication**:
  - Replace `seen_names: HashSet<String>` with `index_by_key: HashMap<String, usize>` indexing into `scanned_list`. When `dedup_key = format!("{}::{}", lower_name, display_version)` already exists, fill any `None` fields (`publisher`, `install_location`, `display_icon`, `uninstall_string`, `installed_at`, `registry_key`) on the existing `ScannedRawApp` from the new hive entry.
- **`registry_key` capture**:
  - Trim `key_name`; if it is not a bare `{...}` GUID (note: `{GUID}_is1` is GUID-based Inno Setup so skip pure `{...}` and `{...}_is1`, whereas `VSCode_is1` or `ShareX_is1` or `VideoLAN.VLC` is informative — strip trailing `_is1` and store as `Some(...)`).
- **`UninstallString` directory inference (`infer_install_dir_from_uninstall_string(raw: &str) -> Option<String>`)**:
  - Pure testable helper: reuse `crate::installer::executor_uninstall::parse_uninstaller_command` (or extract executable token before ` /` / ` -`), reject `msiexec`, `rundll32`, `cmd`, `powershell`, and paths inside `Windows\System32`, `Windows\SysWOW64`, `Windows\Installer`, or `is_cache_or_temp_directory`. If the executable's `.parent()` exists on disk as a directory (and isn't a drive root like `C:\` or top-level `C:\Program Files`), return `Some(parent_str)`.
- **WiX `component_locations` fix**:
  - Store `component_locations` in a `BTreeMap<String, String>` (deterministic order). Only backfill `app.install_location` when `comp_name == app_lower` OR (`comp_name.len() >= 6` && token-boundary prefix match, e.g. `app_lower.starts_with(&format!("{comp_name} "))` or `comp_name.starts_with(&format!("{app_lower} "))`). Extract a pure helper `match_wix_component_location(app_name: &str, components: &BTreeMap<String, String>) -> Option<String>` for cross-platform unit tests.
- **Scoop scanner (`scan_scoop_apps_in_dir(apps_dir: &Path) -> Vec<ScannedRawApp>`)**:
  - Pure directory-based function (unit-testable with `tempdir` on any OS!):
  - Check `$SCOOP/apps` and `%USERPROFILE%/scoop/apps`. Skip `"scoop"` itself.
  - For each `<apps_dir>/<slug>/current/manifest.json`: parse JSON (`version`, `homepage`, `bin`, `shortcuts`), derive `display_name` from first shortcut label `[target, label]` if available else `<slug>`, resolve primary `.exe` in `<current>` (`display_icon`), set `install_location = Some(current_dir)`, `registry_key = Some(slug)`, `source_kind = Some("scoop")`, `installed_at = detect_path_installed_at(current_dir)`.
- **Standalone Start Menu `.lnk` supplement (`scan_unregistered_shortcuts`)**:
  - Enumerate `.lnk` files in Start Menu `Programs` roots (root + 1-level subdirs), skipping shortcuts whose filename contains `uninstall`, `卸载`, `readme`, `help`, `website`, `manual`.
  - Resolve target `.exe` via `resolve_lnk_target`; skip if target or its parent directory is already covered by any Registry or Scoop `ScannedRawApp` (normalized path prefix/equality check).
  - Read `display_version` via `read_exe_version`, `display_name` from `.lnk` file stem, `install_location = target.parent()`, `display_icon = target`, `source_kind = Some("shortcut")`.

### 3. Linux `.desktop` Real Version & AppImage Supplement (`scanner/executable.rs`)

- Extract pure helper `parse_desktop_entry_content(stem: &str, content: &str) -> Option<ParsedDesktopEntry>` (unit-testable on Windows & Linux!):
  - Parse only within `[Desktop Entry]` section (stop or ignore `[Desktop Action ...]`, so action `Name=` / `Exec=` lines never overwrite or pollute the main entry!).
  - **Ignore `Version=` completely** (Freedesktop spec version `1.0`).
  - Read `X-AppImage-Version=` into `display_version` if present.
  - Set `registry_key = Some(stem.to_string())`, `source_kind = Some("desktop")`.
- Add `clean_distro_package_version(raw: &str) -> String` (pure function, unit-tested):
  - Strip leading epoch (`"1:3.0.21-1ubuntu2"` → `"3.0.21-1ubuntu2"`), then strip distro packaging revision (`-1ubuntu2`, `-2deb12u1`, `-1.fc40`, `+dfsg...`) to yield clean upstream version `"3.0.21"`.
- On `#[cfg(target_os = "linux")]` in `scan_linux_desktop()`:
  - For entries with empty `display_version` and a resolved `install_location` under `/usr/`, `/bin/`, or `/opt/`: batch-resolve owning Debian/RPM package versions (e.g. single `dpkg-query -S <paths...>` + `dpkg-query -W -f='${Package}\t${Version}\n' <pkgs...>`, or `rpm -qf --qf '%{VERSION}\n'`, capped with a short timeout/bounded batch so scanning stays sub-second).
  - Also scan `~/Applications` and `~/AppImages` for executable `*.AppImage` files not already represented by `install_location` in `out`, extracting name/version from `AppName-1.2.3-x86_64.AppImage` stem when present (`source_kind = Some("appimage")`).

### 4. macOS `.app` Bundle Scanner (`src-tauri/src/scanner/macos.rs` & `scanner/mod.rs`)

- Create `src-tauri/src/scanner/macos.rs` (compile pure plist XML parser under `#[cfg(any(target_os = "macos", test))]` so tests run on Windows/Linux too!):
  - Pure helper `parse_info_plist_xml(xml: &str) -> Option<MacBundleMeta>`: extracts `<key>CFBundleDisplayName</key>`, `CFBundleName`, `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`, `CFBundleExecutable`.
  - On `#[cfg(target_os = "macos")]`: `AppScanner::scan_macos_apps()` scans `/Applications` and `~/Applications` (depth 1 `*.app` dirs); reads `Contents/Info.plist` (if binary plist `bplist00`, converts via `/usr/bin/plutil -convert xml1 -o - <path>`), resolves `Contents/MacOS/<CFBundleExecutable>`, sets `install_location = Some(app_bundle_path)`, `display_icon = resolved_binary.or(Some(app_bundle_path))`, `registry_key = bundle_id`, `source_kind = Some("macos_app")`, `installed_at = detect_path_installed_at(&app_bundle_path)`.
  - Wire `#[cfg(target_os = "macos")] { Self::scan_macos_apps() }` in `scanner/mod.rs::scan_system_apps()`.

### 5. Reuse `registry_entries` for `installed_at` in `get_installed_apps` (`commands/installer_query.rs`)

- Add `AppScanner::detect_installed_at_from_entries(entries: &[ScannedRawApp], install_path: &str) -> Option<i64>` in `scanner/version.rs`:
  - Uses `Self::find_registry_entry_for_path(entries, install_path)` to read `entry.installed_at`, falling back to `Self::detect_path_installed_at(install_path)`.
- In `src-tauri/src/commands/installer_query.rs` (lines 58–88):
  - For `app.install_method == "system_import"`, reuse the lazily initialized `registry_entries` (already loaded once at line 61) via `detect_installed_at_from_entries` when `cfg!(target_os = "windows")`, and `detect_path_installed_at(&app.install_path)` on non-Windows — completely removing the per-app `resolve_app_installed_at` loop that re-scanned 3 registry hives `K` times synchronously!

## Acceptance Criteria

- [ ] Unit tests verify `parse_desktop_entry_content` ignores `Version=1.0` and `[Desktop Action ...]` blocks, extracts `X-AppImage-Version=2.4.1`, and `clean_distro_package_version("1:3.0.21-1build2") == "3.0.21"`.
- [ ] Unit tests verify `parse_info_plist_xml` accurately extracts `CFBundleDisplayName`, `CFBundleIdentifier`, `CFBundleShortVersionString`, and `CFBundleExecutable` from realistic macOS `Info.plist` XML fixtures.
- [ ] Unit tests verify `scan_scoop_apps_in_dir` on a `tempdir` Scoop layout (`apps/ripgrep/current/manifest.json` + binary) produces a `ScannedRawApp` with `source_kind = Some("scoop")`, accurate version, and executable path.
- [ ] Unit tests verify `match_wix_component_location` never cross-contaminates unrelated apps via short component names like `"Core"` or `"SDK"`, and `infer_install_dir_from_uninstall_string` extracts `"D:\\Apps\\PicGo"` from `"\"D:\\Apps\\PicGo\\Uninstall PicGo.exe\" /allusers"` while rejecting `MsiExec.exe /X{...}`.
- [ ] Unit tests verify `detect_installed_at_from_entries` resolves `installed_at` from cached `ScannedRawApp` entries without touching the Windows Registry.
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml` pass cleanly.
