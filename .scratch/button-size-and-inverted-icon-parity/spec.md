# Feature Spec: 全站同级按钮尺寸严格统一与反色图标光学优化 (`button-size-and-inverted-icon-parity`)

> 审计范围：覆盖 ZStore 全站 9 个主视图（`HomeView`、`LatestView`、`CategoriesView`、`TrendsView`、`PendingView`、`InstalledView`、`UpdatesView`、`FavoritesView`、`SettingsView`）、应用壳层（`TitleBar`、`Sidebar`、`ToastContainer`、`ErrorBoundary`）、共享组件（`AppCard`、`InlineConfirmButton`、`SegmentedControl`、`PlatformIcons`、`ManageHeader`、`ManageFilterBar`）及全部 5 个弹窗（`AppDetailModal`、`DeveloperProfileModal`、`AppImportModal`、`RulesManagerModal`、`InstallConfirmDialog`）。  
> 设计基线：严格遵循 `CONTEXT.md` **D4 Linear 去彩单色界面** 与 **Fluent 2 矢量图标体系**，所有新增与修改仅面向前端样式及组件层，零后端/IPC 改动。

---

## 1. 核心需求与硬性约束

1. **同级（相邻）按钮物理尺寸严格一致**：
   - 同一工具栏、页头按钮簇、列表行动作区、卡片页脚、弹窗顶/底栏、设置项控件组、标题栏右侧控制区内的同级相邻按钮（含 `<button>` 与 `<a>` 链接按钮，以及与按钮同行紧邻的输入框 `input`），其 **外盒物理高度（`height` 含 `1px` 上下边框、`box-sizing: border-box`）必须 100% 相等**。
   - 同排相邻的纯图标按钮，除高度严格相等外，**外盒宽度（`width === height`）与内部图标名义尺寸/有效视觉跨度必须一致**。
   - 禁止在 JSX 中使用内联 `style={{ padding, height, fontSize, lineHeight }}` 临时魔改 `.btn-fluent` 盒模型；所有尺寸变体一律通过标准 CSS 尺寸修饰类收口。
2. **反色按钮与反色/实心图标光学平衡（Optical Parity）**：
   - **问题根源（辐射错觉 / Irradiation Illusion & Ink Area 差异）**：
     1. **反色实底主按钮（`.btn-primary` / 危险实底按钮）**：深色模式下 `--btn-primary-bg: #F7F8F8` 白底黑字、浅色模式下 `#08090A` 黑底白字。高亮实心矩形在暗背景上发生强烈向外光晕扩散，与旁边的透明 hairline 描边次级按钮（`.btn-secondary`）即使 CSS 高度同为 `30px` 或 `26px`，人眼主观上仍感知实底反色按钮 **宽出/高出 `1–2px`**，且按钮内部的反色图标显得更粗大、压迫边缘。
     2. **实心填充图标（`fill="currentColor"` / `fill="#..."`）与线性图标（`fill="none" strokeWidth="1.5"`）混排**：实心剪影（如 `WindowsIcon`、`AppleIcon`、`GitHubIcon`、`GitLabIcon`、`CodebergIcon`、激活态 `Eye`/`Bookmark`/`Star`、实心 `Play`）的有效墨水面积（ink area）比同尺寸 `1.5px` 描边线性图标高出 2–4 倍，视觉上显著显得**大出 15%–25%**。
     3. **投影外溢与 `viewBox` 占空比差异**：`components-buttons.css` 第 122 行仅用 `div:has(> .btn-fluent.btn-secondary) > .btn-fluent.btn-primary` 剥离外投影，对邻接 `.btn-ghost`、`.btn-danger`、`.manage-btn-action`、`.btn-install` 或跨 wrapper（如 `InlineConfirmButton`）场景全部失效；同时弹窗关闭叉号（`viewBox="0 0 10 10"` 12px → 实际跨度 9.6px）与同排 `24×24` 14px 图标（跨度 ~11.7px）视框比例不一。

---

## 2. 全局按钮尺寸阶梯与光学补偿规范

### 2.1 三档严格按钮高度阶梯（`src/styles/components-buttons.css`）

废除“只定义 `30px` 与 `26px`、各处临时手写 `28px`/`32px`”的现状，确立三档正交尺寸修饰类（全部强制 `box-sizing: border-box; border-width: 1px; border-style: solid; line-height: 1; white-space: nowrap;`）：

| 档位类名 | 严格高度 (`height` = `min` = `max`) | 水平内边距 | 字号 | 图标名义尺寸 | 正方形纯图标类 (`.btn-icon-only`) | 适用场景 |
|---|---|---|---|---|---|---|
| 默认 `.btn-fluent`（`md`） | **`30px`** | `0 12px` | `var(--font-base)` (13px) | `14px` | `30px × 30px` | Hero 横幅主次按钮、弹窗 Footer 确认/取消、空态大 CTA、独立表单提交 |
| `.btn-fluent.btn-compact`（新增 `compact` 档） | **`28px`** | `0 10px` | `var(--font-sm)` (12px) | `13px` | `28px × 28px` | **与 `28px` 控件同排的一切场景**：工作台 Header/控制带/行动作区、设置行（含 `.settings-input` 同排）、卡片 `.app-card-footer`（与 `.btn-install` 同高）、`PendingRichCard` 手动标记行、弹窗 Header 图标区与 `AssetList` 资产行、标题栏控件 |
| `.btn-fluent.btn-sm`（`sm` 档） | **`26px`** | `0 8px` | `var(--font-sm)` (12px) | `12px` | `26px × 26px` | 极紧凑内联次级动作（草稿表单/富卡底部动作栏、预览折叠、小号重试/切换、规则列表行内动作） |

> **关键对齐规则**：
> - 凡与 **`28px` 输入框/搜索框/下拉框**（`.settings-input`、`.select-fluent`、`.manage-search-box`）或 **`.btn-install`（`28px`）** / **`.manage-btn-action`（`28px`）** / **`.manage-btn-icon`（`28px`）** / **`.modal-header-btn`（`28px`）** 同排相邻的按钮，一律使用 `28px` 档（`.btn-compact` 或将输入框同步对齐为 `28px`）。
> - `PendingRichCard` 手动标记行的 `.input-fluent` 在 `.pending-manual-row` 中锁定 `height: 28px`（或按钮升至 `30px`，本规范统一推荐 **输入+按钮同为 `28px`**，与设置中心 `.settings-input-group` 完全一致）。

### 2.2 补全缺失的语义变体（`.btn-danger` / `.btn-warning` / `.btn-fluent.btn-icon-only`）

- 现状缺陷：`InlineConfirmButton.tsx` 拼接出 `.btn-fluent.btn-danger` 与 `.btn-fluent.btn-warning`，但全站 CSS **完全缺失** `.btn-danger` 与 `.btn-warning` 定义，导致 `AppDetailModal/InstallActions.tsx` 中的「卸载」按钮退化为无边框透明按钮（甚至在部分浏览器呈现默认灰底），与相邻 `全部资产`、`取消管理`、`启动` 视觉完全割裂。
- 规范：
  - 新增 `.btn-fluent.btn-danger`（常态 subtle 危险语义：`background: transparent; color: var(--status-danger); border-color: rgba(220, 38, 38, 0.25);` / hover：`background: var(--status-danger-bg); border-color: rgba(220, 38, 38, 0.45);`；二次确认态新增 `.btn-danger-solid` 或确认专属高亮态，与 `.btn-installed-uninstall` / `.btn-confirm-danger` 同色系且严格同高）。
  - 新增 `.btn-fluent.btn-warning`（同规格琥珀黄 subtle 边框与 hover）。
  - 新增通用 `.btn-fluent.btn-icon-only`（不依赖 `.installed-action-btn`）：`padding: 0;` 且自动按 `md` (`30×30`)、`btn-compact` (`28×28`)、`btn-sm` (`26×26`) 锁定宽高，消灭 `InlineConfirmButton.tsx` 第 64 行硬写 `width: 30px; height: 30px` 内联样式。

### 2.3 同排外轮廓去投影与反色按钮/图标光学补偿策略

1. **彻底消除同排底部外投影差**：
   - 将 `components-buttons.css` 中脆弱的 `div:has(> .btn-fluent.btn-secondary) > .btn-fluent.btn-primary` 升级为通用按钮簇规则：任何同排含相邻按钮（`.btn-fluent` / `.manage-btn-action` / `.btn-install`）的容器内的 `.btn-primary`，或全站 `.btn-fluent.btn-primary` 统一去除外扩底影（只保留不占外围像素的 `var(--btn-primary-inset)`），使 `btn-primary` 与同排 `btn-secondary` / `btn-ghost` / `btn-danger` 具有 **0px 差异的外接矩形剪影**。
2. **反色实底按钮（`btn-primary` / 实底危险确认态）的光学收缩补偿**：
   - **视觉边界补偿**：深色模式下，亮白 `#F7F8F8` 实底按钮在暗画布上的辐射膨胀最明显。通过将 `--btn-primary-bg` 在深色模式下配合 `background-clip: padding-box` 与 `border-color: rgba(255, 255, 255, 0.08)` 或引入 `inset 0 0 0 0.5px var(--bg-canvas)` 光学微缩环（或略微柔和的高对比白 `#EFEFEF` / hover `#FFFFFF`，同时保持高可读性），使实底高亮区域的视觉边界向内收敛约 `0.5px–1px`，从而在视觉高度和宽度上与邻接 `1px` 描边 `btn-secondary` **视觉等大**。
   - **反色按钮内部图标光学微缩**：在反色实底按钮（`.btn-primary`、`.win-btn.close:hover`、实底危险按钮）中的 `svg`，通过 CSS 规则（如 `.btn-fluent.btn-primary svg { transform: scale(0.9); }` 或下调 1px 名义尺寸：`14px → 13px` / `13px → 12px` / `12px → 11px`）配合适当字距/间隙，抵消高反差实底导致的图标视觉放大效应。
3. **实心/填充图标与线性图标混排的光学归一化**：
   - **平台与代码源图标（`src/components/icons/PlatformIcons.tsx`）**：
     - `WindowsIcon`、`AppleIcon`、`GitHubIcon`、`GitLabIcon`、`CodebergIcon` 均为 `fill="currentColor"` 实心图形；而同级的 `LinuxIcon`、`AndroidIcon`、`IosIcon`、`OtherIcon`、`GiteaIcon` 为 `fill="none" strokeWidth="1.5"` 线性图形。
     - 对所有实心填充类品牌 SVG 统一施加光学微缩（在其 `24×24` viewBox 内按中心 `transform="translate(12,12) scale(0.86) translate(-12,-12)"` 或 CSS `.icon-solid-optical { transform: scale(0.86); }` 缩比），使其有效视觉外径与相邻 `1.5px` 描边线性图标完全等大。
   - **交互激活态反色/实心图标（`Watch` 眼睛、`Favorite` 书签、`Star` 星标、`Play` 启动）**：
     - **Watch 眼睛图标**（`AppCard.tsx`、`TrendsView.tsx`、`AppDetailModal/Header.tsx`）：废除 `fill="currentColor"` 全眼涂死导致瞳孔消失且视觉臃肿的做法；改为**保持 `strokeWidth="1.5"` 线性外框 + 内部瞳孔高亮/半透明底填充 `fill="color-mix(in srgb, currentColor 18%, transparent)"`**（仅中间 `<circle cx="12" cy="12" r="3" fill="currentColor" />` 实心点亮），既保留强烈激活反馈，又与邻近书签/刷新/星标图标保持完全一致的视觉尺寸！
     - **Favorite 书签 / Star 星标激活态**：书签与星标激活填充时叠加 `transform: scale(0.92)`（或 `fill="color-mix(in srgb, #eab308 22%, transparent)"` + `stroke="#eab308"` 半充描边 / 微缩实心），消除“点亮后图标突然变胖一圈”的跳变感。
     - **Installed 启动按钮 `Play` 图标**（`InstalledItemActions.tsx:133`）：将实心 `<Play size={11} fill="currentColor" strokeWidth={0} />` 统一为线性 `<Play size={13} strokeWidth={1.5} />`（对齐 `UpdatesView` 的 `Download size={13} strokeWidth={1.5}` 与 `AppDetailModal/InstallActions` 的 `Play strokeWidth={1.5}`）。
   - **弹窗关闭按钮与标题栏按钮视框对齐**：
     - 全站关闭按钮（`AppDetailModal/Header.tsx`、`AppImportModal.tsx`、`DeveloperProfileModal.tsx`、`RulesManagerModal.tsx`）的 `×` SVG 从 `width="12" viewBox="0 0 10 10"`（跨度 `9.6px`）统一升级为标准 `viewBox="0 0 24 24" width="14" height="14" strokeWidth="1.5"`（或直接用 `lucide-react` `<X size={14} strokeWidth={1.5} />`），并对齐与同排 `.modal-header-btn` 完全相同的盒模型（`28×28px`，`focus-visible`，`border: 1px solid transparent`）。
     - `TitleBar.tsx` 太阳/月亮切换图标从 `15×15` 射线贴边（`1..23`）调整至 `14×14` 标准 `lucide-react` 2..22 安全区比例，使汉堡菜单、语言切换、主题切换、窗口三键在 `28px` 高度下图标视觉重心与大小一致。

---

## 3. 全站逐页同级按钮与图标问题审计矩阵

| 模块 / 页面 | 位置（文件与行号） | 现存问题（尺寸错位 / 样式缺失 / 反色显大） | 目标规范 |
|---|---|---|---|
| **全局基座** | `components-buttons.css:3-125`, `tokens.css` | 缺少 `28px` `.btn-compact`、缺少 `.btn-danger`/`.btn-warning`/`.btn-fluent.btn-icon-only`；`:has()` 外投影规则漏网多；`btn-primary` 缺反色光学收敛 | 建立 `30/28/26px` 三档类，补全语义变体与全场景去外投影，落地反色按钮与实心图标光学缩放 |
| **TitleBar** | `TitleBar.tsx:226-424`, `layout-titlebar.css:186-285` | `.win-btn` 为 `<div>`（`32×28px`，无 `1px solid transparent` 占位与 `focus-visible`），图标 `10px` vs `theme-toggle-btn` `15px` vs `nav-toggle-btn` `14px` vs `lang-toggle-btn` `13px`；`.win-btn.close:hover` 红底白叉显大；历史清除/删除为无尺寸内联按钮 | `.win-btn` 改 `<button>`、补全标准边框与焦点环；统一右侧按钮内部图标有效跨度；历史清除/删除收口为标准小按钮 |
| **Sidebar** | `Sidebar.tsx:242-378`, `layout-sidebar.css:73-471` | `.platform-grid` 中 `Windows`/`Apple` 为全实心填充，同排 `Linux`/`Android`/`iOS`/`Other` 为细线描边，实心显著偏大；展开态 `.nav-item` (`30px`) vs 底部 `.network-pill` (`28px`) | `PlatformIcons` 实心图标 `scale(0.86)` 光学微缩；保持 `.nav-item` 与 `.network-pill` 协调尺寸与对齐 |
| **HomeView** | `HomeView.tsx:378-416, 471-480` | `.hero-actions` 按钮 1 (`padding: 8px 20px; 13px; Zap 14`) vs 按钮 2 (`padding: 9px 18px; 13.5px; ArrowRight 13`) 参数完全不同且 `btn-primary` 反色膨胀；`clear_recent` 内联 `padding: 2px 8px; 11px` | Hero 两按钮清除内联样式统一走 `.btn-fluent` (`30px`) + 对称 `14px` 图标与反色微缩；`clear_recent` 改走 `.btn-fluent.btn-compact` (`28px`) 或 `.btn-sm` (`26px`) |
| **AppCard** | `AppCard.tsx:233-268, 362-481`, `components-app-card.css:158-192` | 底部操作区 `move-in` / `load-detail` (`btn-fluent` **`30px`**) 与相邻 `.btn-install` (**`28px`**) **同排高差 2px**，字号 `11px` vs `12px`，图标 `12px` vs `13px`；头部 `Watch` 激活态 `fill="currentColor"` 整眼涂实遮瞳显大 | `move-in` / `load-detail` 与 `.btn-install` 全部统一为 **`28px`**（`.btn-compact` + `var(--font-sm)` + `13px` 图标）；`Watch` 改半透明底 + 实心瞳孔；`Favorite` 激活态光学微缩 |
| **TrendsView** | `TrendsView.tsx:491-565` | 裸行 `trend-move-in` 为 `btn-fluent` (`30px`) + 内联 `padding: 2px 8px`，与榜单其它富卡 `.btn-install` (`28px`) 及同排 `.btn-fav-card` (`24px`) 错位；`Watch` 激活态全实心显大 | 裸行 `trend-move-in` 统一为 `28px`（`.btn-compact`）对齐 `.btn-install`，去除内联 padding；`Watch`/`Fav` 同步光学优化 |
| **LatestView** | `LatestView.tsx:209-260, 290-295` | 7d 空态双钮 (`btn-sm` `26px`) 与 `FilterEmptyState` (`30px`) 档位不一；`btn-primary` vs `btn-secondary` 反色视觉差 | 统一空态 CTA 尺寸层级与反色光学补偿 |
| **CategoriesView** | `CategoriesView.tsx:247-254, 414-416` | 返回按钮写死内联 `style={{ gap: '6px' }}` 覆盖 `.btn-sm` | 清除内联 gap，统一走 `.btn-compact` (`28px`) 或 `.btn-sm` (`26px`) |
| **FavoritesView** | `FavoritesView.tsx:131-176, 291-314, 344-364` | 顶栏 `SegmentedControl` (`34px`) 与右侧 `.fluent-input-search` (`30px`) 差 `4px`；Starred 同步按钮 `28px` 带非标 `12.5px` 字且保留底部外投影；批量安装/收藏内联 `padding: 4px 12px` 与 `30px` 锁高冲突且反色显大 | 同步区/批量操作区去除内联 `padding`/`fontSize`，按区统一 `28px`（`.btn-compact`）或 `30px` 并去外投影；搜索框与分段控制带视觉基线对齐 |
| **PendingView** | `PendingDraftForm.tsx:550-599`, `PendingRichCard.tsx:131-297`, `PendingPreviewLane.tsx:49-67` | **`PendingRichCard` 手动标记行 `.input-fluent` (`30px`) vs `标记为已提交` (`btn-sm` `26px`) 相差 `4px`！**；草稿/富卡 footer 反色 `btn-primary` 紧挨多个 `btn-secondary` 显大；已归档 `复制为新草稿` 内联 `11px`；`PendingPreviewLane` 内联覆写 `.pending-preview-toggle-btn` | `.pending-manual-row` 输入框与按钮统一 **`28px`**（`.btn-compact`）；Footer 保留 `pending-collect-local` / `pending-submit-pr` 的 `btn-primary` 类名与 `marginLeft: auto`（守住 `PendingView.pr.test.tsx`）并应用反色光学收缩；清除内联字号覆盖 |
| **InstalledView** | `InstalledView.tsx:193-273`, `InstalledItemActions.tsx:62-148` | 控制带 `排序` (`btn-sm` **`26px`**) vs 右侧 `.manage-search-box` (**`28px`**) **差 `2px`**；顶栏 `规则` 按钮紫底白字胶囊撑感 + 最右 `扫描本地` 反色显大；行内「启动」使用实心 `<Play fill="currentColor" strokeWidth={0} size={11} />` 异类图标 | 控制带 `排序` 按钮改 **`28px`**（`.btn-compact`）与搜索框完全等高；`InstalledItemActions` 启动图标改线性 `<Play size={13} strokeWidth={1.5} />`；顶栏 `28px`（或 `26px`）胶囊/反色光学平衡（守住 `InstalledView.test.tsx`） |
| **UpdatesView** | `UpdatesView.tsx:231-291, 405-424, 535-580` | **列表行 `查看日志` (`btn-sm` `26px`) vs `升级` (`manage-btn-action` `28px`) vs `···` (`manage-btn-icon` `28px`) 差 `2px`！** **关注动态行 `查看详情` (`28px`) vs `不再提醒` (`btn-sm` `26px`) 差 `2px`！** 顶栏 `全部更新` 反色显大 | 行内 `查看日志` 与 `不再提醒` 统一升级为 **`28px`**（`.btn-compact`），实现全行 100% 等高 `28px`；顶栏统一光学平衡（守住 `UpdatesView.test.tsx`） |
| **SettingsView** | `NetworkDataSection.tsx`, `UpdatesRulesSection.tsx`, `ClientUpdateRow.tsx`, `OAuthAccountCard.tsx`, `AffinityPrivacyRow.tsx`, `DataBackupRow.tsx`, `LogExportRow.tsx`, `StorageSection.tsx`, `DataManagementSection.tsx` | **自定义源展开行 `.settings-input` (`28px`) vs 按钮 (`32px`) 差 `4px`** + 硬编码 `#ef4444` 红底白字按钮；`ClientUpdateRow` (`26px`) vs 同组 `UpdatesRulesSection` (`30px`) **差 `4px`**；`NetworkDataSection` 代理行 (`28px`) vs 清单同步行 (`30px`)；`OAuthAccountCard` 5 处不同内联 `padding`；大量行内冗余 `padding: '6px 14px'` / `'6px 12px'` | **设置中心全页动作按钮统一收口为 `28px` 档（`.btn-compact`）**，与 `.settings-input` (`28px`) 100% 齐平；红底确认按钮改走标准 `.btn-danger-solid`；全面消除内联 `padding`/`height`/`fontSize` |
| **AppDetailModal** | `Header.tsx:288-426`, `InstallActions.tsx:206-394`, `AssetList.tsx:69-88`, `ReadmeSection.tsx:93-128` | **`InstallActions` 中「卸载」使用缺失的 `.btn-danger`，退化为无边框透明钮**；`Header` 关闭钮 (`12px viewBox 10×10`) 比同排 4 图标 (`14px viewBox 24×24`) 明显偏小，激活态 `Watch` 实心紫眼遮瞳显大；`Header` 开发者按钮 `30px` 胶囊偏高；`AssetList` 选中态 `btn-primary` 反色显大；`ReadmeSection` 语言切换 `btn-primary` vs `btn-secondary` 视觉不平衡 | 补全 `.btn-danger`/`.btn-warning` 与 `InlineConfirmButton` `30px` 等高对齐；`Header` 5 按钮统一 `.modal-header-btn` + `14px strokeWidth 1.5` 图标 + 光学优化激活态；开发者链接改 `26px` `.btn-sm`；`AssetList`/`ReadmeSection` 应用反色光学平衡（`ReadmeSection` 可升级为 `SegmentedControl` 或等大微调态） |
| **其它弹窗** | `RulesManagerModal.tsx`, `DeveloperProfileModal.tsx`, `AppImportModal.tsx`, `InstallConfirmDialog.tsx` | **`RulesManagerModal` 头部 `+ 新增规则` (`30px`) vs 相邻关闭钮 (`28px`) 差 `2px`**，行内 4 按钮 `30px` 配 `11px` 小字；**`DeveloperProfileModal` 行内 `查看` (`30px`) vs `已安装` (`.btn-install` `28px`) 差 `2px`**，头部 GitHub 链接 `30px` 配 `11px` 小字；`AppImportModal` 底栏 `padding: 6px 16px` vs `6px 20px` 不对称 | `RulesManagerModal` 头部统一 `28px`、行内 4 按钮统一 `28px` (`.btn-compact`)；`DeveloperProfileModal` 行内统一 `28px`（`查看`/`安装`/`已安装`/`外链`）、头部外链改 `26px` `.btn-sm`；`AppImportModal` & `InstallConfirmDialog` 底栏去除不对称内联 padding 并应用反色光学平衡 |

---

## 4. 实施 Issue 清单

1. [`01-button-tokens-optical-system.md`](./issues/01-button-tokens-optical-system.md): 全局按钮三档尺寸体系（`30/28/26px`）、`.btn-danger`/`.btn-warning` 补全与反色按钮/实心图标光学补偿基础设施
2. [`02-shell-titlebar-and-sidebar-parity.md`](./issues/02-shell-titlebar-and-sidebar-parity.md): 壳层同级按钮与图标光学对齐（`TitleBar` 控件区 & `Sidebar` 平台宫格实心/线性图标平衡）
3. [`03-discovery-views-and-appcard-parity.md`](./issues/03-discovery-views-and-appcard-parity.md): 发现域视图与 `AppCard` 同排按钮统一（`HomeView`、`TrendsView`、`LatestView`、`CategoriesView`、`FavoritesView`、`AppCard`）
4. [`04-manage-and-pending-views-parity.md`](./issues/04-manage-and-pending-views-parity.md): 管理中心与待收录工作台同排按钮等高统一（`UpdatesView`、`InstalledView`、`InstalledItemActions`、`PendingView` 系列）
5. [`05-settings-view-button-parity.md`](./issues/05-settings-view-button-parity.md): 设置中心全分组按钮 `28px` 归一化与输入控件等高对齐（`SettingsView` 全部 5 组子组件）
6. [`06-modals-and-visual-regression-guard.md`](./issues/06-modals-and-visual-regression-guard.md): 全部 5 个弹窗同级按钮与视框统一 + 自动化按钮尺寸/契约回归门禁测试
