# Issue 04: 收敛后端单仓富卡水合深模块 `CardHydrator` 并将四路 `IconFetch` 世代流迁入 `icons/`

Status: ready-for-agent
Blocked by: 03

## Summary

消除后端列表卡片水合与流式补图在 5 个命令文件中的碎片化与反向耦合：

1. **`IconFetch` 世代计数器与流发射跨命令互引**：
   - `SEARCH_GEN`、`BOARD_GEN`、`STARRED_GEN` 定义在 `commands/catalog_search.rs`，而 `LAUNCHPAD_ICON_GEN` 定义在 `commands/launchpad.rs`；两者互相引用对方的内部静态量与 `emit_icon_job`，`commands/forge.rs` 也跨命令调用 `commands::catalog_search::{cards_from_repo_payloads_offloaded, spawn_starred_icon_stream}`。
2. **四套不一致的本地 `AppSummary` 水合与手工 6 步 `BackfillCtx` 编排**：
   - `catalog_search.rs`（4 处重复调用 `PrefetchKeys → prefetch_backfill → backfill_uncataloged_card_in → stage_repo_card → flush → stamp_summary`）、`catalog_detail.rs`（3 套批量摘要查询函数）、`history.rs`（手写 `recently_viewed_deferred` 与简介治愈）、`launchpad.rs`（**在持有 `state.db()` 互斥锁期间同步调用 `resolve_confirmed_icon_from_db` 做磁盘 I/O 与 Base64 编码**）各自维护一套卡片组装与确认图标叠加代码。

本工单将四路 `IconFetch` 世代流协调完整归位至 `src-tauri/src/icons/`，并在 `src-tauri/src/repositories/` 建立统一的 `CardHydrator` 深模块承接全部只读批量水合与远端仓库载荷写透。

## Scope

- Allowed to modify:
  - `src-tauri/src/icons/mod.rs`
  - `src-tauri/src/icons/fetch.rs`
  - `src-tauri/src/icons/confirmed.rs`
  - `src-tauri/src/icons/tests.rs`
  - `src-tauri/src/repositories/mod.rs`
  - `src-tauri/src/repositories/card_hydrator.rs`（新增）
  - `src-tauri/src/repositories/detail_repo.rs`
  - `src-tauri/src/commands/catalog_search.rs`
  - `src-tauri/src/commands/catalog_detail.rs`
  - `src-tauri/src/commands/forge.rs`
  - `src-tauri/src/commands/history.rs`
  - `src-tauri/src/commands/launchpad.rs`（仅切换 `Confirmed Icon` 锁外两阶段水合与 `icons::spawn_launchpad_icon_stream`，其余广场编排留待 Issue 05）
- Do not modify:
  - `src/` 前端代码

## Implementation Details

1. **在 `src-tauri/src/icons/` 内聚四路世代计数器与流式落库发射协调器**：
   - 将 `SEARCH_GEN`、`BOARD_GEN`、`STARRED_GEN`、`LAUNCHPAD_ICON_GEN` 全部迁入 `icons/fetch.rs`（或子模块），提供类型安全的通道推进与后台派发入口（`next_search_gen`、`current_starred_gen`、`spawn_icon_fetch_lane`）。
   - 将 `save_and_emit` 迁入 `icons/`，将事件广播抽象为轻量回调或 `IconEventSink` **adapter**（生产环境注入 `AppHandle::emit("zstore://icon-ready", ...)`，测试注入内存收集器），严格保持 ADR-0015 双重世代新鲜度检查、`app_icon_cycles` 槽位合并、`repo_card_cache` 图标同步及 `level` 1–5 / `via: live | m2` 语义。
2. **建立深模块 `CardHydrator`（`src-tauri/src/repositories/card_hydrator.rs`）**：
   - **只读批量水合接口**（全部采用短锁批量取 SQLite 行 + 锁外解析 `DeferredIcon` 磁盘确认图标 + `CatalogService::stamp_summary` 统一盖章）：
     - 服务 `get_repo_cards_batch`（目录优先 → `repo_card_cache` 刷新访问时间 → `app_details` 回退）；
     - 服务 `get_cached_app_details_batch`（`app_details` → `repo_card_cache` → 目录回退）；
     - 服务 `resolve_collection_apps`（合集 30 条保序去重 + 缓存回填 + 未知合法坐标最小占位合成）；
     - 服务 `get_recently_viewed_apps`（批量水合最近浏览列表并复用统一占位简介治愈，删除 `commands/history.rs` 手写的 `detail_to_summary` / `heal_recent_summary`）；
     - 服务 `launchpad` 清单条目锁外批量叠加 `Confirmed Icon`（修复 `commands/launchpad.rs` 锁内同步读盘问题）。
   - **写透富卡组装接口**：
     - 将原 `catalog_search.rs` 的 `BackfillCtx` 6 步内部状态机隐藏在单一模块调用背后，供 `direct_github_lookup`、`search_apps_online`、`enrich_trend_repos` 与 `list_github_starred` 共用（输入远端仓库载荷列表，内部一次完成预取、非破坏合并、`repo_card_cache` 与 `app_icon_cycles` 批量落库、锁外 `Confirmed Icon` 解析、目录盖章及待补探 `RepoCoord` 筛出）。
3. **解除跨命令耦合**：
   - 确保 `commands/forge.rs`、`commands/launchpad.rs`、`commands/history.rs`、`commands/catalog_detail.rs` 与 `commands/catalog_search.rs` 之间零相互导入。

## Acceptance Criteria

- [ ] `commands/` 下各子模块不再互相导入 `LAUNCHPAD_ICON_GEN`、`emit_icon_job`、`cards_from_repo_payloads_offloaded` 或 `spawn_starred_icon_stream`。
- [ ] `commands/launchpad.rs` 水合确认图标改为锁外两阶段解析，SQLite 互斥锁内不再执行磁盘图标读取或 Base64 编码。
- [ ] `icons/tests.rs` 通过注入内存 `IconEventSink` 直接测试世代推进与过期世代只补空槽不发射事件的门控语义；`CardHydrator` 单测基于 `Database::open_in_memory()` 覆盖四类只读水合与远端载荷写透。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` 全部通过。
