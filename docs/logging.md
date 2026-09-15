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
- 磁盘库（`z_store.db`）打不开回退内存库时记一条 `error`
 （`src-tauri/src/lib.rs::run` 约 L331–L336，
  `db open failed fallback to in-memory`）：静态文案，不记任何路径值；
  行为不变（仍回退内存库），静默丢数据是最坏一类故障故定为 error 级必记。

## 9. 接线位置速查

- `src-tauri/src/z_log.rs`：init / prune / redact / panic hook / 导出命令。
- `src-tauri/src/lib.rs::run`：首行 `install_panic_hook()` + `.plugin(z_log::init())` +
  `setup` 内 `prune` + commands 注册。
- `src-tauri/src/main.rs`：首行 `install_panic_hook()`（与 `run` 双入口，`OnceLock` 幂等）。
- `src/lib/z-log.ts` + `src/main.tsx`：前端 batch 入口。

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
| 安装结果 `installer/executor.rs`（唯一出入口） | info/error | `install done id=…` / `install failed id=… reason=…首行…` |
| 校验失败 `verifier.rs::verify_fingerprint` | error | `verify failed reason=…`（指纹冲突只记结论，不回显指纹值） |
| 限额低水位 `lib.rs::log_rate_limit_water_mark`（每进程每 host 每种一次） | warn | `rate limit low host=github.com remaining=6/60` |
| 限额用尽 `lib.rs::log_rate_limit_water_mark`（每进程每 host 一次） | error | `rate limit exhausted host=github.com remaining=0 limit=60` |
| 登录成功 `commands/oauth.rs` | info | `oauth login ok user=octocat`（只记 login，不记 token/device_code/user_code） |
| 登出 `commands/oauth.rs` | info | `oauth logout ok` |
| 换 token/刷新/轮询失败 `commands/oauth.rs` | warn | `oauth poll failed reason=…` / `oauth refresh failed reason=…` / `oauth device start failed reason=…` |
| 镜像切换 `mirror.rs::set_active_mirror` | info | `mirror switch ok id=direct` / `mirror switch ok id=custom`（不记代理 URL） |
| 测速结果 `commands/network.rs::test_proxy`（调用方记） | info/warn | `proxy test ok latency_ms=210` / `proxy test failed latency_ms=9999 reason=…`（不记被测 URL） |

### 第二层：debug（release 不可见）

| 点位 | 消息样例 |
|---|---|
| 单仓/详情/搜索成功 `commands/catalog.rs` | `fetch detail ok id=…` / `fetch repo ok id=…` / `search done hits=3` |
| scanner 单项未命中 `scanner/matcher.rs` | `scanner no match name=…`（不记路径/图标原文） |
| 测速毫秒 `commands/network.rs::ping_mirrors` | `proxy ping done latency_ms=210` |
| 关注挂起 `commands/updates.rs::notify_watched_updates` | `watch deferred id=… reason=daily-throttle\|baseline-init\|…首行…` |
| device 取消 `commands/oauth.rs` | `oauth device denied`（正常流程，不记 token/user_code） |

### 第三层：禁止（零打点）

- 下载进度循环 / 字节回调：零 `log!`（进度只走 `zstore://download-progress` 事件）。
- 完整 URL（含 release 资产签名 query）、token / user_code / device_code、
  响应 body、文件全路径、私钥、`tick`：一律不记。
- `println!` / `eprint!` / `dbg!`：业务代码禁用（`scanner/tests.rs`、
  `mirror.rs::tests` 内既有测试 `println!` 保留不动）。
- 拉取层（`github/catalog.rs`、`detail.rs`、`search.rs`、`forge/`、
  `mirror.rs::test_proxy_latency`）零打点：错误上浮到命令层记一次，避免双记。

## 11. 脱敏红线

- 本仓最高风险：release 资产 URL 签名 query。reqwest 0.12 `Display`
  回显完整 URL，错误必须先过 `log_support::http_err_reason` 脱敏（自写，
  不跨仓 import），日志与返回前端的错误串均不得含签名 query。
- 公共辅助 `src-tauri/src/log_support.rs`：`host_of(url)->host/unknown` +
  `short_reason`（首行 + 160 chars 截断，字符边界安全）+ `file_base`
  （basename，兼容 `/` 与 `\`）；复用于下载链 / 安装入口 / 代理与网络调用方。
- `z_log::redact` 保持不变（`Bearer/token` 后 token 打码；panic hook 先脱敏）。

## 12. 行号索引（以本版代码为准）

- `src-tauri/src/log_support.rs`：全文件（辅助定义 + 单测）。
- `src-tauri/src/lib.rs`：`mod log_support`（约 L8）；`notify_rate_limit`
  （约 L61）；`log_rate_limit_water_mark`（约 L76，error L101 / warn L103）；
  磁盘库回退内存库 error（约 L331–L336，`db open failed fallback to in-memory`）。
- `src-tauri/src/installer/downloader.rs`：开始 info（L39）、失败 error
  （L51/L77/L130/L168/L196/L226）、校验失败 error（L294）、完成 info（L333）。
- `src-tauri/src/installer/executor.rs`：出入口 info/error（L16–L17）。
- `src-tauri/src/verifier.rs`：校验失败 error（L58/L71/L101）。
- `src-tauri/src/commands/updates.rs`：单项 warn（L336）、轮结束 info（L364）、
  挂起 debug（L421/L438/L452）。
- `src-tauri/src/commands/catalog.rs`：成功 debug（L64/L88/L383）、失败 warn（L421）。
- `src-tauri/src/commands/oauth.rs`：start/poll 失败 warn（L34/L57）、
  登录 info（L69/L71）、取消 debug（L100）、poll 错误 warn（L107）、
  刷新 warn（L161）、登出 info（L189）。
- `src-tauri/src/mirror.rs`：切换 info（L62/L67/L71/L75）。
- `src-tauri/src/commands/network.rs`：测速 info/warn（L19/L21）、ping debug（L59）。
- `src-tauri/src/scanner/matcher.rs`：未命中 debug（L169）。
