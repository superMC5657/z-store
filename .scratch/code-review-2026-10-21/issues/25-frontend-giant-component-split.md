# Issue 25: 前端巨型组件拆分（PendingView / App.tsx / ViewType 分散）

Status: resolved
Priority: P3（可维护性）
来源: 2026-10-21 全项目审查 · Standards 轴 + 前端核心分片

## 描述

1. `src/views/PendingView.tsx` 全文件 2629 行，主组件约 2250 行；:1182-1267 与
   :1335-1421 单条/批量提交流程约 70 行同形（gate→校验→取URL→https判→超长复制载荷→
   开页）。
2. `src/App.tsx` 931 行，customApps 五个 handler 与 deep-link 确认仍内联（状态机本体
   已下沉 app/hooks，属残余）。
3. ViewType 转移入口分散 4 处直调 `setCurrentView`（Sidebar、useSearchState.ts:170,214、
   useDeepLink.ts:44、App.tsx:595,690），无集中导航函数。

## 修复方向

- PendingView 按表单段拆子组件；单条/批量提交抽 `submitDraftFlow()` 共享。
- App.tsx customApps handlers 迁入 app/hooks（对齐既有下沉模式）。
- 引入 `navigate(view)` 集中入口（内聚合法 ViewType 校验），4 处调用点收口。

## Comments

- 纯行为保持重构，以批次 2 已修的回调结构为基线，未混入新行为；tsc 绿、vitest 778 用例全绿、pnpm build 绿。
- PendingView 拆分（2669 → 主文件 1271 + pending/ 六模块 1803）：
  - 纯函数/类型收容 `pending/draftModel.ts`（校验、归一、分组判定、PENDING_EMPTY_DRAFT 等；
    PendingView 保留同名重导出，三个既有测试与 App 的 import 面零迁移）。
  - 单条/批量提交共享尾段抽 `pending/submitPrefillFlow.ts` 的 `runSubmitPrefillFlow()`：
    「预览模式硬拦→取 URL→https 门→超长复制后端载荷→开页→onOpened 收尾」单一实现；
    `openPrefillPage`/`copyBackendPayload`/`notifyPrefillOpenFailed` 一并下沉（PendingView 内零残留）。
    单条/批量差异全部由 args 表达（loadUrl/loadPayload/failLabel/tooLongParams/onOpened），
    忙态前段（gate→校验→busy）与成功收尾（批量清选中+batch_submitted）保留在各自 handler。
  - 表单段/区块拆四个子组件：`PendingListColumn`（列表+批量工具行）、`PendingRichCard`
    （后链路富卡）、`PendingPreviewLane`（草稿实时预览）、`PendingDraftForm`（表单卡，
    内部再按 D 坐标/A 核心/B 补充/C 运行时/页脚五段拆分）；样式常量收 `pendingStyles.ts`。
- App.tsx（931 → 901 行，回调域下沉后 JSX 为剩余主体）：customApps 状态机 + 六个落盘
  handler + 派生序列（pendingEntries/pendingCount/localLibrarySummaries）迁
  `app/hooks/useCustomApps.ts`，App 消费 hook 返回值，调用面逐字不变。
  深链确认弹窗仍内联于 App（工单描述亦标注属残余，状态机本体已在 useDeepLink，未动）。
- 集中导航：新建 `app/navigation.ts`（VIEW_TYPES 唯一清单 + isViewType 守卫 +
  createNavigate 工厂）；App 持有 `navigate`，4 处直调收口：
  Sidebar onSelectView、useSearchState 两处回跳、useDeepLink open_view（本地 validViews
  副本删除，校验收口 navigation，非法视图静默忽略语义不变）、App 账号设置/趋势跳转。
- noDirectInvoke 递归门禁覆盖新增 views/pending/ 子目录：新文件不 import api/client、
  引 services/api 处均用 tauriApi 名。
