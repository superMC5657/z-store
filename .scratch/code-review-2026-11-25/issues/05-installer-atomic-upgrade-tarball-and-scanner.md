# Issue 05: Installer & Scanner — Atomic Upgrades, Tarball Stripping, Token Matching & Lock Hygiene

Status: resolved
Severity: High (F-09 [High], F-13 [Medium], F-16 [Medium], F-22A [Medium], Test Gaps #3 & #4)
Fix Track: Track 2 (`fix-rust-installer`)
Findings: F-09, F-13, F-16, F-22A, Test Gaps #3 & #4

## Findings

### F-09 [High]: Portable upgrade overwrites v1 files in-place and rollback deletes them (plus non-atomic macOS DMG replace)
- **Locations**:
  - `src-tauri/src/installer/executor_portable.rs:44-51, 135-160, 200-206, 387-398`
  - `src-tauri/src/installer/executor_macos.rs:221-241`
- **Trigger**: Upgrading an existing portable `.zip`/`.tar.*` app in `app_dir` when extraction fails midway (corrupt archive, disk full, or `DEFAULT_EXTRACT_LIMITS`). `ExtractTracker::write_file` truncates/overwrites v1 files directly via `File::create(outpath)` and records them in `self.written`; `rollback_extracted` then calls `remove_file` on every overwritten v1 path, destroying the working v1 installation. On macOS, `executor_macos.rs:222` removes `dest_app` before `cp -R` runs, losing the working `.app` if copy fails.
- **Impact**: Mid-upgrade failure permanently corrupts or deletes a previously working v1 installation.

### F-13 [Medium]: Unconditional `normals[1..]` strip-first-component corrupts flat / multi-root tarballs
- **Locations**:
  - `src-tauri/src/installer/executor_portable.rs:295-314`
- **Trigger**: Extracting a tarball with sibling top-level directories (e.g., `bin/app`, `lib/foo.so`, `bin/config`, `etc/config`). Line 313 unconditionally strips `normals[0]` for every multi-component path, flattening `bin/` and `lib/` into `app_dir` root and colliding `bin/config` with `etc/config`.
- **Impact**: Breaks relative library/resource layout and silently overwrites same-named files from distinct top-level directories.

### F-16 [Medium]: `scanner::executable::build_tokens` splits `owner/repo` on `/` and substring-matches unrelated Windows apps by `owner`
- **Locations**:
  - `src-tauri/src/scanner/executable.rs:126-131, 261-268, 1500-1508`
- **Trigger**: `build_tokens` splits `app_id` (`owner/repo`) on `['-', '/']`, inserting `owner` (e.g., `mozilla`, `jetbrains`, `adobe`, `oracle`) and generic segments (`server` from `code-server`) into `tokens`. `registry_scan` (line 264) and `resolve_app_installed_at` (line 1503) accept any registry `DisplayName` where `d_lower.contains(t)` (`t.len() >= 4`).
- **Impact**: `resolve_installed_app_path` and `scan_unmanaged` path repair bind unrelated installed software (e.g., `mozilla/pdf.js` → Mozilla Firefox, `org/code-server` → SQL Server) as the managed executable/timestamp (violates ADR-0028).

### F-22A [Medium]: `import_matched_apps` holds global SQLite `Mutex` across slow FS/registry probing and writes non-atomically
- **Locations**:
  - `src-tauri/src/commands/scanner.rs:53-92`
- **Trigger**: `import_matched_apps` acquires `state.db()` once at line 53 before the loop, calls `AppScanner::resolve_app_installed_at` (filesystem/registry I/O) per app while holding the lock, and runs `require_app_id` inside the loop after earlier apps were already written outside a transaction.
- **Impact**: Stalls concurrent DB-backed commands during batch import and leaves partial `installed_apps` rows on mid-batch validation error.

### Test Gaps #3 & #4
- **Test Gap #3** (`commands/installer_install.rs:49`, `commands/installer_download.rs:29`, `installer/downloader_http.rs:135`): Zero integration tests for `install_app` `allow_unverified` gate, `download_asset_with_fallback`, and `download_with_progress`.
- **Test Gap #4** (`installer/executor_portable.rs`): No tests for archive path traversal (zip-slip, tar `../`, absolute paths, Windows prefixes, tar hardlinks) or mid-upgrade rollback preserving pre-existing v1 files.

## Acceptance Criteria

- [ ] Portable upgrades (`executor_portable.rs`) and macOS DMG upgrades (`executor_macos.rs`) stage into a sibling temp directory first and swap atomically (`target` → `.bak`, `staging` → `target`, clean `.bak`, restore `.bak` on swap failure), preserving pre-existing v1 files on any failure.
- [ ] Tarball extraction inspects entries first and strips the leading directory component ONLY when all non-empty entries share a single common top-level directory.
- [ ] `scanner::executable::build_tokens` excludes the `owner/` prefix from `app_id` tokenization and enforces word-boundary matching in registry/timestamp lookup.
- [ ] `commands/scanner.rs::import_matched_apps` pre-validates IDs and probes `resolve_app_installed_at` before locking `state.db()`, then commits all DB writes atomically in a single `with_immediate_transaction`.
- [ ] Regression tests cover F-09, F-13, F-16, F-22A, archive path-traversal & hardlinks & mid-upgrade v1 rollback (Test Gap #4), and `allow_unverified` gate / download fallback behavior (Test Gap #3); `cargo test` and `cargo clippy --all-targets` pass.

## Comments

- **Resolved in `61556c2`** (Track 2 `fix-rust-installer`: `fix(installer,scanner): atomic upgrades, safe uninstall, asset selector, and scanner matching`).
- Implemented sibling staging + atomic `.bak` swap/restore for portable (`executor_portable.rs`) and macOS DMG (`executor_macos.rs`) upgrades (F-09); restricted tarball first-component stripping to single-common-root archives (F-13); excluded `owner/` prefix and enforced word-boundary matching in `scanner/executable.rs` (F-16); moved ID validation and `resolve_app_installed_at` outside `state.db()` with single-transaction writes in `commands/scanner.rs` (F-22A); added archive path-traversal, hardlink, v1 rollback, `allow_unverified` gate, and download fallback tests (Test Gaps #3 & #4).
- **Integrated verification on `main`**: `cargo test` 875 passed / 3 ignored, `cargo clippy --all-targets` 0 warnings.
