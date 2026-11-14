# Feature Spec: 在线搜索、GitHub Star 与趋势富卡缓存收敛及链路优化（Richcard Cache & Pipeline Convergence）

> 状态：Implemented（决策见 `docs/adr/0026-search-starred-cache-and-enrich-convergence.md`）
> 关联契约：`CONTEXT.md`（D2 零服务器成本与解耦清单同步、D5 双池复用、D6 有限并发、D7 有限重试、D9 趋势与首页、D10 统一图标获取）、ADR-0003（SQLite 持久化与 ETag 缓存）、ADR-0007（开放清单与可配 TTL 缓存）、ADR-0010（规范应用标识）、ADR-0014（趋势榜 L2 与治理）、ADR-0015（统一图标获取与搜索对齐）、ADR-0019（资产面手动缓存与非资产面自动拉取）、ADR-0025（动态系统代理与远端资源缓存收敛）。

---

## 1. 背景与全链路诊断

ZStore 的 **搜索在线应用（`SearchResultsView`）**、**趋势榜（`TrendsView`）** 与 **GitHub Star（`FavoritesView/StarredFeed`）** 三条发现/同步链路均需从 GitHub 获取仓库信息并渐进增强为 `<AppCard>` 富卡（`AppSummary` + 确认图标 + 多端设备平台 `platforms`）。经全链路代码审计，当前仅趋势榜具备完整的三级缓存体系，其余两条链路及共享底座存在 **6 处核心断层与配额损耗**：

### 1.1 在线搜索与 GitHub Star 缺失 HTTP ETag 条件请求缓存，重复消耗 API 配额（P0）
- **在线搜索（`src-tauri/src/github/search.rs:125, 363` & `commands/catalog_search.rs:372`）**：
  - 关键词搜索 `CatalogService::search_github_online` 直接调用裸 `client.get(&url).send()`，未接入 `github::http::get_with_etag_diag` 与 `api_etag_cache`；
  - 单仓直查（`owner/repo`、`https://github.com/...`、`gh:...`）调用 `fetch_online_repo` 时硬编码传入 `(None, None)` 并丢弃返回的 `etag_to_save`，既不读也不写 `api_etag_cache`，且漏调了 `app_details` 本地字段回填。
- **GitHub Star 列表（`src-tauri/src/github/developer_starred.rs:96` & `commands/forge.rs:21`）**：
  - `CatalogService::fetch_starred_page` 直接裸调 `client.get().send()`，既未复用 `github::http::get_with_etag_with_link` 的 `If-None-Match` 304 零配额恢复能力，也缺失 D7 传输错误/429/5xx 自动退避重试与系统代理切换即时自愈（ADR-0025）。

### 1.2 GitHub Star 缺乏跨重启 L2 快照持久化，且前端内存缓存「有写无读」（P0）
- **现状（`src/views/FavoritesView/StarredFeed.tsx:51, 81, 235-275`）**：
  - `fetchPage` 每次请求后均调用 `writeSearchListCache({ namespace: 'starred', ... })` 写入内存，但仅在视图卸载重挂时依赖单槽模块变量 `lastQuery` 恢复最近 1 个目标；用户在输入框切换查询对象（如 `userA → @me → userA`）或再次触发查询时，`handleQuery` 完全不读 `readSearchListCache`，并且直接清空当前列表白屏等待网络；
  - 后端注释明确「结果不落库」，客户端重启后进入「收藏 → Star 同步」始终为空状态，无法像趋势榜那样零网络秒出上次同步的富卡列表。

### 1.3 在线搜索平台懒回填硬编码 `forceRefresh = true`，击穿本地详情 TTL 快径（P0 配额浪费）
- **现状（`src/app/hooks/useSearchState.ts:261, 282, 351, 386` & `src-tauri/src/commands/catalog_detail.rs:73`）**：
  - 在线搜索首屏、翻页、甚至命中前端内存 `searchListCache` 时，调用 `lazyBackfillPlatforms(rows, seq, true)` 恒传 `forceRefresh = true`；
  - 后端 `get_platforms_lite` 见 `is_force == true` 即跳过 `platforms_lite_from_cache`（60 分钟 `app_details` TTL 快径），每次强制对前 20 条结果发起 `/repos/{o}/{r}/releases/latest` 请求。未登录匿名状态（60 次/小时配额）连续搜索 3 个词即耗尽配额。

### 1.4 未收录单仓富卡与平台推导结果彼此孤立，跨视图与跨重启重复请求（P1）
- **前端层（`src/services/trends/enrich.ts` vs `onlineRows.ts` / `usePlatformBackfill.ts`）**：
  - 趋势榜耗费 `releases/latest` 推导出的具平台富卡与已确认 `Other` 仅存于趋势私有的 `trendEnrichCache` / `trendConfirmedOtherCache`；用户在趋势榜看过的未收录仓库，切到在线搜索或 Star 列表时仍被视为未知空平台（`platforms = []`），重复发起 `get_platforms_lite`；反之搜索/Star 推导出的平台也不回哺趋势池。
  - `searchListCache.ts` 中 `search` 与 `starred` 两个命名空间共用同一个 50 条上限的 `Map`，深度翻页 Star 列表会直接挤出搜索缓存。
- **后端层（`src-tauri/src/commands/catalog_search.rs:196, 479`）**：
  - `get_platforms_lite` 将拉取的 `/repos/{o}/{r}/releases/latest` JSON 存入了 `api_etag_cache`（不写 `app_details`），但 `backfill_uncataloged_card` 仅回填 `app_details`，未读取 `api_etag_cache` 中已有的 `releases/latest` 载荷，导致重启后所有未点开过详情弹窗的未收录仓库丢失已知平台与真实版本号；
  - `search_apps_online` 关键词分支未复用 `resolve_local_enrich_hit`，搜出已收录应用时未投影精选收录库的中文简介、L1 官方图标与预置 `platforms`。

### 1.5 趋势榜 `enrich_trend_repos` 存在首包串行探图 + 后台流式双倍重复探图 Bug（P1）
- **现状（`src-tauri/src/commands/catalog_search.rs:705, 870` & `src-tauri/src/github/search.rs:310`）**：
  - `fetch_enrich_batch` 调用的 `fetch_online_repo_with_etag` 内部向 `build_summary_from_repo_json` 传入了 `probe = true`，使前 40 个未收录仓库在 `buffered(5)` 阶段阻塞等待 L2 SimpleIcons 与 L3 Git Trees 网络探测，拖慢富卡文字壳首包返回；
  - 返回后第 870 行仅过滤 `pre_confirmed.is_none()`，将刚刚 `probe = true` 探过的所有仓库再次送入后台 `fetch_icons_stream(Trend)` 重复发起第二轮相同探测。

### 1.6 趋势 `new` 榜走匿名通道易撞限流，且 `api_etag_cache` 1000 行上限偏紧（P2）
- **现状（`src/services/trends/board.ts:171`, `src-tauri/src/commands/network.rs:234`, `src-tauri/src/db/etag.rs:7`）**：
  - 趋势 `new` 榜通过 `fetch_trends_text("https://api.github.com/search/repositories?...")` 请求 GitHub Search API 时走无 Token 通道，即使已登录账号也消耗匿名 Search 配额（10 次/分钟）；
  - `API_ETAG_CACHE_MAX_ROWS = 1000` 由推荐画像分页同步、趋势 40 仓 enrich、详情与平台回填共享，接入搜索与 Star 按页 ETag 后易产生高频 LRU 互踢。

---

## 2. ADR 契约冲突与显式修订声明

按 `docs/agents/domain.md` 规范，本方案严格遵守 **D1–D10** 核心边界（特别是 `data:` URI 与运行时收录态盖章永不入 L2 落盘、私有账号数据登出即清、视图层禁直调 `invoke`），并对以下既有 ADR 条款作显式重开与升级（落地后记入 **ADR-0026** 并同步更新关联文档）：

- > _Contradicts ADR-0015 §4（「搜缓存 key=`search|normQuery|page|perPage`…上限 50 条写时 FIFO；读 cache miss 时直接走网络直查，提交前虽读缓存但每次必后台 revalidate」），but worth reopening because_：搜索与 Star 共用单一 50 条 `Map` 会导致深度浏览一方时清空另一方缓存；且用户在数十秒内往返同一搜索词时无条件重打 GitHub Search API + 20 次 `forceRefresh=true` 平台探查严重浪费配额。**修订为**：`searchListCache` 按 `namespace`（`search` / `starred`）各自独立维护 50 条 FIFO 容量池，并引入 **5 分钟新鲜免重拉窗口（`SEARCH_LIST_FRESH_MS = 5min`）+ 5~30 分钟 SWR 后台条件重验（`forceRefresh = false` 走后端 ETag 304）**，仅显式点击刷新/重试时穿透缓存。
- > _Contradicts ADR-0015 §5（「搜索列表不共用趋势坐标；enrich 单向共享：仅具平台 summary 经 hydrate 进共享 `trendEnrichCache`」），but worth reopening because_：搜索、趋势与 Star 渲染的未收录实体同为规范应用标识 `owner/repo` 对应的 `AppSummary + platforms`；单向隔离迫使用户跨视图浏览同一未收录仓库时重复等待 `platformLoading` 并重复请求 `releases/latest`。**修订为**：列表顺序与分页缓存仍严格按视图隔离，但单仓富卡派生层升级为三链路双向共享的 **单仓富卡派生缓存（`Repo Enrich Cache`，内存 12h/600 FIFO + 后端 `api_etag_cache` 跨重启 `releases/latest` 平台与版本回填）**，具平台摘要与已确认 `Other` 在三链路间双向互通，未确认空平台 `loading` 仍严禁入池。
- > _Extends ADR-0019 §2（资产面与非资产面缓存策略）_：收藏页下的「Star 同步（`StarredFeed`）」确立为 **L2 快照持久化 + 手动触发条件同步** 模式——进入视图优先零网络直展本地 SQLite `starred_feed_cache` 上次快照（含离线回退），点击「立即同步」或下拉续拉时经后端 `If-None-Match` ETag 条件请求增量更新（未变更页 `304` 零配额消耗），OAuth 退出登录时原子清除 `@me:` 私有快照与 `/user/` ETag。

---

## 3. 目标架构设计

### 3.1 后端组卡底座收敛、跨重启平台回填与趋势探图修复
1. **`api_etag_cache` 扩容与跨重启 `releases/latest` 回填**：
   - 将 `src-tauri/src/db/etag.rs::API_ETAG_CACHE_MAX_ROWS` 从 `1000` 提升至 `3000`；
   - 在 `src-tauri/src/commands/catalog_search.rs::backfill_uncataloged_card` 中：当 `app_details` 未命中导致 `item.core.platforms.is_empty()` 或 `latest_version == "latest"` 时，同步读取 `api_etag_cache` 中 `https://api.github.com/repos/{owner}/{repo}/releases/latest` 的缓存 JSON（零网络），解析 `tag_name` 与 `platforms_from_assets` 回填至卡片。任意链路跑过一次 `get_platforms_lite` 后，重启客户端在三链路均可直接回填真实平台与版本号。
2. **修复趋势 `enrich_trend_repos` 双倍探图**：
   - `CatalogService::fetch_online_repo_with_etag` 增加 `probe_icons: bool` 参数；
   - `enrich_trend_repos` 内的 `fetch_enrich_batch` 传 `probe_icons = false`，首包仅并发拉取 `/repos/{o}/{r}` 元数据快返，图标探测唯一交由后台 `fetch_icons_stream(Trend)` 执行，且入队前统一过滤 `!state.catalog.is_cataloged(&coord.id) && pre.is_none()`。
3. **趋势 `new` 榜鉴权对齐**：
   - `commands/network.rs::fetch_trends_text` 注入 `State<'_, AppState>`（前端 IPC 入参保持 `{ url }` 零变更）；当且仅当请求目标主机为 `api.github.com` 时，附带当前活跃 GitHub Token（若有）并调用 `notify_rate_limit("github.com", ...)`，避免已登录用户在 `new` 榜误撞匿名 10 次/分钟限流；`github.com` HTML 与 `trend.doforce.dpdns.org` 维持零凭据不变。

### 3.2 在线搜索与 GitHub Star 后端 ETag 304 管道及 `starred_feed_cache` L2 表
1. **在线搜索全分支 ETag 化与精选投影（`github/search.rs` & `commands/catalog_search.rs`）**：
   - `CatalogService::search_github_online` 改用 `github::http::get_with_etag_diag`：非 `force_refresh` 时短锁预读 `api_etag_cache`，`200 Fresh` 落库 `(url, etag, text)`，`304 NotModified` 调 `touch_etag` 并从 `cached_payload` 零配额组装返回，网络/限流失败且有旧 `cached_payload` 时优雅回退缓存结果；
   - 搜索结果（含关键词分支与 `owner/repo` 直查分支）对命中 `CatalogService` 的条目优先投影精选收录库元数据（保留更新的远端 `stars`/`forks`，采用精选中文简介、L1 图标、分类与预置 `platforms`），单仓直查补齐 `resolve_local_enrich_hit` + `save_etag` + `backfill_uncataloged_card`。
2. **GitHub Star 按页 ETag 304 与统一重试（`github/developer_starred.rs` & `commands/forge.rs`）**：
   - `list_github_starred` 新增可选 `force_refresh: Option<bool>`；
   - `CatalogService::fetch_starred_page` 改走 `github::http::get_with_etag_with_link`（复用 D7 有限重试与系统代理失败重探）：
     - 请求始终优先携带已缓存有效载荷的 `If-None-Match`（即使手动点「立即同步」，GitHub 服务端也会实时比对最新标星状态：有变更返 `200`，无变更返 `304` 免扣配额；仅当 `force_refresh == true` 且前端显式要求强刷或本地缓存损坏时跳过）；
     - `304 NotModified` 时调用 `db.touch_etag`，并按 `has_next || raw_item_count >= per_page as usize` 计算 `has_more`（兼容 RFC 7232 下部分 `304` 响应省略 `Link` 头的情形）；
     - 401 触发 `check_auth_expired`；瞬时网络/限流失败且本地 `api_etag_cache` 有该页旧载荷时回退旧载荷并标记 `StarredPageResult.is_stale = Some(true)`。
3. **SQLite `starred_feed_cache` L2 快照表与隐私登出清理**：
   - 在 `src-tauri/src/db/schema.rs::init_schema` 幂等新增表：
     ```sql
     CREATE TABLE IF NOT EXISTS starred_feed_cache (
         cache_key TEXT PRIMARY KEY,
         owner_scope TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         payload_bytes INTEGER NOT NULL DEFAULT 0,
         cached_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_starred_feed_cache_cached_at ON starred_feed_cache(cached_at DESC);
     ```
   - 新增薄透存命令 `get_starred_feed_cache(cache_key)` 与 `save_starred_feed_cache(cache_key, owner_scope, payload_json)`（单条上限 `512KiB` 硬拒绝；启动时 `prune_starred_feed_cache` 清理超 7 天过期行并按 `cached_at DESC` 最多保留 15 个目标）；
   - **登出隐私守卫**：在 `src-tauri/src/oauth/mod.rs::clear_oauth_session` 中同步调用 `db.delete_starred_feed_cache_by_scope_prefix("@me:")`（配合既有的 `delete_etags_by_prefix("https://api.github.com/user/")`），确保退出账号后私有 Star 快照在数据库层彻底清零。

### 3.3 前端三链路共享「单仓富卡与平台缓存池」及列表缓存分池
1. **共享单仓富卡派生缓存（`src/services/repoEnrichCache.ts` + `trends/enrich.ts`）**：
   - 将原趋势内部独享的具平台摘要与已确认 `Other` 记忆提炼为三链路共享接口（底层与 `trendEnrichCache` / `trendConfirmedOtherCache` 同源单一存储，容量对齐 `600` 条 FIFO，TTL `12h`，严禁 `data:` 与未确认空平台入池，剥离运行时收录章）：
     - 读侧：`assembleOnlineRowsWithIcons`（`src/services/search/onlineRows.ts`）组装在线搜索与 Star 分页行时，若行 `platforms` 为空且命中共享池具平台条目，首绘直接回填 `platforms`（及非占位真实 `latest_version`），直接跳过 `platformLoading` 与 `get_platforms_lite`；若命中共享池新鲜 `confirmedOther`，同步被 `usePlatformBackfill` 识别为已落定 `Other`；
     - 写侧：`executeLiteBackfillBatch`（`src/app/hooks/usePlatformBackfill.ts`）在搜索或 Star 列表完成 `getPlatformsLite` 拿到真实平台或确认空平台后，同步写回共享池，使后续进入趋势榜或其他列表即刻复用。
2. **`searchListCache` 按命名空间独立配额与分级新鲜度（`src/services/search/searchListCache.ts`）**：
   - 将底层单 `Map` 升级为按 `namespace`（默认 `'search'`、Star 列表 `'starred'`）隔离容量的双桶结构，每命名空间独立享有 `50` 页 FIFO 上限；
   - 新增 `SEARCH_LIST_FRESH_MS = 5 * 60 * 1000`（5 分钟新鲜免重拉期）与 `readSearchListCacheEntry(key)`（返回 `{ rows, at, isFresh }`），保留 `30min` 总生存期；
   - 提供 `clearSearchListCacheNamespace(namespace, keyPrefix?)`，在账号登出/切换时同步清除内存中 `@me:` 分页缓存。

### 3.4 在线搜索 SWR 门控与 `StarredFeed` L1/L2 秒开闭环
1. **在线搜索（`useSearchState.ts` & `SearchResultsView.tsx`）**：
   - `handleSearchSubmit(queryToSubmit?, opts?: { forceRefresh?: boolean })`：首次提交「在线搜索」默认 `forceRefresh = false`；在已有结果或已搜过状态下点击「重试在线搜索」传 `forceRefresh = true`；
   - 当 `!forceRefresh` 且 `readSearchListCacheEntry` 命中第 1 页时：
     - `isFresh (< 5min)`：直接组装上屏并按需补齐未知平台（`forceRefresh = false`），**零网络短路返回**；
     - `5min ~ 30min`：先组装上屏（SWR 无骨架屏等待），后台调 `searchAppsOnline(..., forceRefresh = false)` 走 ETag 304 静默校验更新；
   - 全部常规搜索与翻页路径的 `lazyBackfillPlatforms` 统一传 `forceRefresh = false`。
2. **GitHub Star 同步视图（`StarredFeed.tsx` + `src/services/starred/starredCache.ts`）**：
   - 新增 `starredCache.ts` 管理 `{ v: 1, rows, pages, hasMore, emptyPages, confirmedOther }` 信封（剥离 `data:` 与收录章，最多持久化前 3 页 / 60 条且经 FE `256KB` 预检裁剪，12h 有效 TTL + 7 天离线 stale 兜底）及 `localStorage['zstore.starred.opts']`（记忆上次公开用户名或 `@me` 模式）；
   - **冷启动零网络秒开**：挂载时若内存 `lastQuery` 未命中，按当前登录态/记忆目标异步读取 `getStarredFeedCache`，秒级恢复富卡列表，并调 `getConfirmedIconsBatch`（DB-only 零网络）回填已落盘 `data:` 图标、同步注水共享富卡池与 `searchListCache(ns='starred')`；
   - **多目标切换读缓存 + 同目标 SWR 刷新**：
     - 输入框切换至另一用户名查询时，优先命中 L1 `searchListCache(ns='starred')` 或新鲜 L2 快照直展；
     - 对当前已展示目标点击「立即同步」时，保留旧卡片在屏（按钮旋转态，不清空闪白），调用 `listGithubStarred(..., forceRefresh: false)` 经后端 `If-None-Match` 实时向 GitHub 校验（未变 `304` 零配额秒回，变更 `200` 更新卡片并写透 L1 + L2）；平台回填或流式图标就绪后经 800ms 防抖合并写透 `starred_feed_cache`。

---

## 4. IPC 与架构门禁合规说明

- **IPC 命名契约（`AGENTS.md`）**：
  - 新增后端命令 `get_starred_feed_cache(cache_key)` 与 `save_starred_feed_cache(cache_key, owner_scope, payload_json)` 均标注 `#[tauri::command(rename_all = "camelCase")]`，前端请求键严格使用 `cacheKey`、`ownerScope`、`payloadJson`；`list_github_starred` 新增可选请求键 `forceRefresh`；
  - 响应结构体 `StarredFeedCacheEntry { payload_json, cached_at }` 与 `StarredPageResult { rows, has_more, is_stale }` 严格使用 `snake_case`；
  - 同步注册于 `src-tauri/src/lib.rs`、`src/services/api.ts`（`CMD`）、`src/services/api/social.ts`、`src/demo/tauri-mock.ts`（内存态模拟）及 `src/services/api/ipcArgsNaming.test.ts`，确保 `cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`noDirectInvoke.test.ts`、`countDisplay.test.ts` 100% 绿灯。

---

## 5. 实施 Issue 拆分与依赖拓扑

```text
  [01 后端组卡收敛、ETag扩容、趋势双探修复与 new 榜鉴权] ──► [02 在线搜索与 GitHub Star 后端 ETag 304 管道及 Star L2 表] ──┐
                                                                                                                              ├──► [05 StarredFeed L1/L2 秒开快照与 SWR 同步闭环] ──► [06 ADR-0026、领域文档同步与全量回归门禁]
  [03 前端共享单仓富卡缓存池与分页列表缓存分池分级] ────────► [04 在线搜索 SWR 缓存门控与平台懒回填减负] ────────────────────┘
```

1. [`01-backend-card-convergence-and-trend-probe-fix.md`](./issues/01-backend-card-convergence-and-trend-probe-fix.md)（`ready-for-agent`，`Blocked by: none`）
2. [`02-backend-search-starred-etag-and-starred-l2-db.md`](./issues/02-backend-search-starred-etag-and-starred-l2-db.md)（`ready-for-agent`，`Blocked by: 01`）
3. [`03-frontend-shared-repo-enrich-and-list-cache-pools.md`](./issues/03-frontend-shared-repo-enrich-and-list-cache-pools.md)（`ready-for-agent`，`Blocked by: none`，可与 01 并行）
4. [`04-online-search-swr-and-platform-backfill-convergence.md`](./issues/04-online-search-swr-and-platform-backfill-convergence.md)（`ready-for-agent`，`Blocked by: 02, 03`）
5. [`05-starred-feed-l2-hydration-and-swr-sync.md`](./issues/05-starred-feed-l2-hydration-and-swr-sync.md)（`ready-for-agent`，`Blocked by: 02, 03, 04`）
6. [`06-docs-adr-0026-and-regression-gates.md`](./issues/06-docs-adr-0026-and-regression-gates.md)（`ready-for-agent`，`Blocked by: 01, 02, 03, 04, 05`）

---

## 6. 整体验收标准

- **配额与延迟收敛**：
  - 在线搜索在 5 分钟新鲜窗口内重搜同词实现 0 网络秒回；5~30 分钟内走 SWR 首绘 + 后端 ETag 304 校验；常规搜索平台回填默认复用 `app_details` TTL 与 `releases/latest` ETag，不再每次强穿网络；
  - 趋势榜 `enrich_trend_repos` 首包不再内联串行探图标，同批次不再出现「首包探一遍 + 后台流式再探一遍」的双倍请求；已登录状态下趋势 `new` 榜携带 Token 请求 `api.github.com`；
- **跨视图与跨重启富卡共享**：
  - 在趋势榜、在线搜索或 GitHub Star 任一视图已完成平台推导（具平台或确认 `Other`）的未收录仓库，切至其余两个视图时首绘直接展现 OS 平台徽标，不再重复发起 `get_platforms_lite`；客户端重启后仍可从 `api_etag_cache` 的 `releases/latest` 载荷同步回填已知平台与版本号；
- **GitHub Star 秒开与隐私安全**：
  - 客户端重启后进入「收藏 → Star 同步」，零网络直展上次同步的富卡列表与本地已确认图标；点击「立即同步」保留旧列表平滑刷新，未变更页经 `304 Not Modified` 零配额完成校验；切换不同用户名优先命中 L1/L2 缓存；
  - 执行 `oauth_logout` 退出登录时，数据库 `starred_feed_cache` 中的 `@me:*` 记录、`/user/` ETag 记录及前端内存 `@me:` 缓存全部同步清除；
- **全量门禁**：
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npx tsc --noEmit`、`npx vitest run`、`npx vite build --config vite.demo.config.ts` 全部零错误通过。
