# Feature Spec: SQLite 批量读写去重、`prepare_cached` 复用与阻塞 IO 异步卸载

> 状态：Implemented（`01`、`02`、`03` 均为 `resolved`）
> 关联契约：`CONTEXT.md`（`Repo Enrich Cache`、`Confirmed Icon`、`InstalledApp`、`ETag Cache`）、ADR-0003（SQLite 持久化与 ETag 缓存）、ADR-0026（搜索与 Star 列表缓存收敛）、ADR-0027（单仓富卡与瘦索引缓存）、ADR-0028（存量应用匹配）。

---

## 1. 问题背景与根因诊断

通过对 `db/`、`repositories/` 与 `commands/` 的 SQL 访问路径及线程模型审计，定位出三类高频率瓶颈：

### 1.1 批量富卡管道存在严重 N+1 查询与同表重复查询
- **`upsert_repo_cards_batch` N+1（`src-tauri/src/db/repo_cards.rs:484-536`）**：
  - 每次批量写入 20~40 条 `Repo Enrich Cache` 卡片时，`upsert_repo_cards_batch` 对每一行依次执行 `is_cataloged_card_id`（查 `catalog_apps UNION ALL custom_apps`）、`get_card_row`（单行 `SELECT`）与 `write_card_row`（单行 `INSERT ... ON CONFLICT`），产生 $3N$ 次独立 SQL `prepare` + 执行；即便调用方（`catalog_search.rs`）已通过内存 `CatalogService` 确认未收录，DAO 仍重复查表。
- **富卡水合与回填路径重复查询（`src-tauri/src/commands/catalog_search.rs:187-280, 598-663, 742-815, 1132-1178, 1220-1243, 1311-1373`）**：
  - `enrich_trend_repos` 预读循环逐仓执行 `resolve_confirmed_icon_from_db`（内含 `lookup_case_insensitive` 最多 5 次 SQL + 同步读盘）、`get_etag`、`get_cached_payload`、`get_repo_card`、`get_app_detail`（最多 2 次）。
  - `backfill_uncataloged_card` + `backfill_from_repo_card` + `repo_card_confirmed_other` 在单张卡片处理中对 `repo_card_cache` 同一行查询 3 次（`get_repo_card_platform_state` → `get_repo_card` → `get_repo_card_platform_state`）；`search_apps_online` 在循环内调 `backfill_uncataloged_card`（已查 `resolve_confirmed_icon_from_db`）后，L783-797 又对全页结果重查一遍 `resolve_confirmed_icon_from_db`。
  - `hydrate_repo_cards` 对 `repo_card_cache` 未命中行逐条查询 `app_details` 与 `app_icon_cycles`。

### 1.2 DAO/仓储层全表读取、逐行循环写与缺少 `prepare_cached`
- **`Database` 查询未复用语句缓存（`src-tauri/src/db/mod.rs:80-150`）**：`query_vec`、`query_scalar_opt`、`record_exists`、`exec_write` 均调用 `self.conn.prepare` / `execute` 而非 `prepare_cached`，高频查询重复解析 SQL AST。
- **`backfill_cataloged_flags` 反序列化全表 JSON（`src-tauri/src/repositories/catalog_repo.rs:56-80`）**：每次启动/清单同步/本地收录变更后，先全量读取 `list_catalog_apps()` 与 `list_local_library_items()`（反序列化全库所有 JSON 列），仅为了获取 `id` 集合，随后逐行执行 `UPDATE`。
- **`launch_app` 全表读取（`src-tauri/src/commands/installer_query.rs:182-188`）**、**`retire_custom_apps_in_tx` 逐条 `UPDATE`（`src-tauri/src/db/custom_apps.rs:554-559`）**、**历史记录每次插入都全表 `NOT IN` 裁剪（`src-tauri/src/db/history.rs:97, 158`）**。

### 1.3 同步命令与 `State.db` 互斥锁内执行重阻塞系统/文件 IO
- **`get_installed_apps` 与 `launch_app` 为同步 Tauri 命令（`src-tauri/src/commands/installer_query.rs:6-118, 180-443`）**：内部执行 Windows 注册表全量扫描（`scan_system_apps`）、PE 文件版本读取、多路径 `exists()` 与 SQLite 更新，直接在 IPC/主线程同步阻塞（对照 `commands/scanner.rs` 已正确迁移至 `tokio::task::spawn_blocking`）。
- **在持 `AppState.db` 互斥锁期间同步读盘与 Base64 编码（`commands/history.rs:98-128`、`commands/catalog_detail.rs:493-596`、`commands/catalog_search.rs:598-663`）**：`resolve_confirmed_icon_from_db` 在持有 `state.db()` 锁的循环内同步执行 `std::fs::read`（最多 30~50 个磁盘图标文件）并 Base64 编码，阻塞所有并发需要 `state.db()` 的异步命令。

---

## 2. 优化目标与设计方案

1. **批量 DAO 查询与合并写（Issue 01）**：
   - 在 `db/` 新增按 `ids` 切片分批 `IN (...)` 预读的批量接口（`repo_cards` 含平台态、`api_etag_cache`、`app_details` 摘要列、`app_icon_cycles`），消除 `enrich_trend_repos`、`search_apps_online`、`cards_from_repo_payloads`、`hydrate_repo_cards` 的循环 N+1 查询及 `repo_card_cache` 单行三查。
   - 重构 `upsert_repo_cards_batch`：事务内单次 `IN (...)` 预读已有 `CardRow` 与已收录 ID 集（并允许内存已判定未收录的调用方跳过重复查表），批量合并写入。
2. **语句缓存与仓储 SQL 效率优化（Issue 02）**：
   - `db/mod.rs` 将高频 helper 切换至 `prepare_cached`（或带开关的语句缓存），`db/apps.rs` 增加主键点查 `get_installed_app(app_id)` 供 `launch_app` 使用，`CatalogRepository::backfill_cataloged_flags` 改用仅查 `id` 或单条 SQL `UPDATE`，`retire_custom_apps_in_tx` 批量 `IN (...)` 更新。
3. **重阻塞系统/文件 IO 与 `db` 互斥锁解耦（Issue 03）**：
   - 将 `get_installed_apps` 与 `launch_app` 改为 `async fn`，重扫描与进程探测部分卸至 `tokio::task::spawn_blocking`。
   - 将图标磁盘读取与 Base64 编码从 `state.db()` 临界区内剥离：短锁一次性读出 DB 行/路径元数据 → 释放 `MutexGuard<Database>` → 在 `spawn_blocking`（或无锁读盘）中读文件与编码。

---

## 3. 实施 Issue 拆分清单

- [`01-batch-dao-reads-and-repo-cards-upsert-optimization.md`](./issues/01-batch-dao-reads-and-repo-cards-upsert-optimization.md)
- [`02-prepare-cached-and-repository-sql-efficiency.md`](./issues/02-prepare-cached-and-repository-sql-efficiency.md)
- [`03-async-offload-for-scanner-installer-and-disk-io.md`](./issues/03-async-offload-for-scanner-installer-and-disk-io.md)
