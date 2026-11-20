# Issue 03: `affinity_explain` 与 `Reason` 类型（理由与打分同源）

Status: resolved
Blocked by: 02

## 背景

推荐理由必须来自实际加分项，不能另写一套文案规则（ADR-0023 §2.2）。

## 目标

1. 把 `affinity_boost` 的分项计算抽成内部 `AffinityBreakdown { cat, owner, tok, matched_tokens, fork_resonance, known_penalty }`，`affinity_boost` 改为基于它求和，数值与现状逐位一致。
2. 新增 `Reason`（`#[serde(tag = "kind", rename_all = "snake_case")]`，变体见 spec §4）与 `SeedRelation`。
3. `affinity_explain(&self, app) -> Vec<Reason>`：按分项贡献（`3.2·cat`、`1.8·owner`、`1.8·tok`）降序，贡献 < 0.25 的不出，最多 2 条；`keywords` 最多带 3 个命中词（取权重最高的）。
4. 新增 `seed_similarity(seed: &CatalogItem, candidate: &AppSummary) -> f64`：同分类 0.5 + 同作者 0.3 + 关键词 Jaccard × 0.2。
5. 画像记录每个种子的 `(id, relation, 基准权重 × 衰减)`，公开 `top_seeds(limit) -> Vec<SeedRef>`（仅命中目录、分类互斥）。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/affinity.rs`、`src-tauri/src/models.rs`（仅新增 `Reason` / `SeedRelation` 如需放在模型层）。
- 禁止触碰：`src-tauri/src/commands/*`、`src/*`。

## 验收标准

- [x] 属性式单测：对固定画像与目录，重构前后 `affinity_boost` 结果相同。
- [x] 单测：同分类同作者候选的理由顺序为 `category` 在前、`owner` 在后。
- [x] 单测：已知（收藏 / 关注 / 已装）条目不出 `owner` 理由。
- [x] 单测：`top_seeds` 返回的种子分类互不相同。
