# Feature Spec: 单仓富卡独立缓存表与三链路瘦索引水合重构（Unified Repo Card Cache & Slim ID List Indexes）

> 状态：Implemented（见 `docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md`）
> 关联契约：`CONTEXT.md`（D2 零服务器成本与解耦清单同步、D5 双池复用、D6 有限并发、D7 有限重试、D9 趋势与首页、D10 统一图标获取）、ADR-0003（SQLite 持久化与 ETag 缓存）、ADR-0007（开放清单与可配 TTL 缓存）、ADR-0010（规范应用标识）、ADR-0014（趋势榜 L2 与治理）、ADR-0015（统一图标获取与搜索对齐）、ADR-0017（本地自维护 overlay）、ADR-0019（资产面手动缓存与非资产面自动拉取）、ADR-0026（搜索、GitHub Star 与趋势富卡缓存收敛）。

---

## 1. 背景与现状结构瓶颈

在 ADR-0014 与 ADR-0026 落地后，**在线搜索（`SearchResultsView`）**、**趋势榜（`TrendsView`）** 与 **GitHub Star（`FavoritesView/StarredFeed`）** 三条链路虽然接入了 HTTP ETag 条件请求（`api_etag_cache`）与前端内存共享池（`repoEnrichCache.ts`），但底层持久化模型仍将「列表顺序快照」与「单仓富卡实体」混装在同一份 JSON 信封中，存在 **4 处结构性冗余与跨重启断层**：

### 1.1 列表快照表内嵌整份 `AppSummary` 造成跨表重复膨胀与高频读改写放大
- **`trend_board_cache`（`src/services/trends/cache.ts`）**：`payload_json` 存储 `{ v: 1, repos: TrendRepo[], enrich: Record<string, AppSummary>, confirmedOther: string[] }`。同一热门未收录仓库同时出现在 `daily`、`weekly`、`monthly`、`rising`/`healthy`（`doforce`）时，其完整 `AppSummary` 被重复序列化落盘多份；且每当单仓流式图标到达、`get_platforms_lite` 落定、15s settle 超时或详情弹窗治愈字段时，前端都必须触发 `saveBoardCacheMerged` 先读出整张榜单 JSON、在 JS 内存合并后再整包回写 SQLite，并维护复杂的 256KB 四级裁剪阶梯。
- **`starred_feed_cache`（`src/services/starred/starredCache.ts` & `StarredFeed.tsx`）**：`payload_json` 同样内嵌 `{ v: 1, rows: AppSummary[], pages, hasMore, emptyPages, confirmedOther }`，受单行体积制约最多仅能存 60 条且需长文本截断；每次平台回填或图标就绪均触发 800ms 防抖整包重写。
- **前端 `searchListCache.ts`**：分页桶直接持有 `AppSummary[]` 副本，迫使图标（`patchSearchListCacheIcon`）、平台回填（`patchSearchListCacheRows`）与详情同步（`useDetailCacheSync`）三处横切扫描所有分页桶打补丁。

### 1.2 缺乏跨重启共享的单仓轻量富卡 SQLite 表，未收录富卡与已确认 `Other` 重启即失
- `repoEnrichCache.ts`（底层 `trendEnrichCache` / `trendConfirmedOtherCache`）仅驻留前端内存，且拒绝收纳尚未完成平台推导（`platforms = []` 且未确认 `Other`）的富卡壳；
- 客户端重启后：
  - 在搜索页或 Star 列表拉取过的未收录仓库（其单仓数据内嵌在列表 API 数组响应中，未单独写入 `/repos/{o}/{r}` ETag 键，也未点开过重型 `app_details` 弹窗）无法在趋势榜或跨视图直接复用卡片元数据；
  - 已确认无可安装资产（`confirmedOther`）的未收录仓库在 `api_etag_cache` 中没有具平台资产（或 `releases/latest` 为 404 零发布），每次重启后在搜索、趋势、Star 三条链路均需重新发起 `get_platforms_lite` 网络探测。

### 1.3 在线搜索缺少与 `trend_board_cache` / `starred_feed_cache` 同构的 SQLite 二级列表快照表
- 趋势榜与 Star 列表均具备本地 SQLite 二级列表快照以支撑重启后首屏秒开与弱网回退，而在线搜索仅靠前端内存 `searchListCache`（重启即清），重启后重搜近期关键词无法零网络或先水合首绘再后台 ETag `304` 静默校验。

### 1.4 私有仓库单仓富卡的登出隔离缺乏表级精确标记
- 已登录用户同步 `@me:` Star 列表（或配置具备私有仓权限的主机令牌进行搜索/直查）时，GitHub API 返回的仓库 JSON 可能包含 `"private": true`（或 `"visibility": "private"`）。若单仓富卡进入全局按 `id` 共享的 SQLite 表，必须显式持久化 `is_private` 标记，并在 OAuth 登出或凭据失效时连同私有列表快照一并原子清理，防止退出账号后残留私有仓库元数据。

---

## 2. ADR 契约冲突与显式修订声明

按 `docs/agents/domain.md` 规范，本方案严格遵守 `CONTEXT.md` **D1–D10** 核心边界（与 `catalog_apps` / `custom_apps` 物理隔离、`data:` URI 与运行时收录态标注永不落盘、原始 HTTP 响应继续归 `api_etag_cache`、私有数据登出即清、IPC 请求键 `camelCase` / 响应字段 `snake_case`、视图层禁直调 `invoke`），并对以下既有 ADR 条款作显式重开与升级（落地后记入 **ADR-0027**）：

- > _Contradicts ADR-0014 §1/§5/§8（`trend_board_cache` 以 `{ v: 1, repos, enrich, confirmedOther }` 富信封将榜单与单仓 `AppSummary` 混存，并经 `saveBoardCacheMerged` 读改写合并与 256KB 四级文本截断），but worth reopening because_：榜单的职责是记录某数据源下的「有序仓库坐标 + 原始星数/周期涨星数/Fork 数」，单仓富卡元数据与平台推导结果属于仓库自身属性；混存导致多榜单重复存储与单仓状态变更时的整榜重写放大。**修订为**：`trend_board_cache` 瘦身为 `{ v: 2, items: [{ id, stars, starsGained?, forks? }] }` 纯排行索引快照（单条上限收紧至 `64 KiB` + 最多 `30` 条有界保留），单仓富卡与 `confirmed_other` 下沉至独立 `repo_card_cache` 表，榜单快照仅在上游排行抓取成功时写盘一次，单仓图标/平台/详情更新不再重写榜单表。
- > _Contradicts ADR-0015 §4 & ADR-0026 §2.3/§2.4/§2.5（`Repo Enrich Cache` 仅驻前端内存且拒收未确认空平台富卡；搜索列表仅驻前端内存且存 `AppSummary[]`；`starred_feed_cache` 存 `{ v: 1, rows: AppSummary[], ... }` 富信封并防抖重写），but worth reopening because_：当三链路列表快照统一瘦身为有序 `id` 索引后，所有未收录应用（无论处于「平台未知待推导」、「已确认 Other」还是「具真实平台」三态之一）的轻量富卡壳都必须由统一的单仓富卡表持久化承接，才能保证翻页与重启水合不丢卡、不退化为空白占位。**修订为**：
  1. 新增与 `catalog_apps` / `custom_apps` 物理隔离的 SQLite **`repo_card_cache`** 表（搭配前端 M1 内存镜像 `repoEnrichCache.ts`），完整承接未收录应用轻量富卡与平台三态，写入执行「实值不被空/占位覆盖」单调合并，按 `last_accessed_at` 执行 `2000` 行有界 LRU 淘汰，登出清理 `is_private = 1` 行；
  2. `starred_feed_cache` 瘦身为 `{ v: 2, pages: [{ page, ids }], hasMore }` 按页有序 `id` 索引；
  3. 新增同构的 SQLite **`search_list_cache`** 有界快照表，存储 `{ v: 2, ids, hasMore }` 分页有序 `id` 索引（`has_private = 1` 随登出清理）；
  4. 在线搜索、趋势榜与 GitHub Star 在视图加载与列表恢复时，统一经批量水合接口按有序 `id` 从「精选收录库 / 本地库优先 → `repo_card_cache` 兜底 + `app_icon_cycles` 确认图标叠加」回填展示。

---

## 3. 目标架构设计

### 3.1 缓存职责正交分层（四层模型）

| 层级 | SQLite 表 / 内存模块 | 唯一职责 | 键（PK） | 容量与淘汰策略 | 登出隐私策略 |
|---|---|---|---|---|---|
| **原始 HTTP 条件缓存** | `api_etag_cache` | 原始 GitHub REST API 响应 JSON 与 `ETag`，支撑 `If-None-Match` `304` 零配额重验与断网回退 | `endpoint_url` | `3000` 行（`last_checked_at` LRU） | 清理 `/user/` 前缀端点 |
| **单仓轻量富卡表（新增）** | `repo_card_cache` + 前端 M1 `repoEnrichCache` | **未收录应用**的共享轻量富卡数据、平台推导列表与 `confirmed_other` 标记（与 `catalog_apps` / `custom_apps` 物理隔离） | 规范应用标识 `id`（小写 `owner/repo` 或 `forge:...`） | SQLite `2000` 行（`last_accessed_at` LRU）；前端 M1 `600` 条（`12h` 新鲜度窗口） | 原子删除 `is_private = 1` 行并清空前端 M1 私有集合 |
| **趋势榜索引快照（瘦身）** | `trend_board_cache` + 前端 L1 `trendsCache` | 榜单有序排行及上游独有的原始 `stars` / `starsGained` / `forks`（`v: 2`，不含 `AppSummary`） | `board\|lang\|cat` / `doforce\|\|` | 单条 `64 KiB`、`7 天`保留、至多 `30` 行；前端 L1 `200` 条 | 均为公开榜单，无需清理 |
| **Star 列表索引快照（瘦身）** | `starred_feed_cache` + 前端 L1 `searchListCache(ns='starred')` | 查询目标前 3 页（至多 60 个）按页有序 `id` 索引与 `hasMore`（`v: 2`，不含 `AppSummary`） | `@me:<login>` 或 `<username>` | 单条 `64 KiB`、`7 天`保留、至多 `15` 个目标；前端 L1 `50` 页 | 原子删除 `owner_scope` 以 `@me:` 开头的行及前端 L1 私有页 |
| **在线搜索列表索引快照（新增）** | `search_list_cache` + 前端 L1 `searchListCache(ns='search')` | 搜索词分页对应的有序 `id` 索引与 `hasMore`（`v: 2`，不含 `AppSummary`） | `norm_query\|page\|per_page` | 单条 `64 KiB`、`7 天`保留、至多 `100` 页；前端 L1 `50` 页（`5min` 新鲜、`30min` TTL） | 原子删除 `has_private = 1` 行及前端 L1 含私有仓页 |

> **物理隔离铁律**：`catalog_apps`（精选收录库）与 `custom_apps`（待收录草稿与本地库）完全独立于 `repo_card_cache`。目录检索、精选页推荐货架、分类浏览、最新入库永不查询 `repo_card_cache`；任何已命中 `CatalogService`（远端精选或未归档 `collected`/`local_collected`/`submitted` 本地库）的 `id` 不写入 `repo_card_cache`，且在清单同步（`sync_catalog`）、本地收录（`collect_local_app`）及启动时自动执行 `purge_cataloged_repo_cards` 清除已转正/入库条目。

---

### 3.2 `repo_card_cache` 表结构与写入守卫契约

#### 3.2.1 DDL 定义（`src-tauri/src/db/schema.rs`，`CURRENT_USER_VERSION = 6`）
```sql
CREATE TABLE IF NOT EXISTS repo_card_cache (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    description_en TEXT,
    icon TEXT NOT NULL DEFAULT '',
    icon_bg TEXT NOT NULL DEFAULT '',
    stars INTEGER NOT NULL DEFAULT 0,
    forks INTEGER NOT NULL DEFAULT 0,
    license TEXT NOT NULL DEFAULT '',
    latest_version TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'external',
    category_name TEXT NOT NULL DEFAULT '跨平台开源',
    forge TEXT NOT NULL DEFAULT 'github',
    forge_host TEXT NOT NULL DEFAULT 'github.com',
    homepage TEXT,
    platforms_json TEXT NOT NULL DEFAULT '[]',
    confirmed_other INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_repo_card_cache_lru ON repo_card_cache(last_accessed_at ASC);
CREATE INDEX IF NOT EXISTS idx_repo_card_cache_private ON repo_card_cache(is_private) WHERE is_private = 1;
```

#### 3.2.2 四项硬性写入不变量（`src-tauri/src/db/repo_cards.rs`）
1. **禁止存入收录态标注**：表结构物理不含 `is_cataloged`、`source`、`status`、`added_at`、`is_verified` 列；出库投影为 `AppSummary` 时统一置 `is_verified = false`，并由 `CatalogService::stamp_summary`（前端辅以 `selectors` 标注层）按当前实时目录盖章 `is_cataloged: Some(false)`。
2. **禁止存入 `data:` 图标与正文大图**：写库入口对 `icon` 执行清洗——凡以 `data:` 开头（大小写不敏感、忽略首尾空白）或命中 `icons::is_body_image_url` 的地址一律剥空为 `""`，仅允许持久化合法远端 `http(s)://` 图标 URL（或显式空串）。本地磁盘缓存的 `data:` 图标仅在水合读出时经 `resolve_confirmed_icon_from_db` 动态叠加到内存响应。
3. **实值不被空值或占位文案覆盖（Non-destructive Monotonic Merge）**：
   UPSERT 合并旧行 `prev` 与入站值 `inc` 时逐字段守卫：
   - **文本实值守卫**：
     - `name`：`inc.name` 为空或 `"加载中..."` 时保留 `prev.name`；
     - `description` / `description_en`：经 `detail_fetch::is_placeholder_description` 判定为占位文案（`"GitHub 社区开源项目"`、`"开源软件项目"`、`"跨平台开源项目"`、`"暂无简介"`、`"暂无描述"`、`"No description available"`、`"No description"`）或纯空白时归一为空，且当 `prev` 已有非空实值时保留 `prev`；
     - `license`：`""`、`"..."`、`"unknown"`、`"NOASSERTION"` 或非 GitHub 源的 `"OpenSource"` 视为占位归一为 `""`，不覆盖 `prev` 已有的真实 SPDX 协议；
     - `latest_version`：`""`、`"latest"`、`"..."` 视为占位归一为 `""`，不覆盖 `prev` 已有的真实 Release Tag（读出为空时还原为 `"latest"` 以保持 `AppSummary` 契约一致）；
     - `category` / `category_name`：入站为 `""` 或 `"external"` 而 `prev.category` 已具非 `"external"` 具体推断分类（如 `"dev"`）时，保留 `prev` 的分类与 `icon_bg`；
     - `homepage`：空串归一 `None`，`None` 不覆盖 `prev` 已有的非空主页；
     - `icon`：入站为空串（含 `data:` 剥空后）时不覆盖 `prev` 已有的远端 `http(s)` URL；仅当用户在详情页显式切换图标至 L5 首字母徽章时，由 `sync_repo_card_icon(id, "", allow_clear = true)` 显式清空。
   - **平台三态单调升级守卫（`platforms_json` + `confirmed_other`）**：
     - 入站具非空平台（`!inc.platforms.is_empty()`）：写新 `platforms_json`，并强制将 `confirmed_other` 清零为 `0`（具平台覆盖未知与已确认 `Other`）；
     - 入站确认空平台（`inc.platforms.is_empty() && inc.confirmed_other`）：若 `prev.platforms_json` 已非空则**拒绝降级**（保持具平台与 `confirmed_other = 0`），否则置 `confirmed_other = 1`；
     - 入站平台未知（`inc.platforms.is_empty() && !inc.confirmed_other`，例如来自 `/search/repositories` 或 `/user(s)/starred` 的仓库列表项）：完整保留 `prev.platforms_json` 与 `prev.confirmed_other` 原值，绝不冲掉已推导出的平台或已确认 `Other`！
   - **局部平台补丁与完整富卡的区分（`updated_at` 门控）**：
     - 完整仓库元数据写入（搜索、趋势 enrich、Star 列表、详情页）将 `updated_at` 置为当前秒级时间戳 `now`；
     - 仅含平台/版本的轻量补丁（`patch_repo_card_platforms`，来自 `get_platforms_lite`）在目标 `id` 尚无记录时允许预写 `(id, owner, repo, platforms_json, latest_version, confirmed_other)` 但保持 `updated_at = 0`；批量富卡水合仅返回 `updated_at > 0` 的完整卡片（避免无星数/无简介的半成品壳冒充富卡），而后续完整元数据到达时自动继承已预写的平台与版本号。
4. **有界 LRU 淘汰与私有仓库清理**：
   - 容量上限 `REPO_CARD_CACHE_MAX_ROWS = 2000`：写入与批量水合命中时更新 `last_accessed_at = now`；批量写入后若总行数超限（以及每次应用启动时），按 `ORDER BY last_accessed_at DESC, id ASC LIMIT 2000` 裁剪最久未访问行；
   - 私有标记 `is_private`：后端解析 GitHub 仓库 JSON 时提取 `private == true || visibility == Some("private")`；部分补丁（`is_private = None`）保留库内原值；OAuth 登出（`oauth::clear_oauth_session`）与 401 令牌失效清理通道同步执行 `DELETE FROM repo_card_cache WHERE is_private = 1`。

---

### 3.3 三张同构瘦索引快照表契约（`v: 2`）与数据库迁移

#### 3.3.1 新增 `search_list_cache` 表与统一限额治理
在 `src-tauri/src/db/schema.rs` 新增与 `trend_board_cache`、`starred_feed_cache` 同构的表：
```sql
CREATE TABLE IF NOT EXISTS search_list_cache (
    cache_key TEXT PRIMARY KEY,
    norm_query TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL DEFAULT 0,
    has_private INTEGER NOT NULL DEFAULT 0,
    cached_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_list_cache_cached_at ON search_list_cache(cached_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_list_cache_query ON search_list_cache(norm_query);
```
三张列表快照表统一执行有界治理（`src-tauri/src/db/cache.rs`）：
- **字节硬上限**：因不再包含任何 `AppSummary`，三表后端单条上限统一收紧为 `64 KiB`（`64 * 1024` 字节；前端预检上限 `32 KiB`），彻底移除旧版 256KB 多级截断逻辑；
- **保留期与行数上限**：统一保留 `7 天`（供弱网/离线 stale 回退），按 `cached_at DESC` 限制最大行数：
  - `trend_board_cache`：至多 `30` 行（覆盖 6 榜及筛选组合）；
  - `starred_feed_cache`：至多 `15` 个查询目标；
  - `search_list_cache`：至多 `100` 个 `(norm_query, page, per_page)` 分页快照；
- **Schema 迁移（`migrate_v5_to_v6`）**：推进 `CURRENT_USER_VERSION` 至 `6`，迁移中执行 `DELETE FROM trend_board_cache; DELETE FROM starred_feed_cache;`，一次性清理旧版 `v: 1` 肥胖富卡快照并释放磁盘空间。

#### 3.3.2 三表 `payload_json` 瘦索引格式（统一 `v: 2`）
1. **`trend_board_cache`（趋势榜排行/涨星索引）**：
   ```json
   {
     "v": 2,
     "items": [
       { "id": "owner/repo", "stars": 15200, "starsGained": 640, "forks": 1100 }
     ]
   }
   ```
   - 仅保留有序规范 `id` 与榜单上游独有的 `stars`、`starsGained`（可选）、`forks`（可选，供 `doforce` 共享快照派生 `healthyScore = forks + starsGained` 二次排序及未水合裸行展示）；不含 `enrich` 字典与 `confirmedOther` 数组。
2. **`starred_feed_cache`（GitHub Star 分页有序 `id` 索引）**：
   ```json
   {
     "v": 2,
     "pages": [
       { "page": 1, "ids": ["owner/repo-a", "owner/repo-b"] },
       { "page": 2, "ids": ["owner/repo-c"] }
     ],
     "hasMore": true
   }
   ```
   - 至多持久化前 3 页（共至多 60 个规范 `id`），截断时自动置 `hasMore: true`；不含任何卡片字段。
3. **`search_list_cache`（在线搜索分页有序 `id` 索引）**：
   ```json
   {
     "v": 2,
     "ids": ["owner/repo-1", "owner/repo-2"],
     "hasMore": true
   }
   ```
   - `cache_key` 为 `"{norm_query}|{page}|{per_page}"`（`norm_query` 为 trim + 小写 + 连续空白压单空格）。当该页搜索结果含私有仓库时落库 `has_private = 1`，登出时随 `delete_private_search_list_cache()` 清除。

---

### 3.4 全链路写侧落库与读侧按 `id` 批量水合闭环

```text
[GitHub / Forge REST API]
   │  (原始 JSON + ETag 仍归 api_etag_cache)
   ▼
[Rust 命令写侧] search_apps_online / enrich_trend_repos / list_github_starred / get_platforms_lite / get_app_details
   ├──► 已收录 id：投影 CatalogService 精选/本地库元数据（绝不写 repo_card_cache）
   └──► 未收录 id：单事务非破坏性写入 repo_card_cache（含 platforms、confirmed_other、is_private；剥离 data: 与收录章）

[各视图加载 / 缓存恢复读侧]
   trend_board_cache (v2 items) / starred_feed_cache (v2 pages.ids) / search_list_cache (v2 ids)
   │
   ▼  统一水合器 hydrateCardsByIds(orderedIds)
   ├──► 1. 命中当前合并目录（精选收录库 + 本地库） ──► 直接投影权威收录富卡
   ├──► 2. 命中前端 M1 repoEnrichCache 热镜像 ───────► 0ms 同步组装富卡 + iconStore M1 图标 + confirmedOther
   └──► 3. M1 未命中 id 集合 ──► 单次批量 IPC `get_repo_cards_batch(missingIds)`（DB-only，零网络）
                                   └─ 后端单锁读 repo_card_cache + touch last_accessed_at
                                      + 叠加 resolve_confirmed_icon_from_db (M2 data:/URL) + stamp_summary
                                      + 回传 { summary, confirmed_other, is_private, updated_at }
```

#### 3.4.1 后端写侧收敛细则
1. **`search_apps_online`（`commands/catalog_search.rs`）**：
   - 关键词搜索、GitHub 单仓直查与多源 Forge 直查组装出的所有未收录行，统一批量写入 `repo_card_cache`（带 `is_private`）；
   - 回包 `OnlineSearchResult` 新增可选输出 `confirmed_other_ids: Vec<String>` 与 `private_ids: Vec<String>`（空时省略序列化），使前端首帧即获知库内已落定的 `Other` 行与私有行。
2. **`enrich_trend_repos`（`commands/catalog_search.rs`）**：
   - 短锁预读阶段（`!is_force`）：`resolve_local_enrich_hit` 优先查 `CatalogService`，其次查新鲜 `repo_card_cache`（`updated_at > 0` 且在 `12h` 内），未命中再回退 `app_details` / `api_etag_cache`；
   - 远端拉取返回后：单事务批量写入 `api_etag_cache`、`repo_card_cache` 与 `app_icon_cycles`。
3. **`list_github_starred`（`commands/forge.rs` & `github/developer_starred.rs`）**：
   - `parse_starred_payloads` 提取每仓 `is_private`；`cards_from_repo_payloads` 将未收录行批量写入 `repo_card_cache`，并在 `StarredPageResult` 上附带 `confirmed_other_ids` 与 `private_ids`。
4. **`get_platforms_lite` & `get_app_details`（`commands/catalog_detail.rs` & `repositories/detail_repo.rs`）**：
   - `get_platforms_lite` 非强刷时先查 `app_details` TTL 快径与 `repo_card_cache` 平台快径（12h 内已具平台或 `confirmed_other == true` 即零网络直返）；远端或 `304` 决议非 stale 后，对未收录应用同步调用 `patch_repo_card_platforms` 写回推导平台、真实 `tag_name` 或 `confirmed_other = true`（含已知存在仓库在 `releases/latest` 返回确定性 HTTP `404` 零发布的情形；离线/限流/5xx 等 `is_stale = true` 绝不写库）；
   - `DetailRepository::persist_detail_bundle` 在非 stale 详情落库时，对未收录应用同事务更新 `repo_card_cache`；`cached_detail_summary`（收藏/关注未收录回填与最近浏览回退）在 `app_details` 未命中时回退读取 `repo_card_cache`，使用户在任意列表直接收藏未收录应用后重启进入收藏页也能直接展示富卡；
   - 流式补图 `save_and_emit` 与详情图标轮换 `cycle_app_icon`（含 L5 切空）同步更新 `repo_card_cache.icon`。

#### 3.4.2 各视图水合与写盘简化细则
1. **趋势榜（`TrendsView` / `TrendBoardSession`）**：
   - 抓取成功写盘仅调用一次 `saveDbTrendCache(key, board, repos)` 写入 `{ v: 2, items }`，彻底删除 `saveBoardCacheMerged`、`persistBoardCacheFromDetailIfPresent` 以及图标/平台/详情变更时的防抖榜单重写；
   - `syncBoard` 拿到榜单 `repos` 后，对未收录且不在 M1 `repoEnrichCache` 中的 `id` 批量调用 `get_repo_cards_batch` 水合：水合命中的完整富卡（`updated_at` 未超 12h）直接上屏并免除 `enrich_trend_repos` 网络请求，已具平台或 `confirmed_other` 的行免除 `get_platforms_lite` 请求；仅缺失或超期行进入 `enrich_trend_repos`（上限 40）。
2. **在线搜索（`useSearchState` / `searchListCache.ts`）**：
   - 前端 L1 `searchListCache` 瘦身为存 `{ at, ids, hasMore, hasPrivate }`，写入时将行数据同步推入 M1 `repoEnrichCache`；
   - 提交在线搜索（`!forceRefresh`）时：
     - L1 命中：同步从目录 + M1 `repoEnrichCache`（缺失项补调 `get_repo_cards_batch`）水合富卡；`< 5min` 零网络直出，`5–30min` SWR 首绘 + 后台 `searchAppsOnline(force=false)` ETag `304` 静默重验；
     - L1 未命中（如客户端冷启动）：查询 SQLite `get_search_list_cache(key)` 获取 `{ v: 2, ids, hasMore }` 并经 `hydrateCardsByIds` 批量水合；`< 5min` 零网络直出，`≥ 5min` 先上屏首绘（无骨架屏闪白）再后台走 ETag `304` 静默重验；
   - 翻页（`page > 1`）优先读 L1，未命中读 30min 内新鲜 L2 水合，否则请求网络；联网非 stale 结果落定后同时写 L1 与 `save_search_list_cache`。
3. **GitHub Star（`StarredFeed.tsx` / `starredCache.ts`）**：
   - 冷启动或切换查询目标时：优先从 L1 恢复有序 `id` 并水合；未命中则读 `get_starred_feed_cache`（`{ v: 2, pages, hasMore }`），一次性调用 `hydrateCardsByIds` 完成目录 + `repo_card_cache` + 确认图标回填（无需二次再调 `getConfirmedIconsBatch`）；
   - 网络同步第 1 页或续拉翻页成功时，直接将当前前 3 页有序 `id` 写入 `save_starred_feed_cache` 一次，移除对 `[rows, resolvedOtherIds]` 的 800ms 防抖整包重写监听。

---

## 4. IPC 与架构门禁合规说明

- **IPC 命名契约（`AGENTS.md`）**：
  - 新增后端命令统一标注 `#[tauri::command(rename_all = "camelCase")]`：
    - `get_repo_cards_batch(ids: Vec<String>)` → 前端请求 `{ ids }`，返回 `Vec<Option<HydratedRepoCard>>`（字段 `summary`、`confirmed_other`、`is_private`、`updated_at` 均为 `snake_case`）；
    - `get_search_list_cache(cache_key: String)` → 前端请求 `{ cacheKey }`，返回 `Option<SearchListCacheEntry { payload_json, cached_at }>`；
    - `save_search_list_cache(cache_key: String, norm_query: String, payload_json: String, has_private: Option<bool>)` → 前端请求 `{ cacheKey, normQuery, payloadJson, hasPrivate }`；
  - 既有命令 `get_trend_board_cache` / `save_trend_board_cache` / `get_starred_feed_cache` / `save_starred_feed_cache` 签名保持不变；`OnlineSearchResult` 与 `StarredPageResult` 新增可选 `snake_case` 字段 `confirmed_other_ids`、`private_ids`；
  - 全部新增命令同步接入 `src-tauri/src/lib.rs`（`generate_handler!`）、`src/services/api.ts`（`CMD` + `tauriApi`）、`src/services/api/catalog.ts`、`src/demo/tauri-mock.ts`（仅解析 `camelCase` 参数，绝不加 snake fallback）及 `src/services/api/ipcArgsNaming.test.ts`，确保 `cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`noDirectInvoke.test.ts`、`countDisplay.test.ts` 100% 通过。

---

## 5. 实施 Issue 拆分与依赖拓扑

```text
[01 SQLite repo_card_cache 与 search_list_cache 建表、v6 迁移、非破坏合并、LRU 与登出清理]
        │
        ▼
[02 后端三链路写库收口、私有仓识别、批量水合与搜索列表缓存 IPC 及 Demo Mock 对齐]
        │
        ▼
[03 前端共享单仓富卡 M1 镜像升级、按 id 统一批量水合器与分页列表瘦索引底座]
        │
        ├──────────────────────────────────────────────────────┐
        ▼                                                      ▼
[04 趋势榜 v2 瘦排行索引与单仓富卡批量水合重构]      [05 在线搜索 L2 瘦索引与 StarredFeed v2 水合闭环]
        │                                                      │
        └──────────────────────────┬───────────────────────────┘
                                   ▼
             [06 ADR-0027、领域文档同步与全量回归门禁验收]
```

1. [`01-sqlite-repo-card-and-list-index-schema.md`](./issues/01-sqlite-repo-card-and-list-index-schema.md)（`ready-for-agent`，`Blocked by: none`）
2. [`02-backend-pipeline-writes-and-batch-hydration-ipc.md`](./issues/02-backend-pipeline-writes-and-batch-hydration-ipc.md)（`ready-for-agent`，`Blocked by: 01`）
3. [`03-frontend-shared-repo-card-mirror-and-batch-hydrator.md`](./issues/03-frontend-shared-repo-card-mirror-and-batch-hydrator.md)（`ready-for-agent`，`Blocked by: 02`）
4. [`04-trends-slim-rank-index-and-hydration.md`](./issues/04-trends-slim-rank-index-and-hydration.md)（`ready-for-agent`，`Blocked by: 03`）
5. [`05-online-search-and-starred-slim-index-hydration.md`](./issues/05-online-search-and-starred-slim-index-hydration.md)（`ready-for-agent`，`Blocked by: 03, 04`）
6. [`06-docs-adr-0027-and-regression-gates.md`](./issues/06-docs-adr-0027-and-regression-gates.md)（`ready-for-agent`，`Blocked by: 01, 02, 03, 04, 05`）

---

## 6. 整体验收标准

- **物理隔离与写入卫生**：
  - `repo_card_cache` 与 `catalog_apps` / `custom_apps` 完全物理隔离；已收录（含本地库）应用不入 `repo_card_cache`，转正或本地收录后自动清除旧单仓缓存行；
  - `repo_card_cache` 严禁出现 `data:` 图标与收录态标注；空值、占位简介、占位版本（`latest`）、未知空平台写入时绝不覆盖库内已有实值或已确认 `Other`，而真实推导平台到达时自动升级并清除 `confirmed_other`；
  - 超出 `2000` 行时按 `last_accessed_at` 自动 LRU 淘汰；执行 `oauth_logout` 或 OAuth 401 失效时，`repo_card_cache` 中 `is_private = 1` 的记录、`starred_feed_cache` 中 `@me:*` 记录、`search_list_cache` 中 `has_private = 1` 记录以及前端内存中的对应私有缓存全部同步清零；
- **列表瘦身与跨重启批量水合**：
  - `trend_board_cache`、`starred_feed_cache`、`search_list_cache` 的 `payload_json` 均只含 `v: 2` 有序 `id`（及趋势榜原始 `stars`/`starsGained`/`forks` 或分页 `hasMore`），不含任何 `AppSummary` 对象字段；单仓图标、平台、详情变更不再触发整榜/整列表 JSON 重写；
  - 客户端重启后：进入趋势榜、进入收藏页「Star 同步」或重新提交近期搜索词，均通过 `get_repo_cards_batch` 从 `repo_card_cache`（及 `CatalogService` + `app_icon_cycles`）零网络批量回填完整富卡、平台徽标、已确认 `Other` 状态与本地确认图标；已确认 `Other` 的仓库跨重启后不再重复触发 `get_platforms_lite`；
- **全量质量门禁**：
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
  - `cargo test --manifest-path src-tauri/Cargo.toml`
  - `npx tsc --noEmit`
  - `npx vitest run`
  - `npx vite build --config vite.demo.config.ts`
  全部零警告、零错误通过。
