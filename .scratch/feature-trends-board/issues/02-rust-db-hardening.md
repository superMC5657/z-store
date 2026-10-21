# Issue 02: Rust DB 加固（L2 限大小 + 读侧 TTL + board 索引 v2）

Status: resolved

> 注：设计提案、主干以本 ADR（docs/adr/0014-trends-l2-and-governance.md）为准。

## 背景

P0-2/P1-3/P1-7 的 Rust 侧：`save_trend_board_cache` 判空即写无上限（`db/cache.rs:159`）；`get` 透存不判 TTL（`db/cache.rs:139`）；`trend_board_cache.board` 无索引。01 已搭好 `user_version` 迁移链，本单在其上做 v2 演进。

## 目标

- 写侧加字节上限：超限拒绝写入并返回可识别错误（不静默吞，调用方 fire-and-forget 处可忽略但需可日志）。
- 读侧加可选 `max_age_secs`（默认 None 保持兼容）+ `get_…_fresh(key,ttl)`，过期按 miss 处理；负值/未来时间按过期。
- 迁移 v2：`board` 列加索引（幂等 `CREATE INDEX IF NOT EXISTS`），`user_version` 1→2，老库自动补。
- 单测：超限拒绝、fresh 过期/命中、v1→v2 幂等迁移。

## 范围（互斥）

- 仅允许改：`src-tauri/src/db/**`（`cache.rs/schena.rs/mod.rs/tests.rs`）。
- 禁止碰：前端 `cache.ts/boards.ts/enrich.ts`、打分/抓取逻辑。FE TTL 常量不动。

## 验收

- `cargo test --manifest-path src-tauri/Cargo.toml --lib db::` 通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` 通过。

## 阻塞关系

Blocked by: 01（已 resolved，本单可直接开工）
后续：无（与 03/04/05 文件互斥可并行）。

## Comments

- 来源：趋势榜问题清单 P0-2(DB侧)/P1-3(Rust侧)/P1-7(索引)。

## Resolution (2026-10-08)

- 写侧上限：`db/cache.rs` 新增 `TREND_BOARD_CACHE_MAX_BYTES`（512 KiB）+ `TREND_BOARD_PAYLOAD_TOO_LARGE_MARKER`；`save_trend_board_cache` 对 `payload_json.len()` 超限返回 `rusqlite::Error::ToSqlConversionFailure`（文本必含标记，不落库，空 key/空 payload 旧语义不变），`is_trend_board_payload_too_large(err)` 供调用方识别/日志。签名未变，`commands/trends_cache.rs` 零改动。
- 读侧 TTL：`get_trend_board_cache` 保持兼容（委托 `with_ttl(key, None)` 不判过期）；新增 `get_trend_board_cache_with_ttl(key, Option<i64>)` + `get_trend_board_cache_fresh(key, ttl)`，`ttl<=0`/未来 `cached_at`/`now-cached_at>=ttl` 一律按 miss（`Ok(None)`）。
- 迁移 v2：`SCHEMA_VERSION` 1→2；`init_schema` 内建 `idx_trend_board_cache_board ON trend_board_cache(board)`；`migrate_to_v1` 落版 1、`migrate_to_v2` 幂等补索引（`IF NOT EXISTS` + 表缺失跳过）后落版 `SCHEMA_VERSION`；`apply_migrations` 按序执行 v1→v2，老库自动补。
- 单测（`db/tests.rs`，3 个新增）：`test_trend_board_cache_payload_limit_rejects`（超限可识别拒绝+不落库+等值边界写入）、`test_trend_board_cache_fresh_ttl`（命中/0/负值/陈旧回拨/未来时间；plain get 兼容仍可见）、`test_migration_v1_to_v2_idempotent`（手造 user_version=1 无索引库 → open 自动升 v2 建索引数据保留 → 二次 open + 重跑迁移链幂等）。

### 验证

- `cargo test --manifest-path src-tauri/Cargo.toml --lib db::`：20/20 通过（含 3 个新增）。
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`：`db/**` 零警告；整仓唯一报错在范围外并行改动 `src/github/catalog_feed_score.rs:17`（`doc_lazy_continuation`，属 03/04/05 并行单），本单按范围禁令未碰，待该单修复后整仓即过；已用 `git stash` 验证干净基线 clippy 无错，确认该报错非本单引入。
