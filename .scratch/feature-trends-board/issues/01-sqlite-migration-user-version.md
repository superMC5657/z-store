# Issue 01: SQLite 引入 user_version 迁移链（只加不改）

Status: resolved

> 注：设计提案、主干以本 ADR（docs/adr/0014-trends-l2-and-governance.md）为准。

## 背景

`src-tauri/src/db/schema.rs:init_schema()` 全是 `CREATE TABLE IF NOT EXISTS`，`db/mod.rs:open()` 直接调用，无 `user_version`、无 `ALTER`（P0-1）。任何加列/加索引老库静默保持旧形状，新代码直接 SQL 报错，只能删库重建。

## 目标

- 引入 `PRAGMA user_version` 版本号，`open()` 内幂等执行迁移链（只加列/加索引，不改不删）。
- 首个迁移基线对齐当前 `schema.rs` 13~15 表现状（含 `trend_board_cache`、`search_result_cache` 若存在），保证新库/老库/空库三态通过。
- 新增单测：老库（缺新列/索引）打开后自动迁移成功，重复打开幂等。

## 范围

- 允许改：`src-tauri/src/db/schema.rs`、`src-tauri/src/db/mod.rs`、相关单测。
- 不碰：业务表语义、前端缓存逻辑、`trend_board_cache` 字段语义（本单只搭迁移架子，不加业务列）。

## 验收

- `cargo test -p z-store --lib db::` 通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` 通过。
- 手动验证：用旧库文件打开一次，`PRAGMA user_version` 前进且数据不丢。

## 阻塞关系

Blocked by: none
后续：02-L2膨胀治理、03-Other误判 Depends on this（迁移架子先行）。

## Comments

- 来源：趋势榜 P0 问题清单 #1。
- 实现摘要（2026-10-08）：`schema.rs` 新增 `SCHEMA_VERSION=1` 基线 + `user_version/set_user_version/table_exists/column_exists/ensure_column/apply_migrations/migrate_to_v1` 迁移链（只加列/加索引：缺表由 `init_schema` 建全量、缺列 `ALTER TABLE ADD COLUMN` 补可空或带 DEFAULT 列、缺索引 `CREATE INDEX IF NOT EXISTS` 补）；`mod.rs:open/open_in_memory` 改调 `apply_migrations()`，空库/老库（version=0）/新库三态兼容、重复打开幂等、高版本不降级。表清单以代码为准共 14 张（无 `search_result_cache`，`trend_board_cache` 在基线内，字段语义未动）。单测新增 `test_schema_version_new_db_is_current` + `test_migration_old_db_auto_migrates_and_idempotent`（老库缺 `uninstall_command` 列/缺 `trend_board_cache` 表场景，断言数据保留、版本前进、二次打开幂等）。
- 验证：`cargo test -p z-store --lib db::` 17 passed；`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` 通过。
