# Issue 03: Consolidate `oauth/` Fragmentation & Deepen `userdata` Backup Import

Status: done
Blocked by: none

## Summary

Two backend feature clusters are fragmented into tiny single-purpose files while leaving domain policy in `commands/`:

1. **`oauth/` (6 files for ~700 lines of logic)**: `constants.rs` (33L), `http.rs` (63L, only called by `device_flow.rs` and `star.rs`), `device_flow.rs` (69L, 2 functions), `types.rs` (127L), `star.rs` (417L), and `mod.rs` (28L). Meanwhile, `commands/oauth.rs` holds domain policy (`should_refetch_oauth_user`, `split_github_repo_id`, `sync_star_cache`, login/logout log deduplication).
2. **`userdata/` (single-function module)**: `userdata/mod.rs` (8L) + `userdata/import.rs` (108L) exposes only pure JSON parsing (`parse_import_payload`) to a single caller (`commands/history.rs`), while the actual backup import execution (transaction, deduplicated favorites/watched insertion, setting normalization, `is_cataloged` backfill, `ImportUserDataResult` counting) lives mixed inside `commands/history.rs` alongside favorites, search history, and view history.

## Scope

- `src-tauri/src/oauth/mod.rs`
- `src-tauri/src/oauth/constants.rs` (merge/delete)
- `src-tauri/src/oauth/http.rs` (merge/delete)
- `src-tauri/src/oauth/device_flow.rs`
- `src-tauri/src/oauth/types.rs`
- `src-tauri/src/oauth/star.rs`
- `src-tauri/src/oauth/tests.rs`
- `src-tauri/src/commands/oauth.rs`
- `src-tauri/src/userdata/mod.rs`
- `src-tauri/src/userdata/import.rs` (merge into `userdata.rs` or deepen)
- `src-tauri/src/userdata/tests.rs`
- `src-tauri/src/commands/history.rs`
- `src-tauri/src/lib.rs`

## Implementation Details

### 1. Consolidate `oauth/` and sink OAuth domain policy
- Merge `oauth/constants.rs` and `oauth/http.rs` into `oauth/mod.rs` (or keep a clean 2–3 file layout: `mod.rs` [config/http/types] + `device_flow.rs` + `star.rs`, or single `oauth.rs` + `tests.rs` without micro-files).
- Move `should_refetch_oauth_user` and token/user snapshot resolution helpers out of `commands/oauth.rs` into `oauth` so `commands/oauth.rs` becomes a thin Tauri command adapter over `AppState`.
- Preserve all OAuth Device Flow security invariants (`SETTING_OAUTH_TOKEN`, `SETTING_OAUTH_USER`, `SETTING_OAUTH_CLIENT_ID`, zero token logging, `check_auth_expired` 401 handling, `OAuthUser` JSON shape).

### 2. Deepen `userdata` into a complete backup import module
- Merge `userdata/mod.rs` + `userdata/import.rs` into a single cohesive module (`src-tauri/src/userdata.rs` or `userdata/mod.rs` + `tests.rs`), removing unnecessary 1-line module wrapper overhead.
- Move the SQLite import execution from `commands/history.rs::import_user_data` into `userdata::import_backup(db: &Database, is_cataloged: impl Fn(&str) -> bool, json: &str) -> Result<ImportUserDataResult, String>` (local-substitutable dependency pattern: tested directly via `Database::open_in_memory()`).
- Keep `IMPORT_SETTINGS_ALLOWLIST` excluding `github_token` / OAuth secrets (ADR-0020) and preserve `show_custom`/`showCustom` handling and `ImportUserDataResult` output exactly.
- `commands/history.rs::import_user_data` becomes a clean Tauri command calling `userdata::import_backup` and triggering `notify_affinity_updated` / log summary.

## Acceptance Criteria

- [ ] `oauth/constants.rs` and `oauth/http.rs` micro-files are eliminated; `oauth` exposes a clean, self-contained interface with `should_refetch_oauth_user` owned inside `oauth`.
- [ ] `userdata` owns the full import pipeline (validation + `IMPORT_SETTINGS_ALLOWLIST` + DB execution) testable directly against `Database::open_in_memory()`.
- [ ] `commands/history.rs` no longer embeds backup-import business logic.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` pass.
