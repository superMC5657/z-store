# Issue 39: 配额刷新命令仍回传明文 PAT（08 残项）

Status: resolved
Priority: P1（安全）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · Rust 核心与前端出口分片共同确认

## 描述

08 号工单拍板「凭据不经非 oauth 专用命令回传 webview」，`get_host_tokens` 已删除，
但同一模块的 `refresh_host_rate_limit`（`commands/forge.rs:77-112`）仍返回
`HostTokenEntry`（`models.rs:327-334`，含 `pub token: String`），`lib.rs` 仍注册、
`services/api.ts:278` / `services/api/social.ts:60` 仍封装，前端零消费方。
XSS → 一次 IPC → PAT 全集的暴露面原样存活。

## 修复方向

- 响应结构去掉令牌字段；命令面保留（配额探测仍有价值），补专用响应类型。
- 前端类型/封装/demo mock 同步，删除已无意义的 `HostTokenEntry` 前端接口。
- ADR-0020 的「已移除」改现状陈述。

## Comments

- Rust：`models.rs` 新增 `HostRateLimitRefresh`（host + 配额三元组 + updated_at），
  `refresh_host_rate_limit` 返回该类型；`HostTokenEntry` 退回 db 内部读写面。
- 前端：`types/index.ts` 以 `HostRateLimitRefresh` 取代 `HostTokenEntry`（无 token），
  `services/api/social.ts`、`demo/handlers/social.ts` 同步；grep 确认无其他消费方。
- 文档：ADR-0020 §2 改为「`get_host_tokens` 不在命令表，`refresh_host_rate_limit`
  只回 host + 配额三元组，响应结构无令牌字段」。
- 验证：`cargo test` 378 过、`clippy -D warnings` 绿、`tsc` 绿、`vitest` 894 过。
- 提交：e046c80。
- 遗留：该命令仍无 UI 调用方；若要整条删除，必须同时删 CMD 表项与 `lib.rs` 注册
  （cmdAlignment 已升级为集合相等，两侧必须同步）。
