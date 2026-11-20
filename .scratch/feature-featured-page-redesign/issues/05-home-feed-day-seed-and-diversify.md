# Issue 05: 主流改用日期种子、分类打散、反馈沉底

Status: resolved
Blocked by: 04

## 背景

「全部精选」主流仍固定 `seed 7`，同类应用会成串出现，被用户标记「不感兴趣」的应用也照常排在前面（ADR-0023 §2.5、§2.6）。

## 目标

1. `get_home_feed` 的 `seed` 由前端传 `daySeed` 数值（参数名不变，单词参数免 camelCase 规则）。
2. `catalog_feed_score.rs` 新增 `diversify_by_category(ranked, window = 60, max_run = 2)`：只在前 60 个内贪心重排，保证同一分类不连续超过 2 个；60 之后原序不动，分页稳定。仅在 `balanced` 下启用。
3. 画像的 `dismissed_app_ids` 命中的应用移到结果末尾（保持其相对顺序）。
4. 前端 `useHomeFeed`：`FIXED_FEED_SEED` 改为 `daySeed()`（新建 `src/services/daySeed.ts`：本地日期 `yyyymmdd` 整数，跨零点不在同一次会话里自动刷新）；前端 `rankFeed` 回退路径使用同一种子。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/catalog_feed_score.rs`、`src-tauri/src/commands/catalog_feed.rs`（仅 `get_home_feed`）、`src/views/HomeView/useHomeFeed.ts`、`src/services/daySeed.ts`（新建）及对应测试。
- 禁止触碰：`src-tauri/src/github/affinity.rs`、`src-tauri/src/github/featured.rs`。

## 验收标准

- [x] 单测：打散后前 60 个内无连续 3 个同分类（候选分类足够时）；第 61 个之后与打散前一致。
- [x] 单测：被反馈的应用出现在 `total` 的末段。
- [x] 单测：`daySeed` 对 2026-11-13 返回 `20261113`。
- [x] 现有 `HomeView` 系列前端测试通过（如断言了 seed 7，改为注入固定日期）。
