# Issue 07: 收敛 `DemoStore` 双 Adapter 契约并移除 `PendingView` 测试专用影子状态机

Status: ready-for-agent
Blocked by: 06

## Summary

修复前端两处违背 `codebase-design` 接缝纪律（Seam Discipline）的问题：

1. **演示站 Adapter（`src/demo/`）状态散落与契约漂移导致运行期报错**：
   - 状态分散在 `demoState.ts`、`customApps.ts`、`installer.ts`、`social.ts`、`catalog.ts`、`featured.ts`、`launchpad.ts` 7 个模块级可变全局量中，单测无法一键重置全部状态；
   - `seed.ts` 预置了 4 款活跃本地库应用（`Local Library`），但 `handlers/catalog.ts::handleGetAppDetails` 与 `handlers/installer.ts::handleInstallApp` 仅查静态 `fixtures.ts::findSummary`，导致在演示站点击本地库卡片、`Launchpad` 未收录卡片或外部趋势卡片详情/安装时直接抛出 `Error: demo: unknown app`；
   - `UpdateRule.is_hidden` 仅在 `handleGetSimilarApps` 生效，`handleSearchApps`、`handleGetCategoryApps`、`handleGetLatestCatalogApps`、`handleGetHomeFeed`、`handleGetFeaturedPage` 全部漏筛隐藏应用；`handleGetFavorites` 丢弃了未收录收藏项。
2. **`PendingView.tsx` 携带仅服务单测的未受控影子状态机**：
   - `initialEntries`、`localEntries`、`flipLocalSubmitted`、`flipLocalCollected`、`flipLocalReverted` 在生产代码中零调用，仅被 `PendingView*.test.tsx` 调用 64 次，导致测试绕过真实的 `useCustomApps` 与 `tauriApi` 接缝；
   - `PendingView.tsx`（913 行）同时内联表单编辑、协议白名单单飞缓存与 3 组手写 4000ms 确认定时器（未复用 `InlineConfirmButton`）。

## Scope

- Allowed to modify:
  - `src/demo/demoState.ts`
  - `src/demo/tauri-mock.ts`
  - `src/demo/fixtures.ts`
  - `src/demo/handlers/catalog.ts`
  - `src/demo/handlers/customApps.ts`
  - `src/demo/handlers/installer.ts`
  - `src/demo/handlers/social.ts`
  - `src/demo/handlers/featured.ts`
  - `src/demo/handlers/launchpad.ts`
  - `src/demo/handlers/settings.ts`
  - `src/demo/handlers/*.test.ts`
  - `src/app/hooks/useCustomApps.ts`
  - `src/app/hooks/useCustomApps.test.tsx`
  - `src/views/PendingView.tsx`
  - `src/views/PendingView.test.tsx`
  - `src/views/PendingView.pr.test.tsx`
  - `src/views/pending/*`（可新增 `usePendingDraftEditor.ts`）
- Do not modify:
  - `src-tauri/` 后端代码
  - `src/services/api/client.ts`（严守 `mockImportGraph.test.ts` 零导入约束）
  - `src/App.tsx` 中除 `PendingView` / `useCustomApps` 最小对接外的其他状态域（其余归 Issue 08）

## Implementation Details

1. **将 `src/demo/` 收敛为统一深模块 `DemoStore`（`src/demo/demoState.ts`）**：
   - 将散落在各 handler 文件的可变缓存（`customApps`、`updateRules`、`cachedUpdates`、`watchNotifications`、`searchListCache`、`starredFeedCache`、`featured` 负反馈与兴趣种子、`launchpad` 互动状态、`iconLevel`）统一归入 `DemoStore`，提供单一 `hydrateDemoStore()` 与 `resetDemoStore()` 供 `installDemoMock` 和测试使用，并按需分键写 `localStorage`（不再每次集合变更全量重写 7 个键）。
   - 在 `DemoStore` 内提供与后端 `CatalogService` 同构的查询底座：
     - `visibleCatalogSummaries(opts?)`：合并静态精选目录与未归档本地库条目（盖章 `source: 'local'`, `is_cataloged: true`, `is_verified: false`，远端优先去重），默认剔除 `UpdateRule.is_hidden === true` 的条目，统一供 `search_apps`、`get_category_apps`、`get_latest_catalog_apps`、`get_home_feed`、`get_featured_page`、`get_similar_apps` 使用；
     - `resolveAnyAppSummary(id)`：按「精选目录 → 本地库 → `Launchpad` 清单 → 外部趋势样本 → 合法 `owner/repo` / `forge:` 坐标合成占位摘要」顺序解析，修复 `handleGetAppDetails`、`handleInstallApp`、`handleGetRepoCardsBatch`、`handleGetReadmeVariants` 在非精选卡片上抛错的问题；
     - `handleGetFavorites` / `handleGetFavoriteEntries` 保留未收录收藏项（对齐后端 `user_favorites` 语义）。
   - 严格保持所有 Demo handler 入参仅接收 camelCase（遵守 `AGENTS.md` 与 `ipcArgsNaming.test.ts`）。
2. **深化 `useCustomApps` 并删除 `PendingView` 影子状态机（Replace, Don't Layer）**：
   - 在 `useCustomApps.ts` 内聚 `customIds`（吸收乐观 `zstore:custom-apps-changed` 监听）、协议白名单单飞查询（失败保持 fail-closed）以及 `demoMode` 感知的 Issue 预填获取。
   - 在 `src/views/pending/` 提取 `usePendingDraftEditor.ts` 管理表单字段、CSV/多平台标识符缓冲与双档校验，删除/退回/撤回二次确认统一复用 `<InlineConfirmButton>`。
   - 删除 `PendingView.tsx` 中的 `initialEntries`、`localEntries` 与 `flipLocal*` 未受控回退分支，将 `PendingView.test.tsx` 与 `PendingView.pr.test.tsx` 迁移为通过挂载 `useCustomApps` / Mock `tauriApi` 接缝验证真实状态流转。

## Acceptance Criteria

- [ ] Demo 单测覆盖：点击预置 `Local Library` 条目（如 `tw93/pake`）、`Launchpad` 未收录条目（如 `acme/hyper-term`）及外部趋势条目的详情与安装均正常返回不抛错；`is_hidden` 规则在搜索/分类/最新入库/首页/精选货架一致生效；未收录应用收藏刷新不丢失；单次 `resetDemoStore()` 完全隔离跨用例状态。
- [ ] `PendingView.tsx` 不再包含 `initialEntries` 或 `flipLocal*` 影子状态分支；`PendingView*.test.tsx`、`PendingView.validationParity.test.ts`、`mockImportGraph.test.ts`、`ipcArgsNaming.test.ts`、`cmdAlignment.test.ts` 全部通过。
- [ ] `pnpm test` 与 `pnpm build` 全部通过。
