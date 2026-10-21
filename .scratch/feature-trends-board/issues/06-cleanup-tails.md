# Issue 06: 趋势榜收尾（清扫 + 原因码迁移 + Retry-After + stale 显式化）

Status: resolved

> 注：设计提案、主干以本 ADR（docs/adr/0014-trends-l2-and-governance.md）为准。

## 背景

01–05 后残留 4 个尾巴（见 05 Resolution 后续①–④ + P0-2/P2-12 余量）：
① Rust 未把 `Retry-After` 头值写入 429 错误串，前端解析位已预留；② `cache.ts::getDbTrendCache` 未迁移到原因码+聚合计数（parse.ts 基础设施就绪）；③ `types.TrendsResult` 无显式 `stale` 字段（现用 `fromCache:true`+warn）；④ demo 32 位 mock 与新 canonical 分叉；⑤ L2 过期行无后台清扫、无 auto-vacuum，内存仅写时裁剪无定时清扫。

## 目标

- ① `commands/network.rs`（或 fetchTrendsText 实际位置）429 错误串携带 `retry_after_ms=<n>`（解析不到则不带，不改变现有无头行为），parse 侧命中真实头值。
- ② `getDbTrendCache` miss 统一返回原因码（expired/corrupt/version/empty），计数聚合（复用 parse.ts 分类器/计数器，不另起炉灶）。
- ③ `TrendsResult` 加可选 `stale?: boolean`（默认 undefined 保持兼容），熔断回落 L2 时置 true；UI 仅展示用，不改过滤语义。
- ④ demo mock 切 64 位 canonical（与 feed.ts 一致），golden 覆盖。
- ⑤ Rust 加过期行清扫函数（按各榜 TTL 或统一 12h+1h 双档清 `trend_board_cache` 过期行，命令或启动时调用其一即可，不做定时器）；前端三 Map 加轻量定时/切榜过期清扫（interval 或可见性触发二选一）。

## 范围

- 允许改：上述涉及的 Rust commands/network、db 清扫、trends/parse.ts、cache.ts、types、boards.ts、demo mock 及单测。
- 禁止：改打分公式、key 形态、enrich/Other 语义、迁移 v1/v2 已有行为。

## 验收

- Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib` 全过 + clippy 无警告。
- 前端：`tsc --noEmit` + `vitest run src/services/trends/cache.test.ts src/services/trends/parse.test.ts src/services/feed.test.ts src/views/TrendsView.test.tsx` 全过。
- 单 lane 执行，前后 diff 保持最小。

## 阻塞关系

Blocked by: 02/03/04/05（均 resolved，可直接开工）

## Comments

- 来源：05 Resolution 后续 + 收口对照表 3 类留尾。

## Resolution（2026-10-08，Fixer，单 lane）

- ① Rust `commands/network.rs`：429 且 `Retry-After` 为纯秒数时错误串追加 `retry_after_ms=<n>`（`retry_after_ms_from_value` 纯函数，HTTP-date/非法/溢出省略，保持无头旧行为）；`parse.doforceRetryDelayMs` 优先消费 `retry_after_ms=`，旧 `retry-after:`/默认路径不变。
- ② `cache.ts::getDbTrendCache` 迁移到原因码+聚合计数（复用 `classifyTrendCacheMiss`/`recordTrendCacheMiss`；命中/非 Tauri 预览/传输层异常不计数；JSON 解析失败单列 `corrupt`，不再掉进 once 吞错）。
- ③ `types.TrendsResult` 加可选 `stale?: boolean`；熔断回落 L2 时置 true（rising/healthy 透传）；TrendsView 仅在 trends-meta 展示 `stale_badge` 文案（复用 `trends-count` 类，零新样式，不改过滤/确认语义）。
- ④ `demo/handlers/common.ts::demoSeeded01` 切 64 位 canonical（与 `feed.hashSeeded01` 逐位一致，BigInt 复刻），`rankSummariesForFeed` tie-break 改 id 升序；新增 `common.test.ts` golden（向量逐位相等 + 三策略与 `rankFeed` 同序）。
- ⑤ Rust `db/cache.rs::prune_expired_trend_board_cache`（daily 1h/其余 12h 双档，只删确定过期行，未来脏写保留），`run()` 启动时 best-effort 调用一次，无定时器、不碰迁移/schema；前端 `sweepExpiredTrendCaches`（L1/doforce 共享/enrich 全量，`enrich.sweepExpiredTrendEnrichCache` 新增），`fetchTrendsResult` 入口切榜触发，无 interval（单测零悬挂定时器）。
- 禁令遵守：未改打分公式/key 形态/enrich 语义/迁移行为（schema/user_version 零触碰）。

## Verification

- Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib` → 182 passed（含新增 `retry_after_seconds_to_ms_or_omit`、`prune_expired_respects_daily_1h_and_long_12h_tiers`）；`cargo clippy --lib -- -D warnings` → 干净。
- 前端：`npx tsc --noEmit` → 通过；`vitest run cache.test.ts parse.test.ts feed.test.ts TrendsView.test.tsx` → 107 passed（cache 28 含新增 miss 聚合/sweep/stale 回落 3 项，parse 12 含新增透传 1 项，TrendsView 61 全过）；新增 `demo/handlers/common.test.ts` → 2 passed。
- 注：工作树内含其他 lane 未提交改动，本 lane 仅动 06 范围 14 文件 +1 新测试文件，diff 经抽查无越界。
