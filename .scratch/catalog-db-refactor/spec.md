# ZStore Catalog & Database 分层重构架构规范 (Spec)

Status: resolved
Target Version: SQLite `PRAGMA user_version = 2` (直接重构表结构：新增 `catalog_apps`、`app_details` 替代 `app_details_cache`)
Scope: `catalog.json` 种子化重构、三表分离存储设计、全站页面/功能 DB 调用链路、四层架构职责解耦

---

## 1. 背景与现存问题诊断

当前架构存在以下核心耦合与状态分裂问题：

1. **`catalog.json` 运行时伪持久化（重启丢失同步状态）**：
   - `CatalogService::new()`（`src-tauri/src/github/catalog_service.rs`）启动时从 `catalog.json` 直接加载进内存 `RwLock<Vec<CatalogItem>>`。
   - `sync_catalog`（`src-tauri/src/commands/catalog_sync.rs`）拉取远端 `z-store-catalog` 后仅更新内存 `RwLock` 并把整坨 JSON 字符串塞进 `api_etag_cache`，**未落入结构化目录数据表**；重启后再次从静态 `catalog.json` 加载，只能靠 `hydrate_from_details_cache` 补丁恢复曾打开过详情的应用字段。
2. **详情表与目录表职责混杂**：
   - `app_details_cache` 以整块 `detail_json` 持久化全量信息且受 500 行 LRU 淘汰约束（虽豁免已安装/收藏/关注），既是详情缓存又被当作目录重启水合源。
   - 详情拉取写入时通过 `CatalogService::update_catalog_item_from_detail` 只改内存，若未落库或缓存淘汰即出现列表与详情不一致。
3. **分层失真与隐式数据库旁路**：
   - `CatalogService` 兼任内存数据库、HTTP 清单客户端、检索/打分引擎、GitHub/Forge 详情抓取、Developer/Starred/Affinity 聚合器。
   - `src-tauri/src/github/detail_fetch.rs` 与 `readme_fetch.rs` 存在直接调用 `crate::github::http::open_db_opt()` 另开 SQLite 连接读写 `api_etag_cache` 的旁路行为，绕过 `AppState.db` 互斥锁边界。
   - `commands/*.rs` 混合了 SQLite 事务拼装、领域规则判断与外部网络调用。

---

## 2. 核心设计决策与不变量 (Invariants)

1. **`catalog.json` 退化为纯初始种子（Seed-Only）**：
   - 仅在数据库首次初始化或 `catalog_apps` 表为空时（`COUNT(*) == 0`），从内置/配置的 `catalog.json` 读取并批量播种写入 `catalog_apps`。
   - 播种完成后，运行时一切目录读取、搜索、首页 Feed、分类、最新入库、扫描匹配、亲和度分析、坐标解析均以 SQLite 数据库为准，不再读取静态 `catalog.json`（仅保留为构建期 schema 单测夹具及离线兜底显式降级源）。
2. **三表分离职责边界**：
   - **`catalog_apps`（目录主表）**：持久化存储远端精选收录库元数据，由 `catalog.json` 初次播种、由 `sync_catalog` 全量权威覆盖更新、由 `get_app_details` 拿到新数据时增量回写保鲜字段。
   - **`custom_apps`（本地自维护 overlay 表）**：保持现有草稿（`draft`）、本地收录（`collected`/`local_collected`）、已提交（`submitted`）与转正归档（`archived=1`）生命周期（ADR-0017）。
   - **`app_details`（应用详情表，重构自 `app_details_cache`）**：专门服务详情页载入与未收录应用富卡恢复，结构化承载 `releases_json`、`readme_markdown`、`readme_variants_json`、`changelog`、`cached_at` 及未收录兜底概要字段。
3. **远端清单权威覆盖策略（`sync_catalog` vs 详情回写）**：
   - **清单同步（`sync_catalog`）**：远端 `catalog.json` 返回新数据时，在单事务（`BEGIN IMMEDIATE`）内**全量权威覆盖 `catalog_apps`**（删除已从远端下架的条目，插入或覆盖远端条目全部字段），随后执行 `custom_apps` 转正归档与 `user_favorites` / `watched_apps` 的 `is_cataloged` 回填。
   - **详情刷新（`get_app_details`）**：非 stale 详情拉取成功后，先写入/更新 `app_details`，若该 `app_id` 存在于 `catalog_apps`，同步回写保鲜字段（`stars`、`forks`、`default_version`（非 `latest` 占位）、`platforms_json`（非空）、`license`（非占位）、`homepage`（非空）、`icon`（仅目录原为空且新值为合法 `http(s)` 时补齐）与 `updated_at`）。
4. **合并视图契约保持兼容**：
   - 仓储/领域投影层统一按 `catalog_apps`（`remote` 优先）+ `custom_apps`（`!archived && status ∈ {collected, local_collected, submitted}` 补位或叠加 `local` 标记）输出 `AppSummary` / `AppDetail`，现有前后端 IPC 契约（camelCase 入参 / snake_case 回包、`source`/`status`/`is_cataloged` 盖章规则）完全兼容。

---

## 3. 数据库全量表架构设计（SQLite `user_version = 2`）

### 3.1 全库数据表域划分（共 20 张表）

| 域分类 | 表名 | 职责定位 | 变更状态 |
|---|---|---|---|
| **核心应用数据域** | `catalog_apps` | 远端精选目录主表（首次由 `catalog.json` 播种；同步清单全量覆盖；详情刷新回写保鲜） | **新增（核心主表）** |
| | `custom_apps` | 本地草稿与自维护收录 overlay 表（`draft`/`collected`/`submitted`/`archived`） | 保留不变 |
| | `app_details` | 应用深度详情表（详情页主载入源：Release 资产、README、多语言变体、Changelog、未收录富卡兜底） | **重构（替代 `app_details_cache`）** |
| **本地资产与更新域** | `installed_apps` | 已安装/纳管本地应用记录 | 保留不变 |
| | `update_results` | 更新中心最近一次手动刷新快照（`has_update` / `changelog` / `checked_at`） | 保留不变 |
| | `update_rules` | 版本控制策略（`skipped_version` / `is_frozen` / `is_hidden`） | 保留不变 |
| **用户偏好与足迹域** | `user_favorites` | 收藏列表与 `is_cataloged` 标记 | 保留不变 |
| | `watched_apps` | 关注订阅列表、通知基线与 `is_cataloged` 标记 | 保留不变 |
| | `view_history` | 最近浏览历史（有界裁剪） | 保留不变 |
| | `search_history` | 搜索历史（有界裁剪） | 保留不变 |
| | `user_stars` | GitHub Star 状态本地镜像 | 保留不变 |
| | `user_repo_signals` | 本地亲和度画像特征信号（`starred`/`forked`/`owned`） | 保留不变 |
| **媒体与网络缓存域** | `api_etag_cache` | HTTP 304 条件请求缓存（Repo / Release / README / Dev Profile / Catalog Manifest，1000 行 LRU） | 保留（表结构不变，职责收敛） |
| | `app_icon_cycles` | 图标 L1~L5 轮换槽位、`selected_url`、`pinned` 与磁盘文件名映射 | 保留不变 |
| | `icon_cache_meta` | 图标磁盘缓存 URL 与过期元数据 | 保留不变 |
| | `asset_cache` | 通用图片磁盘缓存配额元数据 | 保留不变 |
| | `asset_refs` | 通用图片与 `app_id` 引用关系 | 保留不变 |
| | `trend_board_cache` | 趋势榜 L2 落盘快照（7 天软窗口） | 保留不变 |
| **系统与认证配置域** | `user_settings` | 用户设置键值表（含 `detail_cache_ttl_minutes`、`catalog_source_url`、`show_custom` 等） | 保留不变 |
| | `host_tokens` | 多源托管主机 PAT 令牌与速率配额快照 | 保留不变 |

### 3.2 核心新表 DDL 设计

#### (1) `catalog_apps`（目录主表）

```sql
CREATE TABLE IF NOT EXISTS catalog_apps (
    id                  TEXT PRIMARY KEY,              -- canonical 小写 id（owner/repo 或 forge:...）
    name                TEXT NOT NULL,
    owner               TEXT NOT NULL,
    repo                TEXT NOT NULL,
    icon                TEXT NOT NULL DEFAULT '',
    icon_bg             TEXT NOT NULL DEFAULT '',
    description         TEXT NOT NULL DEFAULT '',
    description_en      TEXT,
    category            TEXT NOT NULL,
    category_name       TEXT NOT NULL,
    aliases_json        TEXT NOT NULL DEFAULT '[]',    -- JSON array<string>
    default_version     TEXT NOT NULL DEFAULT '',
    added_at            TEXT,                          -- ISO YYYY-MM-DD
    license             TEXT NOT NULL DEFAULT '',
    stars               INTEGER NOT NULL DEFAULT 0,
    forks               INTEGER NOT NULL DEFAULT 0,
    is_verified         INTEGER NOT NULL DEFAULT 0,    -- 0/1
    homepage            TEXT,
    platforms_json      TEXT NOT NULL DEFAULT '[]',    -- JSON array<string>
    identifiers_json    TEXT NOT NULL DEFAULT '{}',    -- JSON map<platform, array<string>>
    install_dirs_json   TEXT NOT NULL DEFAULT '[]',    -- JSON array<string>
    search_subdirs_json TEXT NOT NULL DEFAULT '[]',    -- JSON array<string>
    publishers_json     TEXT NOT NULL DEFAULT '[]',    -- JSON array<string>
    forge               TEXT NOT NULL DEFAULT 'github',
    forge_host          TEXT NOT NULL DEFAULT 'github.com',
    manifest_synced_at  INTEGER NOT NULL DEFAULT 0,    -- 最近一次由种子/清单写入时间
    detail_synced_at    INTEGER NOT NULL DEFAULT 0,    -- 最近一次由详情刷新回写时间
    updated_at          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_catalog_apps_category ON catalog_apps(category);
CREATE INDEX IF NOT EXISTS idx_catalog_apps_stars ON catalog_apps(stars DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_apps_added_at ON catalog_apps(added_at DESC, stars DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_apps_owner_repo ON catalog_apps(owner, repo);
```

#### (2) `app_details`（应用详情表，替代 `app_details_cache`）

```sql
CREATE TABLE IF NOT EXISTS app_details (
    app_id               TEXT PRIMARY KEY,             -- canonical id（收录与未收录共用）
    name                 TEXT NOT NULL,
    owner                TEXT NOT NULL,
    repo                 TEXT NOT NULL,
    description          TEXT NOT NULL DEFAULT '',
    description_en       TEXT,
    icon                 TEXT NOT NULL DEFAULT '',
    icon_bg              TEXT NOT NULL DEFAULT '',
    stars                INTEGER NOT NULL DEFAULT 0,
    forks                INTEGER NOT NULL DEFAULT 0,
    license              TEXT NOT NULL DEFAULT '',
    latest_version       TEXT NOT NULL DEFAULT '',
    category             TEXT NOT NULL DEFAULT 'external',
    category_name        TEXT NOT NULL DEFAULT '跨平台开源',
    forge                TEXT NOT NULL DEFAULT 'github',
    forge_host           TEXT NOT NULL DEFAULT 'github.com',
    homepage             TEXT,
    platforms_json       TEXT NOT NULL DEFAULT '[]',   -- JSON array<string>
    changelog            TEXT NOT NULL DEFAULT '',
    readme_markdown      TEXT NOT NULL DEFAULT '',
    readme_variants_json TEXT,                         -- nullable JSON array<ReadmeVariant>
    releases_json        TEXT NOT NULL DEFAULT '[]',   -- JSON array<ReleaseAsset>
    cached_at            INTEGER NOT NULL DEFAULT 0    -- 上次网络验证时间（供 TTL 判定）
);

CREATE INDEX IF NOT EXISTS idx_app_details_cached_at ON app_details(cached_at DESC);
```

> **说明**：`app_details` 保留基础元信息列（`name`、`owner`、`repo`、`stars`、`platforms_json` 等）的原因是：**未收录应用**（在线搜索、趋势榜、未收录收藏/关注、最近浏览）不在 `catalog_apps` / `custom_apps` 中，必须能仅凭 `app_details` 完成 `get_cached_app_details_batch` 与离线详情渲染；而**已收录应用**在详情页载入时，由领域/仓储层读取 `app_details` 的重型字段（`releases`、`readme_markdown`、`readme_variants`、`changelog`）并叠加 `catalog_apps`/`custom_apps` 的精校元数据与收录徽标。

### 3.3 `v1 → v2` 幂等迁移方案

在 `src-tauri/src/db/schema.rs::run_migrations` 中实现 `migrate_v1_to_v2`：
1. 创建 `catalog_apps` 与 `app_details` 表及索引。
2. 若旧表 `app_details_cache` 存在：
   - 逐行读取 `(app_id, detail_json, cached_at)`，解析 `AppDetail` 后通过 `INSERT OR IGNORE INTO app_details ...` 迁移到新表（解析损坏行跳过记 warn）。
   - 迁移完成后执行 `DROP TABLE IF EXISTS app_details_cache;`（或在备份验证阶段保留后清理，推荐迁移完直接清理避免双写漂移）。
3. 将 `PRAGMA user_version` 推进到 `2`。
4. **启动播种与水合钩子**（`AppState` 初始化阶段执行）：
   - 检查 `catalog_apps` 行数：若为 `0`，读取随包 `catalog.json` 种子，单事务批量插入 `catalog_apps`。
   - 若本次为从 v1 首次迁移且执行了旧缓存迁移，可对 `catalog_apps` 做一次从 `app_details` 的存量回写水合（仅 v1→v2 迁移后首启或按需，日常启动直接信任 `catalog_apps`！）。

---

## 4. 全站页面与功能数据库调用矩阵

以下逐一理清**每个页面 / 核心功能**如何调用数据库能力、读写哪些表、何时触网：

| 页面 / 功能模块 | 前端入口 / Hooks | Backend IPC Commands | 读取的数据表 | 写入的数据表 | 网络触发策略 |
|---|---|---|---|---|---|
| **应用启动初始化** | `useAppSubscriptions` / `lib.rs::setup` | `search_apps('')`、`get_settings`、`get_installed_apps`、`get_favorites`、`get_watched_apps`、`get_update_rules`、`get_cached_updates`、`get_recently_viewed_apps` | `catalog_apps`（若空则从 `catalog.json` 播种）、`custom_apps`、`user_settings`、`installed_apps`、`user_favorites`、`watched_apps`、`update_rules`、`update_results`、`view_history`、`app_details`、`app_icon_cycles` | 首次启动写 `catalog_apps`；清理超限 `trend_board_cache`/`api_etag_cache`/`app_details`/`asset_cache`；校准 `user_favorites.is_cataloged` & `watched_apps.is_cataloged` | 仅后台静默检查配额与登录态亲和度（6h 冷却），**零列表阻断** |
| **发现页 (HomeView)** | `HomeView.tsx` + `useHomeFeed.ts` | `get_home_feed`、`get_recently_viewed_apps`、`clear_view_history` | `catalog_apps` ∪ `custom_apps`（本地库）、`update_rules`（过滤 `is_hidden`）、`user_repo_signals` + `user_stars` + `user_favorites` + `watched_apps`（计算亲和度重排）；最近浏览读 `view_history` + `catalog_apps`/`custom_apps`/`app_details`/`app_icon_cycles` | `clear_view_history` 删 `view_history` | 纯本地 DB 零网络秒开 |
| **最新入库 (LatestView)** | `LatestView.tsx` | `get_latest_catalog_apps` | `catalog_apps` ∪ `custom_apps`（`added_at` 投影）、`update_rules`（过滤 `is_hidden`） | 无 | 纯本地 DB 零网络秒开 |
| **分类中心 (CategoriesView)** | `CategoriesView.tsx` | `get_category_apps` | `catalog_apps` ∪ `custom_apps`（按 `category`/`category_name` 过滤）、`update_rules`（过滤 `is_hidden`） | 无 | 纯本地 DB 零网络秒开 |
| **全局搜索 (本地 + 在线)** | `TitleBar` + `useSearchState.ts` | `search_apps`、`record_search_query`、`get_search_history`、`clear_search_history`、`remove_search_query`、`search_apps_online` | 本地搜：`catalog_apps` ∪ `custom_apps`、`update_rules`、`search_history`；在线搜读 `catalog_apps` ∪ `custom_apps`（盖 `is_cataloged`）、`app_details`（补齐平台/版本/描述）、`app_icon_cycles`（确认图标） | `search_history`；在线搜增量写入 `app_icon_cycles` | 本地搜零网络；在线搜按需调 GitHub/Forge Search API + 流式 `IconFetch` |
| **趋势榜 (TrendsView)** | `TrendsView.tsx` + `useTrendBoard.ts` + `useTrendEnrichment.ts` | `fetch_trends_text`、`get_trend_board_cache`、`save_trend_board_cache`、`enrich_trend_repos`、`get_confirmed_icons_batch` | `trend_board_cache`（L2 榜单快照）、`catalog_apps` ∪ `custom_apps`（命中收录即复用）、`app_details`（未收录富卡缓存）、`api_etag_cache`、`app_icon_cycles` | `trend_board_cache`、`api_etag_cache`、`app_icon_cycles` | 先读 L1/L2，过期再拉趋势文本并后台 `buffered(5)` 批量 enrich + 流式图标 |
| **应用详情页 (AppDetailModal)** | `AppDetailModal/*` + `useDetailCacheSync.ts` | `get_app_details`、`get_readme_variants`、`record_app_view`、`cycle_app_icon`、`restore_or_fetch_icon_cycle`、`fetch_or_cache_asset_url`、`fetch_starred_status`、`star_app`、`unstar_app` | **详情主表 `app_details`**（TTL 内秒开/离线 stale 兜底）、`catalog_apps` ∪ `custom_apps`（精校元数据叠加 & 盖章）、`api_etag_cache`、`app_icon_cycles`、`asset_cache`、`user_stars`、`user_settings`（TTL 挡位） | **`app_details`**（全量详情）、**`catalog_apps`**（若已收录则回写最新 `stars`/`forks`/`default_version`/`platforms`/`license`/`homepage`/`icon`）、`api_etag_cache`、`app_icon_cycles`、`view_history`、`asset_cache`/`asset_refs`、`user_stars` | TTL 内走 DB 零网络；TTL 外/手动刷新走 ETag 条件请求；304 仅 `touch cached_at`；`is_stale=true` 不污染 DB |
| **平台懒回填** | `usePlatformBackfill.ts` | `get_platforms_lite` | `app_details`（TTL 内快径/stale 兜底）、`catalog_apps` ∪ `custom_apps`、`api_etag_cache` | `api_etag_cache`、touch `app_details.cached_at`；**可选同步补齐 `catalog_apps.platforms_json`（当原为空时）** | 仅 TTL miss 时请求单次 `releases/latest` + ETag |
| **收藏与关注 (FavoritesView)** | `FavoritesView.tsx` + `favoritesUncataloged.ts` | `get_favorites`、`get_favorite_entries`、`toggle_favorite`、`get_watched_apps`、`watch_app`、`unwatch_app`、`get_cached_app_details_batch`、`sync_github_starred` | `user_favorites`、`watched_apps`、`catalog_apps` ∪ `custom_apps`、`app_details`（未收录批量富卡 DB-only 回填）、`app_icon_cycles`、`api_etag_cache` | `user_favorites`、`watched_apps`、`user_stars`、`user_repo_signals`、`api_etag_cache` | 收藏/关注展示**零网络**（凭 `is_cataloged` 走目录或 `app_details`）；仅点击“同步 GitHub Star”时走网络 |
| **待收录与本地库 (PendingView)** | `PendingView.tsx` + `useCustomApps.ts` | `list_custom_apps`、`save_custom_app`、`delete_custom_app`、`collect_local_app`、`revert_collected_to_draft`、`mark_submitted`、`withdraw_submitted`、`get_custom_app_pr_*` | `custom_apps`、`catalog_apps`（转正判定对比）、`app_icon_cycles` | `custom_apps`、`app_icon_cycles`、`app_details.icon`（仅同步自定义图标）、`user_favorites.is_cataloged`、`watched_apps.is_cataloged` | 零网络（预填 Issue 仅生成 URL 由浏览器打开） |
| **已安装与系统扫描 (InstalledView)** | `InstalledView.tsx` + `AppImportModal.tsx` | `get_installed_apps`、`scan_and_match_local_apps`、`import_matched_apps`、`launch_app`、`install_app`、`uninstall_app`、`unmanage_app` | `installed_apps`、`catalog_apps` ∪ `custom_apps`（图标/标识符/扫描指纹匹配）、`app_details`（未收录应用安装解析/图标回退）、`user_settings`（下载/便携目录） | `installed_apps`、`update_results`（安装/卸载/导入后失效清理） | 本地管理与扫描零网络；仅“安装/升级”调详情链路拉资产 |
| **更新中心 (UpdatesView)** | `UpdatesView.tsx` + `useUpdateActions.ts` | `get_cached_updates`、`check_for_updates`、`get_update_rules`、`set_app_*`、`remove_update_rule` | `update_results`、`installed_apps`、`update_rules`、`watched_apps`、`app_details`、`catalog_apps` ∪ `custom_apps`、`api_etag_cache` | `update_results`、`api_etag_cache`、`watched_apps`（通知基线）、`update_rules`、`app_details.cached_at`（304 touch） | 默认 **DB-only** 读 `update_results`；仅点击“检查更新” (`force=true`) 时走 ETag 条件请求 |
| **设置与清单同步 (SettingsView)** | `SettingsView/*` + `DataBackupRow` + `AffinityPrivacyRow` | `get_settings`、`save_setting`、`sync_catalog`、`get_affinity_profile_summary`、`reset_affinity_profile`、`import_user_data`、`oauth_*` | `user_settings`、`api_etag_cache`、`catalog_apps`、`custom_apps`、`user_repo_signals`、`user_stars`、`user_favorites`、`watched_apps`、`host_tokens` | `user_settings`、**`catalog_apps`（`sync_catalog` 权威全量覆盖）**、`custom_apps`（转正归档 `archived=1`）、`user_favorites`/`watched_apps`（`is_cataloged` 回填）、`api_etag_cache`、`user_repo_signals`/`user_stars` | 仅手动点击“同步清单”、OAuth 登录、测速、同步画像时触网 |

---

## 5. 彻底分层的后端与前端架构

### 5.1 后端四层严格依赖方向（自上而下，禁止逆向与跨层旁路）

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 4: Interface / IPC Commands (src-tauri/src/commands/*)            │
│ - 职责：入参归一化 (require_app_id)、权限/参数校验、调用 Service、      │
│         发射 Tauri Event、记录 WideEvent 日志                           │
│ - 禁令：禁止手写 SQL、禁止直接拼装多表业务事务、禁止裸调 reqwest        │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 3: Domain / Application Services (src-tauri/src/services/*)       │
│ - CatalogDomainService: 合并目录读取、搜索打分、HomeFeed/Latest/Category │
│   编排、Manifest 远端同步协调、图标/坐标投影盖章                        │
│ - DetailService: 详情 TTL 判定 → ETag/Forge 抓取 → 协调落库与回写       │
│ - UpdateService / InstallerService / ScannerService / AffinityService   │
│ - 禁令：禁止直接持有或打开 `open_db_opt()` 新连接；DB 操作一律走 Repository│
└───────────────┬─────────────────────────────────────────┬───────────────┘
                ▼                                         ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────┐
│ Layer 2: Repository (src-tauri/src/   │ │ External Providers            │
│          repositories/*)              │ │ (github/, forge/, icons/,     │
│ - CatalogRepository:                  │ │  mirror/, proxy/)             │
│   * seed_catalog_if_empty()           │ │ - 纯 HTTP/协议适配与数据解析  │
│   * replace_remote_catalog_sync()     │ │ - 接收 cache_input 参数，     │
│   * list_merged_catalog_items()       │ │   返回待写 cache_mutations，  │
│   * apply_detail_writeback()          │ │   完全无 DB 副作用            │
│ - DetailRepository:                   │ └───────────────────────────────┘
│   * get_detail() / save_detail_atomic()│
│   * get_batch_summaries()             │
│   * touch_detail() / prune()          │
│ - UserAssetRepository / CacheRepository│
└───────────────┬───────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Persistence / DAO (src-tauri/src/db/*)                         │
│ - `Database` 连接管理、`PRAGMA user_version` 迁移链 (v1→v2)             │
│ - 单表/高内聚表族 CRUD：`db/catalog.rs`, `db/details.rs`, `db/etag.rs`, │
│   `db/asset_cache.rs`, `db/custom_apps.rs`, `db/apps.rs`, `db/history.rs`│
│ - 事务原语：`with_immediate_transaction()`                              │
│ - 禁令：零业务逻辑、零网络请求、零全局状态读取                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 关键分层治理动作

1. **彻底消除 `open_db_opt()` 隐藏旁路**：
   - `github/detail_fetch.rs` 和 `github/readme_fetch.rs` 不再自己打开 `z_store.db` 连接读写 `api_etag_cache`。
   - 改为在 `DetailService`（持有 `Arc<Mutex<Database>>`）中**短锁批量预读**所需的 `(etag, payload)` 传给纯异步 fetch 函数，fetch 完成后返回 `Vec<EtagWriteOp>` 由 `DetailRepository` 在同一短锁内落盘。这彻底消除了 SQLite 锁外并发写竞争并让 `github/*` 变成可单测的纯网络适配层。
2. **拆分 `CatalogService` 上帝对象**：
   - 将当前 `github/catalog_service.rs` 拆分为：
     - **DB DAO (`db/catalog.rs`)**：`catalog_apps` 表的 SQL 读写。
     - **CatalogRepository (`repositories/catalog_repo.rs`)**：`catalog_apps` + `custom_apps` + `user_favorites`/`watched_apps` 的事务性联动与投影。
     - **CatalogDomainService (`services/catalog_service.rs` 或重构 `CatalogService`)**：保留轻量内存投影索引（可选读缓存，随 `seed`/`sync`/`detail_writeback`/`custom_apps` 变更同步失效或刷新，保障毫秒级 Feed/Search 性能），不再直接管底层 HTTP 客户端与文件加载。
     - **ManifestClient (`github/manifest.rs`)**：只负责从远程 URL / 本地路径抓取并反序列化 `Vec<CatalogItem>`。
3. **拆分 `db/cache.rs` 臃肿模块**：
   - 按表域拆为：`db/details.rs`（`app_details`）、`db/etag.rs`（`api_etag_cache`）、`db/asset_cache.rs`（`asset_cache` + `asset_refs` + `trend_board_cache` + `icon_cache_meta`）。
4. **前端分层对齐（保持 IPC 契约平滑过渡）**：
   - `src/services/api/*`：严格作为唯一 IPC 入口（CMD 表驱动 + camelCase 参数）。
   - `src/app/hooks/*`：保持状态与视图解耦；`useDetailCacheSync` 在拿到 `get_app_details` 返回后，同步刷新前端四列表及 `searchListCache`，与后端 `app_details` + `catalog_apps` 双写保持完全一致。
   - **可选演进（不破坏现有组件）**：`HomeView` / `LatestView` / `CategoriesView` 已全部走后端分页命令（`get_home_feed` / `get_latest_catalog_apps` / `get_category_apps`），后续可逐步减少 `App.tsx` 启动时全量拉取 `searchApps('')` 的内存冗余，改由按需汇总统计命令供给。
