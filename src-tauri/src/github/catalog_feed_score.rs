use crate::models::AppSummary;

/// 启发式搜索匹配打分权重常量
pub const SEARCH_SCORE_EXACT_MATCH: i32 = 100;
pub const SEARCH_SCORE_PREFIX_MATCH: i32 = 60;
pub const SEARCH_SCORE_NAME_CONTAINS: i32 = 40;
pub const SEARCH_SCORE_ALIAS_CONTAINS: i32 = 35;
pub const SEARCH_SCORE_OWNER_OR_REPO_CONTAINS: i32 = 30;

/// 发现页 Feed 推荐策略（可插拔，hero 置顶留给前端，后端不 hardcode 具体 id）。
/// 打分口径以前端 `src/services/feed.ts` 为 canonical（同形同量级，跨层可比）：
/// - Balanced: `ln(stars+1) + (jitter01-0.5)*0.3`（jitter 半幅 0.15）；
/// - FreshFirst: `jitter01*10 + ln(stars+1)*0.05`（jitter 主导；目录暂无 updated_at 字段，此为近似，换 seed 即换一批）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FeedStrategy {
    /// 纯 stars 降序（确定性默认，供分类/趋势/搜索空态沿用）。
    StarsOnly,
    /// 默认：`ln(stars+1)` 主序 + 轻扰动（±0.15）打散头部垄断。
    #[default]
    Balanced,
    /// 新鲜优先近似：目录暂无 updated_at 字段，用 seed 抖动主导近似“常看常新”
    ///（`jitter01*10 + ln(stars+1)*0.05`，与前端 fresh 同形）；None seed 时回退 stars 降序。
    FreshFirst,
}

/// Feed 轻扰动参数（与前端 `FEED_JITTER_HALF = 0.15` 同形同量级）：
/// Balanced 总摆动 `2 * HALF = 0.3`，只有头部相近星数才会被打散；
/// Fresh 用下方 `FEED_FRESH_*` 权重，jitter 主导。
pub const FEED_JITTER_HALF: f64 = 0.15;
/// Fresh 策略权重（与前端 `fresh` 同形）：jitter 主导 + 星数只给 5% 权重。
pub const FEED_FRESH_JITTER_SCALE: f64 = 10.0;
pub const FEED_FRESH_STARS_WEIGHT: f64 = 0.05;

/// FNV-1a 64 确定性哈希（std 默认 SipHash 随机种子跨进程不稳定，此处必须确定性）。
fn fnv1a64_with_seed(id: &str, seed: u64) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut h = OFFSET ^ seed;
    for b in id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(PRIME);
    }
    // 最终雪崩强化低位区分度
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51afd7ed558ccd);
    h ^= h >> 33;
    h
}

/// 纯函数：给定 id+seed 的确定性抖动，归一到 [0,1)（与前端 `hashSeeded01` 同语义：
/// 同一 (id, seed) 必得同一抖动，换 seed 即换一批；允许 FNV 位宽/雪崩实现不同，
/// 但公式/量级/seed 语义一致）。id 统一小写归一后再哈希，与前端 `toLowerCase` 对齐。
pub fn feed_jitter01(id: &str, seed: u64) -> f64 {
    let lower = id.to_lowercase();
    let h = fnv1a64_with_seed(&lower, seed);
    // 归一到 [0,1)：除以 2^64（前端除以 2^32，同为“哈希全域/模数”语义）。
    (h as f64) / 18446744073709551616.0
}

/// 纯函数：星数基线 `ln(stars+1)`（与前端 `starsBase` 同形；单调性与 stars 一致，取对数压缩头部差距）。
pub fn feed_stars_base(stars: u64) -> f64 {
    ((stars as f64) + 1.0).ln()
}

/// 纯函数：三策略统一 scorer 表（与前端 `feedScorers` 同形同量级，调用方按策略取一行）：
/// - StarsOnly: 纯 `ln(stars+1)`，忽略 jitter/seed；
/// - Balanced: `ln(stars+1) + (jitter01-0.5)*0.3`；
/// - FreshFirst: `jitter01*10 + ln(stars+1)*0.05`（无 updated_at 字段时的 jitter 近似）。
pub fn feed_score(strategy: FeedStrategy, stars: u64, jitter01: f64) -> f64 {
    let base = feed_stars_base(stars);
    match strategy {
        FeedStrategy::StarsOnly => base,
        FeedStrategy::Balanced => base + (jitter01 - 0.5) * FEED_JITTER_HALF * 2.0,
        FeedStrategy::FreshFirst => {
            jitter01 * FEED_FRESH_JITTER_SCALE + base * FEED_FRESH_STARS_WEIGHT
        }
    }
}

/// 纯函数：Feed 排序（可插拔策略）。输入为已过滤的 summaries，不做 hidden 过滤。
/// 口径与前端 `rankFeed` 对齐（canonical 见 `src/services/feed.ts`）：
/// - StarsOnly → 纯 `ln(stars+1)` 降序，忽略 seed；
/// - Balanced + Some(seed) → `ln(stars+1)+(jitter01-0.5)*0.3` 降序；None seed → 纯星数基线降序（向后兼容）；
/// - FreshFirst + Some(seed) → `jitter01*10+ln(stars+1)*0.05` 降序（无 updated_at 字段的近似）；None → 星数基线降序。
/// tie 按 id 升序（后端确定性；前端按入参稳定排序，两端分数同形同量级即可跨层可比）。
pub fn rank_feed_with_strategy(
    items: Vec<AppSummary>,
    seed: Option<u64>,
    strategy: FeedStrategy,
) -> Vec<AppSummary> {
    // 单 scorer 表收敛：先按策略选分，再走同一条 scored-sort 路径（消 Repeated Switches）。
    if strategy == FeedStrategy::StarsOnly || seed.is_none() {
        let mut items = items;
        items.sort_by(|a, b| {
            b.stars
                .cmp(&a.stars)
                .then_with(|| a.id.cmp(&b.id))
        });
        return items;
    }
    let s = seed.unwrap_or(0);
    let mut scored: Vec<(f64, AppSummary)> = items
        .into_iter()
        .map(|app| {
            let jitter = feed_jitter01(&app.id, s);
            let score = feed_score(strategy, app.stars, jitter);
            (score, app)
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.id.cmp(&b.1.id))
    });
    scored.into_iter().map(|(_, app)| app).collect()
}

/// 纯函数：默认 Balanced 的便捷包装（发现页直接用）。
pub fn rank_feed(items: Vec<AppSummary>, seed: Option<u64>) -> Vec<AppSummary> {
    rank_feed_with_strategy(items, seed, FeedStrategy::Balanced)
}

/// 纯函数：分页切片（供 get_home_feed / search_apps 分页复用，边界守好）。
/// 返回 (page_items, total, has_more)，has_more = (offset+limit) < total（saturating）。
pub fn paginate_feed<T: Clone>(items: &[T], limit: usize, offset: usize) -> (Vec<T>, usize, bool) {
    let total = items.len();
    if offset >= total {
        return (Vec::new(), total, false);
    }
    let end = offset.saturating_add(limit).min(total);
    let page = items[offset..end].to_vec();
    let has_more = offset.saturating_add(limit) < total;
    (page, total, has_more)
}
