# Issue 34: CMD 表对齐：4 条命令绕过 CMD 表 / 无 UI 接线

Status: resolved
Priority: P2（规范自约违反）
来源: 2026-10-21 全项目审查 · services 分片

## 描述

后端注册 96 条 / 前端 CMD 表 92 条，不匹配 4 条（均为后端有前端 CMD 无）：

1. `get_trend_board_cache` / `save_trend_board_cache`：`src/services/trends/cache.ts:151-152`
   用本地常量直调，绕过 CMD 表——违反 `src/services/api.ts:60`「CMD 表为唯一来源」自约。
2. `zlog_get_dir` / `zlog_export_bundle`：lib.rs:652-653 注册后前端零调用，日志导出
   功能无 UI 接线（死命令面）。

参数名抽查 12 个复杂命令全部对上；后端无一处 `rename_all="snake_case"` 误配；camel
守卫齐备——问题仅上述 4 条。

## 修复方向

- trends 两命令入 CMD 表（api.ts 加条目 + cache.ts 改走 `tauriInvoke`）。
- zlog 两条：接 UI（设置中心「数据备份」或诊断入口）或从 invoke_handler 摘除。
- 评估在 CI 加一条对齐测试（CMD 表 keys ⊆ invoke_handler 注册集），防再漂移。

## Comments

- trends 两命令入表：CMD 新增 `getTrendBoardCache`/`saveTrendBoardCache`，`cache.ts` 删
  本地常量 `CMD_GET/SAVE_TREND_BOARD_CACHE` 改走 `CMD.*`（经 `../api` 引 CMD 与既有
  settings.ts wrapper 同型；`api/*` 不反向引 trends，无环）。
- zlog 两条选**接 UI** 而非摘除：后端实现完整（zip 打包 + 出包前 redact 脱敏禁
  token/code/邮箱、只收 *.log/.bak、附 README 元数据），源码注释自述「设置页/问题反馈
  用」，是有真实价值的诊断功能，摘除等于砍功能。接线走正规三层：新 wrapper
  `services/api/zlog.ts`（`getLogDir`/`exportLogBundle` 经 CMD）→ `tauriApi` 挂
  `getLogDir`/`exportLogBundle` → 设置中心「数据管理与备份」区新增 `LogExportRow`
  （导出日志包 / 打开日志文件夹，后者复用既有 `open_folder`；i18n zh/en 齐备，
  交互样式对齐同区 DataBackupRow）。
- 对齐测试落地 `src/services/api/cmdAlignment.test.ts`：从 lib.rs
  `generate_handler![...]` 解析注册集（匹配任意 `模块路径::命令名` 末段，不锁死
  `commands::`/`z_log::` 两前缀），断言 `Object.values(CMD) ⊆ 注册集`；设
  「注册集 ≥50」哨兵防正则静默失配误绿；附「CMD 值无重复」完整性断言。
- 门禁口径按工单向 ⊆（前端拼错/后端摘除即红）；当前实际 96/96 恰好相等，后端死命令
  面已由本次接线清零——若未来要锁死反向漂移（后端新增无前端命令），可再加 equality
  断言，未在本张做（会给合法的后端预留命令面留缓冲）。
- 测试：cmdAlignment 3 用例 + trends 全量同 run 119 用例通过，`pnpm build`
  （tsc + vite）绿。
