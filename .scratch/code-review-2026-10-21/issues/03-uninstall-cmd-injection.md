# Issue 03: 卸载命令串经 cmd.exe 注入

Status: resolved
Priority: P1（安全）
来源: 2026-10-21 全项目审查 · Rust 安全分片

## 描述

`src-tauri/src/installer/executor_uninstall.rs:196-200`：`.lnk` 分支经
`cmd.exe /C start /WAIT` 执行来自注册表/DB 的卸载串，路径内 `&`、`%` 等 cmd 元字符可
注入执行任意命令。与 01 号工单同根因（经 shell 执行不可信字符串），但代码路径独立，
需分别修复。

## 修复方向

- 卸载串解析为程序 + 参数列表后用 `Command::new` 直接执行，不经 shell。
- 无法解析时按 allowlist 校验（可执行路径存在且无元字符）再放行，否则报错交用户手动卸载。
- 参考 2026-09-20 审查 P0-3（Unix `sh -c` 拼接注入）——若该处仍在，合并本次一并处理。

## Comments

- 实际改动（`src-tauri/src/installer/executor_uninstall.rs` + `Cargo.toml`）：
  - `.lnk` 分支移除 `cmd.exe /C start /WAIT`，改为两步：
    1. `validate_lnk_for_launch`（allowlist）：必须是真实存在的 .lnk 文件且不含
       `"` `&` `|` `^` `<` `>` `%` `!` 与换行；不满足即报错，提示用户在系统设置中
       手动卸载（按工单修复方向落地）。
    2. `shell_execute_open_wait`：`ShellExecuteExW`（`open` 动词 +
       `SEE_MASK_NOCLOSEPROCESS`）直调并等待进程退出——与 `start /WAIT` 同一系统
       路由，但路径以单个宽字符串直传 shell32，不存在 cmd 元字符解析面。等待用
       250ms 轮询切片跨 `.await`，不阻塞独占执行器线程；句柄经 `SendHandle` 包装
       承载跨 await（内核句柄进程级有效，跨线程等待安全）。
  - 非句柄为空的场景（处理器直接委托已运行实例不回传 hProcess）按已交由系统处理
    视作成功，与 `start` 行为对齐。
  - 依赖：新增 `[target."cfg(windows)"] windows-sys = "0.59"`（features: Foundation /
    UI_Shell / System_Threading / System_Registry——结构体 HKEY 字段要求后者）。
    0.59.0 已在依赖树内，无新增编译单元成本。
- 2026-09-20 P0-3 复查：Unix 分支现已是 `parse_uninstaller_command` 拆分 +
  `Command::new(exe).args(args)` 直调，`sh -c` 拼接注入已不存在，无需处理。
- 测试：`parse_uninstaller_tests`（跨平台 4 例：带引号拆参/无参、msiexec、单 token
  兜底）+ `lnk_launch_guard_tests`（windows 门控：元字符/缺失文件/非 lnk 一律拒绝，
  真实存在的合规 lnk 放行）。
- 验证：`cargo test` 337 通过 0 失败；`cargo clippy --all-targets` 告警与改动前
  基线一致（lib 19 / lib test 20），改动文件零告警。
