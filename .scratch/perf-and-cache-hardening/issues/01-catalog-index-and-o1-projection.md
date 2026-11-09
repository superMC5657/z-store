# Issue 01: `CatalogService` $O(N)$ Stamped Projection & $O(1)$ Starred Lookup

Status: resolved
Blocked by: none

## Summary

Eliminate $O(N^2)$ linear scans and redundant `CatalogItem` clones in `CatalogService`:
1. `CatalogService::merged_summaries` currently iterates over `get_catalog_items()` ($N$ items) and calls `item_to_stamped_summary` $\rightarrow$ `resolve_catalog_stamp`, which calls `get_remote_catalog_item(id)` and `is_collected_id(id)`. Both functions re-run `canonical_app_id(id)`, lock `RwLock`, linearly scan `Vec<CatalogItem>`, and `.clone()` the entire `CatalogItem`. This turns every `merged_summaries()` call (`get_home_feed`, `get_category_apps`, `get_latest_catalog_apps`) into $O(N^2)$ with $2N$ full struct clones.
2. `CatalogService::build_starred_sync_result_from_cached` (`src-tauri/src/github/affinity.rs`) calls `crate::forge::canonical_app_id(&full_name)` inside the inner `catalog_list.iter().find(...)` closure, re-parsing the same `full_name` $N$ times per starred repo.

## Scope

- `src-tauri/src/github/catalog_service.rs`
- `src-tauri/src/github/affinity.rs`

## Implementation Details

### 1. Avoid cloning in `resolve_catalog_stamp` and `is_collected_id` (`src-tauri/src/github/catalog_service.rs`)

- In `is_collected_id(&self, id: &str) -> bool`: check `self.collected.read().ok().map(|items| items.iter().any(|i| i.id == key)).unwrap_or(false)` without cloning `CatalogItem`.
- In `resolve_catalog_stamp(&self, id: &str) -> (bool, Option<String>, Option<String>)`: normalize `id` once via `crate::forge::canonical_app_id(id)` and inspect `self.items.read()` and `self.collected.read()` by reference (`iter().find(|i| i.id == key).map(|i| i.is_verified)`) instead of cloning full `CatalogItem` structs.

### 2. Single-pass $O(N)$ `merged_summaries` (`src-tauri/src/github/catalog_service.rs`)

- Implement `merged_summaries(&self) -> Vec<AppSummary>` so it acquires read guards (or snapshots once), builds a `HashSet<&str>` of `collected` IDs in $O(M)$, and stamps each remote/local summary in $O(1)$ during a single pass without calling `resolve_catalog_stamp` per item:
  - Remote item with `is_verified == true` or not in `collected_ids` $\rightarrow$ `(true, Some("remote"), None)`
  - Remote item with `is_verified == false` and present in `collected_ids` $\rightarrow$ `(true, Some("local"), Some("collected"))`
  - Local-only fallback item (not in remote) $\rightarrow$ `(true, Some("local"), Some("collected"))`
- Preserve exact existing ordering (remote items first in order, followed by deduplicated local collected items) and exact stamp semantics verified by `test_stamp_summary_source_rules` and `test_merged_summaries_stamps_every_row`.

### 3. Hoist `canonical_app_id` and use `HashMap` lookup in `build_starred_sync_result_from_cached` (`src-tauri/src/github/affinity.rs`)

- Pre-index `catalog_list` by `id.as_str()` into a `HashMap<&str, &CatalogItem>` before the `for r in starred_list` loop.
- Compute `let canonical = crate::forge::canonical_app_id(&full_name);` once per starred repo and look up `canonical.as_deref().and_then(|k| catalog_by_id.get(k).copied())`.

## Acceptance Criteria

- [x] `resolve_catalog_stamp` and `is_collected_id` do not clone `CatalogItem`.
- [x] `merged_summaries` runs in $O(N + M)$ time without per-item linear scans.
- [x] `build_starred_sync_result_from_cached` normalizes `full_name` at most once per starred item and matches catalog entries in $O(1)$.
- [x] Existing unit tests (`test_stamp_summary_source_rules`, `test_merged_summaries_stamps_every_row`, and affinity tests) pass under `cargo test --manifest-path src-tauri/Cargo.toml`.
