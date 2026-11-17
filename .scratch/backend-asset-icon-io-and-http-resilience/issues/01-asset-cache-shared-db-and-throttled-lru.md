# Issue 01: `asset_fetch` 复用共享 `AppState.db`、节流磁盘配额与单飞清理

Status: resolved
Blocked by: none

## Summary

消除 `github/asset_fetch.rs` 每次图片请求重复打开 SQLite 连接并执行全量 `init_schema()` 的问题，接入主进程共享 `AppState.db`（测试仍可注入临时库），节流 `enforce_asset_quota_lru` 全盘扫描，并加固 `inflight_map` 异常清理。

## Scope

- Allowed to modify:
  - `src-tauri/src/commands/catalog_detail.rs` (`fetch_or_cache_asset_url` 注入 `State<'_, AppState>`)
  - `src-tauri/src/github/asset_fetch.rs`
  - `src-tauri/src/github/readme_fetch.rs`
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/db/cache.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **复用共享 `AppState.db`（消除重复 `Database::open`）**：
   - `commands/catalog_detail.rs::fetch_or_cache_asset_url` 增加 `state: State<'_, AppState>` 参数（不改变前端 invoke JSON 参数，Tauri 自动注入 `State`）。
   - `asset_fetch.rs` 新增共享 DB 上下文（如 `enum AssetDbRef<'a> { Shared(&'a Mutex<Database>), FileRoot(&'a Path) }`），生产路径全程使用 `AppState.db` 短锁读取/刷新；测试路径 `fetch_or_cache_asset_url_in` 保持原有目录隔离测试能力（且同一调用内复用同一个打开的测试 `Database`，不打开 3 次）。
2. **文件 IO 卸出 async 线程 & `save_asset` 去冗余查询**：
   - 磁盘读取（`read_cached_asset_data_uri`）、`persist_asset_bytes` 与 `touch_path` 通过 `tokio::task::spawn_blocking` 执行，且不持有 `Database` 互斥锁。
   - `Database::save_asset` (`db/cache.rs:521-526`) 不再写入后再多查一遍 `get_asset`，直接构造返回 `AssetCacheRecord`（或仅在 `ON CONFLICT` 更新 `hits` 时通过 `RETURNING` 一次返回）。
3. **节流 `enforce_asset_quota_lru`**：
   - 启动期（`lib.rs:362`）仍执行一次全量 `enforce_asset_quota_lru`；运行期 `save_asset` 不再每次都递归扫描 `cache/assets/` 全目录，改为记录距离上次清理的新增写入字节/次数（例如每满 32 次写入或 64 MiB 新增写入后在独立后台 `spawn_blocking` 中异步执行一次淘汰）。
4. **`inflight_map` RAII 清理守卫与无后缀图片去 HEAD**：
   - 为 `flight_key` 加 `Drop` guard，确保即使调用方 Future 被 Tauri/Tokio cancel 或提前 drop，`inflight_map` 也会摘除自身条目（仅当仍是同一 `Arc::ptr_eq` 时）。
   - 移除 `asset_fetch.rs:363-394` 对无扩展名图片先发 `HEAD` 的额外 RTT，直接发起带条件头的 `GET`，在读取响应体前校验 `Content-Type` 与 `Content-Length`。
5. **内存与响应体有界治理 (`readme_fetch.rs` & `catalog_service.rs`)**：
   - `github/readme_fetch.rs:11-16` 的 `DEFAULT_BRANCH_CACHE` 与 `ROOT_PATHS_CACHE` 增加容量上限（如 512 条）与写入时过期清理，防止长时运行无限增长。
   - `github/catalog_service.rs:148-151` 的 `fetch_catalog_once` 改为有界流式读取（如参考 `launchpad/mod.rs` / `network.rs` 设合理上限），避免异常超大响应耗尽内存。

## Acceptance Criteria

- [x] 生产路径 `fetch_or_cache_asset_url` 不再调用 `Database::open`，全程复用 `AppState.db`。
- [x] `save_asset` 不再每次请求都递归扫描整个 `cache/assets/` 目录；`RETURNING` 或内存构造消除冗余回读。
- [x] `inflight_map` 在 Future cancel 时自动清理键。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过（含 `asset_fetch::tests` 与 `cache_quota_tests`）。
