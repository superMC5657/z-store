# ADR-0014：趋势榜 L2 与治理

- 状态：Accepted
- 日期：2026-10-08
- 关联：ADR-0011（doforce 例外）、ADR-0010（小写 canonical）
- 修订：§1 的载荷形态、§5 的字节上限与 §8 的写透口径由 ADR-0027 取代——`trend_board_cache` 只存 `{ v: 2, items }` 排行索引（64 KiB / 30 行），仅在抓榜成功时写一次，单仓富卡改存 `repo_card_cache`。

## 1. 表结构

- `trend_board_cache(cache_key TEXT PK, board TEXT NOT NULL, payload_json TEXT NOT NULL, payload_bytes INTEGER DEFAULT 0, cached_at INTEGER)` + `idx_trend_board_cache_board(board)`，定义于 `db/schema.rs::init_schema`。
- 后端命令 `get/save_trend_board_cache`（`commands/trends_cache.rs`）：薄透传，请求键经 `#[tauri::command(rename_all = "camelCase")]` 桥接（前端 `cacheKey`/`payloadJson` → 后端 `cache_key`/`payload_json`），仅 trim + 空串拒绝，不做大小写归一、不判 TTL；前端沿用同 key 直接命中。

## 2. Key 归一（小写，读写同源）

- 前端 `buildTrendsCacheKey(board, opts)=board|lang|cat`、`buildDoforceCacheKey(opts)=doforce|lang|cat`，三段统一 `trim().toLowerCase()`；`DOFORCE_SHARED_CACHE_KEY=doforce||`。
- 后端 `clean()` 仅 trim；读写同 builder、同 opts（见 `board.ts` 读路径与 `TrendsView` 写透路径），不分叉。

## 3. TTL / 抖动 / 清扫双档

- 榜缓存一级内存分档（榜 L1，`trendsBoardTtlMs`）：daily 1h，weekly/monthly/new 12h，其余 5min（`CACHE_TTL_MS`）；doforce 共享 12h；enrich 12h；榜缓存二级落盘双档（榜 L2，由 `trendDbTtlMs` 给出）：daily 1h，其余 12h。
- 榜缓存二级落盘有效 TTL = 基线 - min(key 稳定抖动 0-30s, 基线/4)，只扣减不延长；`elapsed<0`（时钟回拨/未来戳）一律按过期；当 L2 超过新鲜度 TTL 后若网络重拉失败，`fetchBoardWithL2` 与 `fetchDoforceShared` 自动回退读取 SQLite 中未超 7 天保留窗口的陈旧快照（`stale: true`）。
- 保留窗口清扫（`prune_expired_trend_board_cache`）：统一保留 7 天（`604800s`）供弱网/离线回退，未来戳保留；启动时 best-effort 调一次，无 timer。前端切榜顺手 `sweepExpiredTrendsCache + sweepExpiredTrendEnrichCache`（`fetchTrendsResult` 入口），不加 `setInterval`。

## 4. 内存有界

- `trendsCache` 200 条写时 FIFO 删最旧；`Repo Enrich Cache`（`services/repoEnrichCache.ts`，600 条，经 `putCard` 单入口写入裁剪）；`doforceShared` 单槽（O(1），注释声明）。

## 5. 两级字节上限 + dataURI 禁入

- FE `TREND_DB_PAYLOAD_MAX_BYTES=256KB` 预检：信封超限逐级裁剪（丢 confirmed → 长文本截 500 字 → 丢 loading 空平台条），仍超限放弃写盘；BE 端超过 `TREND_BOARD_CACHE_MAX_BYTES=512KiB` 硬拒绝（`trend_board_payload_too_large`，不落库）。
- `data:` 字符串与未确认空平台永不进 `payload_json`：当富卡携带 `data:` 图标时，写盘与 `putTrendEnrichCache` 自动将 `icon` 字段剥空为 `''` 后保留富卡本体落盘（`data:` 驻留 `iconStore` M1 内存与后端 `icons/` 磁盘，重挂时经 `getConfirmedIconsBatch` 回填）。

## 6. 批量 40

- BE `enrich_trend_repos`：`take(40)` 兜底截断 + `buffered(5)` 保序。
- FE `enrichTrendRepos`：单次批量 40 上限（`missing.slice(0, 40)` 一次取回，避免第二片顶掉第一片慢尾）；整批失败即整批缺席（不抛错，缺席留占位，榜单永不置空）。

## 7. 429 透传（单次重试）

- BE 429 分支透传 `Retry-After`：纯秒数追加 `retry-after: {s} retry_after_ms={ms}`，日期串透传原串，无该响应头时返回基础错误串；限流日志不占单飞槽计数。
- FE `doforceRetryDelayMs` 优先兑现 `retry_after_ms` 毫秒直值，否则按 `retry-after` 秒数/HTTP-date，上限 60s（超限直接 error），缺省 5s；`fetchDoforceWithRetry` 恰好重试一次。

## 8. 关联能力与守卫

- recents 治愈：`history.rs` `heal_recent_summary`/`cached_detail_summary` + `App.tsx` recents heal，富卡非占位简介治愈占位行。
- 详情占位守卫：`detail_fetch.rs` `is_placeholder_description`/`repo_real_description_from_etag` + `App.tsx` 的 `snapshotTrendEnrichCache`/`handleOpenDetail`/`useDetailCacheSync`，占位不覆盖。
- 富卡全量同步 confirmedOther：`cache.ts` `TrendCacheEnvelope confirmedOther`（版本以字段 `v:1` 表达）+ `enrich.ts` loading-vs-concrete merge/settle/lite。
- 图标门控：`Header.tsx`/`catalog_detail.rs`/`AppIcon.tsx` uncataloged-only cycle + recents fallback + warmup。
- 交互 chrome：`TrendsView` refresh 按钮 + `useTrendBoard forceRefresh` + localStorage tab memory + locales + 卡片对齐 CSS。
