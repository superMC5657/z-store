# Issue 16: icon 坐标归一化旁路放行未知 forge 前缀入库

Status: resolved
Priority: P2（数据完整性，规格违反）
来源: 2026-10-21 全项目审查 · Spec 轴 + Rust 安全分片

## 描述

ADR-0010 修订注称 icon 键归一「收敛为 canonical_app_id 唯一实现（薄委托）」，但
`src-tauri/src/db/icon_cycle.rs:353-375` 的 `resolve_icon_coord` 重新实现归一，其
`split_once(':')` 兜底放行解析器（`forge/coord.rs`）拒绝的未知 forge 前缀——如
`xyz:owner/repo` 直接入库，与 `require_app_id` 的拒绝语义相悖。归一化出现第二真相源。

## 修复方向

- `resolve_icon_coord` 改为薄委托 `canonical_app_id()`（对齐 ADR-0010 的「唯一实现」
  声明），未知前缀走与 `require_app_id` 相同的拒绝路径。
- 补一条回归测试：`xyz:owner/repo` 入 `app_icon_cycles` 相关命令应被拒。

## Comments

- **resolve_icon_coord 薄委托**（`src-tauri/src/db/icon_cycle.rs`）：删除
  `split_once('/')` 本地兜底（旧逻辑把 `xyz:owner/repo` 切成 `("xyz:owner","repo")`
  放行），改为 `RepositoryUrlParser::parse` 单出口——与 `canonical_app_id`/
  `require_app_id` 同一解析体，未知 forge 前缀走同一条拒绝路径
  （`无法识别的应用标识`）。canonical 仍经 `coord.to_app_id().to_lowercase()`
  计算，三键同值（DB 主键/事件 id/前端归一键）不变；ADR-0010「唯一实现」声明
  恢复成立。附带口径收敛：`owner//repo` 由旧兜底拒绝改为解析器放行（空段过滤
  归一），与全站解析语义一致。
- **owner_repo_for_new_cycle 未动**：其 `split_once` 兜底仅在 `load_or_new_cycle`
  新建分支触达，调用前提是 `resolve_app_coord`（即本函数）已过闸，未知前缀在
  上游已被拒，无第二真相源。
- **回归测试**：icon_cycle.rs 新增 tests 模块 3 条——
  `test_resolve_icon_coord_rejects_unknown_forge_prefix`（`xyz:`/`foo:` 前缀拒绝）、
  `test_resolve_icon_coord_matches_require_app_id_acceptance`（9 组输入接受性
  与 `require_app_id` 逐项锁值）、`test_resolve_icon_coord_canonical_matches_canonical_app_id`
  （canonical 与 `canonical_app_id` 逐项同值 + 裸 owner/repo 与 `gh:` 形态归一同键）。
  cargo test --lib 360 全绿。
