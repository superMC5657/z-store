# Feature Spec: 在线搜索 / 趋势榜 / GitHub Star 富卡生成链路收敛与缓存治理优化（Rich-Card Pipeline Optimization）

> 状态：Resolved（Issues `01`–`05` 全量落地）
> 关联契约：`CONTEXT.md`（D2 零服务器成本与解耦清单同步、D5 双池复用、D6 有限并发、D7 有限重试、D9 趋势与首页、D10 统一图标获取）、ADR-0003（SQLite 持久化与 ETag 缓存）、ADR-0007（开放清单与可配置 TTL 缓存）、ADR-0010（规范应用标识 `Canonical App Id`）、ADR-0011（doforce 趋势聚合源例外）、ADR-0014（趋势榜 L2 与治理）、ADR-0015（统一图标获取与搜索对齐）、ADR-0019（资产面手动缓存与非资产面自动拉取）。

---

## 1. 背景与全链路诊断

ZStore 的 **搜索在线应用（Search Online）**、**趋势榜（Trending Boards）** 与 **GitHub Star（`StarredFeed`）** 三条非资产面发现链路均采用「首屏轻量骨架快返（同步回填本地确认图标与详情）→ 后台流式图标补探（`IconFetch`）+ 轻量平台推导（`get_platforms_lite`）双轨异步升格 `<AppCard />` 富卡」的统一范式。

经对三条链路的前后端源码逐行拆解，定位出 **6 项关键性能损耗、配额浪费与缓存孤岛问题**：

### 1.1 问题一：`SearchResultsView` 对在线结果误挂 `useRowIconBackfill`，引发 20 路无界并发探测风暴（P0）
- **现状（`src/views/SearchResultsView.tsx:140-144` & `src/views/shared/useRowAnnotations.ts:50-78`）**：
  - 后端 `search_apps_online`（`src-tauri/src/commands/catalog_search.rs:576`）为保证首屏快返，对无本地确认图标的未收录应用返回 `icon: ""`，并在后台派生 `fetch_icons_stream(pool=5)` 仅探 L2 SimpleIcons → L3 Git Trees（严禁探 L4 README）。
  - 但前端 `SearchResultsView` 将 `activeOnlineApps` 拼入 `iconRows` 传给 `useRowIconBackfill`。首帧渲染时，`useRowIconBackfill` 对全部 `icon === ""` 的在线行**无并发上限**地逐个调用 `tauriApi.restoreOrFetchIconCycle(row.id)`。
  - 在 `app_icon_cycles` 尚无记录时，`restore_or_fetch_icon_cycle` 内部 `ensure_cycle_levels`（`src-tauri/src/icons/mod.rs:717`）会并行执行 `tokio::join!(probe_l2_simple, probe_l3_trees, probe_readme)` 再全量下载图片字节，导致单页 20 条在线搜索瞬间额外爆发最多 **20 × 3 = 60 次请求**（含违背 ADR-0015 §2 流式边界的 20 次 README API 请求），与后台 `fetch_icons_stream` 重复竞争写库并快速消耗 GitHub API 配额。

### 1.2 问题二：在线搜索硬编码 `forceRefresh = true` 击穿平台推导 60 分钟 `Cache TTL`，且主列表缺同代去重（P0）
- **现状（`src/app/hooks/useSearchState.ts:261, 282, 351, 386` & `src/app/hooks/usePlatformBackfill.ts`）**：
  - `handleSearchSubmit`（含第 1 页命中 `Search List Cache` 的首绘分支）与 `handleOnlineLoadMore`（含翻页直接命中 `Search List Cache` 的纯内存分支）调用 `lazyBackfillPlatforms(rows, seq, true)` 时一律硬编码了 `forceRefresh = true`。
  - 穿透至后端 `get_platforms_lite`（`src-tauri/src/commands/catalog_detail.rs:73`）后，直接跳过 `platforms_lite_from_cache`（`app_details` 60 分钟 `Cache TTL` 零网络快径），强制逐仓请求 `/releases/latest`；这与 `StarredFeed`（`useListPlatformBackfill` 默认 `forceRefresh = false`）及趋势榜（`syncLiteVerify` 默认 `false`）的缓存优先口径不一致。
  - 同时，`usePlatformBackfill` 未像 `useListPlatformBackfill` 那样维护同 `seq` 的 `attempted` 已尝试集合，当同词先命中 `searchListCache` 再收到 `searchAppsOnline` 回包时，会对刚返回 `is_stale` 或失败的同一批空平台行重复发起 `get_platforms_lite`。

### 1.3 问题三：GitHub Star 列表、单仓直查与趋势 `new` 榜缺失 `ETag Cache` 或认证头（P1）
- **现状**：
  1. **Star 列表无条件重拉（`src-tauri/src/github/developer_starred.rs:96`）**：`CatalogService::fetch_starred_page` 直接调用裸 `client.get().send()`，未接入 `github::http::get_with_etag_diag_inner` 与 `api_etag_cache`，既无 `304 Not Modified` 零配额复用，也无 D7 的 429/5xx 有限重试与离线缓存回退。
  2. **搜索单仓直查未对齐流式与缓存契约（`src-tauri/src/commands/catalog_search.rs:372-411` & `src-tauri/src/github/search.rs:356`）**：输入 `owner/repo` 或 GitHub URL 走 `fetch_online_repo` 时，传入 `cached_etag: None, cached_payload: None` 且丢弃响应 ETag，未调用 `backfill_uncataloged_card` 回填 `app_details` 已知平台/版本，且以 `probe = true` 同步阻塞首屏探图标。
  3. **趋势 `new` 榜落入匿名限流池（`src-tauri/src/commands/network.rs:110` & `src/services/trends/board.ts:173`）**：`new` 榜经 `fetch_trends_text` 请求 `https://api.github.com/search/repositories?q=created:...` 时未携带已登录用户的 GitHub Token，落入 GitHub Search API 未认证 **10 次/分钟** 的严苛限流池（携带 Token 可提升至 30 次/分钟），且未上报 `notify_rate_limit`。

### 1.4 问题四：跨链路仓库 JSON 孤岛与趋势 `api_etag_cache` 永久短路无 304 再验证（P1）
- **现状**：
  1. **趋势 `enrich_trend_repos` 永久跳过条件验证（`src-tauri/src/commands/catalog_search.rs:784-796`）**：当 `!is_force` 时，只要 `api_etag_cache` 存在某仓库的 `payload_json`，`resolve_local_enrich_hit` 便无视 `last_checked_at` 年龄直接返回静态快照并跳过 `fetch_enrich_batch`，导致数天前的旧星数/简介在榜单 L1/L2 过期重抓后仍永不通过 `304 Not Modified` 保鲜。
  2. **跨视图单仓元数据孤岛**：用户在 `search_apps_online`（关键词搜索）或 `list_github_starred`（Star 列表）已拿到 20 个仓库的完整 GitHub Repo JSON，但未将单仓 JSON 播种至 `api_etag_cache`；随后切至趋势榜遇到同一未收录仓库时，`enrich_trend_repos` 仍需重复发起 `GET /repos/{owner}/{repo}`。
  3. **本人 Star 列表离线孤岛**：登录用户后台画像同步（`affinity.rs`）已按 `per_page=100` 将 `/user/starred` 缓存在 `api_etag_cache`，但用户在收藏页「Star 同步」查自己遇到断网且 `per_page=20` 未缓存时直接报错，未能回退切片已同步的本地画像页缓存。

### 1.5 问题五：`zstore://icon-ready` 双重订阅、世代门控缺口、搜缓存共池互挤与双 API 连接池（P2）
- **现状**：
  1. **事件双重订阅与门控绕过**：`src/app/hooks/useAppSubscriptions.ts:249` 全局监听 `onIconReady` 并调用 `admitIconHit`（无 `board`/`boardGen` 期望值），而 `TrendBoardSession`（`src/services/trends/board.ts:1375`）又挂载了第二个 `onIconReady` 监听器再次调用 `admitIconHit`。每张趋势图标到达均触发两次 `admitIconHit`、两次 `notifyIconWrites` 与防抖写盘调度；且切榜瞬间的 IPC 在途旧事件会被根监听器放行并通过 `subscribeIconWrites` 绕过 `TrendBoardSession` 的榜单门控。同时 `Starred` 上下文在前端 `iconStore` 中尚未接入 `gen` 门控。
  2. **`Search List Cache` 命名空间共池互挤（`src/services/search/searchListCache.ts:28`）**：`search`（搜索页）与 `starred`（收藏页 Star 列表）共用同一个上限 50 条的 `Map`，在 Star 页连续下滑翻阅他人列表会把刚搜过的在线搜索分页缓存全部 FIFO 挤出。
  3. **Rust 双 API 连接池并存**：`src-tauri/src/lib.rs::SHARED_HTTP_CLIENT` 与 `src-tauri/src/forge/http.rs::SHARED_API` 各自维护了一个配置相同的 `OnceLock<reqwest::Client>`，分散了 `api.github.com` 的连接复用（D5）。

---

## 2. 目标架构与优化方案

### 2.1 在线搜索图标风暴治理与平台回填 TTL 对齐（Issue 01）
1. **`SearchResultsView` 剥离在线段重复补图**：`useRowIconBackfill` 仅接收本地目录段 `displayedLocal`，不再传入 `activeOnlineApps`；在线段未收录应用统一由后端 `search_apps_online` 已派生的 `fetch_icons_stream` + 前端 `assembleOnlineRowsWithIcons`（`queueAssembledRowIcons`）完成流式探测与磁盘预热。
2. **平台 Lite 默认复用 60 分钟 `Cache TTL`**：`useSearchState` 中常规首次在线搜索与翻页（含 `Search List Cache` 命中分支）调用 `lazyBackfillPlatforms(rows, seq, false)`；仅当用户对同一搜索词已执行过在线搜索后再次点击「重试在线搜索」（显式重试）时传 `forceRefresh = true`。
3. **`usePlatformBackfill` 增加同 `seq` 已尝试去重**：对齐 `useListPlatformBackfill`，记录 `{ seq, keys }` 集合，同一搜索 `seq` 内已请求过 `get_platforms_lite` 的键不再因列表二次拼接重复发起请求，未落定项交由 15s `scheduleSettleConfirm` 兜底。

### 2.2 Star 列表与单仓直查接入 `ETag Cache` 及趋势 `new` 榜鉴权（Issue 02）
1. **暴露带诊断状态码与分页头的 ETag 通道（`src-tauri/src/github/http.rs`）**：提供 `get_with_etag_diag_with_link`，同时返回 `(EtagGetOutcome, HttpDiag, bool)`，保留 HTTP 状态码供上层精确映射 401/403/404 提示文案。
2. **`fetch_starred_page` 接入 `api_etag_cache` 与离线回退（`developer_starred.rs` & `commands/forge.rs`）**：
   - 将分页缓存信封 `{ has_more, items }` 与响应 ETag 存入 `api_etag_cache`（键为规范请求 URL `.../starred?per_page=20&page=N`），`304 Not Modified` 时零配额还原 `repos` 与精确的 `has_more` 并 `touch_etag` 保鲜；网络错误时回退已有缓存页；
   - `parse_starred_payloads` 同时兼容裸 Repo 对象与 `star+json` 包装对象 `{ starred_at, repo }`。
3. **在线搜索 `owner/repo` 直查对齐流式富卡管线（`catalog_search.rs` & `github/search.rs`）**：
   - 预读 `api_etag_cache` 中的 `etag` 与 `payload_json` 传入 `fetch_online_repo_with_etag`，新 ETag 落库；
   - 首屏传 `Some(pre_confirmed.unwrap_or_default())` 跳过同步阻塞探图，统一经 `backfill_uncataloged_card` 回填 `app_details` 全字段，并在缺确认图标时派生 `fetch_icons_stream(Search)` 后台补图。
4. **`fetch_trends_text` 按主机边界精确挂载认证头（`commands/network.rs`）**：
   - 保持前端 `fetchTrendsText(url)` IPC 签名完全不变；
   - 后端仅当解析后的 `host == "api.github.com"` 时挂载当前活跃 GitHub Token（`AuthScheme::Token` + GitHub Accept 头）并调用 `notify_rate_limit("github.com", resp.headers())`；对 `github.com` 网页与 `trend.doforce.dpdns.org` 绝不携带任何认证凭据（严守 D5 与 ADR-0011 信任边界）。

### 2.3 趋势 Enrich 软过期 304 校验与跨链路单仓缓存反哺（Issue 03）
1. **`enrich_trend_repos` 引入 12 小时软 TTL 条件校验**：
   - 在 `db/etag.rs` 新增 `get_etag_entry(&self, endpoint_url) -> Result<Option<EtagCacheEntry>>`（一次查询取出 `etag`、`payload_json`、`last_checked_at`）；
   - `enrich_trend_repos` 中：若 `api_etag_cache` 命中且距 `last_checked_at` 未满 **12 小时（`43200s`，对齐趋势 L2 周期）**，直接经 `resolve_local_enrich_hit` 零网络秒返；若已满 12 小时且存在非空 `etag`，则携带 `(cached_etag, cached_payload)` 进入 `fetch_enrich_batch` 发 `If-None-Match`（`304` 零配额 `touch_etag` 续期，`200` 刷新最新星数/简介，断网回退 `cached_payload`）。
2. **搜索与 Star 列表向 `api_etag_cache` 播种单仓 JSON**：
   - `search_github_online` 与 `list_github_starred` 返回的每项均是标准 GitHub Repo JSON；在单次 DB 批处理锁内，以 `https://api.github.com/repos/{owner}/{repo}` 为键对**尚无非空 ETag 的条目**写入最新 `payload_json`（`etag = ""`, `last_checked_at = now`），使紧随其后的趋势榜 `enrich_trend_repos` 在 12 小时窗口内直接零网络组卡，且不覆盖已有的真实 HTTP ETag。
3. **本人 Star 列表断网回退画像缓存**：
   - 当用户查询登录账号自身 Star（`username == None`）且网络请求失败、`per_page=20` 页无缓存时，回退从 `api_etag_cache` 中 `affinity` 已同步的 `/user/starred?per_page=100&page=K` 载荷按页窗口切片组卡。

### 2.4 图标事件单一收口、三维世代门控与命名空间缓存隔离（Issue 04）
1. **收敛全局唯一 `onIconReady` 监听器**：
   - 移除 `src/services/trends/board.ts` 中的 `attachStreamIconListener` 重复 IPC 订阅，全站仅保留 `useAppSubscriptions.ts` 根级单一 `tauriApi.onIconReady -> admitIconHit` 入口；`TrendBoardSession` 统一通过已有的 `subscribeIconWrites` 接收图标更新并触发 L2 防抖写透。
   - 在 `iconStore.ts` 中提供轻量上下文门控注册口（如 `setExpectedTrendGate` / `setExpectedStarredGen`，由后端回包或视图周期同步），按 `context.kind`（`search` / `trend` / `starred`）正交校验世代，彻底堵住切榜/换人瞬间的 IPC 在途串扰。
2. **`Search List Cache` 按命名空间独立限额**：
   - > _细化 ADR-0015 §4（原仅定义 `search` 单命名空间 50 条 FIFO，后 `StarredFeed` 接入 `starred` 命名空间共用同一 Map）_：将 `SEARCH_LIST_MAX_ENTRIES = 50` 改为**每个 `namespace` 独立上限 50 条 FIFO**，互不驱逐。
3. **Rust API Client 单例合一（D5）**：
   - `src-tauri/src/lib.rs::shared_http_client()` 与 `src-tauri/src/forge/http.rs::new_api_client()` 收敛共享同一底层 API `reqwest::Client` 连接池（保持图标专用 `SHARED_ICON` 与清单同步 `CatalogService.client` 物理隔离不变）。

### 2.5 领域文档同步与全量回归验证（Issue 05）
- 同步更新 `CONTEXT.md`、ADR-0011、ADR-0015 中涉及的缓存分桶、趋势 `new` 榜鉴权、单仓 ETag 软 TTL 与图标事件单一订阅描述，并通过 Rust + Vitest 全量自动化门禁验证。

---

## 3. 实施 Issue 拆分与依赖拓扑

```text
  [01 前端搜索风暴与平台TTL] ───────────────────────┐
  [02 后端 Star/直查 ETag 与趋势鉴权] ──► [03 跨链反哺与软TTL] ──┼──► [05 文档同步与全量验收]
  [04 图标单订阅门控 + 搜缓存分桶 + 单例池] ─────────┘
```

- [`01-search-online-icon-storm-and-platform-ttl-fix.md`](issues/01-search-online-icon-storm-and-platform-ttl-fix.md)（`resolved`）
- [`02-starred-and-direct-search-etag-and-trends-auth.md`](issues/02-starred-and-direct-search-etag-and-trends-auth.md)（`resolved`）
- [`03-cross-pipeline-repo-cache-and-starred-self-seed.md`](issues/03-cross-pipeline-repo-cache-and-starred-self-seed.md)（`resolved`）
- [`04-icon-ready-single-subscription-and-cache-isolation.md`](issues/04-icon-ready-single-subscription-and-cache-isolation.md)（`resolved`）
- [`05-docs-context-and-regression-suite.md`](issues/05-docs-context-and-regression-suite.md)（`resolved`）
