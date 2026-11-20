use crate::models::AppSummary;

/// 启发式搜索匹配打分权重常量
pub const SEARCH_SCORE_EXACT_MATCH: i32 = 100;
pub const SEARCH_SCORE_PREFIX_MATCH: i32 = 60;
pub const SEARCH_SCORE_NAME_CONTAINS: i32 = 40;
pub const SEARCH_SCORE_ALTERNATIVE_MATCH: i32 = 38;
pub const SEARCH_SCORE_ALIAS_CONTAINS: i32 = 35;
pub const SEARCH_SCORE_OWNER_OR_REPO_CONTAINS: i32 = 30;
pub const SEARCH_SCORE_DESCRIPTION_CONTAINS: i32 = 20;

/// 发现页 Feed 推荐策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FeedStrategy {
    /// 纯 stars 降序。
    StarsOnly,
    /// `ln(stars+1)` 主序叠加轻扰动打散头部垄断。
    #[default]
    Balanced,
    /// 抖动主导近似新鲜度，无 seed 时回退 stars 降序。
    FreshFirst,
}

/// Balanced 策略抖动半幅。
pub const FEED_JITTER_HALF: f64 = 0.15;
/// FreshFirst 策略权重。
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

/// 纯函数：星数 + Fork 双因子质量基线 `ln(stars+1) + 0.25 * ln(forks+1)`。
/// 当 `forks == 0` 时退化为 `feed_stars_base(stars)`。
pub fn feed_stars_forks_base(stars: u64, forks: u64) -> f64 {
    feed_stars_base(stars) + 0.25 * ((forks as f64) + 1.0).ln()
}

/// 按三策略之一计算 Feed 分数。
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

/// 按策略对 Feed 列表排序，同分按 id 升序；`seed` 为 `None` 时回退 stars 降序。
pub fn rank_feed_with_strategy(
    items: Vec<AppSummary>,
    seed: Option<u64>,
    strategy: FeedStrategy,
) -> Vec<AppSummary> {
    rank_feed_with_profile(items, seed, strategy, None)
}

/// 结合本地用户亲和度画像对 Feed 列表排序。
pub fn rank_feed_with_profile(
    items: Vec<AppSummary>,
    seed: Option<u64>,
    strategy: FeedStrategy,
    profile: Option<&crate::github::affinity::UserAffinityProfile>,
) -> Vec<AppSummary> {
    if strategy == FeedStrategy::StarsOnly || seed.is_none() {
        let mut items = items;
        items.sort_by(|a, b| {
            b.core
                .stars
                .cmp(&a.core.stars)
                .then_with(|| a.core.id.cmp(&b.core.id))
        });
        return items;
    }
    let s = seed.unwrap_or(0);
    let mut scored: Vec<(f64, AppSummary)> = items
        .into_iter()
        .map(|app| {
            let jitter = feed_jitter01(&app.core.id, s);
            let score = match strategy {
                FeedStrategy::Balanced => {
                    let base = feed_stars_forks_base(app.core.stars, app.core.forks);
                    let boost = profile.map(|p| p.affinity_boost(&app)).unwrap_or(0.0);
                    base + boost + (jitter - 0.5) * FEED_JITTER_HALF * 2.0
                }
                _ => feed_score(strategy, app.core.stars, jitter),
            };
            (score, app)
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.core.id.cmp(&b.1.core.id))
    });
    scored.into_iter().map(|(_, app)| app).collect()
}

/// 主流打散窗口：只重排前 N 个，之后保持原序，保证分页稳定。
pub const FEED_DIVERSIFY_WINDOW: usize = 60;
/// 主流中同一分类最多连续出现的个数。
pub const FEED_DIVERSIFY_MAX_RUN: usize = 2;

/// 纯函数：在前 `window` 个内贪心重排，使同一分类连续不超过 `max_run` 个；
/// 每步取剩余中最靠前且不违反约束的条目，没有可选时退回最靠前的条目。
pub fn diversify_by_category(
    items: Vec<AppSummary>,
    window: usize,
    max_run: usize,
) -> Vec<AppSummary> {
    if max_run == 0 || items.len() <= max_run {
        return items;
    }
    let split = window.min(items.len());
    let mut rest = items;
    let tail = rest.split_off(split);
    let mut pool = rest;
    let mut out: Vec<AppSummary> = Vec::with_capacity(split + tail.len());
    while !pool.is_empty() {
        let run_cat = out.last().map(|a| a.core.category.to_lowercase());
        let run_len = match &run_cat {
            Some(cat) => out
                .iter()
                .rev()
                .take_while(|a| a.core.category.to_lowercase() == *cat)
                .count(),
            None => 0,
        };
        let pick = pool
            .iter()
            .position(|a| {
                run_len < max_run || run_cat.as_deref() != Some(&a.core.category.to_lowercase())
            })
            .unwrap_or(0);
        out.push(pool.remove(pick));
    }
    out.extend(tail);
    out
}

/// 纯函数：主流最终排列。`sunk_ids`（小写 id）命中的条目保持相对顺序接在末尾，
/// 其余条目按 [`diversify_by_category`] 打散；沉底条目不参与打散，不会被换回前面。
pub fn diversify_and_sink(
    items: Vec<AppSummary>,
    sunk_ids: &std::collections::HashSet<String>,
) -> Vec<AppSummary> {
    let (sunk, kept): (Vec<_>, Vec<_>) = items
        .into_iter()
        .partition(|a| sunk_ids.contains(&a.core.id.to_lowercase()));
    let mut out = diversify_by_category(kept, FEED_DIVERSIFY_WINDOW, FEED_DIVERSIFY_MAX_RUN);
    out.extend(sunk);
    out
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

/// 纯函数：可选分页切片（本地搜索 `limit/offset=None=全量` 语义 SSOT）。
/// None=全量，Some 切 slice，越界守好。
pub fn paginate_optional<T: Clone>(
    items: Vec<T>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Vec<T> {
    match (limit, offset) {
        (None, None) => items,
        _ => {
            let off = offset.unwrap_or(0);
            if off >= items.len() {
                return Vec::new();
            }
            let end = match limit {
                Some(l) => off.saturating_add(l).min(items.len()),
                None => items.len(),
            };
            items[off..end].to_vec()
        }
    }
}

/// 纯函数：Feed 策略解析（`strategy=None/非法→balanced`，大小写不敏感，前端原样透传、后端归一小写）。
pub fn parse_feed_strategy(raw: Option<&str>) -> FeedStrategy {
    let normalized = raw.unwrap_or("balanced").trim().to_lowercase();
    match normalized.as_str() {
        "stars" => FeedStrategy::StarsOnly,
        "fresh" => FeedStrategy::FreshFirst,
        "balanced" => FeedStrategy::Balanced,
        _ => FeedStrategy::Balanced,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{RawAffinitySignals, UserRepoSignal};
    use crate::github::affinity::UserAffinityProfile;
    use crate::github::models::CatalogItem;
    use std::collections::HashMap;

    fn make_item(id: &str, category: &str, stars: u64, forks: u64) -> CatalogItem {
        let (owner, repo) = id.split_once('/').unwrap_or(("owner", id));
        CatalogItem {
            id: id.to_string(),
            name: repo.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: format!("{} application", category),
            description_en: Some(format!("{} application", category)),
            category: category.to_string(),
            category_name: category.to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars,
            forks,
            is_verified: true,
            homepage: None,
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec!["windows".to_string()],
            identifiers: HashMap::new(),
        }
    }

    #[test]
    fn empty_profile_with_zero_forks_matches_rank_feed_with_strategy_identically() {
        let catalog = vec![
            make_item("a/one", "dev", 1000, 0),
            make_item("b/two", "media", 5000, 0),
            make_item("c/three", "security", 2500, 0),
        ];
        let summaries: Vec<AppSummary> = catalog.iter().map(|c| c.to_summary()).collect();
        let empty_profile =
            UserAffinityProfile::from_signals(&RawAffinitySignals::default(), &catalog, 1700000000);
        assert!(!empty_profile.has_signals);

        let by_strategy =
            rank_feed_with_strategy(summaries.clone(), Some(7), FeedStrategy::Balanced);
        let by_profile = rank_feed_with_profile(
            summaries,
            Some(7),
            FeedStrategy::Balanced,
            Some(&empty_profile),
        );

        let ids_strategy: Vec<&str> = by_strategy.iter().map(|s| s.core.id.as_str()).collect();
        let ids_profile: Vec<&str> = by_profile.iter().map(|s| s.core.id.as_str()).collect();
        assert_eq!(ids_strategy, ids_profile);
    }

    #[test]
    fn rank_feed_with_profile_elevates_preferred_category_and_promotes_new_items() {
        let catalog = vec![
            make_item("sys/giant", "system", 30000, 1000),
            make_item("sec/seed-vault", "security", 8000, 900),
            make_item("sec/new-cipher", "security", 7500, 850),
        ];
        let summaries: Vec<AppSummary> = catalog.iter().map(|c| c.to_summary()).collect();

        // 无信号时：30000 星的 sys/giant 排第一
        let baseline =
            rank_feed_with_profile(summaries.clone(), Some(7), FeedStrategy::Balanced, None);
        assert_eq!(baseline[0].core.id, "sys/giant");

        // 用户收藏了 sec/seed-vault 并在 GitHub Star 了安全类仓库：
        // sec/new-cipher 应获得分类+关键词增益跃升至第一，且排在已收藏种子 sec/seed-vault 之前
        let raw = RawAffinitySignals {
            repo_signals: vec![UserRepoSignal {
                full_name: "ext/totp-auth".to_string(),
                relation: "starred".to_string(),
                language: "Rust".to_string(),
                description: "Password security crypto vault".to_string(),
                stars: 4000,
                forks: 400,
                updated_at: 1700000000,
            }],
            user_stars: vec![],
            favorites: vec![("sec/seed-vault".to_string(), 1700000000)],
            watched: vec![],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, 1700000000);
        let ranked =
            rank_feed_with_profile(summaries, Some(7), FeedStrategy::Balanced, Some(&profile));

        assert_eq!(ranked[0].core.id, "sec/new-cipher");
    }

    fn cats(items: &[AppSummary]) -> Vec<String> {
        items.iter().map(|a| a.core.category.clone()).collect()
    }

    #[test]
    fn diversify_limits_runs_inside_window_and_keeps_tail() {
        let mut items: Vec<AppSummary> = Vec::new();
        for i in 0..6 {
            items.push(make_item(&format!("d/dev{i}"), "dev", 1, 0).to_summary());
        }
        for i in 0..3 {
            items.push(make_item(&format!("m/media{i}"), "media", 1, 0).to_summary());
        }
        items.push(make_item("g/tail", "games", 1, 0).to_summary());
        let out = diversify_by_category(items.clone(), 9, 2);
        let c = cats(&out);
        assert_eq!(
            &c[..9],
            &["dev", "dev", "media", "dev", "dev", "media", "dev", "dev", "media"]
        );
        assert_eq!(out[9].core.id, "g/tail");
        // 窗口外不重排
        let untouched = diversify_by_category(items.clone(), 0, 2);
        assert_eq!(cats(&untouched), cats(&items));
    }

    #[test]
    fn diversify_falls_back_when_only_one_category_left() {
        let items: Vec<AppSummary> = (0..4)
            .map(|i| make_item(&format!("d/dev{i}"), "dev", 1, 0).to_summary())
            .collect();
        assert_eq!(diversify_by_category(items, 60, 2).len(), 4);
    }

    #[test]
    fn sink_moves_dismissed_to_end_in_order() {
        let items: Vec<AppSummary> = ["a/1", "b/2", "c/3", "d/4"]
            .iter()
            .map(|id| make_item(id, "dev", 1, 0).to_summary())
            .collect();
        let sunk: std::collections::HashSet<String> =
            ["a/1".to_string(), "c/3".to_string()].into_iter().collect();
        let ids: Vec<String> = diversify_and_sink(items, &sunk)
            .into_iter()
            .map(|a| a.core.id)
            .collect();
        assert_eq!(ids, vec!["b/2", "d/4", "a/1", "c/3"]);
    }

    #[test]
    fn diversify_never_pulls_sunk_items_forward() {
        // 只看未沉底条目会出现 dev×3 连串；唯一能打断它的 media 被沉底，打散不得把它换回前面。
        let items: Vec<AppSummary> = vec![
            make_item("d/1", "dev", 1, 0).to_summary(),
            make_item("d/2", "dev", 1, 0).to_summary(),
            make_item("d/3", "dev", 1, 0).to_summary(),
            make_item("m/sunk", "media", 1, 0).to_summary(),
        ];
        let sunk: std::collections::HashSet<String> = ["m/sunk".to_string()].into_iter().collect();
        let ids: Vec<String> = diversify_and_sink(items, &sunk)
            .into_iter()
            .map(|a| a.core.id)
            .collect();
        assert_eq!(ids.last().map(String::as_str), Some("m/sunk"));
    }
}
