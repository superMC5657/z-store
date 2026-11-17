# Issue 03: 更新规则错误传播、Markdown/扫描器局部性能与 Cargo 构建优化

Status: needs-triage
Blocked by: none

## Summary

修复更新/隐藏规则在 DB 失败时静默退化为空集导致误报更新或暴露隐藏应用的问题，优化 `markdown.rs` 与 `scanner/` 的高复杂度热点，并精简 `Cargo.toml` 依赖特性与 Release 编译配置。

## Scope

- Allowed to modify:
  - `src-tauri/src/commands/updates_check.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/commands/catalog_feed.rs`
  - `src-tauri/src/commands/catalog_featured.rs`
  - `src-tauri/src/github/markdown.rs`
  - `src-tauri/src/scanner/registry.rs`
  - `src-tauri/src/scanner/executable.rs`
  - `src-tauri/src/installer/paths.rs`
  - `src-tauri/Cargo.toml`
- Do not modify:
  - `src/*`

## Implementation Details

1. **禁止静默丢弃更新规则与隐藏规则 (`updates_check.rs` & `catalog_search.rs`)**：
   - `check_for_updates` (`updates_check.rs:306`) 与 `get_cached_updates` (`updates_check.rs:479`) 读取 `db.get_all_rules()` 失败时不再 `.unwrap_or_default()`，改为传播错误（`?`）或 fail-closed 中止，防止已冻结/已跳过版本的应用误报更新。
   - `hidden_rule_ids` (`catalog_search.rs:169-180`) 返回 `Result<HashSet<String>, String>`（或记 warn 并让命令传播 DB 错误），避免 DB 锁异常时把已隐藏应用暴露在首页/搜索/分类视图。
   - `notify_watched_updates` (`updates_check.rs:668-672`) 合并前置 DB 读取；当 `daily` 节流查询失败时保守跳过通知而非绕过节流。
2. **Markdown 提取惰性切行与静态正则 (`github/markdown.rs:250-301`)**：
   - 将 `raw_markdown.lines().collect::<Vec<_>>()` 改为 `raw_markdown.lines().take(40).collect::<Vec<_>>().join("\n")`，避免对大 README 切分全部行。
   - 用静态 `LazyLock<Regex>` 捕获 `<p align="center">...</p>` 与 `<div align="center">...</div>` 的内部标签并与 `full_tag` 比较，移除循环内 `Regex::new` 动态编译。
3. **扫描器与卸载路径查表降复杂度 (`scanner/registry.rs`、`scanner/executable.rs`、`installer/paths.rs`)**：
   - `scanner/registry.rs::is_path_covered` (`L209-228, L324-338`) 预建归一化路径 `HashSet`，将 $O(S \times N)$ 降为 $O(S + N)$。
   - `scanner/executable.rs:436-532` 在 `resolve_installed_app_path` 传入已扫描 `.lnk` 缓存或避免第 5 步重复遍历桌面/开始菜单快捷方式；`installer/paths.rs` 批量场景支持复用已枚举的注册表卸载表。
4. **`Cargo.toml` 特性精简与 Release 配置**：
   - 将 `tokio = { version = "1", features = ["full"] }` 收窄为实际使用的特性集（如 `["rt-multi-thread", "macros", "sync", "time", "fs", "io-util", "process"]`）。
   - 添加 `[profile.release]` 优化（`lto = "thin"`、`codegen-units = 1`、`strip = "symbols"`），降低产物大小并提升内联性能。

## Acceptance Criteria

- [ ] `check_for_updates` / `get_cached_updates` / `hidden_rule_ids` 在 DB 读取规则失败时不再静默返回空规则集。
- [ ] `markdown.rs` 不再在循环内调用 `Regex::new`。
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
