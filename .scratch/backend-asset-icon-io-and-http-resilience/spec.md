# Feature Spec: Asset/Icon 磁盘缓存管道治理、HTTP 重试契约统一与 ETag 补全

> 状态：Implemented（`01`、`02`、`03` 均为 `resolved`）
> 关联契约：`CONTEXT.md`（D5 双池复用、D7 有限重试、`ETag Cache`、`Confirmed Icon`）、ADR-0006（`ForgeProvider` 多托管源）、ADR-0012（网络性能 P0 连接池复用）、ADR-0025（动态系统代理与 Asset 缓存收敛）。

---

## 1. 问题背景与根因诊断

通过对图片磁盘缓存网关（`asset_fetch.rs`）、图标落盘模块（`icons/mod.rs`）与出站 HTTP 客户端层（`forge/http.rs`、`github/http.rs`、`downloader_http.rs`、`developer_profile.rs`）的审查，发现以下资源浪费与契约不一致问题：

### 1.1 `asset_fetch.rs` 绕过 `AppState.db` 重复开库并重跑完整 DDL，且每次写入触发全目录递归扫描
- **现状**（`src-tauri/src/github/asset_fetch.rs:127-133, 203-267, 335-348`、`src-tauri/src/commands/catalog_detail.rs:1190-1196`、`src-tauri/src/db/cache.rs:521-526, 569-660`）：
  - `fetch_or_cache_asset_url` 命令未注入 `State<'_, AppState>`，而是由 `open_asset_db` 每次临时调用 `Database::open(&path)`。单次图片请求最多打开关闭 3 个独立 SQLite 连接，且每次 `Database::open` 都执行 `PRAGMA` + 完整 `init_schema()`（20+ 条建表 DDL + 4 次 `pragma_table_info` + `user_version` 检查），并与 `AppState.db` 产生并发写锁竞争。
  - `Database::save_asset` 每次写入一条图片记录都要全表读取 `asset_cache` 并调用 `scan_asset_files` 递归扫描 `cache/assets/` 全部子目录及所有文件 `metadata()`。
  - `inflight_map()` 若任务被取消或 panic，Map 中的 `OnceCell` 条目不会被清理，存在内存泄漏隐患。

### 1.2 `icons/` 每次落盘全目录扫描与重复下载缺少单飞去重
- **现状**（`src-tauri/src/icons/mod.rs:69-96, 342, 365, 371-416, 552-578`）：
  - `write_icon_file` 每次保存单个图标都调用 `enforce_icon_quota_lru`，同步 `read_dir(icons_dir)` 遍历多达 2000 个文件的 `metadata()`（且在持 `db` 锁期间执行）。
  - `spawn_cache_selected_icon` 对同一 `selected_url` 无并发单飞去重，多张卡片或并发刷新可重复下载同一远端图标。
  - `base64_encode` 采用逐字符 `push(char)` 拼接，大图片（可达 5MB）编码效率较低。

### 1.3 HTTP 重试策略分裂、开发者主页未接 ETag 缓存与连接池小缺陷
- **现状**：
  - `src-tauri/src/forge/http.rs:186-216`（`get_with_retry_after_once`，供 GitLab / Gitea `ForgeProvider` 使用）仅重试 429 一次，不重试 5xx，传输错误无退避；而 `src-tauri/src/github/http.rs:94-128` 实现了 D7 完整语义（传输错误/429/5xx 最多 2 次，200ms→800ms 退避，429 消费 `Retry-After`）。两处重试与代理重探逻辑重复且行为漂移。
  - `src-tauri/src/commands/forge.rs:7-16`（`get_developer_profile`）直接调用无缓存版 `fetch_developer_profile`（`developer_profile.rs:20-32`），绕过了已实现的 `fetch_developer_profile_with_cache` 与 `api_etag_cache`，每次查看开发者主页均白白消耗 2 次无条件 API 配额且无法离线 304 恢复。
  - `src-tauri/src/github/catalog_service.rs:581-584` 镜像回退分支每次临时新建 `reqwest::Client`，未走 `ClientSlot` 复用。
  - `src-tauri/src/installer/downloader_http.rs:47-49` 的 `DOWNLOAD_CLIENTS` 池达上限 8 后直接 `guard.clear()`，可能驱逐正在使用的活跃客户端。

---

## 2. 优化目标与设计方案

1. **Asset 缓存接入共享 `AppState.db` 与节流淘汰（Issue 01）**：
   - 将 `AppState.db`（`Arc<Mutex<Database>>`）传入 `fetch_or_cache_asset_url_inner`（同时保留基于路径的测试注入能力），彻底移除运行期重复 `Database::open` 与 `init_schema()` 开销。
   - `enforce_asset_quota_lru` 与 `save_asset` 改为按写计数/时间窗节流触发（如每写入 N 次或距上次裁剪超阈值才扫描磁盘），并用 `Drop` guard 保证 `inflight_map` 在取消/异常时可靠清理。
2. **Icon 落盘 LRU 节流、单飞下载与编码优化（Issue 02）**：
   - `enforce_icon_quota_lru` 改为周期/写计数节流并在锁外执行磁盘清理；`spawn_cache_selected_icon` 接入 URL 级单飞去重；优化 `base64_encode` 为字节缓冲写入。
3. **HTTP 重试策略收敛与开发者画像 ETag 持久化接入（Issue 03）**：
   - 抽取共享 D7 GET 重试核心至 `forge::http`（供 `GitLab`/`Gitea` 与 `github::http` 共用）；`get_developer_profile` 接入 `api_etag_cache` 预读与落库；清单镜像池与下载池改用有界 LRU/槽位复用。

---

## 3. 实施 Issue 拆分清单

- [`01-asset-cache-shared-db-and-throttled-lru.md`](./issues/01-asset-cache-shared-db-and-throttled-lru.md)
- [`02-icon-write-lru-throttling-and-singleflight.md`](./issues/02-icon-write-lru-throttling-and-singleflight.md)
- [`03-http-retry-unification-and-developer-profile-etag.md`](./issues/03-http-retry-unification-and-developer-profile-etag.md)
