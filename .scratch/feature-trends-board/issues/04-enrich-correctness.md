# Issue 04: enrich 正确性（Other 误判 + take20 + 大小写误命中）

Status: resolved

> 注：设计提案、主干以本 ADR（docs/adr/0014-trends-l2-and-governance.md）为准。

## 背景

P1-4/P1-5/P2-11：settle 30s 超时兜底把故障落定为 Other 并写透 L2；双端 take(20) 长尾永裸奔、失败 None 无区分；`to_summary` 不归一 id + `matchCatalogApp` 仅比 repo 名可跨 owner 命中。

## 目标

- `confirmedOther` 区分“探测确认 vs 超时兜底”，兜底只进内存不进 L2（或短 TTL）；enrich 返回带 `is_stale` 语义让调用方可区分真零发布 vs 失败空。
- enrich 分片补齐第二轮（20+），`None` 区分明确无收录（不再试）vs 瞬时失败（短 TTL 重试），失败计数可观测。
- `to_summary` 出口统一小写 id（ADR-0010）；`matchCatalogApp` 坐标相等优先，名单独匹配需 owner 佐证。
- `trendEnrichCache` 双键存加条目上限。

## 范围（互斥）

- 仅允许改：`src/services/trends/enrich.ts`、`src/views/TrendsView*`、`src-tauri/src/commands/catalog_search.rs`、`src-tauri/src/github/models.rs`（及各自单测）。
- 禁止碰：`db/*`、`cache.ts`、`boards.ts`、`feed.ts`、打分与抓取排序。

## 验收

- Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib` 相关通过 + clippy 无警告。
- 前端：Other 兜底不再写 L2（单测或手工：断网 30s 不落定 Other 进库）；`tsc --noEmit` 通过。

## 阻塞关系

Blocked by: none（与 02/03/05 文件互斥可并行）

## Comments

- 来源：趋势榜问题清单 P1-4/P1-5/P2-11。

## Resolution

- `confirmedOther` 拆分为探测确认（`trendConfirmedOtherIds`，lite 空非 stale，可进 L2）与超时兜底（`trendSettleOtherIds`，30s，仅内存，永不置脏/写透）；展示/过滤/计数走并集，治愈双集清除（`TrendsView.tsx`）。
- enrich `is_stale` 语义显式化：空平台结果标 `is_stale` 不进长缓存；`None` 后端分明确无收录（404/`未找到`）vs 瞬时失败（超时/其余），`trend enrich done` 记 `hits/definite_miss/transient_fail/truncated`，前端 `getLastTrendEnrichStats()` 配套（`enrich.ts`、`catalog_search.rs`）。
- 分片补齐 20+：前后端两分片×20（前端 `TREND_ENRICH_MAX_SHARDS=2`，后端 `ENRICH_TAKE_MAX=40` 分片串行 `buffered(5)`）；`None` 当轮不再试、下轮再定（fired 守卫 + 单 key 尝试上限）。
- `to_summary` 出口 id 统一小写 + enrich 出口 id 归一小写（ADR-0010，`github/models.rs`、`catalog_search.rs`，单测 `test_to_summary_id_lowercased_adr0010`）。
- `matchCatalogApp` 两阶段：精确坐标/id 优先，模糊名一律需 owner 佐证，裸 repo 跨 owner 永不命中（单测 2 则）。
- `trendEnrichCache` 双键存（坐标键 + 摘要 id 键）+ `TREND_ENRICH_CACHE_MAX_ENTRIES=500` 有界裁剪最旧（hydrate/upsert/patch/enrich 全经 `putTrendEnrichCache`）。
- 新增单测：settle 兜底仅内存（断网推进至落定为完整卡，且全部 L2 写透 `confirmedOther` 无本榜键）、分片统计、双键/上限、match 跨 owner。

## Verification

- Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib` → 180 passed / 0 failed（3 ignored 既有）；`cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` → 无警告。
- 前端：`npx tsc --noEmit` → 通过；`vitest run src/views/TrendsView.test.tsx` → 60/61，唯一失败 `缓存键 = board + language + category` 系并行 03 号 agent 未提交的 `cache.ts` 改动（禁区文件，本单未碰），待其同步单测。
- 范围：仅改 `src/services/trends/enrich.ts`、`src/views/TrendsView.tsx`、`src/views/TrendsView.test.tsx`、`src-tauri/src/commands/catalog_search.rs`、`src-tauri/src/github/models.rs` + ticket；`db/*`、`cache.ts`、`boards.ts`、`feed.ts` 未碰。
