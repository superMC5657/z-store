# ADR-0026：在线搜索、GitHub Star 与趋势富卡的缓存收敛

- 状态：Accepted
- 日期：2026-11-14
- 关联：ADR-0003（SQLite 持久化与 ETag 缓存）、ADR-0007（可配 TTL 缓存）、ADR-0010（规范应用标识）、ADR-0014（趋势榜 L2）、ADR-0015（统一图标获取与搜索对齐；本 ADR 修订其 §4、§5）、ADR-0019（资产面手动缓存；本 ADR 补充其 §2）、ADR-0025（动态系统代理）
- 落地计划：`.scratch/richcard-cache-and-pipeline-convergence/`
- 修订：§2.3 的富卡池准入（三态均入池并落盘 `repo_card_cache`）、§2.4 的分页桶形态（只存有序 id + L2 `search_list_cache`）与 §2.5 的 Star 快照信封（`v: 2` 按页 id 索引）由 ADR-0027 取代。
- 实现：`src-tauri/src/github/search.rs`、`src-tauri/src/github/developer_starred.rs`、`src-tauri/src/github/http.rs`、`src-tauri/src/commands/catalog_search.rs`、`src-tauri/src/commands/forge.rs`、`src-tauri/src/commands/network.rs`、`src-tauri/src/db/cache.rs`、`src-tauri/src/db/etag.rs`、`src-tauri/src/oauth/mod.rs`、`src/services/repoEnrichCache.ts`、`src/services/trends/enrich.ts`、`src/services/search/searchListCache.ts`、`src/services/search/onlineRows.ts`、`src/services/starred/starredCache.ts`、`src/app/hooks/usePlatformBackfill.ts`、`src/app/hooks/useSearchState.ts`、`src/views/FavoritesView/StarredFeed.tsx`

## 1. 背景

在线搜索、趋势榜与收藏页「Star 同步」都把 GitHub 仓库渐进增强为 `<AppCard>` 富卡（`AppSummary` + 确认图标 + 平台）。只有趋势榜有完整的内存 + 落盘 + ETag 链路：搜索与 Star 列表每次都裸请求 GitHub，搜索平台回填恒强刷 `releases/latest`，同一未收录仓库在三个视图间互不复用平台推导，Star 列表重启后为空。匿名配额（60 次/小时）连续搜几个词即耗尽。

## 2. 决策

### 2.1 HTTP 条件请求覆盖搜索与 Star 列表

- 关键词搜索（`/search/repositories`）、GitHub 单仓直查（`/repos/{o}/{r}`）与 Star 列表（`/user/starred`、`/users/{u}/starred`）均走 `github::http` 的 ETag 通道，键为规范端点 URL，存 `api_etag_cache`（上限 `API_ETAG_CACHE_MAX_ROWS = 3000`，按 `last_checked_at` LRU）。命令侧短锁预读 ETag 与旧载荷、`await` 期间零 DB、返回后单锁落库（`200` 写入、`304` touch），D7 有限重试与代理重探随通道继承。
- 只有旧载荷可解析时才发 `If-None-Match`；`304` 由旧载荷零配额组装。传输错误、限流（403/429）或 5xx 且有旧载荷时回退旧载荷：搜索标 `is_stale`，Star 列表返回 `StarredPageResult.is_stale = true`；404 不回退，401 经 `check_auth_expired` 通知。
- Star 列表 `304` 可能省略 `Link` 头：满页（原始条数 ≥ `per_page`）即视为还有下一页。
- `list_github_starred` 的 `forceRefresh` 只是手动同步透传位：条件请求本就由 GitHub 实时比对，强刷同样携带 ETag。在线搜索的 `forceRefresh=true` 跳过 ETag 预读与本地富卡快径。
- 趋势 `new` 榜经 `fetch_trends_text` 请求 `api.github.com` 时附带当前活跃 GitHub Token 并上报限流；`github.com` HTML 与 doforce 永不携带凭据。

### 2.2 后端组卡收敛

- 搜索命中精选收录库（含本地收录）的行投影精选元数据（中文简介、官方图标、分类、预置平台），保留更大的远端 Star/Fork，用户轮换过的确认图标优先；未收录行走 `backfill_uncataloged_card`。
- 单仓直查与趋势 enrich 共用 `resolve_local_enrich_hit`（非强刷先查收录库 / 详情缓存 / 仓库 ETag 载荷）与 `backfill_uncataloged_card`。
- `backfill_uncataloged_card` 在 `app_details` 未提供平台或真实版本时，零网络读取 `api_etag_cache` 中 `get_platforms_lite` 落下的 `releases/latest` 载荷（原大小写与小写端点各查一次），推导平台并取 `tag_name`。重启后三链路都能复原已知平台与版本。
- 趋势 `enrich_trend_repos` 的批量直查 `probe_icons = false`，首包只取仓库元数据；图标只由后台 `fetch_icons_stream(Trend)` 探一次，且只为未收录、无确认图标的仓入队。

### 2.3 三链路共享单仓富卡池（Repo Enrich Cache）

- `services/repoEnrichCache.ts` 是跨视图读写口，自身持有 M1 卡片表与已确认 Other 表（12h TTL、600 条 FIFO），`services/trends/enrich.ts` 仅重导出供趋势域沿用。池里只放具平台摘要与已确认 Other；未确认的空平台永不入池；`data:` 图标与收录态标注（`source` / `status` / `is_cataloged`）在池入口剥离。
- 读：`assembleOnlineRowsWithIcons` 组装搜索与 Star 行时，缺平台的行从池里回填平台（占位版本同时换成真实版本）；`executeLiteBackfillBatch` 对池中已确认 Other 的未收录行（非强刷）直接落定，不发 `get_platforms_lite`。
- 写：平台回填拿到具平台或确认空平台后写回池（只写未收录行）；搜索结果中已带平台的行（收录投影、`releases/latest` 回填）同样写回。趋势榜沿用原写口，三视图互相预热。
- 列表顺序与分页缓存仍按视图隔离，只共享单仓派生字段。

### 2.4 分页列表缓存分桶与分级新鲜度

- `searchListCache` 按命名空间分桶（`search` / `starred`），每桶独立 50 条 FIFO；写入后 5min 内为新鲜（`SEARCH_LIST_FRESH_MS`），5–30min 可用但需重验，30min（`SEARCH_LIST_TTL_MS`）起驱逐，时钟回拨即驱逐。`clearSearchListCacheNamespace(ns, prefix?)` 供登出清 `@me:`。
- 在线搜索提交（非强刷）命中第 1 页：新鲜即零网络直出；5–30min 先展示再后台 `searchAppsOnline(force=false)` 静默重验，不重复弹成功提示。联网失败回退旧载荷时后端回包带 `is_stale: true`，前端照常展示但不写入 `searchListCache`，下次提交仍联网。首搜按钮传 `forceRefresh=false`，已搜过后的「重试在线搜索」传 `true`。常规搜索、翻页与平台懒回填一律 `forceRefresh=false`，复用 `app_details` TTL 与 `releases/latest` ETag。

### 2.5 Star 同步快照（Starred Feed Cache）

- SQLite `starred_feed_cache(cache_key, owner_scope, payload_json, payload_bytes, cached_at)` 纯透存信封 `{ v: 1, rows, pages, hasMore, emptyPages?, confirmedOther? }`：前端截至 3 页 / 60 条、剥离 `data:` 与收录标注、256KB 预检逐级降级；后端单条 512KiB 硬拒绝，启动清扫 7 天以上的行并只保留最近 15 个目标。
- 新鲜度由前端判定：12h 内新鲜，更旧的仅作离线兜底与 SWR 首绘。`localStorage['zstore.starred.opts']` 只记查询模式与公开用户名。
- `StarredFeed`：进入视图先从分页缓存恢复最近一次查询，没有则读快照零网络直展并用 `get_confirmed_icons_batch` 补本地图标，不自动联网；切换目标先查分页缓存（新鲜直出，否则先展示再同步第 1 页），再查快照（12h 内直出，更旧先展示再同步）；对当前目标点同步时旧卡片留在屏上，第 1 页带强刷位经条件请求更新。与 GitHub 同步过的目标，结果、页数与平台落定变化后防抖 800ms 写透快照（未经网络的快照不续期）。
- 隐私：`owner_scope` 以 `@me:` 开头的快照随会话吊销唯一入口 `oauth::revoke_oauth_session`（手动登出与 401 失效共用）在无 `github.com` 主机令牌兜底时删除，`/user/` ETag 恒删除；前端登出或换账号时清掉内存中的 `@me:` 分页缓存与查询记录。

## 3. 后果

- 重复搜索、重复同步与跨视图浏览同一仓库时，配额消耗主要变为零配额 `304` 或纯本地命中；匿名用户不再因平台回填耗尽配额。
- 搜索与 Star 列表在网络失败时可显示旧结果，调用方需区分 `is_stale`。
- 三视图共享一个 600 条的富卡池，大量浏览时较早的派生条目会被挤出，到期后重新推导。
