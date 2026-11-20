# Issue 04: Consolidate Backend Icon Subsystem & Tiny `db/` Modules

Status: done
Blocked by: 01

## Summary

The backend **Confirmed Icon** / **IconFetch** / `AppIconCycle` subsystem is fragmented across 3 top-level directories (`github/`, `db/`, `commands/`) and 7+ files, producing multi-hop pass-throughs and inverted dependencies:

- `commands/icons.rs` (439L) contains 4 single-line delegators (`detect_image_mime`, `is_valid_image`, `mime_to_ext`, `infer_icon_ext_from_url`) forwarding to `github/image_sniff.rs`.
- `commands/icons_cycle_probe.rs` (943L) sits in the IPC command layer yet owns disk cache I/O, hash filenames, `IconRef`, `write_icon_file`, and `enforce_icon_quota_lru`, while also re-exporting `db::icon_cycle` helpers and wrapping `db::icon_cycle::resolve_icon_coord` (`resolve_app_coord`) and `commands::icons::download_icon_bytes` (`download_icon_bytes_direct`).
- `db/icon_cycle.rs` (771L) mixes SQLite queries with pure domain state-machine functions (`merge_detail_icon`, `fill_probe_slot`, `pick_detail_icon_with_level`, `apply_detail_icon_resolution`, `next_cycle_level`, `resolve_icon_coord`), forcing `github/detail_fetch.rs`, `forge/coord.rs`, and `commands/catalog_detail.rs` to import domain rules from `crate::db::icon_cycle`.
- Additionally, `db/tokens.rs` (35L), `db/apps.rs` (65L), `db/rules.rs` (84L), and `db/settings.rs` (85L) split trivial 2–3 method `impl Database` blocks while setting normalization (`normalize_setting_value`, etc.) sits separated in `db/mod.rs`.

## Scope

- `src-tauri/src/icons/` (new deep module, or `icons.rs` + internal submodules)
- `src-tauri/src/github/{icon_fetch.rs, icon_probe.rs, image_sniff.rs, detail_fetch.rs, http.rs, mod.rs}`
- `src-tauri/src/db/{icon_cycle.rs, tokens.rs, settings.rs, apps.rs, rules.rs, mod.rs}`
- `src-tauri/src/commands/{icons.rs, icons_cycle_commands.rs, icons_cycle_probe.rs, catalog_detail.rs, catalog_search.rs, mod.rs, tests.rs}`
- `src-tauri/src/forge/coord.rs`
- `src-tauri/src/lib.rs`

## Implementation Details

### 1. Create one deep `src-tauri/src/icons/` module
- Consolidate domain logic + disk cache/LRU + image sniffing + probing behind a unified `icons` module:
  - Move `image_sniff.rs`, `icon_probe.rs`, `icon_fetch.rs` (`fetch_icons_stream`, `probe_single_live`, `level_for_detail_icon`, `icon_key`) out of `github/` into `icons/` (keeping `github/` focused on GitHub catalog/detail/search/affinity).
  - Move pure `AppIconCycle` state-machine & detail-icon resolution types/functions (`merge_detail_icon`, `fill_probe_slot`, `pick_detail_icon_with_level`, `apply_detail_icon_resolution`, `DetailIconResolution`, `ProbeIconLevel`, `next_cycle_level`, `resolve_icon_coord`, `hash_icon_filename`) out of `db/icon_cycle.rs` into `icons/`.
  - Move disk persistence, `read_valid_image_file`, `write_icon_file`, `enforce_icon_quota_lru`, `download_icon_bytes`, `bytes_to_data_uri`, and `ensure_cycle_levels` out of `commands/icons.rs` and `commands/icons_cycle_probe.rs` into `icons/`.
- Eliminate redundant pass-throughs (`detect_image_mime` delegators in `commands/icons.rs`, `resolve_app_coord` / `download_icon_bytes_direct` in `icons_cycle_probe.rs`).
- Preserve all ADR-0015 & D5/D6/D8/D10 invariants: `IconFetch` `pool=5`, 404/410 short-circuit, `zstore://icon-ready{id,icon,level,via,context}`, level pure `1..=5`, `via=live|m2`, token-less icon HTTP client, and 7-day cache TTL without ETag lookups.

### 2. Thin `commands/icons.rs` and `db/icon_cycle.rs`
- `db/icon_cycle.rs` retains ONLY SQLite persistence (`get_icon_cycle`, `upsert_icon_cycle`, `set_icon_cycle_selected`, `get_icon_cache_record`, `save_icon_cache_url`, `delete_icon_cache_url`, etc.) and `AppIconCycle` record struct.
- Merge `commands/icons.rs` + `commands/icons_cycle_commands.rs` + `commands/icons_cycle_probe.rs` down to a single thin `commands/icons.rs` containing ONLY the 3 Tauri commands (`get_or_fetch_icon`, `cycle_app_icon`, `restore_or_fetch_icon_cycle`) delegating into `crate::icons`.

### 3. Consolidate trivial `db/` configuration/state files
- Merge `db/tokens.rs` (35L) and the setting-normalization helpers in `db/mod.rs` (`normalize_detail_cache_ttl`, `normalize_setting_value`, `normalize_watch_notify_frequency`, `normalize_strict_errors`, `get_or_config`, etc.) into `db/settings.rs` so settings persistence + normalization share Locality.
- (Optional tidy while in `db/`): keep `db/apps.rs` + `db/rules.rs` only if cleanly sized, or fold small `installed_apps` + `update_rules` CRUD into `db/installed.rs` if convenient without churn.

## Acceptance Criteria

- [x] `commands/icons_cycle_probe.rs` and `commands/icons_cycle_commands.rs` are merged/removed; `commands/icons.rs` holds only thin command adapters without disk/probe mechanics or `image_sniff` pass-throughs.
- [x] `db/icon_cycle.rs` contains SQLite persistence only; pure icon state-machine and `pick_detail_icon_with_level` logic live in `crate::icons`.
- [x] `db/tokens.rs` and `db/mod.rs` setting normalizers are consolidated into `db/settings.rs`.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` pass.
