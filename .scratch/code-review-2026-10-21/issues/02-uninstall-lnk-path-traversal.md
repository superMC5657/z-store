# Issue 02: 卸载快捷方式路径穿越删除

Status: resolved
Priority: P1（安全/数据损坏）
来源: 2026-10-21 全项目审查 · Rust 安全分片（已人工读码复核）

## 描述

`src-tauri/src/commands/installer_uninstall.rs:159` 用未消毒的 `app.app_name` 拼接
`Desktop\{name}.lnk` 后 `remove_file`。`app_name` 经自定义条目/导入数据可控，名称含
`..\` 时 OS 逐级解析 `..`，可删除 Desktop 之外任意位置的 `*.lnk` 文件。

不对称佐证：创建快捷方式侧 `src-tauri/src/installer/paths.rs:163-166` 已做字符消毒，
删除侧没有——特殊名创建被消毒、删除被跳过，还会残留死快捷方式（P3 关联）。

## 修复方向

- 删除前对 `app_name` 复用创建侧同一消毒函数（抽成共享 helper，保证两侧字符集一致）。
- 拼接后用 `canonicalize` + 前缀断言确认仍位于 Desktop 目录内再删除。

## Comments

- 实际改动：
  - `src-tauri/src/installer/paths.rs`：把创建侧的文件名消毒抽成共享 helper
    `sanitize_shortcut_name`（过滤 `\ / : * ? " < > |`、trim、空名回退 "App"），
    `create_desktop_shortcut` 改为调用它；经 `installer/mod.rs` 再导出为唯一口径。
  - `src-tauri/src/commands/installer_uninstall.rs`：Desktop 快捷方式清理收进
    `deletable_desktop_lnk` + `cleanup_desktop_shortcut`：文件名先过共享消毒
    （无分隔符即无逐级穿越），拼接后 `canonicalize` 两侧 + `starts_with` 前缀断言，
    任一环节不满足返回 None 放弃删除（宁可残留死快捷方式，绝不越出 Desktop）。
- 测试：`shortcut_name_tests`（跨平台，锁定穿越名消毒形态与空名回退）+
  `desktop_shortcut_guard_tests`（windows 门控：正常名可删、`..\..` 穿越名解析
  仍落在 Desktop 内且外部文件存活、缺失返回 None）。
- 验证：`cargo test` 331 通过 0 失败；`cargo clippy --all-targets` 无来自本批
  改动文件的告警。
- 备注：删除侧 Desktop 目录解析仍用 `USERPROFILE\Desktop`，创建侧 PowerShell
  `GetFolderPath('Desktop')` 在 OneDrive 重定向场景下两者可能不同步——属既有
  行为，未在本工单扩大范围。
