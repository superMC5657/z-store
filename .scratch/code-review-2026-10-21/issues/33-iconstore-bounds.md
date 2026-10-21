# Issue 33: iconStore 四容器无上限增长

Status: resolved
Priority: P3（前端内存）
来源: 2026-10-21 全项目审查 · services 分片

## 描述

`src/services/iconStore.ts:264-275`：`iconById` / `iconLevelById` / `iconDataCache` /
`iconPersistedKeys` 四容器无容量上限与淘汰（仅在图标升级时删除旧值）。长会话跨榜浏览
无界增长——对照 D9 榜缓存"内存 200 有界"的既有口径，图标面缺同等约束。

## 修复方向

- 四容器统一走上限 + FIFO/LRU 淘汰（数值需与 M2 落盘层协调，避免淘汰已持久化条目造成
  反复重读；`iconPersistedKeys` 可豁免或只存键不存数据）。
- 参照 `TRENDS_CACHE_MAX_ENTRIES` 的先例命名与 sweep 语义。

## Comments

- 取值 200（`ICON_STORE_MAX_ENTRIES = 200`），理由：直接对齐 D9 榜缓存
  `TRENDS_CACHE_MAX_ENTRIES = 200` 的既有口径（同 repo 单一"内存 200 有界"心智，不再造
  第二个魔法数）；粒度上榜缓存 200 计榜单、图标面 200 计应用，同一长会话跨榜浏览触及的
  应用数量级相当；`iconDataCache` 虽存 `data:` 直显态（单条可达数十 KB），200 条与榜缓存
  200 条富列表同内存量级，且淘汰后自愈路径零网络成本（见下）。
- 淘汰语义取写时 FIFO 删最旧（`writeTrendsCache` 同型），非 LRU：图标无榜缓存那样的
  刷新写序需求，已存在覆盖写不重排插入序；先例即 FIFO，保持同型可预期。
- M2 协调：淘汰的已落盘条目按既有语义自愈——`iconDataCache` miss 后展示回落 URL 直显，
  组装补齐（`queueAssembledRowIcons`→`isIconPersistedOrQueued` 判未覆盖）重新入队
  `get_or_fetch_icon`，后端落盘缓存命中不走网络，与榜缓存 L1 淘汰回落 L2 落盘同型，
  不产生"反复重读打网络"。
- `iconPersistedKeys` 未豁免、统一有界：它本就只存键（工单豁免理由已满足），但现状
  **无任何读路径**（仅写侧簿记：add/delete/clear），有界化零行为风险、纯防慢涨；未来
  若接读路径，FIFO 丢标记的最坏后果也只是多一次落盘缓存重读（同自愈路径）。
- 写点收口：四容器全部 `.set`/`.add` 换经 `rememberIconLevel`/`rememberBufferedIcon`/
  `rememberIconData`/`rememberPersistedKey`（内置裁剪），含测试 seam
  `__setIconDataCacheForTests`；新增只读探针 `__getIconStoreSizesForTests`。
- 测试：`src/services/iconStore.bounds.test.ts` 4 用例（210 命中后四容器均钳 200 /
  FIFO 淘汰最旧且最新保留 / seam 写入同走有界口 / 同 id 覆盖写不增长），
  桩 `__TAURI_INTERNALS__` 走真实预热路（`getOrFetchIcon` mock，无 IPC）。4/4 通过；
  既有图标面 6 测试文件 45 用例全绿。
