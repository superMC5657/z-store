# Issue 37: 令牌风险 ADR 记录 + 备份导出排除令牌

Status: resolved
Priority: P3（安全文档化/数据卫生）
来源: 09 号工单拍板残余（2026-10-21）

## 描述

维护者已拍板（见 09 号工单 Comments）：令牌维持 SQLite 明文、不引入 keystore；备份
导出排除令牌。承接两项落地：

1. **ADR-0020**（编号按 `docs/adr/` 顺延）：记录令牌存储现状（SQLite 明文：settings
   的 `github_oauth_token` + host_tokens）、威胁模型分析（DPAPI/keyring 为用户级保护，
   覆盖离线窃取与他用户账户、不覆盖同用户进程）、接受理由、备份排除保证、重审触发
   条件（如未来引入云同步/多用户共享设备时重开）。
2. **备份导出核验**：检查导出链路（`src-tauri/src/commands/history.rs` 导出侧，与
   `import_user_data` 同文件）是否携带 `github_oauth_token` 与 host_tokens 数据；若
   携带则排除。注意 2026-09-20 审查曾发现「备份导出静默丢失设置字段」——核对导出
   字段完整性时一并处理，避免为排除令牌再丢别的字段。
3. CONTEXT.md D2 表述保持「令牌存本地 SQLite」不变，句尾补指针「（威胁模型与风险
   接受见 ADR-0020）」。

## 修复方向

- ADR 按 `docs/adr/` 既有条目格式撰写。
- 导出侧改动补单测：导出 payload 断言不含 token 键。

## Comments

- 2026-10-21 已落地（commit 281114f）：
  1. **ADR-0020**（`docs/adr/0020-token-plaintext-risk-acceptance.md`，编号顺延）：
     SQLite 明文现状（OAuth 令牌 + host_tokens）、DPAPI/keyring 用户级保护边界分析
     （覆盖离线窃取/他用户账户，不覆盖同用户进程）、接受理由、IPC 收口与备份排除
     保证、重审触发条件（云同步/多用户共享设备/令牌权限升级）。
  2. **备份导出核验**：导出为前端组装（`DataBackupRow.buildBackupSettings` 枚举字段，
     非全量透传），令牌键结构性缺席；导入侧 `IMPORT_SETTINGS_ALLOWLIST` 同样拒绝凭据键。
     2026-09-20「导出静默丢字段」复核：导出字段集与导入白名单一致（12 键 + showCustom
     别名透传），未见为排除令牌而丢字段。补锁值单测：`github_oauth_token`/
     `github_oauth_user` 入样后断言导出 JSON 不含键与令牌值（原样例只有历史 PAT 键
     `github_token`）。
  3. **CONTEXT.md D2**：句尾补「（令牌威胁模型与风险接受见 ADR-0020）」，表述其余不变。
  4. 依赖 08 号先行成立：`get_settings` 白名单后，OAuth 令牌键已不回传 webview，
     备份组装的输入端亦无凭据。
  5. 验证：`DataBackupRow.backup.test.ts` 5 测试过（含新增 OAuth 排除锁）。
