# Feature Spec: 图标与富卡全字段本地缓存优先架构重构及详情更新写透（Icon & Rich-Card Local-Cache-First Redesign）

> 状态：Implemented（`resolved`）
> 关联契约：`CONTEXT.md`（D2 零服务器成本与解耦清单同步、D5 双池复用、D7 有限重试、D8 首包验图与跳过、D9 趋势与首页、D10 统一图标获取）、ADR-0003（SQLite 持久化与 ETag 缓存）、ADR-0007（开放清单与可配置 TTL 缓存）、ADR-0010（规范应用标识 `Canonical App Id`）、ADR-0014（趋势 L2 与治理）、ADR-0015（统一图标获取与搜索对齐）、ADR-0019（资产面与非资产面缓存策略）。

---

## 1. 问题背景与全链路根因诊断

当网络出现波动、抖动或处于弱网环境时，富卡页面（发现页 `HomeView`、趋势榜 `TrendsView`、分类中心 `CategoriesView`、最新入库 `LatestView`、收藏与关注 `FavoritesView`、在线搜索等）大量本已缓存在本地磁盘（`icons/`）和本地 SQLite（`z_store.db`）中的图标与富卡元数据无法显示或刷新失败，退化为首字母缩写徽章（如 `RD`、`LS`）或裸行占位；同时，点击进入应用详情（`AppDetailModal`）拿到最新数据后，部分本地缓存未能同步刷新甚至被旧快照反向覆盖。

经对前后端代码全链路取证，定位出以下 **6 大核心根因**：

### 1.1 根因一：前端 `AppIcon` 在本地缓存未就绪前直连外网 `<img src="https://...">`，网络波动触发 `onError` 后永久锁死 `hasError = true`，且 `iconStore` 读盘完成从不通知 `AppIcon` 重绘
- **现状（`src/components/AppIcon.tsx` & `src/services/iconStore.ts`）**：
  1. `iconStore.ts` 中的 `iconDataCache`（存放 `get_or_fetch_icon` 从本地磁盘 `icons/` 读取的 `data:image/...;base64,...`）是一个**纯内存 `Map`（上限仅 200 条）**，客户端启动时为空。
  2. 当富卡首次渲染 `<AppIcon icon="https://..." appId="owner/repo" />`（或超过 200 条被 FIFO 淘汰、或位于列表第 30 项之后）时，`resolveDisplaySrc`（`AppIcon.tsx:62-74`）查 `getCachedIconDataUri` 未命中，**直接回退返回原始远端 URL `https://...`**。
  3. 浏览器 WebView 立即对 `<img src="https://...">` 发起直连外网请求（完全绕过 Rust 本地 `icons/` 磁盘缓存）。一旦网络波动导致图片请求失败，`onError` 立即将 `hasError` 置为 `true`（`AppIcon.tsx:129-132`），降级为首字母缩写徽章。
  4. 与此同时，后台 `startIconFetch`（`iconStore.ts:625-666`）通过 `getOrFetchIcon` IPC 从本地磁盘 `icons/` 成功读出 `data:` URI 并写入 `iconDataCache` 后，**既未调用 `notifyIconWrites` 通知任何订阅者，也未触发 `AppIcon` 重渲染**！
  5. 更严重的是，`AppIcon.tsx:125-127` 中 `useEffect(() => { setHasError(false); }, [activeIcon])` **仅监听 `activeIcon`（远端 URL 字符串）而非 `displaySrc`**。即便父组件触发重渲染使 `displaySrc` 变为本地 `data:` URI，只要 `activeIcon` 仍是同一个 `https://...` 字符串，`hasError` 就永远保持 `true`，导致本地明明有缓存图标却永久显示首字母徽章。
  6. 此外，`iconStore.ts:500-548` 的 `queueAssembledRowIcons` 存在**“退避僵尸占坑死锁”**：当列表前 30 个 URL 因网络抖动进入 `iconPreloadBackoffUntil`（30s 退避）时，`isIconPersistedOrQueued` 对退避项返回 `false`（注释称“失败退避中不算已覆盖，仍占名额”），导致这 30 个退避项填满 `ASSEMBLED_ROW_ICON_QUEUE_CAP = 30` 名额后在 `queueIconFetches`（L461）被直接 `continue` 丢弃，使得排在第 31 位之后的已缓存图标在 30 秒内完全无法入队读盘。
  7. `FavoritesView.tsx:73`、`InstalledView.tsx:75`、`UpdatesView.tsx:92` 与 `AppDetailModal/Header.tsx:84` 误用 `if (MANUAL_ONLY_NETWORK) return;`（`MANUAL_ONLY_NETWORK` 恒为 `true`）把本地图标读盘预热（`queueAssembledRowIcons` / `restoreOrFetchIconCycle`）完全短路成了死代码。

### 1.2 根因二：后端图标缓存双表割裂（`icon_cache_meta` vs `app_icon_cycles`）、`cache_file` 悬空与 7 天 TTL 硬失效无离线兜底
- **现状（`src-tauri/src/commands/icons.rs`、`icons_cycle_probe.rs`、`icons_cycle_commands.rs`、`github/http.rs`）**：
  1. **落盘已是统一内容寻址，读取却人为割裂**：磁盘 `icons/` 目录下所有图标均以 `sha256(url_trimmed)[0:16].{real_ext}` 命名，但 `load_split_cached_bytes`（`icons_cycle_probe.rs:153-198`）将收录应用（查 `icon_cache_meta`）与非收录应用（查 `app_icon_cycles.cache_file`）硬性切分。
  2. **`cache_file` 为空导致已落盘图标查表 Miss**：流式补探 `save_and_emit`（`catalog_search.rs:95`）、卡片回填 `backfill_uncataloged_card` 与详情落库 `persist_github_detail`（`catalog_detail.rs:872`）仅向 `app_icon_cycles` 写入 `selected_url`，未填 `cache_file`。当 `resolve_confirmed_icon_from_db`（`github/http.rs:385-417`）读取时，见 `cache_file` 为空且未回退检查磁盘上的 `sha256(selected_url)[0:16].{ext}` 文件：
     - 对 `level == 1..=3` 直接返回远端 `https://...` URL（迫使前端走外网）；
     - 对 `level == 4`（应用详情从 README 提取的 Logo）直接返回 `None`，导致详情页已探出并缓存的 L4 图标在趋势榜和搜索列表彻底消失！
  3. **7 天 TTL 过期后先断缓存去拉外网，失败即丢图**：`load_split_cached_bytes`、`read_level_cache_file`、`restore_existing_cycle`、`restore_cataloged_default` 在文件超过 7 天（`ICON_TTL_SECS`）时直接视同无缓存去请求外网；一旦网络波动下载失败，直接返回 `Err` 或空 `url: ""`，把磁盘上完好可用的旧图标文件丢弃不用。

### 1.3 根因三：趋势榜富卡将含本地确认图标（`data:`）的卡片从 `trendEnrichCache`（L1）与 `trend_board_cache`（L2）中整张剔除
- **现状（`src/services/trends/enrich.ts` & `src/services/trends/cache.ts`）**：
  - 当后端 `enrich_trend_repos` 命中本地磁盘确认图标时，`resolve_confirmed_icon_from_db` 将 `s.icon` 设为 `data:image/...;base64,...`。
  - 前端 `enrichTrendReposCore`（`enrich.ts:503`）执行 `if (typeof s.icon === 'string' && s.icon.startsWith('data:')) return;`，**直接跳过了 `putTrendEnrichCache`**！
  - 同时 `putTrendEnrichMemory`（`enrich.ts:320`）与 `saveDbTrendCache`（`cache.ts:316`）在遇到 `isDataIcon(summary.icon)` 时执行 `continue`，**将整张 `AppSummary` 富卡从内存缓存和 SQLite `trend_board_cache` 中直接丢弃**（尽管 `putTrendEnrichCache` 在 L250 本已实现了将 `data:` 剥离为 `icon: ''` 后保存富卡其余字段的逻辑）。
  - **后果**：恰恰是那些已经在本地磁盘缓存好图标（且已从 `app_details_cache` 关联到平台）的富卡，永远无法进入 `trendEnrichCache` 与 `trend_board_cache`；下次切榜或网络波动重进时，这些卡片全部丢失富卡缓存并重新发起网络请求，网络抖动即退化为无图标裸行！

### 1.4 根因四：趋势榜 `enrich_trend_repos` 与在线搜索 `fetch_online_repo` 每次直连网络，未优先读取本地 `app_details_cache` / `api_etag_cache`
- **现状（`src-tauri/src/commands/catalog_search.rs` & `src-tauri/src/github/search.rs`）**：
  1. `enrich_trend_repos`（`catalog_search.rs:705`）即便在 `force_refresh == false` 且本地 SQLite `app_details_cache` 或 `api_etag_cache` 已有该仓库完整元数据时，仍对全部仓库无条件发起 `fetch_online_repo` 网络请求。
  2. `CatalogService::fetch_online_repo`（`search.rs:253`）每次新建 `reqwest::Client`（未复用共享连接池），且发裸 `GET /repos/{owner}/{repo}`（**未走 `get_with_etag` 条件请求、无 304 复用、无传输重试、不写 `api_etag_cache`**）。一旦网络波动超时或失败，直接返回 `None`，完全不回退读取本地 `app_details_cache` 或 `api_etag_cache`。
  3. `backfill_uncataloged_card`（`catalog_search.rs:208`）仅在 60 分钟 TTL 内从 `app_details_cache` 回填 `platforms` 单一字段，忽略了 `latest_version`、非占位 `description`/`description_en`、`license`、`homepage` 与 `icon`，且超过 60 分钟即丢弃已推导的平台列表。
  4. `TrendsView` 的二级缓存 `getDbTrendCache`（`src/services/trends/cache.ts`）与 `boards.ts` 在 L2 超过 TTL（1h/12h）且网络抓取失败时直接报错显示断网空面板，未回退展示本地 SQLite 中尚存的过期 L2 富信封；且 `prune_expired_trend_board_cache`（`db/cache.rs:333`）在启动时将刚过 1h/12h 的榜单缓存直接 `DELETE` 物理删除，剥夺了弱网/离线兜底数据源。

### 1.5 根因五：点击应用详情拿到更新数据后，前端 `maybePersistRichcardHeal` 用旧引用反向覆盖新缓存，且未写透 `searchListCache` 与未挂载榜单
- **现状（`src/app/hooks/useDetailCacheSync.ts`、`src/views/TrendsView/useTrendEnrichment.ts`、`src/services/trends/board.ts`、`src/services/search/searchListCache.ts`）**：
  1. **致命竞态覆盖**：当点击卡片打开详情拿到最新数据后，`useDetailCacheSync.ts:392` 调用 `upsertTrendEnrichRichcard(detail)` 将新数据写入 `trendEnrichCache`，随后派发 `DETAIL_RICHCARD_HEAL_EVENT`。`useTrendEnrichment.ts:411-415` 收到事件后先调异步 `setEnrichedApps(...)`，紧接着在下一行将**尚未更新的旧 `enrichedAppsRef.current`** 传给 `maybePersistRichcardHeal(enrichedAppsRef.current, ...)`；后者（`board.ts:1069-1099`）从旧 `latest` 中取出旧卡片调 `putTrendEnrichMemory(toHydrate)`，**把刚刚写入 `trendEnrichCache` 的详情最新数据反向覆盖回旧值**并写入 SQLite `trend_board_cache`！
  2. **平台与图标治愈未写透 L2**：`useTrendEnrichment.ts:401-410` 的 `onPlatformsHeal` 与 L425-429 的 `subscribeIconWrites` 仅更新 React 内存态 `setEnrichedApps`，**未调用 `putBoardEnrichMemory` + `maybeScheduleBoardPersist` 刷新 SQLite `trend_board_cache`**；且当 `TrendsView` 未挂载（例如从首页、搜索页、收藏页或最近浏览点击详情）时，详情更新对 `trend_board_cache` 完全不写透。
  3. **`searchListCache` 未写透**：`searchListCache.ts` 仅有 `patchSearchListCacheIcon`（只改图标），点击在线搜索结果进入详情拿到最新 `stars`、`forks`、`latest_version`、`platforms`、`description`、`license` 后，`searchListCache` 中的缓存行仍保留旧值（如 `latest_version: "latest"`、`platforms: []`）。

### 1.6 根因六：后端详情更新在 304 分支丢弃最新 `repo_info`、未持久化覆盖 `CatalogService` 重启基线、且未登录时跳过免鉴权 L2 图标探测
- **现状（`src-tauri/src/github/detail_fetch.rs`、`catalog_detail.rs`、`catalog_service.rs`、`db/icon_cycle.rs`）**：
  1. **304 Release 丢弃最新 Repo 统计**：`fetch_app_detail`（`detail_fetch.rs:555-585`）并发请求 `release_url` 与 `repo_url`；当 `release_url` 返回 `304 Not Modified` 时，`reuse_304_cached` 提前返回旧 `cached_detail`，**完全丢弃了刚刚并发拿到的最新 `repo_info`（最新 Star 数、Fork 数、简介、协议、主页）**，且未调用 `update_catalog_item_stats`。
  2. **`CatalogService` 仅内存更新 3 个字段且重启丢失**：`update_catalog_item_stats`（`catalog_service.rs:254`）仅更新 `self.items`（不更新本地收录 `self.collected`），仅更新 `stars`/`forks`/`default_version`（不更新 `platforms`/`license`/`homepage`/`description`/`icon`），且客户端启动时 `CatalogService` 从不将 SQLite `app_details_cache` 中已缓存的最新详情叠加到内存目录上，导致重启后首页/分类/最新入库全部退回静态 `catalog.json` 旧数据。
  3. **未登录时详情页清空已有图标 & `merge_detail_icon` 未清理旧 `cache_file`**：
     - `probe_repo_icon`（`detail_fetch.rs:298`）在 `!has_token` 时直接返回 `None`，连免鉴权的 L2 SimpleIcons（`cdn.simpleicons.org`）都一并跳过；若 README 无首部图，未收录应用详情会产出 `icon: ""` 并覆盖 `app_details_cache`。
     - `merge_detail_icon`（`db/icon_cycle.rs:506`）在未 pinned 行升级选中图标（如从 L2 升级为 L3/L4）时未清空或同步更新 `cycle.cache_file`，导致 `cycle.selected_url` 已是新 URL 但 `cycle.cache_file` 仍指向旧级别图片文件。

---

## 2. 目标架构与重新设计方案

### 2.1 后端统一图标磁盘缓存与 SWR 弱网保底（Issue 01）
1. **统一内容寻址磁盘缓存读取（打破收录/未收录读盘壁垒）**：
   - 在 `src-tauri/src/commands/icons_cycle_probe.rs` 中提供统一读盘入口 `read_cached_icon_bytes_any(icons_dir, db_opt, url, cycle_opt) -> Option<CachedIconHit>`（含 `bytes`、`filename`、`is_fresh`）：
     1. 优先检查 `cycle_opt` 中已绑定的 `cache_file`（当 `selected_url == url`）；
     2. 无论收录或未收录、无论 `cache_file` 是否为空，统一按 `hash_icon_candidate_filenames(url)`（`sha256(url)[0:16].{ext}`）扫描 `icons/` 目录读取合法图片文件（`read_valid_image_file`）；
     3. 命中磁盘文件但 `cycle.cache_file` 为空时，自动关联回填 `cycle.cache_file`，实现自愈。
2. **磁盘图标 Stale-While-Revalidate (SWR) 与弱网永不丢图**：
   - 在 `get_or_fetch_icon`、`restore_existing_cycle`、`restore_cataloged_default` 中：
     - 只要磁盘上存在合法图片文件（无论是否在 7 天 TTL 内），**若网络拉取失败或超时，100% 回退返回磁盘已有图片字节转成的 `data:` URI**，绝不因 7 天到期 + 网络波动而返回 `Err` 或空串 `""`；
     - 在 `restore_existing_cycle` 与 `restore_cataloged_default` 中，若磁盘文件存在但已过 7 天 TTL，先尝试更新（或后台异步刷新），失败时原样返回磁盘旧图 `data:` URI。
3. **`resolve_confirmed_icon_from_db` 全层级磁盘自愈（含 L4 与收录默认图）**：
   - 在 `src-tauri/src/github/http.rs::resolve_confirmed_icon_from_db` 中：
     - 先查 `app_icon_cycles.cache_file`；若为空或文件缺失，立即按 `hash_icon_candidate_filenames(&cycle.selected_url)` 在 `icons/` 目录查找对应哈希文件，命中即返回 `data:` URI（并涵盖 `level == 4` README Logo！）；
     - 若磁盘尚无文件但 `cycle.selected_url` 非空且为合法 `http(s)://`，对 `level 1..=4`（含 L4）统一回退返回 `Some(selected_url)`，修复详情页探出的 L4 图标在列表页被丢弃为 `None` 的问题。
   - 在 `get_confirmed_icons_batch`（`src-tauri/src/commands/catalog_detail.rs`）中：若某 ID 为收录应用且尚无 `app_icon_cycles` 行，顺手检查其 `catalog_item.icon` 在 `icons/` 下是否已有缓存文件，有则返回 `data:` URI，实现全站卡片单次 IPC 批量读盘。

### 2.2 前端 `AppIcon` 与 `iconStore` 本地缓存优先渲染管线（Issue 02）
1. **`iconDataCache` 落定扇出通知与 `admitMemoryOnlyHit` 双写对齐（`src/services/iconStore.ts`）**：
   - 当 `startIconFetch`（`get_or_fetch_icon`）完成并将 `dataUri` 写入 `iconDataCache`（按 `url` 与全部 `aliases` ID 键）时，触发读侧通知（扩展 `subscribeIconWrites` 或新增 `subscribeIconDataReady`），驱动所有挂载中的 `<AppIcon>` 立即从远端 URL 切换为本地 `data:` URI。
   - 当 `admitIconHit` 收到 `data:` URI（`admitMemoryOnlyHit`）时，除写入 `iconById` 外同步写入 `iconDataCache`，确保 `getCachedIconDataUri(appIdNorm)` 与 `getBufferedIcon(appIdNorm)` 100% 同源命中。
   - 将有界缓存容量 `ICON_STORE_MAX_ENTRIES` 从 `200` 提升至 `600`（覆盖全量精选目录 + 趋势多榜同会话浏览，避免滑屏中途将已解码的 `data:` URI 挤出内存）。
2. **`AppIcon` 防网络抖动锁死与按需读盘自愈（`src/components/AppIcon.tsx`）**：
   - **错误态随 `displaySrc` 重置**：将 `useEffect(() => { setHasError(false); }, [activeIcon])` 升级为同时依赖 `[activeIcon, displaySrc]`。即便 `<img src="https://...">` 因网络波动触发了 `onError`，只要本地缓存 `get_or_fetch_icon` 返回 `data:` URI 使 `displaySrc` 更新，`hasError` 立即重置为 `false` 并渲染出图标。
   - **组件级按需本地读盘兜底**：当 `<AppIcon>` 挂载或 `activeIcon` 为 `http(s)://` 且 `getCachedIconDataUri` 未命中时，在 `useEffect` 中自动调用 `requestIconLocalCache(appIdNorm, activeIcon)` 入队 `queueIconFetches`（微任务合并 + 单飞去重；非 Tauri 单测环境保持零 IPC 副作用），彻底解除列表第 30 项之后无法读本地图标缓存的限制。
   - **`onError` 优先走后端缓存/兜底通道**：当 `displaySrc` 为 `http(s)://`（非 `data:`）且触发 `<img onError>` 时，除置 `hasError = true` 暂显首字母徽章外，触发一次 `retryIconFromBackend(appIdNorm, activeIcon)`（清退避并经 Rust `get_or_fetch_icon` 读本地盘或走匿名 L2 兜底），成功后自动恢复显示。
3. **修复退避僵尸占坑与解除资产区本地图标读盘误封锁**：
   - 在 `iconStore.ts::isIconPersistedOrQueued`（或 `queueAssembledRowIcons` 选批过滤）中，将正处于退避期（`backoffUntil > Date.now()`）的 URL 跳过不占 `ASSEMBLED_ROW_ICON_QUEUE_CAP` 名额，让后续未入队的卡片正常入队读盘。
   - 在 `FavoritesView.tsx`、`InstalledView.tsx`、`UpdatesView.tsx` 与 `AppDetailModal/Header.tsx` 中移除阻塞本地图标缓存读取的 `if (MANUAL_ONLY_NETWORK) return;` 门禁。

### 2.3 趋势榜富卡 `data:` 图标持久化修复与 L2 离线/弱网兜底（Issue 03）
1. **保留含确认图标（`data:`）的富卡进入 `trendEnrichCache` 与 `trend_board_cache`**：
   - 在 `src/services/trends/enrich.ts::enrichTrendReposCore`、`putTrendEnrichMemory` 与 `src/services/trends/cache.ts::saveDbTrendCache` 中：
     - 当 `summary.icon` 为 `data:` 时，先经 `admitIconHit({ id: key, icon: summary.icon, via: 'm2' })` 存入 `iconStore` 内存（M1 + `iconDataCache`），随后将持久化副本中的 `icon` 转为已缓存的远端 URL 或 `''`（`const persistIcon = isDataIcon(summary.icon) ? '' : summary.icon`），**正常将富卡其余全部字段（`name`、`description`、`stars`、`forks`、`license`、`latest_version`、`platforms`、`category`、`homepage`）写入 `trendEnrichCache`（L1）与 `trend_board_cache`（L2）**，绝不再因 `isDataIcon` 而 `return`/`continue` 丢弃整张富卡！
   - 将 `collectEmptyIconKeys`（`src/services/trends/board.ts`）的默认上限从 `30` 放宽至 `200`（`getConfirmedIconsBatch` 为纯本地单次 IPC 批量读，零网络开销）。
2. **趋势榜 L2 缓存弱网/离线 Stale 兜底与 7 天保留窗口**：
   - 在 `src/services/trends/cache.ts::getDbTrendCache` 中新增可选参数 `opts?: { allowStale?: boolean }`：当 `allowStale === true` 时忽略 TTL 抖动上限，读取本地 SQLite `trend_board_cache` 中的旧信封并 hydrate 富卡与确认集。
   - 在 `src/services/trends/boards.ts::fetchBoardWithL2` 与 `fetchDoforceShared` 中：当网络请求失败（`result.status === 'error'` 或 `fetchDoforceWithRetry` 抛错）时，自动调用 `getDbTrendCache(key, board, { allowStale: true })` 回退展示本地已缓存的榜单与富卡（标记 `stale: true`），避免网络波动时整页白屏报错。
   - 在 `src-tauri/src/db/cache.rs::prune_expired_trend_board_cache` 中，将物理删除阈值从 `1h / 12h` 延长至 **7 天（`7 * 86400` 秒）**，保留过期行供弱网/离线 Stale 兜底使用。

### 2.4 后端富卡元数据本地缓存优先（Cache-First）与 ETag 复用（Issue 04）
1. **`enrich_trend_repos` 优先从本地 `app_details_cache` / `api_etag_cache` 组装富卡（零网络秒回）**：
   - 在 `src-tauri/src/commands/catalog_search.rs::enrich_trend_repos` 中：
     - 当 `!is_force` 时，先在单次 DB 锁内检查目标仓库是否已命中收录库（`state.catalog.get_catalog_item`）、或命中 `app_details_cache`（`db.get_cached_app_detail(&coord.id, None)`，且描述非占位）、或命中 `api_etag_cache` 中的仓库 JSON（`https://api.github.com/repos/{owner}/{repo}`）。
     - 若本地缓存已存在有效元数据，直接结合 `pre_confirmed` 确认图标与缓存 `platforms` 组装 `AppSummary` 返回，**跳过对该仓库的 `fetch_online_repo` 网络请求**！
2. **`fetch_online_repo` 接入共享连接池、`get_with_etag` 条件请求与本地缓存弱网回退**：
   - 在 `src-tauri/src/github/search.rs::fetch_online_repo` 中：
     - 复用 `crate::shared_http_client()`（消除每次新建 Client）；
     - 改用 `CatalogService::get_with_etag` 请求 `https://api.github.com/repos/{owner}/{repo}`，自动携带 `api_etag_cache` 中的 `If-None-Match`（享有限重试 200ms→800ms 与 304 零配额恢复，200 时写入 `api_etag_cache`）；
     - 当网络波动导致请求失败时，自动回退解析 `api_etag_cache` 中的缓存 `payload` 或 `app_details_cache` 中的历史详情，确保弱网下富卡依然能拿到完整简介、星数、协议与平台信息。
3. **`backfill_uncataloged_card` 全字段本地缓存回填**：
   - 在 `src-tauri/src/commands/catalog_search.rs::backfill_uncataloged_card` 中：
     - 读取 `db.get_cached_app_detail(&item.core.id, None)`（不因超过 60 分钟 TTL 而丢弃已推导的平台与版本）；
     - 回填非空 `platforms`、真实 `latest_version`（当当前为 `"latest"` 或空时）、非占位 `description` / `description_en`、真实 `license`（当当前为 `"OpenSource"`/`"unknown"` 时）、`homepage` 以及有效 `icon`（当 `resolve_confirmed_icon_from_db` 未命中但详情缓存有合法远端图标时）。

### 2.5 点击应用详情拿到更新数据后全链路写透本地缓存（Issue 05）
1. **后端详情更新全量写透（304 Repo 统计合并、`CatalogService` 全字段同步与启动注水、图标文件落盘）**：
   - **修复 304 Release 丢弃 Repo 最新统计（`src-tauri/src/github/detail_fetch.rs`）**：当 `release_outcome` 为 `NotModified` 且命中 `reuse_304_cached` 时，仍将并发拿到的最新 `repo_info`（`stars`、`forks`、`license`、`homepage` 及未收录非占位 `description`/`description_en`）合并进 `detail`，并同步更新 `CatalogService` 与 `app_details_cache`。
   - **扩展 `CatalogService::update_catalog_item_from_detail` 与启动注水（`src-tauri/src/github/catalog_service.rs` & `lib.rs`）**：
     - 将 `update_catalog_item_stats` 升级为全字段同步（覆盖 `self.items` 远端目录与 `self.collected` 本地收录库）：同步 `stars`、`forks`、`default_version`（非空非占位）、`platforms`（非空时更新）、`license`（非空且非 `"unknown"`）、`homepage`、`icon`（目录原为空且详情探出合法 `http(s)` 时补齐）；
     - 新增 `CatalogService::hydrate_from_details_cache(&self, db: &Database)`，在客户端启动初始化与 `sync_catalog` 完成后调用，用本地 SQLite `app_details_cache` 中的已缓存详情保鲜内存目录，使详情更新跨重启持久生效。
   - **详情页免鉴权 L2 探测、图标不置空保护与后台落盘（`detail_fetch.rs`、`catalog_detail.rs`、`db/icon_cycle.rs`）**：
     - `probe_repo_icon` 在无 token 时仍执行免鉴权的 `probe_l2_simple`（SimpleIcons CDN），仅跳过需配额的 L3 Trees；
     - `merge_detail_icon` 在 `selected_url` 发生变化时自动重置或匹配磁盘已有的哈希文件名，防止 `cache_file` 错配旧图；
     - `persist_github_detail` 在探测无图时若 `app_icon_cycles` 已有非空 `selected_url`（且 `level != 5`），保留该 `selected_url` 不被空串覆盖；且当详情确认了有效 `http(s)` 图标 URL 但磁盘尚无对应哈希文件时，后台异步下载落盘至 `icons/` 并回填 `app_icon_cycles.cache_file` / `icon_cache_meta`。
2. **前端详情更新全量写透（修复 `maybePersistRichcardHeal` 旧引用覆盖、写透 `searchListCache` 与未挂载榜单）**：
   - **修复 `useTrendEnrichment.ts` 治愈写透竞态**：
     - 在 `onRichcardHeal` 中先计算 `const nextMirror = applyRichcardHealToMirror(enrichedAppsRef.current, payload, repoKeys)`，立即同步更新 `enrichedAppsRef.current = nextMirror` 并传入 `maybePersistRichcardHeal(nextMirror, payload, repoKeys)`，彻底杜绝用旧 `enrichedAppsRef.current` 反向覆盖 `trendEnrichCache` 新数据；
     - 在 `onPlatformsHeal` 与 `subscribeIconWrites` 中同步调用 `putBoardEnrichMemory` + `maybeScheduleBoardPersist`，确保平台治愈和图标更新（含详情轮换 L1–L5）同样持久化写入 `trend_board_cache`；
     - 在 `board.ts::subscribeTrendHealBus` 中放行 `confirmedOther === true` 或含 `platforms` 的治愈事件（即便 `dirtyFields` 为空）。
   - **支持 `TrendsView` 未挂载时的详情写透（`board.ts` & `useDetailCacheSync.ts`）**：
     - 在 `board.ts` 中导出 `persistDetailToBoardCacheIfPresent(detail)`：当用户在首页、搜索页、收藏页或最近浏览点击详情更新数据后，若 `boardPersistRef` 持有已加载榜单且包含该仓库，自动触发 `maybeScheduleBoardPersist` 将最新富卡写透至 SQLite `trend_board_cache`。
   - **新增 `patchSearchListCacheRows` 全字段写透搜索缓存（`src/services/search/searchListCache.ts` & `useDetailCacheSync.ts`）**：
     - 在 `searchListCache.ts` 新增 `patchSearchListCacheRows(patcher: (rows: AppSummary[]) => AppSummary[])`，并在 `useDetailCacheSync.ts::patchDetailMemoryAndLists` 中与四列表同步调用，确保点击搜索结果详情后搜索缓存中的星数、版本、平台、简介、图标等全字段同步刷新。

---

## 3. 实施 Issue 拆分清单

- [`01-backend-unified-icon-disk-cache-and-swr.md`](file:///z:/rust_workplace/z-store/.scratch/icon-and-cache-local-first/issues/01-backend-unified-icon-disk-cache-and-swr.md)：后端统一图标磁盘缓存读取、7 天 TTL 弱网 SWR 保底与 L4/批量确认图标自愈。
- [`02-frontend-appicon-and-iconstore-local-first.md`](file:///z:/rust_workplace/z-store/.scratch/icon-and-cache-local-first/issues/02-frontend-appicon-and-iconstore-local-first.md)：前端 `AppIcon` 与 `iconStore` 本地缓存优先渲染、`iconDataCache` 响应式扇出、错误态自愈与退避死锁修复。
- [`03-trends-data-icon-persistence-and-l2-fallback.md`](file:///z:/rust_workplace/z-store/.scratch/icon-and-cache-local-first/issues/03-trends-data-icon-persistence-and-l2-fallback.md)：趋势榜富卡 `data:` 图标持久化丢失修复与 L2 榜单缓存弱网/离线 Stale 兜底。
- [`04-backend-richcard-cache-first-and-etag-reuse.md`](file:///z:/rust_workplace/z-store/.scratch/icon-and-cache-local-first/issues/04-backend-richcard-cache-first-and-etag-reuse.md)：后端 `enrich_trend_repos` / `fetch_online_repo` / `backfill_uncataloged_card` 本地缓存优先与 ETag 条件请求复用。
- [`05-detail-update-writethrough-all-local-caches.md`](file:///z:/rust_workplace/z-store/.scratch/icon-and-cache-local-first/issues/05-detail-update-writethrough-all-local-caches.md)：点击应用详情更新后前后端全链路刷新本地缓存（304 Repo 合并、目录启动注水、趋势 L2 防反盖写透、搜索缓存全字段写透、详情图标落盘）。
- [`06-docs-adr-and-regression-verification.md`](file:///z:/rust_workplace/z-store/.scratch/icon-and-cache-local-first/issues/06-docs-adr-and-regression-verification.md)：`CONTEXT.md` / ADR 文档同步与前后端全量门禁回归验证。
