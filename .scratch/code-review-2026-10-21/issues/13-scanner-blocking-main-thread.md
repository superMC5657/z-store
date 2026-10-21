# Issue 13: scanner 扫描/导入同步命令冻结 UI

Status: resolved
Priority: P2（性能/UX）
来源: 2026-10-21 全项目审查 · Rust 架构分片

## 描述

`src-tauri/src/commands/scanner.rs:6,46`：扫描与导入是同步命令，注册表枚举 + 逐应用
文件系统探测（executable.rs 近 1800 行的解析逻辑）直接跑在主线程，冷盘时冻结 UI。
对照 `settings.rs:114` 的 `select_folder` 已用 `spawn_blocking`，仓库内已有正确姿势。

## 修复方向

- 两个命令体搬进 `tauri::async_runtime::spawn_blocking`（或 `tokio::task::spawn_blocking`），
  命令签名改 async。
- 顺带评估扫描进度是否值得经事件流式上报（对齐流式更新检查的既有模式），非必需。

## Comments

- **两命令体卸载 spawn_blocking**（`src-tauri/src/commands/scanner.rs`）：
  `scan_and_match_local_apps` / `import_matched_apps` 命令签名改 `async fn`，全命令体
  （注册表枚举 + 逐应用 FS 探测/installed_at 回溯 + DB join）移入
  `tokio::task::spawn_blocking`（与 settings.rs select_folder、icons_cycle 既有姿势
  同款）。`State<'_, T>` 非 'static 不可入闭包，改注入 `AppHandle` 闭包内
  `state::<AppState>()`（catalog_search.rs 先例）——`state.catalog.*`/`state.db()?`
  调用点原样保留，零语义漂移；JoinError 上浮 `AppError::new`，内层 Err 双 `?` 透传。
  命令名/参数/返回形状不变，前端零改动（invoke await 语义同）。IPC 键为单单词
  `apps`，naming 约定不受影响。
- **进度流式上报评估：不做**。扫描是一次性 onboarding 动作（设置页首扫导入），
  前端已有 loading 态收口；流式上报需扩 IPC 事件面 + 前端订阅改造，收益不抵面，
  且「流式更新检查」模式针对的是长时多_item 网络操作，扫描冷盘虽慢但为本地
  一次性命令，不属同类。留待真实卡顿反馈再议。
- 单测不可达（命令体需 Tauri State 挂载，crate 未启用 tauri `test` feature，与
  import_user_data 同约束），行为由代码形态锁定：同步→async + spawn_blocking
  包裹，逻辑体逐行原样搬移。cargo test 365 全绿 + clippy -D warnings（含
  --all-targets）干净。
