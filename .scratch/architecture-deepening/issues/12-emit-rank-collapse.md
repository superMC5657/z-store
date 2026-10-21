# 12: 收拢 search/trend/feed emit 缝合与 rank
**What to build:** 后端 `save_and_emit` 与 `save_and_emit_trend` 合并为 `save_and_emit(ctx, gen)`（SEARCH_GEN/BOARD_GEN 降为 ctx 参数，gen 检查进核心）；`enrich_trend_repos` 双管线收敛；compat buffered（`compat_collect=true`）路径按 ADR-0015 原样保留为唯一 legacy adapter。前端 rank 收敛一处（后端 `rank_feed` 为准，demo/搜索本地路径保持确定性）；搜索列表缓存保持薄；删除 `shareConcreteToTrendEnrich` 单向泄漏。
**Blocked by:** 09（同 `catalog_search.rs`、`emit_icon_job`/IconFetchCtx 先后错开）
**Status:** resolved
- [x] 删除 `save_and_emit_trend` 后趋势 DB/emit 行为一致（删除测试，仅全局量差异消失）
- [x] 搜索/趋势/demo 三路径排序确定性不变；compat 路径行为不变（ADR-0015 不重开）
- [x] 相关单测经同一 emit interface；`cargo clippy -- -D warnings` 干净

## Comments
- 2026-10-11：已实施并合入 dev-ics2（P3；cargo 205、vitest 54+185、tsc 干净；验证跑在双 lane 合并树上）。compat buffered 按 ADR-0015 逐字节保留；demoSeeded01 暂留（deprecation 标记，随调用方清理）。
- 2026-10-11：票面对齐为 resolved（实现已合入 dev-ics2，见上条记录）。
