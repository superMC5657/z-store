# Issue 03: 双源独立归一化画像、单调词袋打分与跨类种子相似度引擎

Status: resolved
Blocked by: 01, 02

## 背景

在 Issue 01（真实时间戳 + 未收录详情摘要）与 Issue 02（`affinity_text` 双语分词 / IDF / 词边界分类推断）就绪后，需要将 `src-tauri/src/github/affinity.rs` 中的 `UserAffinityProfile` 升级至 V2 打分与相似度模型（详见 `spec.md` §3.3）。

## 目标

1. **切换至 `affinity_text` 文本底座**：
   - `affinity::extract_affinity_tokens` 与 `affinity::infer_categories_from_repo` 委托调用 `affinity_text::extract_tokens` 与 `affinity_text::infer_categories`；
   - `UserAffinityProfile` 内部持有从 `catalog` 构建的 `CatalogIdf`（默认空实例对所有词返回 `1.0`）。
2. **去除目录内流行度双重计权 & 接入未收录本地信号**：
   - 命中 `CatalogItem` 的收藏（`4.0`）、关注（`3.5`）、已装（`3.2`）、GitHub/应用内仓库信号直接按 `base_w * decay` 赋权，不再乘 `repo_scale_factor`；
   - 目录外 GitHub 仓库信号仅乘温和可信度因子 `0.7 + 0.3 * (1.0 - (-(sig.stars as f64) / 50.0).exp())`；
   - 当本地 `favorites`、`watched`、`installed`、`views` 未命中 `by_id` 时，回退查询 `raw.uncataloged_briefs`（若 `category` 属于 10 大标准分类则直接计入分类，否则调用 `infer_categories_from_repo` 推断；若连 brief 也缺失，则从 canonical `owner/repo` 拆出作者与仓库词元），正常计入 `signal_count` 与本地通道权重；
   - `UserAffinityProfile` 新增公开字段：
     - `pub explicit_local_ids: HashSet<String>`：收集 `raw.favorites` ∪ `raw.watched` ∪ `raw.installed` 的小写 id（**不受 `sources.local` 开关影响**，与 `installed_ids` 同口径，供精选页排除已知项）；
     - `pub dismissed_categories: HashSet<String>`：有效期内 `scope == FeedbackScope::Category` 的小写分类 key 集合（无正向信号时同样填充保留）。
3. **双通道独立软饱和归一化与兴趣种子先验**：
   - 将累加器拆为 `local_acc`（收藏、关注、已装、浏览、搜索）与 `github_acc`（`repo_signals`、`user_stars`）；词元写入 `raw_tokens` 时乘 `idf.weight(&tok)`；
   - 分别经 `normalize_soft_saturated`（`cat_tau = 2.2`, `owner_tau = 2.5`, `tok_tau = 2.0`）得到 `(cat_l, own_l, tok_l)` 与 `(cat_g, own_g, tok_g)`；
   - 按维度融合：若该维度在本地与 GitHub 均非空，按 `0.65 * w_l + 0.35 * w_g` 合并；若仅一侧非空，直接取非空侧 `1.0 * w`；
   - 合入 `interest_seeds`：每命中一个种子分类 `c`（`signal_count += 1`），将该分类权重提升为 `w.max(0.75).max(1.0 - (1.0 - w) * 0.4).min(1.0)`，保证即使有上千条 GitHub Star 也不会把用户手选的兴趣分类冲刷至低位；
   - 对 `dismissed_categories` 中的分类，归一化融合后仍执行 `*w *= 0.5`。
4. **单调递增关键词打分、移除 `ForkResonance` 与分类抑制项**：
   - `breakdown(app)` 候选分词文本扩充为 `format!("{} {} {} {}", app.core.name, app.core.repo, app.core.description, app.core.description_en.as_deref().unwrap_or(""))`；
   - 命中的词元按得分 `s = user_tok_w * idf.weight(&tok)` 降序排列，取前 3 项（不足补 `0.0`），计算单调递增分：`raw_tok_score = (0.60 * s1 + 0.25 * s2 + 0.15 * s3).clamp(0.0, 1.0)`；
   - 移除 `avg_fork_ratio` 与 `fork_resonance` 计算；
   - 对命中 `self.dismissed_categories` 的候选分类施加 `cat_penalty = 1.5`：
     `affinity_boost = 3.2 * b.cat + 1.8 * b.owner + 1.8 * b.tok - b.cat_penalty - b.known_penalty`（已知项仍保持 `known_penalty = 1.2` 供 `get_home_feed` 使用）。
5. **跨分类语义感知的 `seed_similarity`**：
   - 新增带 IDF 支持的 `pub fn seed_similarity_with_idf(seed: &AppSummary, candidate: &AppSummary, idf: Option<&CatalogIdf>, aliases_map: Option<&HashMap<String, Vec<String>>>) -> f64`（并保留原 `pub fn seed_similarity(seed, candidate) -> f64` 兼容签名内部调用默认计算）：
   - 提取 `name + repo + aliases + description + description_en` 词元计算加权余弦相似度 `sim_tok`；
   - 公式：`0.25 * I(same_cat) + 0.25 * I(same_owner) + 0.50 * sim_tok`。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/affinity.rs`、`src-tauri/src/github/catalog_feed_score.rs`（仅在既有测试因分数微调需适配时修改）。
- 禁止触碰：`src-tauri/src/github/featured.rs`、`src-tauri/src/commands/*`、`src/*`。

## 验收标准

- [ ] 单测（单调性）：候选应用 B 命中的偏好词集合为候选 A 的严格超集（如 `["video", "player", "ffmpeg"]` vs `["video"]`）且同分类同作者时，`profile.affinity_boost(&app_b) > profile.affinity_boost(&app_a)`。
- [ ] 单测（抗淹没）：输入 300 条目录外 GitHub Star（语言均为 Rust/Python）+ 2 条本地 `media` 收藏时，`profile.category_weights["media"] >= 0.45` 且排进 `top_categories(2)`。
- [ ] 单测（中文搜索词）：仅输入中文搜索历史 `searches = [("远程桌面", now)]` 时，`profile.has_signals == true` 且远程桌面应用获得正向关键词增益与 `Reason::Keywords`。
- [ ] 单测（未收录足迹）：收藏或浏览不在 `catalog` 但存在于 `uncataloged_briefs` 的应用时，`signal_count >= 1` 且 `has_signals == true`。
- [ ] 单测（跨类相似度）：不同分类但共享核心领域词与别名（如远程控制与局域网传输）的两款应用 `seed_similarity >= 0.28`。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 通过。

## Comments

- 实现偏差：`affinity_explain` 在画像只有词袋信号（画像没有任何分类与作者权重）时，命中的关键词即使贡献低于 `REASON_MIN_CONTRIBUTION` 也作为 `Keywords` 理由展示。原因：按 spec 的搜索权重 0.4、`tok_tau = 2.0` 与双重 IDF，单条中文搜索词的关键词贡献约 0.15–0.25，达不到 0.25 门槛，验收项「仅中文搜索历史时出现 `Reason::Keywords`」无法满足。
- GitHub 目录外仓库的词元文本取 `repo 名 + description`，不再包含 `owner` 与 `language`，避免作者名与编程语言进入关键词词袋。
