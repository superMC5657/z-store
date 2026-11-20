# Issue 03: 前端合集分享生成器（`<CollectionShareModal>`）与「我的应用 / 收藏」入口集成

Status: resolved
Blocked by: 01, 02

## Summary

构建 `<CollectionShareModal>` 应用合集分享生成器弹窗，并在「我的应用（`InstalledView`）」与「收藏（`FavoritesView`）」顶栏挂载「分享清单」入口，支持用户挑选最多 30 款开源应用、填写合集名称与备注，并一键生成与复制 `zstore://collection?...` 深链及排版清晰的 Markdown 推荐清单。

## Scope

- Allowed to modify:
  - `src/components/CollectionShareModal.tsx`（新增，基于 `<ModalShell>`）
  - `src/utils/collectionShare.ts`（新增纯函数：深链 URL 构建器、2048 字节预算检测、Markdown 清单生成器）
  - `src/utils/collectionShare.test.ts`（新增单测）
  - `src/views/InstalledView.tsx`（`<ManageHeader actions={...}>` 添加分享清单按钮）
  - `src/views/FavoritesView.tsx`（`local` / `watched` 签导航栏添加分享清单按钮）
  - `src/styles/components-modal.css`（补充分享表单与预览代码块单色样式）
  - `src/locales/zh-CN.json` & `src/locales/en-US.json`（新增 `collection.share.*` 词条）
- Do not modify:
  - `src-tauri/` 后端文件
  - `src/views/SettingsView.tsx`（原有导出 JSON 备份仍由 `DataBackupRow` 负责）

## Implementation Details

1. **纯函数生成器（`src/utils/collectionShare.ts`）**：
   - 常量：`COLLECTION_MAX_APPS = 30`、`COLLECTION_MAX_DEEPLINK_LEN = 2048`、`COLLECTION_TITLE_MAX_CHARS = 60`、`COLLECTION_NOTE_MAX_CHARS = 140`。
   - `buildCollectionDeepLink({ title, note, appIds })`：
     - 对 `appIds` 去重截断至 `30` 条；
     - 使用 `encodeURIComponent` 拼接 `zstore://collection?ids=...&title=...&note=...`（`title`/`note` 为空时省略对应 query 参数）；
     - 返回 `{ url, length, exceedsMaxLen }`，供 UI 提前警示是否超出深链 `2048` 字节上限。
   - `buildCollectionMarkdown({ title, note, apps, deepLinkUrl })`：
     - 生成包含合集标题、备注引用块、Markdown 表格（应用名、仓库链接、协议、简介）以及底部 `zstore://collection?...` 一键打开提示的文本（深链超 2048 字节时省略深链提示行）。
2. **`<CollectionShareModal>` 组件（`src/components/CollectionShareModal.tsx`）**：
   - 基于 `<ModalShell>` 构建；
   - 接收候选 `apps: AppSummary[]`（由 `InstalledView` 将 `installedApps` 映射/补全自 `catalogById` 传入，或由 `FavoritesView` 传入 `favoriteApps` / `watchedApps`）与默认标题；
   - **UI 布局**：
     - 标题输入框（带字数统计 `len / 60`）+ 一句话备注输入框（带字数统计 `len / 140`）；
     - 候选应用勾选区：顶部搜索框过滤列表 + 「全选前 30」/「清空」快捷操作 + 选中数量 `<CountBadge value={selectedIds.length} />`；勾选达 `30` 条时其余复选框禁用并展示上限提示；
     - 链接预览区：展示实时生成的 `zstore://collection?...` 只读预览；若 `exceedsMaxLen === true`，以警告态提示用户精简部分应用或缩短备注（禁用复制深链按钮或高亮提醒）；
     - 底部两个一键复制动作：「复制深链链接」与「复制 Markdown 清单」，均复用 `copyTextToClipboard` + `useTransientFeedback` 展示「已复制」状态。
3. **视图入口集成**：
   - `InstalledView.tsx`：在 `<ManageHeader actions={...}>` 中当 `installedApps.length > 0` 时渲染紧凑次按钮「分享清单」（`Share2` 图标，`strokeWidth={1.5}`），点击打开 `<CollectionShareModal>`。
   - `FavoritesView.tsx`：在 `activeTab !== 'starred'` 且当前列表非空（`favoriteApps.length > 0` 或 `watchedApps.length > 0`）时渲染同款紧凑次按钮「分享清单」，点击打开 `<CollectionShareModal>`。

## Acceptance Criteria

- [x] `collectionShare.test.ts` 验证：生成深链的编码格式、`30` 上限截取、`exceedsMaxLen` 超 `2048` 判定、Markdown 表格输出完整性与特殊字符转义（`|` 避免破坏表格列）。
- [x] `CollectionShareModal.test.tsx` 验证：默认预选、上限 `30` 拦截、搜索勾选、复制深链与复制 Markdown 回调。
- [x] `InstalledView.test.tsx` 与 `FavoritesView.test.tsx`（及 `views.i18n.test.tsx`、`countDisplay.test.ts`）全部通过。
