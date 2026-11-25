# Issue 07: Userdata Backup Import Validation & Runtime State Synchronization

Status: resolved
Severity: High (F-10 [High])
Fix Track: Track 3 (`fix-rust-storage`)
Findings: F-10

## Findings

### F-10 [High]: `import_user_data` bypasses setting security validation, desyncs `AppState.mirror` & startup registry, and aborts on slash-less IDs
- **Locations**:
  - `src-tauri/src/userdata/mod.rs:10-44, 89-103, 119-153`
  - `src-tauri/src/commands/history.rs:215-231`
  - `src-tauri/src/commands/settings.rs:155-188`
- **Trigger**:
  1. `import_backup:149-153` writes allowlisted settings (`catalog_source_url`, `active_mirror`, `launch_on_startup`, `portable_dir`, `download_dir`) directly to `user_settings` without invoking `validate_setting_value`. A crafted or corrupted backup JSON can persist `catalog_source_url: "http://127.0.0.1:8080/c.json"` or `active_mirror: "http://evil.local"`, bypassing HTTPS and private-host SSRF guards.
  2. Neither `import_user_data` nor `save_setting("active_mirror", ...)` updates in-memory `state.mirror` (unlike `switch_mirror`), and `import_user_data` never invokes `sync_launch_on_startup` when `launch_on_startup` is imported.
  3. `validate_app_id` (`userdata/mod.rs:29-44`) accepts `"foo"` (no `/`), after which `import_backup:123` fails on `canonical_app_id("foo") == None` and aborts the entire transaction, contradicting the documented behavior ("非法 ID 直接丢弃").
- **Impact**: Security validation bypass via backup JSON (persisting arbitrary HTTP/loopback `catalog_source_url` fetched by `catalog_sync`); stale in-memory mirror configuration and OS startup registry until restart; a single malformed ID aborts an entire user backup restore.

## Acceptance Criteria

- [ ] `userdata::import_backup` validates every imported setting through `validate_setting_value`, rejecting or safely skipping unsafe `catalog_source_url`, `active_mirror`, and path settings without persisting invalid values.
- [ ] Both `commands/settings.rs::save_setting("active_mirror", ...)` and `commands/history.rs::import_user_data` synchronize in-memory `state.mirror` immediately upon persisting `active_mirror`.
- [ ] `commands/history.rs::import_user_data` calls `sync_launch_on_startup` whenever `launch_on_startup` is applied from a backup.
- [ ] `parse_import_payload` normalizes and filters app IDs via `canonical_app_id`, gracefully discarding malformed or slash-less IDs (`"foo"`) without aborting the rest of the backup import.
- [ ] Unit/regression tests cover unsafe URL rejection, `state.mirror` sync, `launch_on_startup` sync, and graceful skipping of slash-less IDs; `cargo test` and `cargo clippy --all-targets` pass.

## Comments

- **Resolved in `b48b4da`** (Track 3 `fix-rust-storage`: `fix(storage,oauth,icons): complete OAuth private cache purge, import validation, and singleflight/lock safety`).
- Enforced `validate_setting_value` on imported settings and `canonical_app_id` filtering on imported app IDs in `userdata/mod.rs`; synced in-memory `state.mirror` in `commands/settings.rs` & `commands/history.rs` and `sync_launch_on_startup` on backup restore, with regression tests in `userdata/tests.rs` (F-10).
- **Integrated verification on `main`**: `cargo test` 875 passed / 3 ignored, `cargo clippy --all-targets` 0 warnings.
