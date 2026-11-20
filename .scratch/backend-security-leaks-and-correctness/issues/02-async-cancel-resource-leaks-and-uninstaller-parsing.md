# Issue 02: 异步取消 RAII 资源清理与 Windows 卸载命令解析修复

Status: resolved
Blocked by: none

## Summary

修复下载临时文件、Win32 进程句柄与 macOS DMG 挂载点在异步取消或异常提前返回时的资源泄漏问题，并修复 `parse_uninstaller_command` 无法处理无引号含空格卸载路径的问题。

## Scope

- Allowed to modify:
  - `src-tauri/src/installer/downloader_http.rs`
  - `src-tauri/src/installer/executor_uninstall.rs`
  - `src-tauri/src/installer/executor_macos.rs`
  - `src-tauri/src/installer/tests.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **下载临时文件 RAII 守卫 (`installer/downloader_http.rs:195-363`)**：
   - 为 `tmp_path` 增加轻量 `TempFileGuard(Option<PathBuf>)`（`Drop` 时若仍存在则尽力 `std::fs::remove_file`），成功 `rename` 到 `final_path` 后调用 `guard.disarm()`。确保 Future 被取消或任意错误提前返回时无 `.tmp` 残留。
2. **Win32 进程句柄 `Drop` 与阻塞等待移出 async 线程 (`installer/executor_uninstall.rs:168-240`)**：
   - 为 `SendHandle` 实现 `Drop`（句柄非空时自动调用 `CloseHandle`），在正常关闭路径消费所有权（`take` / `ManuallyDrop`）避免双重关闭；即使 `tokio::time::sleep` 期间任务被取消也不会泄漏句柄。
   - 将 `WaitForSingleObject(launched.0, 250)` 移入 `tokio::task::spawn_blocking`（或增大轮询间隔并在阻塞线程等待），避免在 Tokio async worker 上做同步系统调用等待。
3. **macOS DMG 挂载点 RAII 卸载 (`installer/executor_macos.rs:104-165`)**：
   - `hdiutil attach` 成功拿到 `volume_path` 后，利用作用域守卫确保在 `remove_dir_all` / `cp` 报错或任务取消时仍能异步/同步尽力执行 `hdiutil detach`。
4. **修复 `parse_uninstaller_command` 无引号含空格路径与带引号参数 (`installer/executor_uninstall.rs:4-46`)**：
   - 当未以引号开头时，若整串不是文件，扫描各空格断点（优先匹配 `.exe ` / `.bat ` / `.cmd ` / `.msi ` 等后缀断点且 `Path::new(prefix).is_file()`），正确切分如 `C:\Program Files\App\unins.exe /SILENT`。
   - 对 `args_part` 采用支持双引号/单引号的轻量 argv 分词器，避免拆散如 `/LOG="C:\My Logs\u.log"` 参数。

## Acceptance Criteria

- [x] `parse_uninstaller_command` 单测覆盖无引号含空格路径（模拟真实或临时 `.exe` 路径）与带引号参数。
- [x] `downloader_http`、`executor_uninstall`（Windows）与 `executor_macos`（macOS）具备 RAII 清理守卫，取消/错误路径不泄漏临时文件、句柄与挂载点。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
