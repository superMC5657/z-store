# Issue 40: 开始菜单卸载快捷方式路径未消毒（02 兄弟路径）

Status: resolved
Priority: P1（安全 · 路径穿越）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · Rust 安全分片

## 描述

02 号工单修的是桌面 `.lnk` 删除路径（`commands/installer_uninstall.rs:88-110`，
复用 `sanitize_shortcut_name` + canonicalize 前缀断言），但同一路径族的兄弟未修：
`installer/paths.rs:322-331` 把原始 `app_name` 直接 `join` 进开始菜单程序组目录。
`PathBuf::join` 遇绝对路径会整段替换 base，`..` 亦可上跳；命中的
`*uninstall*.lnk` 随后经 ShellExecuteEx 执行。同一不可信输入（自定义/导入应用名），
穿越仍然成立。

## 修复方向

- 开始菜单查找入口复用创建侧同一消毒函数，拼接后再做 canonicalize + 前缀断言。
- 补 Windows 门控回归：`..\..\Windows\System32`、绝对路径均不可逃逸。

## Comments

- `installer/paths.rs` 新增 `start_menu_uninstall_lnk(base, app_name)`：
  `sanitize_shortcut_name` → join → `canonicalize` → `.lnk` 前缀断言（仍在程序组目录内才返回）；
  原两处候选路径统一走该函数。
- 回归：`traversal_name_cannot_escape_start_menu` 覆盖 `..\..\Windows\System32` 与
  `C:\Windows\System32` 两种形态（Windows 门控）。
- 验证：`cargo test` 378 过；`clippy --all-targets -D warnings` 绿。
- 提交：e046c80。
