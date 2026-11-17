# 后端 Rust 优化实施顺序计划（5 Specs · 14 Issues）

> 关联 Spec 目录：
> 1. `.scratch/backend-security-leaks-and-correctness/`
> 2. `.scratch/backend-asset-icon-io-and-http-resilience/`
> 3. `.scratch/backend-catalog-index-and-affinity-cache/`
> 4. `.scratch/backend-sqlite-batching-and-async-offload/`
> 5. `.scratch/backend-contract-consistency-and-hygiene/`

---

## 一、排序原则

1. **正确性与安全先行**：优先修复已确认的线上 Bug（`detail_fetch.rs` 错传 Release ETag 给 Checksum）、注入/解压炸弹风险、取消泄漏与更新规则静默丢失。
2. **共享文件按依赖单向推进，避免反复冲突**：
   - `executor_portable.rs` 先做安全硬限与异常回滚（Spec 5），再做 `spawn_blocking` + `BufReader`/`BufWriter`（Spec 2）。
   - `icons/mod.rs` 先做 LRU 节流、写错不吞与单飞（Spec 3），再把读盘/Base64 移出 `AppState.db` 互斥锁（Spec 2）。
   - `developer_profile.rs` 先接入 ETag 缓存与 `tokio::join!`（Spec 3），再切换至 `CatalogService` $O(1)$ 查询（Spec 1）。
   - `CatalogService` 先建立 $O(1)$ 索引与预计算 `CatalogIdf`（Spec 1），再做 `IN (...)` 批量预读、锁合并与异步卸载（Spec 2）。
3. **SSOT 收敛收尾**：`backend-contract-consistency-and-hygiene` 涉及 13 个文件横切去重，放在最后统一收口，避免前序 Spec 改动引发反复冲突，同时保证最终不残留重复逻辑。

---

## 二、分阶段实施路线图

### Phase 1：安全加固、Bug 修复与磁盘/网络热点止血（可与 Phase 1B 部分并行）

- **Step 1.1 — `backend-security-leaks-and-correctness`**
  1. `01-installer-injection-and-archive-bomb-hardening.md`（PowerShell 传参加固、ZIP/Tar `Read::take()` 硬限、软链与全异常回滚、`save_setting`/`open_desktop_path`/`enrich_targets` 校验）
  2. `02-async-cancel-resource-leaks-and-uninstaller-parsing.md`（下载 `.tmp` / Win32 `SendHandle` / macOS DMG 挂载点 RAII `Drop`、`WaitForSingleObject` 移出 async、无引号含空格卸载路径解析）
  3. `03-rules-error-propagation-scanner-and-build-hygiene.md`（禁止 `get_all_rules`/`hidden_rule_ids` DB 失败静默置空、`markdown.rs` 静态正则、`scanner/registry.rs` $O(S+N)$、`Cargo.toml` 精简 `tokio` 与 `[profile.release]`）
- **Step 1.2 — `backend-asset-icon-io-and-http-resilience`**
  1. `03-http-retry-unification-and-developer-profile-etag.md`（修复 `detail_fetch.rs` Checksum 错传头 Bug、统一 D7 重试、`get_developer_profile` 接入 ETag 缓存、`developer_profile`/`discussions` `tokio::join!`、镜像 `ClientSlot` 与下载池 LRU）
  2. `01-asset-cache-shared-db-and-throttled-lru.md`（`asset_fetch` 复用 `AppState.db` 消除重复 `Database::open`、节流磁盘配额、`inflight_map` RAII、无后缀图去 `HEAD`、`readme_fetch`/`fetch_catalog_once` 有界化）
  3. `02-icon-write-lru-throttling-and-singleflight.md`（图标 LRU 节流并移出 DB 锁、`spawn_cache_selected_icon` 单飞、Base64 缓冲、图标下载上限与写错不吞、`data:image/` 与 SVG 校验）

> 注：`Step 1.1`（Issues 01–02）与 `Step 1.2`（Issues 01–03）仅在 `downloader_http.rs` 有轻微交集，按 `1.1-02 -> 1.2-03` 顺序即可完全零冲突。

---

### Phase 2：`CatalogService` 内存索引与画像预计算

- **Step 2.1 — `backend-catalog-index-and-affinity-cache`**
  1. `01-catalog-service-hash-index-and-lock-consolidation.md`
  2. `02-filtered-projection-and-zero-clone-search.md`
  3. `03-precomputed-catalog-idf-and-borrowed-affinity-build.md`

> 产出：`CatalogService` 全面 $O(1)$ 点查、零全库 `CatalogItem` 克隆、`CatalogIdf` 预计算缓存、`featured.rs` 零克隆 `by_id` 与种子词元预提取。

---

### Phase 3：SQLite 批处理与重阻塞 IO 异步卸载

- **Step 3.1 — `backend-sqlite-batching-and-async-offload`**
  1. `01-batch-dao-reads-and-repo-cards-upsert-optimization.md`（`repo_cards`/`etag`/`details`/`icon_cycle` 批量 `IN (...)` 预读、`upsert_repo_cards_batch` 去 N+1、`catalog_search` 去三查同表）
  2. `02-prepare-cached-and-repository-sql-efficiency.md`（`prepare_cached`、`backfill_cataloged_flags` 仅查 ID 列、`get_installed_app` 主键点查、`apply_paginated_signal_outcome` 单事务合并、命令层锁合并）
  3. `03-async-offload-for-installer-query-and-disk-io.md`（`get_installed_apps`/`launch_app` 改 `async` + `spawn_blocking`、批量图标读盘/Base64 移出 `AppState.db` 锁、便携包解压与 `sha256_of_file` `spawn_blocking` + `BufReader`/`BufWriter`）

---

### Phase 4：跨模块 SSOT 收敛与收尾卫生

- **Step 4.1 — `backend-contract-consistency-and-hygiene`**
  1. `01-shared-placeholder-license-and-endpoint-ssot.md`（GitHub 端点编码、`is_placeholder_*`、`normalize_license`、`resolve_online_license`、分类词表与 `discussions.rs` 借用引用收敛）
  2. `02-error-boundary-and-settings-key-allocation-cleanup.md`（`MANAGED_SETTING_KEYS` 静态切片零分配、统一 `AppResult<T>`、种子解析与内存库降级诊断）

---

## 三、通用验证门禁（每个 Issue 完成后执行）

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
```
- 涉及 Tauri commands 签名/返回值或 `AppState` 变更时，补跑前端单测确认 IPC 契约与类型兼容：
```bash
pnpm test
```
