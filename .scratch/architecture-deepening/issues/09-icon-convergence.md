# 09: 收敛图标写口到 IconFetch 缝合处
**What to build:** 前端删除 `zstore:icon-changed` 窗口总线，所有图标写入经 icon-ready（图标就绪）→ `iconStore.applyHit` 唯一写口；`AppIcon` 只读 store；Header/DetailCacheSync/FavoritesExtra 的直调（invalidateIconCache/preloadIcons/getOrFetchIcon/getAppIconCycle）改经 store 缝合。后端 `fallback_summary` 内联探测改走 IconFetch 核心 `resolve_probe_branches` 动态分支，删除 `SEARCH_PROBE_BRANCHES` 别名；三处 `api_timeout_or/from` 收敛为一个 helper。保留两个 adapter：流式 `fetch_icons_stream`（搜索/趋势，pool=5）与同步 `probe_single_live`（详情/轮转）。
**Blocked by:** —
**Status:** resolved
- [x] 删除 icon-changed 总线后详情轮转/Header 跟进与 AppIcon 即时换图不断（删除测试）
- [x] `fallback_summary` probe 与核心动态分支表现一致（经 `probe_single_live` 取 `default_branch`，失败即空）
- [x] 超时 helper 单一来源，读 Unified Project Config（统一配置中枢）同一键
- [x] 图标单测经同一 interface（applyHit / fetch_icons_stream）；`cargo clippy -- -D warnings` 干净

## Comments
- 2026-10-11：已实施并合入 dev-ics2（`P1: converge icon writes behind IconFetch seam (ticket 09)`；clippy 干净、cargo 189 通过、vitest 三批通过、tsc 干净）。
- 2026-10-11：票面对齐为 resolved（实现已合入 dev-ics2，见上条记录）。
