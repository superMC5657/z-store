# Issue 01: Path/Icon Resolver Fixes, Unicode `.lnk` Parser, Auxiliary Binary Filtering, 2-Segment SemVer Coercion & Seed Identifier Hygiene

Status: resolved
Blocked by: none

## Summary

Fix all deterministic low-level path, shortcut, executable selection, version comparison, and polluted catalog identifier bugs before rebuilding the higher-level discovery and matching stages:

1. **`clean_display_icon` & `.lnk` DisplayIcon Chaining (`scanner/display_icon.rs`, `scanner/executable.rs`)**: Strip outer quotes *before* stripping trailing `,N`/`,-N` icon resource indices so `"C:\Program Files\App\app.exe,0"` resolves cleanly; when `DisplayIcon` points to a `.lnk` shortcut, resolve its target `.exe` via `resolve_lnk_target` so PE version detection works.
2. **Unicode & Chinese Path `.lnk` Resolution (`scanner/lnk_target.rs`, `Cargo.toml`)**: Parse MS-SHLLINK `LocalBasePathUnicode` + `CommonPathSuffixUnicode` (UTF-16LE when `LinkInfoHeaderSize >= 0x24`), `StringData` (`HasName` / `HasRelativePath` / `HasWorkingDir`), Win32 `CP_ACP` decoding for legacy ANSI `LocalBasePath` (supporting GBK on Chinese Windows), and UTF-16LE heuristic fallback.
3. **Component-Aware Cache/Helper Filtering & Squirrel `app-*` Directory Resolution (`scanner/display_icon.rs`)**: Replace whole-path substring `contains("temp" | "unins" | "installer" | "bundle")` with path-component cache checks + auxiliary binary stem checks (excluding `Update.exe`, `updater.exe`, `squirrel.exe`, `elevate.exe`, `crashpad_handler.exe`, `createdump.exe`, while **allowing** legitimate apps like `Bulk-Crap-Uninstaller.exe` when declared in `config.target_executables`); prioritize newest Squirrel `app-<ver>` subdirectories and restrict root Step 4 fallback to sole non-auxiliary `.exe` or stem-matching `.exe`.
4. **2-Segment vs 3-Segment SemVer Update Comparison (`commands/updates_check.rs`)**: Normalize pure-numeric 2-segment versions (`major.minor`, optional `-prerelease`) to `major.minor.0` inside `is_version_newer` so apps like `Notepad Next` (`v0.15` vs PE `0.15.0`) and `Playnite` (`10.37` vs PE `10.37.0`) accurately detect updates without breaking non-SemVer composite tag rules.
5. **Installer-Asset Identifier Sanitization & Seed `catalog.json` Cleanup (`scanner/types.rs`, `catalog.json`, `config.rs`)**: Add runtime `is_installer_asset_identifier` filtering + always append `exe_candidates(&cat.repo)` / `exe_candidates(&cat.name)` in `ScanConfig::from(&CatalogItem)` (even when `identifiers.windows` is non-empty); clean the 43 polluted installer-filename `identifiers.windows` entries in `catalog.json` and enforce this invariant in `config.rs::embedded_seed_catalog_matches_runtime_schema`.

## Scope

- Allowed to modify:
  - `src-tauri/Cargo.toml` (only if adding `"Win32_Globalization"` to `windows-sys` features for `MultiByteToWideChar`)
  - `src-tauri/src/scanner/display_icon.rs`
  - `src-tauri/src/scanner/lnk_target.rs`
  - `src-tauri/src/scanner/executable.rs` (only `.lnk` DisplayIcon target chaining in `resolve_executable_path` and updated `is_installer_or_cache_path` call sites)
  - `src-tauri/src/scanner/types.rs`
  - `src-tauri/src/scanner/tests.rs`
  - `src-tauri/src/commands/updates_check.rs`
  - `src-tauri/src/commands/tests.rs` (for `is_version_newer` tests)
  - `src-tauri/src/config.rs` (extend `embedded_seed_catalog_matches_runtime_schema`)
  - `catalog.json` (clean up installer-asset `identifiers.windows` entries)
- Do not modify:
  - `src/*` (frontend files)
  - `src-tauri/src/scanner/matcher.rs` (belongs to Issue 03, except if adapting to a helper signature from `types.rs`)
  - `src-tauri/src/scanner/registry.rs`, `src-tauri/src/commands/installer_query.rs` (belong to Issue 02)

## Implementation Details

### 1. Fix `clean_display_icon` & `.lnk` Chaining (`src-tauri/src/scanner/display_icon.rs` & `executable.rs`)

- In `AppScanner::clean_display_icon(raw: &str)`:
  - Step A: Trim whitespace; if the string starts with `'"'`, extract up to the matching closing `'"'` (note: handle both `"C:\App\app.exe",0` where `,0` is after the second quote AND `"C:\App\app.exe,0"` where `,0` is inside the quotes!). Specifically:
    1. First strip trailing `,[-0-9]+` if it appears *outside* quotes;
    2. Unwrap outer `"` quotes;
    3. Strip trailing `,[-0-9]+` *again* if it appeared inside the quotes.
- In `AppScanner::resolve_executable_path` (`executable.rs` around line 350):
  - When `icon_path` has extension `.lnk` and `icon_path.is_file()`: attempt `Self::resolve_lnk_target(&icon_path)` first; if that returns a valid non-auxiliary `.exe` file on disk, return the resolved `.exe` path (enabling PE version reading), otherwise fall back to returning `icon_path` if allowed.

### 2. Upgrade `.lnk` Parser for UTF-16LE & Chinese Paths (`src-tauri/src/scanner/lnk_target.rs`)

- Keep pure cross-platform parsing so synthetic byte-buffer unit tests run on both Windows and Linux CI:
  1. **Header & `LinkTargetIDList`**: Unchanged (`flags & 0x01` skips `2 + id_list_size`).
  2. **`LinkInfo` (`flags & 0x02`)**:
     - Read `link_info_size` (`+0`) and `link_info_header_size` (`+4`).
     - **Unicode fast path (`link_info_header_size >= 0x24`)**: Read `local_base_path_offset_unicode` (`+28`) and `common_path_suffix_offset_unicode` (`+32`). Decode null-terminated UTF-16LE slices within `link_info` bounds via `String::from_utf16_lossy`, join base + suffix if non-empty, and return `Some(pb)` if `pb.is_file()`.
     - **ANSI fallback (`local_base_path_offset` at `+16` + `common_path_suffix_offset` at `+24`)**: Try `std::str::from_utf8` first; on `Err` under `#[cfg(target_os = "windows")]`, decode ANSI bytes via `MultiByteToWideChar(CP_ACP, 0, ...)` so GBK/Shift-JIS/Big5 paths resolve accurately.
  3. **`StringData` (`HasName = 0x04`, `HasRelativePath = 0x08`, `HasWorkingDir = 0x10`, `IsUnicode = 0x80`)**:
     - Advance cursor past `LinkInfo` (`link_info_offset + link_info_size` when `flags & 0x02 != 0`, else `link_info_offset`).
     - Read counted strings in MS-SHLLINK spec order (`NameString`, `RelativePath`, `WorkingDir`): `u16` character count (`count * 2` bytes UTF-16LE when `flags & 0x80 != 0`, else `count` bytes ANSI).
     - If `RelativePath` is present, resolve against `WorkingDir` (if non-empty) and `lnk_path.parent()`, returning `Some(pb)` when the joined/canonicalized path `.is_file()`.
  4. **Heuristic Fallback**:
     - Scan both UTF-16LE (`[drive_letter, 0, b':', 0, b'\\', 0, ...]`) and ASCII (`X:\...`) for `.exe` paths, allowing non-ASCII Unicode codepoints (`>= 0x80`, excluding control chars and `<>:"|?*`) in the UTF-16LE scanner.

### 3. Component-Based Cache/Auxiliary Path Rules & Squirrel Support (`src-tauri/src/scanner/display_icon.rs`)

- Introduce:
  - `pub fn is_cache_or_temp_directory(p: &Path) -> bool`: Inspect normalized path components (not substring of whole path!). Return `true` only when a directory component equals `"temp"`, `"tmp"`, `"package cache"`, `"squirreltemp"`, `"$plugindir"`, starts with `"~nsu"`, or path ends with/contains component pair `windows\installer`. (`C:\Users\tempuser\AppData\Local\Programs\...` and `C:\Program Files\Core Temp\Core Temp.exe` MUST return `false`!)
  - `pub fn is_auxiliary_executable_name(file_name: &str) -> bool`: Check lowercase filename (`file_name` only, not parent directories):
    - Exact matches: `"update.exe"`, `"updater.exe"`, `"squirrel.exe"`, `"elevate.exe"`, `"crashpad_handler.exe"`, `"crashreporter.exe"`, `"crash_reporter.exe"`, `"createdump.exe"`, `"unins000.exe"`, `"unins001.exe"`, `"uninstall.exe"`, `"uninst.exe"`.
    - Prefix/substring patterns on stem: starts with `"unins"` / `"uninstall"` or contains `"setup"` / `"installer"` (e.g. `foo-setup.exe`, `foo_installer.exe`).
  - Keep `pub fn is_installer_or_cache_path(p: &Path) -> bool` combining `is_cache_or_temp_directory(p)` and (when `p` has a filename ending in `.exe`/`.msi`) `is_auxiliary_executable_name`, while providing `is_valid_app_executable(p: &Path, allowed_targets: &[String]) -> bool` that **exempts** a binary from `is_auxiliary_executable_name` if its lowercase filename explicitly matches `allowed_targets` (so `Bulk-Crap-Uninstaller.exe` is accepted when `allowed_targets` contains `"bulk-crap-uninstaller.exe"`!).
- In `find_exe_in_directory(dir: &Path, config: &ScanConfig)`:
  - Step 1 & 2 (`dir` and `search_subdirs` against `config.target_executables`): check `!is_cache_or_temp_directory(dir)` and `is_valid_app_executable(&candidate, &config.target_executables)`.
  - Step 3 (1-level subdirectories): collect subdirectories, prioritizing Squirrel `app-*` directories sorted descending (via SemVer/lexicographical version comparison so `app-3.6.10` beats `app-3.5.0`) before other subdirectories.
  - Step 4 (root `.exe` fallback when `target_executables` didn't match): collect all root `.exe` files passing `!is_installer_or_cache_path(&p)`.
    - If exactly **1** candidate exists in `dir`, return it;
    - If **multiple** `.exe` files exist in `dir`, only return one whose stem normalized (`normalize_fs_token`) matches one of `config.install_dirs` or `config.target_executables`; otherwise return `None` (preventing arbitrary helper `.exe` selection in multi-binary folders).

### 4. Coerce 2-Segment Numeric Versions in `is_version_newer` (`src-tauri/src/commands/updates_check.rs`)

- In `is_version_newer`'s internal `normalize(s: &str)` (or SemVer parse helper):
  - After stripping leading `v`/`V` and trimming: split off optional `-prerelease` / `+build` suffix at the first `-` or `+` (only when the prefix before `-` consists purely of ASCII digits and `.`, so composite tags like `v26.02-v1.5.7-R2` where the `-` part is `v1.5.7-R2`? Wait: check existing unit tests in `commands/tests.rs` for `v26.02-v1.5.7-R2`!).
  - **CRITICAL**: Check `src-tauri/src/commands/tests.rs` for existing `is_version_newer` tests! Notice `v26.02-v1.5.7-R2` has `26.02` before `-` AND `-v1.5.7-R2` IS valid SemVer prerelease syntax if `26.02` were turned into `26.02.0` (`02` has leading zero so `semver::Version::parse` rejects leading zeros anyway, OR `26.2-v1.5.7-R2` would parse!). To avoid turning composite tags with `-` into SemVer, **ONLY coerce 2-segment versions that have NO `-`/`+` suffix** (`parts.len() == 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0')))` → `format!("{}.{}.0", parts[0], parts[1])`)!
  - Verify:
    - `is_version_newer("0.15.0", "v0.16")` → `"0.15.0"` vs `"0.16.0"` → `true`!
    - `is_version_newer("0.15.0", "v0.15")` → `"0.15.0"` vs `"0.15.0"` → `false`!
    - `is_version_newer("10.37.0", "10.38")` → `true`!
    - `is_version_newer("1.0.0", "v26.02-v1.5.7-R2")` → still `false` (composite tag untouched)!

### 5. Runtime Identifier Sanitization & `catalog.json` Seed Cleanup (`types.rs`, `catalog.json`, `config.rs`)

- Add `pub fn is_installer_asset_identifier(ident: &str, repo: &str, app_name: &str) -> bool` in `scanner/types.rs`:
  - Returns `true` when a `.exe` identifier looks like a distribution installer/archive wrapper rather than an installed binary:
    - Ends with `.paf.exe`, `.msi`, `.zip`, `.7z`; OR
    - Contains word/token `setup` or `installer` (case-insensitive) when neither `repo` nor `app_name` contains `setup` or `installer`; OR
    - Contains embedded version numbers (`\d+\.\d+`) or architecture tags (`-x64`, `-x86`, `_x64`, `-win64`, `-win32`, `-arm64`, `-aarch64`, `-mingw`) when `repo` itself does not contain them.
- Add `CatalogItem::get_clean_native_identifiers(&self) -> Vec<String>` (or sanitize inside `ScanConfig::from(&CatalogItem)`):
  - Filter `get_identifiers` through `!is_installer_asset_identifier(id, &cat.repo, &cat.name)`.
  - In `ScanConfig::from(&CatalogItem)` on Windows: start with cleaned `identifiers.windows`, then **always** append deduplicated `exe_candidates(&cat.repo)` and `exe_candidates(&cat.name)` (when `cat.name` is ASCII/identifier-shaped) so fallback candidates are never lost!
- Clean the 43 polluted `identifiers.windows` values in root `catalog.json`:
  - Keep `"Bulk-Crap-Uninstaller.exe"` (legitimate binary name matching its repo `Bulk-Crap-Uninstaller`), and replace setup/installer/arch-versioned asset names with accurate installed `.exe` names (e.g. `notepad++.exe`, `GitHubDesktop.exe`, `Pulsar.exe`, `Hyper.exe`, `Wave.exe`, `rio.exe`, `Mockoon.exe`, `Pinta.exe`, `OpenToonz.exe`, `shotcut.exe`, `SubtitleEdit.exe`, `SoundSwitch.exe`, `brave.exe`, `Mailspring.exe`, `Session.exe`, `Hiddify.exe`, `Moonlight.exe`, `Zulip.exe`, `freeplane.exe`, `Anytype.exe`, `OpenBoard.exe`, `heidisql.exe`, `DB Browser for SQLite.exe`, `VeraCrypt.exe`, `ueli.exe`, `Ditto.exe`, `WinCompose.exe`, `prismlauncher.exe`, `OneKeePass.exe`, or `[]` where uncertain so `exe_candidates` derives cleanly).
- In `src-tauri/src/config.rs::embedded_seed_catalog_matches_runtime_schema`:
  - Assert that for every item in `catalog.json`, no entry in `identifiers["windows"]` triggers `crate::scanner::types::is_installer_asset_identifier(v, &item.repo, &item.name)`.

## Acceptance Criteria

- [ ] `clean_display_icon` unit tests cover `"C:\Program Files\App\app.exe,0"` (comma inside quotes), `"C:\Program Files\App\app.exe",0` (comma outside quotes), `,-101`, and `.lnk` paths.
- [ ] `lnk_target.rs` synthetic fixture tests verify UTF-16LE `LocalBasePathUnicode` containing Chinese characters (e.g. `目录_测试\目标程序.exe`), `StringData` `RelativePath` + `WorkingDir` resolution, and UTF-16LE heuristic fallback all resolve on disk without panicking on truncated buffers.
- [ ] `display_icon.rs` unit tests verify:
  - `C:\Users\tempuser\AppData\Local\Programs\Motrix\Motrix.exe` and `C:\Program Files\Core Temp\Core Temp.exe` are **not** rejected as cache/installer paths;
  - `Bulk-Crap-Uninstaller.exe` is accepted when present in `config.target_executables`, while `unins000.exe`, `Update.exe`, `crashpad_handler.exe`, and `elevate.exe` are rejected;
  - Squirrel layout (`root/Update.exe` + `root/app-3.5.0/GitHubDesktop.exe` + `root/app-3.6.10/GitHubDesktop.exe`) resolves to `root/app-3.6.10/GitHubDesktop.exe`;
  - Multi-binary directory with unrelated `foo.exe` and `bar.exe` returns `None` instead of blindly picking the first `.exe`.
- [ ] `updates_check.rs` unit tests verify `is_version_newer("0.15.0", "v0.16") == true`, `is_version_newer("0.15.0", "v0.15") == false`, `is_version_newer("10.37.0", "10.38") == true`, and composite non-SemVer tags (`"v26.02-v1.5.7-R2"`) retain existing behavior.
- [ ] `embedded_seed_catalog_matches_runtime_schema` passes with zero installer-asset filenames in `catalog.json`, and `ScanConfig::from(&CatalogItem)` preserves `exe_candidates(&cat.repo)` even when `identifiers.windows` is non-empty.
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml` pass cleanly.
