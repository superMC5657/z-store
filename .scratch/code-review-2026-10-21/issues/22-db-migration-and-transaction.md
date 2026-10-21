# Issue 22: db 无 user_version 迁移机制 + import 未包事务

Status: resolved
Priority: P3（数据层）
来源: 2026-10-21 全项目审查 · Rust 架构分片

## 描述

1. `src-tauri/src/db/schema.rs:200`：无 `PRAGMA user_version` 版本机制，仅 `ensure_column`
   幂等补列。当前可用（作者已知），但后续任何破坏性迁移（改类型/删列/重建表）没有落点。
2. `src-tauri/src/commands/history.rs:308-341`：`import_user_data` 多表多行写入未包
   事务，中途失败留半量导入数据。

## 修复方向

- 引入 user_version 迁移表（v0 = 现状），后续破坏性变更按版本号走迁移函数链。
- `import_user_data` 包 `UNSIGNED TRANSACTION`/rollback 事务，失败整体回滚并报错。

## Comments

- **user_version 迁移机制**（`src-tauri/src/db/schema.rs`）：新增
  `CURRENT_USER_VERSION = 1` + `run_migrations` 迁移链——读 `PRAGMA user_version`
  → `version..CURRENT` 逐版 match 迁移函数（链空洞 `unreachable!` 兜底）→ 盖章；
  高版本库被旧构建打开时 warn 后仅跑幂等基底（不降级盖章，只读兼容）。
  **v0 = 现状起步**：既有 18 表 `CREATE IF NOT EXISTS` 基底 DDL 与两处 ensure_column
  幂等补列全部保留在基底路径（任何版本启动都自愈），`migrate_v0_to_v1` 为机制采用
  空迁移（无形态变更），破坏性变更后续按 `migrate_vN_to_vN+1` 续链。新增
  `user_version()` pub(crate) 读口供批次 13（issue 36）schema 迁移测试使用。
  测试 2 例：新库盖章 + 重复 init 幂等；手工构造缺列未盖章存量库走 v0→v1
  （补列 + 存量行收录标记 fail-closed 默认 0 锁值）。
- **import 事务化**（`src-tauri/src/commands/history.rs#import_user_data`）：复用
  既有 `with_immediate_transaction`（BEGIN IMMEDIATE/COMMIT/ROLLBACK，与仓库
  Top1+2 写同一原语），事务体抽 `apply_import_plan`（命令与单测共用的生产一致
  路径）；`require_app_id` 归一校验前置于任何写入（fail-fast，坏载荷零写入——
  修复前坏 id 会在写完前几条后中途 Err 留半量）。错误上浮口径不变
  （rusqlite → String → AppError）。测试：既有同机恢复用例改直调 `apply_import_plan`；
  新增回滚锁值（写入后注入失败 → Err 上浮 + 半量收藏零残留）。
- clippy -D warnings 干净（`--all-targets` 口径顺修 2 处上个批次遗留测试代码
  useless_format/useless_vec，clippy 1.98 新暴露，单独小提交不混工单体）。
  cargo test 相关 4 例全绿（schema 2 + import 2）。
