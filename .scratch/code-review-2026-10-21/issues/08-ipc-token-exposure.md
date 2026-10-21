# Issue 08: IPC token 暴露面：PAT / OAuth token 明文回传 webview

Status: resolved
Priority: P2（安全/暴露面）
来源: 2026-10-21 全项目审查 · Rust 安全分片

## 描述

1. `src-tauri/src/commands/forge.rs:31-34`：`get_host_tokens` 把全部 PAT 明文返回
   webview，且前端无任何 UI 消费——纯多余攻击面（XSS 一发 IPC 即得全部令牌）。
2. `src-tauri/src/commands/settings.rs:47-62` + `src-tauri/src/db/settings.rs:33`：
   `get_settings` 全量回传含 `github_oauth_token`；`save_setting` 无键白名单，任意键
   可写入。

## 修复方向

- `get_host_tokens`：改为只回传 `host -> 是否已配置`（布尔/掩码尾 4 位），删除明文
  返回；若确无消费方，连命令一起移除。
- `get_settings` 对敏感键脱敏或剔除；`save_setting` 加键白名单（枚举合法 setting key）。
- 关联：09 号工单（静态存储加固）。

## Comments

- 2026-10-21 已修复（commit ee9fecf）：
  1. **`get_host_tokens` 整链移除**：核实前端无任何真实消费方（仅 `social.ts` 封装 +
     测试白名单），按工单方向连命令一起删——后端命令 + `lib.rs` 注册、前端 `CMD` 表 +
     `tauriApi` 出口 + `social.ts` 封装、demo mock 分支/handler/`LIST_FALLBACK`、
     6 处 App 测试白名单同步清除。DB 层 `get_host_tokens()` 保留（`refresh_host_rate_limit`
     内部仍用，不触 IPC 面）。
  2. **`get_settings`/`save_setting` 白名单收口**：新增 `is_managed_setting_key`，
     与 `get_default_settings` 键集同源（16 键）；`get_settings` 只合并白名单键
     （`github_oauth_token`/`github_oauth_user`/`github_oauth_client_id` 不再回传
     webview），`save_setting` 非白名单键直接报错，凭据无法经设置面读写或覆写。
  3. 后端补白名单纯函数单测（合法键放行 / 凭据键与任意键拒绝）。
  4. 附带：clippy 19 处存量 lint 修复单独提交（87c0afe），恢复 `-D warnings` 基线
     （lint 为工具链收紧所致，与工单无关的文件，不混入本工单提交）。
  5. 验证：`cargo test` 349 过 / `clippy -D warnings` 干净 / 前端 vitest 733 过。
  - 余留观察（未处理，超出本工单）：`refresh_host_rate_limit` 仍返回含 `token` 字段的
    `HostTokenEntry`，但前端无视图消费该命令（仅命名卡点测试引用）；若后续 UI 接入
    限流展示，建议回传脱敏形状（同 `HostRateLimitStatus` 口径）。
