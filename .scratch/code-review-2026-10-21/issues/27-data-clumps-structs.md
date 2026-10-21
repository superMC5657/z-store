# Issue 27: Data Clumps：6 元组与 (id,owner,repo) 裸传、models 字段重复

Status: resolved
Priority: P3（类型卫生）
来源: 2026-10-21 全项目审查 · Standards 轴 + Rust 架构分片

## 描述

1. `src-tauri/src/github/catalog_service.rs:586-599`：`get_endpoints` 返回 6 元
   `String` 元组——已有 `AppRepoCoordinates` 类型却拆散；唯一调用方
   `detail_fetch.rs:119` 按位解构，加字段即错位。
2. `src-tauri/src/commands/catalog_search.rs:502-514,585-596`：`(id,owner,repo)` 三元
   组裸传（已有 `IconFetchJob` 形状可复用）。
3. `src-tauri/src/models.rs:4-104`：`AppSummary`/`AppDetail` 约 20 字段重复，可抽公共
   子结构（如 `AppCore`）。

## 修复方向

- `get_endpoints` 返回 `AppRepoCoordinates`；搜索侧两处改传 `IconFetchJob`（或小结构
  `RepoCoord`）。
- models 抽公共子结构时注意 serde 平面 JSON 契约不变（用 `#[serde(flatten)]`）。

## Comments

2026-10-21 修复（batch 11）：

1. `get_endpoints` 6 元 String 元组删除（与 `get_repo_coordinates` 恒等的双名命令面）：唯一调用方 `detail_fetch.rs::resolve_detail_identity` 改调 `get_repo_coordinates` 返回 `AppRepoCoordinates`，DetailIdentity 平铺字段形态不变（desc ← coords.description）。
2. `(id,owner,repo)` 裸三元组收口：icon_fetch.rs 新增 `RepoCoord`（id 归一小写 + owner/repo，附 `into_job(ctx)` 组装 IconFetchJob），搜索侧 candidates 与趋势侧 enrich_targets/enrich_pre_confirmed/fetch_enrich_batch/batch_jobs/后台流式 jobs 全链改结构体传递，按位解构消灭。`icons_cycle_probe::resolve_app_coord` 同形三元组属图标轮换适配层（本单点名范围外）未动。
3. models 抽 `AppCore`（22 公共字段单一来源）+ `#[serde(flatten)]` 内嵌，AppSummary 只余 is_installed/has_update/installed_version，AppDetail 只余 changelog/readme/readme_variants/releases/cached_at/is_stale；serde 平面 JSON 契约不变（字段名与 attrs 逐字沿用），新增 models.rs 平面契约回归测试（序列化无 core 包装键 + 旧平面载荷原样可反序列化，IPC/缓存双验）。Rust 侧访问统一 `x.core.<field>`：编译器引导迁移 256 处访问点 + 17 处构造点（rustc E0609/E0560 span 精确插 `core.` + 手工包 core: AppCore，逐处核验 receiver 类型非正则猜测）。前端 TS 类型零变化。

验证：cargo check --tests 0 err；clippy --tests -D warnings 绿；cargo test 366 passed（含新平面契约测试）。
