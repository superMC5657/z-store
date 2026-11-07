# Issue 04: 前端发现页精选接替与实时画像刷新（`feed.ts` / `useHomeFeed.ts` / `HomeView.tsx`）

Status: resolved
Blocked by: 02, 03

## 背景

在现有 `src/views/HomeView/useHomeFeed.ts` 中，`featuredApps`（首页「经典精选开源软件」前 4 张卡片）仅从前端本地 `rankedRest` 切片，未消费后端 `get_home_feed` 返回的 `backendItems`，导致后端的动态推荐结果无法作用于首页最显眼的「经典精选」区。同时，前端需要在用户 Star / 收藏 / Watch 应用或后端完成 GitHub 画像同步时实时刷新推荐排序。

## 目标

1. **增强 `src/services/feed.ts`**：
   - 新增 `starsForksBase(app)`（`ln(stars + 1) + 0.25 * ln(forks + 1)`，当 `forks == 0` 时与原 `starsBase` 逐位一致），作为 `balanced` 策略基线；
   - 新增 `buildFrontendAffinityScorer(input?: FrontendAffinityInput)`：一期仅基于前端已有的显式信号 `{ catalog, favoriteIds, watchedIds }`（不含浏览点击历史）构建同构动态打分器（无信号时返回 `undefined`，100% 保持原行为）；
   - 新增 `subscribeAffinityUpdated(onUpdate: () => void): () => void`，在 `services` 层封装 `@tauri-apps/api/event` 的 `listen('zstore://affinity-updated')`（遵守 `noDirectInvoke.test.ts` 视图层禁令）。
2. **更新 `src/views/HomeView/useHomeFeed.ts` 与 `src/views/HomeView.tsx`**：
   - `HomeView` 将 `favoriteIds` 与 `watchedIds` 传入 `useHomeFeed`；
   - 当后端列表激活（`isBackendListActive`）时，以 `backendItems`（与 `apps` 对齐最新属性并排除 `heroApp` 后）的前 4 项直接驱动 `featuredApps`（「经典精选开源软件」），第 4 项起驱动 `displayedFeed`（「全部精选开源收录」）；
   - 订阅 `subscribeAffinityUpdated` 并在本地收藏/关注信号或后端 GitHub 同步完成时自动重拉首屏 `fetchHomeFeedPage`。

## 范围（互斥）

- 允许修改：`src/services/feed.ts`、`src/services/feed.test.ts`、`src/views/HomeView/useHomeFeed.ts`、`src/views/HomeView.tsx`、`src/views/HomeView.test.tsx`。
- 禁止在 `src/views/*` 或 `src/components/*` 中直接 `import` `@tauri-apps/api/*` 或 `services/api/client`。

## 验收标准

- [x] `npx vitest run src/services/feed.test.ts src/views/HomeView.test.tsx src/views/noDirectInvoke.test.ts src/services/api/cmdAlignment.test.ts` 全部通过。
- [x] 新增单测验证 `buildFrontendAffinityScorer` 基于 `favoriteIds` 与 `watchedIds` 对同分类候选应用的动态提权。
- [x] `npx tsc --noEmit` 零错误。
