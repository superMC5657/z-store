# ADR-0015：统一图标获取与搜索对齐

- 状态：Accepted
- 日期：2026-10-10
- 关联：ADR-0014（趋势 L2/批量 40/等齐路）、ADR-0012（网络池化并发）

## 1. Core 接口与统一事件

- 后端统一核心 `github/icon_fetch.rs::fetch_icons_stream(handle, jobs, token, cfg, emit)`，其中 `jobs=[{id,owner,repo,ctx}]`，`ctx=Search{search_id,gen} | Trend{board,gen}`。
- Core 只做探测与调度，不触 DB；世代防串由调用方 `emit` 回调（搜索与趋势共用的 `commands/catalog_search.rs::save_and_emit`）落库前 + emit 前双检查执行。
- 搜索与趋势都只走 `zstore://icon-ready{id,icon,level,via,context}`（`id`=小写 `owner/repo`，`level`纯L：2=L2品牌库 / 3=L3仓库 / 4=L4 README，core只发2/3 live；`via`=live|m2，M2落盘回填走m2不占level；M1为前端内存与本载荷正交）。

## 2. Pool 与超时默认

- `config::IconFetchConfig` 默认 `pool=5 / total 15s`（搜索与趋势共用收敛，与趋势 `buffered(5)` 对齐）。
- 快慢超时经 `network.api_timeout_seconds` 统一配置（`config::api_timeout_or`），未设置回退 1500ms/12s 默认值；快路径外层兜底 8000ms，慢路径只在快未命中且有 token 时跑。
- `github/icon_probe.rs::verify_image` 对 `HEAD` 与 `Range GET` 返回的确定性不存在状态码（`404 Not Found` / `410 Gone`，见 `is_terminal_http_miss`）立即短路返回 `None`，避免单 slug 串行放大为 3 次请求。
- 整批总量按页伸缩：`total = max(cfg.total_timeout_secs, ceil(jobs/pool) × timeout_each)`，其中 `timeout_each=api_timeout_or(10s)`，`pool` 保持 5。
- L4=README需网络，详情链专属，不受本核心约束；详情经 `db::icon_cycle::pick_detail_icon_with_level` 显式保留 L1/L2/L3/L4 来源级别，并在 L2/L3 与 L4 同时命中时通过 `fill_probe_slot(&mut cycle, 4, ...)` 补齐 `l4_url` 备选槽。
- M2=DB落盘命中零网络，由调用方在进 core 前短锁预解析，不受探测开关影响；经 `via`=m2 表达，不占level。

## 3. 动态分支与确认过滤

- 慢路径 Trees 分支动态解析，复用 `github/icon_probe.rs::resolve_probe_branches`（GET 取 `default_branch`，请求失败、超时或字段为空时回退 `vec!["HEAD"]`，同源于 `github/icon_fetch.rs::probe_l3_trees` 与 `detail_fetch.rs`）。
- 确认图标（DB落盘即M2，经 `via`=m2）经 DB 短锁预解析回填（`github/http.rs::resolve_confirmed_icon_from_db`，锁即取即放，fetch 内零查询零直连；当 `cache_file` 为空但 `icons/` 下已有对应 URL 哈希文件时自动自愈关联并返回 `data:` URI）；前端 `enrichTrendReposCore` 与 `putTrendEnrichMemory` 收到非空确认图标（含 `data:`）时同步调用 `admitIconHit({ via: 'm2' })` 写入 M1 `iconStore` 缓冲，并将 `icon` 剥空为 `''` 后把完整富卡存入 `trendEnrichCache` 与 L2 `trend_board_cache`。
- level纯L(1=L1官方,2=L2品牌库,3=L3仓库,4=L4 README)；缓存只用M(M1=前端内存，M2=DB落盘)，与level正交；level:4=L4。

## 4. 搜缓存（key/TTL/容量）

- 搜缓存（搜缓存=搜索 L1）`services/search/searchListCache.ts` 纯前端内存独立 Map，不共用 `trendsCache`（榜缓存一级内存）实例；value=`{at, rows}`（当次页 rows，非累计）。
- key=`search|normQuery|page|perPage`（norm=trim 小写连续空白压单空格，翻页不串）。
- TTL 30min；空 norm/空 rows 拒绝写（空结果不存）；上限 50 条写时 FIFO 删最旧。
- 切搜/翻页入口顺手 `sweepExpiredSearchListCache`，不加 timer；`elapsed<0`（时钟回拨/未来戳）按过期。切搜新词或清空搜索时立即清空上一词的在线列表，仅先展示本地结果（再由用户显式触发在线搜索）；读 cache miss 时直接走网络直查，仅当同词缓存已直展且后台 revalidate 失败/为空时保留该同词缓存列表。
- 写前 JSON 字节预检复用 `services/trends/cache.ts` 的 256KB 阈值思想（同一 `TREND_DB_PAYLOAD_MAX_BYTES`），超限放弃写。

## 5. 列表与坐标共享裁决

- 搜索列表不共用趋势坐标；搜索 L1 只活搜索页。
- 图标/坐标层共享：前端图标写入口唯一收口 `services/iconStore.ts::admitIconHit`（空永不覆盖实、搜索 `search_id` / 趋势 `board` 世代门控）。
- enrich 单向共享：仅具平台 summary 经 `hydrate` 进共享 `trendEnrichCache`；loading 空平台只活当次列表，不进共享。

## 6. 单一流式路径

- 搜索与趋势的图标补齐只走统一核心 `github/icon_fetch.rs::fetch_icons_stream`：搜索后台无条件 `tokio::spawn` 该核心，趋势 enrich 同样逐张 emit；不存在 `buffered+collect` 等齐的兼容分支，也没有对应开关。
- 趋势 enrich 的 summary 批量直查侧另走 `.buffered(5)` 保序等齐（`commands/catalog_search.rs`），只补 summary 不搬图标；前端 `useTrendEnrichment` 按 `(trendResult, activeBoard)` 周期记录已尝试 enrich 的坐标集合，单仓直查失败返回 `None` 时不重入触发二次 `enrich_trend_repos`，保证单次榜单加载只递增一次 `BOARD_GEN`。
- `config::IconFetchConfig` 仅含 `pool` / `total_timeout_secs`；快慢超时统一经 `config::api_timeout_or`（`network.api_timeout_seconds`），未设置时回退 1500ms/12s 默认值（`github/icon_probe.rs`）。
- L4→None / 槽位保真：无有效缓存文件时 `level=4`（L4 README，需网络）返回 None，不作 M2 回填（见 `github/http.rs::resolve_confirmed_icon_from_db`）；`get_or_fetch_icon` 与详情 304 复用优先经 `AppIconCycle::level_for_known_url` 匹配已入槽级别，未知 URL 再由 `level_for_detail_icon` 启发式归类（`/blob/`、`/HEAD/`、`readme` 及 GitHub README 图床归 `4`，显式分支 `raw.githubusercontent.com` 归 `3`）。

## 7. 与 ADR-0014 第 6 节关系声明

- ADR-0014 第 6 节批量 40 的现行口径：BE `take(40)` 兜底截断 + `buffered(5)` 保序；FE 单次批量 40 上限（一次取回，避免第二片顶掉第一片慢尾；整批失败即整批缺席，不抛错）。
