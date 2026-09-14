# 统一日志（z-store logging）

> 范围：本项目内落盘日志。**不上报**：自动上报网络开关默认关闭（`TODO(opt-in)`），
> 仅落盘 + 导出，需用户显式开启后再接上报通道。禁止引入 tracing / sentry / 自动上报。

## 1. 落盘目录（OS 路径）

后端 `app.path().app_log_dir()`（tauri-plugin-log v2 `TargetKind::LogDir`），identifier `com.zstore.app`：

| OS | LogDir |
|---|---|
| Windows | `%LOCALAPPDATA%/com.zstore.app/logs` |
| macOS | `~/Library/Logs/com.zstore.app` |
| Linux | `~/.local/share/com.zstore.app/logs`（XDG） |

查询命令：`zlog_get_dir`（透出 `app_log_dir` 绝对路径，供设置页 / 问题反馈用）。

## 2. dev / release 矩阵

| | release | dev（`debug_assertions` / `import.meta.env.DEV`） |
|---|---|---|
| 后端 targets（`z_log::init`） | 仅 `LogDir` | `Stdout` + `LogDir` + `Webview` |
| 前端 `attachConsole` | 不调用 | 仅 DEV 调用（`src/lib/z-log.ts::initZLog`） |
| capabilities | `log:default`（`src-tauri/capabilities/default.json`） | 同左 |

v2 API 对齐：`tauri_plugin_log::Builder::targets([...]).build()` 以插件形式接入
（`lib.rs::run` 中 `.plugin(z_log::init())`）。

## 3. 级别

- 后端：`log::error!`（panic hook）等标准 `log` 级别直写。
- 前端：`enqueue` 按 `info/warn/debug` 攒批（批量经一次 `info()` 上送，级别保留在行前缀
  `[level]` 中）；`error` 级别直透 `error()`，不进批量，保证关键错误不被延迟。
- `window.onerror` / `unhandledrejection` 直透 `error()`。

## 4. batch 机制（200 条 / 3s）

前端量大故攒批，减少 IPC：`src/lib/z-log.ts`，入口 `main.tsx` 最早调用
`initZLog({ batch: 200, flushIntervalMs: 3000 })`。

- 满 `batch`（200 条）即 `flush()`；
- 每 `flushIntervalMs`（3000ms）`setInterval` 刷一次；
- `pagehide` + `beforeunload` 补刷尾批（`void flush()`，尽力而为）；
- `flush()` 失败吞错，不影响业务（丢弃本批）。

## 5. 脱敏（redact）

- 后端 `z_log::redact`：遮蔽 `Bearer / bearer / Token / token ` 后连续 token 为 `***`；
  panic hook 入参先脱敏再记 `error`。
- 前端同规则轻量脱敏（`redact()`）：`enqueue` 与 `error` 直透路径均先脱敏，避免密钥落盘。

## 6. 保留与清理（prune 14d / 25MB，只碰 *.log）

`z_log::prune` 在 `setup` 中对 `app_log_dir` 执行：

- `KEEP_DAYS = 14`：mtime 超 14 天删；
- `MAX_TOTAL_BYTES = 25MB`：超量按 mtime 最旧先删；
- **只碰 `*.log`**（按扩展名 `log` 大小写不敏感判定）：`.zip` 导出包、`.txt`、
  业务 SQLite（`z_store.db` 在 AppDataDir，与 LogDir 分离）一律不动。

## 7. 导出命令

- `zlog_get_dir(app) -> String`：返回 LogDir 路径。
- `zlog_export_bundle(app) -> String`：把 LogDir 内 `*.log` 打成
  `zstore-logs-<unix_secs>.zip`（deflate，附 `README.txt` 记 identifier / keep_days /
  max_total_bytes），返回 bundle 路径；跳过自身与一切 `.zip`。

两命令均已在 `lib.rs::invoke_handler` 注册。

## 8. 禁 sqlite 声明

- 日志**只进 LogDir**，禁止写入业务 SQLite（`z_store.db`：已安装记录 / 设置 / 令牌 /
  更新规则 / 足迹等 14 张核心表，与日志物理隔离）。
- panic hook 仅记 `log::error!` 落盘，不写 DB、不上报。

## 9. 接线位置速查

- `src-tauri/src/z_log.rs`：init / prune / redact / panic hook / 导出命令。
- `src-tauri/src/lib.rs::run`：首行 `install_panic_hook()` + `.plugin(z_log::init())` +
  `setup` 内 `prune` + commands 注册。
- `src-tauri/src/main.rs`：首行 `install_panic_hook()`（与 `run` 双入口，`OnceLock` 幂等）。
- `src/lib/z-log.ts` + `src/main.tsx`：前端 batch 入口。
