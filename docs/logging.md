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

| | release | dev（`debug_assertions` / `import.meta.env.DEV`） |
|---|---|---|
| 后端 targets（`z_log::init`） | 仅 `LogDir`（Level::Info） | `Stdout` + `LogDir` + `Webview`（Level::Debug） |
| 单文件与轮转 | 单文件 5MB 滚动（`KeepSome(5)`） | 同左 |
| 时区策略 | 本地时区（`TimezoneStrategy::UseLocal`） | 同左 |
| 第三方降噪 | reqwest / hyper / tao / wry / h2 / rustls 过滤为 `Warn` | 同左 |
| 前端 `attachConsole` | 不调用 | 仅 DEV 调用（`src/lib/z-log.ts::initZLog`） |
| capabilities | `log:default`（`src-tauri/capabilities/default.json`） | 同左 |

v2 API 对齐：`tauri_plugin_log::Builder::new()` 配置轮转、时区、模块过滤与 targets 后以插件形式接入
（`lib.rs::run` 中 `.plugin(z_log::init())`）。

## 3. 级别与直透

- 后端：`log::error!`（panic hook）、`log_session_start()`（会话横幅）等标准 `log` 级别直写。
- 前端：直透刷盘模式。`info / warn / error / debug` 均为纳秒级即时进 IPC 直写，杜绝 3 秒攒批导致的时序颠倒（因果倒置）与崩溃丢日志问题。
- Target 规范化：Webview 上送的调用栈 Target 统一被后端重写为精简的 `[ui]`，提升日志可读性。
- `window.onerror` / `unhandledrejection` 直透 `error()`。

## 4. 前端直透与脱敏

入口 `main.tsx` 最早调用 `initZLog()`。
- DEV 环境自动执行 `attachConsole()` 桥接；
- 各级别方法（`zlogInfo / zlogWarn / zlogError / zlogDebug`）即时异步落盘；
- 失败吞错，不影响任何业务逻辑。
- `flush()` 有意为 no-op（直透无缓冲，保留仅为调用方兼容，无需手动调用）；初始化幂等由 `isInitialized` 守卫（非 `inited`）。

## 5. 脱敏（redact）

- 后端 `z_log::redact`：`format` 写盘前 + 导出打包前各执行一次。规则（无正则、字符边界安全）：
  邮箱掩码；`code` / `device_code` / `user_code` / `api_key` 系（大小写不敏感，含 JSON `"key": "值"` 形态）掩码；
  `Bearer` / `Token` 后紧跟的 token 原文打码为 `***`；
  panic hook 入参先脱敏再记 `error`。
- 前端同规则轻量脱敏（`redact()`）：`zlogInfo / zlogWarn / zlogError / zlogDebug` 与 `onerror / unhandledrejection` 直透路径均先脱敏，避免密钥落盘。

## 6. 保留与清理（prune 14d / 25MB，只碰 *.log，含 *.log.bak）

`z_log::prune` 在 `setup` 中对 `app_log_dir` 执行：

- `KEEP_DAYS = 14`：mtime 超 14 天删；
- `MAX_TOTAL_BYTES = 25MB`：超量按 mtime 最旧先删；
- **只碰 `*.log`（含 `*.log.bak` / `*.bak`）**（按扩展名 `log` / `bak` 大小写不敏感判定）：`.zip` 导出包、`.txt`、
  业务 SQLite（`z_store.db` 在 AppDataDir，与 LogDir 分离）一律不动。

## 7. 导出命令

- `zlog_get_dir(app) -> String`：返回 LogDir 路径。
- `zlog_export_bundle(app) -> String`：把 LogDir 内 `*.log`（含 `*.log.bak`）打成
  `zstore-logs-<unix_secs>.zip`（deflate，附 `README.txt` 记 identifier / keep_days /
  max_total_bytes），返回 bundle 路径；跳过自身与一切 `.zip`。

两命令均已在 `lib.rs::invoke_handler` 注册。

## 8. 禁 sqlite 声明

- 日志**只进 LogDir**，禁止写入业务 SQLite（`z_store.db`：已安装记录 / 设置 / 令牌 /
  更新规则 / 足迹等 14 张核心表（含 `trend_board_cache` 趋势榜 L2 缓存与 `icon_cache_meta` / `app_icon_cycles` 图标缓存分流两表），与日志物理隔离）。
- panic hook 仅记 `log::error!` 落盘，不写 DB、不上报。
- 磁盘库（`z_store.db`）打不开回退内存库时记一条 `error`
 （`src-tauri/src/lib.rs::run` 约 L331–L336，
  `db open failed fallback to in-memory`）：静态文案，不记任何路径值；
  行为不变（仍回退内存库），静默丢数据是最坏一类故障故定为 error 级必记。

## 9. 接线位置速查

- `src-tauri/src/z_log.rs`：init / prune / redact / panic hook / 导出命令。
- `src-tauri/src/lib.rs::run`：首行 `install_panic_hook()` + `.plugin(z_log::init())` +
  `setup` 内 `prune` + commands 注册。
- `src-tauri/src/main.rs`：首行 `install_panic_hook()`（与 `run` 双入口，`OnceLock` 幂等）。
- `src/lib/z-log.ts` + `src/main.tsx`：前端直透入口（`initZLog / zlog* / flush / isInitialized`）。

## 10. 业务打点三层设计（定稿）

> release 落盘级别为 Info：第一层可见，第二层 `debug!` 仅 dev 可见，
> 第三层禁止（零打点）。级别规则：失败 `error`（下载/安装/校验/超限用尽）、
> 可恢复 `warn`、里程碑 `info`、细节 `debug`；单仓成功禁止 `info` 化。

### 第一层：release 可见

| 点位 | 级别 | 消息样例 |
|---|---|---|
| 更新检查轮结束 `commands/updates.rs` | info | `update check finished total=12 new=2 failures=1` |
| 单仓抓取失败 `commands/updates.rs`（更新项） | warn | `update check item failed id=rustdesk/rustdesk host=github.com reason=检查更新网络不可达且无本地缓存` |
| 单仓详情失败 `commands/catalog.rs` | warn | `fetch detail failed id=rustdesk/rustdesk host=github.com reason=…首行…` |
| 下载开始 `installer/downloader.rs` | info | `download start id=rustdesk/rustdesk file=rustdesk.msi host=objects.githubusercontent.com` |
| 下载完成 `installer/downloader.rs` | info | `download done id=rustdesk/rustdesk file=rustdesk.msi bytes=12345678 elapsed_ms=4321` |
| 下载失败 `installer/downloader.rs`（各终端分支记一次） | error | `download failed id=… file=… host=… reason=…首行…` / `download verify failed id=… file=…` |
| 安装启动 `installer/executor.rs` | info | `install start id=… kind=Msi\|SetupExe\|…` |
| 安装静默失败降级向导 `installer/executor.rs` | info | `install silent failed code=1603, fallback to interactive wizard id=…` |
| 安装用户主动取消 `installer/executor.rs` | info | `install cancelled by user id=… reason=用户取消了 MSI 安装向导` |
| 安装结果 `installer/executor.rs`（唯一出入口） | info/error | `install done id=…` / `install failed id=… reason=…首行…` |
| 校验成功 `installer/downloader.rs` | info | `verify ok reason=expected-empty` / `verify ok algo=sha256` |
| 校验失败 `installer/downloader.rs` | error | `download verify failed id=… file=…` |
| 扫描起止 `commands/scanner.rs` | info | `scanner start` / `scanner done scanned=… unmanaged=…` |
| 卸载起止 `installer/executor.rs` | info/error | `uninstall start/done/failed`（原因首行，不记全路径） |
| 限额低水位 `lib.rs::log_rate_limit_water_mark`（每进程每 host 每种一次） | warn | `rate limit low host=github.com remaining=6/60` |
| 限额用尽 `lib.rs::log_rate_limit_water_mark`（每进程每 host 一次） | error | `rate limit exhausted host=github.com remaining=0 limit=60` |
| 登录成功 `commands/oauth.rs` | info | `oauth login ok user=octocat`（只记 login，不记 token/device_code/user_code） |
| 登出 `commands/oauth.rs` | info | `oauth logout ok` |
| 换 token/刷新/轮询失败 `commands/oauth.rs` | warn | `oauth poll failed reason=…` / `oauth refresh failed reason=…` / `oauth device start failed reason=…` |
| 镜像切换 `mirror.rs::set_active_mirror` | info | `mirror switch id=… proxy='…'`（代理只记脱敏展示值） |
| 测速结果 `commands/network.rs::test_proxy`（调用方记） | info/warn | `proxy test ok latency_ms=210` / `proxy test failed latency_ms=9999 reason=…`（不记被测 URL） |
| 下载命中跳过 `installer/downloader.rs::SkipDone::finish` | info | `download skipped sid=… req=… id=… host=… file=… bytes=… elapsed_ms=…`（零网络，`should_skip_download` 命中：本地存在且大小>0 且 SHA-256 与期望一致） |
| 趋势文本拒绝/失败 `commands/network.rs::fetch_trends_text` | warn | `trends text rejected sid=… req=… reason=…` / `trends text timeout …` / `trends text network fail …` / `trends text upstream … status=…` / `trends text rate-limited … status=429 retry_after='…' retry_after_ms=…` / `trends text read fail …` / `trends text upstream too large …` / `trends text decode fail …`（只记 host，不记 query/URL；429 不占单飞槽计数） |

### 第二层：debug（release 不可见）

| 点位 | 消息样例 |
|---|---|
| 单仓/详情/搜索成功 `commands/catalog.rs` | `fetch detail ok id=…` / `fetch repo ok id=…` / `search done query='rust' hits=3` |
| 关注挂起 `commands/updates.rs::notify_watched_updates` | `watch deferred id=… reason=daily-throttle\|baseline-init\|…首行…` |
| device 取消 `commands/oauth.rs` | `oauth device denied`（正常流程，不记 token/user_code） |
| 拉取层正常请求 `github/*`、`forge/*` | `http fetch … / http forge …`（成功/304 一律 debug；失败 warn，错误上浮到命令层记一次） |
| 趋势文本起止 `commands/network.rs::fetch_trends_text` | `trends text fetch start sid=… req=… host='…' path='…'` / `trends text ok sid=… req=… host='…' bytes=… elapsed_ms=…`（成功/开始一律 debug；失败 warn 见第一层） |

### 第三层：禁止（零打点）

- 下载进度循环 / 字节回调：零 `log!`（进度只走 `zstore://download-progress` 事件）。
- 完整 URL（含 release 资产签名 query）、token / user_code / device_code、
  响应 body、文件全路径、私钥、`tick`：一律不记。
- `println!` / `eprint!` / `dbg!`：业务代码禁用（`scanner/tests.rs` 内既有测试 `println!` 保留不动）。
- 循环内打点：禁止 `info`，只许 `debug` 且须可聚合；单项未命中类 debug 已删除。

## 11. 脱敏红线与网络透明化（sanitize_url）

- **网络请求透明化**：客户端对外拉取的所有远端数据（收录清单、Release 资产、README、更新检查、在线搜索、多源 Forge），均在业务层打印出目标 URL、状态码与耗时，保证排查与网络环境审计可知可控。
- **URL 脱敏与签名保护（`log_support::sanitize_url`）**：
  - 保留完整协议、Host、端口与 Path 路径（包括镜像代理前缀，如 `https://ghproxy.net/https://github.com/...`）；
  - 对 Query 参数执行敏感词扫描，自动将 `token`、`sig`、`signature`、`secret`、`key`、`X-Amz-*` 等敏感签名键值替换为 `***`；
  - 保留常规业务查询参数（如 `q=...`, `per_page=...`, `sort=...`），便于直接在日志中排查搜索请求与参数。
- **上游错误脱敏（`log_support::http_err_reason`）**：reqwest 0.12 `Display` 回显完整 URL，先剥离签名 query 再取首行（160 字符安全截断）。
- **令牌遮蔽（`z_log::redact`）**：`Bearer/token` 之后紧跟的 token 原文统一打码为 `***`。

## 12. 接线位置索引（以当前代码为准，不记行号）

- `src-tauri/src/log_support.rs`：辅助定义 + 单测。
- `src-tauri/src/lib.rs`：`mod log_support`；限流 error/warn（`log_rate_limit_water_mark`）；
  磁盘库回退内存库 error（`db open failed fallback to in-memory`）。
- `src-tauri/src/installer/downloader.rs`：下载开始 info、失败 error（多分支）、完成 info；
  校验成功 / 失败（`download verify failed`）同文件。
- `src-tauri/src/installer/executor.rs`：安装出入口 info/error；卸载起止 info/error。
- `src-tauri/src/installer/selector.rs`：选包决策 debug。
- `src-tauri/src/commands/updates.rs`：单项 warn、轮结束 info、挂起 debug。
- `src-tauri/src/commands/catalog.rs`：成功 debug、回退 debug、失败 warn、同步起止 info。
- `src-tauri/src/commands/oauth.rs`：登录 info、取消 debug、失败 warn、登出 info。
- `src-tauri/src/oauth/device_flow.rs`、`star.rs`：轮询 debug、401/403 warn。
- `src-tauri/src/commands/scanner.rs`：扫描起止 info。
- `src-tauri/src/mirror.rs`：切换 info（`set_active_mirror`）。
- `src-tauri/src/commands/network.rs`：测速 info/warn、ping debug；趋势文本拒绝/限流/上游 warn、起止 debug。

行号以当前代码为准，例如：`rg -n "download start|download done|oauth login ok" src-tauri/src`。
