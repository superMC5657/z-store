# ADR-0027：单仓富卡独立缓存表与三链路瘦 id 索引

- 状态：Accepted
- 日期：2026-11-15
- 关联：ADR-0003（SQLite 持久化与 ETag 缓存）、ADR-0007（可配 TTL 缓存）、ADR-0010（规范应用标识）、ADR-0014（趋势榜 L2；本 ADR 修订其 §1、§5、§8 的信封与写盘口径）、ADR-0015（统一图标获取；本 ADR 修订其 §4）、ADR-0017（本地自维护 overlay）、ADR-0019（资产面手动缓存）、ADR-0026（本 ADR 修订其 §2.3–§2.5）
- 落地计划：`.scratch/unified-repo-card-and-index-caches/`
- 实现：`src-tauri/src/db/repo_cards.rs`、`src-tauri/src/db/cache.rs`、`src-tauri/src/db/schema.rs`、`src-tauri/src/oauth/mod.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/commands/catalog_search.rs`、`src-tauri/src/commands/catalog_detail.rs`、`src-tauri/src/commands/forge.rs`、`src-tauri/src/commands/trends_cache.rs`、`src-tauri/src/repositories/detail_repo.rs`、`src-tauri/src/repositories/detail_service.rs`、`src-tauri/src/repositories/card_hydrator.rs`、`src-tauri/src/github/catalog_service.rs`、`src-tauri/src/icons/lanes.rs`、`src-tauri/src/launchpad/feed.rs`、`src/services/repoEnrichCache.ts`、`src/services/trends/enrich.ts`、`src/services/trends/cache.ts`、`src/services/trends/board.ts`、`src/services/search/searchListCache.ts`、`src/services/starred/starredCache.ts`、`src/app/hooks/useSearchState.ts`、`src/views/FavoritesView/useStarredFeed.ts`

## 1. 背景

趋势榜（`trend_board_cache`）与 Star 列表（`starred_feed_cache`）把「列表顺序」与整份 `AppSummary` 混存在同一 JSON 信封里，在线搜索的内存分页桶同样各持一份 `AppSummary[]`：

- 同一仓库出现在多个榜单 / 分页里就被重复序列化；任一图标、平台或详情字段变化都要先读整张榜单、合并、再整包回写，还要维护 256 KB 多级截断；
- 共享富卡池（`repoEnrichCache`）只驻内存，且拒收平台尚未推导的卡片：搜索或 Star 列表里见过的未收录仓库、以及已确认无可安装资产（Other）的仓库，重启即丢，三条链路都要重新探测 `get_platforms_lite`；
- 在线搜索没有 SQLite 列表快照，重启后重搜近期关键词只能联网；
- 共享富卡一旦落盘，私有仓库需要表级标记才能随登出清除。

## 2. 决策

### 2.1 独立的 `repo_card_cache` 表

- `repo_card_cache`（`db/schema.rs`）按规范应用标识 `id` 存未收录应用的轻量富卡：卡片字段、`platforms_json`、`confirmed_other`、`is_private`、`updated_at`、`last_accessed_at`。与 `catalog_apps` / `custom_apps` 物理隔离：目录检索、推荐货架、分类浏览与最新入库永不读它。
- 写入口（`db/repo_cards.rs`）统一执行：
  - 表内无收录态标注列；读出时 `is_verified = false`、收录标注缺席，由 `CatalogService::stamp_summary` 按当前目录盖章；
  - `data:`、README 正文大图与非 `http(s)` 图标剥空；本地确认图标只在读出时经 `resolve_confirmed_icon_from_db` 叠加；
  - 已收录（远端精选或未归档 `collected` / `local_collected` / `submitted` 本地库）的 `id` 跳过写入；`CatalogService` 的启动装载（`initialize_from_db`）、远端清单覆盖（`apply_remote_manifest`，同事务）、本地库收录（`collect_local_app`）与本地库态草稿重存（`save_custom_draft`），以及启动清扫执行 `purge_cataloged_repo_cards`；
  - 非破坏合并：空值与占位（占位简介、`latest` / `...` 版本、`unknown` / `NOASSERTION` 协议、`external` 分类、空主页、空图标、0 星）不覆盖已有实值；
  - 平台三态单调：具体平台 > 已确认 Other > 未知。具体平台到达即清零 `confirmed_other`；空平台（无论是否确认）不降级具体平台；未知空平台保留原平台与确认标记。
- `get_platforms_lite` 的非 stale 决议经 `patch_repo_card_platforms` 写回平台、真实 tag 或确认 Other（已知存在的仓库在 `releases/latest` 返回 404 即零发布，确认 Other）；无行时预写 `updated_at = 0` 的平台壳，批量水合不可见，完整元数据到达时继承平台与版本。离线、限流与 5xx 不写。
- `get_platforms_lite` 非强刷时，详情 TTL 未命中再查本表：12h 内已具平台或已确认 Other 即零网络返回。
- 完整卡片写入点：在线搜索（关键词 / GitHub 直查 / 多源直查，stale 回退不写）、趋势 `enrich_trend_repos`（远端成功与详情 / 载荷本地命中；本表自身命中与失败回退不写，避免伪造新鲜度）、Star 列表（非 stale 页）、详情落库 `persist_detail_bundle`（同事务，平台为空即确认 Other）。流式补图与详情图标轮换同步本表 `icon`（L5 切空显式清空）。
- 容量 2000 行，按 `last_accessed_at` LRU；批量水合命中即刷新访问时间。
- `is_private` 取自仓库 JSON 的 `private` / `visibility == "private"`；部分写入保留原值。会话吊销唯一入口 `oauth::revoke_oauth_session`（手动登出与 401 失效共用）在无 `github.com` 主机令牌兜底时删除 `is_private = 1` 行。
- 收藏 / 关注 / 最近浏览的未收录回填（`cached_detail_summary`）在 `app_details` 无行时回退本表。

### 2.2 三张瘦 id 索引快照表（`v: 2`）

| 表 | `payload_json` | 上限 | 私有清理 |
|---|---|---|---|
| `trend_board_cache` | `{ v: 2, items: [{ id, stars, starsGained?, forks? }] }` | 30 行 | 公开榜单，不清理 |
| `starred_feed_cache` | `{ v: 2, pages: [{ page, ids }], hasMore }`（前 3 页 / 60 个 id） | 15 个目标 | `owner_scope` 以 `@me:` 开头的行 |
| `search_list_cache`（新增） | `{ v: 2, ids, hasMore }`，键 `"{norm_query}\|{page}\|{per_page}"` | 100 页 | `has_private = 1` 的行 |

- 三表单条后端上限 64 KiB、前端预检 32 KiB，7 天保留；`user_version = 6` 迁移一次性清空旧 `v: 1` 富信封。
- 榜单快照只在上游抓榜成功时写一次；Star 快照在同步第 1 页或续拉成功时直接写一次（登出后的 `@me:` 永不写回）；搜索快照在联网非 stale 结果落定时写一次。卡片的图标、平台与详情变化只写共享富卡镜像与 `repo_card_cache`，不再重写任何列表快照。
- `api_etag_cache` 仍是原始 HTTP 响应与 ETag 的唯一存储。

### 2.3 统一批量水合

- `get_repo_cards_batch(ids)`（DB-only、零网络、与入参一一对齐）：收录项投影目录元数据并叠加确认图标，优先于本表；未收录项读本表完整卡片（`updated_at > 0`，刷新访问时间），缺失时回退 `app_details`（`updated_at = 0`）；叠加确认图标并盖收录章。
- 前端 `hydrateCardsByIds(ids, opts)`（`services/repoEnrichCache.ts`）：当前合并目录 → M1 共享池（12h 内三态卡片）→ 单次 `get_repo_cards_batch` 取缺失项；返回有序 `rows`、`byId`、`confirmedOtherIds` 与 `freshCardIds`（`updated_at` 在 12h 内）。`data:` 图标只进 iconStore 缓冲与返回对象，池内永不存放。
- M1 共享池即 `repo_card_cache` 的前端镜像：三态卡片均可入池，写入同样非破坏合并；私有仓库 id 单独记录，登出（`forgetPrivateStarredQueries`）清除私有卡片、`@me:` 分页与含私有仓的搜索分页。
- 趋势榜：`TrendBoardSession` 对池内未命中的榜单仓库批量水合；enrich 决策等本榜水合落定后再判定，只对缺失或超 12h 的仓库请求 `enrich_trend_repos`；已具平台或已确认 Other 的卡片不走 lite。
- 在线搜索：L1 分页桶只存 `{ at, ids, hasMore, hasPrivate }`，卡片在模块级单一卡片表（同 id 一份）；L1 未命中读 L2 并水合：5 分钟内且全部水合即零网络返回，否则先首绘再后台 `searchAppsOnline(forceRefresh = false)` 走 ETag 静默重验；翻页 L1 → 30 分钟内且全部水合的 L2 → 网络。回包的 `confirmed_other_ids` / `private_ids` 记入共享池。
- Star 列表：冷启动或切换目标时按快照页 id 一次水合（无需另调 `get_confirmed_icons_batch`），已确认 Other 直接上报平台落定。

## 3. 取舍

- 列表快照不再携带卡片文本，L2 命中但卡片被 LRU 淘汰时只能展示已水合部分；在线搜索与翻页因此仅在全部水合时短路网络，否则先展示再重验。
- `get_repo_cards_batch` 的 `updated_at` 是完整元数据的写入时刻，平台补丁不推进它：平台快径的新鲜度对完整卡片取 `updated_at`，对平台预写壳取 `last_accessed_at`。
- 趋势榜冷启动的 enrich 决策多等一次本地 IPC（毫秒级），换取不重复请求 `/repos/{o}/{r}`。
