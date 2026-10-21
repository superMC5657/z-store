# Issue 35: 草稿 forge 门禁与 enrich 键归一化分叉

Status: resolved
Priority: P3（正确性）
来源: 2026-10-21 全项目审查 · services 分片

## 描述

1. `src/services/api/catalog.ts:772`：`buildCustomDraftItemFromSummary` 不看
   `app.forge`，非 GitHub 摘要（无冒号 id）可过 DraftLenient 被记成 GitHub 应用；
   `src/services/custom/draft.ts:21` 入口同样无 forge 门。后端仅拦 `:` 形态
   （catalog_custom.rs:108）——前后端门禁都不完整。
2. `src/services/trends/cache.ts:384`：`wantedEnrichKeys` 对 `r.id` 直接入集，带 forge
   前缀的 id 会与 `owner/repo` 形态的 enrich 键分叉致合并 miss（`src/services/normalizeId.ts:11`
   仅 trim+lowercase，不解析前缀，与后端 canonical_app_id 的解析深度不对齐）。

## 修复方向

- 草稿入口（draft.ts + buildCustomDraftItemFromSummary）补与后端一致的 forge 门：无
  冒号 id 视为 GitHub、带前缀 id 过 canonical 解析校验（未知前缀拒绝，对齐 16 号工单）。
- enrich 键统一经归一化函数生成，禁止裸 `r.id` 入集。

## Comments

- **前端归一口升级 canonical 深度**（`src/services/normalizeId.ts`）：`normalizeId`
  从纯 `trim().toLowerCase()` 升级为后端 `canonical_lookup_id` 同语义 total 函数——
  新增 `RepositoryUrlParser` 三分支 TS 镜像（完整 URL 宿主判 forge / 前缀短语法
  别名表 gh·cb·gt·gl / 裸 owner/repo，含 `valid_coord_segment` 段校验与
  `to_app_id` 构造），可解析直取 canonical、不可解析回退小写；导出 Option 形态
  `canonicalAppId`（后端 `canonical_app_id` 镜像）供门禁区分「不可解析」与「兜底」。
  后端同步键路径无法逐键 await Rust，镜像对齐由 `normalizeId.test.ts` 与
  coord.rs 单测同案例锁值。`gh:` 折叠后 id 键与坐标键同值，enrich merge miss
  收口（`wantedEnrichKeys`/`snapshotTrendConfirmedOthers`/`snapshotTrendEnrichCache`
  的 `normalizeId(r.id)` 调用点自动收敛，无裸 `r.id` 绕过归一口）。
- **草稿 forge 门**（`src/services/api/catalog.ts#draftForgeGateError` + 入口双接）：
  后端 DraftLenient 同口径——摘要 `forge` 明确非 github 拒（builder 只取
  owner/repo 拼无冒号 id，放行会把 codeberg/gitea/gitlab 仓库记成 GitHub 应用，
  homepage 回退还会指向错误平台）；id 含 `:` 时未知前缀按 canonical 解析拒绝
  （对齐 16 号单出口），已知前缀按「forge 形态暂不收录」拒（后端 `:` 闸）。
  `moveInToDraft` 入口先行拦截（`ok=false` 不落库不广播，视图 toast 直出原因），
  `buildCustomDraftItemFromSummary` 同门 throw 兜底（异常不越层，入口已拦）。
- **测试**：新增 `normalizeId.test.ts`（13 例：别名折叠/前缀保持/URL 宿主白名单
  子域/自建默认 gitea/不可解析回退/脏段拒绝/Set 收敛）；`draft.test.ts` 增 2 例
  （非 GitHub 摘要不探测不落库不广播；未知前缀/已知前缀/`gh:` 别名三态拒绝）；
  `catalog.draftIcon.test.ts` 增 forge 门 4 例。vitest 749 全绿。
