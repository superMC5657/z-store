# ZStore Catalog & Database 分层重构实施计划 (Plan)

Status: resolved
Linked Spec: `.scratch/catalog-db-refactor/spec.md`

---

## 阶段划分与退出标准

### Phase 1 · 数据库 Schema v1→v2 与持久化 DAO 层重构

- **目标**：建立 `catalog_apps` 与 `app_details` 双核心表，完成 `v1 → v2` 无损迁移与 `catalog.json` 种子播种，拆分 `db/cache.rs`。
- **改动清单**：
  1. `src-tauri/src/db/schema.rs`：
     - `CURRENT_USER_VERSION` 升级为 `2`。
     - 新增 `catalog_apps` 与 `app_details` DDL 及索引。
     - 实现 `migrate_v1_to_v2`：将旧 `app_details_cache` 行解析并迁移写入 `app_details` 后删除旧表（含损坏行容错与单测）。
  2. `src-tauri/src/db/catalog.rs`（新增）：
     - `count_catalog_apps()`、`seed_catalog_apps_if_empty(&[CatalogItem])`
     - `replace_remote_catalog_apps(&[CatalogItem], now)`（事务全量覆盖）
     - `list_catalog_apps()`、`get_catalog_app(id)`、`exists_catalog_app(id)`
     - `update_catalog_app_from_detail(&AppDetail, now)`（仅当条目在 `catalog_apps` 存在时回写保鲜字段）
     - `update_catalog_app_platforms(id, &[String], now)`（供 `get_platforms_lite` 可选持久化回填）
  3. `src-tauri/src/db/details.rs`（新增，拆出 `db/cache.rs` 中详情部分）：
     - `get_app_detail(id, ttl_seconds)`、`get_all_app_details()`、`save_app_detail(id, &AppDetail)`、`touch_app_detail(id, ts)`、`sync_app_detail_icon(id, url)`、`prune_app_details(max_rows)`（保护 `installed_apps`、`user_favorites`、`watched_apps`、`view_history`）。
  4. `src-tauri/src/db/etag.rs` 与 `src-tauri/src/db/asset_cache.rs`（拆分原 `db/cache.rs` 剩余职责）。
- **退出标准**：
  - 全新空库、v0 遗留库、v1 含 `app_details_cache` 存量库均可无损迁移至 v2；
  - `cargo test --lib db::` 全部通过（含新增 v1→v2 迁移及 DAO 单测）。

---

### Phase 2 · Repository 仓储层与消除 `open_db_opt()` 旁路

- **目标**：引入 `src-tauri/src/repositories/` 收敛跨表事务一致性，彻底移除 `github/*` 隐式直连 SQLite 的旁路。
- **改动清单**：
  1. `src-tauri/src/repositories/mod.rs`、`catalog_repo.rs`、`detail_repo.rs`：
     - `CatalogRepository`：封装「种子播种」、「`sync_catalog` 原子覆盖 + `custom_apps` 转正归档 + `user_favorites`/`watched_apps` 回填」、「`catalog_apps ∪ custom_apps` 远端优先合并投影与盖章」。
     - `DetailRepository`：封装「`app_details` + `catalog_apps`/`custom_apps` 精校叠加投影」、「`save_detail_and_sync_catalog_and_cycle` 原子单事务落库（写 `app_details` + 回写 `catalog_apps` + 写 `app_icon_cycles` + 批量写 `api_etag_cache`）」、「`get_batch_summaries` DB-only 批量富卡读取」。
  2. 消除 `src-tauri/src/github/http.rs::open_db_opt`：
     - 改造 `github/detail_fetch.rs`、`github/readme_fetch.rs`、`github/affinity.rs` 等，改为接收预读 `EtagCacheMap` / `RepoContext` 并返回待持久化 `Vec<EtagMutation>`，由 Service/Repository 持有 `state.db()` 统一短锁落盘。
- **退出标准**：
  - 仓库内不存在 `Database::open_default_opt()` 在网络模块中被调用；
  - 详情保存、图标轮换、目录回写在单事务中原子提交。

---

### Phase 3 · Domain Service 层重构与拆解 `CatalogService`

- **目标**：明确领域服务边界，将 `CatalogService` 转型为纯领域服务 + 内存读索引镜像，不再自己加载 `catalog.json` 或承担杂糅职责。
- **改动清单**：
  1. 抽取 `src-tauri/src/github/manifest.rs`：纯清单拉取客户端（HTTP ETag / 本地文件回退）。
  2. 重构 `CatalogService`（或 `src-tauri/src/services/`）：
     - 启动初始化时由 `CatalogRepository::bootstrap_catalog(&db, seed_loader)` 完成播种并加载到内存读索引；
     - 每次 `sync_catalog`、`save_detail`、`custom_apps` 变更时通过 Repository 先写 DB、再刷新读索引（DB 为 SSOT，内存仅做 O(1)/O(N) 读加速投影）。
     - 抽离 `DetailService`、`UpdateService`、`HistoryService` 编排逻辑，使 `commands/*.rs` 仅剩薄参数校验、调用 Service、发事件与写日志。
  3. 调整 `src-tauri/src/lib.rs::setup`：
     - 打开 DB（自动跑 v1→v2 迁移）→ `CatalogRepository::ensure_seeded_from_config(&db)` → 若首次从 v1 迁移执行一次存量 `app_details` 水合到 `catalog_apps` → 构建 `CatalogService` 并同步读索引 → `backfill_cataloged_flags`。
- **退出标准**：
  - `CatalogService::new()` 不再以 `catalog.json` 作为运行时数据源；
  - 重启应用后，上次 `sync_catalog` 同步的清单与 `get_app_details` 刷新的统计/平台/版本仍完整持久化于 `catalog_apps` 中。

---

### Phase 4 · 全链路 Commands 对齐与回归验证

- **目标**：逐条核对并接入所有页面对应的 Commands，确保零行为退化、零前端破坏性变更。
- **改动清单**：
  1. `commands/catalog_sync.rs`：`sync_catalog` 走 `CatalogRepository::apply_remote_manifest`（全量权威覆盖 `catalog_apps` + 转正 + 回填 + 刷新读索引）。
  2. `commands/catalog_detail.rs`：`get_app_details` / `get_platforms_lite` / `get_cached_app_details_batch` 全部读/写 `app_details` + 回写 `catalog_apps`。
  3. `commands/catalog_feed.rs` / `catalog_search.rs` / `catalog_custom.rs` / `history.rs` / `scanner.rs` / `updates_check.rs` / `installer_*.rs`：统一经 Repository / Domain Service 获取合并目录与详情表数据。
  4. `src-tauri/src/commands/tests.rs` & `src-tauri/src/github/tests.rs`：补充/更新集成单测，验证：
     - 首次启动空库从 `catalog.json` 播种；二次启动不重复覆盖已同步/已刷新数据；
     - `sync_catalog` 全量覆盖 `catalog_apps` 并移除下架条目、同时保留 `app_details` 详情缓存；
     - `get_app_details` 写入 `app_details` 并同步回写 `catalog_apps`，重启后首页/分类/搜索直接展示最新数据；
     - 收藏/关注/最近浏览/更新中心/扫描器在未收录与已收录混合场景下行为 100% 兼容。
- **退出标准**：
  - `cargo test` 全量通过；
  - `pnpm test`（含 `ipcArgsNaming.test.ts`、`noDirectInvoke.test.ts`、`cmdAlignment.test.ts` 等前端契约测试）全量通过；
  - 更新 `CONTEXT.md` 与新增 `docs/adr/0022-catalog-and-detail-database-layering.md`（若实施时一并收口文档）。
