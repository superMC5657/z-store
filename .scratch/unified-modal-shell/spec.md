# Feature Spec: 全站统一弹窗底座与层级规范 (`unified-modal-shell`)

> 状态：Implemented（`01`、`02` 均为 `resolved`）  
> 关联契约：`CONTEXT.md`（D4 Linear 去彩单色界面）、`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`、`.scratch/button-size-and-inverted-icon-parity/spec.md`

---

## 1. 背景与问题

当前前端共有 6 个全屏遮罩模态弹窗：
- `AppDetailModal`（`src/components/AppDetailModal/index.tsx`）
- `DeveloperProfileModal`（`src/components/DeveloperProfileModal.tsx`）
- `AppImportModal`（`src/components/AppImportModal.tsx`）
- `RulesManagerModal`（`src/components/RulesManagerModal.tsx`）
- `InstallConfirmDialog`（`src/app/InstallConfirmDialog.tsx`）
- `LaunchpadDiscussionModal`（`src/views/LaunchpadView/LaunchpadDiscussionModal.tsx`）

尽管它们共享相同的 `.modal-backdrop`、`.detail-modal` 与 `useModalA11y` 约定，但底层封装分散，存在以下结构性问题：

1. **挂载上下文分裂**：
   - 前 5 个弹窗写在 `src/App.tsx` 顶层 `.app-window` 内；`LaunchpadDiscussionModal` 由子视图 `LaunchpadView` 内部渲染，需手动 `createPortal` 才能逃逸 `.app-body`（`overflow: hidden; z-index: 10`）。
   - 此前因误挂到 `.app-body`，导致讨论弹窗背景虚化无法覆盖 40px `.titlebar`（`z-index: 20`），且无法继承 `.app-window` 的 `zoom: var(--app-zoom, 1)`（若回退 `document.body`）。
2. **层级（`z-index`）散落硬编码**：
   - `.launchpad-discussion-backdrop`：`z-index: 90`（`src/styles/components-launchpad.css`）
   - `.modal-backdrop`：`z-index: 100`（`src/styles/components-modal.css`）
   - `.modal-backdrop.modal-confirm-above`：`z-index: 200`（`src/styles/components-modal.css`）
   - `AppImportModal`、`RulesManagerModal`：JSX 内联 `style={{ zIndex: 1000 }}`
3. **弹窗壳样板代码重复**：
   - 6 个组件各自重复编写 `.modal-backdrop`、遮罩点击关闭（混用 `onClick` 与 `onMouseDown` 判断 `e.target === e.currentTarget`）、`.detail-modal` 停止冒泡、`role="dialog"`、`aria-modal="true"`、`tabIndex={-1}` 及 `useModalA11y` 接入。
4. **刷新旋转动画重复**：
   - `src/styles/components-feedback.css` 已定义全局 `.icon-spin`（`0.8s linear infinite`），但 `components-launchpad.css`（`.launchpad-refresh-spin`）与 `components-trends.css`（`.trends-refresh-spin`）各自重复定义了等价旋转类，且 `.launchpad-refresh-spin` 缺少 `prefers-reduced-motion: reduce` 降级。
5. **暗夜模式弹窗遮罩过黑、失去背景透视虚化感**：
   - `src/styles/tokens.css` 浅色模式下 `--overlay-bg: rgba(0, 0, 0, 0.50)` 配合 `blur(16px)` 能透出柔和的模糊背景轮廓；但深色模式下本身画布已偏暗（`#08090A` / `#0F1011` / `#141516`），却仍叠加了高不透明度的 `--overlay-bg: rgba(0, 0, 0, 0.85)`，导致背后仅剩 ~15% 亮度透出，整体几乎呈现纯黑遮罩、看不出毛玻璃虚化层次。

---

## 2. 目标与边界

### 2.1 统一范围（做什么）

1. **统一弹窗外层壳 `<ModalShell>`（`src/components/ModalShell.tsx`）**：
   - **统一 Portal 出口**：当 DOM 中存在 `.app-window` 时自动 `createPortal` 挂载至 `.app-window`；无 `.app-window` 时（如脱离 `<App />` 的隔离单测）直接原地渲染（确保现有依赖 `render(...).container.querySelector(...)` 的组件测试零破坏）。
   - **统一遮罩与表面容器**：渲染 `.modal-backdrop` + `.detail-modal`，统一 `role="dialog"`、`aria-modal="true"`、`aria-label` / `aria-labelledby`、`tabIndex={-1}`、`onMouseDown` / `onClick` 遮罩关闭防误触（拖选文本松手到遮罩上不误关）及 `closeOnBackdrop` 开关（支持导入进行中禁关）。
   - **统一栈式无障碍**：内部收口 `useModalA11y(dialogRef, { open, onEscape })`，支持自定义 `onEscape`（例如讨论弹窗 Esc 优先收起表情浮层再关闭）。
   - **统一语义层级（`layer`）**：取消 JSX 内联 `zIndex: 1000` 与各模块私有遮罩层级，收敛为 `src/styles/components-modal.css` 内的受控层级修饰类：

| `layer` | 类名 | `z-index` | 适用弹窗 |
|---|---|---|---|
| `'sub'` | `.modal-layer-sub` | `90` | 可被应用详情 / 开发者主页压在下方的父级弹窗（`LaunchpadDiscussionModal`） |
| `'base'`（默认） | `.modal-backdrop` 默认 | `100` | 应用详情（`AppDetailModal`）、开发者主页（`DeveloperProfileModal`） |
| `'confirm'` | `.modal-layer-confirm` | `200` | 二次确认门禁（`InstallConfirmDialog`） |
| `'top'` | `.modal-layer-top` | `1000` | 全局工具弹窗（`AppImportModal`、`RulesManagerModal`） |

> 注：以上所有层级均高于 `.titlebar`（`20`）与 `.resize-handle`（`30`），且低于 `.toast-container`（`9999`）。

2. **统一旋转动画工具类**：
   - `src/styles/components-feedback.css` 中的 `.icon-spin` 补充 `@media (prefers-reduced-motion: reduce)` 降级规则（`animation: none;`）。
   - 广场与趋势榜刷新图标统一使用 `.icon-spin`，清理重复的 `.launchpad-refresh-spin` 与 `.trends-refresh-spin` 定义（同步更新对应测试断言）。

3. **改进暗夜模式弹窗背景毛玻璃透视虚化**：
   - 调整 `src/styles/tokens.css` 中 `[data-theme="dark"]` 的 `--overlay-bg`：从不透明感过强的 `rgba(0, 0, 0, 0.85)` 降至半透深色遮罩（建议 `rgba(8, 9, 10, 0.56)`–`rgba(8, 9, 10, 0.62)` 区间，具体以实机视觉对比为准），并可配合 `components-modal.css` 中 `.modal-backdrop` 的 `backdrop-filter: blur(var(--acrylic-blur-modal))`（如暗色下微调 `saturate(1.1)`–`1.15` 提升图标/文字轮廓可读性），依靠弹窗自身的 `--shadow-modal` 边框高光与大漫射阴影维持前景与背景的清晰分离，使暗夜模式下弹窗背后的卡片、图标、侧栏与标题栏呈现与亮色模式一致的“隐约可见 + 柔和毛玻璃虚化”质感。

### 2.2 非目标（不做什么）

- **不强行统一弹窗内部 Header / Body / Footer 布局**：
  - `AppDetailModal/Header`（5 图标动作簇 + 应用元信息）、`LaunchpadDiscussionModal`（右上角刷新/关闭 + 竖排顶帖框 + 评论编辑器）、`InstallConfirmDialog`（无关闭按钮纯确认框）各自交互结构差异明显，保持各自内部 JSX 组合，避免过度抽象成配置式 Header。
- **零后端 / Rust / IPC 改动**：全部工作仅限前端组件、样式与前端测试。

---

## 3. 实施 Issue 清单

| 编号 | 票文件 | 作用域 | 状态 | 阻塞依赖 |
|---|---|---|---|---|
| 01 | [`01-modal-shell-and-layer-tokens.md`](file:///z:/rust_workplace/z-store/.scratch/unified-modal-shell/issues/01-modal-shell-and-layer-tokens.md) | 新增 `ModalShell` 组件、收口 `components-modal.css` 层级类、`.icon-spin` reduced-motion 降级与暗夜模式遮罩虚化透视优化 | `resolved` | `none` |
| 02 | [`02-migrate-modals-to-modal-shell.md`](file:///z:/rust_workplace/z-store/.scratch/unified-modal-shell/issues/02-migrate-modals-to-modal-shell.md) | 6 个弹窗迁移至 `ModalShell`、统一 `.icon-spin` 并补全叠加/虚化/Esc 回归测试 | `resolved` | `01` |

---

## 4. 全仓验收门禁

每项 Issue 落地后必须通过：
- `pnpm check`（`tsc --noEmit && vitest run`）全部通过，含 `src/styles/buttons.parity.test.tsx` 与各弹窗单测。
- `pnpm build` 生产构建零错误。
