# 02: 管理工作台共享 UI 原语抽取 (`src/views/manage/`)

**What to build:** 在 `src/views/manage/` 下抽取小而单一职责的共享展示组件：`ManageAppIcon`、`ManageHeader`、`ManageFilterBar`，统一「已安装」与「更新」两个管理页面的顶栏结构、计数徽章、下划线筛选标签、本地搜索框与安全区图标容器。

**Status:** resolved

## 验收清单

- [x] **`src/views/manage/ManageAppIcon.tsx`**：
  - 封装 `36px × 36px`（支持 `size?: 'md' | 'sm'`，默认 `'md'` = `36px`，用于关注动态等次级行时 `'sm'` = `28px`）`.manage-icon-frame` 容器。
  - 内部渲染 `<AppIcon fit="contain" ... />`（不使用会与 `.fluent-list-row .app-icon` 冲突的 `app-icon` 类名，由 `.manage-icon-frame` 统一定宽定高并做 `4px` / `3px` 内边距光学留白）。
  - 当图片未加载或回退为首字母/emoji 时，保持完整圆角底色居中填充，不产生双层边框视觉污染。
  - 支持可选 `onClick` 与 `title`（点击直达应用详情），具备键盘可访问性或语义角色。
- [x] **`src/views/manage/ManageHeader.tsx`**：
  - Props：`icon`、`title`、`count?: number`、`subtitle?: string`、`actions?: React.ReactNode`。
  - 统一渲染管理工作台顶栏：左侧图标（`16px` / `strokeWidth={1.5}`，统一尺寸消除原两页 18px vs 16px 割裂）、`h2/h3` 标题、等宽数字 `.manage-count-pill` 与单行副标题；右侧对齐动作按钮簇。
  - 注意：`title` 支持直接渲染含计数文案（如兼容 `t('updates.title', { count })` / `t('installed.title', { count })`），或拆分标题文本与 `.manage-count-pill`——**必须保证 `views.i18n.test.tsx` 中的 `/已安装.*\(0\)/`、`/Installed.*\(0\)/`、`/应用更新.*\(0\)/`、`/Updates.*\(0\)/` 契约仍成立或同步明确更新契约（优先保留兼容）**。
- [x] **`src/views/manage/ManageFilterBar.tsx`**：
  - Props：`tabs: Array<{ id: string; label: string; count?: number; disabled?: boolean }>`、`activeTab: string`、`onTabChange: (id: string) => void`、`searchQuery: string`、`onSearchChange: (q: string) => void`、`searchPlaceholder: string`、`clearSearchLabel: string`、`rightExtra?: React.ReactNode`（用于放置排序按钮等）。
  - 使用 `.manage-filter-tabs` / `.manage-filter-tab`（带 `role="tablist"` / `role="tab"` / `aria-selected`），**禁止使用 `.segmented-group` 类名**。
  - 搜索框带搜索图标、即时输入与一键清空按钮。
- [x] **代码质量与 i18n 门禁**：
  - 新增组件内禁止出现任何硬编码中文或 `invoke` 直调；所有交互文本走 props 或 `useTranslation()`。
  - 函数与组件附简洁中文 docstring，保持浅层嵌套与早返回。

**Blocked by:** 01

## Comments
- 2026-11-12：将顶栏、筛选搜索带与图标框抽为共享原语，避免 `InstalledView` 与 `UpdatesView` 再次出现两套内联样式漂移。
- 2026-11-12：已创建 `src/views/manage/ManageAppIcon.tsx`、`ManageHeader.tsx`、`ManageFilterBar.tsx` 及纯函数模型 `manageModel.ts`，零硬编码中文。
