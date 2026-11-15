# Issue 02: 全局目录基线与搜索态隔离、本地库同步闭环及视图级侧栏平台计数通道

Status: resolved
Blocked by: 01

## Summary

消除跨页面数量失真的三大全局根因，并建立全站统一的视图级侧栏平台分布计数通道：

1. **全量目录基线与顶栏搜索结果物理隔离（`src/App.tsx`, `src/app/selectors.ts`, `src/app/hooks/useSearchState.ts`）**：
   - 将仅服务于 `SearchResultsView`（`home` 搜索态）的 `searchFilteredApps` 与服务于其余所有视图（精选、最新、分类、趋势、收藏/关注、我的应用）的 `catalogFilteredApps`（基于未经搜索词裁剪的 `fullCatalogApps` + `localLibrarySummaries`）彻底解耦；
   - 顶栏搜索框输入非空关键词时，在任意非 `home` 视图统一路由至 `home`（消除在 `categories` / `trends` 页输入搜索词时页面不跳转却原地裁剪 `apps` 的异常）。
2. **本地自维护库（`custom_apps`）与隐藏规则的目录同步闭环（`src/services/custom.ts`, `src/app/hooks/useCustomApps.ts`, `src/app/hooks/useUpdateActions.ts`, `src/app/hooks/useInstallState.ts`）**：
   - 在 `src/services/custom.ts` 中保留后端只读投影的 `added_at`（优先 `wire.item.added_at`，缺省由 `wire.created_at` 格式化 UTC `YYYY-MM-DD`；`itemToWire` 写盘继续剥离 `added_at` 遵守 ADR-0021 §2.4）；
   - `useCustomApps` 在全部写操作（保存、删除、本地收录、退回草稿、标记已提交、撤回提交）重拉完成后派发 `zstore:catalog-synced`，使 `fullCatalogApps`（及空搜索态下的 `apps`）即时与后端 `CatalogService` 对齐（彻底消除退回草稿或删除本地收录后目录残留多算）；
   - `handleToggleRuleHidden` 同步刷新 `fullCatalogApps`；`useUpdateActions` 与 `useInstallState` 中所有 `app_id` 相等/不等过滤统一改用 `normalizeId`，并在卸载/取消管理成功时同步移除 `updates` 中对应条目。
3. **全视图侧栏平台分布计数上报通道与收藏/已装基础集合导出（`src/app/selectors.ts`, `src/App.tsx`）**：
   - 扩展 `useAppSelectors` 支持各视图上报其当前作用域的 `Record<PlatformId, number> | null`（覆盖 `latest`、`categories` 子页、`trends`、`pending`、`installed`、`favorites` 三签），离开对应视图或返回大厅时自动复位回全库计数；
   - 导出未按平台过滤的 `fullMergedCatalogApps`、`allFavoritesPoolApps`（供收藏/关注侧栏平台计数与空态判定）以及平台过滤后的 `platformFilteredFavoriteCount`（供侧栏「收藏」角标消费）与 `pendingFilteredCount`（供侧栏「待收录」角标消费）。

## Scope

- Allowed to modify:
  - `src/App.tsx`
  - `src/app/selectors.ts`
  - `src/app/hooks/useSearchState.ts`
  - `src/app/hooks/useCustomApps.ts`
  - `src/app/hooks/useUpdateActions.ts`
  - `src/app/hooks/useInstallState.ts`
  - `src/services/custom.ts`
  - `src/services/custom.test.ts`
  - `src/app/selectors.platformCounts.test.tsx`
  - `src/app/selectors.localBadge.test.tsx`
  - `src/app/hooks/useSearchState.test.tsx`
  - `src/app/hooks/useCustomApps.test.tsx`
  - `src/app/hooks/useUpdateActions.test.tsx`
  - `src/app/hooks/useInstallState.test.tsx`
  - `src/App.platformFilter.test.tsx`
  - `src/App.searchPlatformCounts.test.tsx`
- Do not modify:
  - `src-tauri/*`
  - `src/views/LatestView.tsx`, `src/views/CategoriesView.tsx`（Issue 03 处理，仅允许在 `App.tsx` 预留可选回调透传）
  - `src/views/PendingView.tsx`, `src/views/pending/*`（Issue 04 处理）
  - `src/views/InstalledView.tsx`, `src/views/FavoritesView.tsx`, `src/views/FavoritesView/*`（Issue 05 处理）

## Implementation Details

### 1. `src/services/custom.ts` 保留只读 `added_at` 投影

- `DraftItemWire` 增加 `added_at?: string | null;`；`DraftItem` 增加 `added_at?: string;`。
- 新增纯函数 `formatUtcYmd(epochSecs?: number): string | undefined`（当 `epochSecs` 为正有限数时按 UTC 年月日输出 `YYYY-MM-DD`）。
- `entryFromWire(wire)`：若 `wire.item.added_at` 非空字符串则采用，否则用 `formatUtcYmd(wire.created_at)` 写入 `item.added_at`。
- `itemToSummary(item, status, archived)`：当 `item.added_at` 非空时透传 `added_at: item.added_at`；`itemToWire` 保持不包含 `added_at` 字段。

### 2. `useCustomApps` 与 `useUpdateActions` / `useInstallState` 同步闭环

- `useCustomApps.ts`：在 `mutateAndReload` 完成 `await reloadCustomApps()` 后派发 `window.dispatchEvent(new CustomEvent('zstore:catalog-synced'))`（注意：`useAppSubscriptions` 的 `handleCatalogSynced` 需注意当前若 `searchQueryRef` 非空时只更新 `fullCatalogApps`、为空时同时更新 `apps` 与 `fullCatalogApps`，避免冲掉用户正在查看的搜索词结果）。
  - 检查 `useAppSubscriptions.ts`（如需最小调整可在 `App.tsx` 传入 `searchQueryRef` 或在 `useUpdateActions` 中刷新 `setFullCatalogApps`）：当 `handleToggleRuleHidden` 执行时，始终调用 `searchApps('')` 更新 `setFullCatalogApps`，并在 `searchQuery.trim()` 非空时另调 `searchApps(searchQuery)` 更新 `setApps`（为空则复用同一份结果）。
- `useUpdateActions.ts` & `useInstallState.ts`：
  - `handleApplyUpdate`、`handleSkipVersion`、`handleBatchUpdateAll`、`handleUnmanageApp`、`handleLaunchApp` 中全部 `a.app_id !== id` / `u.app_id !== id` / `a.app_id === id` 统一改为 `normalizeId(...)` 比较；
  - `handleUninstallApp` 与 `handleUnmanageApp` 成功后通过回调或 `setUpdates`（传入 `useInstallState` 或在 `App.tsx` 包装）同步清理该 `app_id` 的残留更新项。

### 3. `useSearchState.ts` 搜索导航统一

- 将 `handleSearchChange` 与 `handleSearchSubmit` 中的 `if (trimmed && currentView !== 'home' && currentView !== 'trends' && currentView !== 'categories')` 统一收敛为 `if (trimmed && currentView !== 'home') { navigate('home'); }`，同步更新 `useSearchState.test.tsx`。

### 4. `useAppSelectors` 目录基线隔离与侧栏计数收口（`src/app/selectors.ts`）

- 明确区分两条派生链：
  - **权威全量目录链**：`catalogBase = selectCatalogBase(fullCatalogApps, apps)` → `fullMergedCatalogApps = selectMergedCatalogApps(catalogBase, customApps, showCustom)`（无 `searchQuery` 裁剪！） → `catalogPlatformFilteredApps = selectPlatformFilteredApps(fullMergedCatalogApps, selectedPlatforms, platformResolvedOtherIds)`；
  - **搜索本地段链**：`searchMergedApps = selectMergedCatalogApps(apps, customApps, showCustom, searchQuery)` → `searchPlatformFilteredApps = selectPlatformFilteredApps(searchMergedApps, selectedPlatforms, platformResolvedOtherIds)`（仅传给 `SearchResultsView` 与 `home` 搜索空态判断）。
- **收藏/关注供给修复**：
  - `allFavoritesPoolApps`：将 `fullMergedCatalogApps` 与 `uncatalogedExtraApps` 按 `normalizeId` 去重合并（不过平台过滤）；
  - `favoritesViewApps`：改为 `selectFavoritesViewApps(catalogPlatformFilteredApps, uncatalogedExtraApps, selectedPlatforms, platformResolvedOtherIds)`（彻底免疫顶栏 `searchQuery` 裁剪！）；
  - `platformFilteredFavoriteCount`：统计 `favoritesViewApps` 中命中 `favoriteIds`（经 `normalizeId` 归一）的去重条数，供侧栏 `favoritesCount` 使用（当所有收藏项均已由 `useUncatalogedJoin` 合成占位或命中目录时，全平台选中下恒等于 `favoriteIds.size`，切平台后精确反映平台过滤后的收藏数）。
- **待收录侧栏计数**：
  - 在 `App.tsx` 计算传给 `Sidebar` 的 `pendingCount`：对未归档 `customApps` 条目按 `matchPlatformSet({ platforms: e.item.platforms }, selectedPlatforms)` 过滤计数（与 Issue 04 页内前三个未归档 Tab 之和完全一致）。
- **统一视图级侧栏平台计数槽**：
  - 提供按 `ViewType` 存储或回调的 `setViewPlatformCounts(view, counts)`（或对应 `handleLatestPlatformCounts`、`handleCategoryPlatformCounts`、`handlePendingPlatformCounts`、`handleInstalledPlatformCounts`、`handleFavoritesPlatformCounts`），`sidebarPlatformCounts` 优先读取 `currentView` 对应的非 `null` 视图上报值；`home` 搜索在线态沿用 `searchPlatformCounts`，其余默认回退基于 `fullMergedCatalogApps` 的 `platformCounts`（绝不因顶栏残留搜索词把默认侧栏计数缩成搜索子集！）。

## Acceptance Criteria

- [ ] 单测验证：当顶栏 `searchQuery = "vlc"`（`apps` 仅 1 款）而 `fullCatalogApps` 含 10 款已收录应用时，`catalogPlatformFilteredApps`、`favoritesViewApps` 及非 `home` 视图的 `sidebarPlatformCounts` 仍完整保留全部 10 款，不发生搜索词跨页截断或收藏卡片蒸发。
- [ ] 单测验证：`entryFromWire` → `entryToCollectedSummary` 正确携带 `added_at`（`YYYY-MM-DD`），且 `itemToWire` 输出不包含 `added_at`。
- [ ] 单测验证：`useCustomApps` 执行 `handleRevertCollectedApp` / `handleDeleteCustomApp` / `handleCollectLocalApp` 后触发 `zstore:catalog-synced`。
- [ ] 单测验证：`handleApplyUpdate`、`handleSkipVersion`、`handleUnmanageApp` 在大小写混合 ID（如 `Owner/Repo` vs `owner/repo`）下不产生重复已装行或残留更新项。
- [ ] `npx tsc --noEmit` 与相关 Vitest 测试套件全部通过。
