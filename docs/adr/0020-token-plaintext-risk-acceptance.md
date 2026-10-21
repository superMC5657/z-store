# ADR-0020：令牌本地明文存储的风险接受

- 状态：Accepted
- 日期：2026-10-21
- 关联：D2、ADR-0018（同经「维护者拍板 → ADR 记录」路径）、`get_settings` / `save_setting` 白名单
- 范围：后端存储与 IPC 暴露面（`user_settings.github_oauth_token`、`host_tokens` 表）+ 前端备份导出（`DataBackupRow`）

## 1. 背景

应用持有两类凭据，均明文存于本地嵌入式 SQLite：OAuth 访问令牌（`user_settings` 表
`github_oauth_token` 键，随设备授权流程写入）与主机令牌（`host_tokens` 表，按 host 存
PAT）。曾评估引入 OS 级凭据保护（Windows DPAPI / macOS Keychain / Linux Secret
Service，SQLite 只存密文或句柄），维护者拍板不引入，维持明文；本 ADR 记录该风险接受。

## 2. 决策

1. **令牌维持 SQLite 明文存储，不引入 keystore**。理由：DPAPI/keyring 均为**用户级**
   保护——覆盖场景是离线数据库文件被窃取与同机其他用户账户读取；**不覆盖**同用户下的
   任意进程（该进程可直接调用同一 OS 凭据 API 解密，或直接注入/读取本应用进程内存）。
   本应用威胁模型下（单用户桌面应用，令牌权限限于 public_repo 级），keystore 的边际
   收益不抵其复杂度（跨平台凭据服务依赖、迁移与故障恢复），故接受文件级风险。
2. **IPC 暴露面收口先行**：凭据永不经通用设置 IPC 面进出——`get_settings`
   只回传 UI 设置键白名单、`save_setting` 只接受同源白名单，OAuth 令牌/用户键仅经
   oauth 模块专用命令读写；`get_host_tokens` 不在命令表内，`refresh_host_rate_limit`
   只回 host + 配额三元组，响应结构无令牌字段。
3. **备份文件永不携带凭据**：导出侧（`DataBackupRow` 的 `buildBackupSettings`）按
   枚举字段组装，令牌键结构性缺席（`BACKUP_EXCLUDED_KEYS` 声明排除面）；导入侧
   （`userdata/import.rs::IMPORT_SETTINGS_ALLOWLIST`）拒绝全部凭据键。恢复后需重新登录。

## 3. 后果

- 同用户恶意进程可读取两类令牌，此风险被明确接受；缓解依赖 IPC 收口（决策 2）缩小
  一次性拿全部令牌的面。
- 备份 JSON 断言不含令牌键由前端单测锁定（`DataBackupRow.backup.test.ts`）。
- 重审触发条件：未来引入云同步、多用户共享设备场景，或令牌权限升级到可写仓库内容时，
  重新评估 keystore 方案并重开本决策。
