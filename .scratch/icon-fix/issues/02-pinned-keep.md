# 02: 手动轮换选择不被详情刷新覆盖

**What to build:** 用户在应用详情手动切换图标档位后，缓存生存时效到期或强制刷新不再丢失手动选择，详情展示保持用户所选档位。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] 手动选择后详情刷新仍保持所选档位，仅补齐备选槽位
- [x] 未手动选择时详情仍可按最强探测更新选中图

## Answer

根因：应用详情刷新落库（`src-tauri/src/commands/catalog_detail.rs` 最强探测分支，level 纯 L、L4=README 路径经 `level_for_detail_icon`）无条件用本次探测结果重写 `app_icon_cycles` 行的 `level/selected_url`。用户在应用详情手动切换档位后，一旦缓存生存时效（基线 60 分钟）到期或强制刷新触发远端重拉，手动选择的档位即被最强探测覆盖丢失；落库的应用详情 `icon` 同样被探测值覆盖，详情展示回落到探测图。`app_icon_cycles` 表此前无任何“用户手动选择”标记，无法区分自动收编与手动锁定。

改动（只碰 02 范围，前端零改动，未动 01 的 `compareIconPriority` 语义与 03/04/05 范围）：
- `src-tauri/src/db/schema.rs`：`app_icon_cycles` 建表新增 `pinned INTEGER NOT NULL DEFAULT 0` 列；`init_schema` 追加存量库迁移（`PRAGMA table_info` 判列缺失才 `ALTER TABLE … ADD COLUMN`，新库跳过、重复 open 幂等）。
- `src-tauri/src/db/icon_cycle.rs`：`AppIconCycle` 新增 `pinned: bool`（默认 false，读/写贯通 `get_icon_cycle`、`get_icon_cycle_by_repo`、`upsert_icon_cycle`）；新增 SSOT helper `merge_detail_icon`（pinned 行保持 `level/selected_url/cache_file/updated_at` 仅补槽并返回 true，未 pinned 行沿用原最强探测收编语义返回 false）与 `fill_probe_slot`（仅空槽写入，槽映射与原落库一致 2=L2品牌库/3=L3仓库/4=L4 README）；`set_icon_cycle_level`/`set_icon_cycle_selected` 明确保持 pinned 不动（恢复路径不改变手动状态）。
- `src-tauri/src/commands/icons_cycle_commands.rs`：唯一手动路径 `request_app_icon_cycle` 在 L1–L4 与 L5（含徽章空选）两处固化后置 `pinned = true`；恢复/回填路径（`restore_or_fetch_icon_cycle`、`get_or_fetch_icon`）不置 pinned。
- `src-tauri/src/commands/catalog_detail.rs`：详情落库改调 `merge_detail_icon`；pinned 行把落库应用详情 `icon` 对齐 `selected_url`（L5 pinned 对齐 `""` 保持徽章态），探测无可用图标时同样对齐展示；未 pinned 行行为与之前逐字一致。
- `src-tauri/src/db/tests.rs`、`src-tauri/src/commands/icons_cycle_probe.rs`：补全 6 处穷举字面量的 `pinned: false`；新增 6 项用例（pinned 往返、存量表迁移、pinned 保持+补槽、未 pinned 照常更新、pinned L5 不复活图标、恢复路径不丢 pinned）。

验证：
- `cargo test`：247 passed、0 failed、3 ignored（含新增 6 项）。
- `npx vitest run src/services/iconStore.deepen.test.ts src/services/iconStore.l5badge.test.ts src/services/iconStore.patch-red.test.ts src/views/HomeView.search-icon.test.tsx src/components/AppDetailModal/Header.l5cycle.test.tsx`：24 项全过（01 语义与轮换无回归）。
- `npx tsc --noEmit`：通过。
