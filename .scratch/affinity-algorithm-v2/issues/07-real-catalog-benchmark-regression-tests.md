# Issue 07: 基于真实 `catalog.json` 的推荐质量、轮换多样性与抗偏置回归门禁

Status: resolved
Blocked by: 04, 05, 06

## 背景

此前单测夹具使用人工等星数样本（如 `10000, 10001, 10002`），掩盖了真实开源生态幂律星数分布（`105 ~ 225,315` 星）下的头部垄断、词频污染与子串分类误判。需要在测试套件中直接装载仓库根目录的真实 `catalog.json` 建立量化回归防线。

## 目标

新建测试模块 `src-tauri/src/github/affinity_eval_tests.rs`（仅 `#[cfg(test)] mod affinity_eval_tests;` 挂载于 `src-tauri/src/github/mod.rs`），加载 `../catalog.json` 验证以下 5 项硬指标：

1. **真实目录 30 天轮换多样性门禁**：
   - 在无画像（`Off`）以及典型 `Rich` 个性化画像（如收藏 2 款 `media` + 安装 2 款 `security` + 关注 1 款 `office`）两种场景下，遍历 `20261101..=20261130` 共 30 个连续 `day_seed` 调用 `assemble_featured_page`：
   - 断言两种场景下 30 天内出现过的不同主 Hero（`hero[0]`）数量均 `>= 5` 款，不同 Hero 三元组数量均 `>= 12` 组；
   - 断言所有天数的 `hero` 应用星数均 `>= 500`（长尾质量护栏生效），且任意单日整页无重复 ID、无已收藏/已关注/已安装应用混入。
2. **重度 GitHub 账号抗淹没门禁**：
   - 构造 300 条目录外 GitHub `starred`/`owned` 信号（涵盖 Rust / Python / TypeScript 等语言及常规仓库描述）+ 2 条目录内 `media` 收藏 + 1 个 `reading` 兴趣种子；
   - 断言构建出的画像中 `media` 与 `reading` 分类权重均 `>= 0.45`，不会落入 `< EXPLORE_WEIGHT_MAX (0.15)` 的探索池，且 `top_categories(3)` 包含 `media` 与 `reading`。
3. **关键词单调性与推荐理由纯净度门禁**：
   - 遍历真实目录构建典型多信号画像，检查全页所有 `FeaturedPick.reasons` 中的 `Reason::Keywords { tokens }`：断言绝不包含 `open-source`、`cross-platform`、`desktop`、`https`、`http`、`your`、`you` 等停用/泛化词。
4. **真实目录分类推断防退化门禁**：
   - 将真实 `catalog.json` 各条目的 `(language="", description_en, id)` 输入 `infer_categories_from_repo`：
   - 断言无 `video→ide`、`client→cli`、`github→git` 子串误触发，且预测 Top-1 为 `dev` 的条目数不超过真实 `dev` 条目数的 `1.35` 倍（修复前为 `1.77` 倍），有结果条目的 Top-1 准确率 `>= 72%`（修复前为 `56.8%`）。
5. **分类负反馈全态回归门禁**：
   - 针对 `Off`、`Cold`、`Warm`、`Rich` 四种状态，模拟对当前页面 `Explore` 或 `category_pick` 中的首个条目执行「少推这类 + 屏蔽当前卡」双写后重新组装同一 `day_seed` 页面：断言该分类不再作为 `category_pick` 或 `Explore` 出现，且触发卡片 ID 不在整页任何位置出现。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/affinity_eval_tests.rs`（新建）、`src-tauri/src/github/mod.rs`（仅挂载 `#[cfg(test)] mod affinity_eval_tests;`）。
- 禁止触碰：生产逻辑代码与前端文件（若测试暴露阈值偏差需微调常量，须在 Issue Comments 记录原因）。

## 验收标准

- [ ] 5 项真实目录量化门禁测试全部编写完成并通过。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 零警告全绿。
