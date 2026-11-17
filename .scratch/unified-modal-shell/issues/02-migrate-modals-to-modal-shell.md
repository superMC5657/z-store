# 02: 全站 6 个弹窗迁移至 `ModalShell` 并统一 `.icon-spin`

Status: resolved
Blocked by: 01

## 目标与背景

将全站全部 6 个全屏遮罩弹窗迁移到 Issue 01 提供的 `ModalShell`，彻底消除各弹窗内重复的遮罩、Portal、点击关闭、无障碍与硬编码 `zIndex` 样板代码；同时清理视图/弹窗中重复定义的刷新旋转动画类名，统一走 `.icon-spin`。

## 迁移清单

1. **`src/views/LaunchpadView/LaunchpadDiscussionModal.tsx`**：
   - 移除本地 `portalTarget()`、`useModalA11y(...)` 调用及手写 `.modal-backdrop` / `.detail-modal` 包装，改用 `<ModalShell layer="sub" panelClassName="launchpad-discussion-modal" ...>`。
   - 通过 `onEscape` 保留“若表情选择面板已展开，先按 Esc 收起浮层，否则关闭讨论弹窗”的交互。
   - 刷新按钮图标类从 `launchpad-refresh-spin` 改为 `.icon-spin`。
2. **`src/components/AppDetailModal/index.tsx`**：
   - 改用 `<ModalShell layer="base" ...>`（保持可叠加在 `layer="sub"` 的讨论弹窗之上，覆盖全窗口及标题栏虚化）。
3. **`src/components/DeveloperProfileModal.tsx`**：
   - 改用 `<ModalShell layer="base" ...>`，保留原有最大宽度/高度样式。
4. **`src/app/InstallConfirmDialog.tsx`**：
   - 改用 `<ModalShell layer="confirm" ...>`，移除手工 `.modal-confirm-above` 与 `useModalA11y`。
5. **`src/components/AppImportModal.tsx`**：
   - 改用 `<ModalShell layer="top" closeOnBackdrop={!isImporting} onEscape={isImporting ? () => {} : onClose} ...>`，移除内联 `style={{ zIndex: 1000 }}`。
6. **`src/components/RulesManagerModal.tsx`**：
   - 改用 `<ModalShell layer="top" ...>`，移除内联 `style={{ zIndex: 1000 }}`。
7. **旋转动画类名收敛**：
   - `src/views/LaunchpadView.tsx` 与 `src/views/TrendsView.tsx` 刷新按钮旋转类统一改为 `.icon-spin`。
   - 清理 `src/styles/components-launchpad.css` 中的 `.launchpad-refresh-spin`（及 `.modal-backdrop.launchpad-discussion-backdrop { z-index: 90; }` 冗余规则）与 `src/styles/components-trends.css` 中的 `.trends-refresh-spin`、`@keyframes trends-refresh-spin`。
   - 同步更新 `src/views/TrendsView.test.tsx`、`src/views/LaunchpadView/LaunchpadDiscussionModal.test.tsx` 等测试中的旋转类名断言（改为 `.icon-spin`）。

## 验收清单

- [x] 全站 6 个弹窗均已接入 `ModalShell`，`src/` 下不再出现弹窗内联 `zIndex: 1000` 或各弹窗自写 `.modal-backdrop` / `createPortal(..., document.querySelector('.app-window'))`。
- [x] `LaunchpadDiscussionModal`、`AppDetailModal`、`DeveloperProfileModal` 等在真实 `.app-window` 布局下均覆盖 `.titlebar` 并统一虚化背景，且叠放顺序满足 `sub (90) < base (100) < confirm (200) < top (1000) < toast (9999)`。
- [x] 在 `LaunchpadDiscussionModal` 之上叠开 `AppDetailModal` 或 `DeveloperProfileModal` 后，Esc 逐层关闭行为正确。
- [x] `src/styles/buttons.parity.test.tsx`、全部视图与弹窗测试、以及 `pnpm check` 与 `pnpm build` 全部通过。

## Comments

- 2026-11-17：由 `.scratch/unified-modal-shell/spec.md` 拆出，依赖 Issue 01。
- 2026-11-17：已实施。6 个弹窗均改用 `ModalShell`；讨论弹窗遮罩关闭由 `onMouseDown` 改为按下 + 松开均在遮罩上才关闭。demo 中「开源广场 → 讨论 → 应用详情」叠放为 sub(90) / base(100)，Esc 逐层关闭。
