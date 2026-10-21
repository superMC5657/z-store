# Issue 03: 前端 L2 治理（key 归一 + 信封宽容读 + 空榜哨兵 + 时钟钳制）

Status: resolved

> 注：设计提案、主干以本 ADR（docs/adr/0014-trends-l2-and-governance.md）为准。

## 背景

P0-2(FE)/P1-7(key)/P1-8(三态)/P2-14(时钟)：key 纯拼接无 lower（`cache.ts:35,80`）；裸数组/V1/V2 三态未知版本整榜 miss、空榜存不住；`cachedAt*1000` 回拨永命中；dataURI 进信封致单行 MB 级。

## 目标

- key 组装统一 `trim().toLowerCase()`（空即省），`doforce` 共享 key 与榜 key 命名显式区分。
- 入信封前剥离 dataURI（只存远端 URL，与内存 hydrate 一致）；写前判字节上限，超限降级裸榜。
- 读侧宽容：忽略未知字段、未知 `v` 按最新版尽力读；合法空榜写短 TTL 哨兵行可命中。
- TTL 比较钳制负值按过期；写 L2 加小随机抖动错峰。
- `trendsCache/doforceSharedCache` 加条目上限（写时裁剪）。

## 范围（互斥）

- 仅允许改：`src/services/trends/cache.ts`（及同目录单测若有）。
- 禁止碰：`boards.ts/enrich.ts/parse.ts`、Rust 任何文件。`saveBoardL2` 调用语义不变。

## 验收

- `npm run test -- trends/cache` 或等效单测通过（若无单测至少 `tsc --noEmit`）。
- 不改变 forceRefresh/回写语义，仅治理存取层。

## 阻塞关系

Blocked by: none（与 02/04/05 文件互斥可并行）

## Comments

- 来源：趋势榜问题清单 P0-2(FE侧)/P1-7(key)/P1-8/P2-12(部分)/P2-14。

## Resolution（2026-10-08，@fixer）

仅改 `src/services/trends/cache.ts` + 同目录 `cache.test.ts`；boards.ts/enrich.ts/parse.ts/Rust 未碰，
`saveBoardL2` 调用签名与 forceRefresh/回写语义不变。

- key 归一：`normalizeCacheSegment`（trim+toLowerCase）+ `joinCacheKeySegments`（空即省，
  仅裁 trailing 空段，中间空段保留占位保对齐）。`weekly`→`weekly`、`Python`→`weekly|python`、
  `healthy+media`→`healthy||media`；doforce 共享 key 改前缀 `doforce-shared|…`，
  与榜 key（`doforce|…`）显式区分。老 key 旧行自然 orphan（miss 后重建）。
- 写侧：`stripDataUriIcon` 入信封前剥离 dataURI（图标置空、行保留；远端 URL 原样存，
  与内存 hydrate“不收 data:”一致）；写前 `utf8ByteLength` 判 256KB 上限
  （`TREND_L2_MAX_PAYLOAD_BYTES`），超限降级裸榜，裸榜仍超限放弃写盘。
- 读侧宽容：忽略未知字段；未知 v（含缺失）按最新版尽力读（enrich 守卫 + confirmedOther
  500 帽沿用）；`TrendCacheEnvelopeV2.empty` 哨兵：`repos:[]+empty:true` 按
  `EMPTY_BOARD_SENTINEL_TTL_MS=60s` 命中 `[]`，无标记空（legacy `[]`/空信封）仍 miss。
  `saveDbTrendCache([])` 由“跳过”改为写哨兵行（boards 流 `empty` 状态本就不调 save，
  故 saveBoardL2 语义不受影响）。
- 时钟钳制：`isCacheExpired` 对 elapsed<0/非有限一律按过期（L1/L2/哨兵统一）。
  抖动错峰：内存写时 `drawSpreadMs`（0..30s，随条目存、读侧确定性扣除）；
  L2 读侧 `keySpreadMs`（key 稳定哈希 0..30s，重复读不抖）；`effectiveTtlMs` 只扣减、
  永不延长新鲜度（抖动帽为基准 1/4，短 TTL 不被抖穿）。
- 上限裁剪：`trendsCache` 写时 FIFO 裁剪（`TRENDS_MEMORY_CACHE_MAX_ENTRIES=200`）；
  `doforceSharedCache` 单槽位整体替换（上限 1 天然满足，注释声明）。
- 单测：沿用 17 个（更新 key/doforce 前缀、哨兵写、dataURI 剥离、forceRefresh 用 builder key），
  新增 8 个（归一+区分、哨兵命中/过期/无标记 miss、未知 v+缺 v 尽力读、未来 cached_at miss、
  内存回拨 miss、Map 裁剪、字节上限降级/放弃、doforce 内存命中）。

## Verification

- `npx vitest run src/services/trends/cache.test.ts`：25/25 通过。
- `npx tsc --noEmit`：本文件 0 错误；全仓唯一报错为 `TrendsView.tsx(394,31) TS6133`
 （并发并行 agent 改动该文件引入，超出本 ticket 范围，未碰）。
- 已知后续（超出范围，需跟进）：`src/views/TrendsView.test.tsx` 有 1 个 key 断言
  （`weekly||` 等旧形态）随归一化失效 + parse/retry 并行改动引入 2~3 个失败
  （`doforceRetryDelayMs` 5754 vs 5000 等，属 parse.ts 抖动改动域）；建议由对应 ticket
  持有者更新断言；另 boards.ts `dbHit.length > 0` 使哨兵 `[]` 暂落为空请求，
  待消费端 ticket 承接（本层已可命中 `[]`）。
