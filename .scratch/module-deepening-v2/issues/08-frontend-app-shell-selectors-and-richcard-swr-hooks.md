# Issue 08: 纯化 `selectors.ts`，下沉 `Bi-dimensional Filter` 与 `My Apps` 状态域，收敛列表 SWR Hook

Status: ready-for-agent
Blocked by: 05, 07

## Summary

收敛前端根壳 `App.tsx`、`selectors.ts` 及三条富卡列表视图遗留的大接口浅层 Hook 与重复状态机：

1. **名为纯选择器实则夹带副作用的 1,214 行 `selectors.ts`**：
   - `useAppSelectors` 接收 **18 个参数**、返回 **33 个字段**，内部持有 `installedHydratedById` 异步 `hydrateCardsByIds` 副作用、`managedLoaded` 8 秒定时器、`viewPlatformCounts` 状态与 `useLayoutEffect`，并导出 **8 个逐视图透传的 `handle*PlatformCounts` 包装回调**；
   - `selectors.ts::customItemToSummary` 与 `services/custom.ts::itemToSummary` 重复定义转换逻辑。
2. **跨 Hook 可变 Ref 桥接与「我的应用」（`My Apps`）双发 IPC**：
   - `App.tsx` 用 `installedAppRemovedRef`、`countVisibleUpdatable` 桥接 `useInstallState` 与 `useUpdatesState`，用 `lazyBackfillRef` 桥接 `useSearchState` 与 `usePlatformBackfill`；
   - 切入 `installed` 视图时，`useInstallState.ts` 与 `useAppSubscriptions.ts` 同时各自调用一次 `tauriApi.getInstalledApps()`（后者吞错覆盖状态），且 `App.tsx` 向 `InstalledView` 透传 25 个散装 props。
3. **`StarredFeed.tsx` 与 `TrendsView` 的状态机泄漏**：
   - `StarredFeed.tsx`（657 行）在组件体内维护 14 个 `useState`/`useRef` 运行 L1/L2 瘦索引水合、SWR 重验与串行落库（串行键写入器在 `searchListCache.ts`、`starredCache.ts`、`trends/cache.ts` 重复实现 3 遍）；
   - `useTrendBoard.ts` 在挂载时等待无用的 `tauriApi.getSettings()`（`proxyReady` 屏障，`proxyPrefix` 实际已由后端动态系统代理取代），且 `TrendsView` 需靠 `refreshEnrichForceRef` 与 `displayItemsRef` 拼装 6 个 `useEffect` 驱动 `useTrendEnrichment`。

## Scope

- Allowed to modify:
  - `src/App.tsx`
  - `src/app/AppContext.tsx`
  - `src/app/selectors.ts`
  - `src/app/hooks/usePlatformFilter.ts`（新增）
  - `src/app/hooks/useMyAppsState.ts`（新增，合并收敛 `useInstallState.ts` 与 `useUpdatesState.ts`，可保留薄重导出或同步迁移单测）
  - `src/app/hooks/useInstallState.ts` & `src/app/hooks/useUpdatesState.ts`
  - `src/app/hooks/usePlatformBackfill.ts`
  - `src/app/hooks/useAppSubscriptions.ts`
  - `src/app/hooks/useSearchState.ts`
  - `src/views/FavoritesView/StarredFeed.tsx`
  - `src/views/FavoritesView/useStarredFeed.ts`（新增）
  - `src/views/TrendsView.tsx`
  - `src/views/TrendsView/useTrendBoard.ts` & `src/views/TrendsView/useTrendEnrichment.ts`
  - `src/services/trends/board.ts` & `src/services/trends/cache.ts`
  - `src/services/search/searchListCache.ts` & `src/services/starred/starredCache.ts`
  - 上报侧栏平台计数的视图组件（接入上下文 `useReportPlatformCounts`，保持可选 prop 兼容已有独立单测）
  - 对应前端测试文件（`src/App.*.test.tsx`、`src/app/*.test.tsx`、`src/app/hooks/*.test.tsx`、`src/views/TrendsView*.test.tsx`、`src/views/FavoritesView/*.test.tsx`）
- Do not modify:
  - `src-tauri/` 后端代码

## Implementation Details

1. **下沉 `usePlatformFilter` 深模块并通过 `AppContext` 收口视图平台计数**：
   - 新增 `src/app/hooks/usePlatformFilter.ts`：统一持有 `selectedPlatforms`（含 `localStorage` 持久化、切换与重置）、`platformResolvedOtherIds`（整合 `usePlatformBackfill`）以及视图级平台分布槽位 `reportViewPlatformCounts(view, counts)`（保留跨异步视图切换防闪烁语义）。
   - 在 `AppContext` 提供 `useReportPlatformCounts(view, counts)`，消除 `App.tsx` 中 8 个 `handle*PlatformCounts` 的解构与层层透传（各视图优先使用可选 prop 以兼容既有孤立组件测试，缺省直连 `AppContext`）。
2. **合并 `My Apps` 状态域（`useMyAppsState.ts`）并纯化 `selectors.ts`**：
   - 将 `installedApps`、`updates`、`updateRules`、流式检查进度、未收录已装卡片水合（原 `selectors.ts` 中的 `installedHydratedById` effect）、`managedLoaded` 延迟门控及无校验安装确认弹窗合并进单一深模块 `useMyAppsState`：
     - 彻底消除 `App.tsx` 中的 `installedAppRemovedRef`、`countVisibleUpdatable` Ref 桥接；
     - 移除 `useAppSubscriptions.ts` 中进入 `installed` 视图时的重复 `getInstalledApps()` 请求，保证单次进入仅由 `useMyAppsState` 请求一次并准确维护 `installLoadError`；
     - `App.tsx` 同时将 `movedInIds` 完全交由 Issue 07 深化后的 `useCustomApps.customIds` 承接。
   - **纯化 `src/app/selectors.ts`**：移除所有 `useState`、`useEffect`、`useLayoutEffect` 与 `setTimeout`，使其成为 100% 纯派生计算模块，并复用 `services/custom.ts::itemToSummary` 消除 `customItemToSummary` 重复代码。
3. **提取 `useStarredFeed`、共用串行写盘器并合并 `TrendsView` 双 Hook 接缝**：
   - 提取小型通用工具 `createSerializedKeyWriter` 供 `searchListCache.ts`、`starredCache.ts`、`trends/cache.ts` 复用，消除 3 份重复 Promise 链代码。
   - 将 `StarredFeed.tsx` 中 330 行的 L1/L2 瘦索引水合、世代门控、SWR 首页重验与翻页状态机抽入 `useStarredFeed.ts`，使 `StarredFeed.tsx` 退化为 ~200 行声明式视图。
   - 移除 `useTrendBoard.ts` 中冗余的 `getSettings()` `proxyReady` 挂载阻塞；将 `useTrendBoard` 与 `useTrendEnrichment` 收敛为单一 `useTrendSession` 接口（内部自动衔接强刷后的 enrich 触发，删除 `TrendsView.tsx` 中的 `refreshEnrichForceRef` 与 `displayItemsRef` 晚绑定桥接）。

## Acceptance Criteria

- [ ] `src/app/selectors.ts` 不包含任何 `useState`、`useEffect`、`useLayoutEffect` 或定时器调用。
- [ ] `src/App.tsx` 不再包含 `installedAppRemovedRef`、`lazyBackfillRef`、`movedInIds` 或 8 个 `handle*PlatformCounts` 透传样板；进入 `installed` 视图仅触发一次 `getInstalledApps`。
- [ ] `TrendsView` 首次挂载不再被 `getSettings` 阻塞才请求榜单；`StarredFeed.tsx` 不再直接内联 L1/L2 缓存水合状态机。
- [ ] 全量前端测试（含 `App.platformFilter.test.tsx`、`selectors.platformCounts.test.tsx`、`TrendsView*.test.tsx`、`StarredFeed.test.tsx`、`InstalledView*.test.tsx`、`countDisplay.test.ts`、`noDirectInvoke.test.ts`）及 `pnpm build` 全部通过。
