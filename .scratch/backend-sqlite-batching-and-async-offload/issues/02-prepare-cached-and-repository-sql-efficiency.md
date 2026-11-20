# Issue 02: `prepare_cached` 语句复用与仓储/DAO SQL 效率优化

Status: resolved
Blocked by: none

## Summary

在 SQLite 连接访问层复用编译后的预编译语句（`prepare_cached`），优化全表反序列化与逐行更新的仓储/DAO 路径，减少无效 JSON 解析与历史裁剪子查询开销。

## Scope

- Allowed to modify:
  - `src-tauri/src/db/mod.rs`
  - `src-tauri/src/db/apps.rs`
  - `src-tauri/src/db/custom_apps.rs`
  - `src-tauri/src/db/history.rs`
  - `src-tauri/src/repositories/catalog_repo.rs`
  - `src-tauri/src/commands/installer_query.rs` (仅 `launch_app` 点查替换)
- Do not modify:
  - `src/*`

## Implementation Details

1. **`Database` 语句缓存 (`db/mod.rs`)**：
   - 将 `query_vec`、`query_scalar_opt`、`record_exists`、`exec_write` 底层从 `self.conn.prepare(sql)` / `self.conn.execute(sql, params)` 切换为 `self.conn.prepare_cached(sql)`（对动态拼接 `IN (...)` 长度可变的少量 SQL 保持 `prepare` 或限制分片档位，避免撑爆 LRU 容量；或提供 `query_vec_uncached` 给动态占位符查询，其余静态 SQL 统一走 `prepare_cached`）。
2. **`CatalogRepository::backfill_cataloged_flags` 轻量校准 (`repositories/catalog_repo.rs`)**：
   - 不再调用 `db.list_catalog_apps()` 与 `db.list_local_library_items()` 反序列化全库 JSON 列只为收集 ID。
   - 改为 `SELECT id FROM catalog_apps` + `SELECT id FROM custom_apps WHERE status IN ('collected', 'local_collected', 'submitted') AND archived = 0` 获取规范 ID 集合（或直接执行基于 `EXISTS` 的单条 SQL 更新并仅写入值发生变化的行）。
3. **主键点查、批量归档与事务合并**：
   - `db/apps.rs` 新增 `get_installed_app(&self, app_id: &str) -> Result<Option<InstalledApp>>`，替换 `commands/installer_query.rs::launch_app` 与 `commands/installer_uninstall.rs::uninstall_app` 中的全表 `get_installed_apps().into_iter().find(...)`。
   - `db/custom_apps.rs::retire_custom_apps_in_tx` 将逐条 `UPDATE custom_apps SET archived = 1 ...` 改为按分片 `WHERE id IN (...)` 批量更新。
   - `github/affinity.rs:494-510`（`apply_paginated_signal_outcome`）将循环内最多 100 次 `save_etag` / `touch_etag` / `delete_etag` 合并进 `db.with_immediate_transaction` 单事务提交。
   - 合并命令层冗余加锁：`commands/catalog_detail.rs` 移除 `fetch_detail_from_forge:755` 对 `project_from_cache` 的重复调用并合并 `platforms_lite_from_github` 连续加锁；`commands/updates_check.rs::get_cached_updates` 合并 3 次顺序 `state.db()` 加锁为单次；`commands/catalog_custom.rs` 合并 `save_custom_app`/`collect_local_app` 等操作与 `sync_catalog_overlay` 的连续加锁。
4. **按需裁剪历史表 (`db/history.rs`)**：
   - `record_search_query` / `record_app_view_at` 先查 `COUNT(*)` 或仅当超限（如每 N 次写入或行数超过 `limit + margin`）时执行 `prune_history_table` 子查询删除，避免每次写入都跑全表 `NOT IN` 子查询。

## Acceptance Criteria

- [x] `Database` 静态 SQL 统一走 `prepare_cached`，动态 `IN (...)` 不污染语句缓存。
- [x] `CatalogRepository::backfill_cataloged_flags` 不再反序列化 `catalog_apps` / `custom_apps` 的 JSON 字段。
- [x] `launch_app` 使用主键点查 `get_installed_app`；`retire_custom_apps_in_tx` 使用批量 `IN` 更新。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
