# 06: 全站弹窗（5 个 Modal/Dialog）同级按钮统一与自动化回归门禁

Status: resolved
Blocked by: 01

## 目标与背景

统一全部 5 个弹窗（`AppDetailModal`、`DeveloperProfileModal`、`RulesManagerModal`、`AppImportModal`、`InstallConfirmDialog`）中同级相邻按钮的盒尺寸、缺失样式、关闭按钮视框与反色图标光学大小；并新增前端样式/组件自动化回归测试，防止后续出现内联覆盖破坏同排等高或缺失样式类名。

## 验收清单

- [x] **`AppDetailModal` 全子组件对齐（`src/components/AppDetailModal/Header.tsx`, `InstallActions.tsx`, `AssetList.tsx`, `ReadmeSection.tsx`, `src/styles/components-modal.css`）**：
  - **Header 右上角 5 按钮（`Header.tsx:288-380`, `components-modal.css:64-124`）**：
    - 关闭按钮统一复用 `.modal-header-btn.modal-close-btn`（消除缺少 `focus-visible`、缺内联覆盖 `position: relative; top: auto; right: auto;` 的割裂），并把关闭 `×` SVG 从 `12×12 viewBox="0 0 10 10"` 改为标准 `14×14 viewBox="0 0 24 24" strokeWidth="1.5"`（或 `<X size={14} strokeWidth={1.5} />`），使 5 个并列 `28×28px` 图标按钮内部图形跨度与线条粗细完全一致。
    - `Watch` 眼睛按钮激活态（`Header.tsx:334`）废除整眼实心 `fill="currentColor"`，改为半透明背景 + 实心瞳孔；`Favorite` / `Star` 激活态施加微缩光学平衡。
    - 开发者跳转按钮（`Header.tsx:406-426`）：移除内联 `padding: '2px 8px', lineHeight: '1.4'`，改用 `btn-fluent btn-secondary btn-sm`（`26px`）或紧凑文本按钮，避免 `30px` 高胶囊撑高副标题行。
  - **InstallActions 操作簇（`InstallActions.tsx:206-394`, `components-modal.css:376-414`）**：
    - 依托 Issue 01 补全的 `.btn-danger` 与 `.btn-fluent.btn-icon-only`，修复 `InlineConfirmButton` 卸载按钮缺失边框/背景的问题，并保证「全部资产 (N)」「取消管理」「卸载 / 确认卸载 + ×」「打开文件夹」「启动 / 安装 / 下载」全部严格等高 `30px`，且相邻 `btn-primary` 不带外扩底影、享受反色光学收敛。
  - **AssetList 资产行（`AssetList.tsx:69-88`, `components-modal.css:416-447`）**：
    - `.detail-asset-btn` 收口为复用 `.btn-compact`（`28px`），选中态 `.btn-primary`（`当前已选`）自动去除外投影并应用反色光学平衡，与右侧 `直链`（`<a>`）视觉等大。
  - **ReadmeSection 语言切换（`ReadmeSection.tsx:93-128`）**：
    - 评估并优化 `中文` / `English` 切换按钮组：维持 `btn-sm` (`26px`) + `minWidth: 56px` 时应用反色光学平衡（或统一为 `SegmentedControl` 风格单色激活滑块，避免纯白方块压过右侧透明按钮；注意保留 `aria-pressed` 与 `AppDetailModal.readme.test.tsx` 断言）。
- [x] **`RulesManagerModal.tsx`（`src/components/RulesManagerModal.tsx:163-193, 324-346, 524-572`）**：
  - **头部按钮组（第 163-193 行）**：将 `+ 新增规则` 按钮改为 `btn-fluent ... btn-compact`（**`28px`**），与紧邻的 `.modal-close-btn`（**`28×28px`**）彻底消除 `2px` 高度差！同步升级关闭 `×` SVG 为 `14×14 viewBox="0 0 24 24" strokeWidth="1.5"`。
  - **新增表单底栏（第 324-346 行）**：去除 `padding: '6px 14px'` 与 `padding: '6px 18px'` 不对称内联，统一走标准 `.btn-fluent` (`30px`)。
  - **规则列表行内 4 按钮（第 524-572 行）**：去除内联 `style={{ fontSize: 'var(--font-xs)', padding: '4px 8px' }}`，统一改为 `btn-fluent btn-secondary btn-sm`（`26px`）或 `btn-compact`（`28px`）；「移除规则」改为 `btn-fluent btn-danger btn-sm`（复用规范危险按钮而非裸改字色）。
- [x] **`DeveloperProfileModal.tsx`（`src/components/DeveloperProfileModal.tsx:98-108, 153-166, 320-402`）**：
  - **仓库列表行内操作区（第 320-402 行）**：修复「查看」（`30px`）与「已安装」（`.btn-install` `28px`）高差 `2px` 的缺陷！将行内全部按钮（`查看`、`未知占位`、`已安装`、`安装`、`GitHub 外链`）统一收口为 **`28px`**（`.btn-compact` + `.btn-install` `28px`；外链按钮使用 `btn-compact btn-icon-only` `28×28px`）；去除全部内联 `padding`/`fontSize`。
  - **头部外链与关闭钮（第 98-108, 153-166 行）**：GitHub 按钮改 `btn-fluent btn-secondary btn-sm`（去内联 padding）；关闭 `×` 升级至 `14×14 viewBox="0 0 24 24" strokeWidth="1.5"`。
- [x] **`AppImportModal.tsx` 与 `InstallConfirmDialog.tsx`**：
  - `AppImportModal.tsx:170-181, 413-447`：底栏「取消」与「导入选中应用 (N)」去除不对称内联 `padding: '6px 16px'` vs `'6px 20px'`，统一走标准 `.btn-fluent` (`30px`) + 反色光学平衡；头部关闭 `×` 升级至 `14×14 viewBox="0 0 24 24" strokeWidth="1.5"`。
  - `InstallConfirmDialog.tsx:92-105`：底栏「取消」与「确认安装」受益于 Issue 01 去外投影与反色光学收敛，视觉等大。
- [x] **自动化回归门禁测试**：
  - 新增样式与组件级契约测试（如 `src/styles/buttons.parity.test.ts` 或在既有组件测试中扩展）：
    1. 解析 `src/styles/components-buttons.css`，断言 `.btn-fluent`、`btn-compact`（`28px`）、`btn-sm`（`26px`）、`.btn-danger`、`.btn-warning`、`.btn-fluent.btn-icon-only` 规则完整存在且三档高度字面量精确锁定；
    2. 断言 `PlatformIcons.tsx` 中实心图标（`WindowsIcon`/`AppleIcon`/`GitHubIcon`）存在光学缩放补偿，避免回归到满幅膨胀；
    3. 渲染 `AppCard`（含 `onMoveInApp` / `showLoadDetail`）、`UpdatesView`、`InstalledView`、`RulesManagerModal`、`DeveloperProfileModal`、`AppDetailModal`，断言同排相邻按钮均挂载同档位尺寸类且不携带破坏性内联 `height`/`padding` 样式。
  - 运行全量相关测试套件：`pnpm vitest run` 重点验证前端组件与视图测试全部通过，以及 `pnpm typecheck` 零错误。

## Comments

- 2026-11-12：由 `spec.md` 拆出。依赖于 Issue 01。
- 2026-11-12：已完成 5 个弹窗对齐及 `src/styles/buttons.parity.test.tsx` 回归门禁测试，`pnpm check`（95 文件 985 项测试全过）与 `pnpm build` 生产构建通过。
