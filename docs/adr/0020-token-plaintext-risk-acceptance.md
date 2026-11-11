# ADR-0020：令牌本地明文存储的风险接受

- 状态：Accepted
- 日期：2026-10-21
- 关联：D2、ADR-0018、`get_settings` / `save_setting` 白名单
- 范围：后端存储与 IPC 暴露面（`user_settings.github_oauth_token`、`host_tokens` 表）+ 前端备份导出（`DataBackupRow`）

## 1. 背景

应用本地 SQLite 存储两类认证表项：OAuth 访问令牌（`user_settings` 表 `github_oauth_token` 键，随设备授权流程写入）与各主机速率/只读令牌表（`host_tokens` 表：后端写入各主机 Rate Limit 配额快照，并在存在非空 `token` 行时按只读方式使用）。在单用户桌面应用场景下（OAuth 权限限定为 `public_repo user`，见 `oauth/constants.rs::OAUTH_SCOPE`），OS 级用户凭据库（Windows DPAPI / macOS Keychain / Linux Secret Service）无法阻止同用户下的任意进程直接解密或读取内存，引入跨平台 keystore 的依赖、迁移与故障恢复复杂度高于实际边际收益，因此采用 SQLite 明文持久化并严格收口 IPC 与备份导出边界。

## 2. 决策

1. **令牌采用 SQLite 明文存储，不引入 keystore**：明确接受本地磁盘及同用户进程读取风险，聚焦 IPC 与备份通道隔离。
2. **IPC 暴露面严格收口**：凭据不经通用设置 IPC 进出——`get_settings` 只回传 UI 设置键白名单、`save_setting` 只接受同源白名单；OAuth 模块命令仅回传登录状态与用户信息（不回传 access_token 明文）；`host_tokens` 表仅由后端内部读取或更新配额快照，无前端 PAT 读写与测试命令。
3. **备份文件不携带凭据**：导出侧（`DataBackupRow` 的 `buildBackupSettings`）按枚举字段组装，`BACKUP_EXCLUDED_KEYS` 排除凭据键；导入侧（`userdata/import.rs::IMPORT_SETTINGS_ALLOWLIST`）拒绝所有非白名单凭据键。恢复备份后需要重新授权登录。

## 3. 后果

- 同用户恶意进程可读取本地库中的令牌，此风险已被明确接受；缓解依赖 IPC 收口（决策 2）缩小暴露面。
- 备份 JSON 不含凭据键由前端单测锁定（`DataBackupRow.backup.test.ts`）。
- 重审触发条件：引入云同步、多用户共享设备支持，或令牌权限升级到可写仓库内容时，需重新评估 keystore 方案并重开本决策。
