# ADR-0015：统一图标获取与搜索对齐（主干为准）

- 状态：Accepted
- 日期：2026-10-10
- 关联：ADR-0014（趋势 L2/分片 40/等齐路）、ADR-0012（网络 P0 池化并发）
- 前置：`5c2635a`、`02be2cf` 已合入主干；`.scratch` 为设计提案，主干以本 ADR 为准。

## 1. Core 接口与统一事件

- 后端统一核心 `github/icon_fetch.rs:fetch_icons_stream(handle, jobs, token, cfg, emit)`，其中 `jobs=[{id,owner,repo,ctx}]`，`ctx=Search{search_id,gen} | Trend{board,gen}`。
- Core 只做探测与调度，不触 DB；世代防串由调用方 `emit` 回调（搜索 `catalog_search.rs:save_and_emit`、趋势 `save_and_emit_trend`）落库前 + emit 前双检查执行。
- 搜索与趋势都只走 `zstore://icon-ready{key,id,icon,level,via,context}`（`key`=小写 `owner/repo`，`level`纯L：2=L2品牌库 / 3=L3仓库 / 4=L4 README，core只发2/3 live；`via`=live|m2，M2落盘回填走m2不占level；M1为前端内存与本载荷正交）。

## 2. Pool 与超时默认

- `config.rs:IconFetchConfig` 默认 `pool=5 / total 15s / compat_collect=true`（搜索与趋势共用收敛，与趋势 `buffered(5)` 对齐）。
- 快慢超时经 `network.api_timeout_seconds` 统一配置，未设置回退 1500ms/12s 默认值；快路径外层兜底 8000ms，慢路径只在快未命中且有 token 时跑。
- 整批总量按页伸缩：`total = max(cfg.total_timeout_secs, ceil(jobs/pool) × timeout_each)`，其中 `timeout_each=api_timeout_or(10s)`，`pool` 保持 5。
- L4=README需网络，详情链专属，不受本核心约束；详情仍走最强探测（动态 3 分支 + L4 + 无整批熔断）。
- M2=DB落盘命中零网络，由调用方在进 core 前短锁预解析，不受探测开关影响；经 `via`=m2 表达，不占level。

## 3. 动态分支与确认过滤

- 慢路径 Trees 分支动态解析，复用 `icon_probe::resolve_probe_branches`（先 GET repos 取 `default_branch` 5s 超时，再补 main/master，最多 3 分支，与 `icons_cycle_probe::probe_git_trees` 同源，不另起第三套）。
- 回退基线 `SEARCH_PROBE_BRANCHES=[main, master]`（main 优先，ZCode 类老仓默认分支仍为 master）。
- 确认图标（DB落盘即M2，经 `via`=m2）经 DB 短锁预解析回填（`http::resolve_confirmed_icon_from_db`，锁即取即放，fetch 内零查询零直连）；搜索首屏只接受 M2 回填，不走 L4（README 现场扒，需网络）。
- level纯L(1=L1官方,2=L2品牌库,3=L3仓库,4=L4 README)；缓存只用M(M1=前端内存，M2=DB落盘)，与level正交；level:4=L4。

## 4. 搜缓存（key/TTL/容量）

- 搜缓存（搜缓存=搜索 L1）`services/search/searchListCache.ts` 纯前端内存独立 Map，不共用 `trendsCache`（榜缓存一级内存）实例；value=`{at, ids, rows}`（当次页 rows，非累计）。
- key=`search|normQuery|page|perPage`（norm=trim 小写连续空白压单空格，翻页不串）。
- TTL 30min；空 norm/空 rows 拒绝写（空结果不存）；上限 50 条写时 FIFO 删最旧。
- 切搜/翻页入口顺手 `sweepExpiredSearchListCache`，不加 timer；`elapsed<0`（时钟回拨/未来戳）按过期，读 miss 时调用方保留旧列表。
- 写前 JSON 字节预检复用 `services/trends/cache.ts` 的 256KB 阈值思想，超限放弃写。

## 5. 列表与坐标共享裁决

- 搜索列表不共用趋势坐标；搜索 L1 只活搜索页。
- 图标/坐标层共享：前端图标写入口唯一收口 `services/iconStore.ts:applyHit`（空永不覆盖实、`avatar` 永不进缓冲、搜索 `search_id` / 趋势 `board` 世代门控）。
- enrich 单向共享：仅具平台 summary 经 `hydrate` 进共享 `trendEnrichCache`；pending 空平台只活当次列表，不进共享。

## 6. Compat 逃生门

- `compat_collect=true`（默认，见 `config.rs:IconFetchConfig`）时趋势走 `buffered+collect` 等齐路（`commands/catalog_search.rs:enrich_trend_repos_buffered`）；搜索固定走新流式路，`compat_collect` 仅门控趋势——搜索后台无条件 `tokio::spawn(fetch_icons_stream)`（见 `commands/catalog_search.rs:568,583-586`），不受该开关影响；开关检查只存在于趋势 `enrich_trend_repos` 入口（见 `commands/catalog_search.rs:627-630`）。
- 已删除 `simple_timeout_ms=1500 / trees_timeout_secs=12 / enable_readme` 三字段（`IconFetchConfig` 仅保留 `pool/total_timeout_secs/compat_collect`，见 `config.rs:97-104`）；快慢超时统一经 `network.api_timeout_seconds` 配置（见 `commands/catalog_search.rs:api_timeout_or:30-47`），未设置时回退 1500ms/12s 历史值（见 `github/icon_probe.rs:384-389`）。
- L4→None / 非品牌远端→L3 重标：无有效缓存文件时 `level=4`（L4 README，需网络）返回 None，不作 M2 回填（见 `github/http.rs:resolve_confirmed_icon_from_db:413-417`）；未收录卡片非 `simpleicons.org` 远端图标改标 `level=3` 写 `l3_url`（不再标 `level=4/l4_url`，见 `commands/catalog_search.rs:backfill_uncataloged_card:222-228` 与搜索单仓同形 `:438-447`）。

## 7. 与 ADR-0014 第 6 节关系声明

- ADR-0014 第 6 节分片 40 与现状一致（BE `take(40)` 兜底截断 + `buffered(5)` 保序，FE 分片串行 20/片×2 片=40 上限），0014 原文不动，本节声明其继续有效。
