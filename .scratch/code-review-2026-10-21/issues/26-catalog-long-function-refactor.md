# Issue 26: catalog 长函数重构（455 行详情 / 279 行图标 / 合并形状两份）

Status: resolved
Priority: P3（重构）
来源: 2026-10-21 全项目审查 · Standards 轴

## 描述

1. `src-tauri/src/commands/catalog_detail.rs:377-830`：`get_app_details_impl` 约 455
   行，内部"读缓存→id回写→盖章→返回"形状重复 3 次（:405-430 / :440-460 / :810-828）。
2. `src-tauri/src/commands/icons_cycle_commands.rs`：`restore_or_fetch_icon_cycle`
   279 行、`request_app_icon_cycle` 174 行。
3. `src-tauri/src/commands/catalog_detail.rs:62`：`get_platforms_lite` 209 行。
4. `src-tauri/src/github/catalog_service.rs:66-82` 与 `:429-440`：同一"远端优先去重
   合并"形状两份。

## 修复方向

- 详情路径抽 `project_from_cache(id) -> Option<AppDetail>` helper（含盖章），三处调用；
  主函数按"缓存命中 / lite / full"拆段。
- 图标两命令按 阶段函数（校验/探测/落库/事件）拆分。
- 合并形状抽 `merge_remote_first(remote, local)` 单实现。

## Comments

- 纯行为保持重构，缓存语义零改动；cargo check/clippy（--tests -D warnings）绿、cargo test 366 全过。
- 详情路径（catalog_detail.rs）：
  - 「读缓存→id回写→盖章→返回」收敛为 `project_from_cache(state, clean_id, ttl_gated,
    enrich_catalog_desc_en, log_prefix, log_from, start) -> Option<AppDetail>` 单实现
    （含 `stamp_detail` 盖章；`ttl_gated=false` 即 stale 穿透臂：无 TTL 门控复用旧行并置
    `is_stale=Some(true)`），四处调用：主臂 TTL 快径（保留收录项 description_en 回填）、
    forge 段 TTL 快径、未知坐标 stale 降级、fetch 失败 stale 回退
    （工单点名的三处 + :569 同形第四处一并收口；第四处原日志 `cache=stale` 文案归一为
    `from=cache:stale`，其余日志逐字保留）。
  - `get_app_details_impl` 455 行 → 53 行编排器，按段拆 `fetch_detail_from_forge`
    （多源 lite 段）与 `fetch_detail_from_github`（GitHub full 段）；GitHub 段落库子段
    再抽 `persist_github_detail`（inherit-then-recompute/占位根治/Top2 原子落库/
    never-poison 语义与注释原样随迁）。
  - `get_platforms_lite` 209 行 → 31 行编排器，拆 `platforms_lite_from_cache` /
    `platforms_lite_from_forge` / `platforms_lite_from_github` 三段。
- 图标两命令（icons_cycle_commands.rs）按阶段函数拆分：
  - `request_app_icon_cycle`：校验（收录早返）→ `load_or_seed_cycle`（装载/播种）→
    `seal_empty_level_selection`（L5 空选）→ `load_cycle_target_bytes`（缓存命中→远端下载）→
    `persist_manual_selection`（三件套落库 + data uri）；`ensure_icons_dir` /
    `download_icon_bytes` 小件共用。
  - `restore_or_fetch_icon_cycle`：校验 → `restore_existing_cycle`（已有行：L5 空态/
    新鲜快径/过期重下/空图兜底）→ `restore_cataloged_default`（收录初始）→
    `probe_uncataloged_first_cycle`（未收录首探）；hash 候选文件名序列收敛
    `hash_candidate_filenames` 单实现（两处同形）。
- 合并形状（catalog_service.rs）：`get_catalog_items`（:66-82）与
  `merged_items_with_overlay`（:429-440）收敛为 `merge_remote_first(remote, local)` 单实现；
  `merge_catalog_overlay_view`（MergedCatalogEntry 带 source 标记）为另一形状，不属同形，未动。
