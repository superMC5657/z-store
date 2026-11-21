# Issue 01: 删除浅层 `CatalogRepository` 并将精选目录与本地库状态变迁收口至 `CatalogService`

Status: resolved
Blocked by: none

## Summary

当前 `src-tauri/src/repositories/catalog_repo.rs`（101 行非测试代码）未通过 `codebase-design` 删除测试（Deletion Test）：其 4 个生产函数各自仅有唯一调用点，另有 1 个零调用死函数 `CatalogRepository::is_cataloged`，且不持有内存 `CatalogService`。这迫使 `commands/catalog_sync.rs`、`commands/catalog_custom.rs` 与 `lib.rs` 在外部手工串联 5 项强耦合不变量：

1. SQLite `catalog_apps` / `custom_apps` 写入；
2. 内存 `CatalogStore`（远端精选 + 本地库 overlay + 预计算 `CatalogDerived` IDF/别名缓存）同步；
3. `user_favorites` 与 `watched_apps` 的 `is_cataloged` 标记回填；
4. `app_icon_cycles` 的 `is_cataloged` 与 `l1_url` 槽位同步；
5. 已收录应用从 `repo_card_cache` 剔除（`purge_cataloged_repo_cards`）——其中 `commands/catalog_custom.rs::save_custom_app` 在重存已处于 `collected` / `submitted` 状态的本地库条目时遗漏了 `purge_cataloged_repo_cards()`，且跨命令依赖 `commands::history::backfill_cataloged_flags_in`。

本工单删除 `CatalogRepository`，将上述 5 项状态变迁不变量全部收口进深模块 `CatalogService` 的统一 **interface**。

## Scope

- Allowed to modify:
  - `src-tauri/src/repositories/mod.rs`（移除 `catalog_repo` 导出）
  - `src-tauri/src/repositories/catalog_repo.rs`（删除文件，将其有效测试迁移至 `CatalogService` 测试中）
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/commands/catalog_custom.rs`
  - `src-tauri/src/commands/catalog_sync.rs`
  - `src-tauri/src/commands/history.rs`
  - `src-tauri/src/commands/mod.rs`
  - `src-tauri/src/lib.rs`（仅启动期目录初始化与 `backfill_cataloged_flags` 调用点）
- Do not modify:
  - `src/` 前端代码
  - `src-tauri/src/commands/catalog_detail.rs`（留待 Issue 03 处理）
  - `src-tauri/src/db/schema.rs`

## Implementation Details

1. **在 `CatalogService`（`src-tauri/src/github/catalog_service.rs`）内聚目录持久化与内存同步接口**：
   - 新增启动初始化入口 `initialize_from_db(&self, db: &Database)`：执行空库种子播种（原 `seed_from_config_if_empty`）、加载 `catalog_apps` + `custom_apps` 本地库至内存 `CatalogStore`、校准收藏/关注 `is_cataloged` 标记（原 `backfill_cataloged_flags`），并执行 `db.purge_cataloged_repo_cards()`。
   - 新增远端清单原子应用入口 `apply_remote_manifest(&self, db: &Database, items: &[CatalogItem], etag_entry: Option<(&str, &str, i64)>) -> rusqlite::Result<Vec<String>>`：在单事务内覆盖 `catalog_apps`、退役已转正（`Graduated`）草稿、校准 `is_cataloged`、清理已收录 `repo_card_cache` 行并可选写入 `ETag Cache`，事务提交后立即刷新 `self` 内存目录。
   - 新增 `Local Library` / `Draft` 生命周期变更方法（均接收 `&Database` 并在内部统一执行图标轮换槽同步、`purge_cataloged_repo_cards`、`is_cataloged` 回填与 `sync_collected_from_db`）：
     - `save_custom_draft(&self, db: &Database, item: CatalogItem) -> crate::AppResult<CustomAppEntry>`（当保存后条目处于 `is_local_library_status` 时同步图标槽**并补齐 `db.purge_cataloged_repo_cards()`**）
     - `collect_local_app(&self, db: &Database, id: &str) -> crate::AppResult<CustomAppEntry>`
     - `revert_collected_to_draft(&self, db: &Database, id: &str) -> crate::AppResult<CustomAppEntry>`
     - `withdraw_submitted(&self, db: &Database, id: &str) -> crate::AppResult<CustomAppEntry>`
     - `mark_submitted(&self, db: &Database, id: &str, pr_url: &str) -> crate::AppResult<CustomAppEntry>`
     - `delete_custom_app(&self, db: &Database, id: &str) -> crate::AppResult<bool>`
2. **删除 `CatalogRepository` 并清理跨命令引用**：
   - 删除 `src-tauri/src/repositories/catalog_repo.rs`，更新 `repositories/mod.rs`。
   - `commands/catalog_custom.rs` 的 6 个写命令收敛为薄 IPC **adapter**，不再直接拼接 `sync_custom_app_cache_and_cycle`、`reset_custom_app_cycle_uncataloged` 或调用 `commands::history::backfill_cataloged_flags_in`。
   - `commands/catalog_sync.rs::apply_manifest_to_db` 直接委托 `state.catalog.apply_remote_manifest(...)`。
   - 移除 `commands/history.rs` 中的 `backfill_cataloged_flags` / `backfill_cataloged_flags_in` 辅助函数（`lib.rs` 启动路径统一走 `catalog.initialize_from_db(&db)`）。
3. **测试策略（`local-substitutable`，Replace Don't Layer）**：
   - 将原 `catalog_repo.rs` 的事务、转正退役、ETag 同事务测试迁入 `CatalogService` 单测，基于 `Database::open_in_memory()` 通过 `CatalogService` 外部 **interface** 一次性断言 DB 行、内存 `is_cataloged` / `get_catalog_item`、`user_favorites` 标记、`app_icon_cycles` 与 `repo_card_cache` 清理（含重存已收录本地库条目清理 `repo_card_cache` 的回归用例）。

## Acceptance Criteria

- [ ] `src-tauri/src/repositories/catalog_repo.rs` 已删除，全仓无 `CatalogRepository` 残留引用，无 `commands/catalog_custom.rs -> commands/history.rs` 跨命令依赖。
- [ ] `CatalogService` 单测覆盖：远端清单应用（含转正退役 + ETag 同事务 + `repo_card_cache` 清理）、`collect_local_app` / `save_custom_draft`（活跃本地库重存触发 `purge_cataloged_repo_cards`）/ `revert_collected_to_draft` / `delete_custom_app` 的内存与 SQLite 原子一致性。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` 全部通过。
