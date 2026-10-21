# 03: 过期恢复走下载刷新而非直接返回旧图

**What to build:** 图标缓存过期后重新打开相关页面，过期旧图走后台下载刷新，用户不长期停留在 7 天前旧图。

**Blocked by:** 02 手动轮换选择不被详情刷新覆盖

**Status:** resolved

- [x] 超过缓存生存时效的恢复路径与请求路径同口径判鲜，过期走下载分支
- [x] 手动 pinned 选择在过期刷新中仍受 02 保护不丢失

## Answer

根因：`restore_or_fetch_icon_cycle` 已有轮换行分支（`src-tauri/src/commands/icons_cycle_commands.rs:230-245`）直接以“文件存在 + 合法图”返回旧图，未做任何时效判定；而请求路径 `get_or_fetch_icon` 经 `load_split_cached_bytes`（`src-tauri/src/commands/icons_cycle_probe.rs:153-198`）执行行 7 天有效（`is_icon_fresh(updated_at)`）+ 文件 7 天新鲜（`is_icon_file_fresh`）双检，过期视为未命中走下载。恢复路径缺双检，图标过期（7 天前旧图）后重新打开相关页面仍直接返回旧文件，永不进入下载分支。

改动（只碰 03 范围，未动 01 的 `compareIconPriority` 语义、02 的 `pinned` + `merge_detail_icon` 语义、04 的有界流式读取，不碰 05 范围）：
- `src-tauri/src/db/icon_cycle.rs`：新增 SSOT 判鲜 helper `is_cycle_restore_fresh(cycle, file_fresh, now)`（`cache_file` 非空 + 文件新鲜 + 行 7 天有效三合一，与请求路径同口径；`pinned` 不参与判定）。
- `src-tauri/src/commands/icons_cycle_commands.rs`：已有轮换行分支先算 `is_icon_file_fresh(cache_path)`，再经 `is_cycle_restore_fresh` 双检；双新鲜才直接返回旧图，任一过期即落到既有下载分支（`download_icon_bytes_direct` + `write_icon_file` + `set_icon_cycle_selected`）。下载分支沿用 `set_icon_cycle_selected`（02 语义：不碰 `pinned` 列），手动 pinned 选择在过期刷新中不受影响。
- `src-tauri/src/db/tests.rs`：新增 `test_cycle_restore_fresh_requires_row_and_file`（双新鲜命中、行过期/文件过期/空 `cache_file`/零时间戳均走下载分支）。

验证：
- `cargo test --manifest-path src-tauri/Cargo.toml`：250 passed、0 failed、3 ignored（含新增 1 项；02 的 pinned 用例与 04 的 `icon_probe` 用例均通过）。
- `npx tsc --noEmit`：通过（后端-only，无前端改动）。
- `npx vitest run src/services/iconStore.deepen.test.ts src/services/iconStore.l5badge.test.ts src/views/HomeView.search-icon.test.tsx`：20 项全过（01 语义无回归）。
