# Feature Spec: 全链路性能与缓存治理优化（Performance & Cache Hardening）

> 状态：Implemented（`resolved`）
> 关联契约：`CONTEXT.md`（D2 零服务器成本与解耦清单同步、D5 双池复用、D9 趋势与首页、D10 统一图标获取）、ADR-0003（SQLite 持久化与 ETag 缓存）、ADR-0007（开放清单与可配置 TTL 缓存）、ADR-0010（规范应用标识 `Canonical App Id`）、ADR-0012（网络性能 P0 连接池与并发跳过）、ADR-0013（发现页 Feed 契约）、ADR-0015（统一图标获取）。

---

## 1. 问题背景与根因诊断

通过对 ZStore 前后端全链路（Rust 后端目录服务、网络/更新检查管道、SQLite 缓存层、React 19 视图与订阅总线）进行静态审查与复杂度分析，定位出以下 5 个关键性能与架构治理问题：

### 1.1 根因一：`CatalogService` 投影与检索存在 $O(N^2)$ 线性扫描与重复深拷贝
- **现状**：
  - `src-tauri/src/github/catalog_service.rs` 中，`CatalogService` 仅以 `RwLock<Vec<CatalogItem>>` 存储 `items`（远端目录）与 `collected`（本地库 overlay），未建立哈希索引。
  - `get_remote_catalog_item(&self, id: &str)`（L103-109）与 `get_collected_item(&self, id: &str)`（L118-123）每次调用都会执行 `canonical_app_id(id)` 解析、获取读锁、在 `Vec<CatalogItem>` 上做 $O(N)$ 线性查找并 `.cloned()` 整个 `CatalogItem`。
  - `merged_summaries(&self)`（L187-192）在遍历合并目录的 $N$ 个条目时，对每一项调用 `item_to_stamped_summary` $\rightarrow$ `stamp_summary` $\rightarrow$ `resolve_catalog_stamp`，内部再次调用 `get_remote_catalog_item` 与 `is_collected_id`。这导致每次调用 `merged_summaries()`（被 `get_home_feed`、`get_category_apps`、`get_latest_catalog_apps`、本地搜索高频调用）都退化为 **$O(N^2)$ 线性扫描 + $2N$ 次 `CatalogItem` 深拷贝 + $2N$ 次 `canonical_app_id` 归一化**。
  - 同理，`src-tauri/src/github/affinity.rs::build_starred_sync_result_from_cached`（L213-220）在外层遍历 `starred_list`、内层 `catalog_list.iter().find(...)` 时，将 `crate::forge::canonical_app_id(&full_name)` 放在了内层闭包中，导致每个 Star 仓库重复执行 $N$ 次 ID 归一化。

### 1.2 根因二：手动检查更新（`fetch_app_latest_version_lightweight`）未携带 ETag 条件头
- **现状**：
  - `src-tauri/src/commands/updates_check.rs::fetch_app_latest_version_lightweight`（L80-86）在 `force_refresh == Some(true)`（用户在更新中心点击“检查更新”）时，直接调用：
    ```rust
    crate::github::http::get_with_etag(&state.http, &ep, None, &base_headers, None, "updates")
    ```
    其中 `cached_etag` 参数被硬编码为 `None`，但随后在 L128 却又把响应的 `etag` 与 `payload` 存入 `api_etag_cache`（`db.save_etag`）。
  - 因为请求从不读取 `db.get_etag(&ep)`，保存的 ETag 永远不会被发送，导致每次手动检查更新都强制返回 `200 OK` 全量响应并扣减 GitHub REST API 配额（未登录仅 60 次/小时），违背了 `CONTEXT.md` 中“通过 `If-None-Match` 实现零配额消耗更新检测”的设计契约。

### 1.3 根因三：画像同步与下载器每次调用重建 `reqwest::Client`，破坏连接池复用（D5）
- **现状**：
  - `src-tauri/src/github/affinity.rs::sync_github_affinity_signals_bg`（L129）每次执行后台画像同步都调用 `super::http::build_api_client()?` 新建一次性 `reqwest::Client`，未复用 `crate::shared_http_client()`。
  - `src-tauri/src/installer/downloader_http.rs::download_with_progress`（L21-29）每次下载资产都重新 `reqwest::Client::builder()...build()`，使得连续安装或批量更新时无法复用 TCP/TLS 连接池。

### 1.4 根因四：前端图标就绪双重 `setState` 扇出、首页前后端重复全量重排与导航小瑕疵
- **现状**：
  1. **图标写扇出重复触发 8 次列表更新**：`src/app/hooks/useAppSubscriptions.ts`（L260-265）在 `onIconReady` 回调中向 `admitIconHit` 传入了 `patch` 闭包（对 `apps`、`onlineApps`、`recentlyViewedApps`、`uncatalogedExtraApps` 四列表调用 `patchAppIconList`）；而 `admitIconHit` 内部受理后又通过 `notifyIconWrites` 触发 `src/App.tsx`（L282-316）注册的 `subscribeIconWrites` 订阅，对同一批四列表再次执行 `patchAppIconList`。
  2. **首页 Feed 前后端双重全量排序**：`src/views/HomeView/useHomeFeed.ts`（L209-239）在 Tauri 桌面环境下已经通过后端 `get_home_feed`（`isBackendListActive === true`）获取了带亲和度画像的排序分页结果，但前端 `useMemo` 仍无条件对全量 `apps` 执行 `buildFrontendAffinityScorer` + `rankFeed` 计算 `rankedRest` / `localFeaturedApps` / `visibleLocal`。
  3. **死代码与导航收口绕过**：`src/App.tsx`（L541-548）定义了 `handleEnterUpdatesTab` 但未传给任何子组件；L708 `LatestView` 的 `onNavigateCategories={() => setCurrentView('categories')}` 绕过了统一导航函数 `navigate`。

### 1.5 根因五：SQLite `api_etag_cache` 与 `app_details_cache` 缺少容量上限淘汰
- **现状**：
  - `src-tauri/src/lib.rs`（L444-449）启动时仅清扫了 `trend_board_cache`（`prune_expired_trend_board_cache`）与图片磁盘缓存（`enforce_asset_quota_lru`）。
  - `api_etag_cache`（保存完整 GitHub Release / Starred JSON 文本）与 `app_details_cache`（保存含完整 README Markdown 的 `detail_json`）从未设置条数上限或过期清扫，随用户长期搜索、浏览在线仓库与趋势榜会无限增长。

---

## 2. 优化目标与设计方案

### 2.1 `CatalogService` 哈希索引与 $O(N)$ 批量盖章投影（Issue 01）
- 在 `CatalogService` 中使单次查询与全量投影避免重复线性扫描与无谓克隆：
  - `merged_summaries(&self)` 内部直接读取 `items` 与 `collected` 读锁，预先构建远端已验证集合/映射与本地收录 ID 集合，在单趟遍历中直接完成去重、`to_summary()` 与 `(is_cataloged, source, status)` 盖章，时间复杂度从 $O(N^2)$ 降至 $O(N)$，且零 `CatalogItem` 克隆。
  - `resolve_catalog_stamp(&self, id: &str)` 仅在读锁内借用检查 `is_verified` 与是否存在，不再 `.cloned()` 完整的 `CatalogItem`。
  - `build_starred_sync_result_from_cached` 预先將 `catalog_list` 构建为 `HashMap<&str, &CatalogItem>`，外层每项仅调用一次 `canonical_app_id(&full_name)` 进行 $O(1)$ 查找。

### 2.2 更新检查复用 `api_etag_cache` 条件请求（Issue 02）
- 在 `src-tauri/src/commands/updates_check.rs::fetch_app_latest_version_lightweight` 的 `force_refresh == Some(true)` 分支中：
  - 跳过详情 `Cache TTL` 短路（确保每次手动刷新都会向远端发起实时校验），但从 `state.db()` 读取 `db.get_etag(&ep)` 与 `db.get_cached_payload(&ep)`；
  - 将 `cached_etag.as_deref()` 传给 `get_with_etag`，并将 `cached_payload.as_deref()` 传给 `decide_shallow_release`；
  - 当远端返回 `304 Not Modified` 时，零配额消耗直接从 `cached_payload` 解析最新 `tag_name` 与 `body`；当返回 `200 OK` 时更新 `api_etag_cache`。

### 2.3 HTTP Client 连接池复用收敛（Issue 03）
- `src-tauri/src/github/affinity.rs::sync_github_affinity_signals_bg` 改为直接复用 `crate::shared_http_client()`，移除每次同步新建 `build_api_client()` 的开销。
- `src-tauri/src/installer/downloader_http.rs` 按 `dl_extra`（`no_proxy` 主机列表键）维护有界缓存池 `DOWNLOAD_CLIENTS`（上限 8）复用下载专用 `reqwest::Client`，避免每次下载重建连接池。

### 2.4 前端图标写扇出单一化、首页重排惰性化与死代码清理（Issue 04）
- 移除 `src/app/hooks/useAppSubscriptions.ts` 中 `onIconReady` 传给 `admitIconHit` 的冗余 `patch` 回调，将 `subscribeIconWrites` 收口于 `useAppSubscriptions.ts` 单一扇出更新四列表与搜索缓存（并移除 `src/App.tsx` 中的重复订阅）。
- 在 `src/views/HomeView/useHomeFeed.ts` 中，当 `!isSearching && backendActive && backendNonHero.length > 0` 时，跳过前端 `buildFrontendAffinityScorer` 与 `rankFeed` 的全量重排计算。
- 清理 `src/App.tsx` 中未使用的 `handleEnterUpdatesTab`，并将 `LatestView` 的 `onNavigateCategories` 统一改为 `() => navigate('categories')`。

### 2.5 SQLite `api_etag_cache` 与 `app_details_cache` 容量上限清扫（Issue 05）
- 在 `src-tauri/src/db/cache.rs` 中新增 `prune_bounded_caches(&self, max_etag_rows: usize, max_detail_rows: usize) -> Result<(usize, usize)>`（默认上限如 `api_etag_cache` 1000 条、`app_details_cache` 500 条，按 `last_checked_at` / `cached_at` LRU 保留最新行）。
- 在 `src-tauri/src/lib.rs` 启动清扫块中调用该方法（best-effort 吞错，不阻塞启动），防止长期使用后 SQLite 数据库无限膨胀。

---

## 3. 实施 Issue 拆分清单

- [`01-catalog-index-and-o1-projection.md`](file:///z:/rust_workplace/z-store/.scratch/perf-and-cache-hardening/issues/01-catalog-index-and-o1-projection.md)：`CatalogService` 批量投影 $O(N)$ 优化、零克隆盖章与 Starred 匹配 $O(1)$ 查表。
- [`02-updates-etag-conditional-fetch.md`](file:///z:/rust_workplace/z-store/.scratch/perf-and-cache-hardening/issues/02-updates-etag-conditional-fetch.md)：手动检查更新接入 `api_etag_cache` 条件请求（304 零配额恢复）。
- [`03-http-client-pooling-convergence.md`](file:///z:/rust_workplace/z-store/.scratch/perf-and-cache-hardening/issues/03-http-client-pooling-convergence.md)：画像同步与下载器 `reqwest::Client` 连接池复用收敛。
- [`04-frontend-icon-fanout-and-homefeed-dedup.md`](file:///z:/rust_workplace/z-store/.scratch/perf-and-cache-hardening/issues/04-frontend-icon-fanout-and-homefeed-dedup.md)：前端图标 `subscribeIconWrites` 单一扇出、`useHomeFeed` 惰性重排与 `App.tsx` 导航/死代码清理。
- [`05-sqlite-etag-and-detail-cache-pruning.md`](file:///z:/rust_workplace/z-store/.scratch/perf-and-cache-hardening/issues/05-sqlite-etag-and-detail-cache-pruning.md)：SQLite `api_etag_cache` 与 `app_details_cache` 启动期 LRU 容量上限裁剪。
