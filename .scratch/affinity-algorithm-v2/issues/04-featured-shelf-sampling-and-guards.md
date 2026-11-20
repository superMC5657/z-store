# Issue 04: 精选页货架温度轮换抽样、已知项硬排除与负反馈/新入库闭环

Status: resolved
Blocked by: 03

## 背景

`src-tauri/src/github/featured.rs` 现有组装逻辑存在四个体验问题（见 `spec.md` §1、§2、§3.4）：
1. 沿用 `FEED_JITTER_HALF = 0.15` 微扰，在真实目录星数跨度下导致 30 天内主 Hero 几乎不轮换；`Explore` 在各分类内死锁第 1 名高星巨头。
2. 仅硬排除 `installed_ids`，未排除应用内已收藏/已关注（`explicit_local_ids`），十万星已知应用仍占据精选曝光位。
3. 未读取 `profile.dismissed_categories`，导致在探索栏/编辑精选点「少推这类」无效，或轻度偏好分类折半后反向掉入 `Explore`。
4. `Rich` 态硬性关闭 `Fresh`（「本月新入库」），当用户靠目录外仓库信号进入 `Rich` 但目录内种子不足 2 个时，页面货架偏少。

## 目标

1. **调整精选货架常量与候选硬排除**：
   - `SEED_SIMILARITY_MIN` 更新为 `0.28`（对齐 Issue 03 新相似度量纲）；
   - 新增精选货架采样半幅 `pub const SHELF_JITTER_HALF: f64 = 1.15` 与探索单类精品池大小 `pub const EXPLORE_PER_CAT_POOL: usize = 5`；
   - 候选池过滤在排除 `hidden_ids`、非 `allowed_ids`、`installed_ids`、`dismissed_app_ids` 的基础上，新增排除 `profile.map(|p| &p.explicit_local_ids)`（已收藏/已关注/已安装均不再进推荐货架候选，但 `by_id` 全量映射保留不变，确保它们仍能作为 `because_you` 的种子被查找与命名）。
2. **宽幅确定性日期采样与长尾质量护栏**：
   - 计算货架候选 `quality` 时，基础质量 `q_base = feed_stars_forks_base(stars, forks)`；
   - 抖动半幅按星数设软门槛以防百星长尾蹿上 Hero：`eff_half = if stars >= 500 { SHELF_JITTER_HALF } else { FEED_JITTER_HALF }`，扰动项 `jitter = (feed_jitter01(&id, seed) - 0.5) * eff_half * 2.0`，`quality = q_base + jitter`。
   - `Explore` 货架组装：对每个候选分类（权重 `< EXPLORE_WEIGHT_MAX`），收集未占用应用中按 `q_base`（纯星数+Fork 质量）降序的前 `EXPLORE_PER_CAT_POOL`（5）款精品，再在该池内按 `feed_jitter01(&app.id, seed)` 最大者选出当日该分类的 1 款代表作；随后各分类间仍按 `feed_jitter01(cat, seed)` 轮换取 `SHELF_SIZE`（4）个。
3. **分类负反馈（`dismissed_categories`）全货架闭环**：
   - 从 `profile` 读取 `dismissed_cats`（关闭个性化时同样生效，与 `dismissed_app_ids` 一致）；
   - **Hero**：优先从 `!dismissed_cats.contains(&cat)` 的候选中按分类互斥取满 `HERO_SIZE`；仅当剩余未屏蔽分类不足以凑满 `HERO_SIZE` 时，才从被抑制分类中补齐；
   - **`category_pick` 与 `rotated_categories`**：过滤掉 `dismissed_cats` 中的分类（仅当过滤后可选分类不足 `want_cats` 时，才将被抑制分类追加在队尾兜底）；
   - **`Explore`**：直接跳过 `dismissed_cats` 中的分类（不把用户刚点过「少推这类」的分类当作“新领域”推回）。
4. **`Rich` 态动态补位 `Fresh` 与 `because_you` 理由优化**：
   - 记录实际生成的 `because_you` 货架数 `because_count`；将 `Fresh` 触发条件从 `state != ProfileState::Rich` 改为 `state != ProfileState::Rich || because_count < 2`；
   - 在 `because_you` 条目生成理由时，若候选与种子存在共同高 IDF 词元（或 `explain` 已返回 `Owner` / `Keywords`），优先展示该具体理由，仅在无任何非分类理由时回退 `Reason::Category`。

## 范围（互斥）

- 允许修改：`src-tauri/src/github/featured.rs`。
- 禁止触碰：`src-tauri/src/github/affinity.rs`、`src-tauri/src/commands/*`、`src/*`。

## 验收标准

- [x] 单测：已收藏（`favorites`）与已关注（`watched`）的应用不会出现在 `hero` 或任何 `shelves[].items` 中，但仍可作为 `because_you` 的 `seed_id` 产出推荐货架。
- [x] 单测：在 `Explore`（原分类权重 `0`）、`Warm`/`Rich`（原分类权重 `0.24`，折半后 `0.12 < 0.15`）及 `Off` 态下，被标记 `FeedbackScope::Category` 的分类不会出现在 `Explore` 或 `category_pick` 中（其他分类充足时）。
- [x] 单测：`Rich` 态下若 `seeds` 仅全是目录外仓库导致 `because_you` 产出 `0` 排（或仅 `1` 排）且目录内有近 30 天新应用时，页面自动补出 `Fresh` 货架；当 `because_you` 满 `2` 排时 `Rich` 态不出 `Fresh`。
- [x] 单测：`Explore` 某分类有 5 款不同星数的精品应用时，切换不同 `day_seed` 能在该分类内轮换出不止 1 款代表应用。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 通过。

## Comments

- `HERO_SEED_REASON_MIN` 由 0.5 调整为 0.45：新相似度量纲下「同分类」只贡献 0.25，0.45 约等于同分类加中等词元重合。
- 个性化的 `category_pick` 分类只来自画像，被「少推这类」的分类直接剔除、不兜底（页面另有 `because_you` / `explore` / `fresh`，不会空页）；无画像的 `rotated_categories` 才按「其余分类不足 `want_cats` 时排到队尾兜底」处理。
- `featured.rs` 单测夹具目录由每分类 6 款扩为 8 款：收藏 / 关注也被硬排除后，6 款不足以让 `rich` 夹具产出 2 排 `because_you`。
- `because_you` 理由回退时使用的「共同高 IDF 词元」门槛定为 `SHARED_TOKEN_MIN_IDF = 0.5`（spec 未给数值）。
- spec §6 要求「少推这类」后该分类不出现在「任意货架」：`because_you` 的种子与候选、`fresh` 同样排除被少推的分类。
