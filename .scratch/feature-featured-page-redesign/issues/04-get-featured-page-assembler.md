# Issue 04: `get_featured_page` 货架组装器与命令

Status: resolved
Blocked by: 03

## 背景

整页结构由后端一次组装，前端只渲染（ADR-0023 §2.1、§2.3）。

## 目标

1. 新建纯函数模块 `src-tauri/src/github/featured.rs`：
   `assemble_featured_page(candidates: Vec<AppSummary>, catalog: &[CatalogItem], profile: Option<&UserAffinityProfile>, enabled: bool, day_seed: u64, now: i64) -> FeaturedPage`
   - 候选过滤、单项得分、种子相似度、去重顺序、各状态区块组合严格按 spec §3、§6。
   - `explore`：分类权重 < 0.15 或缺席的分类，每类取单项得分（不含亲和度）最高者，按 `day_seed` 抖动选 4 个。
   - `fresh`：`added_at` 在 `now` 前 30 天内，stars 降序取 4。
   - `off` / `cold` 的两个分类精选：按 `day_seed` 从 10 个分类中轮换取 2 个，每类 4 个。
   - 货架不足 3 个条目时整排不出；`top_categories` 取画像 Top 3（`off` / `cold` 为空数组）。
2. 命令 `get_featured_page { daySeed, platforms }`（新文件 `src-tauri/src/commands/catalog_featured.rs`，`rename_all = "camelCase"`）：
   - 候选 = `merged_summaries()` − 隐藏规则 −（`platforms` 给出时）平台不匹配；平台匹配口径复用分类页 / 首页现有的平台判定函数，不新写。
   - 画像构建与 `get_home_feed` 共用一个内部函数（抽出 `load_profile(state)`）。
3. 序列化类型 `FeaturedPage` / `FeaturedPick` / `FeaturedShelf` 字段 snake_case。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/featured.rs`（新建）、`src-tauri/src/github/mod.rs`、`src-tauri/src/commands/catalog_featured.rs`（新建）、`src-tauri/src/commands/catalog_feed.rs`（仅抽出 `load_profile`）、`src-tauri/src/commands/mod.rs`、`src-tauri/src/lib.rs`（仅命令注册）。
- 禁止触碰：`src-tauri/src/github/affinity.rs`、`src/*`。

## 验收标准

- [x] 表驱动单测覆盖四种状态的区块组合。
- [x] 单测：整页无重复 id；hero 三个分类互不相同；已装与 `app` 反馈命中的应用不出现。
- [x] 单测：同一 `day_seed` 两次结果完全相同；目录 ≥ 20 时换 `day_seed` 后 hero 至少 1 个变化。
- [x] 单测：`platforms = ["windows"]` 时所有条目支持 Windows。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 通过。
