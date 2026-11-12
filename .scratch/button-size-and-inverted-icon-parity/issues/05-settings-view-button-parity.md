# 05: 设置中心（SettingsView 全 5 组）按钮 28px 归一化与输入控件等高对齐

Status: resolved
Blocked by: 01

## 目标与背景

解决 `SettingsView` 内各分组与子组件中高度混乱（同页内混用 `26px`、`28px`、`30px`、`32px`）、`NetworkDataSection` 自定义源行输入框（`28px`）与按钮（`32px`）错位 `4px`、硬编码 `#ef4444` 红底反色按钮、以及到处散落内联 `padding`/`fontSize` 的问题，将设置中心全页动作按钮统一收口到与 `.settings-input`（`28px`）完全等高的 `.btn-compact`（`28px`）标准体系。

## 验收清单

- [x] **`NetworkDataSection.tsx`（`src/views/SettingsView/sections/NetworkDataSection.tsx:111-228`）**：
  - **自定义源展开行（第 174-228 行）**：
    - 彻底删除确认按钮（第 202 行）、取消按钮（第 210 行）、保存地址按钮（第 220 行）上的内联 `height: '32px'`、`padding: '0 12px'` / `'0 14px'` 及硬编码 `background: '#ef4444', color: '#fff'`！
    - 三者统一改为 `className="btn-fluent btn-compact ..."`（严格 **`28px`** 高），与左侧 `.settings-input`（**`28px`**）100% 等高对齐！其中确认切换按钮使用 Issue 01 新增的 `.btn-danger-solid`（含反色图标光学平衡与规范交互态），取消/保存使用 `.btn-secondary`。
  - **清单源同步行（第 151-171 行）**：`自定义源`（`btn-secondary`）与 `立即同步`（`btn-primary`）去除内联 `padding: '6px 12px'` 与 `fontSize`，统一改为 `btn-compact`（**`28px`**），与下方展开行、上方加速镜像行（`.settings-input-group .btn-fluent` `28px`）形成全卡一致的 `28px` 节奏。
- [x] **`UpdatesRulesSection.tsx` 与 `ClientUpdateRow.tsx`（`src/views/SettingsView/sections/UpdatesRulesSection.tsx:91-118`, `src/components/ClientUpdateRow.tsx:141-179`）**：
  - 将 `ClientUpdateRow` 的各态动作按钮（当前 `btn-sm` `26px` + `size={14}` 图标）与 `UpdatesRulesSection` 的「管理更新规则」按钮（当前 `30px` + `size={13}` 图标 + 散落内联样式）**统一为 `btn-fluent btn-compact`（`28px`）**，消除同一设置卡片内相邻两行 `26px` vs `30px` 的 `4px` 高差；图标统一 `13px` `strokeWidth={1.5}`，规范「管理更新规则」内部计数徽章复用 `.badge-capsule`。
- [x] **`StorageSection.tsx`（`src/views/SettingsView/sections/StorageSection.tsx:40-108`）**：
  - 两个「浏览」按钮（与 `28px` `.settings-input` 同排）显式添加 `btn-compact` 类名；移除 `components-settings.css:252-259` 对 `.settings-input-group .btn-fluent` 的补丁式高度覆盖（统一由 `.btn-compact` 供给 `28px`）。
- [x] **`OAuthAccountCard.tsx`（`src/components/OAuthAccountCard.tsx:231-390`）**：
  - 统一卡片内全部 7 处按钮（已登录态 `重新登录`/`退出登录`、未登录态 `GitHub 登录`、过期横幅 `立即重新授权`、作用域不足横幅 `重新授权`、Device Flow `复制授权码`/`前往授权页`/`取消`）为 `btn-fluent btn-compact`（**`28px`**），彻底清除各处不一致的内联 `padding: '6px 14px'` / `'6px 16px'` / `'5px 14px'` / `'5px 12px'` / `'6px 12px'` 与 `fontSize`，应用反色光学平衡（消除 `前往授权页` 白色块在左右两个次级钮中间突兀膨胀的视觉感）。
- [x] **`DataManagementSection.tsx`、`AffinityPrivacyRow.tsx`、`DataBackupRow.tsx`、`LogExportRow.tsx`**：
  - `DataManagementSection.tsx:38-46`（「导出 JSON」）、`AffinityPrivacyRow.tsx:146-195`（3 个相邻按钮：`开启/关闭`、`立即同步`、`重置画像`）、`DataBackupRow.tsx:233-250`（`导出备份`、`导入恢复`）、`LogExportRow.tsx:64-80`（`导出诊断日志`、`打开日志文件夹`）：全部去除冗余内联 `padding: '6px 14px'` / `'6px 12px'` / `fontSize`，统一使用 `btn-fluent btn-compact`（**`28px`**）+ `13px` 图标，确保整个「数据管理与备份」分组 4 行共 8 颗按钮像素级对齐，并让 `AffinityPrivacyRow` 的 `btn-primary` 开启态享受反色光学补偿。
- [x] **验证**：
  - 运行 `pnpm vitest run src/views/SettingsView.test.tsx src/components/AffinityPrivacyRow.test.tsx src/components/ClientUpdateRow.test.tsx src/components/OAuthAccountCard.poll-leak.test.tsx` 全部通过。

## Comments

- 2026-11-12：由 `spec.md` 拆出。依赖于 Issue 01。
- 2026-11-12：已完成设置中心全部子组件与 `components-settings.css` 改造，`pnpm check` 与 `pnpm build` 通过。
