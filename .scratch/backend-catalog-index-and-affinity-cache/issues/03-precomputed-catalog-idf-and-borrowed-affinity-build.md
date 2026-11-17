# Issue 03: 预计算 `CatalogIdf` 缓存与零克隆 `UserAffinityProfile` 构建

Status: needs-triage
Blocked by: 01

## Summary

将 `CatalogIdf` 的全库分词计算从每次请求（`get_home_feed` / `get_featured_page` / `get_affinity_profile_summary`）前移并缓存至 `CatalogService` 目录更新时机，并让 `UserAffinityProfile` 直接借用预计算 `Arc<CatalogIdf>` 与 `CatalogService` 的 $O(1)$ 索引，消除高频视图切换时的重复全库分词与克隆开销。

## Scope

- Allowed to modify:
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/github/affinity.rs`
  - `src-tauri/src/github/affinity_text.rs`
  - `src-tauri/src/github/featured.rs`
  - `src-tauri/src/commands/catalog_feed.rs`
  - `src-tauri/src/commands/catalog_featured.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **目录级 `Arc<CatalogIdf>` 预计算与缓存**：
   - 在 `CatalogService` 中随目录内容（`remote` + 未重复 `collected`）维护 `Arc<CatalogIdf>`（可在写锁更新或通过目录版本号按需懒构建一次并缓存），仅当 `sync_from_db` / `sync_collected_from_db` / `update_items` / `set_collected_items` 改变目录时失效或更新。
   - 当目录详情回写仅更新 `stars`/`forks`/`platforms` 等不参与文本分词的字段（`update_catalog_item_from_detail` / `update_catalog_item_platforms`）时，保持 `CatalogIdf` 缓存有效，不触发重算。
2. **零全库克隆构建 `UserAffinityProfile`**：
   - 为 `UserAffinityProfile` 增加基于目录索引/闭包或只读视图的构造方法（保留现有 `from_signals` / `from_signals_with_sources` 供已有单测使用，内部共享统一逻辑）：
     - 直接复用预计算的 `Arc<CatalogIdf>`；
     - 不再遍历全库构建 `by_id`、`by_repo_name` 和全库 `aliases` `HashMap`——按需查 `CatalogService` 的 $O(1)$ `id` 索引与 `repo_name` 倒排索引（Issue 01 的 `by_repo`），且只收集实际 `seeds` 与候选比较需要用到的 `aliases`。
   - `commands/catalog_feed.rs::load_affinity_profile` 与 `get_affinity_profile_summary` 不再调用 `state.catalog.get_catalog_items()` 克隆全库。
3. **精选页 `by_id` 零克隆与种子 token 预提取 (`featured.rs`、`affinity.rs`)**：
   - `github/featured.rs:174-179` 的 `by_id` 改为 `HashMap<String, &AppSummary>`（或按切片下标索引），消除全量 `AppSummary` 克隆。
   - `featured.rs:240-300` 在对比候选前预先提取 `seed` 的词元集合，避免嵌套循环中每次候选比对都对同一 `seed` 重复执行 `similarity_tokens` 分词；打分阶段（`affinity.rs:1245-1300`）减少不必要的文本拼接。
   - 保持 `UserAffinityProfile` 数值结果（`category_weights`、`owner_weights`、`token_weights`、`seeds`、`affinity_boost`、`affinity_explain`）与现行 V2 算法（ADR-0024）逐位一致。

## Acceptance Criteria

- [ ] `get_home_feed`、`get_featured_page` 与 `get_affinity_profile_summary` 在目录未变更时不再重新执行全库 `CatalogIdf::from_catalog` 分词，也不克隆全库 `Vec<CatalogItem>`。
- [ ] `affinity_eval_tests`、`featured::tests` 与 `catalog_feed::tests` 全量回归通过，推荐分数与理由输出与重构前完全一致。
