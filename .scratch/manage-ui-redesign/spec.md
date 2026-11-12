# Feature Spec: 管理中心（已安装 & 更新）UI 彻底重设计 (`manage-ui-redesign`)

> 目标范围：`src/views/UpdatesView.tsx`、`src/views/InstalledView.tsx`、`src/views/InstalledView/InstalledItemActions.tsx`、`src/components/AppIcon.tsx` 及管理工作台配套样式与共享 UI 原语。  
> 设计基线：严格遵循 `CONTEXT.md` **D4 Linear 去彩单色界面**与 **Fluent 2 矢量图标体系**，对齐 `SettingsView` 与 `PendingView` 的现代面板语法。

---

## 1. 现状诊断（Root-Cause Analysis）

结合当前实现与实机截图，更新页（`UpdatesView`）与已安装页（`InstalledView`）存在以下结构性与视觉问题：

### 1.1 图标排布与渲染畸变（更新页尤为严重）
1. **尺寸双源冲突**：`UpdatesView.tsx` 对 `<AppIcon>` 传入 `size={40}`（内联 `width: 40; height: 40`）并叠加 `className="app-icon"`，而 `components-list-row.css` 用 `.fluent-list-row .app-icon { width: 32px !important; height: 32px !important; }` 强行覆盖尺寸，导致组件内联语义与样式表冲突。
2. **满幅裁剪（`object-fit: cover`）+ 硬边框**：`AppIcon.tsx` 的 `<img>` 强制使用 `objectFit: 'cover'`，且 `.app-icon` 带有 `1px solid rgba(255,255,255,0.12)` 边框与 `6px` 圆角。对于非正方形或无内边距的开源应用图标（如 `7-Zip-zstd`、`OBS Studio`、`qBittorrent`、`Motrix`），图标字形与圆环被外框硬切或紧贴边缘，视觉重心失衡。
3. **跨区块尺寸不一致**：`UpdatesView` 中关注动态卡片使用 `size={26}` + `borderRadius: 7px`，列表使用 `size={40}` 被覆写为 `32px`，行高却因双行文本撑到 50px+，显得图标局促且排布松散。
4. **缺少纵向对齐锚点**：两页均未使用固定列轨，图标、应用名、版本号/路径与操作按钮全靠 `flex: 1` 自由伸缩，版本 Diff 与元数据在行与行之间无法形成纵向扫描线。

### 1.2 按钮权重失衡（“刺眼白块墙”）
- 深色模式下 `--btn-primary-bg` 为高对比纯白（`#F7F8F8`）。当前 `UpdatesView` 每行均放置实心 `btn-primary`「立即升级」，`InstalledView` 每行均放置实心 `btn-primary`「▶ 启动」，导致 8–14 个纯白矩形沿右侧竖排成墙，完全压过应用名称与版本信息；与此同时，`InstalledView` 顶栏主按钮「扫描本地」放在最左侧而非右侧主位，与 `UpdatesView` 顶栏按钮顺序相反。

### 1.3 容器堆叠噪声与信息架构缺失
1. **卡片边框堆叠**：两页均采用独立 `.fluent-list-row` 圆角盒以 `4px` 间距堆叠，在 10+ 条目时形成密集的横条纹噪声，未采用 `SettingsView` 的「单一 Elevated 面板 + `1px` hairline 内分割线」分组范式。
2. **更新页信息匮乏与交互缺陷**：
   - 版本对比 `当前: 1.8.19 ➔ 最新: v2.4.1` 使用粗重 Unicode 箭头与紫色大段文本，长哈希版本（如 WezTerm）不易扫描；
   - 点击「查看日志」时，若 `item.changelog` 为空字符串，按钮状态切换为「收起更新日志」但下方无任何内容展开，交互表现形同失效；
   - 关注动态通知区与流式检查进度条使用独立突兀的 `var(--brand-subtle)` 方盒，与下方列表割裂。
3. **已安装页路径与操作杂乱**：
   - 超长 Windows 安装路径与 `· 安装于 YYYY/MM/DD` 混排在一行，末尾悬浮一个随路径长度左右跳动的「复制」按钮；
   - 缺少本地搜索、状态筛选（全部 / 已锁定 / 已隐藏 / 路径待探测）和排序能力；
   - `InstalledItemActions.tsx` 仍残留手写内联 `<svg>`（锁、眼睛、三点菜单），未统一收口至 `lucide-react`。

---

## 2. 重新设计目标与视觉规范

### 2.1 设计原则
1. **单一主焦点（One Primary CTA per View）**：全页最多保留 1 个高对比度 `btn-primary` 全局动作（更新页为「全部更新 (N)」，无待更新时为「检查更新」；已安装页为「扫描本地」并固定置于顶栏最右端）。列表行内主操作降噪为克制的 **Outline/Secondary 按钮**（`28px` 高，`1px solid var(--border-color)`，透明/微透底色，hover 微亮）。
2. **面板化细线列表（Hairline Grouped Panel）**：采用 `.manage-panel`（`background: var(--bg-acrylic-card)`，`1px solid var(--border-color)`，`border-radius: var(--radius-lg)`）包裹列表行，行间以 `1px solid var(--border-subtle)` 分割，保持与 `SettingsView` 一致的呼吸感与表面层级。
3. **光学安全区图标校准（Optical Icon Frame）**：
   - `AppIcon` 新增可选属性 `fit?: 'cover' | 'contain'`（默认 `'cover'`，确保 `AppCard` 等现有场景零变化）。
   - 管理视图统一使用 `<ManageAppIcon>`（或 36×36px `.manage-icon-frame` 容器）：外部为 `36px × 36px`、`border-radius: 8px`、极浅中性底（`var(--bg-input)`）与 `1px solid var(--border-subtle)`；内部图片层留出 `4px` 安全内边距并使用 `fit="contain"`，彻底消除图标边缘裁切与双圆角嵌套。首字母回退徽章与 emoji 则铺满安全内框。
4. **全局可扫描轨道（Tabular Alignment）**：借助可控的 Flex/Grid 列轨与 `font-variant-numeric: tabular-nums`、等宽版本/路径片段，确保跨行图标、名称、版本 Diff、状态标签与操作列纵向齐整。
5. **非破坏性回归边界**：不修改 `.fluent-list-container` / `.fluent-list-row` 对 `TrendsView`、`RulesManagerModal`、`DeveloperProfileModal`、`AppImportModal` 的既有样式；保留 `InstalledView` 的 `.installed-list-container` 与 `.installed-list-row` 类名以及不含 `.segmented-group` 的结构契约（满足 `views.i18n.test.tsx`）。

---

## 3. 信息架构与布局蓝图

### 3.1 统一管理工作台顶栏与控制带（Shared Workbench Chrome）

```text
+-----------------------------------------------------------------------------------+
| [Breadcrumb/Title] 应用更新  8                 [规则 (2)] [检查更新] [全部更新 (8)] |
|                    8 款可升级 · 2 条更新规则生效                                     |
+-----------------------------------------------------------------------------------+
| [全部待更新 8]  [关注动态 2]                              [🔍 筛选应用名或仓库... ]  |
+-----------------------------------------------------------------------------------+
```

- **Header（`.manage-header`）**：
  - 左侧：16px 线性图标（stroke 1.5，中性色 `--text-secondary` 或克制 `--brand-primary`）+ 页面主标题（`var(--font-lg)`，`font-weight: 590`）+ 等宽计数徽章（`.manage-count-pill`）+ 单行副标题摘要（如规则数、锁定数或已筛选计数）。
  - 右侧：统一 `28px` 高度按钮簇（`gap: 6px`），次级按钮使用 `btn-secondary` / `btn-ghost` 居左，唯一主按钮 `btn-primary` 居最右。
- **Controls Bar（`.manage-controls-bar`）**：
  - 左侧：下划线式轻量筛选标签（`.manage-filter-tabs` / `.manage-filter-tab`，借鉴 `.pending-segment-row` 风格，**不**使用 `.segmented-group` 类名），支持按状态过滤并展示等宽计数。
  - 右侧：本地搜索框（`.manage-search-box`，宽 `200px–240px`，带清空 `×` 按钮）+（已安装页可选）轻量排序切换按钮（按安装时间 / 按名称）。

### 3.2 `UpdatesView`（应用更新）页面蓝图

1. **流式检查进度条（Checking Strip）**：
   - 检测中显示紧凑的单行进度面板：顶部为状态文案（`正在比对 {app_name}`）与右侧等宽百分比 + `checked / total`，底边贴合 `2px` 线性进度条（`--brand-primary`）。
2. **待更新主面板（`.manage-panel`）**：
   每行 `.manage-row` 采用桌面端 3 段对齐布局：
   - **身份区（Identity，`flex: 1 1 240px`）**：
     - `36×36` 校准图标框（可点击进详情）
     - 第一行：应用名称（`590` 字重，可点击）+ 非 GitHub 代码源微徽章（如有）
     - 第二行：规范仓库坐标 `owner/repo`（等宽 `--text-tertiary`）
   - **版本对比轨（Version Diff，`flex: 0 0 auto`，桌面端定宽对齐轨道 `min-width: 220px; max-width: 300px`）**：
     - `[ 当前版本 ]` `<ArrowRight size={12} />` `[ 最新版本 ]`
     - 当前版本为中性低对比等宽芯片；目标版本为克制的 `--brand-subtle` 强调等宽芯片，超长提交哈希使用 `text-overflow: ellipsis` + 完整 `title` 提示。
   - **操作区（Actions，`flex: 0 0 auto`）**：
     - 「日志」切换按钮（`btn-ghost btn-sm`，`FileText` + 旋转 `ChevronDown`）
     - 「升级」动作按钮（Outline 样式 `.manage-btn-action`，`Download` 13px + 文案，更新中显示 `.icon-spin` 或微加载指示）
     - 「···」更多规则按钮（`MoreHorizontal` 14px，打开 `FlyoutMenu`：忽略本次、跳过版本、锁定版本、隐藏应用）
3. **内联更新日志抽屉（Changelog Drawer）**：
   - 紧贴当前行下方展开（`border-top: 1px solid var(--border-subtle)`，浅层凹陷底色 `var(--bg-canvas)`），带迷你头栏（`v1.8.19 -> v2.4.1 发布说明` + 右侧「查看详情」链接）与限高可滚动 Markdown 正文（`max-height: 260px`）。
   - **空日志修复**：若 `item.changelog` 为空，显示规范占位提示「该版本未提供发布日志，可前往应用详情查看仓库 Release」，避免按钮点击无响应感。
4. **关注动态分组（Watch Notifications）**：
   - 独立作为第二个 `.manage-section`（仅当 `watchNotifications.length > 0` 时渲染），采用同源 `.manage-panel` 细线列表风格：小号标题带 `Eye` 图标 + 计数、28×28 安全区图标、版本发布提示与「查看」「不再提醒」轻量按钮；并支持通过顶部筛选标签快速切到仅看关注动态（或与待更新同屏分节展示）。

### 3.3 `InstalledView`（已安装）页面蓝图

1. **筛选标签与排序**：
   - 筛选标签：`全部`、`已锁定`、`已隐藏`、`待探测`（路径缺失），动态显示对应计数（如锁定或隐藏为 0 时仍可保留禁用/零计数或仅在存在时高亮，具体在 Issue 04 锁定）。
   - 排序切换：`最近安装`（默认，按 `installed_at` 降序）⇄ `名称 A–Z`（按展示名升序）。
   - 搜索过滤：实时按应用展示名、`app_id`（`owner/repo`）、安装路径匹配（复用纯函数过滤）。
2. **已安装主面板（`.installed-list-container.manage-panel`）**：
   每行 `.installed-list-row.manage-row` 结构：
   - **身份与元数据区（`flex: 1 1 320px`，`min-width: 0`）**：
     - `36×36` 校准图标框（可点击进详情）
     - **第一行**：应用展示名（`590` 字重，可点击）+ 等宽版本徽标（`v0.12.6`）+ 安装方式微标签（`MSI` / `Setup` / `Portable` / `WinGet` 等，来自 `install_method`）+ 状态语义标签（`已锁定`、`已隐藏`，以及可选的 `有更新` 点状提示，当 `updatableIds` 命中时展示）
     - **第二行（结构化次级元数据条，彻底消灭浮动跳转 `复制` 按钮）**：
       - 安装日期：`2026/11/12`（等宽 `tabular-nums`）
       - 分隔点 `·`
       - 若有 `install_path`：渲染紧凑的 **集成式路径胶囊（`.manage-path-chip`）**——等宽单行截断路径（`max-width: 380px`，悬停 `title` 展示完整路径）+ 紧贴胶囊右缘的内置图标/微按钮（点击整颗胶囊或末尾复制按钮即可复制路径，瞬态切换为绿色 `Check` + `已复制`）。
       - 若无 `install_path`：渲染虚线提示「未检测到路径」+ 紧邻「重新探测」微按钮（调用 `onScanSystemApps`）。
   - **操作区（`InstalledItemActions`）**：
     - 「卸载」降噪为低对比 Ghost 文字按钮（悬停才显红）；二次确认时原地切换为克制的「确认卸载 / 确认取消」+「取消」紧凑按钮组。
     - 「启动」升级为干净的 **Linear Outline 按钮**（`Play` 12px + 文案，`28px` 高），不再使用刺眼的白色实心填充。
     - 「···」更多菜单统一采用 `lucide-react` 矢量图标，新增「查看详情」与「复制安装路径」（有路径时），保留「锁定/解除锁定」「隐藏/恢复显示」「取消管理」。

---

## 4. 响应式与无障碍约束

- `<= 900px`：更新页版本 Diff 轨与动作区允许有序折行或收窄至 `min-width: 0`；路径胶囊自适应收缩不撑破行宽。
- `<= 640px`：次级元数据（`owner/repo`、安装日期、路径胶囊）按优先级折叠/截断，确保图标、应用名、核心状态与操作按钮始终清晰可用。
- 所有图标按钮提供 `aria-label` 与 `title`；筛选标签与抽屉触发按钮提供 `aria-expanded` / `aria-selected`；动画遵循 `prefers-reduced-motion` 与 `--ease-smooth`。
- **i18n 硬门禁**：所有新增 UI 文案全部进入 `src/locales/zh-CN.json` 与 `src/locales/en-US.json`，通过 `components.i18n.scan.test.ts` 与 `views.i18n.test.tsx`。

---

## 5. 实施 Issue 清单

1. `01-app-icon-contain-and-manage-tokens.md`: `AppIcon` `fit` 安全渲染支持 + `components-manage.css` 工作台样式与图标框基础
2. `02-shared-manage-workbench-primitives.md`: 管理工作台共享组件（`ManageHeader`、`ManageFilterBar`、`ManageAppIcon`）抽取与单元测试
3. `03-updates-view-redesign.md`: `UpdatesView` 彻底重构（图标对齐、版本 Diff 轨、Outline 升级按钮、Changelog 抽屉与空日志修复、流式进度条、关注动态面板）
4. `04-installed-view-redesign.md`: `InstalledView` 与 `InstalledItemActions` 彻底重构（筛选/搜索/排序、集成路径复制胶囊、Outline 启动按钮、全 `lucide-react` 菜单、待更新联动提示）
5. `05-i18n-a11y-and-regression-tests.md`: 双语键齐备、`i18n` 扫描接入、跨视图与暗亮主题回归测试验收
