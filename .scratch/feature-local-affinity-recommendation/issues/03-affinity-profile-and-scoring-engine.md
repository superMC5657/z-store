# Issue 03: `UserAffinityProfile` 画像构建器与 `rank_feed_with_profile` 动态推荐引擎

Status: resolved
Blocked by: 01

## 背景

首页推荐需要在纯本地将一期 `RawAffinitySignals`（用户 GitHub Star/Fork 仓库属性与应用内 Stars/Favorites/Watch 信号）转化为对 ZStore 收录库（`CatalogItem`）的动态打分排序，同时综合候选应用自身的 `stars` 与 `forks` 指标。

## 目标

1. **实现 `UserAffinityProfile`**（`src-tauri/src/github/affinity.rs`）：
   - `UserAffinityProfile::from_signals(raw: &RawAffinitySignals, catalog: &[CatalogItem], now_secs: i64) -> Self`
   - 仅消费一期信号：`user_repo_signals`（`starred` / `forked` / `owned`）、`user_stars`、`user_favorites`、`watched_apps`；
   - 支持 30 天半衰期时间衰减（下限 `0.25`）与信号源仓库 `stars`/`forks` 规模系数调制；
   - 支持 `relation == "forked"` 仓库按同名 `repo` 反查收录库上游项目；
   - 实现 `infer_categories_from_repo(language, description, full_name)`，将目录外 GitHub Star/Fork 仓库精准映射至 ZStore 10 大标准分类（`dev`, `ops`, `media`, `office`, `security`, `graphics`, `network`, `system`, `reading`, `games`）；
   - 计算分类权重 `category_weights`、开发者权重 `owner_weights`、关键词词袋权重 `token_weights`、加权平均 `avg_fork_ratio` 与已收藏/已关注集合 `known_ids`。
2. **实现双因子质量基线与动态重排**（`src-tauri/src/github/catalog_feed_score.rs`）：
   - 新增 `feed_stars_forks_base(stars, forks) = ln(stars + 1) + 0.25 * ln(forks + 1)`（当 `forks == 0` 时严格等于 `feed_stars_base(stars)`）；
   - 新增 `rank_feed_with_profile(items, seed, strategy, profile)`：在 `FeedStrategy::Balanced` 下叠加 `profile.affinity_boost(&app)`（含分类增益 `+3.2`、开发者增益 `+1.8`、关键词增益、fork 活跃比共鸣度，以及对已收藏/已关注应用的 `-1.2` 适度推新让位）。
3. **接入 `get_home_feed`**（`src-tauri/src/commands/catalog_feed.rs`）：
   - 从 `state.db()` 读取 `load_raw_affinity_signals()`，构建 `UserAffinityProfile` 并传入 `rank_feed_with_profile`。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/affinity.rs`、`src-tauri/src/github/mod.rs`、`src-tauri/src/github/catalog_feed_score.rs`、`src-tauri/src/commands/catalog_feed.rs`。
- 禁止修改：`src/*`。

## 验收标准

- [x] 单测验证：空信号（`has_signals == false`）且 `forks == 0` 时，`rank_feed_with_profile` 输出顺序与 `rank_feed_with_strategy` 完全一致。
- [x] 单测验证：当用户存在某分类（如 `media` 或 `security`）的 GitHub Star/Fork 仓库或应用内 Watch/Star 时，同分类候选应用获得显著加分并跃升至前排。
- [x] 单测验证：已收藏/已关注应用为其所属分类贡献正向权重，同时将首屏最高优席位让给同分类尚未收藏的优质应用。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib github::` 与 `commands::catalog_feed` 全部通过。
