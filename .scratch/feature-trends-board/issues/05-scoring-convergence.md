# Issue 05: 打分收敛与源 resilience（FNV 同构 + 缺失沉底 + doforce 退避）

Status: resolved

> 注：设计提案、主干以本 ADR（docs/adr/0014-trends-l2-and-governance.md）为准。

## 背景

P1-6/P1-9/P2-10：Rust FNV-1a 64 位 vs 前端 32 位，tie-break 与策略名漂移，“同形可比”名存实亡；`starsGained ?? 0` 把缺失当零；doforce 单点 429 只重试一次、无 Retry-After、固定 5s 必再败还占单飞行槽。

## 目标

- 收敛一端：哈希位宽/雪崩/归一除数两端逐位一致（以后端 64 位为准或以前端 32 位为准，二选一并文档化），tie-break 统一 `id` 升序，策略名映射显式；加跨语言 golden-test（固定 seed 样本两端同序）。
- 排序缺失沉底：rising/healthy/new 的 `?? 0` 改为 undefined 沉底；healthy 文档化启发式本质（暂不改公式量级）。
- doforce：Rust 透传 `Retry-After` 到错误串（parse 已预留解析位），退避改指数+抖动最多 2 次；限流期间熔断读 L2 标 stale，不占单飞行。
- miss 带原因码（expired/corrupt/version/empty），聚合计数替代 once 吞。

## 范围（互斥）

- 仅允许改：`src-tauri/src/github/catalog_feed_score.rs`、`src/services/feed.ts`、`src/services/trends/parse.ts`、`src/services/trends/boards.ts`（及单测）。
- 禁止碰：`db/*`、`cache.ts`、`enrich.ts`、Trie/详情链路。

## 验收

- Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib github::` + feed/score 相关通过，clippy 无警告。
- 前端：golden 样本两端同序单测通过；`tsc --noEmit` 通过。

## 阻塞关系

Blocked by: none（与 02/03/04 文件互斥可并行）

## Comments

- 来源：趋势榜问题清单 P1-6/P1-9/P2-10/P2-13(部分)。
- 高风险：哈希收敛选型需先定方向再动手，完工建议走 oracle review。

## Resolution（2026-10-08，Fixer）

方向：以后端 64 位为 canonical，前端逐位对齐（FNV-1a 64：OFFSET/PRIME/`OFFSET^seed` 起步、UTF-8 字节、`h>>33` 雪崩、除数 `2^64`，前端 BigInt wrapping 复刻）。

- `src-tauri/src/github/catalog_feed_score.rs`：文档 canonical 化 + `frontend_name`/`backend_name`/`feed_strategy_from_frontend`/`feed_strategy_frontend_name` 显式映射 + golden 单测（jitter 逐位×5、balanced seed7 同序、StarsOnly id tie-break、映射表）。
- `src/services/feed.ts`：`hashSeeded01` 32 位 → 64 位 BigInt（小写 + TextEncoder + 同雪崩 + `2^64`）；`rankFeed` tie-break 入参稳定顺序 → `id` 升序（字节序，与后端 `cmp` 一致）；新增 `FEED_STRATEGY_TO_BACKEND`/`backendToFeedStrategy`/`feedStrategyToBackend` 双向映射。
- `src/services/trends/parse.ts`：`growthRatio`/`healthyScore` 缺失返回 undefined（healthy 仅双缺失沉底，单侧按 0 计入，公式量级不变并文档化启发式本质）；新增 `compareTrendIdAsc`/`compareStarsGainedDesc`/`compareHealthyDesc`，`rankByGrowthRatio`/`sortByHealthyScore`/`filterNewReposFallback` 全部缺失沉底 + id tie-break；`doforceRetryDelayMs(err, attempt, rand)` 指数 `2^attempt` + ±20% 抖动（上限 60s，`DOFORCE_RETRY_MAX_RETRIES=2`）；新增 `TrendCacheMissReason`（expired/corrupt/version/empty）+ 聚合计数 + `classifyTrendCacheMiss` 纯分类器。
- `src/services/trends/boards.ts`：`fetchDoforceWithRetry` 单次重试 → 最多 2 次指数退避（共享单飞内等待，不另占槽）；重试耗尽后限流熔断读 L2（内存→DB，不触网，命中 `fromCache:true` + warn 标 stale，无 stale 记 `expired` 一次并抛 error 契约）；rising 改 `compareStarsGainedDesc`。
- 单测：新增 `src/services/feed.test.ts`（6 项：jitter golden×5、balanced golden 同序、stars tie-break、输入序无关、映射表）与 `src/services/trends/parse.test.ts`（11 项：沉底/tie-break、退避指数抖动、原因码计数）；`TrendsView.test.tsx` 同步新语义（429 两次重试=3 请求、Retry-After 抖动上界、delay 范围断言）。
- 范围外后续（禁令内未动，需跟进）：① Rust `commands/network.rs` 把 `Retry-After` 头值写入 429 错误串（前端解析位已预留）；② `cache.ts::getDbTrendCache` 迁移到原因码+聚合计数（基础设施已在 parse.ts 就绪）；③ `types.TrendsResult` 加显式 `stale` 字段（现用 `fromCache:true` + warn 日志标记）；④ `demo/handlers/common.ts::demoSeeded01` 仍为 32 位 mock，与新 canonical 分叉。

## Verification

- Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib github::` → 47 passed（含 4 项新增 golden）；`cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` → 干净（修过一处 doc-lazy-continuation）。
- 前端：`npx vitest run src/services/feed.test.ts src/services/trends/parse.test.ts` → 17 passed；`npx vitest run src/views/TrendsView.test.tsx` → 55/56（唯一失败 `buildTrendsCacheKey('weekly')` 期望 `weekly||` 实得 `weekly`，系并行 issue 改 `cache.ts` 键归一所致，属其范围，本 issue 未碰该文件）；`npx tsc --noEmit` → 通过。
