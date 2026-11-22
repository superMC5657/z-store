# Issue 06: 归位前端 `Repo Enrich Cache` 存储与订阅扇出并统一 `iconStore` L5 轮换准入

Status: resolved
Blocked by: none

## Summary

消除前端跨视图富卡池（`Repo Enrich Cache`）、应用详情（`AppDetail`）治愈广播与确认图标（`Confirmed Icon`）轮换准入的五重重复与循环写入：

1. **`Repo Enrich Cache` 名实分离**：`src/services/repoEnrichCache.ts` 名义上是跨搜索、趋势与 Star 列表的共享富卡池，但真实 M1 Map（`trendEnrichCache`、`trendConfirmedOtherCache`）、600 条容量裁剪与非破坏合并却寄居在 `src/services/trends/enrich.ts`，且两文件各写了一套字段补全规则。
2. **4 遍重复的占位简介治愈与启动漂移**：`src/app/hooks/useDetailCacheSync.ts` 在 4 个分支重复拷贝读取共享池治愈占位 `description` / `description_en` / `homepage` 的逻辑，而 `useAppSubscriptions.ts` 启动加载 `recentlyViewedApps` 时未走同一治愈入口。
3. **双 `window` 自定义事件绕行与 202 行重复合并**：详情落定后，`useDetailCacheSync.ts` 先改写 `trends/enrich.ts`，再派发 `DETAIL_PLATFORMS_HEAL_EVENT` 与 `DETAIL_RICHCARD_HEAL_EVENT`，由 `src/services/trends/board.ts` 用 202 行 reducer 重新合并并二次写回同一 M1 池。
4. **5 处散落的 `AppIconCycleResult` L5 解码协议**：提取 `remote_url`、剥离 `data:`、识别 `level === 5` 显式空徽标重置并调用 `admitIconHit` 的逻辑在 `Header.tsx`、`useDetailCacheSync.ts`、`favoritesUncataloged.ts`、`useRowAnnotations.ts` 与 `services/custom.ts`（错放 `resolveRemoteIconUrl`）中重复 5 遍。

## Scope

- Allowed to modify:
  - `src/services/repoEnrichCache.ts`
  - `src/services/trends/enrich.ts`
  - `src/services/trends/board.ts`
  - `src/services/iconStore.ts`
  - `src/services/custom.ts`
  - `src/app/hooks/useDetailCacheSync.ts`
  - `src/app/favoritesUncataloged.ts`
  - `src/views/shared/useRowAnnotations.ts`
  - `src/components/AppDetailModal/Header.tsx`
  - 相关单测文件（`src/app/hooks/useDetailCacheSync.test.tsx`、`src/services/iconStore.*.test.ts`、`src/services/trends/*.test.ts`、`src/components/AppDetailModal/Header.*.test.tsx`、`src/app/favoritesUncataloged.test.ts`）
- Do not modify:
  - `src-tauri/` 后端代码
  - `src/demo/`（由 Issue 07 处理）
  - `src/App.tsx` 与 `src/app/selectors.ts`（由 Issue 08 处理）

## Implementation Details

1. **将通用 M1 富卡池与治愈订阅总线归位至 `src/services/repoEnrichCache.ts`**：
   - 将 M1 卡片表、已确认 Other 表、600 条 FIFO 上限、12h TTL 驱逐、非破坏字段合并、`data:` 图标剥离（仅转交 `iconStore` M1 `via: 'm2'`）及私有仓记录/登出清除完整内聚到 `repoEnrichCache.ts`（`trends/enrich.ts` 仅保留趋势专属 IPC 批处理与重导出兼容符号）。
   - 提供统一治愈与写入接口：
     - `healSummaryPlaceholders(row)`（供 `prepareRecentViews`、`useDetailCacheSync` 等统一调用，消除 4 处拷贝）；
     - `upsertRepoCardFromDetail(detail, opts)` + `subscribeRepoCardHeals(listener)`：单点完成非 stale 详情合入、三态平台单调跃迁（具体平台自动清除 `confirmedOther`）并向订阅方（如 `TrendBoardSession`、列表状态）扇出已计算的补丁，**彻底删除 `DETAIL_PLATFORMS_HEAL_EVENT`、`DETAIL_RICHCARD_HEAL_EVENT` 两个 `window` 事件及 `trends/board.ts` 中 202 行的重复 heal reducer**。
2. **在 `src/services/iconStore.ts` 收敛 `Confirmed Icon` 轮换结果准入**：
   - 新增 `admitIconCycleResult(appId, cycle, opts?)`（及按需封装 `restoreAndAdmitIconCycle`）：集中处理 `remote_url` 优先、非 `data:` 回退、`data:` 仅进 M1 缓冲、`level === 5` 空串作为显式首字母徽标定格广播、普通空串丢弃保占位的全部不变量（严格遵守 ADR-0015）。
   - 将 `Header.tsx`、`useDetailCacheSync.ts`、`favoritesUncataloged.ts`、`useRowAnnotations.ts` 全部切换至该入口，并将 `resolveRemoteIconUrl` 从 `services/custom.ts` 迁入 `iconStore.ts`（若 `custom.ts` 内部需要则从 `iconStore` 导入）。
3. **精简 `useDetailCacheSync.ts` 与测试夹具**：
   - 合并详情内存缓存读/写与冷/热分支的重复治愈代码，简化 `useDetailCacheSync.test.tsx` 测试装配。

## Acceptance Criteria

- [ ] 全仓不再存在 `DETAIL_PLATFORMS_HEAL_EVENT` 或 `DETAIL_RICHCARD_HEAL_EVENT` `window` 事件；`repoEnrichCache.ts` 成为 M1 单仓富卡池与占位治愈的唯一实现模块。
- [ ] `AppIconCycleResult` 的 `remote_url` / `data:` / `level === 5` 准入解码仅在 `src/services/iconStore.ts` 实现一处，5 处调用方全部收敛。
- [ ] 单测直接通过 `repoEnrichCache` 与 `iconStore` 的公开 **interface** 验证：三态平台单调合并、`is_stale` 不污染富卡池、详情落定扇出趋势镜像更新、L5 空串定格徽标与登出私有卡清理。
- [ ] `pnpm test` 与 `pnpm build` 全部通过。
