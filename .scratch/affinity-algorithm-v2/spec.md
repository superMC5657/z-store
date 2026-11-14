# Feature Spec: 本地推荐算法二期优化（画像校准、单调词袋与温度轮换货架）

> 状态：Implemented
> 决策依据：ADR-0024（并修订 ADR-0023 §2.1 / §2.4 / §2.5 / §2.6 部分细则）
> 前置：`.scratch/feature-local-affinity-recommendation/`、`.scratch/feature-featured-page-redesign/`

## 1. 背景与问题诊断

基于真实 `catalog.json`（366 款精选开源应用）的离线回放与数学推导，一期/重设计后的本地推荐算法存在以下核心瓶颈：

1. **关键词打分违反单调性，且存在虚词霸榜与中文丢失**：
   - `UserAffinityProfile::breakdown` 对命中的 Top-3 词取算术平均 `sum / take_n`，导致多命中低权重相关词反而拉低总分；
   - `extract_affinity_tokens` 保留连字符且缺失目录级 IDF，使 `open-source`（36 款）、`cross-platform`（39 款）、`desktop`（41 款）、`https`（15 款）霸占词袋并污染推荐理由；
   - Rust 侧分词器丢弃全部非 ASCII 字符，导致纯中文搜索历史（`search_history`）100% 提取为空。
2. **多源信号量纲失衡**：
   - 最多 5,000 条 GitHub 仓库信号与寥寥数条应用内操作共用单一线性累加器后除以全局 `max_v`，叠加 `infer_categories_from_repo`「只要有语言就兜底赋 `dev` 0.45」与短词子串误匹配（`video→ide`、`client→cli`、`github→git`），重度 GitHub 用户的 `dev` 原始分可达 `400+`，将应用内显式收藏与冷启动兴趣种子（固定 `+2.0`）稀释至 `< 0.05`（甚至误判落入 `Explore`）。
3. **分类级推荐负反馈（「少推这类」）存在闭环漏洞**：
   - 仅对已有分类权重乘 `0.5`：`Explore` / `Off` / `Cold` 下原权重为 `0` 时点击无效；轻度偏好（如 `0.24`）折半后（`0.12 < 0.15`）反而跨过阈值进入「探索新领域」；且触发操作的那张卡片未落库 `app` 级屏蔽，重进页面仍可复现。
4. **GitHub 仓库特征信号时间衰减失真**：
   - 同步时将所有分页仓库的 `updated_at` 统一写为同步时刻 `now`，多年老 Star 与今日新 Star 衰减系数同为 `1.0`，「因为你 Star 了 Y」因同分按 `id` 升序退化为按字母表选种子。
5. **精选货架头部垄断与种子相似度同质化**：
   - 沿用列表微扰 `FEED_JITTER_HALF = 0.15`（全幅 `0.30`）抽样精选货架，实测 30 天内编辑精选主 Hero 仅出现 2 款应用、`Rich` 态主 Hero 100% 锁定单款应用；
   - 全库多作品开发者仅 5 个，`seed_similarity`（同分类 `0.5` + 同作者 `0.3` + Jaccard `0.2`，阈值 `0.35`）封死了 98.5% 的跨分类互补推荐；
   - 画像构建乘 `repo_scale_factor` 与打分基线 `ln(stars+1)` 构成流行度双重计权。
6. **已知项占坑与足迹断层**：
   - 精选货架仅硬排除已安装应用，十万星级的已收藏/已关注应用扣 `1.2` 分后仍占据精选曝光位；
   - 未命中目录的本地浏览/收藏不进画像，导致隐私看板有计数而精选页仍卡在 `Cold` 态；
   - `Rich` 态在有效种子不足时硬性关闭「本月新入库」（`fresh`），导致货架变少。

## 2. ADR 契约冲突与显式修订说明

按 `docs/agents/domain.md` 规范，本方案对既有 **ADR-0023** 的以下条款作显式重开与修订（落地后记入 ADR-0024 并回写 ADR-0023 交叉引用）：

- _Contradicts ADR-0023 §2.4（仅已安装应用从推荐区块候选中排除；收藏/关注仅靠 `known_penalty` 让位）_，重开原因：实测十万星级已收藏/已关注应用扣 `1.2` 分后仍压制同分类新应用霸占精选页约 15 个黄金卡位。**修订为**：应用内显式资产关系（`user_favorites` ∪ `watched_apps` ∪ `installed_apps`）一律从精选货架候选中硬排除，仅保留作为 `because_you` 推荐种子的资格（`get_home_feed` 全量流仍维持软扣分让位）。
- _Contradicts ADR-0023 §2.5（`scope = category` 仅将归一化分类权重 ×0.5）_，重开原因：在探索栏（原权重 `0`）点击无效，且 `0.2~0.29` 权重折半后反向掉入 `< 0.15` 探索池，触发点击的单卡也会复现。**修订为**：`dismissed_categories` 同时从 `Explore`、分类挑选与无画像轮换池中剔除，在 `affinity_boost` 施加 `-1.5` 抑制项；前端从某卡片发起「少推这类」时传 `appId`，后端原子双写 `(category, 'category')` 与 `(app_id, 'app')`。
- _Contradicts ADR-0023 §2.1 & §2.6（`fresh` 仅在非 `rich` 时出现；货架共用 `±0.15` 微抖动）_，重开原因：目录外信号使画像进入 `rich` 但无目录内种子时页面缺少货架；`±0.15` 抖动无法在真实星数分布上产生跨日轮换。**修订为**：`rich` 态在 `because_you` 实际产出不足 2 排时自动保留 `fresh` 货架补位；精选货架独立使用宽幅确定性日期采样（`SHELF_JITTER_HALF = 1.15`）及分类 Top-5 探索池轮换。

## 3. 核心算法设计（V2）

### 3.1 中英双语分词、IDF 词表与词边界分类推断（`affinity_text.rs`）

1. **双语分词 `extract_affinity_tokens(text)`**：
   - 预处理剥离 `http://...`、`https://...` URL 片段；
   - ASCII 段：按非字母数字字符切分（连字符 `-` 拆开，保留 `c++`、`2fa`、`3d`、`k8s` 等技术词），长度 `>= 3` 或命中双字符技术白名单（`ai`, `ui`, `2d`, `3d`, `db`, `os`, `vm`, `go`, `qt`），过滤对齐后的停用词表（含 `desktop`, `your`, `you`, `more`, `all`, `official`, `repository`, `supports`, `powerful` 等）；
   - CJK 段：连续中文字符（长度 `>= 2`）按滑动窗口提取 2-gram 双字词元，过滤中文泛化虚词（`开源`, `软件`, `工具`, `应用`, `支持`, `平台`, `客户`, `户端`, `免费`, `一个`, `基于`, `跨平`）。
2. **目录级逆文档频率 `CatalogIdf`**：
   - 基于当前合并目录（总文档数 $N$，词元文档频次 $\text{df}(t)$）计算归一化 IDF：
     $$\text{idf}(t) = \text{clamp}\left(\frac{\ln\frac{N + 1}{\text{df}(t) + 1}}{\ln(N + 1)},\ 0.15,\ 1.0\right)$$
   - 目录中未出现的用户特定搜索词默认 $\text{idf}(t) = 1.0$。
3. **词边界分类推断 `infer_categories_from_repo`**：
   - 规则拆分为 `exact_tokens`（在分词后的 ASCII 词元集合中整词精确匹配，杜绝 `video→ide`、`client→cli`、`github→git`、`notebook→book`）与 `phrases`（多词英文短语如 `"file manager"` 及中文关键词子串匹配）；
   - 移除「未命中关键词但 `language` 非空即赋 `("dev", 0.45)`」的兜底，仅保留高区分度领域语言提示（`gdscript→games`、`shaderlab/glsl/hlsl/wgsl→graphics`、`hcl/dockerfile/nix/shell/bash/powershell→ops`、`tex/typst→office`）。

### 3.2 真实信号时间戳与未收录详情回退

1. **GitHub 真实交互时间**：
   - `/user/starred` 请求携带 `Accept: application/vnd.github.star+json`，兼容解析 `{ starred_at, repo }` 与裸 `GitHubRepoResponse` 两种载荷；若旧 `api_etag_cache` 缓存载荷不含 `starred_at` 字段，跳过 `If-None-Match` 触发一次保鲜升级；缺失 `starred_at` 时按分页全局序号 `idx` 赋予 `now - idx * 3600` 递减时间戳兜底；
   - `/user/repos` 解析 `pushed_at`（回退 `updated_at`，再回退 `now`）作为信号时间。
2. **未收录本地信号回退（`UncatalogedSignalBrief`）**：
   - `Database::load_raw_affinity_signals` 收集本地 `favorites`、`watched`、`installed`、`views` 中的 `app_id`，批量单次查询 `app_details` 表提取概要（`name`, `owner`, `repo`, `description`, `description_en`, `category`，剔除占位简介）；
   - 构建画像时若本地信号未命中 `CatalogItem`，回退消费 `UncatalogedSignalBrief`（仍无缓存则按 canonical `owner/repo` 提取作者与仓库词元），正常计入 `signal_count`、分类推断与词袋。

### 3.3 双源独立归一化与单调打分引擎（`affinity.rs`）

1. **去流行度双重计权**：
   - 命中目录的信号直接取 `w = base_weight * decay`（不再乘 `repo_scale_factor`）；
   - 目录外野生 GitHub 仓库信号乘温和可信度系数 `0.7 + 0.3 * (1.0 - (-(stars as f64) / 50.0).exp())`（抑制 0 星空壳测试仓，不放大十万星头部）。
2. **双通道独立软饱和归一化**：
   - 本地通道（收藏 `4.0`、关注 `3.5`、已装 `3.2`、浏览 `<= 2.1`、搜索 `0.4`）与 GitHub 通道（Fork `3.8`、Star `3.0`、Owned `2.4`）分别维护原始分类、作者、词元（乘 `idf(t)`）累加器，各自经 `normalize_soft_saturated(..., tau)` 归一化到 `[0, 1]`；
   - 通道融合：两通道均有信号时 $W = 0.65 \cdot W_{\text{local}} + 0.35 \cdot W_{\text{github}}$；仅单通道有信号时直接取该通道 $1.0 \cdot W$；
   - 冷启动 `interest_seeds` 以显式分类先验独立合入：`W_cat(c) = W_cat(c).max(0.75)`（若已有行为分则 `1.0 - (1.0 - W_cat(c)) * 0.4` 温和抬升并封顶 `1.0`），确保不被外部海量仓库冲刷归零。
3. **单调递增关键词匹配与精简 `ForkResonance`**：
   - 候选匹配文本取 `name + repo + description + description_en`；
   - 命中词元按用户权重 $s_i = W_{\text{tok}}(t_i) \cdot \text{idf}(t_i)$ 降序排列，取前 3 项做固定系数单调加权：
     $$\text{raw\_tok\_score} = \text{clamp}(0.60 s_1 + 0.25 s_2 + 0.15 s_3,\ 0.0,\ 1.0)$$
   - 移除不可解释且近似常数的 `fork_resonance`；
   - 最终增益：
     $$\text{affinity\_boost} = 3.2 P_{\text{cat}} + 1.8 P_{\text{owner}} + 1.8 P_{\text{tok}} - 1.5 \cdot \mathbb{I}(\text{cat} \in \text{dismissed\_cats}) - 1.2 \cdot \mathbb{I}(\text{known})$$
4. **跨分类语义感知的 `seed_similarity`**：
   - 基于 `name + repo + aliases + description + description_en` 的 IDF 词元向量计算余弦相似度 $\text{sim}_{\text{tok}} \in [0, 1]$：
     $$\text{seed\_similarity} = 0.25 \cdot \mathbb{I}(\text{same\_cat}) + 0.25 \cdot \mathbb{I}(\text{same\_owner}) + 0.50 \cdot \text{sim}_{\text{tok}}$$
   - `SEED_SIMILARITY_MIN` 调整为 `0.28`，放行高语义相关的跨分类互补工具。

### 3.4 精选页温度轮换组装与负反馈闭环（`featured.rs`）

1. **候选过滤**：排除 `hidden_ids`、非 `allowed_ids`、`dismissed_app_ids` 以及 `profile.explicit_local_ids`（`favorites` ∪ `watched` ∪ `installed`，不受个性化开关影响）。
2. **宽幅确定性货架采样**：
   - 精选货架独立使用 `SHELF_JITTER_HALF = 1.15`（全幅 `2.30`，对应约 $10\times$ 星数竞争窗口），并对极低星长尾设软门槛（`stars < 500` 时抖动上限收敛至 `0.30`，防止百星冷门仓靠极端随机数蹿上 Hero）；
   - `Explore` 货架在每个满足 `W_cat < 0.15` 且不在 `dismissed_categories` 中的分类里，取纯质量分前 `EXPLORE_PER_CAT_POOL = 5` 名构成精品池，按 `feed_jitter01(app.id, day_seed)` 选出当日代表作。
3. **分类负反馈全链路生效**：
   - `Explore`、`category_pick` 与无画像 `rotated_categories` 优先跳过 `dismissed_categories`（仅在跳过后不足 `SHELF_MIN` 时回退使用被抑制分类兜底防空）；
4. **`Rich` 态动态补位 `Fresh`**：
   - 当 `state != ProfileState::Rich || because_you_shelves_count < 2` 时启用 `Fresh`（「本月新入库」）货架组装。

## 4. IPC 与前后端改动契约

遵循 AGENTS.md：请求键一律 `camelCase`，响应字段保持 `snake_case`，演示站 mock 仅接受 `camelCase`。

```ts
// 扩展 dismiss_featured：新增可选 appId
dismiss_featured
  args: { target: string; scope: 'app' | 'category'; appId?: string }
  resp: void
```

- 当 `scope === 'category'` 且提供合法 `appId` 时，后端在单次事务中同时 `upsert_feed_feedback(category, Category, now)` 与 `upsert_feed_feedback(canonical(appId), App, now)`；
- `get_featured_page`、`get_affinity_profile_summary`、`get_home_feed` 请求/响应 JSON 结构保持完全向后兼容，无破坏性字段变更；
- 清理前端 `src/services/feed.ts` 中无业务调用的重复画像打分器 `buildFrontendAffinityScorer`，消除前后端双口径隐患。

## 5. Issue 拆分与依赖拓扑

1. [`01-github-signal-real-timestamps-and-uncataloged-briefs.md`](./issues/01-github-signal-real-timestamps-and-uncataloged-briefs.md)（无前置）：GitHub `star+json` 真实标星/推送时间解析 + SQLite 未收录详情轻量摘要批量读取。
2. [`02-tokenizer-idf-and-word-boundary-classifier.md`](./issues/02-tokenizer-idf-and-word-boundary-classifier.md)（无前置，与 01 并行）：新建 `affinity_text.rs` 实现中英双语分词、目录级 `CatalogIdf` 与词边界分类推断器。
3. [`03-dual-source-profile-and-monotonic-scoring.md`](./issues/03-dual-source-profile-and-monotonic-scoring.md)（依赖 01, 02）：双源独立归一化、单调 IDF 词元打分、去流行度双重计权、未收录信号接入与跨分类 `seed_similarity`。
4. [`04-featured-shelf-sampling-and-guards.md`](./issues/04-featured-shelf-sampling-and-guards.md)（依赖 03）：精选货架宽幅确定性轮换、已知项（收藏/关注/已装）硬排除、分类负反馈闭环与 `Rich` 态 `Fresh` 动态补位。
5. [`05-category-dismiss-card-persistence-and-ipc.md`](./issues/05-category-dismiss-card-persistence-and-ipc.md)（依赖 04）：`dismiss_featured` 扩展 `appId` 原子双写，联动前端 Hook、API 门禁测试与演示站 Mock。
6. [`06-cleanup-dead-frontend-affinity-scorer.md`](./issues/06-cleanup-dead-frontend-affinity-scorer.md)（无前置，可并行）：清理 `src/services/feed.ts` 中未使用的 `buildFrontendAffinityScorer` 死代码。
7. [`07-real-catalog-benchmark-regression-tests.md`](./issues/07-real-catalog-benchmark-regression-tests.md)（依赖 04, 05, 06）：加载真实 `catalog.json` 建立 30 天轮换多样性、抗淹没、单调性与分类推断准确率自动化门禁。
8. [`08-docs-adr-and-acceptance.md`](./issues/08-docs-adr-and-acceptance.md)（依赖 01–07）：新增 ADR-0024、修订 ADR-0023 关联说明、同步 `CONTEXT.md` 并执行全量验收。

## 6. 整体验收标准

- 真实 `catalog.json` 下连续 30 个 `daySeed` 模拟中，编辑精选与个性化 `Rich` 态主 Hero 均轮换不少于 5 款不同应用；
- 300 条目录外 GitHub 仓库信号叠加 2 条应用内收藏时，本地收藏分类稳定进入 `top_categories` 前 2 且不落入 `Explore`；
- 纯中文搜索词可提取词元进入 `token_weights`；候选多命中偏好关键词时得分严格单调不减；推荐理由不含 `open-source`、`cross-platform`、`desktop`、`https` 等泛化虚词；
- 在 `Explore`、`Warm`、`Rich`、`Off` 任意货架点击「少推这类」，重算后该分类与当前点击卡片均不再出现在推荐货架；
- `ipcArgsNaming.test.ts`、`noDirectInvoke.test.ts`、`countDisplay.test.ts`、`pnpm test`、`npx tsc --noEmit`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 全绿。
