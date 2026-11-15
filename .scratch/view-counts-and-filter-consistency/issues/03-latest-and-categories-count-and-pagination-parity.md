# Issue 03: 最新入库子页与分类子页的数量角标、平台预过滤分页及侧栏平台分布对齐

Status: resolved
Blocked by: 01, 02

## Summary

彻底修复 **最新入库子页（`LatestView`）** 与 **分类下面的子页（`CategoriesView`）** 中标题数量与页面实际应用数不符、首屏因后置平台过滤缺卡/空白、以及侧栏平台分布计数未随子视图切换的问题：

1. **`LatestView`（最新入库子页）**：
   - 将当前平台过滤后的可见目录 ID 列表 `allowedIds` 传给 `getLatestCatalogApps(range, page, LATEST_APPS_PER_PAGE, allowedIds)`，使后端在分页前完成平台过滤；
   - 标题 `<CountBadge value={totalCount} />` 直接展示平台过滤后的精确总数（移除旧版 `visibleApps.length > 0 ? totalCount : 0` 错误逻辑）；
   - 利用回包 `matched_ids` 对照未裁剪全量目录 `allApps` 计算当前时间窗（`7d` / `30d` / `90d`）的平台分布并通过 `onDisplayPlatformCounts` 上报侧栏；
   - 精确区分两种空态：该时间窗在全平台本身无新收录（`windowTotalAllPlatforms === 0` → 展示时间窗切换引导「查看 30 天 / 查看 90 天 / 浏览分类」） vs 该时间窗有新收录但被当前设备平台筛选排除（`windowTotalAllPlatforms > 0 && totalCount === 0` → 展示带「重置设备筛选」按钮的 `FilterEmptyState`）。
2. **`CategoriesView`（分类大厅与分类详情子页）**：
   - 进入分类子页时向 `getCategoryApps(selectedCategory, page, CATEGORY_APPS_PER_PAGE, allowedIds)` 传入 `allowedIds`；
   - 子页标题 `<CountBadge>` 绑定该分类在当前平台筛选下的真实应用总数 `selectedCategoryCount`（来自 `categoryStats`，与大厅卡片显示的「`N 款可用`」及后端 `res.total` 完全同源，首帧稳定直显，消灭首帧闪 `0`、截断为 `20` 以及滚动 `20 → 40 → N` 跳变）；
   - 处于分类子页（`selectedCategory !== null`）时，对照 `allApps` 计算该分类在全部平台上的平台分布并通过 `onDisplayPlatformCounts` 上报侧栏；返回分类大厅或卸载时上报 `null` 恢复全库平台分布。
3. **滚动容器哨兵修复与「加载更多」显式按钮兜底**：
   - 两页的 `IntersectionObserver` 显式绑定 `root: el.closest('.content-area')`，解决 `.content-area` 独立滚动容器下 `rootMargin` 不对容器生效的问题；
   - 当 `hasMore && !loading && !error` 时，在列表底部提供与 `SearchResultsView` 同风格的「加载更多」次级按钮（`.feed-more-row` + `.btn-fluent.btn-secondary`），保证大屏或未触发哨兵时用户可明确感知并加载剩余页。

## Scope

- Allowed to modify:
  - `src/views/LatestView.tsx`
  - `src/views/LatestView.test.tsx`
  - `src/views/CategoriesView.tsx`
  - `src/views/CategoriesView.test.tsx`
  - `src/App.tsx`（向 `LatestView` 与 `CategoriesView` 传入 `allApps` 与 `onDisplayPlatformCounts`）
  - `src/locales/zh-CN.json`（仅在需要复用/微调加载更多或空态键值时修改，遵守 `countDisplay.test.ts`）
  - `src/locales/en-US.json`
- Do not modify:
  - `src-tauri/*`
  - `src/views/PendingView.tsx`, `src/views/InstalledView.tsx`, `src/views/FavoritesView.tsx`

## Implementation Details

### 1. `LatestView.tsx` 改造细节

- 新增可选属性：
  - `allApps?: readonly AppSummary[];`（未按平台过滤的全量合并目录，缺省回退 `apps` 以兼容独立单测）
  - `onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;`
- 计算稳定排序的 `allowedIds = useMemo(() => apps.map((a) => a.id.toLowerCase()).sort(), [apps])`，并以稳定签名 `allowedKey = allowedIds.join('\n')` 纳入取页 `useEffect` 依赖：当用户在侧栏切换设备平台时，自动重置至第 1 页并按新 `allowedIds` 重新拉取第 1 页（纯内存毫秒级返回）。
- 兼容单测桩：若测试 mock 的 `getLatestCatalogApps` 未处理第 4 个参数而返回了不在 `appsById` 内的项（且 `apps` 非空时），若回包带 `matched_ids` 则信任后端已按 `allowedIds` 过滤后的 `res.total`；若旧单测桩未回传 `matched_ids`，回退按 `appsById` 过滤保障旧单测平滑兼容。
- 平台计数上报：
  - 当回包携带 `matched_ids` 时，从 `allApps ?? apps` 中取出命中 `matched_ids` 的条目集合 `windowAllPlatformApps`，计算 `selectPlatformCounts(windowAllPlatformApps, platformResolvedOtherIds)` 上报 `onDisplayPlatformCounts`；组件卸载时上报 `null`。
- 空态判定优先级（非加载且无错时）：
  1. `windowTotalAllPlatforms === 0`（即 `matched_ids ? matched_ids.length === 0 : (apps.length > 0 && fetchedApps.length === 0)`）→ 渲染时间窗无新收录引导卡（切 30d / 90d / 浏览分类）；
  2. `visibleApps.length === 0`（含 `apps.length === 0` 或当前时间窗无所选平台应用）→ 渲染 `FilterEmptyState`（`onResetPlatformFilter`）。
- 标题角标：`{!loading && !error && totalCount !== null && <CountBadge value={totalCount} />}`。

### 2. `CategoriesView.tsx` 改造细节

- 新增可选属性：
  - `allApps?: readonly AppSummary[];`
  - `onDisplayPlatformCounts?: (counts: Record<PlatformId, number> | null) => void;`
- 从 `categoryStats` 直接读取当前选中分类的精确总数：
  `const selectedCategoryCount = useMemo(() => categoryStats.entries.find((e) => e.cat.id === selectedCategory)?.count ?? visibleApps.length, [categoryStats, selectedCategory, visibleApps.length]);`
- 子页标题角标改为 `<CountBadge value={selectedCategoryCount} />`（与大厅卡片「`{{count}} 款可用`」严格同源，点击进入子页瞬间即显示总数，不闪 `0`，不随翻页跳变）。
- `requestPage` 调用 `getCategoryApps(category, page, CATEGORY_APPS_PER_PAGE, allowedIds)`；当 `selectedCategory` 或 `allowedKey` 变化时重置分页重取第 1 页。
- 侧栏平台分布上报：
  - 当 `selectedCategory` 非空时，基于 `(allApps ?? apps).filter((a) => matchCategory(a, selectedCategory))` 计算 `selectPlatformCounts(..., platformResolvedOtherIds)` 并调用 `onDisplayPlatformCounts`；
  - 当 `selectedCategory === null`（在大厅）或组件卸载时调用 `onDisplayPlatformCounts?.(null)`。

### 3. 哨兵容器根绑定与加载更多按钮

- 在 `LatestView` 与 `CategoriesView` 的 `IntersectionObserver` 初始化处，设置 `const root = el.closest('.content-area');`，传入 `{ root: root instanceof Element ? root : null, rootMargin: '320px 0px' }`（在 jsdom 测试中 `closest('.content-area')` 为 `null` 时自动保持原默认 `null`，完全兼容现有单测桩）。
- 在两页的卡片网格下方，当 `hasMore && !loading && !error` 时渲染：
  ```tsx
  <div className="feed-more-row">
    <button
      type="button"
      className="btn-fluent btn-secondary"
      onClick={() => loadMoreRef.current()}
    >
      {t('search.local_load_more')}
    </button>
  </div>
  ```

## Acceptance Criteria

- [ ] `LatestView.test.tsx` 新增并验证：
  - 当全窗共 30 款（`matched_ids` 30 个），侧栏仅勾选 `android`（`apps` 含其中 4 款）时，`getLatestCatalogApps` 收到 `allowedIds`，标题 `<CountBadge>` 显示 `4`（而非 `30` 或 `0`），页面渲染全部 4 张卡片，且 `onDisplayPlatformCounts` 收到该时间窗全平台 30 款的真实平台分布；
  - 当该时间窗有 Windows 应用但无 iOS 应用，且侧栏仅选 iOS 时，渲染带重置按钮的 `FilterEmptyState`（绝不渲染空白 `.app-grid`）；
  - 当 `has_more = true` 时渲染「加载更多」按钮，点击后请求第 2 页。
- [ ] `CategoriesView.test.tsx` 新增并验证：
  - 某分类共有 25 款应用、第 1 页返回 20 款时，大厅卡片显示 `25 款可用`，点击进入子页后首帧标题 `<CountBadge>` 立即显示 `25`（而非 `20`，且加载期间不闪 `0`）；
  - 进入分类子页时 `onDisplayPlatformCounts` 上报该分类各平台计数，点击「返回分类」回到大厅时上报 `null`。
- [ ] `countDisplay.test.ts`、`npx tsc --noEmit` 及两视图全部单测通过。
