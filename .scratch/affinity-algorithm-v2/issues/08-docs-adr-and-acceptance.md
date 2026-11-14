# Issue 08: ADR-0024 立项转正、领域词汇表同步与全量验收

Status: resolved
Blocked by: 01, 02, 03, 04, 05, 06, 07

## 背景

按 `AGENTS.md` 与 `docs/agents/domain.md` 规范，领域文档（`CONTEXT.md` 与 `docs/adr/`）必须在代码全部落地验证后再同步当前行为，并将对 ADR-0023 的显式修订正式固化为架构决策记录。

## 目标

1. **新增 `docs/adr/0024-affinity-scoring-v2-and-shelf-sampling.md`（状态：`Accepted`）**：
   - 记录二期推荐算法核心决策：
     - 双源（应用内本地信号 `0.65` : GitHub 仓库信号 `0.35`）独立软饱和归一化与兴趣种子先验，解决海量外部仓库稀释本地意图问题；
     - 中英双语分词、目录级 `CatalogIdf`、单调递增词元打分（`0.60·s1 + 0.25·s2 + 0.15·s3`）、词边界分类推断与移除 `ForkResonance`；
     - GitHub `star+json` 真实 `starred_at` / `pushed_at` 时间衰减与未收录应用 `app_details` 摘要回退；
     - 精选货架宽幅确定性日期采样（`SHELF_JITTER_HALF`）、探索分类精品池轮换、应用内显式收藏/关注/已装统一从推荐货架硬排除、`Rich` 态动态补位 `Fresh`，以及「少推这类」分类抑制 + 单卡屏蔽原子双写。
2. **同步更新 `docs/adr/0023-featured-page-explainable-local-recommendation.md`**：
   - 在关联头与 §2.1 / §2.4 / §2.5 / §2.6 对应段落补充指向 ADR-0024 的修订说明，保持两份 ADR 互不矛盾。
3. **同步更新 `CONTEXT.md`（仅描述当前现状，不写变更历史）**：
   - 更新词汇表中 **本地亲和度画像 (`User Affinity Profile`)**（移除“社区 Fork 活跃比”、更新双源独立归一化、IDF 单调词袋与未收录详情回退说明）、**推荐货架 (`Featured Shelf`)**（补充已装/已收藏/已关注排除及 `rich` 态种子不足时动态补位新入库）、**推荐负反馈 (`Feed Dismissal`)**（补充分类级反馈从探索/轮换池剔除及卡片发起时连带屏蔽单卡）、**仓库特征信号 (`Repo Affinity Signal`)**（补充真实 `starred_at` / `pushed_at` 时间戳解析）。
4. **更新 `.scratch/affinity-algorithm-v2/spec.md` 状态为 `Implemented`**，并执行全量门禁回归：
   - `cargo test --manifest-path src-tauri/Cargo.toml`
   - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
   - `npx tsc --noEmit`
   - `pnpm test`
   - `pnpm build:demo`（或 `npx vite build --config vite.demo.config.ts` 验证演示站构建无误）

## 范围（互斥）

- 允许修改：`docs/adr/0024-affinity-scoring-v2-and-shelf-sampling.md`（新建）、`docs/adr/0023-featured-page-explainable-local-recommendation.md`、`CONTEXT.md`、`.scratch/affinity-algorithm-v2/spec.md`。
- 禁止触碰：前后端业务源码。

## 验收标准

- [ ] `CONTEXT.md` 与 `docs/adr/0023`、`docs/adr/0024` 术语严格对齐统一领域词汇表，且只描述当前行为、不含变更历史流水账。
- [ ] `spec.md` §6 全部验收项达成。
- [ ] `cargo test`、`cargo clippy -- -D warnings`、`npx tsc --noEmit`、`pnpm test` 与演示站构建全部零错误通过。
