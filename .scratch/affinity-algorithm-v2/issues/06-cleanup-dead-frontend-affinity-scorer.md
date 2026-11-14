# Issue 06: 清理前端未使用的重复画像打分死代码（收敛单一真值源）

Status: resolved
Blocked by: none

## 背景

ADR-0023 §3 已明确否决在前端维护一套独立画像打分器（“前端拿不到 GitHub 仓库信号、已装与历史表，会与后端画像出现两套口径”）。目前 `src/services/feed.ts` 中仍残留约 150 行无任何生产调用的 `buildFrontendAffinityScorer` 及其私有分词/停用词/归一化实现，与后端 V2 画像演进形成双口径维护负担。

## 目标

1. 清理 `src/services/feed.ts` 中的死代码：
   - 删除 `FrontendAffinityInput`、`STOPWORDS`、`extractTokens`、`normalizeWeightMap`、`toNormalizedSet` 与 `buildFrontendAffinityScorer`；
   - **完整保留**仍有生产/演示站调用的导出：`FeedStrategy`、`hashSeeded01`、`starsForksBase`、`subscribeAffinityUpdated`、`rankFeed`、`sliceFeed`（被 `src/components/AffinityPrivacyRow.tsx` 与 `src/demo/handlers/common.ts` 引用）。
2. 同步更新 `src/services/feed.test.ts`：
   - 移除仅针对已删除函数 `buildFrontendAffinityScorer` 的测试套件；
   - 保留 `hashSeeded01` 前后端 64 位哈希一致性、`starsForksBase`、`rankFeed` 三策略排序与确定性 tie-break、`sliceFeed` 及 `subscribeAffinityUpdated` 的全部测试。

## 范围（互斥）

- 允许修改：`src/services/feed.ts`、`src/services/feed.test.ts`。
- 禁止触碰：除上述两个文件外的任何前后端文件。

## 验收标准

- [ ] 全仓搜索 `buildFrontendAffinityScorer` 零残留引用。
- [ ] `npx tsc --noEmit` 与 `pnpm test` 全部通过。
