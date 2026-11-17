# Feature Spec: `CatalogService` 哈希索引化、按需投影与推荐画像 `CatalogIdf` 预计算

> 状态：Proposed（`needs-triage`）
> 关联契约：`CONTEXT.md`（`Curated Catalog`、`Canonical App Id`、`User Affinity Profile`、`Featured Shelf`）、ADR-0010（规范应用标识）、ADR-0013（发现页 Feed 契约）、ADR-0023（精选页可解释本地推荐）、ADR-0024（亲和度打分 v2）。

---

## 1. 问题背景与根因诊断

尽管前序 `perf-and-cache-hardening` 已将 `merged_summaries()` 改进为单趟遍历，但 `CatalogService` 与 `UserAffinityProfile` 仍存在大量全库线性扫描、整库深拷贝与重复分词开销：

### 1.1 `CatalogService` 缺少 `HashMap` 索引，单条查询退化为 $O(N)$ 线性扫描 + 全结构体克隆
- **现状**（`src-tauri/src/github/mod.rs:39-46`、`src-tauri/src/github/catalog_service.rs:292-326, 358-370, 490-531`）：
  - `CatalogService` 以两把独立的 `RwLock<Vec<CatalogItem>>` 存储远端精选目录（`items`）与本地库 overlay（`collected`），没有按 `id` 建哈希索引。
  - `get_remote_catalog_item`、`get_collected_item`、`has_collected_key`、`resolve_catalog_stamp`、`update_catalog_item_from_detail`、`update_catalog_item_platforms` 均对 `Vec<CatalogItem>` 执行 `.iter().find(|i| i.id == key)` 线性扫描，点查入口除 `has_collected_key` 外还每次 `.cloned()` 整条 `CatalogItem`（含 20+ 堆分配字段）。
  - 在 `get_repo_cards_batch`、`search_apps_online`、`get_installed_apps`、`get_recently_viewed_apps` 等循环点查场景下，累计产生 $O(K \cdot N)$ 扫描与克隆。

### 1.2 全库列表操作无条件克隆或全量构造 `AppSummary`
- **现状**（`catalog_service.rs:255-264, 390-421, 605-683`、`commands/catalog_feed.rs:266, 322, 361`、`github/developer_profile.rs:169-207`）：
  - `get_catalog_items()` 每次调用都将 `items` 与 `collected` 两个 `Vec<CatalogItem>` 全量克隆后再 `merge_remote_first`；被 `search_local_catalog`（每次按键）、`load_affinity_profile`、`get_affinity_profile_summary`、`scan_and_match_local_apps`、`fetch_developer_profile_with_cache` 高频调用。
  - `get_category_apps` 与 `get_latest_catalog_apps` 每次先调用 `merged_summaries()` 为全库所有 $N+M$ 个条目分配并构造 `AppSummary`，随后立刻按 `category` / `added_at` / `hidden_ids` / `allowed_ids` 过滤丢弃大部分结果。
  - `fetch_developer_profile_with_cache` (`developer_profile.rs:169-207`) 克隆全库 `catalog_list`，在内层 `for r in repo_items` 中对每个仓库做线性 `.find(...)` 且重复调用 `canonical_app_id(&full_name)`。

### 1.3 每次请求重建 `UserAffinityProfile` 与全库 `CatalogIdf`
- **现状**（`commands/catalog_feed.rs:210-234`、`github/affinity.rs:883-928`、`github/affinity_text.rs:369-388`）：
  - `get_home_feed`、`get_featured_page`、`get_affinity_profile_summary` 每次执行都先克隆全库 `CatalogItem`，再于 `UserAffinityProfile::from_signals_with_sources` 中遍历全库运行 `CatalogIdf::from_catalog`（拼接文本 + `strip_urls` + 中英双语分词 + `HashMap` 统计文档频率），并重建 `by_id`、`by_repo_name` 与全库 `aliases` 映射。
  - 事实上 `Curated Catalog` 与本地库 overlay 仅在启动、清单同步（每日一次）及本地收录 CRUD 时变更，全库 `CatalogIdf` 与索引在两次目录变更之间完全恒定。

---

## 2. 优化目标与设计方案

1. **内部索引化与只读借用访问（Issue 01）**：
   - 将 `CatalogService` 内部存储收敛为带 `id -> index` `HashMap` 索引的结构（并合并/协调远端与本地库访问），使 `get_catalog_item`、`get_remote_catalog_item`、`get_collected_item`、`is_cataloged`、`resolve_catalog_stamp`、`get_repo_coordinates`、`update_catalog_item_from_detail`、`update_catalog_item_platforms` 全部达到 $O(1)$ 查找，且只读判断与盖章零 `CatalogItem` 克隆。
2. **按需过滤投影与零全库克隆本地搜索（Issue 02）**：
   - 提供 `merged_summaries_filtered(&self, predicate)` 在读锁内先过滤（分类、日期窗、隐藏集、平台允许集）再只对命中条目构造 `AppSummary`。
   - `search_local_catalog` 与 `fetch_developer_profile_with_cache` 直接在读锁或轻量索引上检索，消除整库 `Vec<CatalogItem>` 克隆；同时避免 `search_in_slice` 内重复 `.to_lowercase()`。
3. **预计算 `Arc<CatalogIdf>` 与零克隆画像构建（Issue 03）**：
   - 在目录更新入口（`sync_from_db`、`sync_collected_from_db`、`update_items`、`set_collected_items`）同步（或版本化懒）构建并缓存 `Arc<CatalogIdf>` 与 `repo -> indices` 倒排映射。
   - `UserAffinityProfile::from_signals_with_sources` 接受预计算 `Arc<CatalogIdf>` 与目录索引/切片引用，`load_affinity_profile` 与 `build_affinity_profile_summary` 不再每次克隆全库或重跑全库分词，仅对命中种子提取 `aliases`。

---

## 3. 实施 Issue 拆分清单

- [`01-catalog-service-hash-index-and-lock-consolidation.md`](./issues/01-catalog-service-hash-index-and-lock-consolidation.md)
- [`02-filtered-projection-and-zero-clone-search.md`](./issues/02-filtered-projection-and-zero-clone-search.md)
- [`03-precomputed-catalog-idf-and-borrowed-affinity-build.md`](./issues/03-precomputed-catalog-idf-and-borrowed-affinity-build.md)
