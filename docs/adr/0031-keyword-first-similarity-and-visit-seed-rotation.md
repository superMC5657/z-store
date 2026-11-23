# ADR-0031：关键词优先的相似度与按访问轮换的精选货架

- 状态：Accepted
- 日期：2026-11-23
- 关联：ADR-0023（精选页可解释推荐）、ADR-0024（修订其 §2.4 种子相似度、§2.5 货架日期采样）、ADR-0030（修订其 §2.3 详情页相似推荐的打分与排序）
- 实现：`src-tauri/src/github/affinity.rs`、`src-tauri/src/github/catalog_service.rs`、`src-tauri/src/github/featured.rs`、`src-tauri/src/commands/catalog_featured.rs`、`src/services/visitSeed.ts`、`src/views/FeaturedView.tsx`、`src/demo/handlers/catalog.ts`
- 落地计划：随本 ADR 直接实现，未拆分 `.scratch/` issue
- 回归门禁：`src-tauri/src/github/affinity_eval_tests.rs`（真实 `catalog.json`）

## 1. 背景

在真实目录上回放详情页「相似开源项目」与精选页：

- **分类太粗，同分类即相似**：旧公式 `0.25·同分类 + 0.25·同作者 + 0.50·词元余弦` 下，同分类单独就等于 0.25 的入选门槛，再叠加 `0.15·ln(stars)` 的排序项，开发类应用的相似推荐被 opencode、VS Code、Codex 等高星工具占满（hoppscotch → opencode、scrcpy → VS Code、rustdesk → PowerToys），彼此没有任何共享关键词。
- **理由里出现汉字碎片**：双字滑窗分词把 `编程智能体` 切成 `编程 / 程智 / 智能 / 能体`，理由直接展示 `程智`、`网文`、`端模` 这类碎片。
- **精选页多次打开都是同一款**：前端传 `yyyymmdd` 日期种子，同一天内每次进入结果完全相同；hero 在每个分类只取最高分，开发偏好画像把整个 dev 分类抬高后，分类内只剩星数在比，目录星数第一的 opencode 在 30 个种子里 20 次登上 hero。

## 2. 决策

### 2.1 关键词相关度是相似度的主信号

`similarity_tokens` 产出三组词元：全文词元（名称、仓库、别名、中英简介）、策展关键词（目录 `aliases` 与开源平替元数据 `alternatives` 的分词）、整条短语（别名 / 平替原文，小写、空白折叠）。

```
关键词相关度 r =
  两侧都有策展关键词：0.35·cos(关键词) + 0.30·min(1, 短语命中数 / 1.5) + 0.35·cos(全文)
  否则：cos(全文)
相似度 = r < 0.15 ? 0 : 0.80·r + 0.12·I(同分类) + 0.08·I(同作者)
```

- 余弦按目录 IDF 加权。短语命中包括同一短语，以及一侧短语被另一侧按词边界包含（`编辑器` ⊂ `vim编辑器`、`editor` ⊂ `code editor`，`go` ⊄ `google`）。
- 同分类、同作者只在关键词相关度达标后加分，不能单独成立。
- 详情页相似推荐（`find_similar_apps`）与精选页 `because_you` / hero 种子理由共用这一公式（SSOT 不变）；`because_you` 门槛 0.28、hero 种子理由门槛 0.45 不变。

### 2.2 详情页排序：相关度优先，星数只做轻微偏好

- 入选门槛 `SIMILAR_MIN_SIMILARITY = 0.20`。
- 排序 `rank = 相似度 + 0.005·(ln(stars+1) + 0.25·ln(forks+1))`：两个数量级的星数差约合 0.03 相似度，只在相关度接近时起作用。

### 2.3 共享关键词理由可读

理由 `Keywords` 先列两侧命中的别名 / 平替短语，再列共享的高 IDF（≥ 0.5）词元（按 IDF 降序）；候选全文每段连续汉字切出的双字链里，连续命中种子的词元拼回原词（`编程`+`程智`+`智能`+`能体` → `编程智能体`），被更长拼词包含的片段不单列，已被短语按词边界覆盖的词元不重复，最多 3 个。拼词按双字链进行，不受全文词元去重影响（别名里先出现的 `智能` 不会打断简介里的拼词）。

### 2.4 精选货架按访问种子轮换

- `get_featured_page` 的入参由 `daySeed` 改为 `visitSeed`：前端每次进入精选页生成一个 32 位随机种子（`visitSeed()`），同一次访问内（平台筛选补探、负反馈后重载）保持不变，下次进入换一批。
- **hero 分类内抽样**：分类先后仍由该分类最高分决定（个性化决定哪些分类上 hero），分类内从得分前 `HERO_POOL = 5` 名里按访问种子挑 1 款。
- **分类精选抽样**：分类内得分前 `CATEGORY_PICK_POOL = 8` 名里按访问种子抽 `SHELF_SIZE` 个，展示仍按得分先后。
- 抽样使用与得分抖动错开的种子盐；`SHELF_JITTER_HALF`、长尾窄幅抖动、探索精品池与「少推这类」规则不变。
- `get_home_feed` 仍使用日期种子，本 ADR 不涉及。

## 3. 考虑过的方案

- **只调低同分类权重、保留 0.25 门槛**：同分类加同作者仍可凑过门槛，且无法表达「没有共享关键词就不相似」；改为关键词相关度门控。
- **给目录补更细的子分类标签**：需要维护新的受控词表并改动 `z-store-catalog`；目录已有每条 3–6 个人工别名，直接作为关键词更便宜。
- **按天轮换但加大抖动**：同一天内多次打开仍完全相同，且抖动再大也压不过画像对整个分类的统一加分；分类内抽样直接解决头部被单款占住的问题。
- **记录曝光历史做疲劳降权**：需要新的持久化与清理策略；每次访问换种子加分类内抽样已满足轮换，暂不引入。

## 4. 后果

- 相似推荐结果变少但更准：没有共享关键词的同分类高星应用不再出现，个别缺少同赛道条目的应用（如 ripgrep）结果为空，前端 `<SimilarAppsSection>` 按既有约定静默折叠。
- `affinity::similarity_tokens` 返回 `SimilarityTokens`（全文词元、汉字双字链、策展关键词、短语、规范化的分类与作者）；`seed_similarity_with_tokens` / `similarity_from_tokens` 只接收两侧 `SimilarityTokens`，`explain_similarity_reasons` 接收种子的 `SimilarityTokens` 与候选应用。
- 演示站 mock（`src/demo/handlers/catalog.ts`）使用同名常量与同一公式（IDF 加权余弦、按词边界的短语命中、IDF ≥ 0.5 的理由词元）；其分词把连续汉字整段作为一个词元，不产生双字碎片，因此不需要拼词。
- 真实目录门禁新增：所有目录条目的相似结果都带共享关键词理由；hoppscotch、scrcpy、ripgrep、alacritty、vlc、rustdesk 不推出 opencode / VS Code / Codex；hoppscotch、alacritty、vlc、rustdesk 命中各自的同赛道代表，目录里没有同赛道条目的 scrcpy 只推出共享 `android` 关键词的条目、ripgrep 结果为空；opencode 推出 Codex、Cline、Qwen Code；开发重度画像 30 次访问里 dev hero 至少 4 款、星数第一的应用上 hero 不超过一半。门禁的 30 个访问种子与前端一样是 32 位随机整数（固定起点生成以便复现）。
- ADR-0024 §2.5 门禁里的「连续 30 个日期种子」改为 30 个访问种子，阈值不变。
