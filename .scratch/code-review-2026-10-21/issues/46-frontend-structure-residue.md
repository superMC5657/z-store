# Issue 46: 前端结构残留（兼容再导出/双 toast/布尔陷阱/重复面板）

Status: resolved
Priority: P3（结构卫生）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · views/app、components、services 三分片

## 描述

25/27/28/31 号留下若干结构残项：

- `PendingView.tsx:62-84` 12 个兼容再导出，生产消费方为零（只有 3 个测试 + 1 处类型 import），
  注释所称「既有调用方」不存在。
- revert 失败被报两次：`useCustomApps` toast 后 rethrow，`PendingView` 再用原始 `e.message` toast 一次。
- `App.tsx:831` `handleInstallApp(..., true)` 把已有类型 `UnverifiedInstallPrompt` 拍平成 3 个位置参数 + 裸布尔。
- `navigation.ts`：`Navigate = (view: unknown) => void` 抹掉编译器检查；`VIEW_TYPES` 与
  `types/index.ts` 的 `ViewType` 两份手抄；`Sidebar` 自带一份 id 列表（注释却称共用）。
- `useCustomApps` 从 `views/PendingView` 取领域类型；六个 handler 五段同形 `await api.X(); reload()`。
- `PendingDraftForm` 把 28 属性 bag 摊进 5 个分段（refused bequest）；`PendingRichCard` 的
  `hasWithdrawProvider` 与 `onWithdrawSubmitted` 一个事实两个 prop；`errorText`/toast 形状多处重声明。
- `selectors.ts:782` 两个 memo 算同一集合；`SettingsView` 失败文案进了「已保存」槽。
- `pending/` 新增文件仍有 CJK 字面量，扫描门禁够不到。

## 修复方向

- 删无消费方再导出；单一出口报错；参数对象化；类型由常量派生；领域类型回 services；
  分段给出 `Pick` 精确 props；共享 `errorText`/`ShowToast`；CJK 迁 i18n 并纳入门禁。

## Comments

- `PendingView.tsx` 删除兼容块，3 个测试改真模块 import；`pendingText.ts` 提供 `errorText` + `ShowToast`。
- revert 失败改为：hook 只抛，`PendingView` 用 `pending.revert_failed` 渲染一次（`useCustomApps.test.tsx`
  断言 hook 不 toast）。
- `App.tsx` 新增 `InstallAppRequest`/`handleInstallRequest`，`allowUnverified` 具名。
- `navigation.ts` 成 `ViewType` 唯一来源（`types/index.ts` 改 re-export），`Navigate` 收窄为
  `(view: ViewType) => void`，深链先过 `isViewType`；`Sidebar` 按 `VIEW_TYPES` 渲染。
- `useCustomApps` 改从 `services/custom/types` 取 `DraftItem`，六个 handler 走 `mutateAndReload`。
- `PendingDraftForm` 分段 `Pick<>`；`PendingRichCard` 去掉 `hasWithdrawProvider`（由回调派生）。
- `selectors.ts` 单 memo；`SettingsView` 状态更名 `proxyFeedback`。
- `pending/` 18 个新 locale 键（zh/en 对齐），`PendingPreviewLane`/`PendingRichCard` 纳入 `MIGRATED_FILES`。
- 新增测试：`navigation.test.ts`、`useCustomApps.test.tsx`、Sidebar 顺序用例。
- 验证：`vitest` 894 过、`tsc` 绿。
- 提交：caa8f09。
- 遗留：App.tsx 约 10 处、components 约 26 个文件仍是 CJK（20 号工单自身划出范围）。
