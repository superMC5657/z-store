# Feature Spec: 多视图应用数量显示与筛选口径全局对齐（View Counts & Filter Consistency）

> 状态：Draft（Ready for Implementation）
> 关联契约：`CONTEXT.md`（双维目录筛选、最新入库、本地库、我的应用、收藏标记）、`docs/count-display.md`（数量显示规范）、ADR-0010（规范应用标识）、ADR-0017（本地自维护草稿 overlay）、ADR-0021（最新入库独立视图）、ADR-0022（我的应用合并已安装与更新视图）。

---

## 1. 问题背景与全量根因分析

当前平台在 **最新入库（`LatestView`）**、**分类子页（`CategoriesView`）**、**待收录（`PendingView`）**、**我的应用（`InstalledView`）**、**收藏与关注（`FavoritesView`）** 五个核心区域均出现「角标/统计数字与页面实际展示的应用卡片数量不一致」的问题。

经全链路代码审计，定位出 **3 项跨页面公共根因** 与 **5 组页面级口径缺陷**（共 12 处具体机制错位）：

### 1.1 跨页面公共根因（Global Root Causes）

1. **[G-1] 顶栏全局搜索词（`searchQuery`）污染 `apps` 目录状态，截断非搜索视图数据**
   - **位置**：`src/App.tsx:74-75, 226, 358-375`、`src/app/selectors.ts:859-926`、`src/app/hooks/useSearchState.ts:198, 216`
   - **机理**：顶栏输入搜索词时，`useSearchState` 调用 `setApps(results)` 将 `apps` 覆写为搜索命中子集；切换侧栏视图时既不清空搜索词，也不切回完整目录 `fullCatalogApps`（且在 `categories` / `trends` 页输入顶栏搜索词时甚至不跳转 `home`，直接原地裁剪 `apps`）。而 `useAppSelectors` 的 `mergedApps`、`platformFilteredApps`、`favoritesViewApps`、`appsById`、`platformCounts` 全部由 `apps` 派生。
   - **后果**：
     - **收藏 / 关注页最严重**：`useUncatalogedJoin` 用 `fullCatalogApps` 求差集，认为已收录应用都在目录内因而不生成补充行；但 `favoritesViewApps` 却拿被搜索词裁剪后的 `platformFilteredApps` 渲染，导致**所有不匹配顶栏残留搜索词的已收录收藏/关注应用直接蒸发**，而角标仍显示全量；
     - **最新子页 / 分类子页**：后端返回全量分页 ID，前端与被裁剪的 `apps` 求交集后卡片大幅缩水；
     - **隐藏规则联动缺口**：`useUpdateActions.ts:83`（`handleToggleRuleHidden`）仅更新 `apps`，未同步刷新 `fullCatalogApps`。

2. **[G-2] 本地自维护库（`custom_apps`）状态切换与前端目录快照 / `added_at` 投影脱节**
   - **位置**：`src/app/hooks/useCustomApps.ts:55-93`、`src/app/selectors.ts:404-494`、`src/services/custom.ts:55-146, 189-229`
   - **机理**：
     - 启动时 `searchApps('')` 返回的 `apps` / `fullCatalogApps` 已内含当时的本地库行；运行期在「待收录」页执行「退回草稿（`revertCollectedApp`）」或「删除（`deleteCustomApp`）」后，`useCustomApps` 仅重拉 `customApps` 而未派发 `zstore:catalog-synced` 刷新 `fullCatalogApps` / `apps`，且 `selectMergedCatalogApps` 不剔除 `remote` 入参中残留的旧本地行，导致分类大厅等前端计数比后端命令多算；
     - `src/services/custom.ts` 在 `DraftEntryWire → DraftItem → AppSummary` 转换时丢弃了后端投影的 `added_at`（由 `created_at` 生成的 `YYYY-MM-DD`），导致运行期新收录进本地的应用丢失入库日期徽标。

3. **[G-3] 隐藏规则（`is_hidden`）从 `search_apps('')` 剥离引发的跨视图元数据断层**
   - **位置**：`src-tauri/src/commands/catalog_search.rs:523`、`src-tauri/src/commands/catalog_detail.rs:492`、`src/app/selectors.ts:913-925`
   - **机理**：后端 `search_apps('')` 预先过滤了 `hidden_rule_ids`：
     - 若被隐藏的收录应用同时在「收藏 / 关注」中，`useUncatalogedJoin` 将其当作目录缺失项调 `get_cached_app_details_batch`，而该命令在 `app_details` 无缓存行时直接短路返回 `None`（未回退查 `CatalogService`），导致正牌收录应用退化为空白占位卡，未勾选 `Other` 平台时 15s 后直接从收藏/关注页消失；
     - 在「我的应用」中，`appsById` 查不到被隐藏应用及未收录已装应用，`!catalogEntry` 恒为 `true`，使其跳过 `selectedPlatforms` 平台过滤（即使平台全不选 `0/6` 仍残留显示）。

---

### 1.2 各页面具体错位根因（View-Specific Root Causes）

| 页面 | 错位现象 | 具体代码根因 |
|---|---|---|
| **1. 最新子页 (`LatestView`)** | 勾选任意设备平台后，标题角标仍显示全平台总数（或首屏先显 `0`、翻页突变全量），且首屏卡片可能不足 20 张或出现无提示空白网格；侧栏平台数显示全库 366 款而非当前时间窗分布。 | `LatestView.tsx:187` 写为 `<CountBadge value={visibleApps.length > 0 ? totalCount : 0} />`，其中 `totalCount` 来自未按平台过滤的后端 `get_latest_catalog_apps`；后端先按全平台切 20 条再由前端做平台交集；`visibleApps.length === 0 && fetchedApps.length > 0 && !hasMore` 漏掉空态分支；哨兵未绑定 `.content-area` 滚动根且无「加载更多」按钮兜底。 |
| **2. 分类子页 (`CategoriesView`)** | 分类大厅卡片写着「`53 款可用`」，点进子页标题角标却显示 `20`（加载瞬间闪 `0`，平台过滤下甚至只显示 `3`），随滚动 `20 → 40 → 53` 跳变。 | `CategoriesView.tsx:240` 绑定了已加载分页切片 `<CountBadge value={visibleApps.length} />` 而非分类过滤后总数；后端 `get_category_apps` 未按平台过滤即分页；进入子分类时侧栏平台计数未切至该分类分布；哨兵缺 `.content-area` 根与加载更多兜底按钮。 |
| **3. 待收录子页 (`PendingView`)** | 1) 「本地收录」Tab 角标显示 `待提交 + 已提交` 之和（如 `5`），下方仅提供 `待提交` / `已提交` 二选一分段（无「全部」），列表永远对不上顶层角标（`待提交=0` 时甚至点进非零 Tab 看到空列表）；<br>2) 侧栏角标显示 `N`，点进页面固定停在 `草稿 0` 看到空列表；<br>3) 不响应侧栏设备平台过滤与平台计数。 | `PendingView.tsx:106, 316-324` 在 `library` 组下强制按双分段互斥过滤；初始 `activeGroup` 硬编码 `'draft'`；`PendingView` 与 `pendingCount` 未接入 `selectedPlatforms` 与侧栏平台分布上报。 |
| **4. 我的应用 (`InstalledView`)** | 1) 侧栏勾选平台筛空列表时误显示「暂未安装任何应用」并隐藏筛选栏；<br>2) 隐藏应用与未收录已装应用穿透平台过滤；<br>3) 页内搜索框输入关键词后列表缩减，上方 4 个筛选签角标不变；<br>4) 检查更新完成 Toast 报全平台更新数，与页内「有更新」Tab 数字打架；<br>5) 锁定竞争与大小写 ID 变体残留。 | `InstalledView.tsx:353` 未区分磁盘零安装与平台过滤为空；`selectors.ts:916` `!catalogEntry` 放行；`InstalledView.tsx:234` `filterTabs` 未消费页内 `searchQuery`；`manageModel.ts:48` `selectUpdatableInstalled` 未排除 `is_frozen`；`useUpdateActions.ts` / `useInstallState.ts` 多处 `app_id !== id` 未经 `normalizeId` 归一。 |
| **5. 收藏与关注 (`FavoritesView`)** | 1) 切换设备平台或输入页内搜索词后，列表卡片减少（甚至未收录空平台行 15s 后消失），但侧栏角标与页内「收藏 / 关注」Tab 角标固定显示全集 `favoriteIds.size` / `watchedSet.size`，且筛空时误报「还没有收藏的应用」或「关注的应用暂不在当前目录」；<br>2) 关注签顶部「有新版本」提醒与下方关注列表过滤脱节；<br>3) 侧栏平台数在收藏/关注签跳回全库 366 款；<br>4) Star 同步底部叙述计数用了未按平台过滤的 `rows.length`。 | `FavoritesView.tsx:118, 128` 写死 `favoriteIds.size` / `watchedSet.size`；`FavoritesView.tsx:78` 非 `starred` 签直接上报 `null` 回退全库平台数；空态判断未区分集合为空、平台筛空与搜索筛空；`WatchReleasesPanel` 未同步过滤；`StarredFeed.tsx:667, 682` 误传 `rows.length` 而非 `filteredRows.length`。 |

---

## 2. 已确认的产品与交互契约决策

经前期口径确认，全站统一执行以下三项核心准则：

1. **全站保留设备平台筛选并严格对齐角标、侧栏平台分布与空态引导**
   - 发现区（精选、最新入库、分类浏览、趋势榜、在线搜索）与管理区（待收录、我的应用、收藏/关注/Star 同步）全部一致响应侧栏 `selectedPlatforms` 多选过滤；
   - 侧栏导航角标（`待收录`、`我的应用`、`收藏`）统一反映当前 `selectedPlatforms` 过滤后的对应计数；
   - 侧栏「平台」6 枚芯片下方的数字随当前所在视图/子签动态展示该视图的数据集平台分布（例如在最新入库页显示当前时间窗各平台数、在分类子页显示该分类各平台数、在待收录页显示待收录条目各平台数、在我的应用页显示已装应用各平台数、在收藏/关注签分别显示收藏集/关注集各平台数）；
   - 凡因 `selectedPlatforms` 过滤导致列表为空（而底层未过滤数据集非空）的视图，一律展示带「重置设备筛选」按钮的 `FilterEmptyState`，严禁误报为「暂无已安装/暂无收藏/暂无草稿」。

2. **「待收录」展平为四个顶层互斥 Tab + 智能默认落点**
   - 移除原有的「本地收录」复合 Tab 及二级分段行（`.pending-segment-row`），顶层直接展平为 **4 个平级 Tab**：`草稿 (draft)`、`待提交 (to_submit)`、`已提交 (submitted)`、`已归档 (archived)`；
   - 每个顶层 Tab 的 `<CountLabel>` 角标直接等于该 Tab 在当前平台筛选下的列表条数；侧栏 `pendingCount` 等于前三个未归档 Tab（`草稿 + 待提交 + 已提交`）在当前平台筛选下的条数之和；
   - 首次进入「待收录」页时，按 `draft → to_submit → submitted → archived` 顺序自动落在首个非空分组（全空时停在 `draft`），杜绝侧栏有角标但点进页面看到空列表。

3. **页内局部搜索框实时联动页内 Tab 角标**
   - 在「我的应用」筛选框与「收藏 / 关注」搜索框输入关键词时，页内各状态 Tab 的 `<CountBadge>` / `<CountLabel>` 同步展示匹配当前页内搜索词（叠加全局设备平台过滤）后的实际条数，确保任何时刻 **「激活 Tab 上的数字 === 下方列表实际渲染的卡片/行数」**；
   - 侧栏全局导航角标与「全部更新」批量目标不受页内临时搜索框影响（仅受全局平台筛选与更新规则约束）。

---

## 3. 目标架构设计

### 3.1 后端 Feed 平台预过滤参数与隐藏目录水合补齐

1. **`get_category_apps` 与 `get_latest_catalog_apps` 支持可选 `allowed_ids` 并回传 `matched_ids`（`src-tauri/src/commands/catalog_feed.rs`）**
   - 请求参数新增 `allowed_ids: Option<Vec<String>>`（前端传 `allowedIds?: string[]`；缺省 `None` 时不过滤，100% 兼容既有调用与单测）：
     - 先在合并目录（剔除 `hidden_rule_ids`）上完成分类匹配或时间窗（`min_days` / `max_days`）过滤与排序，收集该视图全平台命中的规范 ID 列表 `matched_ids: Vec<String>`；
     - 若传入 `allowed_ids = Some(ids)`，按小写规范 ID 集合对结果集做保序过滤，**在过滤后的序列上**执行 `paginate_feed(&filtered, limit, offset)` 计算 `items`、`total` 与 `has_more`；
   - `FeedPage` 响应新增可选字段 `matched_ids: Option<Vec<String>>`（`#[serde(default, skip_serializing_if = "Option::is_none")]`）：供前端零网络结合 `fullMergedCatalogApps` 计算当前时间窗或当前分类在全部平台上的 `selectPlatformCounts`。

2. **`get_cached_app_details_batch` 目录回退补齐（`src-tauri/src/commands/catalog_detail.rs`）**
   - 当 `cached_detail_summary(&db, raw)` 返回 `None`（从未点开过详情弹窗，且不在 `repo_card_cache`）时，继续检查 `state.catalog.get_catalog_item(raw)`：若命中精选库或本地库（含被 `is_hidden` 隐藏的条目），直接投影 `item_to_stamped_summary` 并叠加 `apply_confirmed_icon`，避免被隐藏的已收录收藏/关注/已装应用退化为空白占位卡。

### 3.2 前端全局目录基线与搜索态物理隔离（`src/app/selectors.ts` & `src/App.tsx`）

```text
[searchApps('') / zstore:catalog-synced] ──► fullCatalogApps ──┐
[useCustomApps: localLibrarySummaries (含 added_at)] ──────────┼──► fullMergedCatalogApps（全站权威目录基线，不受顶栏搜索裁剪）
                                                               │      ├─► catalogPlatformFilteredApps ──► Featured / Latest / Categories / Trends
                                                               │      ├─► allFavoritesPoolApps ─────────► Favorites / Watched（平台过滤 + 侧栏平台分布）
                                                               │      └─► installedPlatformLookup ──────► InstalledView（含隐藏/未收录水合与 install_method 兜底）
[searchApps(searchQuery)] ──► apps ────────────────────────────┴──► searchPlatformFilteredApps ─────────► 仅 SearchResultsView（home 搜索态）消费
```

- **顶栏搜索路由统一**：在非 `home` 视图输入非空顶栏搜索词时，统一 `navigate('home')` 进入搜索结果视图（清空搜索词时留在当前视图并恢复 `apps`）。
- **本地库变更闭环**：`useCustomApps` 在全部 6 个写操作落盘重拉后派发 `zstore:catalog-synced`；`handleToggleRuleHidden` 同步刷新 `fullCatalogApps`；`src/services/custom.ts` 从 `DraftEntryWire` 保留只读 `added_at`（优先 `wire.item.added_at`，缺省按 `wire.created_at` UTC `YYYY-MM-DD` 投影；`itemToWire` 写盘继续剥离）。
- **统一视图级侧栏平台计数通道**：`useAppSelectors` 提供视图级 `viewPlatformCounts` 覆盖槽，按当前 `currentView` 自动选用：
  - `home`（搜索态含在线结果）：本地搜索命中 ∪ 在线结果去重分布；`home`（精选态）/ `categories`（大厅）/ `settings`：`fullMergedCatalogApps` 全库分布；
  - `latest`：当前激活时间窗（`7d` / `30d` / `90d`）的目录分布；
  - `categories`（子分类详情态）：当前选中分类的目录分布；
  - `trends`：当前趋势榜单分布；
  - `pending`：当前待收录条目（未归档或当前视图集合）的平台分布；
  - `installed`：当前已安装应用（在 `已隐藏` Tab 为隐藏已装应用，其余 Tab 为非隐藏已装应用）的平台分布；
  - `favorites`：`收藏` 签为全部收藏项平台分布、`关注` 签为全部关注项平台分布、`Star 同步` 签为已加载 Star 列表平台分布。

### 3.3 五大视图精确对齐细则

1. **最新子页（`LatestView.tsx`）**
   - 调用 `getLatestCatalogApps(range, page, LATEST_APPS_PER_PAGE, allowedIds)`，其中 `allowedIds` 为 `catalogPlatformFilteredApps` 的规范 ID 列表；
   - 标题 `<CountBadge value={totalCount} />`（仅在 `!loading && !error && totalCount !== null` 渲染）直接取后端在 `allowedIds` 过滤后返回的精确 `res.total`，与全页可加载卡片总数 100% 相等；
   - 利用回包 `matched_ids` 对照 `allApps` 计算该时间窗的全平台分布并上报 `onDisplayPlatformCounts`；
   - 空态分流：`matched_ids.length === 0` 展示时间窗无新应用引导（切换 30 天 / 90 天 / 浏览分类）；`matched_ids.length > 0 && totalCount === 0` 展示 `FilterEmptyState`（重置设备平台筛选）；
   - 分页增强：`IntersectionObserver` 绑定 `root: el.closest('.content-area')`，并在 `hasMore && !loading && !error` 时渲染显式「加载更多」按钮。

2. **分类下面的子页（`CategoriesView.tsx`）**
   - 调用 `getCategoryApps(selectedCategory, page, CATEGORY_APPS_PER_PAGE, allowedIds)`；
   - 子页标题角标改为该分类在当前平台筛选下的真实总数 `currentCategoryCount`（由 `categoryStats` 同步给出并与 `res.total` 一致，首帧即就绪，不闪 `0`，不随滚动从 `20` 跳变）；
   - 进入子分类时上报该分类在 `allApps`（未平台过滤全量目录）下的平台分布至侧栏，返回分类大厅或卸载时恢复 `null`；
   - 分页增强：`IntersectionObserver` 绑定 `root: el.closest('.content-area')`，并在 `catHasMore && !catLoading && !catError` 时渲染「加载更多」按钮。

3. **待收录子页（`PendingView.tsx` & `draftModel.ts`）**
   - `PendingGroupId` 调整为 `'draft' | 'to_submit' | 'submitted' | 'archived'` 四态，`entryGroup(e)` 直接映射到这 4 个互斥桶，移除 `PendingSegmentId` 与 `.pending-segment-row`；
   - 接收 `selectedPlatforms` 与 `onResetPlatformFilter`：按 `matchPlatformSet({ platforms: e.item.platforms }, selectedPlatforms)` 过滤各 Tab 条目，4 个顶层 Tab 的 `<CountLabel>` 展示各自过滤后的条数，严格等于点击该 Tab 后左栏渲染的条目数；
   - 侧栏 `pendingCount` 按同一 `selectedPlatforms` 口径统计 `!e.archived` 条目数（恰好等于 `草稿 + 待提交 + 已提交` 三个 Tab 角标之和）；向侧栏上报未归档条目（或当前全集，在 `archived` Tab 时含归档）的平台计数；
   - 挂载时自动选中按 `draft → to_submit → submitted → archived` 排序的首个过滤后非空 Tab（若因平台过滤全为 0，则选首个原始非空 Tab 并展示带「显示全部平台」按钮的 `FilterEmptyState`）。

4. **我的应用（`InstalledView.tsx` & `manageModel.ts`）**
   - 通过 `hydrateCardsByIds` 零网络补齐不在 `fullMergedCatalogApps` 中的已安装应用元数据（覆盖 `is_hidden` 收录应用与 `repo_card_cache`/`app_details` 中的未收录应用），仍无记录的本地安装项按 `install_method` 推导平台（`msi`/`setup_exe`/`winget` → `windows`，`dmg`/`pkg` → `macos`，`deb`/`rpm`/`appimage` → `linux`，其余回退宿主平台），消除 `!catalogEntry` 无条件穿透；
   - `selectUpdatableInstalled` 同时排除 `is_hidden` 与 `is_frozen`；`handleCheckUpdates` 完成 Toast 计数统一复用 `selectUpdatableInstalled`（平台+规则过滤后口径）；`useUpdateActions` / `useInstallState` 全部 ID 比较经 `normalizeId` 归一，卸载/取消管理同步清理 `updates` 残留；
   - `InstalledView` 的 `filterTabs`（`全部 / 有更新 / 已锁定 / 已隐藏`）先经页内 `searchQuery` 过滤再统计计数，使每个 Tab 的 `<CountBadge>` 与切换至该 Tab 时的 `visibleApps.length` 始终一致；
   - 当磁盘有已安装应用（`totalInstalledCount > 0`）但被全局 `selectedPlatforms` 全部筛除（`installedApps.length === 0`）时，保留顶栏并渲染 `FilterEmptyState`（「重置设备筛选」），绝不显示「暂未安装任何应用」。

5. **收藏下面的收藏和关注页面（`FavoritesView.tsx`、`WatchReleasesPanel.tsx`、`StarredFeed.tsx`）**
   - 侧栏 `favoritesCount` 改为平台过滤后的收藏数（不含页内临时搜索词）；
   - 页内 `收藏` 与 `关注` 两个顶层 Tab 的 `<CountLabel>` 计数分别绑定 `favoriteApps.length` 与 `watchedApps.length`（同时反映 `selectedPlatforms` 与页内 `searchText`），与下方网格卡片数严格 1:1 相等；
   - 侧栏平台分布计数随 `activeTab` 动态切换：`local` 上报全量收藏项平台分布、`watched` 上报全量关注项平台分布、`starred` 上报已加载 Star 列表平台分布；
   - 空态三路精确分流：底层集合为空（`favoriteIds.size === 0` / `watchedSet.size === 0`）→ 初始空态引导；被 `selectedPlatforms` 筛空 → `FilterEmptyState`（含 `onResetPlatformFilter` 重置按钮，移除旧版误导性的 `watch_not_in_catalog` 触发）；被页内 `searchText` 筛空 → 搜索无匹配提示 + 清空搜索按钮；
   - `WatchReleasesPanel` 按当前关注签相同的平台筛选与 `searchText` 过滤待处理提醒（图标查表使用未过滤全集 `allApps` 防止丢图标），确保「有新版本 `<CountBadge>`」与面板行数及下方关注列表一致；
   - `StarredFeed` 底部 `online_armed_hint` 与 `starred_end` 叙述计数传入平台过滤后的 `filteredRows.length`。

---

## 4. 实施 Issue 拆分与依赖拓扑

```text
[01 后端 Feed allowedIds 预过滤分页与隐藏目录批量水合补齐]
        │
        ▼
[02 全局目录基线与搜索态隔离、本地库同步闭环及视图级侧栏平台计数通道]
        │
        ├───────────────────────────────┬───────────────────────────────┐
        ▼                               ▼                               ▼
[03 最新入库与分类子页计数及分页对齐] [04 待收录四 Tab 展平与平台筛选对齐] [05 我的应用与收藏/关注计数及空态对齐]
        │                               │                               │
        └───────────────────────────────┴───────────────────────────────┘
                                        ▼
                      [06 规范文档更新与全量回归门禁验收]
```

1. [`01-backend-feed-allowed-ids-and-hidden-catalog-hydration.md`](./issues/01-backend-feed-allowed-ids-and-hidden-catalog-hydration.md)（`ready-for-agent`，`Blocked by: none`）
2. [`02-global-catalog-baseline-and-custom-sync.md`](./issues/02-global-catalog-baseline-and-custom-sync.md)（`ready-for-agent`，`Blocked by: 01`）
3. [`03-latest-and-categories-count-and-pagination-parity.md`](./issues/03-latest-and-categories-count-and-pagination-parity.md)（`ready-for-agent`，`Blocked by: 01, 02`）
4. [`04-pending-four-tabs-and-platform-alignment.md`](./issues/04-pending-four-tabs-and-platform-alignment.md)（`ready-for-agent`，`Blocked by: 02`）
5. [`05-installed-and-favorites-counts-and-filter-parity.md`](./issues/05-installed-and-favorites-counts-and-filter-parity.md)（`ready-for-agent`，`Blocked by: 01, 02`）
6. [`06-docs-and-full-regression-gates.md`](./issues/06-docs-and-full-regression-gates.md)（`ready-for-agent`，`Blocked by: 03, 04, 05`）

---

## 5. 整体验收标准

- **五大区域数量 100% 闭合**：
  - **最新子页**：任意时间窗（7d / 30d / 90d）与任意侧栏设备平台组合下，标题 `<CountBadge>` 数字 === 该时间窗可加载展示的实际卡片总数；侧栏各平台数字 === 该时间窗内对应平台的应用数；首屏不出现因后置过滤导致的残缺短页或空白无提示页；
  - **分类子页**：分类大厅某卡片显示 `N 款可用` 时，点进该分类子页标题 `<CountBadge>` 首帧即稳定显示 `N`（不闪 `0`、不截断为 `20`、不随滚动跳变），全页实际卡片总数 === `N`；子页内侧栏平台数字反映当前分类各平台分布；
  - **待收录子页**：顶层 4 个 Tab（`草稿 / 待提交 / 已提交 / 已归档`）各自的 `<CountLabel>` 数字 === 点击该 Tab 后左栏渲染的条目数；前 3 个未归档 Tab 角标之和 === 侧栏「待收录」角标；从非零侧栏角标进入必落在非空 Tab；切换设备平台时列表、Tab 角标、侧栏角标与空态同步响应；
  - **我的应用**：`全部 / 有更新 / 已锁定 / 已隐藏` 四个筛选签的 `<CountBadge>` 在任意设备平台组合与任意页内搜索词下，均严格等于切换至该签时下方列表实际渲染的行数；隐藏应用与未收录已装应用不穿透空平台筛选；平台筛空时展示重置平台引导而非「暂未安装任何应用」；检查更新完成 Toast 数字与「有更新」签一致；
  - **收藏与关注**：顶栏曾输入搜索词或某收录应用被设为隐藏时，收藏/关注列表绝不丢卡或退化为空壳；切换设备平台或输入页内搜索词时，页内 `收藏 / 关注` Tab 角标严格等于下方实际渲染卡片数，侧栏「收藏」角标等于平台过滤后的收藏总数，「关注」顶部「有新版本」角标等于面板展示行数，`Star 同步` 底部叙述计数等于过滤后实际可见卡片数；
- **架构与规范门禁**：
  - 符合 `docs/count-display.md`（统一 `<CountBadge>` / `<CountLabel>`，零括号计数，零自定义计数类名，`countDisplay.test.ts` 通过）；
  - 符合 `AGENTS.md` IPC 命名规范（请求键 `camelCase` `allowedIds`，响应字段 `snake_case` `matched_ids`，Demo Mock 禁 snake fallback，`ipcArgsNaming.test.ts` 与 `noDirectInvoke.test.ts` 通过）；
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npx tsc --noEmit`、`npx vitest run`、`npx vite build --config vite.demo.config.ts` 全部零错误通过。
