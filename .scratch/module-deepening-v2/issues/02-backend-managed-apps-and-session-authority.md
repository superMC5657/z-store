# Issue 02: 下沉 `InstalledApp` 生命周期至 `installer/` 并统一 `oauth/` 凭据与 401 会话清理权威

Status: ready-for-agent
Blocked by: 01

## Summary

解决后端已安装管理与账号凭据两处跨模块泄漏与逻辑漂移：

1. **`InstalledApp` ↔ `Update Rule` ↔ `update_results` 三向命令环**：
   - `commands/installer_query.rs`（502 行，仅 2 个 `#[tauri::command]`）与 `commands/updates_check.rs`、`commands/installer_uninstall.rs` 互相调用（`load_installed_apps` ↔ `should_include_update` ↔ `hide_ghost_apps`）；
   - 6 个命令文件各自手工维护 `save_installed_app` / `remove_installed_app` 后的 `remove_update_result` 或 `rebase_cached_update`，而 `commands/updates_rules.rs` 修改规则后未重算快照；
   - Linux 可执行文件定位（`.desktop` + `which`）在 `installer_install.rs` 与 `installer_query.rs` 重复实现，Windows 桌面 `.lnk` 路径推导在 `installer_query.rs` 与 `installer_uninstall.rs` 重复实现。
2. **手动登出与 401 自动失效的双轨会话清理已发生隐私缓存漂移**：
   - `oauth::clear_oauth_session` 会清理 `/user/` 前缀 `ETag Cache` 与 `clear_launchpad_viewer_upvotes()`，并回填 `github.com` 主机令牌；
   - 而 `lib.rs` `setup()` 闭包内的 401 `auth_rx` 后台协程手写另一套清理逻辑，**遗漏了 `delete_etags_by_prefix("https://api.github.com/user/")` 与 `clear_launchpad_viewer_upvotes()`**，且在存在 `github.com` 主机令牌时仍将 `*state.github_token` 清为 `None`，并因嵌在 Tauri 启动闭包中无法单测；
   - 5 处非 GitHub `host_tokens` 查询散落在 `commands/*`，空白字符裁剪口径不一致。

## Scope

- Allowed to modify:
  - `src-tauri/src/installer/mod.rs`
  - `src-tauri/src/installer/managed.rs`（新增）
  - `src-tauri/src/installer/paths.rs`
  - `src-tauri/src/installer/tests.rs`
  - `src-tauri/src/oauth/mod.rs`
  - `src-tauri/src/oauth/tests.rs`
  - `src-tauri/src/commands/installer_query.rs`
  - `src-tauri/src/commands/installer_install.rs`
  - `src-tauri/src/commands/installer_uninstall.rs`
  - `src-tauri/src/commands/scanner.rs`
  - `src-tauri/src/commands/updates_rules.rs`
  - `src-tauri/src/commands/oauth.rs`
  - `src-tauri/src/commands/mod.rs`
  - `src-tauri/src/lib.rs`
- Do not modify:
  - `src/` 前端代码
  - `src-tauri/src/commands/catalog_detail.rs`（在 Issue 03 切换至统一凭据解析口）
  - `src-tauri/src/commands/catalog_search.rs`（在 Issue 04 处理）

## Implementation Details

1. **在 `src-tauri/src/installer/` 下沉已纳管应用生命周期深模块（`managed.rs` + `paths.rs`）**：
   - 将 Windows 桌面目录与 `.lnk` 定位、Linux `.desktop` / `which` 可执行文件定位统一收口至 `installer/paths.rs`，消除 `installer_install.rs`、`installer_query.rs`、`installer_uninstall.rs` 三处重复。
   - 在 `installer/managed.rs` 封装 `InstalledApp` 盘点自愈（注册表时间回填、幽灵路径隐去、版本号同步）、应用启动路径解析，以及原子化状态写入口：
     - 记录安装/纳管导入/卸载/取消纳管时统一同步清理或重算 `update_results`；
     - 将纯判定 `should_include_update(current_version, latest_version, rule)` 下沉至 `installer::managed`（供 `installer` 与 `updates_check` 共用，彻底切断 `commands/installer_query.rs ↔ commands/updates_check.rs` 互引）；
     - `set_app_skip_version` / `set_app_frozen` / `set_app_hidden` 经同一模块持久化规则并同步对齐 `update_results`。
   - `commands/installer_query.rs`、`installer_install.rs`、`installer_uninstall.rs`、`scanner.rs`、`updates_rules.rs` 瘦身为薄 IPC **adapter**。
2. **在 `src-tauri/src/oauth/mod.rs` 建立统一凭据与会话权威**：
   - 提供统一令牌解析函数：
     - `resolve_github_token(db: &Database, token_cache: &Mutex<Option<String>>) -> Option<String>`（收口 `AppState::active_github_token` 与 `lib.rs` 启动读取）；
     - `resolve_host_token(db: &Database, forge: ForgeType, host: &str, token_cache: &Mutex<Option<String>>) -> Option<String>`（GitHub 走 OAuth 优先 + `github.com` 主机令牌回退，其他 Forge 统一 `trim` 并过滤空串读取 `host_tokens`）。
   - 提供单一会话吊销入口 `revoke_oauth_session(db: &Database, token_cache: &Mutex<Option<String>>, reason: RevokeReason) -> Result<Option<String>, String>`：
     - `RevokeReason::ManualLogout`：移除 `SETTING_OAUTH_TOKEN` 与 `SETTING_OAUTH_USER`，清理 GitHub 画像信号、`/user/` 前缀 `ETag Cache`、无主机令牌回退时的私有快照（`@me:` Star 快照、私有 `repo_card_cache`、私有 `search_list_cache`）及 `launchpad` 本人顶帖态，并将回退主机令牌回填至 `token_cache`；
     - `RevokeReason::AuthExpired401`：与手动登出共享同一清理内核（修复缺失的 `/user/` `ETag Cache` 删除、`clear_launchpad_viewer_upvotes()` 与主机令牌回填），仅将 `SETTING_OAUTH_USER` 标记为 `is_expired = true`（损坏 JSON 自动清除）。
   - `lib.rs` 的 `auth_rx` 协程改为一行调用 `oauth::revoke_oauth_session(..., RevokeReason::AuthExpired401)` 后发射 `zstore://oauth-expired`。
   - 收敛 `apply_star_mutation(db: &Database, owner: &str, repo: &str, starred: bool, adjust_launchpad_delta: bool)`，消除 `commands/oauth.rs` 双次查询 `is_starred` 与手工拼接 `adjust_launchpad_repo_stars`。

## Acceptance Criteria

- [ ] `commands/installer_query.rs`、`commands/installer_uninstall.rs`、`commands/installer_install.rs` 不再互相导入或导入 `commands/updates_check.rs`。
- [ ] `oauth/tests.rs` 基于 `Database::open_in_memory()` 直接覆盖 `RevokeReason::ManualLogout` 与 `RevokeReason::AuthExpired401`（验证 401 失效同样删除 `/user/` ETag、清除 `launchpad` 顶帖标记，且在配置了 `github.com` 主机令牌时保留回退令牌并保护私有缓存口径）。
- [ ] `installer/tests.rs` 覆盖安装、卸载、规则变更与 `update_results` 快照一致性。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` 全部通过。
