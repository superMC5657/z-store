# Issue 03: 重阻塞系统探测与磁盘图标读取的异步卸载与锁拆分

Status: needs-triage
Blocked by: 01

## Summary

消除同步 Tauri Command 对主线程/IPC 线程的阻塞，并将持有 `AppState.db` 互斥锁期间的同步文件系统读取与 Base64 编码剥离到无锁 `spawn_blocking` 上下文中执行。

## Scope

- Allowed to modify:
  - `src-tauri/src/commands/installer_query.rs`
  - `src-tauri/src/commands/installer_install.rs`
  - `src-tauri/src/commands/installer_uninstall.rs`
  - `src-tauri/src/commands/updates_check.rs` (调用 `get_installed_apps` 的适配)
  - `src-tauri/src/commands/history.rs`
  - `src-tauri/src/commands/catalog_detail.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/installer/executor.rs`
  - `src-tauri/src/installer/executor_portable.rs`
  - `src-tauri/src/installer/downloader_progress.rs`
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/icons/mod.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **`get_installed_apps` 与 `launch_app` 异步卸载 (`commands/installer_query.rs`)**：
   - 将 `get_installed_apps` 与 `launch_app` 转为 `pub async fn`（对 Tauri IPC 透明，前端 `invoke` 契约不变），内部通过 `tokio::task::spawn_blocking` 执行：
     - Windows 注册表扫描（`scan_system_apps`）、PE 版本解析（`read_exe_version`）、磁盘 `Path::exists()` 探测与进程启动；
     - `check_for_updates` 内部改为共享同一个异步/blocking helper；`get_cached_updates` 保持纯 DB 只读（不触发全盘注册表重扫或修复路径，避免同步命令再做全盘扫描）。
2. **解耦 `state.db()` 互斥锁与磁盘图标读取/Base64 编码**：
   - 当前 `resolve_confirmed_icon_from_db` 在持有 `MutexGuard<Database>` 期间同步执行 `std::fs::read` 与 `bytes_to_data_uri`。
   - 拆分为两步：
     1) **短锁 DB 阶段**：批量读取 `app_icon_cycles` 记录与 `catalog_apps` 静态图标路径后立即释放 `db` 锁；
     2) **无锁 IO 阶段**：在 `spawn_blocking` 中批量读取并校验磁盘图标文件、编码 `data:` URI；若发生自愈认领（`cache_file` 回填），仅针对变更项再取一次短锁写回 `cache_file`。
   - 优先覆盖高频批量入口：`get_confirmed_icons_batch`、`get_cached_app_details_batch`、`get_repo_cards_batch`、`get_recently_viewed_apps`。
3. **安装器压缩包解压、哈希计算与本地清单读取卸载 + I/O 缓冲**：
   - `installer/executor.rs:248-253` & `installer/executor_portable.rs`：`execute_installation_inner` 通过 `tokio::task::spawn_blocking` 执行同步 ZIP/Tarball 解压与 `create_desktop_shortcut`（PowerShell）；`install_portable_zip` 与 `install_portable_tarball` 使用 `std::io::BufReader` / `BufWriter` 减少小文件解压系统调用。
   - `commands/installer_install.rs:85-184` & `commands/installer_uninstall.rs:135-202`：将阻塞的注册表/跨盘符探测（`resolve_installed_app_path` / `resolve_uninstaller_command`）与 `std::fs::remove_dir_all` 包装进 `spawn_blocking`。
   - `installer/downloader_progress.rs:31-46`：`sha256_of_file` 改在 `spawn_blocking` 中用 `std::io::BufReader` 顺序计算，减少 64KB 异步块调度开销。
   - `github/catalog_service.rs:63-109`：`fetch_local_catalog` 改用 `tokio::fs` 或 `spawn_blocking`。

## Acceptance Criteria

- [ ] `get_installed_apps` 与 `launch_app` 不再在 Tauri 主线程/IPC 线程执行同步注册表枚举与文件系统探测。
- [ ] 批量接口读取磁盘图标文件与 Base64 编码期间不持有 `AppState.db` `Mutex` 锁。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 全部通过。
