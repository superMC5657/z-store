# Issue 02: Deepen `scanner` (`External App Management`) by Eliminating `scanner/join.rs`

Status: done
Blocked by: none

## Summary

`src-tauri/src/scanner/join.rs` (109 lines, only 34 lines of non-test code) is labeled a "deep join module", but in reality it is a thin pass-through over `matcher::AppScanner::match_apps` (`join_fuzzy`) and two trivial 2–4 line helpers (`is_managed_id`, `canonical_id_set`). Meanwhile, its sole caller `commands/scanner.rs` still has to orchestrate every internal step manually:

```rust
let scanned = AppScanner::scan_system_apps();
let catalog_items = state.catalog.get_catalog_items();
let installed_ids = canonical_id_set(...);
let matches = join::join_fuzzy(&scanned, &catalog_items);
let unmanaged = matches.into_iter().filter(|m| !join::is_managed_id(&m.catalog_id, &installed_ids)).collect();
```

Per `codebase-design`, this splits one cohesive **External App Management** operation across `commands/scanner.rs`, `scanner/join.rs`, and `scanner/matcher.rs` without hiding complexity behind `AppScanner`'s interface.

## Scope

- `src-tauri/src/scanner/mod.rs`
- `src-tauri/src/scanner/join.rs` (delete)
- `src-tauri/src/scanner/matcher.rs`
- `src-tauri/src/scanner/tests.rs`
- `src-tauri/src/commands/scanner.rs`

## Implementation Details

### 1. Deepen `AppScanner` interface (`scanner/mod.rs` & `scanner/matcher.rs`)
- Absorb the canonical set normalization and managed-ID exclusion logic from `join.rs` directly into `scanner/matcher.rs` (or `scanner/mod.rs`).
- Expose a single cohesive interface for unmanaged discovery:
  - `AppScanner::match_unmanaged(scanned: &[ScannedRawApp], catalog: &[CatalogItem], installed_ids: impl IntoIterator<Item = String>) -> Vec<AppMatchResult>` (pure, deterministic, testable in-process without Windows registry / Linux desktop filesystem I/O)
  - `AppScanner::scan_unmanaged(catalog: &[CatalogItem], installed_ids: impl IntoIterator<Item = String>) -> Vec<AppMatchResult>` (combines `scan_system_apps()` + `match_unmanaged(...)` for production command callers)
- Keep all canonical lookup normalization via `crate::forge::canonical_lookup_id` (ADR-0010) so mixed-case legacy rows in `installed_apps` remain healed.

### 2. Simplify `commands/scanner.rs`
- Update `scan_and_match_local_apps` to fetch `catalog_items` and raw `installed_app_ids` from `AppState`, then call `AppScanner::scan_unmanaged(&catalog_items, installed_ids)` inside `spawn_blocking`.
- Remove all `crate::scanner::join::*` calls from `commands/scanner.rs`.

### 3. Replace-don't-layer tests
- Delete `src-tauri/src/scanner/join.rs` and move its behavioral assertions (`test_is_managed_id_canonical_compare_heals_drift` and `test_join_fuzzy_delegates_to_matcher_semantics`) onto the deepened `AppScanner::match_unmanaged` interface in `src-tauri/src/scanner/tests.rs`.

## Acceptance Criteria

- [ ] `src-tauri/src/scanner/join.rs` is deleted and removed from `scanner/mod.rs`.
- [ ] `commands/scanner.rs` calls a single `AppScanner::scan_unmanaged` interface rather than orchestrating scan → canonicalize → match → filter steps.
- [ ] Behavioral coverage for fuzzy matching + canonical case-drift healing is tested directly through `AppScanner::match_unmanaged`.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` pass.
