# 14: 收拢未收录 join 与规范键
**What to build:** 收藏/关注 left-join（`(favorite∪watched)∖精选收录库`）与 scanner 模糊评分收拢为一个深 join 模块（两种行为：exact 规范应用标识查 vs heuristic fuzzy 外部启发式）；`canonical_app_id`/`canonical_icon_key`/`icon_key` 三合一为前者；deeplink 入站经 `canonical_app_id()` 归一化。
**Blocked by:** 09，11（同 `icon_fetch.rs`、selectors/FavoritesView 先后错开）
**Status:** resolved
- [x] 决议已定（2026-10-11，maintainer 选择修订 ADR-0010）：deeplink 入站强制经 `canonical_app_id()` 归一化；实施时同步修订 `docs/adr/0010-canonical-app-identifier.md`，在票底 `## Comments` 记录修订摘要
- [x] 未收录收藏/关注行表现一致；删除 `useFavoritesExtra` 后行消失、计数保留语义经新模块保持（删除测试）
- [x] 三键合一后 DB/event 键全同；模糊降级（exact 命中保留、fuzzy 挂起）语义经确认

## Comments

- 2026-10-11（ADR-0010 修订摘要，maintainer 决议执行）：深链入站归一化例外收紧——
  `DeepLinkParser::parse` 的 `app`/`install`/裸 id 三路由统一经 `canonical_app_id()`
  归一（实现为 total 版 `canonical_lookup_id`：可解析直取 canonical，不可解析
  回退小写、解析层不断路由；执行层 `require_app_id` 仍拒绝未知标识）。
  同步修订 `docs/adr/0010-canonical-app-identifier.md`（附修订注：深链收紧 +
  三键合一 + 深 join 模块说明），本票不重开其他 ADR。
- 三键合一：`canonical_app_id`/`canonical_icon_key`/`icon_key` 收敛为前者唯一实现
  （`canonical_app_id_from_parts`；`icon_key` 为薄委托、`canonical_icon_key` 删除）；
  DB 主键/事件 key/前端归一键全同（单测断言三处同值）。
- 深 join 模块：后端 `scanner/join.rs`（exact `join_exact` + fuzzy `join_fuzzy`
  唯一入口 + `is_managed_id`/`canonical_id_set` 规范比对；`scan_and_match_local_apps`
  经其路由，canonical 数据零行为变更）；前端 `app/favoritesUncataloged.ts`
  收拢为深 join 模块（纯 helpers + `selectFavoritesViewApps` 合并 + hook 内迁，
  `useFavoritesExtra.ts` 删除，`App.tsx` 改调新名）。行消失（收录到达驱逐/
  取消收藏）与计数保留（全集计数）语义经删除测试保持。
- 2026-10-11：已实施并合入 dev-ics2（P4；cargo 212、clippy/tsc 干净、vitest 相关批次全绿）。
- 2026-10-11：票面对齐为 resolved（实现已合入 dev-ics2，见上条记录）。
