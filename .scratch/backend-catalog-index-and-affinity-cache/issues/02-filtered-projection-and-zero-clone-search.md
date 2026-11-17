# Issue 02: 按需过滤投影与零全库克隆搜索/开发者画像匹配

Status: needs-triage
Blocked by: 01

## Summary

消除 `merged_summaries()` 与 `get_catalog_items()` 在分类页、最新入库页、本地搜索及开发者主页中的整库深拷贝与无效 `AppSummary` 分配，改为在读锁内按谓词过滤后再构造响应结构体。

## Scope

- Allowed to modify:
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/commands/catalog_feed.rs`
  - `src-tauri/src/commands/catalog_featured.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/github/developer_profile.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **谓词过滤投影 `merged_summaries_filtered`**：
   - 在 `catalog_service.rs` 新增 `pub fn merged_summaries_filtered<F>(&self, mut pred: F) -> Vec<AppSummary> where F: FnMut(&CatalogItem) -> bool`。
   - 在单次遍历 `remote` 与 `collected`（使用 `seen` 去重与 `apply_stamp_flags`）时，先执行 `pred(item)`，仅命中项才调用 `item.to_summary()` 与盖章，避免为未命中分类、已隐藏应用或超出时间窗的条目分配 `AppSummary`。
   - `get_category_apps` (`catalog_feed.rs:322`)、`get_latest_catalog_apps` (`catalog_feed.rs:361`) 与 `get_home_feed` (`catalog_feed.rs:266`) 接入该方法（前置 `hidden_ids` 与分类/时间窗谓词）。
2. **零克隆本地搜索 (`search_local_catalog`)**：
   - `search_local_catalog` 不再调用 `self.get_catalog_items()` 深拷贝全部 `CatalogItem`；直接在读锁内按远端优先去重遍历切片，仅对 `score > 0`（或分类命中）的条目构造并盖章 `AppSummary`。
   - 分类预检（`filter_in_slice`）与关键词评分合并或复用同一 `remote + collected` 遍历，避免空命中时额外扫一遍；且只在非空命中后再排序返回。
3. **开发者画像与卸载命令 $O(1)$ 目录匹配 (`developer_profile.rs`、`installer_uninstall.rs`、`search.rs`)**：
   - 移除 `let catalog_list = self.get_catalog_items();`（`developer_profile.rs:169`）的全库克隆与内层 `catalog_list.iter().find(...)`。
   - `for r in repo_items` 直接对每个 `full_name` 调一次 `self.get_catalog_item(&full_name)`（$O(1)$ 查表）；离线兜底分支直接在 `CatalogService` 新增 `collect_by_owner(&self, owner: &str) -> Vec<DeveloperRepoItem>`（读锁内过滤），零全库克隆。
   - `commands/installer_uninstall.rs:135-140` 的 `uninstall_app` 回退分支将 `state.catalog.get_catalog_items().into_iter().find(|c| c.id == app_id)` 改为直接调用 `state.catalog.get_catalog_item(&app_id)`。
   - `github/search.rs:107-138` 的 `summaries_from_search` 传入 `probe = false`，内部无异步 I/O，将 `futures_util::future::join_all` 改为同步迭代构造以消除不必要的 Future 包装。

## Acceptance Criteria

- [ ] `get_category_apps`、`get_latest_catalog_apps`、`search_local_catalog` 与 `fetch_developer_profile_with_cache` 不再触发全库 `Vec<CatalogItem>` 克隆。
- [ ] 分页结果、`matched_ids` 与排序稳定性（`stars DESC, id ASC` 等）与现有行为完全一致。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
