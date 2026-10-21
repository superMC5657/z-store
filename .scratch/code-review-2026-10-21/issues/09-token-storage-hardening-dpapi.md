# Issue 09: 令牌明文存储加固（DPAPI/keyring）

Status: resolved
Priority: P2（安全，涉及设计决策）
来源: 2026-10-21 全项目审查 · Rust 安全分片

## 描述

OAuth token 与 host_tokens（PAT）均 SQLite 明文存储（`src-tauri/src/oauth/mod.rs:9`、
`src-tauri/src/commands/oauth.rs:74`）。D2 声明令牌存本地 SQLite 属既定决策，但明文
落盘意味着任意本地进程/备份导出可直接读取。

## 待决策

- 是否引入 OS 级凭据保护：Windows DPAPI / keyring crate（macOS Keychain、Linux
  Secret Service），SQLite 只存密文或句柄。
- 备份导出（设置中心「数据备份」组）是否含令牌，含的话如何加密。
- 迁移路径：存量明文行的就地升级策略。

## 备注

需要维护者拍板范围与兼容性取舍后转 ready-for-agent。前置依赖：08 号工单先收口 IPC
暴露面。

## Comments

- 2026-10-21 维护者拍板：
  1. **不引入 keystore**：令牌维持 SQLite 明文存储。理由：DPAPI/keyring 均为用户级
     保护（防离线文件窃取、他用户账户；不防同用户恶意进程），本应用威胁模型下收益
     有限，接受文件级风险。D2「令牌存本地 SQLite」表述因此不变，风险接受以 ADR 记录
     （→ 37 号工单）。
  2. **备份导出排除令牌**：备份文件永不携带凭据，恢复后需重新登录（→ 37 号工单核验
     现状）。
  3. 迁移问题随第 1 条作废（无 keystore 即无迁移动作）。
- 残余可执行动作拆至 `37-token-risk-adr-and-backup-exclusion.md`。
