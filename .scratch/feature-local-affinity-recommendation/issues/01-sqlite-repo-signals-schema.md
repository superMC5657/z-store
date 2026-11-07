# Issue 01: SQLite `user_repo_signals` 表结构与一期 `RawAffinitySignals` 本地读写层

Status: resolved
Blocked by: none

## 背景

为了在零服务端的前提下维护用户的开源偏好画像，一期需要在本地 SQLite (`z_store.db`) 中持久化用户登录后同步到的 GitHub Starred / Forked / Owned 仓库特征（`language`、`description`、`stars`、`forks`），并提供一次性读取一期全量显式信号（GitHub `user_repo_signals`、应用内 `user_stars`、`user_favorites`、`watched_apps`）的高效读口。
（注：点击浏览 `view_history`、搜索历史 `search_history` 与停留时长等交互数据划归二期，一期不读取。）

## 目标

1. 在 `src-tauri/src/db/schema.rs` 的 `init_schema` 中幂等创建 `user_repo_signals` 表及 `idx_user_repo_signals_updated_at` 索引：
   - 主键 `(full_name, relation)`，其中 `relation` 取值为 `'starred'` | `'forked'` | `'owned'`。
2. 新建 `src-tauri/src/db/affinity.rs` 并在 `src-tauri/src/db/mod.rs` 导出 `UserRepoSignal` 与 `RawAffinitySignals`：
   - `Database::upsert_user_repo_signals(&self, signals: &[UserRepoSignal]) -> Result<()>`
   - `Database::replace_user_repo_signals_by_relations(&self, relations: &[&str], signals: &[UserRepoSignal]) -> Result<()>`
   - `Database::remove_user_repo_signal(&self, full_name: &str, relation: &str) -> Result<()>`
   - `Database::clear_github_account_signals(&self) -> Result<()>`（事务清理 `user_repo_signals`、`user_stars` 及 `affinity_github_synced_at` 设置项）
   - `Database::get_user_repo_signals(&self) -> Result<Vec<UserRepoSignal>>`
   - `Database::load_raw_affinity_signals(&self) -> Result<RawAffinitySignals>`（一期严格聚合 `user_repo_signals`、`user_stars`、`user_favorites`、`watched_apps` 四类数据）。

## 范围（互斥）

- 允许修改：`src-tauri/src/db/schema.rs`、`src-tauri/src/db/affinity.rs`（新建）、`src-tauri/src/db/mod.rs`。
- 禁止触碰：`src-tauri/src/github/*`、`src-tauri/src/commands/*`、`src/*`。

## 验收标准

- [x] 新建与存量内存数据库经 `init_schema()` 后均包含 `user_repo_signals` 表，`schema_migration_tests` 全部通过。
- [x] 单测覆盖 `upsert_user_repo_signals`、`replace_user_repo_signals_by_relations`、`clear_github_account_signals` 与 `load_raw_affinity_signals`。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib db::` 全部通过。
