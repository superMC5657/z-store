# Issue 02: GitHub 首次登录与跨周期启动静默增量同步及 `zstore://affinity-updated` 事件通道

Status: resolved
Blocked by: 01

## 背景

用户在完成 GitHub OAuth 登录（或配置 PAT）后，客户端需要在后台自动静默拉取其 GitHub `starred` 仓库与个人 `repos`（含 `fork` 仓库与自有仓库），提取每个仓库的 `stars`、`forks`、`language`、`description` 存入本地 `user_repo_signals` 表。
同时，若用户半个月或数周后再次打开应用，期间在 GitHub 网页端新 Star 或 Fork 了仓库，客户端在启动时需通过冷却时间戳（`affinity_github_synced_at`）+ `api_etag_cache`（`If-None-Match` 条件请求）自动完成低频增量同步，并在信号更新后通知前端刷新推荐流。

## 目标

1. **扩展 `GitHubRepoResponse`**（`src-tauri/src/github/models.rs`）：
   - 增加 `#[serde(default)] pub fork: Option<bool>` 字段，用于区分用户在 `/user/repos?type=owner` 下是自建仓库（`owned`）还是 Fork 仓库（`forked`）。
2. **实现 ETag 感知的静默增量同步**（`CatalogService::sync_github_affinity_signals`）：
   - 端点 1：`https://api.github.com/user/starred?per_page=100`
   - 端点 2：`https://api.github.com/user/repos?type=owner&sort=updated&per_page=100`
   - 复用 `api_etag_cache` 表读取 `etag` 与 `payload_json`，经 `CatalogService::get_with_etag` 发送 `If-None-Match` 条件请求；远端未变更返回 `304 Not Modified` 时零配额恢复，返回 `200 OK` 时更新 ETag 与 `user_repo_signals` 表，并刷新 `user_settings.affinity_github_synced_at`。
3. **建立全局事件广播通道 `GLOBAL_AFFINITY_TX`**（`src-tauri/src/lib.rs`）：
   - 提供 `crate::notify_affinity_updated()`，向前端发射 `zstore://affinity-updated` 事件。
4. **接入一期触发点（不含点击/搜索）**：
   - **首次登录 / 令牌配置**：`oauth_device_poll`（授权成功时后台静默同步并广播）、`set_host_token`；
   - **跨周期重开 / 启动保鲜**：`lib.rs` 启动 `setup` 中检查已保存 token 及 `affinity_github_synced_at`，若距上次同步超过 6 小时（`21600s`，涵盖隔天、隔半个月再打开等场景），后台静默执行一次 `sync_github_affinity_signals` 并广播；
   - **账号退出**：`oauth_logout`（调用 `clear_github_account_signals` 并广播）；
   - **应用内 Star / 收藏 / Watch 变更**：`star_app` / `unstar_app` / `sync_github_starred` / `toggle_favorite` / `watch_app` / `unwatch_app` 完成后广播 `notify_affinity_updated()`。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/models.rs`、`src-tauri/src/github/affinity.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/commands/oauth.rs`、`src-tauri/src/commands/forge.rs`。
- 禁止修改：`src-tauri/src/commands/history.rs`（点击/搜索留待二期）、`src/*`，且不新增任何 `#[tauri::command]` 函数（保持 `cmdAlignment.test.ts` 对齐）。

## 验收标准

- [x] Mock Server 单测验证 `sync_github_affinity_signals` 发送 `If-None-Match`、正确区分 `starred` / `forked` / `owned` 三类信号并落库，且 304 响应不触发重复解析错误。
- [x] 验证冷却过期场景（如 `affinity_github_synced_at` 为 15 天前）会触发增量同步并更新时间戳。
- [x] `oauth_logout` 后 `user_repo_signals` 与 `user_stars` 为空。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 通过。
