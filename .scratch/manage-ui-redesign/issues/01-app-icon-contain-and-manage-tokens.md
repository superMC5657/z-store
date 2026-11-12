# 01: AppIcon `fit` 适配与管理工作台样式基座 (`components-manage.css`)

**What to build:** 为 `AppIcon` 新增 `fit?: 'cover' | 'contain'`（默认 `'cover'`）以解决非方形/满幅应用图标在列表中被强行裁切的问题；新建 `src/styles/components-manage.css` 并按层叠顺序引入 `src/styles/fluent.css`，建立管理工作台的 Linear 面板、细线分割行、36×36 光学安全区图标框、版本 Diff 胶囊与响应式断点样式，同时保证 `TrendsView` 及其他 Modal 消费的 `.fluent-list-row` 零回归。

**Status:** resolved

## 验收清单

- [x] **修复 `AppIcon` 图标裁切能力（`src/components/AppIcon.tsx`）**：
  - `AppIconProps` 新增可选属性 `fit?: 'cover' | 'contain'`（默认 `'cover'`）与 `imgPadding?: number | string`（可选内边距，默认无），向后兼容全部现有调用点。
  - 当 `fit === 'contain'` 时，`<img>` 使用 `objectFit: 'contain'`；如传入 `imgPadding`（或由外层 `.manage-icon-frame` 提供内边距），保证异形/满幅 PNG 与 SVG（如 `7-Zip-zstd`、`OBS Studio`、`Motrix`）完整居中显示、不被外框圆角切边。
  - 首字母回退徽章与 emoji 分支逻辑保持不变，不破坏 `AppIcon.simplify.test.tsx` 既有契约。
- [x] **新增管理工作台样式表（`src/styles/components-manage.css`）**：
  - 定义 `.manage-view`、`.manage-header`、`.manage-title-group`、`.manage-count-pill`、`.manage-subtitle`、`.manage-actions-cluster`。
  - 定义 `.manage-controls-bar`、`.manage-filter-tabs`、`.manage-filter-tab`（带底部 2px 单色激活指示线与 `tabular-nums` 计数，**不使用** `.segmented-group` 类名）、`.manage-search-box`。
  - 定义 `.manage-panel`（`var(--bg-acrylic-card)` + `1px solid var(--border-color)` + `var(--radius-lg)`）与 `.manage-row`（内部 `1px solid var(--border-subtle)` 底部分割线，末行去底线，首/末行圆角平滑衔接，hover 态使用 `var(--bg-acrylic-hover)`，菜单打开行提升 `z-index` 不被邻行遮挡）。
  - 定义 `.manage-icon-frame`（`36px × 36px`、`border-radius: 8px`、中性微底色 `var(--bg-input)`、`1px solid var(--border-subtle)`、4px 安全区，覆盖 `.installed-list-row .app-icon` 对内层 `.app-icon` 的 `32px !important` 强约束或改用无冲突类名）。
  - 定义版本 Diff 轨（`.manage-version-diff`、`.manage-ver-current`、`.manage-ver-latest`）、集成路径胶囊（`.manage-path-chip`）、Outline 行动作按钮（`.manage-btn-action`）与流式进度条（`.manage-progress-banner`）。
  - 完整适配 `[data-theme="dark"]` 与 `[data-theme="light"]`（及 `:root` 默认亮色），遵循 Linear 字重 `400 / 510 / 590`（禁止 `700+`）与 `--ease-smooth`。
  - 补充 `<= 900px` 与 `<= 640px` 响应式媒体查询，保证窄屏下不横向溢出。
- [x] **样式总入口接入（`src/styles/fluent.css`）**：
  - 在 `@import "./components-list-row.css";` 之后引入 `@import "./components-manage.css";`，确保不破坏既有 `.fluent-list-row` 在 `TrendsView`、`RulesManagerModal`、`DeveloperProfileModal`、`AppImportModal` 中的表现。
- [x] **测试**：
  - 在 `src/components/AppIcon.simplify.test.tsx` 补充 `fit="contain"` 的渲染断言（默认仍为 `cover`，传入 `contain` 时 `img.style.objectFit === 'contain'`）。
  - 运行 `pnpm vitest run src/components/AppIcon.simplify.test.tsx src/styles/tokens.parity.test.ts` 通过。

**Blocked by:** 无

## Comments
- 2026-11-12：由 UI 重设计 Spec (`spec.md`) 拆出，作为所有管理视图重构的样式与图标校准基座。
- 2026-11-12：已实施 `AppIcon` `fit` / `imgPadding` 支持、新建 `src/styles/components-manage.css` 并按层叠顺序接入 `src/styles/fluent.css`。验证：`pnpm vitest run src/components/AppIcon.simplify.test.tsx src/styles/tokens.parity.test.ts` 共 24 项全部通过。
