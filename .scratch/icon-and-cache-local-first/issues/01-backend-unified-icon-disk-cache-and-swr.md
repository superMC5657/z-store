# Issue 01: Backend Unified Icon Disk Cache Lookup, 7-Day SWR Fallback & L4 Confirmed Icon Recovery

Status: done
Blocked by: none

## Summary

Redesign backend icon cache resolution so that any valid icon file already present in `icons/` (`sha256(url)[0:16].{ext}`) is always found regardless of cataloged status or empty `cache_file`, never fails when network fluctuates after the 7-day TTL (`ICON_TTL_SECS`), and preserves L4 (README header logo) confirmed icons across list views:

1. **Eliminate artificial cataloged vs uncataloged disk cache miss (`load_split_cached_bytes`)**:
   - Currently, `load_split_cached_bytes` (`src-tauri/src/commands/icons_cycle_probe.rs:153`) requires an `icon_cache_meta` row for cataloged apps and a non-empty `cycle.cache_file` with `cycle.selected_url == url` for uncataloged apps. When `save_and_emit`, `backfill_uncataloged_card`, or `persist_github_detail` writes `selected_url` into `app_icon_cycles` without `cache_file`, or when an app's cataloged status changes, `load_split_cached_bytes` misses even though `icons/{sha256(url)[0:16]}.{ext}` is on disk.
2. **Stale-While-Revalidate (SWR) & Offline Fallback on Disk Icons**:
   - Currently, `get_or_fetch_icon` (`icons.rs`), `restore_existing_cycle` (`icons_cycle_commands.rs`), and `restore_cataloged_default` (`icons_cycle_commands.rs`) reject on-disk icon files older than 7 days (`is_icon_file_fresh` / `is_icon_fresh`) before attempting network download. If the network fluctuates and `download_icon_bytes_direct` fails, they return `Err` or `url: ""` instead of serving the valid on-disk image bytes.
3. **`resolve_confirmed_icon_from_db` Hash-Candidate Self-Healing & L4 Support**:
   - Currently, `resolve_confirmed_icon_from_db` (`src-tauri/src/github/http.rs:385-417`) only checks `cycle.cache_file`. If `cache_file` is empty (even if `icons/{hash}.{ext}` exists on disk), it returns raw remote URL for `level 1..=3` and returns `None` for `level == 4` (causing L4 README logos discovered in App Detail to vanish in Trends/Search/Favorites).
4. **`get_confirmed_icons_batch` Cataloged Disk Fallback**:
   - Allow `get_confirmed_icons_batch` (`src-tauri/src/commands/catalog_detail.rs:355`) to also resolve on-disk cached icons for cataloged apps (`state.catalog.get_catalog_item`) when no `app_icon_cycles` row exists, enabling 1-RTT batch local disk icon loading.

## Scope

- `src-tauri/src/commands/icons.rs`
- `src-tauri/src/commands/icons_cycle_probe.rs`
- `src-tauri/src/commands/icons_cycle_commands.rs`
- `src-tauri/src/github/http.rs`
- `src-tauri/src/commands/catalog_detail.rs`

## Implementation Details

### 1. Unified disk cache reader with fresh/stale distinction (`src-tauri/src/commands/icons_cycle_probe.rs`)

- Define a struct `CachedIconDiskHit`:
  ```rust
  pub(crate) struct CachedIconDiskHit {
      pub bytes: Vec<u8>,
      pub filename: String,
      pub is_fresh: bool,
  }
  ```
- Implement `pub(crate) fn read_cached_icon_bytes_any(icons_dir: &std::path::Path, db_opt: Option<&crate::db::Database>, icon: &IconRef<'_>, is_cataloged: bool, noncatalog_cycle: Option<&crate::db::AppIconCycle>) -> Option<CachedIconDiskHit>`:
  1. First try the fast fresh path (`load_split_cached_bytes` or `read_level_cache_file`). If hit, return `Some(CachedIconDiskHit { bytes, filename, is_fresh: true })`.
  2. Next, check `noncatalog_cycle`: if `!cycle.cache_file.trim().is_empty()` and `cycle.selected_url.trim() == icon.url.trim()`, check `icons_dir.join(&cycle.cache_file)` via `read_valid_image_file`. If valid bytes exist on disk, compute `file_fresh` and return `Some(CachedIconDiskHit { bytes, filename: cycle.cache_file.clone(), is_fresh: file_fresh })`.
  3. Next, scan `hash_icon_candidate_filenames(icon)` in `icons_dir`: for each candidate `fname`, if `read_valid_image_file(&icons_dir.join(&fname))` returns `Some(bytes)`, check `is_icon_file_fresh` and return `Some(CachedIconDiskHit { bytes, filename: fname, is_fresh })`.
- In `load_split_cached_bytes`:
  - Keep strict 7-day freshness check for the primary fresh check, **but** allow hash-candidate lookup on `icons_dir` for both `is_cataloged` and `!is_cataloged` when the file is fresh (`is_icon_file_fresh`), self-healing `icon_cache_meta` or `cycle.cache_file` when a fresh hash file is already on disk.

### 2. Fallback to stale on-disk bytes when network fails (`src-tauri/src/commands/icons.rs` & `icons_cycle_commands.rs`)

- In `get_or_fetch_icon` (`src-tauri/src/commands/icons.rs`):
  - Before making network requests, check `read_cached_icon_bytes_any`.
  - If `Some(hit)` with `hit.is_fresh == true`: self-heal `cycle.cache_file` if needed and return `Ok(bytes_to_data_uri(&hit.bytes))` immediately (0 network requests).
  - If `Some(stale_hit)` with `stale_hit.is_fresh == false`: attempt the network download (`download_icon_bytes_direct`), and if the network download fails, **return `Ok(bytes_to_data_uri(&stale_hit.bytes))`** instead of returning `Err(...)`!
- In `restore_existing_cycle` and `restore_cataloged_default` (`src-tauri/src/commands/icons_cycle_commands.rs`):
  - When the 7-day freshness check (`is_cycle_restore_fresh` / `is_icon_file_fresh`) is false and the subsequent `download_icon_bytes(&remote_url)` fails due to network fluctuation, check if a valid image file (`cache_path` or `hash_candidate_filenames`) still exists on disk; if so, return its `bytes_to_data_uri(&bytes)` instead of `url: String::new()`.

### 3. Self-healing disk lookup & L4 support in `resolve_confirmed_icon_from_db` (`src-tauri/src/github/http.rs`)

- In `resolve_confirmed_icon_from_db(db, app_id, owner, repo) -> Option<String>`:
  1. Look up `cycle` via `lookup_case_insensitive(db, app_id, &repo_ref)`.
  2. If `cycle.level == 5` or `cycle.selected_url.trim().is_empty()`, return `None`.
  3. Check `cycle.cache_file` in `icons_dir`. If valid image bytes exist, return `Some(bytes_to_data_uri(&bytes))`.
  4. **New fallback**: If `cache_file` is empty or missing on disk, compute `inferred_ext = crate::commands::icons::infer_icon_ext_from_url(selected).unwrap_or("png")` and scan `hash_icon_candidate_filenames(&IconRef::new(selected, inferred_ext))` in `icons_dir`. If a valid image file exists on disk:
     - Best-effort update `db.set_icon_cycle_selected(&cycle.app_id, cycle.level, selected, &found_filename)`;
     - Return `Some(bytes_to_data_uri(&bytes))` (this works for all levels `1..=4`, including L4!).
  5. If no file is on disk yet:
     - For `(1..=3).contains(&cycle.level)`: return `Some(selected.to_string())`.
     - For `cycle.level == 4`: keep existing `level4_without_cache_file_is_not_m2` test contract if `selected` is non-http or synthetic, OR wait: check `src-tauri/src/github/http.rs:681` (`fn level4_without_cache_file_is_not_m2`)!
       - Note: In `http.rs:681`, `level4_without_cache_file_is_not_m2` tests that when `level == 4` and there is NO file on disk (`cache_file: ""` and no hash file on disk), `resolve_confirmed_icon_from_db` returns `None` (so `enrich_trend_repos` knows L4 is not yet downloaded as M2 on disk).
       - Therefore: when the L4 file **IS** on disk (via `cache_file` OR via `hash_icon_candidate_filenames` in step 4, and we also ensure `persist_github_detail` / `get_or_fetch_icon` downloads and links L4 `cache_file`), step 3/4 returns `Some(data_uri)`! And when no file is on disk for `level == 4`, it still returns `None`, keeping `level4_without_cache_file_is_not_m2` 100% green!

### 4. Catalog disk fallback in `get_confirmed_icons_batch` (`src-tauri/src/commands/catalog_detail.rs`)

- In `get_confirmed_icons_batch`:
  - First call `crate::github::http::resolve_confirmed_icon_from_db(&db, &clean_id, owner, repo)`.
  - If `None`, check `state.catalog.get_catalog_item(&clean_id)`. If `Some(cat_item)` and `!cat_item.icon.trim().is_empty()`:
    - Check if `icons/` has a valid cached file for `cat_item.icon.trim()` via `hash_icon_candidate_filenames`. If found on disk, return `Some(bytes_to_data_uri(&bytes))` (otherwise `Some(cat_item.icon)`).

## Acceptance Criteria

- [ ] `get_or_fetch_icon` hits on-disk `sha256(url)[0:16].{ext}` files even when `app_icon_cycles.cache_file` is empty or `icon_cache_meta` row is absent, and self-heals metadata.
- [ ] When an on-disk icon file is older than 7 days (`ICON_TTL_SECS`) and the network is unreachable/fluctuating, `get_or_fetch_icon`, `restore_existing_cycle`, and `restore_cataloged_default` return the valid on-disk `data:` URI instead of `Err` or empty `url`.
- [ ] `resolve_confirmed_icon_from_db` locates on-disk hash files (`sha256(selected_url)[0:16].{ext}`) even when `cycle.cache_file` is `""`, self-heals `cache_file`, and returns `Some(data:...)` for `level 1..=4` (while preserving `level4_without_cache_file_is_not_m2` when no file exists on disk).
- [ ] All unit tests in `src-tauri/src/commands/icons.rs`, `icons_cycle_probe.rs`, `github/http.rs`, and `commands/catalog_detail.rs` pass under `cargo test --manifest-path src-tauri/Cargo.toml`.
