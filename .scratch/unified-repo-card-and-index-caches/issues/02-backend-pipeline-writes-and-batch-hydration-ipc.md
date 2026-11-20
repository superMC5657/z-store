# Issue 02: Backend Pipeline Writes to `repo_card_cache`, Private Repo Detection, Batch Hydration IPC & Demo Mock Alignment

Status: resolved
Blocked by: 01

## Summary

Connect all backend uncataloged card/platform/icon pipelines to `repo_card_cache`, detect private GitHub repositories from API JSON payloads, expose the unified batch hydration and `search_list_cache` Tauri commands, and wire the frontend IPC/mock layer so `cmdAlignment.test.ts` and `ipcArgsNaming.test.ts` remain green:

1. **Private Repo Extraction (`github/search.rs`, `github/developer_starred.rs`, `github/models.rs`)**: Parse `private` / `visibility == "private"` on GitHub repo JSON across keyword search, single-repo lookup, Starred feed, and detail fetch.
2. **Backend Pipeline Write & Read Convergence (`commands/catalog_search.rs`, `commands/forge.rs`, `commands/catalog_detail.rs`, `repositories/detail_repo.rs`, `commands/history.rs`, `icons/mod.rs`, `commands/catalog_sync.rs`, `commands/catalog_custom.rs`)**:
   - Upsert uncataloged cards into `repo_card_cache` on Online Search, Trends Enrich, GitHub Starred, and App Detail fetch;
   - Read fresh `repo_card_cache` entries in `resolve_local_enrich_hit`, `backfill_uncataloged_card`, and `get_platforms_lite` (`platforms_lite_from_cache`), and fall back to `repo_card_cache` in `cached_detail_summary` (Uncataloged Favorites/Watched & Recently Viewed);
   - Patch `repo_card_cache` platforms/version/`confirmed_other` inside `get_platforms_lite` (including deterministic HTTP `404` on `/releases/latest` when `repo_card_cache` already confirms the repo exists);
   - Sync `repo_card_cache.icon` on streaming icon hits and manual icon cycling (including L5 clear), and purge cataloged rows from `repo_card_cache` on `sync_catalog` / `collect_local_app`.
3. **New Tauri IPC Commands & Frontend/Demo Wiring**:
   - `get_repo_cards_batch(ids: Vec<String>) -> AppResult<Vec<Option<HydratedRepoCard>>>`
   - `get_search_list_cache(cache_key: String) -> AppResult<Option<SearchListCacheEntry>>`
   - `save_search_list_cache(cache_key: String, norm_query: String, payload_json: String, has_private: Option<bool>) -> AppResult<()>`
   - Extend `OnlineSearchResult` and `StarredPageResult` with `confirmed_other_ids: Vec<String>` and `private_ids: Vec<String>`.

## Scope

- Allowed to modify:
  - `src-tauri/src/github/models.rs`
  - `src-tauri/src/github/search.rs`
  - `src-tauri/src/github/developer_starred.rs`
  - `src-tauri/src/github/developer_starred_tests.rs`
  - `src-tauri/src/github/detail_fetch.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/commands/catalog_detail.rs`
  - `src-tauri/src/commands/catalog_sync.rs`
  - `src-tauri/src/commands/catalog_custom.rs`
  - `src-tauri/src/commands/forge.rs`
  - `src-tauri/src/commands/history.rs`
  - `src-tauri/src/commands/mod.rs`
  - `src-tauri/src/repositories/detail_repo.rs`
  - `src-tauri/src/icons/mod.rs`
  - `src-tauri/src/models.rs`
  - `src-tauri/src/lib.rs`
  - `src/types/index.ts`
  - `src/services/api.ts`
  - `src/services/api/catalog.ts`
  - `src/services/api/ipcArgsNaming.test.ts`
  - `src/demo/tauri-mock.ts`
  - `src/demo/handlers/catalog.ts`
  - `src/demo/handlers/social.ts`
- Do not modify:
  - `src/views/*`, `src/app/*`, `src/services/trends/*`, `src/services/search/*`, `src/services/starred/*`, `src/services/repoEnrichCache.ts` (belong to Issues 03–05)

## Implementation Details

### 1. Private Repo Flag Extraction in GitHub Parsers

- In `src-tauri/src/github/search.rs`:
  - Add `#[serde(default)] private: bool` and `#[serde(default)] visibility: Option<String>` to `OnlineSearchItem` and `OnlineRepoResponse` (`is_private = item.private || item.visibility.as_deref() == Some("private")`).
  - Surface `private_ids: HashSet<String>` (canonical lowercase IDs) on `OnlineSearchFetch` and `is_private: bool` from `fetch_online_repo_with_etag` / `parse_summary_from_repo_json` (without adding `is_private` to public `AppCore`).
- In `src-tauri/src/github/developer_starred.rs`:
  - Add `pub is_private: bool` to `StarredRepoPayload` in `parse_starred_payloads` (`item.get("private").and_then(|v| v.as_bool()) == Some(true) || item.get("visibility").and_then(|v| v.as_str()) == Some("private")`).
- In `src-tauri/src/github/models.rs` & `detail_fetch.rs`:
  - Add `#[serde(default)] pub private: bool` and `#[serde(default)] pub visibility: Option<String>` to `GitHubRepoResponse` and carry `pub is_private: bool` on `DetailFetchOutcome`.

### 2. Backend Read/Write Integration with `repo_card_cache`

- **`backfill_uncataloged_card` (`commands/catalog_search.rs`)**:
  - Merge existing `db.get_repo_card(&item.core.id)` fields first (filling empty `platforms`, placeholder `latest_version`, placeholder `description`/`description_en`, empty `homepage`/`license`/`icon`), then `app_details` (`apply_detail_to_summary_core`), then `backfill_release_from_etag_cache`, returning `(Option<AppIconCycle>, bool /* confirmed_other */)`.
- **`resolve_local_enrich_hit` (`commands/catalog_search.rs`)**:
  - Order:
    1. `catalog.get_catalog_item(&coord.id)` (curated / local library always wins);
    2. Fresh `db.get_repo_card(&coord.id)` (`now.saturating_sub(card.updated_at) < REPO_CARD_FRESH_TTL_SECS`), overlaid with `pre_icon` if present;
    3. `db.get_app_detail(&coord.id, None)` (non-placeholder description);
    4. `cached_payload` (`/repos/{o}/{r}` JSON from `api_etag_cache`).
- **`search_apps_online` & `direct_github_lookup` (`commands/catalog_search.rs`)**:
  - Batch-upsert all uncataloged results into `repo_card_cache` via `db.upsert_repo_cards_batch` (covering keyword search, GitHub direct lookup, and non-GitHub Forge direct lookup).
  - Populate `confirmed_other_ids: Vec<String>` (canonical IDs of returned uncataloged rows whose `confirmed_other == true` and `platforms.is_empty()`) and `private_ids: Vec<String>` on `OnlineSearchResult` (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`).
- **`enrich_trend_repos` (`commands/catalog_search.rs`)**:
  - In the post-fetch single DB lock, batch-upsert all uncataloged `AppSummary` rows into `repo_card_cache`.
- **`list_github_starred` & `cards_from_repo_payloads` (`commands/forge.rs` & `commands/catalog_search.rs`)**:
  - Batch-upsert all uncataloged Starred cards (with each item's `is_private`) into `repo_card_cache`, and return `confirmed_other_ids` and `private_ids` on `StarredPageResult`.
- **`get_platforms_lite` (`commands/catalog_detail.rs`)**:
  - In `platforms_lite_from_cache`: when `!is_force`, if `app_details` misses TTL, check `db.get_repo_card(clean_id)` — if `now.saturating_sub(card.last_accessed_at.max(card.updated_at)) < REPO_CARD_FRESH_TTL_SECS` AND (`!card.summary.core.platforms.is_empty() || card.confirmed_other`), return `PlatformsLiteResult { id: clean_id.to_string(), platforms: card.summary.core.platforms, from_cache: true, is_stale: None }`.
  - On non-stale resolution in `platforms_lite_from_github` and `platforms_lite_from_forge`: if `!state.catalog.is_cataloged(&clean_id)`, call `db.patch_repo_card_platforms(&clean_id, &coords.owner, &coords.repo, &platforms, Some(&tag), platforms.is_empty())`.
  - In `platforms_lite_from_github` `ShallowMiss::OfflineWithoutCache` arm: if `diag.status == Some(404)` AND `!state.catalog.is_cataloged(&clean_id)` AND `db.get_repo_card(&clean_id).ok().flatten().is_some()` (the repo is already known to exist, so 404 on `/releases/latest` deterministically proves zero releases), call `db.patch_repo_card_platforms(&clean_id, &coords.owner, &coords.repo, &[], None, true)` and return `Ok(PlatformsLiteResult { id: clean_id, platforms: Vec::new(), from_cache: false, is_stale: None })`; keep `is_stale: Some(true)` for all other errors/unknown repos.
- **Detail, Favorites/Recents Fallback, Icons & Catalog Sync**:
  - `DetailRepository::persist_detail_bundle`: when `!catalog_is_curated`, upsert `repo_card_cache` in the same transaction (`confirmed_other = detail.core.platforms.is_empty()`, `is_private`).
  - `DetailRepository::cached_detail_summary` & `commands/history.rs::cached_detail_summary`: when `app_details` has no row for an uncataloged `id`, fall back to `db.get_repo_card(&clean_id)` + `resolve_confirmed_icon_from_db`.
  - `save_and_emit` (`commands/catalog_search.rs`), `icons/mod.rs` (`cycle_app_icon`, passing `allow_clear = true` on L5), and `commands/catalog_custom.rs`: call `let _ = db.sync_repo_card_icon(...)`.
  - `commands/catalog_sync.rs` (after `sync_catalog`) and `commands/catalog_custom.rs` (after `collect_local_app`): call `let _ = db.purge_cataloged_repo_cards();`.

### 3. New IPC Commands & Frontend / Demo Wiring

- Models in `src-tauri/src/models.rs` (snake_case fields):
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct HydratedRepoCard {
      pub summary: AppSummary,
      pub confirmed_other: bool,
      #[serde(default, skip_serializing_if = "std::ops::Not::not")]
      pub is_private: bool,
      pub updated_at: i64,
  }

  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct SearchListCacheEntry {
      pub payload_json: String,
      pub cached_at: i64,
  }
  ```
- Commands (`#[tauri::command(rename_all = "camelCase")]`):
  1. `get_repo_cards_batch(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<Vec<Option<HydratedRepoCard>>>`:
     - Single short DB lock, DB-only, zero network, input-order preserving:
     - Canonicalize each `raw_id` (`None` on invalid).
     - If `state.catalog.get_catalog_item(&clean_id)` hits: project `item_to_stamped_summary`, overlay confirmed/cached disk icon (same disk `data:` resolution as `get_confirmed_icons_batch`), and return `Some(HydratedRepoCard { summary, confirmed_other: false, is_private: false, updated_at: now })`.
     - Collect remaining uncataloged `clean_id`s, fetch via `db.get_repo_cards_batch_and_touch(&uncataloged_ids, now)` (with fallback to `DetailRepository::cached_detail_summary` if present in `app_details` only), overlay `resolve_confirmed_icon_from_db`, run `state.catalog.stamp_summary(&mut summary)`, and return aligned `Option<HydratedRepoCard>`.
  2. `get_search_list_cache(state: State<'_, AppState>, cache_key: String) -> AppResult<Option<SearchListCacheEntry>>`
  3. `save_search_list_cache(state: State<'_, AppState>, cache_key: String, norm_query: String, payload_json: String, has_private: Option<bool>) -> AppResult<()>`
- Register all 3 commands in `src-tauri/src/lib.rs` `generate_handler!`, `src/services/api.ts` (`CMD` + `tauriApi`), `src/services/api/catalog.ts`, `src/types/index.ts`, `src/demo/tauri-mock.ts` + `src/demo/handlers/catalog.ts` + `src/demo/handlers/social.ts` (camelCase args only: `ids`, `cacheKey`, `normQuery`, `payloadJson`, `hasPrivate`; clear private demo entries in `handleOAuthLogout`), and `src/services/api/ipcArgsNaming.test.ts`.

## Acceptance Criteria

- [x] Backend unit/mock tests verify:
  - `search_apps_online` and `list_github_starred` populate `repo_card_cache` for uncataloged items, skip cataloged items, flag `is_private = 1` when repo JSON has `"private": true`, and return `confirmed_other_ids` / `private_ids`;
  - `get_platforms_lite` returns `from_cache = true` with zero HTTP requests when `repo_card_cache` holds fresh concrete `platforms` or `confirmed_other = true`, and marks `confirmed_other = true` (`is_stale = None`) when an existing repo in `repo_card_cache` returns HTTP `404` on `/releases/latest`, while offline/500 errors return `is_stale = Some(true)` without poisoning `repo_card_cache`;
  - `get_repo_cards_batch` preserves input order, projects curated items from `CatalogService` with priority over `repo_card_cache`, overlays confirmed `app_icon_cycles` icons, stamps `is_cataloged = Some(false)` on wire output without writing it to `repo_card_cache`, and touches `last_accessed_at`.
- [x] `npx vitest run src/services/api/cmdAlignment.test.ts src/services/api/ipcArgsNaming.test.ts src/views/noDirectInvoke.test.ts` pass 100%.
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml --lib` pass cleanly.
