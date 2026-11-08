# Issue 01: Detail Icon Level Origin Tracking & Canonical `app_id` Alignment

Status: resolved
Blocked by: none

## Summary

Fix two closely coupled backend icon-cycle bugs:
1. **L4 README logos misclassified as L3 (`l3_url`)**: `CatalogService::fetch_app_detail` extracts L4 README logos via `extract_and_strip_logo_from_readme`, which calls `clean_image_url` and rewrites GitHub `/blob/` URLs and relative paths into `https://raw.githubusercontent.com/{owner}/{repo}/.../HEAD/...` (or preserves external CDN URLs). Later, `persist_github_detail` and `get_or_fetch_icon` infer the icon level purely from the URL string via `level_for_detail_icon`, which only matches `/blob/` or `"readme"` as L4 and defaults everything else to `3`. As a result, L4 README logos are persisted into `l3_url` (leaving `l4_url` empty) and shown with an `L3` badge in `AppDetailModal`, while when both `probed_hit` (L2/L3) and `extracted_logo` (L4) exist, `extracted_logo` is discarded instead of populating `l4_url`.
2. **Non-lowercased `app_id` creating duplicate `app_icon_cycles` rows**: `CatalogService::fetch_online_repo` constructs `AppSummary.core.id` from raw `format!("{}/{}", owner, repo)` without `.to_lowercase()`, and `get_or_fetch_icon` / `load_or_new_cycle` query `db.get_icon_cycle` without `canonical_lookup_id`.

## Scope

- `src-tauri/src/db/icon_cycle.rs`
- `src-tauri/src/github/icon_fetch.rs`
- `src-tauri/src/github/detail_fetch.rs`
- `src-tauri/src/commands/catalog_detail.rs`
- `src-tauri/src/commands/icons.rs`
- `src-tauri/src/commands/icons_cycle_probe.rs`
- `src-tauri/src/github/search.rs`
- `src-tauri/src/db/tests.rs`

## Implementation Details

### 1. Match known cycle URLs first (`src-tauri/src/db/icon_cycle.rs`)

Add a helper on `AppIconCycle` to check if a URL already matches a populated slot (`l1_url`..`l5_url`):

```rust
impl AppIconCycle {
    /// Returns the level (1..=5) if `url` matches an already-populated slot on this cycle row.
    pub fn level_for_known_url(&self, url: &str) -> Option<u8> {
        let u = url.trim();
        if u.is_empty() {
            return None;
        }
        for level in 1..=5 {
            if self.url_for_level(level) == Some(u) {
                return Some(level);
            }
        }
        None
    }
}
```

### 2. Improve `level_for_detail_icon` URL fallback heuristic (`src-tauri/src/github/icon_fetch.rs`)

Update `level_for_detail_icon(url: &str) -> i32` (pure `L2/L3/L4` per `CONTEXT.md` §二.D10) so URLs rewritten by `clean_image_url` from README relative paths (`raw.githubusercontent.com/{owner}/{repo}/HEAD/...`) and GitHub user-attachments / camo URLs are recognized as L4 (`4`):
- `2`: `url.contains("simpleicons.org")`
- `4`: `url.contains("/blob/") || url.contains("/HEAD/") || url.to_lowercase().contains("readme") || url.contains("user-images.githubusercontent.com") || url.contains("camo.githubusercontent.com") || url.contains("github.com/user-attachments/assets/")`
- `3`: default for repo-tree raw paths (`raw.githubusercontent.com/{owner}/{repo}/{branch}/...` with an explicit branch name).

### 3. Preserve true L2/L3/L4 origin in `fetch_app_detail` & `persist_github_detail`

- In `src-tauri/src/db/icon_cycle.rs` and `src-tauri/src/github/detail_fetch.rs`:
  - Define `ProbeIconLevel` (`L2SimpleIcons = 2`, `L3Trees = 3`, constructed via `ProbeIconLevel::from_source`) and `DetailIconResolution` (`pick_detail_icon_with_level`) so that the caller knows:
    - The selected primary `(level, url)` where `probed_hit` preserves its `ProbeIconLevel` (`2` or `3`) and `extracted_logo` has level `4`.
    - `extra_l4_url: Option<String>` when both `probed_hit` (L2/L3) and `extracted_logo` (L4) were discovered during `fetch_app_detail`.
  - When `db` is present in `persist_github_detail`, `apply_detail_icon_resolution` writes `extra_l4_url` into `l4_url` via `fill_probe_slot(&mut cycle, 4, extra_l4)` so the user can cycle to L4 in `AppDetailModal` and L4 is not lost.
- In `src-tauri/src/commands/catalog_detail.rs`:
  - Pass the explicit icon level (or look up `existing_cycle.level_for_known_url(&detail.core.icon)` before falling back to `level_for_detail_icon(&detail.core.icon)`) into `persist_github_detail` so `fill_probe_slot` writes into the true slot (`2`, `3`, or `4`) rather than overwriting `l3_url` with an L4 README logo.

### 4. Respect existing cycle slot in `get_or_fetch_icon` (`src-tauri/src/commands/icons.rs`)

- Normalize `id` at the start of `get_or_fetch_icon` using `let canonical_id = super::catalog::canonical_lookup_id(id);` and use `&canonical_id` for `db.get_icon_cycle(&canonical_id)` (lines 272 and 342) and `fill_probe_slot`.
- When `url` is `http(s)://` and `fill_probe_slot` is called (around line 348):
  - First check `db.get_icon_cycle(&canonical_id).ok().flatten().and_then(|c| c.level_for_known_url(u))` to preserve the existing slot level (`1..=5`), falling back to `level_for_detail_icon(u)` only when the URL is not yet in any slot of `app_icon_cycles`.

### 5. Lowercase `app_id` in `fetch_online_repo` & `load_or_new_cycle`

- In `src-tauri/src/github/search.rs` (`CatalogService::fetch_online_repo`, around line 305):
  - Change `let id = format!("{}/{}", owner, repo);` to `let id = format!("{}/{}", owner, repo).to_lowercase();` so it matches `search_repositories` (line 202) and `parse_github_Item` (line 419).
- In `src-tauri/src/commands/icons_cycle_probe.rs` (`load_or_new_cycle`, around line 98):
  - Normalize `app_id` via `super::catalog::canonical_lookup_id(app_id)` before querying/constructing `AppIconCycle`.

## Acceptance Criteria

- [x] `AppIconCycle::level_for_known_url` returns `Some(level)` when a URL matches an existing slot on `AppIconCycle`, and `None` otherwise.
- [x] `level_for_detail_icon` classifies `https://raw.githubusercontent.com/owner/repo/HEAD/docs/banner.png`, `/blob/` URLs, and GitHub user-attachments / camo URLs as level `4` (`L4`), while keeping explicit-branch `raw.githubusercontent.com/owner/repo/main/assets/icon.png` as level `3` (`L3`).
- [x] When `fetch_app_detail` extracts a README logo (and L2/L3 probes miss), `app_icon_cycles.l4_url` is populated (not `l3_url`), and `active_level` becomes `4`.
- [x] When `fetch_app_detail` hits both `probed_hit` (e.g. L3) and `extracted_logo` (L4), `l3_url` holds the L3 URL, `l4_url` holds the L4 URL, and `active_level` is `3`.
- [x] `CatalogService::fetch_online_repo` produces a lowercase `core.id` (`owner/repo`).
- [x] `get_or_fetch_icon` and `load_or_new_cycle` use `canonical_lookup_id(id)` so no uppercase/mixed-case `app_id` rows are created in `app_icon_cycles`.
- [x] Unit tests added in `src-tauri/src/github/icon_fetch.rs`, `src-tauri/src/github/detail_fetch.rs`, and `src-tauri/src/db/tests.rs` pass under `cargo test --manifest-path src-tauri/Cargo.toml`.
