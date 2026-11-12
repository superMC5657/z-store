# 统一日志（z-store logging）

> 范围：本项目内落盘日志。**不上报**：自动上报网络开关默认关闭，
> 仅落盘 + 导出。禁止引入 tracing / sentry / 自动上报。

## 1. 落盘目录（OS 路径）

后端 `app.path().app_log_dir()`（tauri-plugin-log v2 `TargetKind::LogDir`），identifier `com.zstore.app`：

| OS | LogDir |
|---|---|
| Windows | `%LOCALAPPDATA%/com.zstore.app/logs` |
| macOS | `~/Library/Logs/com.zstore.app` |
| Linux | `~/.local/share/com.zstore.app/logs`（XDG） |

查询命令：`zlog_get_dir`（透出 `app_log_dir` 绝对路径，供设置页 / 问题反馈用）。

## 2. dev / release 矩阵

| | release | dev（`debug_assertions` / `ZSTORE_LOG=debug`） |
|---|---|---|
| 后端 targets（`z_log::init`） | 仅 `LogDir`（Level::Info） | `Stdout` + `LogDir` + `Webview`（Level::Debug） |
| 宽事件诊断扩展（`WideEvent`） | 仅输出核心字段（操作/对象/结果/耗时/短原因） | **不增加行数**，在同一行追加 `steps=`、`url=`、`rate=`、缓存与淘汰原因 |
| 单文件与轮转 | 单文件 5MB 滚动（`KeepSome(5)`） | 同左 |
| 时区策略 | 本地时区（`TimezoneStrategy::UseLocal`） | 同左 |
| 第三方降噪 | reqwest / hyper / tao / wry / h2 / rustls 过滤为 `Warn` | 同左 |
| 前端 `attachConsole` | 不调用 | 仅 DEV 调用（`src/lib/z-log.ts::initZLog`） |
| capabilities | `log:default`（`src-tauri/capabilities/default.json`） | 同左 |

## 3. 行格式与领域标签

统一格式：`[YYYY-MM-DD HH:MM:SS][LVL][tag] <event> <k=v...>`

- **级别短标签**：等宽 3 字符 `INF` / `WRN` / `ERR` / `DBG`。
- **会话 ID（`sid`）**：仅启动横幅 `[app] start ... sid=...` 记录一次，不在每行重复；前端不单独生成 `frontendSid`。
- **链路 ID（`t=...`）**：不使用 `thread_local!`（避免 Tokio 多线程 `.await` 串台），仅长耗时并发任务（如下载、安装）显式生成并传递 6 位 `new_trace_id()`。
- **领域短标签 `[tag]`**（`z_log::domain_tag` 统一映射）：
  - `app`：启动横幅、配置/DB 异常、Panic、用户数据导入、深链解析失败
  - `catalog`：清单同步、自定义源审计、License Gate 审计
  - `search`：在线搜索与直查
  - `detail`：应用详情、Multi-Forge、`platforms-lite` 失败降级
  - `trends`：抓榜失败 / 429 限流 / 截断 / enrich 部分缺席汇总
  - `download`：安装包下载起止、镜像自动兜底、SHA-256 校验失败、本地命中跳过
  - `installer`：安装/卸载起止、MSI 静默降级向导、用户取消、幽灵应用隐藏
  - `updater`：批量更新检查汇总、单项失败
  - `scanner`：本地软件扫描汇总
  - `oauth`：OAuth 登录/登出、401 过期（30s 去重）、403 禁用、轮询/刷新失败
  - `network`：镜像切换、测速、Host API 限流低水位/耗尽、无效环境变量代理
  - `ui`：前端渲染崩溃（`ErrorBoundary`）、全局异常（`onerror`/`unhandledrejection`）、IPC 参数违规、接口失败告警

## 4. 宽事件（Wide Event）与 Dev 诊断设计

- **一件事一行**：底层 HTTP（`github/http.rs`、`forge/*`、`github/search.rs`、`github/readme_fetch.rs`）不直接打印 `start`/`resp` 双行或双级别日志，而是通过 `HttpDiag` / `DetailFetchDiag` 将状态码、耗时与脱敏 URL 回传上层命令，由上层 `WideEvent` 统一发射 **1 行**。
- **Dev 增量诊断**：通过 `WideEvent::dev` / `dev_url` / `step` 仅在 `is_dev_mode()` 生效时在同一行追加：
  - 缓存与决策原因（如 `cache_why=ttl_hit`、`chk=no_asset` / `filtered(...)`）
  - 子阶段耗时拆解（如 `steps=rel:200(873ms),repo:200(842ms),readme:200(442ms),icon:simple-icons,chk:skip(no_asset),db:3ms`）
  - 完整脱敏 `url='...'` 与剩余配额 `rate=56/60`

## 5. 前端直透与脱敏（redact）

入口 `main.tsx` 最早调用 `initZLog()`（见 `src/main.tsx`）：

- 公开 API 为 `zlogInfo / zlogWarn / zlogError` 与 `initZLog`（见 `src/lib/z-log.ts`）；
- `window.onerror` / `unhandledrejection` 脱敏后直透 `error()`；1s 窗口内相同行去重；
- 脱敏规则（前后端双侧同规则）：邮箱掩码 `***@***`；`code` / `device_code` / `user_code` / `api_key` 系掩码（不误杀 `vscode` 等路径段）；`Bearer` / `Token` 后跟凭据掩码为 `***`；
- URL 脱敏（`log_support::sanitize_url`）保留协议、Host、Path 及搜索参数（`q=`、`per_page=`、`sort=`），仅对敏感签名/令牌 query 键替换为 `***`；`http_err_reason` 剥离 reqwest 错误回显的签名 query 后取首行 160 字符。

## 6. 保留、清理与导出（prune 14d / 25MB）

- `z_log::prune` 在 `setup` 中执行：`KEEP_DAYS = 14`、`MAX_TOTAL_BYTES = 25MB`、`MAX_SINGLE_FILE_BYTES = 5MB`、`ROTATION_KEEP_COUNT = 5`。仅清理 `*.log` / `*.log.bak`，不动 `.zip` 与业务 SQLite（`z_store.db`）。
- 导出命令：`zlog_get_dir` / `zlog_export_bundle`（打包前再过一次 `redact()`）。
- 禁止将日志写入业务 SQLite；`z_store.db` 打开失败回退内存库时在 `setup()` 中记一条 `[ERR][app] db open failed fallback to in-memory`。

## 7. 静默策略（禁止刷屏点位）

- 下载进度回调、字节流循环：零日志（走 `zstore://download-progress` 事件）。
- 后台图标补探（`icons/fetch.rs`、`icons/probe.rs`）、单张图标下载/404/格式校验（`icons/mod.rs`、`asset_fetch.rs`）：零独立日志，详情图标来源仅折叠在 `[detail]` 宽事件的 Dev `steps` 中。
- 高频状态流水：本地 0~5ms 搜索（`search_apps`）、DB-only 快照读（`get_cached_updates`）、Trends 正常抓榜/缓存命中/`lite-skip`、页面切换（`switch view`）、点击按钮埋点、常规 Toast 提示、OAuth 正常轮询过程，一律静音不落盘。
- 业务代码禁用 `println!` / `eprint!` / `dbg!`。
