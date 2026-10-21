# Issue 03: 多平台 Token 管理与 API 速率感知器

Status: resolved

## 描述

实现多代码托管平台的独立访问令牌管理与速率限制监测：
1. 数据库存储：
   - SQLite 新增 `host_tokens` 表：
     `host TEXT PRIMARY KEY, token TEXT NOT NULL, rate_limit_remaining INTEGER, rate_limit_limit INTEGER, rate_limit_reset INTEGER, updated_at INTEGER NOT NULL`；
   - 提供增删改查方法，自动迁移旧 `settings` 表中的 `github_token`。
2. Tauri IPC 命令：
   - `get_host_tokens() -> Result<Vec<HostTokenEntry>, String>`
   - `set_host_token(host: String, token: String) -> Result<(), String>`
   - `remove_host_token(host: String) -> Result<(), String>`
   - `test_host_connection(host: String, token: Option<String>) -> Result<HostRateLimitStatus, String>`
3. 单元测试覆盖 Token 持久化与速率限制响应头解析。

## Comments

- 支持感知响应头 `x-ratelimit-remaining` (GitHub) 与 `x-ratelimit-remaining` (Gitea)。

## Answer

已完成多平台 Token 独立管理与 API 速率感知闭环：
1. 在 SQLite 中新建 `host_tokens` 表，实现了主机 Token 增删查改与速率配额更新持久化；
2. 在 `commands.rs` 中实现了 `get_host_tokens`、`set_host_token`、`remove_host_token` 以及支持 GitHub/Gitea/Codeberg 连通性测试与配额检测的 `test_host_connection` 命令；并在 `lib.rs` 中完成 IPC 注册；
3. `search_apps` 与 `get_app_details` 已接入多源 URL 自动嗅探与 Token 动态注入；
4. 单元测试 `test_host_tokens_crud` 验证通过。

