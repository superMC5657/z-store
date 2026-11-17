# Issue 02: 设置键白名单零分配、错误边界统一与启动降级可观测性

Status: needs-triage
Blocked by: none

## Summary

消除 `commands/settings.rs` 每次白名单校验重建整张 `HashMap` 的高频堆分配，统一部分仍返回 `Result<_, String>` 的命令至 `crate::AppResult<T>`，并补全启动种子解析与内存库降级的可观测性。

## Scope

- Allowed to modify:
  - `src-tauri/src/commands/settings.rs`
  - `src-tauri/src/commands/catalog_feed.rs`
  - `src-tauri/src/commands/network.rs`
  - `src-tauri/src/commands/catalog_detail.rs`
  - `src-tauri/src/repositories/catalog_repo.rs`
  - `src-tauri/src/lib.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **设置白名单零堆分配 (`commands/settings.rs`)**：
   - 定义静态常量切片 `const MANAGED_SETTING_KEYS: &[&str] = &[...]`，让 `is_managed_setting_key(key)` 直接做 `MANAGED_SETTING_KEYS.contains(&key)`，不再每次调用 `get_default_settings()` 分配 18 个 `String` 键值对。
   - 新增单元测试，断言 `get_default_settings().keys()` 与 `MANAGED_SETTING_KEYS` 集合完全相等，防止后续新增设置项时发生漂移。
2. **统一 `AppResult<T>` 命令错误边界**：
   - 将 `commands/catalog_feed.rs::get_home_feed`（L263）、`commands/network.rs::fetch_trends_text`（L239）以及内部辅助 `commands/catalog_detail.rs::get_app_details_impl` 收敛为 `crate::AppResult<T>`（对前端 IPC 序列化结果完全同构，仅在 Rust 内部支持 `?` 统一传播 `AppError`）。
3. **启动种子解析与 DB 内存降级可观测性**：
   - `CatalogRepository::seed_from_config_if_empty`（`repositories/catalog_repo.rs:12-19`）在本地/外部 `catalog.json` 反序列化失败时显式记录 `log::warn!`（目前 `.unwrap_or_default()` 静默吞错）。
   - 在 `AppState` 或启动日志中保留 `db_mode`（`"disk"` vs `"memory"`）及失败原因摘要，避免磁盘数据库异常打开失败后静默退化为内存模式而难以排查。

## Acceptance Criteria

- [ ] `is_managed_setting_key` 零堆分配，且有单测保证与 `get_default_settings()` 键集 100% 同步。
- [ ] `get_home_feed` 与 `fetch_trends_text` 返回 `crate::AppResult<T>`，与其余 Tauri commands 保持一致。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 全部通过。

## Comments

- 2026-11-18 实现：DB 降级不新增 `AppState` 字段，启动横幅已含 `db_mode`，降级时追加一条 `app` 错误宽事件（`db_mode` + `reason` 摘要）。
