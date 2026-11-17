# Issue 02: Icon 落盘 LRU 节流、`spawn_cache_selected_icon` 单飞去重与 Base64 编码优化

Status: resolved
Blocked by: none

## Summary

修复 `icons/mod.rs` 每次写入单个图标全目录扫描 `icons/`（且在 `db` 锁内执行）的瓶颈，为后台图标缓存下载增加 URL 级单飞去重，并优化 `base64_encode` 分配与字节写入。

## Scope

- Allowed to modify:
  - `src-tauri/src/icons/mod.rs`
  - `src-tauri/src/icons/image_sniff.rs`
  - `src-tauri/src/icons/quota_throttle.rs`
  - `src-tauri/src/icons/singleflight.rs`
  - `src-tauri/src/icons/tests.rs`
  - `src-tauri/src/lib.rs` (可选：启动期补齐一次 `enforce_icon_quota_lru`)
- Do not modify:
  - `src/*`

## Implementation Details

1. **节流 `enforce_icon_quota_lru` 并移出 DB 互斥锁**：
   - 当前 `write_icon_file` (`icons/mod.rs:342, 365`) 每次写文件都全量 `read_dir(icons_dir)` 并对全部文件调 `fs::metadata`（且在 `spawn_cache_selected_icon` 内处于 `db_arc.lock()` 临界区中！）。
   - 优化方案：
     - 将 `enforce_icon_quota_lru` 从 `db_arc.lock()` 临界区中移出（先在短锁内取出配额上限 `(max_files, max_bytes)`，解锁后执行磁盘清理）。
     - 添加原子写计数/时间节流（例如每写入 25 个图标或距上次扫描超过 5 分钟才触发一次全目录 LRU 裁剪），并在启动期 best-effort 执行一次全量清理。
2. **`spawn_cache_selected_icon` 并发单飞去重与异步写盘**：
   - 使用全局 `tokio::sync::Mutex<HashSet<String>>`（或复用意图清晰的轻量 inflight 集合）对相同 `selected_url` 进行去重，避免多张列表卡片同时命中同一图标 URL 时并发重复下载与写盘。
   - 文件写入（`std::fs::write` / `cleanup_stale_cycle_variants`）先于 `db_arc.lock()` 或通过 `spawn_blocking` 执行，减小 `db` 锁持有时间。
3. **`base64_encode` 字节缓冲区优化**：
   - 将 `base64_encode` (`icons/mod.rs:69-90`) 改为向预分配 `Vec<u8>` 直接写入 ASCII 字节（`result.extend_from_slice(&[...])`）后调用 `String::from_utf8_unchecked`（所有字节均来自静态 ASCII `BASE64_ALPHABET` 与 `b'='`）或安全等价实现，避免每次迭代 4 次 UTF-8 char 转换与容量检查。
4. **下载有界防护、写盘错误传播与格式校验加固 (`icons/mod.rs`、`icons/image_sniff.rs`)**：
   - `download_icon_bytes` (`icons/mod.rs:504`) 改用有界流式读取（如上限 5 MiB），避免直接 `resp.bytes().await` 被超大响应拖垮内存。
   - `persist_catalog_icon` (`icons/mod.rs:310`) 与 `write_icon_file` (`icons/mod.rs:363`) 不再吞掉 `std::fs::write` 错误：写入失败时不删除旧文件、不写入指向不存在文件的 `icon_cache_meta` / `cache_file` 记录。
   - `get_or_fetch_icon` (`icons/mod.rs:761`) 仅对 `data:image/` 前缀（大小写不敏感）直通返回，拒绝任意非图片 `data:` URI；`sniff_image_mime` (`icons/image_sniff.rs:48-50`) 对 `<?xml` 开头的内容进一步校验包含 `<svg` 标签再识别为 `image/svg+xml`。

## Acceptance Criteria

- [x] `write_icon_file` 不再在每次写图标时遍历整个 `icons/` 目录，且不持有 `AppState.db` 锁执行磁盘遍历。
- [x] `spawn_cache_selected_icon` 对同一 `selected_url` 并发请求去重为单次网络下载。
- [x] `icons::tests` 与全量 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 通过。
