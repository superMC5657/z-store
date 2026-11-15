# Issue 05: 我的应用与收藏/关注页面的角标计数、页内搜索联动、隐藏/未收录平台过滤及空态对齐

Status: ready-for-agent
Blocked by: 01, 02

## Summary

对齐资产管理区的两个核心视图——**我的应用（`InstalledView`）** 与 **收藏/关注/Star 同步（`FavoritesView`）**，消除平台筛选、页内搜索、隐藏规则与未收录应用造成的所有数量错位与误导性空态：

1. **我的应用（`InstalledView` & `manageModel.ts` & `selectors.ts`）**：
   - **消除 `!catalogEntry` 平台过滤穿透**：对不在 `fullMergedCatalogApps` 中的已安装应用（含被 `is_hidden` 隐藏的收录应用与未收录已装应用），通过零网络批量水合（`hydrateCardsByIds`）补齐卡片平台信息；仍无卡片记录的本地项按 `install_method` 推导平台（`msi`/`setup_exe`/`winget` → `['windows']`；`dmg`/`pkg` → `['macos']`；`deb`/`rpm`/`appimage` → `['linux']`；其余未知本地项按当前宿主平台回退），使 `filteredInstalledApps` 与 `filteredUpdates` 对全部已装应用执行一致的 `selectedPlatforms` 过滤；
   - **页内搜索词实时联动 4 个筛选签角标**：当用户在 `InstalledView` 页内搜索框输入关键词时，`全部 / 有更新 / 已锁定 / 已隐藏` 四个筛选签的 `<CountBadge>` 同步计算匹配该关键词的条数，保证任一筛选签上的数字恒等于切入该签时的 `visibleApps.length`；
   - **`selectUpdatableInstalled` 补齐 `is_frozen` 排除 + 检查更新 Toast 口径对齐**：`selectUpdatableInstalled` 同时跳过 `is_hidden` 与 `is_frozen`；`handleCheckUpdates` 完成后的 `toast.updates_found` 计数复用平台与规则过滤后的同一可更新口径，不再出现 Toast 报 5 个而页面「有更新」签显示 2 个；
   - **平台筛空专属 `FilterEmptyState` 与侧栏平台分布上报**：当本机有已装应用（`totalInstalledCount > 0`）但被侧栏 `selectedPlatforms` 全部筛空时，保留顶栏与重置入口（渲染 `FilterEmptyState` 引导「重置设备筛选」），绝不谎报「暂未安装任何应用」；同时向侧栏上报当前已装应用（`activeTab === 'hidden'` 时为隐藏已装应用，其余签为非隐藏已装应用）的平台分布计数。
2. **收藏与关注（`FavoritesView`、`WatchReleasesPanel`、`StarredFeed`）**：
   - **Tab 角标实时对齐列表**：页内 `收藏` 与 `关注` 两个顶层 Tab 的 `<CountLabel>` 计数由固定 `favoriteIds.size` / `watchedSet.size` 改为实时反映平台筛选 + 页内 `searchText` 过滤后的 `favoriteApps.length` 与 `watchedApps.length`；侧栏「收藏」角标使用平台过滤后的收藏数（来自 Issue 02 `platformFilteredFavoriteCount`）；
   - **侧栏平台分布三签全覆盖**：`activeTab === 'local'` 上报全量收藏应用平台分布，`activeTab === 'watched'` 上报全量关注应用平台分布，`activeTab === 'starred'` 保持上报已加载 Star 列表平台分布；
   - **空态三路精确分流**：明确区分「尚未收藏/关注任何应用」vs「当前设备平台筛选下无匹配项（渲染带重置按钮的 `FilterEmptyState`，移除误导性的 `watch_not_in_catalog` 触发）」vs「页内搜索词无匹配项（提供清空搜索动作）」；
   - **`WatchReleasesPanel` 与 `StarredFeed` 计数对齐**：「关注」签顶部的「有新版本」提醒面板同步按当前平台筛选与页内 `searchText` 过滤（图标查表使用未过滤全集 `allApps` 防丢图），使其标题 `<CountBadge>` 与面板行数及下方关注列表一致；`StarredFeed` 底部的 `online_armed_hint` 与 `starred_end` 叙述计数改为传入平台过滤后的 `filteredRows.length`。

## Scope

- Allowed to modify:
  - `src/views/InstalledView.tsx`
  - `src/views/manage/manageModel.ts`
  - `src/views/InstalledView.test.tsx`
  - `src/views/FavoritesView.tsx`
  - `src/views/FavoritesView/WatchReleasesPanel.tsx`
  - `src/views/FavoritesView/StarredFeed.tsx`
  - `src/views/FavoritesView.test.tsx`
  - `src/views/FavoritesView/StarredFeed.test.tsx`
  - `src/app/selectors.ts`（已安装应用的平台回退解析与收藏/关注未过滤池透出）
  - `src/app/hooks/useUpdateActions.ts`（检查更新完成 Toast 计数对齐）
  - `src/App.tsx`（透传 `totalInstalledCount`、`allApps`、`onResetPlatformFilter`、`onDisplayPlatformCounts` 等属性）
  - `src/locales/zh-CN.json`
  - `src/locales/en-US.json`
- Do not modify:
  - `src-tauri/*`
  - `src/views/LatestView.tsx`, `src/views/CategoriesView.tsx`, `src/views/PendingView.tsx`

## Implementation Details

### 1. 已安装应用平台解析与 `InstalledView` 对齐（`manageModel.ts`, `selectors.ts`, `InstalledView.tsx`）

- 在 `manageModel.ts` 新增纯函数 `inferInstalledFallbackPlatforms(installMethod?: string, hostPlatform: PlatformId = 'windows'): string[]`：
  - `msi` / `setup_exe` / `winget` → `['windows']`；
  - `dmg` / `pkg` → `['macos']`；
  - `deb` / `rpm` / `appimage` → `['linux']`；
  - 其余（`portable_zip`、`portable_tarball`、`installer`、`external`、`scanned`、`system_import` 或空）→ `[hostPlatform]`（Tauri/Windows 默认 `'windows'`，可由 `navigator.userAgent` 轻量识别 mac/linux）。
- 在 `App.tsx` / `selectors.ts` 中，对不在 `fullMergedCatalogApps` 内的 `installedApps` ID 调一次 `hydrateCardsByIds` 缓存在 state 中；构造每条 `InstalledApp` 的平台行：优先目录行 → 水合富卡行 → `{ id: inst.app_id, platforms: inferInstalledFallbackPlatforms(inst.install_method) }`，再用 `matchPlatformSetWithLoading` 统一过滤 `filteredInstalledApps` 与 `filteredUpdates`（消除 `!catalogEntry` 无条件穿透 `selectedPlatforms = new Set()` 的漏洞）。
- 在 `manageModel.ts`：
  - 抽取 `matchesInstalledSearch(app: InstalledApp, apps: AppSummary[], query: string): boolean`；
  - `selectUpdatableInstalled` 增加 `if (rule?.is_frozen) continue;`；
  - `computeInstalledStats` 支持传入已按页内 `searchQuery` 过滤的 `searchMatchedInstalledApps`，使 `InstalledView` 的 `filterTabs` 四个计数（`all`、`updatable`、`frozen`、`hidden`）严格反映页内搜索词匹配结果（而顶栏「全部更新」目标 `updatableItems` 仍取未受页内搜索词裁剪的 `installedApps`，或保持与 ADR-0022 对齐）。
- 在 `InstalledView.tsx`：
  - 新增可选 props：`totalInstalledCount?: number`、`allInstalledPlatformRows?: readonly AppSummary[]`（或 `unfilteredInstalledApps` + lookup）、`onResetPlatformFilter?: () => void`、`onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void`；
  - 当 `(totalInstalledCount ?? installedApps.length) > 0 && installedApps.length === 0` 时，渲染 `FilterEmptyState`（标题如 `categories.no_apps_device_filter`，动作绑定 `onResetPlatformFilter`），不再误渲染 `installed.empty_title`；
  - 根据 `activeTab === 'hidden'` 过滤未平台裁剪的已装行计算 `selectPlatformCounts` 并通过 `onDisplayPlatformCounts` 上报侧栏（卸载时上报 `null`）。

### 2. `FavoritesView`、`WatchReleasesPanel` 与 `StarredFeed` 对齐

- `FavoritesView.tsx`：
  - 新增可选 props：`allApps?: readonly AppSummary[]`（未按平台过滤的 `allFavoritesPoolApps`，缺省回退 `apps`）；
  - 计算三层列表以支撑侧栏平台分布与精准空态：
    1. `allFavRows` / `allWatchRows`：从 `allApps ?? apps` 匹配 `favoriteIdsLower` / `watchedIdsLower`（未过平台、未过页内搜索）→ 计算 `selectPlatformCounts` 在 `activeTab === 'local' | 'watched'` 时经 `onDisplayPlatformCounts` 上报侧栏；
    2. `platformFavRows` / `platformWatchRows`：从 `apps`（已平台过滤的 `favoritesViewApps`）匹配 `favoriteIdsLower` / `watchedIdsLower`（已过平台、未过页内搜索）；
    3. `favoriteApps` / `watchedApps`：在 `platformFavRows` / `platformWatchRows` 上叠加 `matchesSearch`（已过平台 + 已过页内搜索）。
  - 顶层 `SegmentedControl` 中：
    - `local` Tab 的 `<CountLabel count={favoriteApps.length} ... />`；
    - `watched` Tab 的 `<CountLabel count={watchedApps.length} ... />`。
  - 空态渲染：
    - `local` 签：`favoriteIds.size === 0` → `empty_fav_title`；`platformFavRows.length === 0` → `FilterEmptyState`（`onResetPlatformFilter`）；否则（`searchText.trim()` 无匹配）→ `no_match_fav` + 清空搜索按钮；
    - `watched` 签：`watchedSet.size === 0` → `empty_watch_title`；`platformWatchRows.length === 0` → `FilterEmptyState`（`onResetPlatformFilter`）；否则 → `no_match_watch` + 清空搜索按钮。
  - `WatchReleasesPanel`：
    - 传入 `visibleNotifications`：仅保留其 `normalizeId(n.app_id)` 命中当前可见关注作用域（当 `searchText.trim()` 为空时命中 `platformWatchRows` 或未在 `allApps` 中但满足平台过滤；有 `searchText` 时同时匹配名称/ID 搜索词）的通知项，并将 `allApps ?? apps` 传给 `WatchReleasesPanel` 供图标解析，确保「有新版本 `<CountBadge>`」与面板实际行数及下方关注列表完全协调。
- `StarredFeed.tsx`：
  - 第 667 行 `t('search.online_armed_hint', { count: filteredRows.length })`；
  - 第 682 行 `t('favorites.starred_end', { count: filteredRows.length })`。

## Acceptance Criteria

- [ ] `InstalledView.test.tsx` 新增并验证：
  - 输入页内搜索关键词后，`全部 / 有更新 / 已锁定 / 已隐藏` 四个 Tab 的 `<CountBadge>` 实时更新为匹配该关键词的行数，且逐一点选各 Tab 时下方列表行数与 Tab 角标完全一致；
  - 当 `totalInstalledCount = 5` 而平台过滤后 `installedApps = []` 时，渲染平台筛选 `FilterEmptyState` 并可触发 `onResetPlatformFilter`，不渲染「暂未安装任何应用」；
  - 被 `is_hidden` 隐藏的已装应用及未收录 `msi` 已装应用在 `selectedPlatforms = new Set()`（或仅选 `android`）时同样被平台过滤器排除，不再穿透显示；
  - `selectUpdatableInstalled` 排除 `is_frozen = true` 的应用。
- [ ] `FavoritesView.test.tsx` 与 `StarredFeed.test.tsx` 更新并验证：
  - 切换 `selectedPlatforms` 或输入页内 `searchText` 时，`收藏` 与 `关注` Tab 角标始终等于各自网格实际渲染的卡片数；
  - 当 `favoriteIds` / `watchedIds` 非空但因平台筛选导致可见行为 0 时，渲染 `FilterEmptyState` 并可点击重置，不再误报「还没有收藏的应用」或「关注的应用暂不在当前目录」；
  - 在 `收藏` 与 `关注` 签切换时，`onDisplayPlatformCounts` 分别收到收藏集与关注集的平台分布计数；
  - `StarredFeed` 在平台筛选激活时，底部 `starred_end` / `online_armed_hint` 展示 `filteredRows.length` 而非未过滤的 `rows.length`。
- [ ] `countDisplay.test.ts`、`i18n.test.ts`、`npx tsc --noEmit` 全部通过。
