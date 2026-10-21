# Issue 44: DB 事务/迁移链/配置路径健壮性（22/12 残项）

Status: resolved
Priority: P2（持久化与启动健壮性）
来源: 2026-10-21 复审 · 1ac41eb...HEAD 双轴复审 · Rust 核心分片

## 描述

1. `db/mod.rs:213-224`：`COMMIT` 失败用 `?` 直接返回，没有 `ROLLBACK`，连接被留在事务里，
   后续写会撞「transaction within a transaction」。
2. `db/schema.rs:236`：迁移链空洞是启动路径上的 `unreachable!`，版本跳号即每次启动 panic；
   同处注释「只读兼容」与实际（跳过盖章但仍写幂等基底 DDL）不符。
3. `config.rs:516`：`[catalog] local_path` 仍按 CWD 解析，与 12 号「候选路径绝对化、去 CWD 依赖」
   只做了一半（`config.toml` 里就是 `../catalog.json`）。
4. `config.rs:610`：外部 `config.toml` 不存在时每次正常启动打 WARN——缺失可选文件不是可恢复失败
   （`docs/logging.md` 口径）。
5. `config.rs:208-212`：`default_oauth_client_id` 与嵌入 TOML 各存一份，注释却称「单一事实源锁」。
6. `commands/catalog_detail.rs` / `commands/history.rs` 各写一遍 22 字段 `AppCore` 字面量
   （27 号要收的形状），`catalog_detail.rs:149/206` 重复同一段 304/ADR-0007 说明。

## 修复方向

- COMMIT 失败先尽力 ROLLBACK；迁移链空洞返回可读错误；注释改述现状。
- 相对 `local_path` 锚到配置文件所在目录；缺文件降级 debug，解析失败仍 WARN。
- 客户端 ID 注释改述「两份副本由测试锁同步」；`AppCore` 字面量收敛为 `..core.clone()`。

## Comments

- `db/mod.rs`：COMMIT 失败 `let _ = ROLLBACK` 后返回错误；`db/tests.rs:1291` 用延迟外键
  制造 COMMIT 失败并证明连接仍可用。
- `db/schema.rs`：空洞改 `SqliteFailure(SQLITE_ERROR, …)`（附版本与期望函数名）；
  函数 doc 与测试注释改述「跳过盖章/迁移，仍跑幂等基底 DDL」。
- `config.rs`：新增 `rebase_local_path`（外部文件相对路径锚到配置目录，嵌入兜底保持 CWD 基准）；
  缺文件日志降 debug；`default_oauth_client_id` 注释改述双副本 + 测试锁定。
- `catalog_detail.rs`：`cached_detail_summary` 与 `history.rs::detail_to_summary` 改
  `AppCore { ..core.clone() }`（保留 icon/is_cataloged/source/status 覆写，逐字段等价）；
  重复 doc 段收敛为一处 + 引用。
- 回归：`rebase_local_path` 锚定、`embedded_config_toml_declares_every_section`（57ef4f4）、
  高版本库只读分支、COMMIT 回滚。
- 验证：`cargo test` 378 过；`clippy -D warnings` 绿。
- 提交：e046c80（config 逐段测试 57ef4f4）。
