# 05: 双语文案、静态门禁与全量回归验收

**What to build:** 补齐重设计引入的所有 `zh-CN` / `en-US` 本地化键，将新建管理工作台组件纳入 `components.i18n.scan.test.ts` 静态扫描防线，完善并扩充 `UpdatesView` / `InstalledView` 单元测试，完成全套测试与 TypeScript 类型检查。

**Status:** resolved

## 验收清单

- [x] **双语 Locale 对齐（`src/locales/zh-CN.json` & `src/locales/en-US.json`）**：
  - 保留并兼容既有 `installed.*` 与 `updates.*` 键；补齐新 UI 所需键（如筛选标签 `全部/已锁定/已隐藏/待探测`、`全部待更新/关注动态`、搜索占位与清空、排序切换、日志抽屉标题/空日志提示、安装方式标签、待更新提示标签、菜单「查看详情」「复制路径」等）。
  - 确保 `zh-CN.json` 与 `en-US.json` 键集完全对称（通过 `components.i18n.scan.test.ts` 检查）。
- [x] **静态 i18n 扫描防线扩展（`src/components/components.i18n.scan.test.ts`）**：
  - 将 `../views/manage/ManageAppIcon.tsx`、`../views/manage/ManageHeader.tsx`、`../views/manage/ManageFilterBar.tsx`、`../views/InstalledView/InstalledItemActions.tsx`（及按需 `../views/UpdatesView.tsx`、`../views/InstalledView.tsx`）追加至 `MIGRATED_FILES`，保证零 CJK 硬编码。
- [x] **单元测试补强**：
  - 确认 `src/views/views.i18n.test.tsx` 中既有的 `InstalledView` 与 `UpdatesView` 中英文切换、无 `.segmented-group` 断言全部通过。
  - 新增 `src/views/UpdatesView.test.tsx`：验证对齐版本 Diff 展示、搜索过滤、空 `changelog` 展开占位提示、非空 Markdown 日志展开与详情联动、流式进度百分比渲染、关注动态面板展示与 `ManageAppIcon` 的 `fit="contain"` 渲染。
  - 新增 `src/views/InstalledView.test.tsx`：验证状态筛选（全部 / 已锁定 / 已隐藏 / 待探测）、搜索过滤、排序切换（安装日期 vs 名称）、集成路径胶囊复制及回退状态、待更新标签展示、二次确认卸载/取消管理及 `lucide-react` 菜单交互；同时保证 `InstalledView.loadError.test.tsx` 全绿。
- [x] **全量静态与测试门禁**：
  - `pnpm exec tsc --noEmit` 通过；
  - `pnpm vitest run`（94 文件 / 974 用例）全部通过。

**Blocked by:** 03, 04

## Comments
- 2026-11-12：确保视觉全面重设计后，双语、无硬编码门禁、既有契约测试及新交互覆盖 100% 闭环。
- 2026-11-12：已完成双语键对齐、静态扫描接入与单测补强。验证：`pnpm exec tsc --noEmit` 退出 0，`pnpm vitest run` 94 个测试文件共 974 项测试全部通过。
