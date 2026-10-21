# Issue 01: SQLite 新增版本策略表与查询过滤逻辑

Status: resolved

## 描述

在嵌入式本地 SQLite 数据库中引入规则策略支持：
1. 新建 `update_rules` 表：
   ```sql
   CREATE TABLE IF NOT EXISTS update_rules (
       app_id TEXT PRIMARY KEY,           -- "owner/repo"
       skipped_version TEXT,              -- 跳过的最新版本号 (如 "v2.5.0")
       is_frozen INTEGER NOT NULL DEFAULT 0, -- 1 为永久锁定当前版本
       is_hidden INTEGER NOT NULL DEFAULT 0, -- 1 为在探索/更新中隐藏
       updated_at INTEGER NOT NULL
   );
   ```
2. 改造 `src-tauri/src/db.rs`：
   - 实现 `set_skip_version(app_id, version)`、`set_frozen_status(app_id, bool)`、`set_hidden_status(app_id, bool)`。
   - 实现 `get_all_rules()` 与 `get_rule(app_id)`。
3. 联动版本检测逻辑：
   - 当探测到最新版本 == `skipped_version` 时，自动从可更新应用列表中过滤掉该更新；
   - 当 `is_frozen == 1` 时，直接忽略该软件的更新提示。
4. 编写 Rust 单元测试验证跳过逻辑与取消跳过逻辑。

## Comments

- 保持向下兼容，建表使用 `IF NOT EXISTS`。

## Answer

已在 `src-tauri/src/models.rs` 中定义 `UpdateRule`，在 `src-tauri/src/db.rs` 中建立 `update_rules` 数据表并实现 `get_rule`、`get_all_rules`、`set_skip_version`、`set_frozen_status`、`set_hidden_status`、`remove_rule`。
在 `src-tauri/src/commands.rs` 中抽象并接入 `should_include_update` 过滤逻辑，当 `is_frozen`、`is_hidden` 或 `skipped_version == latest_version` 时自动忽略更新提示，并在 `search_apps` 中过滤已隐藏应用。新增 5 个 Tauri IPC 命令（`get_update_rules`、`set_app_skip_version`、`set_app_frozen`、`set_app_hidden`、`remove_update_rule`），单元测试 `test_update_rules_crud` 与 `test_should_include_update` 全部通过。
