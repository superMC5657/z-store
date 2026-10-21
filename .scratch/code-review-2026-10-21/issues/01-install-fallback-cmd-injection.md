# Issue 01: install 回退分支 cmd.exe 元字符注入

Status: resolved
Priority: P1（安全）
来源: 2026-10-21 全项目审查 · Rust 安全分片（已人工读码复核）

## 描述

`src-tauri/src/installer/executor_windows.rs:114-122` 的 `install_fallback_default` 用
`cmd.exe /c start /wait <installer_path>` 调起安装包。两个问题：

1. **注入**：`installer_path` 中的文件名来自第三方 release 资产，含 `"` 时 Rust 按
   MSVCRT 规则转义为 `\"`，但 cmd.exe 的解析器不认该转义，可借此断开参数注入任意命令
   （`&`、`|` 等）。
2. **正确性**：`start` 把第一个带引号参数当窗口标题，含空格的路径会被吞成标题而非执行。

## 修复方向

- 不经 shell：用 `Command::new(installer_path)` 直接调起（`ShellExecuteW`/`open` 路由到
  系统默认程序），`/wait` 语义用 `.status()` 已满足。
- 若必须保留 `cmd.exe` 路径，先校验路径不含 `"`/`&`/`^`/`%` 等 cmd 元字符，拒绝并走
  明确报错。
- 附带：无 checksums 的资产流入此分支时与 07 号工单的门禁联动。

## Comments

- 实际改动（`src-tauri/src/installer/executor_windows.rs`）：`install_fallback_default` 移除
  `cmd.exe /c start /wait` 链路，改为 `tokio::process::Command::new(installer_path).status()`
  直调。不经任何 shell 解析器，`"`/`&`/`%` 等元字符回归普通文件名字节；`.status()` 自带等待
  语义，与原 `/wait` 等价；错误消息改为携带 OS 报错与路径，便于定位非 PE 资产（如 msix）
  无法直接执行的失败。回退分支实际只接 `Apk`/`Other` 两类资产（executor.rs `_` 分支）。
- 测试：新增 `fallback_surfaces_spawn_error_for_missing_installer`（windows 门控），锁定
  缺失资产的 spawn 失败如实冒泡为 `Err`——若回退经 cmd.exe，cmd 自身总被成功拉起，
  错误与注入面都会被掩盖。
- 验证：`cargo test` 326 通过 0 失败；`cargo clippy --all-targets` 无来自本文件的告警。
- 07 号联动（无 checksums 门禁）不在本工单范围，未动。
