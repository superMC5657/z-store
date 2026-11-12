# 02: 壳层（TitleBar & Sidebar）同级按钮与图标光学对齐

Status: resolved
Blocked by: 01

## 目标与背景

对齐顶部标题栏（`src/components/TitleBar.tsx`、`src/styles/layout-titlebar.css`）与左侧导航栏（`src/components/Sidebar.tsx`、`src/styles/layout-sidebar.css`）中所有同级相邻按钮的盒模型、可访问性轮廓与内部图标视觉大小，重点解决 `Sidebar` 平台宫格中实心/线性图标混排失衡以及 `TitleBar` 右侧工具按钮图标跨度不一的问题。

## 验收清单

- [x] **`TitleBar.tsx` 右侧控制区对齐（`src/components/TitleBar.tsx:226-425`, `src/styles/layout-titlebar.css:186-285`）**：
  - 将 `.win-btn` 由 `<div>` 语义化替换为 `<button type="button">`（保留 `data-tauri-drag-region="false"` 与 `onDoubleClick` 阻止冒泡），补全 `border: 1px solid transparent; box-sizing: border-box;` 与 `:focus-visible` 焦点环，使其盒模型行为与 `.nav-toggle-btn`、`.theme-toggle-btn`、`.lang-toggle-btn` 完全一致（高度均严格为 `28px`）。
  - 统一标题栏按钮内部图标光学尺寸：
    - `theme-toggle-btn` 太阳/月亮图标（`TitleBar.tsx:381-397`）由 `15×15`（射线达 `1..23` 贴边）收敛为与 `nav-toggle-btn`（`14×14`）一致的 `14×14` 安全视框（如采用 `lucide-react` `Sun` / `Moon` `size={14} strokeWidth={1.5}`），消除太阳图标比左侧汉堡与语言图标显大一圈的问题。
    - `win-btn` 窗口控制图标（最小化/最大化/关闭）统一视框与笔触比例；针对 `.win-btn.close:hover`（红底白 `×` 反色高对比态），对关闭 `×` 图标施加光学收敛（或保持 `10×10` 但 `strokeWidth="1.35"` 居中）避免悬停反色时叉号显粗。
  - 搜索历史下拉框中的「清空全部」按钮（`TitleBar.tsx:300-315`）与历史芯片删除 `×` 改为 `<button type="button">` 标准样式类（去除散落内联样式），保证对齐基线与键盘可达性。
- [x] **`Sidebar.tsx` 平台开关宫格与导航胶囊对齐（`src/components/Sidebar.tsx:242-378`, `src/styles/layout-sidebar.css:73-471`）**：
  - 验证 `.platform-grid` 中 6 个同级 `.platform-chip` 按钮在展开态（`44px` 高）与折叠态（`28px` 高）下，经 Issue 01 实心图标 `scale(0.86)` 优化后，`Windows` / `macOS` 图标不再比 `Linux` / `Android` / `iOS` / `Other` 显得更大更重。
  - 统一 `Sidebar.tsx` 展开态下 `.nav-item`（`30px`）与底部 `.network-pill`（当前 `28px`，`layout-sidebar.css:242`）的设计协调性（明确 `.network-pill` 展开态若同归侧栏操作胶囊则对齐 `30px`，折叠态两者同为 `44×32px`）；同时确保底部未登录态的实心 `GitHubIcon` 经 Issue 01 光学缩比后与上方线性导航图标视觉等大。
- [x] **验证**：
  - 运行 `pnpm vitest run src/components/TitleBar.test.tsx src/components/Sidebar.test.tsx` 通过（如有依赖 `.win-btn` 选择器的用例同步兼容）。

## Comments

- 2026-11-12：由 `spec.md` 拆出。依赖于 Issue 01 的 `PlatformIcons` 实心光学缩比。
- 2026-11-12：已完成 `TitleBar.tsx`、`layout-titlebar.css` 与 `layout-sidebar.css` 对齐改造，`pnpm check` 与 `pnpm build` 通过。
