# 04: 管理中心（Updates / Installed）与待收录工作台（Pending）同排按钮等高统一

Status: resolved
Blocked by: 01

## 目标与背景

消除管理工作台（`UpdatesView.tsx`、`InstalledView.tsx`、`InstalledItemActions.tsx`）与待收录工作台（`PendingDraftForm.tsx`、`PendingRichCard.tsx`、`PendingPreviewLane.tsx`）中同排紧邻控件 `2px`–`4px` 高度错位、实心异类图标以及反色按钮光学膨胀问题，同时严守既有测试契约。

## 验收清单

- [x] **`UpdatesView.tsx` 行内操作区等高对齐（`src/views/UpdatesView.tsx:231-291, 405-424, 535-580`）**：
  - **主待更新列表行 `.manage-row-actions`（第 535-580 行）**：将「查看日志 / 收起日志」按钮由 `btn-fluent btn-ghost btn-sm`（**`26px`**）升级为 `btn-fluent btn-ghost btn-compact`（**`28px`**），与紧邻的 `.manage-btn-action`（「升级」，**`28px`**）和 `.manage-btn-icon`（「···」，**`28×28px`**）实现 **全行 100% 等高 `28px`**！
  - **关注动态行 `.manage-row-actions`（第 405-424 行）**：将「不再提醒」按钮由 `btn-fluent btn-ghost btn-sm`（`26px`）升级为 `btn-fluent btn-ghost btn-compact`（`28px`），与紧邻「查看详情」（`.manage-btn-action`，`28px`）完全等高！
  - **顶栏 `.manage-actions-cluster`（第 231-291 行）**：`规则` / `检查更新` / `全部更新 (N)` 保持一致高度（推荐统一为 `btn-compact` `28px`，或保留 `btn-sm` `26px` 时校准内部 `badge-capsule` 上下呼吸与图标尺寸为 `13px` 避免撑感），依托 Issue 01 消除最右 `btn-primary` 反色视觉偏大问题。
- [x] **`InstalledView.tsx` 与 `InstalledItemActions.tsx` 等高与图标线性化（`src/views/InstalledView.tsx:193-274`, `src/views/InstalledView/InstalledItemActions.tsx:62-148`）**：
  - **控制带排序按钮对齐搜索框（`InstalledView.tsx:261-273`）**：将 `rightExtra` 排序切换按钮由 `btn-fluent btn-secondary btn-sm`（`26px`）调整为 `btn-fluent btn-secondary btn-compact`（**`28px`**），与紧邻右侧 `.manage-search-box`（**`28px`**）完全齐平！
  - **顶栏 `.manage-actions-cluster`（第 193-248 行）**：与 `UpdatesView` 保持严格同档位（同为 `28px` `btn-compact` 或 `26px` `btn-sm`，推荐工作台 Header 全量升至 `28px` `.btn-compact`，让 `badge-capsule` 16px 在 28px 框内上下各有 6px 呼吸）。
  - **行内「启动」按钮图标线性统一（`InstalledItemActions.tsx:133`）**：将 `<Play size={11} fill="currentColor" strokeWidth={0} />` 实心反色小三角改为标准线性 `<Play size={13} strokeWidth={1.5} />`，与同组 `MoreHorizontal size={14} strokeWidth={1.5}` 及 `UpdatesView` 同类行动作 `Download size={13} strokeWidth={1.5}` 的笔触和视觉体重完全统一；左侧 `.installed-action-btn` 与右侧 `.manage-btn-action`、`.manage-btn-icon` 保持同为 `28px` 且统一描边/focus 表现。
- [x] **`PendingView` 工作台对齐（`src/views/pending/PendingRichCard.tsx`, `PendingDraftForm.tsx`, `PendingPreviewLane.tsx`, `src/styles/components-pending.css`）**：
  - **修复 `PendingRichCard` 手动标记行 `4px` 高度差（`PendingRichCard.tsx:214-233`, `components-pending.css:214, 873-882`）**：`.pending-manual-row` 内的 `<input className="input-fluent">` 当前为 `30px`，相邻按钮「标记为已提交」为 `btn-sm` `26px`。将 `.pending-manual-row .input-fluent` 锁定 `height: 28px;`，同时将该按钮改为 `btn-fluent btn-secondary btn-compact`（**`28px`**），实现输入框与按钮 **0px 齐平**。
  - **清理 `PendingRichCard` 已归档行内联覆写（第 286-294 行）**：移除 `style={{ padding: '2px 8px', fontSize: '11px' }}`，统一使用 `btn-fluent btn-secondary btn-sm`（`26px`）。
  - **清理 `PendingPreviewLane` 折叠按钮覆写（`components-pending.css:513-517`）**：仅保留颜色控制，不覆写 `padding`/`font-size` 破坏 `.btn-sm` 盒模型。
  - **Footer 反色光学补偿**：在 `PendingDraftForm.tsx:550-599` 与 `PendingRichCard.tsx:131-208` 保留 `pending-collect-local`、`pending-submit-pr` 的 `btn-primary` 与 `style={{ marginLeft: 'auto' }}`（守护既有测试），借助 Issue 01 去除外投影与反色光学收敛，使右侧主按钮与左侧次级按钮视觉等大。
- [x] **既有测试契约硬守卫**：
  - 保留 `InstalledView.test.tsx` 中 `button.btn-primary` 数量为 1、`.manage-actions-cluster button`、`.manage-btn-action` 类名断言；
  - 保留 `UpdatesView.test.tsx` 中 `button.btn-primary` 数量为 1、`.manage-btn-action` 类名断言；
  - 保留 `PendingView.pr.test.tsx` 中 `pending-collect-local` / `pending-revert-to-draft` / `pending-submit-pr` 的类名与 `style.marginLeft === 'auto'` 断言。
  - 运行 `pnpm vitest run src/views/UpdatesView.test.tsx src/views/InstalledView.test.tsx src/views/PendingView.test.tsx src/views/PendingView.pr.test.tsx` 全部通过。

## Comments

- 2026-11-12：由 `spec.md` 拆出。依赖于 Issue 01 的 `.btn-compact` (`28px`) 与反色光学收敛。
- 2026-11-12：已完成 `UpdatesView.tsx`、`InstalledView.tsx`、`InstalledItemActions.tsx`、`PendingRichCard.tsx` 与 `components-pending.css` 改造，`pnpm check` 与 `pnpm build` 通过。
