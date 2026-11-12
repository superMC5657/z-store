# 04: 已安装页 (`InstalledView.tsx` & `InstalledItemActions.tsx`) UI 彻底重构

**What to build:** 重构 `src/views/InstalledView.tsx`、`src/views/InstalledView/InstalledItemActions.tsx`（及可选在 `src/App.tsx` 透传 `updatableIds`），打造与更新页同源的 Linear 管理工作台体验：顶栏主次按钮归位、状态筛选 + 本地搜索 + 排序、集成式路径复制胶囊、Outline 启动按钮与全 `lucide-react` 更多操作菜单。

**Status:** resolved

## 验收清单

- [x] **顶栏主次归位与副标题摘要（`ManageHeader`）**：
  - 顶栏左侧：`Package`（`16px`）+ 已安装标题（兼容 `/已安装.*\(N\)/`）+ 副标题摘要（如已纳管数量、已锁定数量、有可用更新数）。
  - 顶栏右侧顺序重排为：**次级按钮在左，主按钮在最右**：`规则 [N]`、`刷新`、`导出清单`（`btn-secondary btn-sm`），最右为全页唯一 `btn-primary`「扫描本地」（修正原图将主按钮错放在最左侧的问题）。
- [x] **状态筛选 + 搜索 + 排序（`ManageFilterBar`）**：
  - 筛选标签（使用 `.manage-filter-tabs`，**绝不引入 `.segmented-group`**）：
    - `全部`（全量 `installedApps`）
    - `已锁定`（匹配 `rule.is_frozen`）
    - `已隐藏`（匹配 `rule.is_hidden`）
    - `路径待探测`（`!app.install_path`）
  - 本地搜索框：即时按应用展示名、`app_id`、`install_path` 过滤，命中 0 条时展示友好筛选空态与「重置筛选」按钮（不影响原有 `loadError` 错误卡与全局 `installedApps.length === 0` 空态契约）。
  - 排序切换按钮：在「最近安装（默认 `installed_at` 降序）」与「名称 A–Z」之间一键切换。
- [x] **已安装细线面板列表（`.installed-list-container.manage-panel`）**：
  - 每行 `.installed-list-row.manage-row` 结构：
    1. **图标**：`36×36` `<ManageAppIcon size="md" />`（可点击进详情）。
    2. **身份与元数据区**：
       - 第一行：应用展示名（`590` 字重，可点击）+ 等宽版本标签（`app.version`）+ 安装方式微标签（由 `app.install_method` 映射为简短规范词如 `MSI` / `Setup` / `Portable` / `DMG` / `DEB` / `External`，复用纯映射表）+ 状态标签（`已锁定`、`已隐藏`、以及可选的待更新徽标当 `updatableIds?.has(app.app_id.toLowerCase())` 为真时）。
       - 第二行（结构化对齐，禁止游离按钮）：
         - 安装日期（`formatAppDate`，`tabular-nums`）；
         - 若有 `app.install_path`：渲染集成式 **`.manage-path-chip`**（单行等宽截断路径 + 紧贴右缘内置 `Copy`/`Check` 图标按钮，点击整颗胶囊或复制图标即触发 `copyTextToClipboard` 并瞬态显示「已复制」，彻底消除原先随路径长度左右跳动的蓝色「复制」文字链接）；
         - 若无 `app.install_path`：渲染虚线提示「未检测到安装路径」+ 行内「重新探测」微按钮。
- [x] **操作列与更多菜单统一（`InstalledItemActions.tsx`）**：
  - 移除 `compact` 引起的高度不一致与 14 个实心白块：
    - 「卸载」使用低对比 `btn-ghost`（hover 显中性红）；二次确认态（`confirmingUninstallId` / `confirmingUnmanageId`）保持原地切换的「确认卸载 / 确认取消」+「取消」紧凑安全按钮。
    - 「启动」升级为 `.manage-btn-action` **Linear Outline 样式**（`Play` `12px` + 文案，`28px` 统一高度），彻底告别实心白块墙。
    - 「···」菜单按钮及内部所有菜单项图标**全部改用 `lucide-react`**（`MoreHorizontal`、`Info`/`ExternalLink`、`Copy`、`Lock`/`Unlock`、`Eye`/`EyeOff`、`MinusCircle`），删除手写内联 `<svg>`。
    - 菜单内新增「查看应用详情」（调用可选 `onOpenDetail`）与「复制安装路径」（有路径时调用复制回调），与既有「锁定版本」「隐藏应用」「取消管理」并列。
- [x] **`App.tsx` 轻量联动（可选增强）**：
  - 在 `src/App.tsx` 传入 `InstalledView` 时计算 `updatableIds`（来自 `updates` 集合小写 `app_id`）供已安装行展示克制的「有更新」微标签。
- [x] **契约守卫**：
  - 保留 `loadError` 错误卡与重试按钮逻辑（满足 `InstalledView.loadError.test.tsx`）。
  - 保留 `.installed-list-container`、`.installed-list-row` 且不渲染 `.segmented-group`、`.app-grid`（满足 `views.i18n.test.tsx`）。

**Blocked by:** 01, 02

## Comments
- 2026-11-12：解决已安装页 14 个白色启动块、路径复制按钮横跳、缺搜索筛选、以及操作图标未收口 `lucide-react` 问题。
- 2026-11-12：已完成 `InstalledView.tsx`、`InstalledItemActions.tsx` 重构并在 `App.tsx` 透传 `updatableIdSet`，新增 `src/views/InstalledView.test.tsx`。
