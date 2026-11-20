# Issue 01: 批量 DAO 预读与 `repo_card_cache` / 富卡管道去 N+1

Status: resolved
Blocked by: none

## Summary

消除 `upsert_repo_cards_batch`、`backfill_uncataloged_card`、`enrich_trend_repos`、`search_apps_online`、`cards_from_repo_payloads` 与 `hydrate_repo_cards` 中的 SQLite N+1 查询与同表重复查询，改为批量 `IN (...)` 预读并在内存一次合并。

## Scope

- Allowed to modify:
  - `src-tauri/src/db/repo_cards.rs`
  - `src-tauri/src/db/etag.rs`
  - `src-tauri/src/db/details.rs`
  - `src-tauri/src/db/icon_cycle.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/commands/catalog_detail.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **`upsert_repo_cards_batch` 批量预读优化 (`db/repo_cards.rs`)**：
   - 在 `with_immediate_transaction` 起始处，先收集本批规范 `id`，用 `BATCH_CHUNK` 分片执行一次 `SELECT {SELECT_COLS} FROM repo_card_cache WHERE id IN (...)` 预加载已有 `CardRow` 到 `HashMap<String, CardRow>`。
   - 同时批量查询本批 `id` 是否命中 `catalog_apps` / 活跃 `custom_apps`（或提供 `upsert_uncataloged_repo_cards_batch` 供已通过 `CatalogService` 过滤的调用方跳过重复查表），消除循环内 `3 * N` 次单行查询。
2. **新增批量读 DAO**：
   - `db/etag.rs`：新增 `get_etags_and_payloads_batch(&self, urls: &[String]) -> Result<HashMap<String, (String, String)>>`（`IN (...)` 分片查询）。
   - `db/details.rs`：新增 `get_app_detail_summaries_batch(&self, ids: &[String]) -> Result<HashMap<String, AppSummary>>`（不读取大字段 `readme_markdown` / `readme_variants_json` / `changelog` / `releases_json`，仅读取构建概要/平台/版本所需列，同时服务 `hydrate_repo_cards` 的缺失回退与 `backfill_uncataloged_card`）。
   - `db/icon_cycle.rs`：新增 `get_icon_cycles_batch(&self, app_ids: &[String]) -> Result<HashMap<String, AppIconCycle>>`，供批量回填图标确认复用。
3. **收敛 `backfill_uncataloged_card` 与富卡管道 (`commands/catalog_search.rs`)**：
   - 单次 `backfill_from_repo_card` + `repo_card_confirmed_other` 合并为单次读取 `CardRow` / `RepoCardPlatformState`，消除对 `repo_card_cache` 的连续 3 次查询。
   - `search_apps_online` 中循环内部已计算的 `pre_confirmed` 直接复用于 `candidates` 过滤，移除 L783-797 对整页结果再扫一次 `resolve_confirmed_icon_from_db` 的重复代码。
   - `enrich_trend_repos` 预读区改用批量预读映射表（ETag/Payload、RepoCard、Detail 轻量摘要、IconCycle），不再逐仓发 6~8 条 SQL。

## Acceptance Criteria

- [x] `upsert_repo_cards_batch` 对 $N$ 条卡片的读前置固定为常数次批量分片查询（而非 $2N$ 次单行查询）。
- [x] `search_apps_online`、`enrich_trend_repos`、`cards_from_repo_payloads` 与 `hydrate_repo_cards` 每页只查一次 `app_icon_cycles` / `repo_card_cache` / `app_details` / `api_etag_cache`。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过（含 `repo_card_pipeline_tests` 与 `db::repo_cards::tests`）。
