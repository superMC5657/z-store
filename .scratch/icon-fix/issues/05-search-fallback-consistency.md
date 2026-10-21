# 05: 搜索翻页与兜底槽位一致性（第二批）

**What to build:** 搜索翻页、匿名兜底与多槽合并后，各页图标一致可复现，不出现翻页丢图、死链占槽或选中图与槽位分叉。

**Blocked by:** 01 迟到高优图标可替换低优，02 手动轮换选择不被详情刷新覆盖，03 过期恢复走下载刷新而非直接返回旧图

**Status:** resolved

- [x] 翻页缓存行与首屏同口径组装回填，图标就绪事件可写透两段
- [x] 兜底图按真实来源入槽，已有槽位合并保留，槽满不錯配选中图

## Answer（2026-10-15，fix-1 落码）

改动（仅 `src-tauri/src/commands/catalog_search.rs`，SSOT 与前端禁区只读未动）：
- `save_and_emit`（~L75-91）：先读旧行再 `merge_detail_icon`（M6），非 pinned 且 `selected_url` 变化时置 `cache_file=""`，pinned 分支不动。
- `backfill_uncataloged_card`（~L137-152）：`else if icon非空` 由 `new` 直接覆盖改为读旧行 + `merge_detail_icon(level_for_detail_icon(icon), …)`，保留流式已攒槽位与 pinned；注释更新为 `level_for_detail_icon` 口径。
- 直查单条段（~L337-360）：同样收敛到读旧行 + `merge_detail_icon` 同口径（含 L4 入槽）。

验证（fix-1 实跑）：
- `cargo test --manifest-path src-tauri/Cargo.toml --lib -- <4 项 db::tests>`：4 passed。
- `backfill_keeps_twin_loop + icon_fetch 5 + icon_probe 6`：12 passed。
- `npx vitest run searchListCache.patch.test.ts HomeView.search-icon.test.tsx`：13 passed。
- 回滚：无；改动限定本文件，无扩散。
