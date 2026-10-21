# Issue 19: 趋势榜缓存读-合并-写竞态丢数据

Status: resolved
Priority: P2（数据完整性）
来源: 2026-10-21 全项目审查 · services 分片

## 描述

`src/services/trends/cache.ts:446`：`saveBoardCacheMerged` 读-合并-写无按 key 的在途
串行化。800ms debounce（board.ts:126）、confirm 写透、pagehide flush、hydrate 写透并发
时，两次 get→save 交错，last-write-wins 丢一侧 enrich/confirmedOther 数据。

## 修复方向

- 按榜单 key 维护在途 Promise 链（mutex/map of chains），合并写串行化；或改为单飞行
  队列，后到合并请求基于最新已写快照 rebase。
- pagehide flush 与 debounce 写透共享同一队列入口，避免旁路。

## Comments

- **按 key 在途链串行化**（`src/services/trends/cache.ts#saveBoardCacheMerged`）：取
  「mutex/map of chains」方向——新增模块级 `boardSaveChains: Map<key, Promise<void>>`，
  公开 `saveBoardCacheMerged` 改为薄队列入口（前驱 `.catch` 隔离后 `.then` 排队，落定后
  仍是链尾即删防悬挂），原读-合并-写体下沉为私有 `runBoardCacheMerged`。后到合并请求
  在前一次写盘落定后才发起 `getDbTrendCache` 读盘，天然基于最新已写快照 rebase，
  last-write-wins 丢 enrich/confirmedOther 被堵。内部全吞错永不变 reject，为串行链
  依赖约定（与既有 `saveDbTrendCache`/`getDbTrendCache` 吞错语义一致）。
- **共享同一队列入口**：debounce 写透（board.ts `maybeScheduleBoardPersist`）、pagehide
  flush（`flushBoardPersist`）、confirm/settle 写透（`maybePersistLitePatched` /
  `confirmLiteEmpty` / `maybePersistSettleConfirmed`）、boards.ts 抓取落盘共 8 处调用点
  已统一走 `saveBoardCacheMerged`，串行化在函数内收口即全覆盖，无需改调用方；
  flush 清 timer 后入队，与已触发的 debounce 任务同链排队不旁路。
- **测试**（cache.test.ts 新增 2 例）：并发双写 mock 首读挂起在途，断言 B 在 A 落定前
  不读盘 + 调用序严格 读A→写A→读B→写B + 双侧 enrich/confirmedOther 均落盘
  （无串行化时该序列为 读A→读B→写A→写B 且丢 A 侧）；链空转后再写仍正常落盘。
  测试中 mark/put 顺序踩坑一次：未确认 loading 不进 enrich 内存，须先 mark 后 put。
  vitest 20/20 全绿。进度事件上报不涉及（本张纯前端缓存）。
