# ADR-0014：趋势榜 L2 与治理收口（主干为准）

- 状态：Accepted
- 日期：2026-10-08
- 关联：ADR-0011（doforce 例外）、ADR-0010（小写 canonical）
- 前置：Phase1A（Rust L2）+ Phase1B（前端正确性）+ Phase2（治理）已合入；`.scratch/feature-trends-board/issues/01-06` 为设计提案，主干以本 ADR 为准。

## 1. 表结构（14 张，无 `search_result_cache`）

- `trend_board_cache(cache_key TEXT PK, board TEXT NOT NULL, payload_json TEXT NOT NULL, payload_bytes INTEGER DEFAULT 0, cached_at INTEGER)` + `idx_trend_board_cache_board(board)`，见 `db/schema.rs`。
- 全库 14 张核心表（`search_result_cache` 不存在，不做承诺）。
- 后端命令 `get/save_trend_board_cache`（`commands/trends_cache.rs`）已补齐：薄透传，双命名兼容（`cache_key/cacheKey`、`payload_json/payloadJson`），仅 trim+空拒绝，不做大小写归一，不判 TTL；前端沿用同 key 直接命中，零改动。

## 2. Key 归一（小写，读写同源）

- 前端 `buildTrendsCacheKey(board, opts)=board|lang|cat`、`buildDoforceCacheKey(opts)=doforce|lang|cat`，三段统一 `trim().toLowerCase()`；`DOFORCE_SHARED_CACHE_KEY=doforce||`。
- 后端 `clean()` 仅 trim；读写同 builder、同 opts（见 `boards.ts` 读路径与 `TrendsView` 写透路径），不分叉。

## 3. TTL / 抖动 / 清扫双档

- L1 分档（`trendsBoardTtlMs`）：daily 1h，weekly/monthly 12h，其余 5min；doforce 共享 12h；enrich 12h；L2 统一 12h。
- L2 有效 TTL = 12h - min(key 稳定抖动 0-30s, TTL/4)，只扣减不延长；`elapsed<0`（时钟回拨/未来戳）一律按过期。
- 清扫双档（`prune_expired_trend_board_cache`）：daily 挡 3600s，其余挡 43200s，未来戳保留；启动时 best-effort 调一次，无 timer。前端切榜顺手 `sweepExpiredTrendsCache + sweepExpiredTrendEnrichCache`（`fetchTrendsResult` 入口），不加 `setInterval`。

## 4. 内存有界

- `trendsCache` 200 条写时 FIFO 删最旧；`trendEnrichCache` 500 条经单一 `put` 入口裁剪；`doforceShared` 单槽（O(1），注释声明）。

## 5. 两级字节上限 + dataURI 禁入

- FE `TREND_DB_PAYLOAD_MAX_BYTES=256KB` 预检：信封超限降级裸榜，仍超限放弃写盘；BE `TREND_BOARD_CACHE_MAX_BYTES=512KiB` 硬拒绝（`trend_board_payload_too_large`，不落库）保持。
- `data:`/空平台永不进 `payload_json`（写盘消毒 + hydrate/snapshot 守卫 + 读盘逐项守卫）。

## 6. 分片 40

- BE `enrich_trend_repos`：`take(40)` 兜底截断，`buffered(5)` 保序不变。
- FE `enrichTrendRepos`：分片串行 20/片×2 片=40 上限；超 40 留占位（缺席，旧小行保留），榜单永不置空；单片失败仅该片缺席。

## 7. 429 透传（单次重试）

- BE 429 分支透传 `Retry-After`：纯秒数追加 `retry-after: {s} retry_after_ms={ms}`，日期串透传原串，无头保持旧串；限流日志不占单飞槽计数。
- FE `doforceRetryDelayMs` 优先兑现 `retry_after_ms` 毫秒直值，否则按 `retry-after` 秒数/HTTP-date，上限 60s（超限直接 error），缺省 5s；`fetchDoforceWithRetry` 恰好重试一次。
