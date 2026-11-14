# ADR-0024：画像双通道归一化、IDF 单调词袋与精选货架日期采样

- 状态：Accepted
- 日期：2026-11-14
- 关联：ADR-0023（精选页推荐货架；本 ADR 修订其 §2.1、§2.4、§2.5、§2.6 的部分细则）
- 范围：后端（`affinity_text` 文本底座、`UserAffinityProfile` 打分、GitHub 画像同步时间戳、`app_details` 概要回退、`featured.rs` 货架组装、`dismiss_featured` 命令）；前端（`dismissFeatured` 附带 `appId`、演示站 mock、删除前端画像打分器）
- 落地计划：`.scratch/affinity-algorithm-v2/`
- 实现：`src-tauri/src/github/affinity_text.rs`、`src-tauri/src/github/affinity.rs`、`src-tauri/src/github/featured.rs`、`src-tauri/src/db/affinity.rs`、`src-tauri/src/commands/catalog_feed.rs`
- 回归门禁：`src-tauri/src/github/affinity_eval_tests.rs`（加载仓库根目录 `catalog.json`）

## 1. 背景

在真实目录（366 款、星数 105–225k 幂律分布）上回放 ADR-0023 的画像与货架，暴露出：

- **关键词打分不单调、虚词霸榜**：Top-3 命中取算术平均，多命中一个低权重词反而拉低总分；分词保留连字符且无 IDF，`open-source`、`cross-platform`、`desktop`、`https` 占满词袋和推荐理由；非 ASCII 字符全部丢弃，中文搜索词提取为空。
- **重度 GitHub 账号淹没本地意图**：上千条仓库信号与少量应用内操作共用一个累加器再除以全局最大值；分类推断用裸子串（`video→ide`、`client→cli`、`github→git`），且「有语言就兜底 `dev` 0.45」，`dev` 原始分可达数百，收藏和兴趣种子被稀释到探索区。
- **「少推这类」不闭环**：只把已有权重 ×0.5，原权重为 0 的探索分类点了无效；轻度偏好折半后反而掉进 `< 0.15` 的探索池；触发操作的那张卡片下次进入还在。
- **GitHub 信号时间失真**：同步时把所有仓库的时间写成同步时刻，多年前的 Star 与今天的 Star 衰减相同。
- **货架不轮换、种子相似度只认同分类同作者**：`±0.15` 抖动在真实星数跨度下 30 天里主 hero 几乎不变；全库多作品作者极少，`同分类 0.5 + 同作者 0.3` 封死跨分类互补推荐；画像构建乘仓库规模系数、打分又有 `ln(stars)` 基线，流行度被算两次。
- **已知项占位与足迹断层**：已收藏 / 已关注的高星应用扣 1.2 分后仍占精选位；未收录应用的收藏和浏览不进画像；`rich` 态种子不在目录时页面货架变少。

## 2. 决策

### 2.1 文本底座：双语分词、目录 IDF、词边界分类推断

`affinity_text.rs` 是画像与相似度的唯一文本入口：

- **分词** `extract_tokens`：先剥离 `http(s)://` 片段；英文按非字母数字切分（`-`、`/`、`.`、`_` 都切开，保留词内 `+` 如 `c++`），长度 ≥ 3 或命中短技术词白名单（`ai`、`ui`、`3d`、`db`、`os`、`vm` 等），过滤停用词与纯数字；连续汉字按双字滑窗切分，功能字与泛化双字词（`开源`、`软件`、`工具`、`跨平` 等）作为分隔，不在其两侧拼出跨词碎片。
- **目录 IDF** `CatalogIdf`：每条目录项的名称、仓库、中英简介、别名为一个文档，`idf(t) = clamp(ln((N+1)/(df+1)) / ln(N+1), 0.15, 1.0)`；空目录或目录中未出现的词为 `1.0`。另提供按 IDF 加权的余弦相似度。
- **分类推断** `infer_categories`：英文关键词按整词匹配（带简单复数还原），多词短语按词边界匹配，中文关键词按子串匹配，匹配文本只取 `full_name` 与描述；编程语言只用于高区分度领域语言提示（`gdscript`、`glsl` 系、`hcl`/`nix`/shell 系、`tex`/`typst`），不参与关键词匹配（否则 `Shell`、`Vim Script` 会命中 dev 的 `shell`、`vim`），也没有「有语言就归 `dev`」的兜底。在真实目录上 Top-1 准确率需 ≥ 72%，`dev` 预测数不超过真实数的 1.35 倍（门禁见 `affinity_eval_tests.rs`）。

### 2.2 画像：两个通道各自归一化后融合

- 本地通道（收藏 4.0、关注 3.5、已装 3.2、浏览 ≤ 2.1、搜索 0.4）与 GitHub 通道（Fork 3.8、Star 3.0、自有 2.4）分别累加分类、作者、词元（词元乘 IDF），各自做软饱和归一化（分类 τ=2.2、作者 τ=2.5、词元 τ=2.0）。
- 融合：某一维度两个通道都有值时 `0.65 × 本地 + 0.35 × GitHub`，只有一侧时直接取该侧。
- 兴趣种子作为显式先验在融合后合入：`w = max(w, 0.75, 1 − (1 − w) × 0.4)`，封顶 1.0。
- 「少推这类」分类在融合后权重仍 ×0.5。
- 命中目录的信号按 `基准权重 × 时间衰减` 计入，不再乘仓库规模系数；目录外 GitHub 仓库乘可信度 `0.7 + 0.3 × (1 − e^(−stars/50))`，压低零星空壳仓库、不放大高星头部。
- 本地收藏 / 关注 / 已装 / 浏览未命中目录时，用 `app_details` 中的概要（`UncatalogedSignalBrief`：名称、作者、仓库、中英简介、分类，占位简介置空）计入；分类不是 10 个标准分类之一时走分类推断；连概要也没有时只用 `owner/repo`。这些信号照常计入 `signal_count`。
- 画像对外公开 `explicit_local_ids`（收藏 ∪ 关注 ∪ 已装，不受信号源开关影响）与 `dismissed_categories`。

### 2.3 打分：单调关键词分、分类抑制，去掉 Fork 共振

```
affinity_boost = 3.2·P_cat + 1.8·P_owner + 1.8·P_tok − 1.5·I(分类被少推) − 1.2·I(已知)
P_tok = clamp(0.60·s1 + 0.25·s2 + 0.15·s3, 0, 1)，s_i = W_tok(t_i) × idf(t_i) 降序
```

- 候选文本为名称、仓库、中英简介；固定系数加权保证多命中一个偏好词只会加分。
- 删除近似常数、无法解释的 Fork 共振项。
- 推荐理由仍与打分同源；画像只有词袋信号（如只有搜索历史）时，命中的关键词即使贡献低于 0.25 也作为理由展示。

### 2.4 种子相似度跨分类

`seed_similarity = 0.25·I(同分类) + 0.25·I(同作者) + 0.50·sim_tok`，`sim_tok` 为名称、仓库、别名、中英简介词元的 IDF 加权余弦。`because_you` 阈值 0.28，hero 附带种子理由阈值 0.45。语义相近的跨分类工具（如远程控制与局域网传输）可以进入同一排。

### 2.5 精选货架组装

- **候选排除**：隐藏、平台不可见、「不感兴趣」，以及应用内显式关系（收藏 ∪ 关注 ∪ 已装）的应用一律不进推荐货架；它们仍可作为 `because_you` 的种子被查找和命名。`get_home_feed` 主流仍只做 1.2 的让位扣分。
- **日期采样**：货架质量分 = `ln(stars+1) + 0.25·ln(forks+1)` + 日期抖动；星数 ≥ 500 的应用抖动半幅为 `SHELF_JITTER_HALF = 1.15`（全幅约等于 10 倍星数的竞争窗口），更低星数只用 `±0.15`，长尾应用不会靠极端随机数登上 hero。`get_home_feed` 的 `±0.15` 不变。
- **探索新领域**：每个画像权重 < 0.15 且未被少推的分类，按纯质量分取前 `EXPLORE_PER_CAT_POOL = 5` 个组成精品池，再按日期种子挑当日代表作；分类之间仍按日期种子轮换取 4 个。
- **「少推这类」全货架生效**：hero 先在未被少推的分类里互斥取满，凑不满才用被少推的分类补位；`because_you` 不以被少推分类的应用为种子，候选也排除该分类；本月新入库排除该分类；个性化的分类精选直接剔除被少推的分类；无画像的分类轮换把它们排到队尾，只在其余分类不足时兜底；探索直接跳过。
- **`rich` 态补位新入库**：`fresh` 在非 `rich`，或 `rich` 但实际产出的 `because_you` 不足 2 排时出现。
- **`because_you` 理由**：优先画像给出的作者 / 关键词理由，其次种子与候选共同的高 IDF 词元（IDF ≥ 0.5），都没有才用分类。

### 2.6 「少推这类」连带屏蔽卡片

`dismiss_featured` 增加可选 `appId`（请求键 camelCase）。`scope = category` 且带合法 `appId` 时，后端在同一事务中写入分类反馈与该应用的应用级反馈，完成后广播一次画像更新；不带 `appId` 时只写分类反馈。前端从卡片菜单点「少推这类」时传入该卡片 id；演示站 mock 同步维护被少推的分类集合，在分类精选、探索与 hero 中跳过它们。

### 2.7 GitHub 信号真实时间

- `/user/starred` 以 `Accept: application/vnd.github.star+json` 请求，元素兼容 `{ starred_at, repo }` 与裸仓库两种格式；`starred_at` 作为信号时间。
- `/user/repos` 取 `pushed_at`，其次 `updated_at`。
- 都缺失时按分页全局序号回退 `now − idx × 3600`，保持 GitHub 返回的先后顺序。
- 本地 `api_etag_cache` 里的 Star 页缓存有条目却不含 `starred_at`，且尚未以 `star+json` 完整同步过（设置项 `affinity_starred_format_upgraded`）时，该页不带 `If-None-Match` 重新拉取，缓存随之换成新格式；同步成功一次后即使服务端仍返回旧格式也照常发条件请求。

## 3. 考虑过的方案

- **继续用单一累加器，只给 GitHub 信号降权**：降多少都依赖账号规模，几十条与几千条仓库的用户需要不同系数；分通道归一化后与规模无关，否决。
- **分类负反馈改为直接从画像中删除该分类**：用户点「少推」不等于「再也不要」，且删除后该分类权重为 0 会被当成「新领域」推回探索；保留减半加打分抑制并从探索 / 分类精选剔除更符合语义。
- **货架改为每天完全随机抽样**：会让百星级长尾仓库登上 hero，质量感下降；宽幅抖动加星数门槛在轮换与质量之间取平衡。
- **在前端保留一套画像打分器做离线回退**：ADR-0023 已否决双口径；本次删除 `src/services/feed.ts` 中残留的 `buildFrontendAffinityScorer`。

## 4. 后果

- `UserAffinityProfile` 去掉 `avg_fork_ratio`，新增 `explicit_local_ids`、`dismissed_categories`、`idf`、`aliases`；`get_featured_page`、`get_affinity_profile_summary`、`get_home_feed` 的请求与响应结构不变。
- `RawAffinitySignals` 新增 `uncataloged_briefs`，`load_raw_affinity_signals` 对涉及的全部去重应用按每批 200 个 id 读取 `app_details` 轻量列。
- `GitHubRepoResponse` 新增 `pushed_at`、`updated_at`。
- 已收藏 / 已关注的应用不再出现在精选页推荐货架里；它们仍在主流、分类与搜索中正常出现。
- 真实目录门禁：无画像与典型 `rich` 画像下，连续 30 个日期种子内主 hero 至少 5 款、hero 三元组至少 12 组、hero 星数均 ≥ 500；300 条目录外 GitHub 信号加 2 条收藏与 1 个兴趣种子时，收藏与种子分类权重均 ≥ 0.45；推荐理由不含泛化词；四种画像状态下「少推这类」后该分类与触发卡片都不再出现在页面任何位置（其余分类足够填满 hero）。
