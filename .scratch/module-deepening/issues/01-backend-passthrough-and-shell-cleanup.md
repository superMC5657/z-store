# Issue 01: Backend Pure Pass-through Facades, `#[path]` Shells & `InstallerEngine` Cleanup

Status: done
Blocked by: none

## Summary

Eliminate pure pass-through modules and empty `#[path]` re-export shells in the Rust backend that fail the `codebase-design` deletion test (adding files, symbols, and indirection while hiding zero complexity):

1. **`commands/installer.rs` (43L)**: Five `#[tauri::command]` functions (`install_app`, `uninstall_app`, `unmanage_app`, `get_installed_apps`, `launch_app`) are 1:1 parameter pass-throughs forwarding directly to `installer_install`, `installer_uninstall`, and `installer_query`.
2. **Pure `#[path]` re-export shells**:
   - `commands/catalog.rs` (16L, re-exporting 5 `catalog_*.rs` files already re-exported in `commands/mod.rs`)
   - `commands/updates.rs` (7L, re-exporting `updates_check.rs` and `updates_rules.rs`)
   - `github/readme_variants.rs` (4L, re-exporting `readme_fetch.rs` and `readme_parse.rs`)
   - `installer/downloader.rs` (6L, re-exporting `downloader_http.rs` and `downloader_progress.rs`)
3. **`InstallerEngine` zero-sized wrapper (`installer/mod.rs`)**: Holds no state and no trait polymorphism; its 3 static methods (`classify_asset`, `download_with_progress`, `execute_installation`) strictly forward to `selector::classify_asset`, `downloader_http::download_with_progress`, and `executor::execute_installation`.
4. **`github/developer_endpoints.rs` (90L, 62L code)**: Contains only 4 constants and 4 tiny URL/tag helpers consumed inside `github/`.

## Scope

- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/commands/installer.rs`
- `src-tauri/src/commands/installer_install.rs`
- `src-tauri/src/commands/installer_uninstall.rs`
- `src-tauri/src/commands/installer_query.rs`
- `src-tauri/src/commands/catalog.rs`
- `src-tauri/src/commands/updates.rs`
- `src-tauri/src/commands/updates_check.rs`
- `src-tauri/src/installer/mod.rs`
- `src-tauri/src/installer/downloader.rs`
- `src-tauri/src/installer/downloader_http.rs`
- `src-tauri/src/installer/tests.rs`
- `src-tauri/src/commands/installer_download.rs`
- `src-tauri/src/github/mod.rs`
- `src-tauri/src/github/readme_variants.rs`
- `src-tauri/src/github/developer_endpoints.rs`
- `src-tauri/src/github/developer_profile.rs`
- `src-tauri/src/github/developer_starred.rs`
- `src-tauri/src/github/developer_starred_tests.rs`
- `src-tauri/src/github/affinity.rs`
- `src-tauri/src/github/readme_fetch.rs`
- `src-tauri/src/github/detail_assets.rs`
- `src-tauri/src/forge/provider.rs`

(Do NOT touch `src-tauri/src/commands/icons*.rs`, `src-tauri/src/github/icon_*.rs`, or `src-tauri/src/db/` — handled in Issue 04.)

## Implementation Details

### 1. Collapse `commands/installer.rs` pass-through wrapper
- Attach `#[tauri::command(rename_all = "camelCase")]` / `#[tauri::command]` directly onto the command functions in `installer_install.rs`, `installer_uninstall.rs`, and `installer_query.rs`, OR merge `installer.rs` + `installer_install.rs` + `installer_query.rs` + `installer_uninstall.rs` cleanly into a cohesive `commands/installer/` module without double-wrapping functions.
- Keep `crate::commands::get_installed_apps` (called by `commands/updates_check.rs` and `lib.rs` `generate_handler!`) resolvable at the same `commands::*` path (`commands/mod.rs` re-exports).

### 2. Remove empty `#[path]` re-export shells
- Remove `commands/catalog.rs`, `commands/updates.rs`, `github/readme_variants.rs`, and `installer/downloader.rs`.
- Declare their underlying modules directly in `commands/mod.rs`, `github/mod.rs`, and `installer/mod.rs` using `#[path = "..."]` or standard submodules, preserving all command names registered in `lib.rs`.

### 3. Dissolve `InstallerEngine`
- Remove `pub struct InstallerEngine;` from `src-tauri/src/installer/mod.rs` and its re-export in `commands/mod.rs`.
- Re-export `classify_asset` (from `selector`), `download_with_progress` (from `downloader_http`), and `execute_installation` (from `executor`) directly from `crate::installer`.
- Update callers (`commands/installer_install.rs`, `commands/installer_download.rs`, `forge/provider.rs`, `github/detail_assets.rs`, and `installer/tests.rs`) to call `crate::installer::classify_asset`, `download_with_progress`, and `execute_installation` directly.

### 4. Merge `github/developer_endpoints.rs`
- Move the 4 constants (`DEVELOPER_REPOS_PAGE_SIZE`, `GITHUB_STARRED_MAX_PAGE_SIZE`, `GITHUB_API_BASE`, `STARRED_RELEASE_ENRICH_LIMIT`) and 4 helpers (`dev_user_endpoint`, `dev_repos_endpoint`, `starred_release_endpoint`, `parse_release_tag`, `request_url`) into `github/mod.rs` or `github/developer_profile.rs` (and move its unit tests to `github/tests.rs` or `developer_starred_tests.rs`).
- Delete `src-tauri/src/github/developer_endpoints.rs`.

## Acceptance Criteria

- [ ] `commands/catalog.rs`, `commands/updates.rs`, `github/readme_variants.rs`, `installer/downloader.rs`, and `github/developer_endpoints.rs` are deleted; `InstallerEngine` is removed.
- [ ] `commands::installer` no longer duplicates signatures as single-line forwarders.
- [ ] All `tauri::generate_handler!` commands in `src-tauri/src/lib.rs` and `cmdAlignment.test.ts` remain 100% aligned (no IPC command rename).
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` pass with zero warnings.
