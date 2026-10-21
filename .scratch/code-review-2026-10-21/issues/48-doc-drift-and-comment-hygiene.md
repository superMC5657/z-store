# Issue 48: 文档-代码二次漂移与注释卫生回潮

Status: resolved
Priority: P3（文档与注释）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · 文档/注释分片（Rust 与前端两侧同时发现）

## 描述

上一轮修复自身引入了新的文档-代码漂移与变更史注释：

- CONTEXT D7 仍写「按 200ms→800ms 退避」，而 `github/http.rs` 已对 429 睡到 60s；
  ADR-0012 §3 同样只描述固定退避。
- `docs/logging.md:115` 仍列 `trends text upstream too large`，代码发的是 `trends text truncated`。
- `docs/adr/0017:34` 仍把已删除的 `collect_custom_app` 写作在用命令（全仓唯一残留引用）。
- ADR-0020:24「已移除」是变更史口吻；`tokens.ts:3`「与 tokens.css 同源」为假陈述
  （tokens.css 无渐变）；`navigation.ts:3`「Sidebar 项共用」在 Sidebar 自带清单时为假。
- `db/schema.rs:222` 注释「只读兼容」与实现（跳过盖章但仍写幂等基底 DDL）不符。
- 变更史注释回潮约 20 处（`coord.rs`、`mirror.rs`、`icon_fetch.rs`、`useCustomApps`、
  `pending/*`、`iconStore`、`normalizeId`、多个测试头），而 29 号工单专门清理的就是这类。

## 修复方向

- 文档按现状改写（含 429 口径、截断日志点、删除命令、令牌面）；
- 注释统一现在时，删除工单号/迁移史叙述；假陈述要么改代码要么改话术。

## Comments

- 文档：CONTEXT D7 与 ADR-0012 §3 补 429 Retry-After（60s/5s）；ADR-0017 收录命令面收敛为
  `collect_local_app`；ADR-0020 改现状陈述；`logging.md` 换 `trends text truncated … bytes=`。
- 注释：`coord.rs:40`、`mirror.rs:33-35`、`icon_fetch.rs:58`、`forge/tests.rs`、
  `models.rs:148`、`config.rs` 测试、`schema.rs:220-222`、`tokens.ts:1-10`、`navigation.ts:1-6`、
  `useCustomApps`、`pending/*` 六个文件头、`iconStore:299-308`、`normalizeId:1-14`、
  `search.rs:135-137`、`installer_install.rs:42-45`、`OAuthAccountCard.poll-leak.test.tsx`、
  `DataBackupRow.backup.test.ts` 以及 `#NN` 引用共十余处改为现在时。
- `navigation.ts:3` 的假陈述通过「Sidebar 真按 VIEW_TYPES 渲染」修掉；`tokens.ts:3` 通过改述 + 新 parity 测试修掉。
- 验证：`vitest` 894 过、`cargo test` 378 过、`clippy -D warnings` 绿、`tsc`/`vite build` 绿。
- 提交：71582c0（收尾 57ef4f4）。
