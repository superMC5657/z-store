# Issue 01: `CatalogService` 哈希索引与只读借用收口

Status: resolved
Blocked by: none

## Summary

在 `CatalogService` 内部为远端精选目录（`items`）与本地库 overlay（`collected`）维护 `HashMap<String, usize>` 主键索引，并将单条检索、收录态判断、盖章与详情回写从 $O(N)$ 线性扫描 + 全量克隆优化为 $O(1)$ 查找。

## Scope

- Allowed to modify:
  - `src-tauri/src/github/mod.rs`
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/github/developer_starred.rs` (仅测试构造辅助 `test_service()`)
  - `src-tauri/src/commands/catalog_feed.rs` (仅测试构造 `CatalogService`)
  - `src-tauri/src/commands/catalog_search.rs` (仅测试更新目录写法)
- Do not modify:
  - `src/*` (前端代码)
  - `src-tauri/src/db/*`

## Implementation Details

1. **内部存储封装 (`CatalogStore` / `CatalogBucket`)**：
   - 将 `CatalogService` 的 `pub(crate) items` / `collected` 封装为带索引的内部结构（如 `CatalogBucket { items: Vec<CatalogItem>, index: HashMap<String, usize>, by_repo: HashMap<String, Vec<usize>> }`），每次替换 `items` 或 `collected` 时在写锁内一次性重建 `index`（`item.id -> idx`）。
   - 提供测试专用构造方法（如 `CatalogService::with_items_for_test`），替换 `catalog_feed.rs:598`、`developer_starred.rs:249`、`catalog_search.rs:1615` 中的直接字段字面量赋值。
2. **$O(1)$ 点查与零克隆盖章**：
   - `get_remote_catalog_item`、`get_collected_item` 通过 `index.get(&key)` 直接定位，不再 `.iter().find(...)`。
   - `is_cataloged`、`has_collected_key`、`resolve_catalog_stamp`、`get_repo_coordinates` 仅借用命中条目的标量字段（`is_verified`、`owner`、`repo`、`name` 等），不再克隆完整的 `CatalogItem`（含 `identifiers`/`aliases`/`install_dirs` 等堆集合）。
   - `update_catalog_item_from_detail` 与 `update_catalog_item_platforms` 通过 `index.get(&key)` 直接 `get_mut(idx)` 就地合并更新（若不修改 `id`，索引无需重建）。
3. **语义不变量**：
   - 保持 `Canonical App Id`（ADR-0010）入站归一化及远端优先覆盖规则（`remote` 蓝标优先、`local` 橘黄补位）完全一致。

## Acceptance Criteria

- [x] `CatalogService` 内部所有按 `id` 查找方法均为 $O(1)$ 哈希查找，无 `.iter().find(|i| i.id == key)` 线性扫描。
- [x] `is_cataloged` 与 `resolve_catalog_stamp` 不产生 `CatalogItem` 克隆。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 中所有目录、盖章与搜索相关单测全部通过。
