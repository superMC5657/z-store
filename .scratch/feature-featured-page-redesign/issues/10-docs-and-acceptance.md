# Issue 10: 文档转正与整体验收

Status: resolved
Blocked by: 01, 02, 03, 04, 05, 06, 07, 08, 09

## 背景

`CONTEXT.md` 与 ADR-0013 描述的是现状，必须在功能落地后再改，避免文档先于代码。

## 目标

1. ADR-0023 状态改为 Accepted；按实际实现修正与 ADR 不符之处。
2. ADR-0013 第 1 条：`seed 7` 改为日期种子 `daySeed`，「经典精选开源软件（前 4）」改为指向 ADR-0023 的精选页货架；补充主流分类打散与反馈沉底。
3. `CONTEXT.md`：
   - 词汇表新增：**推荐理由** `Recommendation Reason`、**推荐货架** `Featured Shelf`、**兴趣种子** `Interest Seed`、**推荐负反馈** `Feed Dismissal`、**画像状态** `Profile State`（off / cold / warm / rich）、**日期种子** `Day Seed`；
   - 改写「本地亲和度画像」条目的信号清单（加入已装、浏览、搜索、兴趣种子、反馈）；
   - 改写架构段落中「首页固定 `balanced` 排序与 `seed 7`」一句。
4. 整体验收：按 spec §8 逐项勾选；真机（`pnpm tauri dev`）走一遍 `off` → 开启 → `cold` 选兴趣 → `warm` → 收藏 / 安装若干后 `rich` 的路径，附截图。

## 范围（互斥）

- 允许修改：`docs/adr/0013-feed-contract.md`、`docs/adr/0023-featured-page-explainable-local-recommendation.md`、`CONTEXT.md`、本目录下的 `spec.md`。
- 禁止触碰：代码文件。

## 验收标准

- [x] spec §8 全部勾选。
- [x] `CONTEXT.md` 中不再出现 `seed 7` 与「经典精选开源软件」。

## Comments

- 2026-11-13：文档部分已完成（ADR-0023 转 Accepted 并补实现说明、ADR-0013 第 1 条修订、`CONTEXT.md` 新增 7 个术语并改写画像条目与首页段落）。`pnpm test`（98 文件 / 1025 用例）、`cargo test`（436 用例）与 `cargo clippy` 通过；演示站已目测 `rich` 与 `cold` 两种状态及「不感兴趣」交互。
- 2026-11-20：维护者已完成真机 `off → 开启 → cold 选兴趣 → warm → rich` 人工验收，并同步完成本票与 `spec.md` §8 验收勾选。
