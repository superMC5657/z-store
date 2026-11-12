# 03: 应用更新页 (`UpdatesView.tsx`) UI 彻底重构

**What to build:** 使用管理工作台共享原语与 Linear 分组细线面板彻底重写 `src/views/UpdatesView.tsx`，解决图标裁切错位、8 个刺眼白色实心升级按钮堆叠、版本对比难扫描、空日志点击无反馈以及关注动态卡片样式割裂等问题；保持全部既有 Props 与回调契约向后兼容。

**Status:** resolved

## 验收清单

- [x] **顶栏与控制带（`ManageHeader` + `ManageFilterBar`）**：
  - 顶栏左侧：`RotateCcw`（`16px`）+ 更新标题 + 副标题（汇总待更新数、生效规则数或关注动态数）。
  - 顶栏右侧：次级按钮「规则（带 `.badge-capsule`）」、「检查更新」（checking 时旋转图标）；当 `updates.length > 0` 时「全部更新 (N)」作为全页唯一 `btn-primary` 置于最右，无待更新时「检查更新」居右。
  - 控制带：当存在 `watchNotifications` 或 `updates.length > 0` 时渲染筛选标签（`全部待更新` / 如有关注动态则出现 `关注动态`，或支持仅看某类）与本地搜索框（按应用名 / `app_id` 过滤，空命中时渲染清晰的筛选空态 + 一键清空筛选按钮）。
- [x] **流式检查进度条重构**：
  - `isChecking` 为真时在顶栏下方展示紧凑 `.manage-progress-banner`：单行展示进度图标、当前比对应用名、`checked / total`（等宽 `tabular-nums`）与百分比，底边贴合 `2px` 实际进度条（`width: ${pct}%`）。
- [x] **待更新列表（`.manage-panel` 细线分组面板）**：
  - 每行 `.manage-row` 严格对齐 3 列轨道：
    1. **身份列**：`<ManageAppIcon size="md" />` + 应用名（`590` 字重，可点击进详情）+ 非 GitHub 代码源徽标（查 `apps` 匹配）+ 第二行等宽 `owner/repo` 坐标。
    2. **版本对比轨**：`[ current_version ]` `<ArrowRight size={12} />` `[ latest_version ]`，采用等宽微胶囊与截断 `title` 提示，替代旧版 `当前: x ➔ 最新: y` 纯文本。
    3. **操作列**：
       - 「查看日志 / 收起日志」改为 `btn-ghost btn-sm`（`FileText` 13px + 旋转 `ChevronDown`）；
       - 单行升级按钮改为 `.manage-btn-action` **Linear Outline 样式**（`Download` 13px / 更新中 `RotateCcw.icon-spin` + 文案），彻底消除右侧白色方块墙；
       - 「···」更多规则按钮使用 `lucide-react` 的 `<MoreHorizontal size={14} />` 替换内联 `<svg>`，打开 `FlyoutMenu`（忽略本次、跳过版本、锁定版本、隐藏应用，全部使用 `flyout-item` 标准布局与 `lucide-react` 图标）。
- [x] **更新日志内联抽屉完善与空日志修复**：
  - 展开态紧贴当前行下方渲染 `.manage-changelog-drawer`：迷你顶栏显示 `current -> latest` 版本摘要与「查看应用详情」微按钮（如有 `onOpenWatchedApp`）；正文区域采用 `.readme-markdown-body` 并限制 `max-height: 260px; overflow-y: auto` 防止长日志撑爆视图。
  - **Bug 修复**：当 `item.changelog` 为空或空白字符串时，展开抽屉显示中性提示文案（如「该版本暂无发布说明」+ 前往详情入口），不再出现点击按钮后毫无内容展开的假死状态。
- [x] **关注动态次级分组（`watchNotifications`）**：
  - 改用同源 `.manage-section` + `.manage-panel` 细线面板呈现（标题带 `Eye` 14px + 计数，`28px` `<ManageAppIcon size="sm" />`，版本胶囊，「查看」Outline 按钮与「不再提醒」Ghost 按钮），彻底消除原本突兀的紫色大块方框。
- [x] **移除全部散落内联样式**：将布局、动画、间距全部迁移至 `components-manage.css`。

**Blocked by:** 01, 02

## Comments
- 2026-11-12：覆盖更新页图标错位、主按钮过载、Changelog 空态无内容与关注动态割裂四大痛点。
- 2026-11-12：已完成 `src/views/UpdatesView.tsx` 重构，并新增 `src/views/UpdatesView.test.tsx` 覆盖。
