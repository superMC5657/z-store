# 01: 新增统一弹窗壳 `ModalShell` 与层级 / 旋转动画收口

Status: resolved
Blocked by: none

## 目标与背景

建立全站共享的弹窗外层壳组件 `ModalShell`（`src/components/ModalShell.tsx`）及统一的层级样式类，将散落于 6 个弹窗和 3 个 CSS 文件中的 Portal 挂载、背景遮罩虚化、叠放层级（`z-index`）、遮罩点击关闭、无障碍焦点陷阱及旋转图标动画收口到单一来源。

## 具体要求

1. **新增 `src/components/ModalShell.tsx`**：
   - 接口设计：
     - `open?: boolean`（默认 `true`，兼容常驻挂载组件；为 `false` 时返回 `null`）
     - `layer?: 'sub' | 'base' | 'confirm' | 'top'`（默认 `'base'`）
     - `closeOnBackdrop?: boolean`（默认 `true`；设为 `false` 时点击遮罩不触发 `onClose`，供导入中等不可打断状态使用）
     - `onClose?: () => void`（供遮罩点击与默认 `onEscape` 使用）
     - `onEscape?: () => void`（可选覆盖 Esc 行为，默认回退 `onClose`；传 `undefined` 且不传 `onClose` 时不响应 Esc）
     - `backdropClassName?: string`、`panelClassName?: string`、`panelStyle?: React.CSSProperties`、`panelRef?: React.Ref<HTMLDivElement>`
     - `ariaLabel?: string`、`ariaLabelledBy?: string`
     - `children: React.ReactNode`
   - **Portal 规则**：
     - 仅当 `typeof document !== 'undefined'` 且 `document.querySelector('.app-window')` 存在时，使用 `createPortal(..., appWindow)` 将遮罩挂载到 `.app-window`（覆盖 40px 标题栏并继承 `--app-zoom`）。
     - 当不存在 `.app-window` 时（如脱离 `<App />` 单独渲染弹窗的单元测试），直接原地渲染，保证既有 `render(...).container.querySelector(...)` 测试兼容。
   - **遮罩防误触关闭**：
     - 在 `.modal-backdrop` 上同时记录 `mouseDownOnBackdropRef`（`onMouseDown` 时判定 `e.target === e.currentTarget`），在 `onClick` 时仅当起落点均在遮罩自身且 `closeOnBackdrop` 为 `true` 时调用 `onClose`，防止在弹窗内拖拽选词松手到遮罩上意外关闭弹窗。
   - **无障碍与 Ref 合并**：
     - 内部合并 `internalRef` 与外部传入的 `panelRef`（支持函数 ref 与对象 ref），接入 `useModalA11y(internalRef, { open, onEscape: onEscape ?? onClose })`。
     - `.detail-modal` 容器统一携带 `role="dialog"`、`aria-modal="true"`、`tabIndex={-1}` 及 `aria-label` / `aria-labelledby`。

2. **收口 `src/styles/components-modal.css` 弹窗层级**：
   - 保留 `.modal-backdrop` 默认 `z-index: 100`。
   - 定义规范层级修饰类：
     - `.modal-backdrop.modal-layer-sub { z-index: 90; }`
     - `.modal-backdrop.modal-layer-confirm { z-index: 200; }`（同时保留 `.modal-confirm-above` 别名或迁移后清理）
     - `.modal-backdrop.modal-layer-top { z-index: 1000; }`
   - 验证不得破坏 `src/styles/buttons.parity.test.tsx` 中对 `.modal-header-btn`、`.modal-meta-link` 等现有选择器断言。

3. **统一旋转动画 `.icon-spin`（`src/styles/components-feedback.css`）**：
   - 在 `src/styles/components-feedback.css` 中为 `.icon-spin`（及 `.spinner-icon`）补充 `@media (prefers-reduced-motion: reduce) { .icon-spin { animation: none; } }`。

4. **暗夜模式弹窗遮罩毛玻璃透视优化（`src/styles/tokens.css`、`src/styles/components-modal.css`）**：
   - 将 `src/styles/tokens.css` 中 `[data-theme="dark"]` 的 `--overlay-bg` 由 `rgba(0, 0, 0, 0.85)` 下调至通透适中的半透明深色遮罩（如 `rgba(8, 9, 10, 0.56)`–`0.62`），避免深色画布叠加 85% 纯黑后背景彻底死黑、看不见虚化内容。
   - 确认 `.modal-backdrop` 的 `backdrop-filter: blur(var(--acrylic-blur-modal))`（按需微调暗色下饱和度或保持 `16px` 模糊半径）与 `--shadow-modal` 前景高光描边配合，使暗夜模式打开任意弹窗时，背景卡片、图标与标题栏仍能保持柔和可见的毛玻璃透视效果，同时不削弱弹窗主体的阅读对比度。

## 验收清单

- [x] 新增 `src/components/ModalShell.tsx` 并覆盖单元测试 `src/components/ModalShell.test.tsx`：
  - 验证 `.app-window` 存在时 Portal 至 `.app-window`（覆盖 `.titlebar`），不存在时原地渲染；
  - 验证 `layer`（`sub`/`base`/`confirm`/`top`）正确挂载对应类名；
  - 验证遮罩点击关闭、`closeOnBackdrop={false}` 拦截关闭、弹窗内部拖拽松手到遮罩不误关；
  - 验证多弹窗叠放时 Esc 仅关闭栈顶弹窗、支持自定义 `onEscape`。
- [x] `src/styles/components-modal.css`、`src/styles/components-feedback.css` 与 `src/styles/tokens.css` 完成层级类、reduced-motion 收口及暗夜模式 `--overlay-bg` 透视虚化优化。
- [x] 在暗夜模式下对比亮色模式目视核验（或样式令牌断言）：弹窗后背景不再死黑，能隐约看到虚化后的下层界面轮廓且前景弹窗对比度清晰。
- [x] `pnpm check` 与 `pnpm build` 通过。

## Comments

- 2026-11-17：由 `.scratch/unified-modal-shell/spec.md` 拆出，独立可测，无阻塞前置。
- 2026-11-17：已实施。`ModalShell` 每次打开时解析一次 `.app-window` 挂载点，打开期间不切换以免子树重挂；暗夜 `--overlay-bg` 取 `rgba(8, 9, 10, 0.6)`，`[data-theme="dark"] .modal-backdrop` 叠加 `saturate(1.12)`；`.modal-confirm-above` 已由 `.modal-layer-confirm` 取代。样式契约见 `src/styles/modalLayers.test.ts`，demo 暗夜模式实机核验背景虚化可见、覆盖标题栏。
