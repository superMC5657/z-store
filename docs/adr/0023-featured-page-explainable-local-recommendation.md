# ADR-0023：精选页改为可解释的本地推荐货架

- 状态：Accepted
- 日期：2026-11-13
- 关联：ADR-0013（Feed 契约，本 ADR 落地时修订其第 1 条）、ADR-0021（最新入库）、ADR-0022（我的应用）
- 范围：后端（亲和度画像扩展信号、推荐理由、`get_featured_page` 命令、两张新表）；前端（`FeaturedView` 取代 `HomeView` 的非搜索部分，搜索结果拆为 `SearchResultsView`）
- 落地计划：`.scratch/feature-featured-page-redesign/`
- 实现：`src-tauri/src/github/featured.rs`（组装器）、`src-tauri/src/commands/catalog_featured.rs`（命令）、`src/views/FeaturedView.tsx`

## 1. 背景

本地亲和度画像（`UserAffinityProfile`）目前只作为 `balanced` 排序的一个加分项，首页结构仍是「置顶推荐 + 最近浏览 + 经典推荐 4 个 + 全部精选」。存在以下问题：

- **个性化不可见**：用户看不出哪些是按自己的偏好排的；置顶位在前端写死为 `rustdesk/rustdesk`（`resolveHero`）。
- **已有的本地信号没用上**：`installed_apps`、`view_history`、`search_history` 都在本地库里却没进画像；已装应用还会被推荐。
- **没有负反馈**：用户无法表达「不要这个 / 少推这类」。
- **页面不会变**：固定 `seed 7`，每次打开都一样。
- **`HomeView` 职责过多**：同一个组件兼管精选与本地/在线两段搜索结果。

## 2. 决策

### 2.1 页面由后端按「货架」组装

新增命令 `get_featured_page`，一次返回整页结构，前端只负责渲染：

| 区块 | kind | 规则 |
|---|---|---|
| 今日为你 | `hero` | 3 个（1 大 2 小），分类互斥，按「质量基线 + 亲和度增益 + 日期抖动」取头部 |
| 因为你 X 了 Y | `because_you` | 至多 2 排。种子取近期权重最高的收藏 / 已装 / 关注 / Star 条目（分类互斥）；候选按同分类、同作者、关键词重合度排序；不足 3 个的货架整排不出 |
| 某分类 · 为你挑选 | `category_pick` | 画像权重 Top 2 分类，每排 4 个 |
| 探索新领域 | `explore` | 从画像权重低于 0.15 或未出现的分类里，每个分类取 1 个质量最高的，共 4 个，按日期种子轮换 |
| 本月新入库 | `fresh` | 画像不是 `rich` 时出现：`added_at` 在 30 天内、按 stars 降序取 4 个 |

全页去重：同一应用只出现一次，组装顺序 hero → because_you →（非 rich）fresh → category_pick →（rich）explore，先组装的区块优先占用。`fresh` 排在分类货架之前，否则新入库的高星应用会先被分类货架取走。个性化时 `category_pick` 跳过已被 because_you 种子占用的分类，避免同一分类出现两排。精选页仅渲染推荐货架与货架下方的「继续查看」最近浏览富卡区块（全库浏览由 10 个分类视图或本地/在线搜索承接）。

平台筛选：前端把 App 层平台筛选后的可见 id（`allowedIds`）传给命令，组装器只按结果求交。平台筛选规则（含平台补探中的行、「其他」平台）只在前端 `selectPlatformFilteredApps` 一处维护，不在 Rust 侧复制一份。

刷新时机：进入页面、平台筛选结果变化、保存兴趣分类后重新拉取；收藏、安装、GitHub 同步等画像变化不触发重拉，在下次进入页面时体现，保证当天浏览中页面不跳动。

**为什么由后端组装**：去重、分类互斥、平台过滤与隐藏规则需要一起看整个目录，放在 View 里会违反 ADR-0013 第 3 条「View 禁二次过滤」；货架规则在 Rust 里也能直接单测。

### 2.2 推荐理由与打分同源

`UserAffinityProfile` 新增 `affinity_explain(app) -> Vec<Reason>`，与 `affinity_boost` 共用同一套分项计算（分类、作者、关键词、种子），保证展示的理由就是实际加分的来源，不另写一套「文案规则」。`Reason` 以 `kind` 区分：`seed`（带 `seed_id` 与 `relation`）、`category`、`owner`、`keywords`、`fresh`、`explore`。hero 与各货架的每个条目最多带 2 条理由。

### 2.3 画像状态分档

| 状态 | 判定 | 页面 |
|---|---|---|
| `off` | 两个信号源开关 `enable_local_affinity`（本地应用信息）与 `enable_github_affinity`（GitHub 用户信息）均为 `false`；只开其一时画像只聚合该信号源 | 编辑精选：hero 按质量 + 日期抖动；货架为 `fresh` + 两个日期轮换的分类精选；顶部有一条可关闭的开启提示 |
| `cold` | 开启但画像信号数为 0 | hero 位换成兴趣选择卡（10 个分类多选），其余同 `off` |
| `warm` | 信号数 1–4 | hero + 1 排 `because_you` + 1 排 `category_pick` + `fresh` |
| `rich` | 信号数 ≥ 5 | 按 2.1 全部区块 |

### 2.4 画像补充信号

| 信号 | 基准权重 | 半衰期 | 是否计入已知（不再推荐） |
|---|---|---|---|
| 已安装 `installed_apps` | 3.2 | 30 天 | 是 |
| 浏览 `view_history`（按 `config.toml` `view_history_limit` 读事件流水，30s 写入防抖不去重；画像内 5min 突发防抖 + `0.6 × min(log2(1 + c_eff), 3.5)` 对数加权封顶 `2.1`，仅匹配目录条目且按应用去重计入 `signal_count`） | 0.6（单次基准） | 7 天 | 否 |
| 搜索词 `search_history`（最近 20 条） | 0.4，仅进关键词词袋 | 7 天 | — |
| 兴趣种子 `user_interest_seeds` | 2.0，仅进分类权重 | 不衰减 | — |

已安装应用从所有推荐区块的候选中排除，只作为 `because_you` 的种子。

### 2.5 负反馈

新表 `user_feed_feedback(target, scope, created_at)`，`scope` 为 `app` 或 `category`：

- `app`：该应用 90 天内不进任何推荐区块；在 `get_home_feed` 排序中沉到末尾。
- `category`：画像归一化后该分类权重 ×0.5，90 天有效。

过期行在读取时忽略；设置页隐私看板清空推荐反馈时一并删除全部记录。

### 2.6 日期种子取代固定 seed

前端按本地日期计算 `daySeed`（`yyyymmdd` 整数），供 `get_featured_page` 与 `get_home_feed` 使用：当天稳定、隔天换一批。落地时修订 ADR-0013 第 1 条的 `seed 7`。

### 2.7 搜索结果拆出

搜索态（本地段 + 在线段）拆为独立组件 `SearchResultsView`，视图 id 仍是 `home`：有搜索词时渲染 `SearchResultsView`，否则渲染 `FeaturedView`。拆分是纯重构，行为不变，先于 `FeaturedView` 落地。

## 3. 考虑过的方案

- **继续在前端组装货架**（复用 `buildFrontendAffinityScorer`）：前端拿不到 GitHub 仓库信号、已装与历史表，会与后端画像出现两套口径，否决。
- **主流也带推荐理由**：需要把 `FeedPage.items` 改为带理由的结构，牵动搜索与分类页共用的类型；收益低，否决。
- **负反馈永久有效**：偏好会变，永久屏蔽容易让人忘了自己点过；90 天到期 + 手动清空更稳妥。
- **探索比例作为可配置超参**：目前只有一排固定 4 个，没有可调的必要，不进 `config.toml`。

## 4. 后果

- `UserAffinityProfile` 公开 `signal_count`，供状态分档与隐私看板使用。
- `resolveHero` 中写死的 `rustdesk/rustdesk` 与 `home.rustdesk_*` 文案删除。
- 「最近浏览」在推荐货架下方以标准 `AppCard` 卡片网格（至多 8 个）呈现，有浏览记录即出现。
- 关闭个性化时仍构建画像：已安装与「不感兴趣」的排除不受开关影响。
- 演示站 mock（`src/demo/tauri-mock.ts`）需要新增 `get_featured_page` 与反馈相关命令，参数只认 camelCase。
- `CONTEXT.md` 新增术语：推荐理由、推荐货架、兴趣种子、推荐负反馈、画像状态、日期种子；ADR-0013 第 1 条随之修订。
