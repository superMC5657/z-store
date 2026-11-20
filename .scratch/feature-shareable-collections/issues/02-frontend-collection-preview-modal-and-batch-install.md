# Issue 02: 前端合集预览弹窗（`<CollectionPreviewModal>`）、深链联动与顺序批量安装

Status: resolved
Blocked by: 01

## Summary

在前端打通 `zstore://collection` 深链路由和 `resolve_collection_apps` IPC（含 Demo Mock），构建基于 `<ModalShell>` 的 `<CollectionPreviewModal>` 合集预览与批量安装弹窗，允许用户查看分享合集中的应用清单、本机安装状态及平台兼容性，并显式勾选执行顺序批量安装或全部收藏。

## Scope

- Allowed to modify:
  - `src/types/index.ts`（扩展 `DeepLinkAction` 与 `CollectionPreviewState` 类型）
  - `src/services/api.ts`（`CMD` 新增 `resolveCollectionApps: 'resolve_collection_apps'`）
  - `src/services/api/catalog.ts`（新增 `resolveCollectionApps(appIds)`）
  - `src/demo/handlers/catalog.ts` & `src/demo/handlers/common.ts` / `src/demo/tauri-mock.ts`（补齐 `resolve_collection_apps` 与 `collection` 深链 Demo Mock）
  - `src/app/hooks/useDeepLink.ts`（处理 `action.action === 'collection'` 并触发 `openCollection`）
  - `src/components/CollectionPreviewModal.tsx`（新增，基于 `<ModalShell>`）
  - `src/App.tsx`（管理 `activeCollection` 状态，挂载 `<CollectionPreviewModal>`，接入顺序批量安装与批量收藏）
  - `src/styles/components-modal.css`（新增合集弹窗单色清单样式）
  - `src/locales/zh-CN.json` & `src/locales/en-US.json`（新增 `collection.preview.*` 词条，严禁 `({{count}})`）
- Do not modify:
  - `src-tauri/` 后端文件
  - `src/views/InstalledView.tsx` / `src/views/FavoritesView.tsx`（分享入口在 Issue 03 添加）

## Implementation Details

1. **API 与深链路由（`src/services/api/`, `src/app/hooks/useDeepLink.ts`）**：
   - `resolveCollectionApps(appIds: readonly string[])` 传 `{ appIds: [...appIds] }`（严格 camelCase）。
   - `useDeepLink.ts` 处理 `action.action === 'collection'` 时调用 `routes.openCollection?.(action.payload)`，绝不触碰 `stagedDeepLinkInstall` 或自动调用安装。
2. **`<CollectionPreviewModal>` 交互与状态机（`src/components/CollectionPreviewModal.tsx`）**：
   - 基于 `<ModalShell onClose={...} closeOnBackdrop={!isBatchInstalling}>`（`layer="base"`），避免批量安装进行中误点遮罩关闭；
   - **水合与初始化勾选**：
     - 挂载后调用 `tauriApi.resolveCollectionApps(collection.app_ids)` 获取 `apps`，同时调用 `queueAssembledRowIcons(apps)` 入队图标缓存；
     - 勾选集 `selectedIds` 默认选中「未在 `installedIds` 中，且（`platforms.length === 0` 或命中当前宿主 `detectHostOs()`）」的条目；已安装条目默认不选中并标注 `.status-tag` `已安装`；
   - **单行操作**：
     - 勾选框切换选中状态；
     - 点击应用名称/图标可通过 `onOpenDetail(app.id)` 打开详情查看（`AppDetailModal` 打开时若同在 `base` 层会叠加或替换，推荐通过 `onOpenDetail` 预览单个软件后再关闭回到页面，或在 `<CollectionPreviewModal>` 内支持直接唤起查看）；
   - **底部动作**：
     - 全选未安装 / 取消全选按钮；
     - 「全部加入收藏」按钮：对合集中尚未在 `favoriteIds` 内的应用逐个调用 `onToggleFavorite`，结束后 Toast 提示加入数量；
     - 主按钮「安装选中项」附带 `<CountBadge value={selectedIds.size} hideZero />`：点击后顺序遍历 `selectedIds` 调用 `onInstallApp(id)`：
       - 顶部/按钮实时显示当前进度（如 `t('collection.installing_progress', { current, total, name })`）；
       - 单项失败捕获后记入失败计数并继续下一项（若命中 `unverifiedInstallPrompt` 则由既有警示弹窗流程处理）；全部完成后 Toast 汇总成功与跳过/失败数量。

## Acceptance Criteria

- [x] `useDeepLink.test.tsx`（或新单测）验证 `collection` 深链触发 `openCollection` 且绝不触发自动安装。
- [x] `CollectionPreviewModal.test.tsx` 验证：水合渲染标题/备注/`<CountBadge>`、已安装项默认不勾选且带状态标签、批量安装按序调用 `onInstallApp`、部分失败时其余项继续执行、全部加入收藏跳过已收藏项。
- [x] `cmdAlignment.test.ts` 与 `ipcArgsNaming.test.ts` 通过。
