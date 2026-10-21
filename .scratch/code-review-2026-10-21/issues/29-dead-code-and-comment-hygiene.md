# Issue 29: 死代码与注释卫生

Status: resolved
Priority: P3（清理）
来源: 2026-10-21 全项目审查 · Standards 轴

## 描述

1. `src/services/iconStore.ts:956`：`const had = …; void had;` 计算结果无消费，死代码。
2. 违反 AGENTS.md 注释规则（「写现状，不写变更史」）两处：
   `src-tauri/src/github/catalog_service.rs:37`（"不再把默认源 host 塞进…"）、
   `src-tauri/src/github/search.rs:300`（"此处不再写"）——均叙述历史而非现状。

## 修复方向

- 删除 `had`/`void had` 及其计算。
- 两条注释改写为现状描述（说明现在的行为/约束），不提"以前如何"。

## Comments

- `had`/`void had` 实际位于 `iconStore.ts:1012-1013`（#33 有界化后行号漂移，工单写
  956）：`clearBufferedIcon` 里计算"键是否存在"后无任何消费，连同计算一并删除，
  `deleteBufferedIcon` → `invalidateIconCache` → `notifyIconWrites` 主流程不动。
- `catalog_service.rs:37` 改写："不再把默认源 host 塞进 per-client no_proxy" →
  "per-client no_proxy 不预置默认源 host"（现状约束陈述）；`search.rs:323`（工单写
  300，行号漂移）改写："此处不再写" → "本函数只读不写"（现状行为陈述）。两处均不提
  变迁史，行为语义零变化。
- 同名模式排查：`search.rs:136`"不再伪装"为现行策略语境、`catalog_service.rs:895`
  "同步后不再可搜可装"为状态描述，均非变更史叙述，不改。
- 验证：`cargo check` 绿；iconStore 4 测试文件 16 用例全绿；全量 vitest + pnpm build
  见批次收尾。
