//! 精选页货架组装纯函数：输入合并目录与本地画像，输出整页结构。

use super::affinity::{Reason, SeedRelation, UserAffinityProfile, MAX_REASONS};
use super::catalog_feed_score::{feed_jitter01, feed_stars_forks_base, FEED_JITTER_HALF};
use crate::models::AppSummary;
use serde::Serialize;
use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

/// hero 条目数（1 大 2 小）。
pub const HERO_SIZE: usize = 3;
/// 货架条目数。
pub const SHELF_SIZE: usize = 4;
/// 货架最少条目数：不足则整排不出。
pub const SHELF_MIN: usize = 3;
/// `because_you` 候选与种子的最低相似度。
pub const SEED_SIMILARITY_MIN: f64 = 0.28;
/// hero 附带种子理由的最低相似度。
const HERO_SEED_REASON_MIN: f64 = 0.45;
/// 画像分类权重低于此值视为「较少接触」，进入探索候选。
pub const EXPLORE_WEIGHT_MAX: f64 = 0.15;
/// 「本月新入库」窗口（天）。
pub const FRESH_WINDOW_DAYS: i64 = 30;
/// 画像信号数达到此值进入 `rich`。
pub const RICH_SIGNAL_MIN: usize = 5;
/// 精选货架日期采样的抖动半幅（全幅 2.30，约等于 10 倍星数的竞争窗口），让头部按天轮换。
pub const SHELF_JITTER_HALF: f64 = 1.15;
/// 星数低于此值的长尾应用只用窄幅抖动，避免靠极端随机数登上 hero。
pub const SHELF_WIDE_JITTER_MIN_STARS: u64 = 500;
/// 探索货架在每个分类内的精品池大小（按纯质量分取前 N，再按日期种子挑 1 款）。
pub const EXPLORE_PER_CAT_POOL: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileState {
    Off,
    Cold,
    Warm,
    Rich,
}

impl ProfileState {
    fn personalized(self) -> bool {
        matches!(self, Self::Warm | Self::Rich)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShelfKind {
    BecauseYou,
    CategoryPick,
    Explore,
    Fresh,
}

impl ShelfKind {
    /// 页面自上而下的展示位次，与组装去重顺序无关。
    fn display_rank(self) -> u8 {
        match self {
            Self::BecauseYou => 0,
            Self::CategoryPick => 1,
            Self::Explore => 2,
            Self::Fresh => 3,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FeaturedPick {
    pub app: AppSummary,
    pub reasons: Vec<Reason>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeaturedShelf {
    pub kind: ShelfKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed_relation: Option<SeedRelation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub items: Vec<FeaturedPick>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeaturedPage {
    pub profile_state: ProfileState,
    pub signal_count: usize,
    pub top_categories: Vec<String>,
    pub hero: Vec<FeaturedPick>,
    pub shelves: Vec<FeaturedShelf>,
}

/// 组装输入。
pub struct FeaturedInput<'a> {
    /// 合并目录全量（远端 + 本地收录），用于候选与种子查找。
    pub all: Vec<AppSummary>,
    /// App 层平台筛选后的可见 id（小写）；`None` 表示不限制。
    pub allowed_ids: Option<&'a HashSet<String>>,
    /// 隐藏规则命中的 id（小写）。
    pub hidden_ids: &'a HashSet<String>,
    /// 本地画像（关闭个性化时也传入，用于排除已知应用与负反馈）。
    pub profile: Option<&'a UserAffinityProfile>,
    pub enabled: bool,
    pub day_seed: u64,
    pub now_secs: i64,
}

pub fn resolve_profile_state(enabled: bool, profile: Option<&UserAffinityProfile>) -> ProfileState {
    if !enabled {
        return ProfileState::Off;
    }
    match profile {
        Some(p) if p.has_signals && p.signal_count >= RICH_SIGNAL_MIN => ProfileState::Rich,
        Some(p) if p.has_signals && p.signal_count > 0 => ProfileState::Warm,
        _ => ProfileState::Cold,
    }
}

struct Scored<'a> {
    app: &'a AppSummary,
    score: f64,
    /// 纯星数 + Fork 质量分（无抖动）。
    base: f64,
}

/// 货架采样质量。
struct ShelfQuality {
    /// 纯星数 + Fork 质量基线。
    base: f64,
    /// 基线 + 按日期种子的确定性抖动（长尾应用只用窄幅抖动）。
    sampled: f64,
}

fn shelf_quality(app: &AppSummary, id: &str, day_seed: u64) -> ShelfQuality {
    let base = feed_stars_forks_base(app.core.stars, app.core.forks);
    let half = if app.core.stars >= SHELF_WIDE_JITTER_MIN_STARS {
        SHELF_JITTER_HALF
    } else {
        FEED_JITTER_HALF
    };
    let jitter = (feed_jitter01(id, day_seed) - 0.5) * half * 2.0;
    ShelfQuality {
        base,
        sampled: base + jitter,
    }
}

/// 分类顺序中把「少推这类」挪走：其余分类足够 `want` 个时直接丢弃，否则排在队尾兜底。
fn demote_dismissed(order: Vec<String>, dismissed: &HashSet<String>, want: usize) -> Vec<String> {
    let (kept, demoted): (Vec<String>, Vec<String>) =
        order.into_iter().partition(|c| !dismissed.contains(c));
    if kept.len() >= want {
        kept
    } else {
        kept.into_iter().chain(demoted).collect()
    }
}

pub fn assemble_featured_page(input: FeaturedInput<'_>) -> FeaturedPage {
    let state = resolve_profile_state(input.enabled, input.profile);
    let personalized = state.personalized();
    let profile = input.profile;
    // 个性化状态下参与打分与解释的画像；关闭个性化或冷启动时为 None
    let personal = profile.filter(|_| personalized);
    let day_seed = input.day_seed;
    let empty: HashSet<String> = HashSet::new();
    let dismissed_cats = profile.map(|p| &p.dismissed_categories).unwrap_or(&empty);
    let is_dismissed_category = |cat: &str| dismissed_cats.contains(cat);
    let in_dismissed_category =
        |app: &AppSummary| is_dismissed_category(&app.core.category.trim().to_lowercase());

    let mut by_id: HashMap<String, &AppSummary> = HashMap::with_capacity(input.all.len());
    for app in &input.all {
        by_id.entry(app.core.id.to_lowercase()).or_insert(app);
    }

    // 已安装 / 已收藏 / 已关注与「不感兴趣」的应用都不进推荐货架（仍可作为种子被查找）
    let excluded = |id: &str| -> bool {
        profile
            .map(|p| {
                p.installed_ids.contains(id)
                    || p.explicit_local_ids.contains(id)
                    || p.dismissed_app_ids.contains(id)
            })
            .unwrap_or(false)
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut ranked: Vec<Scored> = Vec::new();
    for app in &input.all {
        let id = app.core.id.to_lowercase();
        if !seen.insert(id.clone())
            || input.hidden_ids.contains(&id)
            || input.allowed_ids.map(|s| !s.contains(&id)).unwrap_or(false)
            || excluded(&id)
        {
            continue;
        }
        let quality = shelf_quality(app, &id, day_seed);
        let boost = personal.map(|p| p.affinity_boost(app)).unwrap_or(0.0);
        ranked.push(Scored {
            score: quality.sampled + boost,
            base: quality.base,
            app,
        });
    }
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.app.core.id.cmp(&b.app.core.id))
    });

    let mut used: HashSet<String> = HashSet::new();
    let explain = |app: &AppSummary| -> Vec<Reason> {
        personal
            .map(|p| p.affinity_explain(app))
            .unwrap_or_default()
    };

    // 种子相似度词元：每个种子与每个候选各只分词一次，在 hero 与 because_you 间复用。
    let seeds = profile.map(|p| p.seeds.as_slice()).unwrap_or(&[]);
    let seed_tokens: HashMap<&str, Vec<String>> = match personal {
        Some(p) => seeds
            .iter()
            .filter_map(|sr| Some((sr.id.as_str(), p.similarity_tokens(by_id.get(&sr.id)?))))
            .collect(),
        None => HashMap::new(),
    };
    let cand_tokens: Vec<OnceCell<Vec<String>>> = ranked.iter().map(|_| OnceCell::new()).collect();
    let similarity = |p: &UserAffinityProfile, seed_id: &str, seed_app: &AppSummary, i: usize| {
        let cand = ranked[i].app;
        match seed_tokens.get(seed_id) {
            Some(st) => {
                let ct = cand_tokens[i].get_or_init(|| p.similarity_tokens(cand));
                p.seed_similarity_with_tokens(seed_app, st, cand, ct)
            }
            None => p.seed_similarity(seed_app, cand),
        }
    };

    // ---- hero：分类互斥取头部，「少推这类」分类只在其余分类凑不满时补位 ----
    let mut hero: Vec<FeaturedPick> = Vec::new();
    let mut hero_cats: HashSet<String> = HashSet::new();
    for allow_dismissed in [false, true] {
        for (idx, s) in ranked.iter().enumerate() {
            if hero.len() >= HERO_SIZE {
                break;
            }
            let cat = s.app.core.category.trim().to_lowercase();
            if (!allow_dismissed && is_dismissed_category(&cat)) || hero_cats.contains(&cat) {
                continue;
            }
            hero_cats.insert(cat);
            let mut reasons = Vec::new();
            if let Some(p) = personal {
                if let Some((seed_ref, _)) = seeds
                    .iter()
                    .filter_map(|sr| {
                        let seed_app = by_id.get(&sr.id)?;
                        let sim = similarity(p, &sr.id, seed_app, idx);
                        (sim >= HERO_SEED_REASON_MIN).then_some((sr, sim))
                    })
                    .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                {
                    reasons.push(Reason::Seed {
                        seed_id: seed_ref.id.clone(),
                        relation: seed_ref.relation,
                    });
                }
            }
            reasons.extend(explain(s.app));
            reasons.truncate(MAX_REASONS);
            used.insert(s.app.core.id.to_lowercase());
            hero.push(FeaturedPick {
                app: s.app.clone(),
                reasons,
            });
        }
    }

    let mut shelves: Vec<FeaturedShelf> = Vec::new();
    let max_score = ranked
        .iter()
        .map(|s| s.score)
        .fold(f64::MIN, f64::max)
        .max(1e-9);

    // ---- because_you ----
    let mut seed_cats: HashSet<String> = HashSet::new();
    let mut because_count = 0usize;
    if let Some(p) = personal {
        let want = if state == ProfileState::Rich { 2 } else { 1 };
        // 被「少推这类」的分类不作为种子分类，也不出现在 because_you 候选里
        let live_seeds: Vec<_> = p
            .top_seeds(usize::MAX)
            .into_iter()
            .filter(|s| !is_dismissed_category(&s.category))
            .take(want + 2)
            .collect();
        for seed_ref in live_seeds {
            if because_count >= want {
                break;
            }
            let Some(&seed_app) = by_id.get(&seed_ref.id) else {
                continue;
            };
            let mut cands: Vec<(f64, &Scored)> = ranked
                .iter()
                .enumerate()
                .filter(|(_, s)| !in_dismissed_category(s.app))
                .filter(|(_, s)| !used.contains(&s.app.core.id.to_lowercase()))
                .filter(|(_, s)| !s.app.core.id.eq_ignore_ascii_case(&seed_ref.id))
                .filter_map(|(idx, s)| {
                    let sim = similarity(p, &seed_ref.id, seed_app, idx);
                    (sim >= SEED_SIMILARITY_MIN).then(|| (0.6 * sim + 0.4 * s.score / max_score, s))
                })
                .collect();
            cands.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.1.app.core.id.cmp(&b.1.app.core.id))
            });
            if cands.len() < SHELF_MIN {
                continue;
            }
            let items: Vec<FeaturedPick> = cands
                .into_iter()
                .take(SHELF_SIZE)
                .map(|(_, s)| FeaturedPick {
                    app: s.app.clone(),
                    reasons: vec![p.seed_shelf_reason(seed_app, s.app)],
                })
                .collect();
            for it in &items {
                used.insert(it.app.core.id.to_lowercase());
            }
            seed_cats.insert(seed_ref.category.clone());
            because_count += 1;
            shelves.push(FeaturedShelf {
                kind: ShelfKind::BecauseYou,
                seed_id: Some(seed_ref.id.clone()),
                seed_relation: Some(seed_ref.relation),
                category: None,
                items,
            });
        }
    }

    // ---- fresh（非 rich，或 rich 但 because_you 不足 2 排时补位）----
    if state != ProfileState::Rich || because_count < 2 {
        let cutoff = date_string_days_ago(input.now_secs, FRESH_WINDOW_DAYS);
        let mut fresh: Vec<&Scored> = ranked
            .iter()
            .filter(|s| !in_dismissed_category(s.app))
            .filter(|s| !used.contains(&s.app.core.id.to_lowercase()))
            .filter(|s| {
                s.app
                    .core
                    .added_at
                    .as_deref()
                    .map(|d| d >= cutoff.as_str())
                    .unwrap_or(false)
            })
            .collect();
        fresh.sort_by(|a, b| {
            b.app
                .core
                .stars
                .cmp(&a.app.core.stars)
                .then_with(|| a.app.core.id.cmp(&b.app.core.id))
        });
        if fresh.len() >= SHELF_MIN {
            let items: Vec<FeaturedPick> = fresh
                .into_iter()
                .take(SHELF_SIZE)
                .map(|s| FeaturedPick {
                    app: s.app.clone(),
                    reasons: vec![Reason::Fresh {
                        added_at: s.app.core.added_at.clone().unwrap_or_default(),
                    }],
                })
                .collect();
            for it in &items {
                used.insert(it.app.core.id.to_lowercase());
            }
            shelves.push(FeaturedShelf {
                kind: ShelfKind::Fresh,
                seed_id: None,
                seed_relation: None,
                category: None,
                items,
            });
        }
    }

    // ---- category_pick ----
    let want_cats = match state {
        ProfileState::Warm => 1,
        _ => 2,
    };
    let category_order: Vec<String> = if personalized {
        profile
            .map(|p| {
                p.top_categories(4)
                    .into_iter()
                    .map(|(c, _)| c)
                    .filter(|c| !seed_cats.contains(c))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        rotated_categories(&ranked, day_seed)
    };
    // 个性化分类只来自画像，被抑制分类直接剔除；无画像轮换池在其余分类不足时才用它兜底
    let category_order = if personalized {
        category_order
            .into_iter()
            .filter(|c| !is_dismissed_category(c))
            .collect()
    } else {
        demote_dismissed(category_order, dismissed_cats, want_cats)
    };
    let mut picked_cats = 0;
    for cat in &category_order {
        if picked_cats >= want_cats {
            break;
        }
        let items: Vec<FeaturedPick> = ranked
            .iter()
            .filter(|s| s.app.core.category.trim().eq_ignore_ascii_case(cat))
            .filter(|s| !used.contains(&s.app.core.id.to_lowercase()))
            .take(SHELF_SIZE)
            .map(|s| {
                let mut reasons = explain(s.app);
                reasons.retain(|r| !matches!(r, Reason::Category { .. }));
                reasons.truncate(1);
                FeaturedPick {
                    app: s.app.clone(),
                    reasons,
                }
            })
            .collect();
        if items.len() < SHELF_MIN {
            continue;
        }
        for it in &items {
            used.insert(it.app.core.id.to_lowercase());
        }
        picked_cats += 1;
        shelves.push(FeaturedShelf {
            kind: ShelfKind::CategoryPick,
            seed_id: None,
            seed_relation: None,
            category: Some(cat.clone()),
            items,
        });
    }

    // ---- explore（仅 rich）：每个少接触分类取质量前 N 的精品池，按日期种子挑当日代表作 ----
    if state == ProfileState::Rich {
        let p = profile.expect("rich implies profile");
        let mut pools: HashMap<String, Vec<&Scored>> = HashMap::new();
        for s in &ranked {
            let cat = s.app.core.category.trim().to_lowercase();
            if cat.is_empty()
                || is_dismissed_category(&cat)
                || used.contains(&s.app.core.id.to_lowercase())
                || p.category_weights.get(&cat).copied().unwrap_or(0.0) >= EXPLORE_WEIGHT_MAX
            {
                continue;
            }
            pools.entry(cat).or_default().push(s);
        }
        let mut picks: Vec<(String, &Scored)> = pools
            .into_iter()
            .filter_map(|(cat, mut pool)| {
                pool.sort_by(|a, b| {
                    b.base
                        .partial_cmp(&a.base)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| a.app.core.id.cmp(&b.app.core.id))
                });
                pool.truncate(EXPLORE_PER_CAT_POOL);
                let pick = pool.into_iter().max_by(|a, b| {
                    feed_jitter01(&a.app.core.id, day_seed)
                        .partial_cmp(&feed_jitter01(&b.app.core.id, day_seed))
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| b.app.core.id.cmp(&a.app.core.id))
                })?;
                Some((cat, pick))
            })
            .collect();
        picks.sort_by(|a, b| {
            feed_jitter01(&a.0, day_seed)
                .partial_cmp(&feed_jitter01(&b.0, day_seed))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        let items: Vec<FeaturedPick> = picks
            .into_iter()
            .take(SHELF_SIZE)
            .map(|(cat, s)| FeaturedPick {
                app: s.app.clone(),
                reasons: vec![Reason::Explore { category: cat }],
            })
            .collect();
        if items.len() >= SHELF_MIN {
            for it in &items {
                used.insert(it.app.core.id.to_lowercase());
            }
            shelves.push(FeaturedShelf {
                kind: ShelfKind::Explore,
                seed_id: None,
                seed_relation: None,
                category: None,
                items,
            });
        }
    }

    // 组装按去重优先级进行，输出按展示位次排列（稳定排序，同类货架保持组装先后）。
    shelves.sort_by_key(|s| s.kind.display_rank());

    let top_categories = if personalized {
        profile
            .map(|p| p.top_categories(3).into_iter().map(|(c, _)| c).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    FeaturedPage {
        profile_state: state,
        signal_count: if input.enabled {
            profile.map(|p| p.signal_count).unwrap_or(0)
        } else {
            0
        },
        top_categories,
        hero,
        shelves,
    }
}

/// 无画像时的分类轮换：候选中出现的分类按日期种子抖动排序。
fn rotated_categories(ranked: &[Scored<'_>], day_seed: u64) -> Vec<String> {
    let mut cats: Vec<String> = ranked
        .iter()
        .map(|s| s.app.core.category.trim().to_lowercase())
        .filter(|c| !c.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    cats.sort_by(|a, b| {
        feed_jitter01(a, day_seed)
            .partial_cmp(&feed_jitter01(b, day_seed))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.cmp(b))
    });
    cats
}

/// `now_secs` 往前 `days` 天的 UTC 日期，格式 `YYYY-MM-DD`（与 `added_at` 可直接按字符串比较）。
fn date_string_days_ago(now_secs: i64, days: i64) -> String {
    let ts = now_secs.saturating_sub(days * 86400);
    match time::OffsetDateTime::from_unix_timestamp(ts) {
        Ok(dt) => {
            let d = dt.date();
            format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
        }
        Err(_) => String::from("0000-00-00"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{FeedFeedback, FeedbackScope, RawAffinitySignals};
    use crate::github::models::CatalogItem;

    const NOW: i64 = 1_800_000_000; // 2027-01-15

    fn item(
        id: &str,
        category: &str,
        stars: u64,
        desc: &str,
        added_at: Option<&str>,
    ) -> CatalogItem {
        let (owner, repo) = id.split_once('/').unwrap();
        CatalogItem {
            id: id.to_string(),
            name: repo.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: desc.to_string(),
            description_en: Some(desc.to_string()),
            category: category.to_string(),
            category_name: category.to_string(),
            aliases: vec![],
            default_version: "v1".to_string(),
            added_at: added_at.map(str::to_string),
            license: "MIT".to_string(),
            stars,
            forks: stars / 10,
            is_verified: true,
            homepage: None,
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec!["windows".to_string()],
            identifiers: Default::default(),
        }
    }

    fn catalog() -> Vec<CatalogItem> {
        let cats = [
            ("dev", "code editor ide"),
            ("media", "video player"),
            ("office", "markdown notes"),
            ("security", "password vault"),
            ("system", "remote desktop"),
            ("games", "retro emulator"),
        ];
        let mut out = Vec::new();
        for (ci, (cat, desc)) in cats.iter().enumerate() {
            for i in 0..8 {
                let added = if i == 0 {
                    Some("2027-01-10")
                } else {
                    Some("2025-01-01")
                };
                out.push(item(
                    &format!("{cat}-owner{}/app{i}", i % 2),
                    cat,
                    1000 * (10 - i as u64) + ci as u64,
                    desc,
                    added,
                ));
            }
        }
        out
    }

    fn summaries(c: &[CatalogItem]) -> Vec<AppSummary> {
        c.iter().map(|i| i.to_summary()).collect()
    }

    fn page(
        raw: &RawAffinitySignals,
        enabled: bool,
        day_seed: u64,
        allowed: Option<&HashSet<String>>,
    ) -> FeaturedPage {
        let c = catalog();
        let profile = UserAffinityProfile::from_signals(raw, &c, NOW);
        let hidden = HashSet::new();
        assemble_featured_page(FeaturedInput {
            all: summaries(&c),
            allowed_ids: allowed,
            hidden_ids: &hidden,
            profile: Some(&profile),
            enabled,
            day_seed,
            now_secs: NOW,
        })
    }

    fn rich_raw() -> RawAffinitySignals {
        RawAffinitySignals {
            favorites: vec![
                ("dev-owner0/app0".to_string(), NOW),
                ("dev-owner1/app1".to_string(), NOW),
                ("office-owner0/app2".to_string(), NOW),
            ],
            installed: vec![("dev-owner0/app2".to_string(), NOW)],
            watched: vec![("office-owner1/app3".to_string(), NOW)],
            ..Default::default()
        }
    }

    fn all_ids(p: &FeaturedPage) -> Vec<String> {
        p.hero
            .iter()
            .chain(p.shelves.iter().flat_map(|s| s.items.iter()))
            .map(|x| x.app.core.id.clone())
            .collect()
    }

    fn kinds(p: &FeaturedPage) -> Vec<ShelfKind> {
        p.shelves.iter().map(|s| s.kind).collect()
    }

    fn warm_raw() -> RawAffinitySignals {
        RawAffinitySignals {
            favorites: vec![
                ("media-owner0/app0".to_string(), NOW),
                ("office-owner0/app0".to_string(), NOW - 86400),
            ],
            ..Default::default()
        }
    }

    /// 四种画像状态的区块组合与展示顺序（spec §2 自上而下、§3 状态表）。
    #[test]
    fn profile_states_produce_expected_shelves_in_display_order() {
        use ShelfKind::*;
        let cases: Vec<(&str, RawAffinitySignals, bool, ProfileState, Vec<ShelfKind>)> = vec![
            (
                "off",
                rich_raw(),
                false,
                ProfileState::Off,
                vec![CategoryPick, CategoryPick, Fresh],
            ),
            (
                "cold",
                RawAffinitySignals::default(),
                true,
                ProfileState::Cold,
                vec![CategoryPick, CategoryPick, Fresh],
            ),
            (
                "warm",
                warm_raw(),
                true,
                ProfileState::Warm,
                vec![BecauseYou, CategoryPick, Fresh],
            ),
            (
                "rich",
                rich_raw(),
                true,
                ProfileState::Rich,
                // 画像分类只有 dev / office，都已被 because_you 种子占用，故无 category_pick。
                vec![BecauseYou, BecauseYou, Explore],
            ),
        ];
        for (name, raw, enabled, state, expected) in cases {
            let p = page(&raw, enabled, 20261113, None);
            assert_eq!(p.profile_state, state, "{name}: state");
            assert_eq!(p.hero.len(), HERO_SIZE, "{name}: hero size");
            assert_eq!(kinds(&p), expected, "{name}: shelves");
            if !state.personalized() {
                assert_eq!(p.signal_count, 0, "{name}: signal_count");
                assert!(p.top_categories.is_empty(), "{name}: top_categories");
                assert!(
                    p.hero.iter().all(|h| h.reasons.is_empty()),
                    "{name}: hero reasons"
                );
            }
        }
    }

    #[test]
    fn warm_category_pick_skips_seed_category() {
        let p = page(&warm_raw(), true, 1, None);
        let because = p
            .shelves
            .iter()
            .find(|s| s.kind == ShelfKind::BecauseYou)
            .unwrap();
        let pick = p
            .shelves
            .iter()
            .find(|s| s.kind == ShelfKind::CategoryPick)
            .unwrap();
        assert_ne!(
            because.seed_id.as_deref().unwrap().split('-').next(),
            pick.category.as_deref()
        );
    }

    #[test]
    fn rich_top_category_follows_profile() {
        let p = page(&rich_raw(), true, 1, None);
        assert_eq!(p.top_categories[0], "dev");
    }

    #[test]
    fn page_has_no_duplicates_and_excludes_installed_and_dismissed() {
        let mut raw = rich_raw();
        raw.feedback = vec![FeedFeedback {
            target: "media-owner0/app0".to_string(),
            scope: FeedbackScope::App,
            created_at: NOW,
        }];
        let p = page(&raw, true, 1, None);
        let ids = all_ids(&p);
        let uniq: HashSet<_> = ids.iter().collect();
        assert_eq!(uniq.len(), ids.len());
        assert!(!ids.contains(&"dev-owner0/app2".to_string()));
        assert!(!ids.contains(&"media-owner0/app0".to_string()));
    }

    #[test]
    fn hero_categories_are_distinct() {
        let p = page(&rich_raw(), true, 1, None);
        let cats: HashSet<_> = p.hero.iter().map(|h| h.app.core.category.clone()).collect();
        assert_eq!(cats.len(), p.hero.len());
    }

    fn hero_ids(p: &FeaturedPage) -> Vec<String> {
        p.hero.iter().map(|h| h.app.core.id.clone()).collect()
    }

    #[test]
    fn same_day_seed_is_stable() {
        let a = page(&RawAffinitySignals::default(), false, 20261113, None);
        let b = page(&RawAffinitySignals::default(), false, 20261113, None);
        assert_eq!(all_ids(&a), all_ids(&b));
        assert_eq!(hero_ids(&a), hero_ids(&b));
    }

    /// 目录 ≥ 20 时换 daySeed 后 hero 至少有 1 个变化：逐日检查一周内每次换种子。
    #[test]
    fn next_day_seed_rotates_hero() {
        assert!(catalog().len() >= 20);
        for day in 20261113..20261120u64 {
            let today = page(&RawAffinitySignals::default(), false, day, None);
            let tomorrow = page(&RawAffinitySignals::default(), false, day + 1, None);
            assert_ne!(
                hero_ids(&today),
                hero_ids(&tomorrow),
                "hero unchanged between {day} and {}",
                day + 1
            );
        }
    }

    /// 反馈过期（≥ 90 天）后应用重新进入候选；有效期内的反馈仍排除。
    #[test]
    fn expired_feedback_no_longer_excludes() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let now = crate::now_secs();
        let target = "media-owner0/app0";
        db.upsert_feed_feedback(target, FeedbackScope::App, now - 91 * 86400)
            .unwrap();
        let mut raw = rich_raw();
        raw.feedback = db.get_active_feed_feedback(now).unwrap();
        let candidates: HashSet<String> = [target.to_string()].into_iter().collect();
        let expired = page(&raw, true, 1, Some(&candidates));
        assert!(all_ids(&expired).contains(&target.to_string()));

        db.upsert_feed_feedback(target, FeedbackScope::App, now)
            .unwrap();
        raw.feedback = db.get_active_feed_feedback(now).unwrap();
        let active = page(&raw, true, 1, Some(&candidates));
        assert!(!all_ids(&active).contains(&target.to_string()));
    }

    #[test]
    fn allowed_ids_limit_candidates() {
        let allowed: HashSet<String> = catalog()
            .iter()
            .filter(|c| c.category == "games" || c.category == "media")
            .map(|c| c.id.clone())
            .collect();
        let p = page(&RawAffinitySignals::default(), false, 1, Some(&allowed));
        assert!(all_ids(&p).iter().all(|id| allowed.contains(id)));
    }

    #[test]
    fn because_you_items_resemble_seed() {
        let p = page(&rich_raw(), true, 1, None);
        let shelf = p
            .shelves
            .iter()
            .find(|s| s.kind == ShelfKind::BecauseYou)
            .unwrap();
        let seed_cat = shelf.seed_id.as_deref().unwrap().split('-').next().unwrap();
        assert!(shelf.items.iter().all(|i| i.app.core.category == seed_cat));
    }

    #[test]
    fn fresh_cutoff_date() {
        assert_eq!(date_string_days_ago(NOW, 30), "2026-12-16");
    }

    #[test]
    fn favorites_and_watched_are_excluded_but_still_seed_because_you() {
        let raw = rich_raw();
        let p = page(&raw, true, 1, None);
        let ids = all_ids(&p);
        let explicit: Vec<String> = raw
            .favorites
            .iter()
            .chain(&raw.watched)
            .chain(&raw.installed)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &explicit {
            assert!(!ids.contains(id), "{id} 不应出现在推荐货架");
        }
        let seeds: Vec<&str> = p
            .shelves
            .iter()
            .filter(|s| s.kind == ShelfKind::BecauseYou)
            .filter_map(|s| s.seed_id.as_deref())
            .collect();
        assert!(!seeds.is_empty());
        assert!(seeds.iter().all(|s| explicit.iter().any(|e| e == s)));
    }

    fn with_category_feedback(mut raw: RawAffinitySignals, cat: &str) -> RawAffinitySignals {
        raw.feedback.push(FeedFeedback {
            target: cat.to_string(),
            scope: FeedbackScope::Category,
            created_at: NOW,
        });
        raw
    }

    fn shelf_categories(p: &FeaturedPage) -> Vec<String> {
        p.shelves
            .iter()
            .filter(|s| matches!(s.kind, ShelfKind::Explore | ShelfKind::CategoryPick))
            .flat_map(|s| {
                s.category
                    .iter()
                    .cloned()
                    .chain(s.items.iter().filter_map(|i| match i.reasons.first() {
                        Some(Reason::Explore { category }) => Some(category.clone()),
                        _ => None,
                    }))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn dismissed_category_leaves_explore_and_category_pick_in_every_state() {
        // rich：media 权重为 0，原本会进探索
        let rich = page(&with_category_feedback(rich_raw(), "media"), true, 3, None);
        assert_eq!(rich.profile_state, ProfileState::Rich);
        assert!(!shelf_categories(&rich).contains(&"media".to_string()));

        // rich 轻度偏好：浏览一次 games 得到较低权重，被抑制后不得掉进探索
        let mut light = rich_raw();
        light.views = vec![("games-owner0/app3".to_string(), NOW)];
        let light = page(&with_category_feedback(light, "games"), true, 3, None);
        assert!(!shelf_categories(&light).contains(&"games".to_string()));

        // warm：画像第二分类被抑制后不再作为分类精选
        let warm = page(&with_category_feedback(warm_raw(), "office"), true, 3, None);
        assert_eq!(warm.profile_state, ProfileState::Warm);
        assert!(!shelf_categories(&warm).contains(&"office".to_string()));

        // off / cold：轮换分类跳过被抑制分类
        for (enabled, raw) in [(false, rich_raw()), (true, RawAffinitySignals::default())] {
            for day in 1..10u64 {
                let before = page(&raw, enabled, day, None);
                let target = before
                    .shelves
                    .iter()
                    .find(|s| s.kind == ShelfKind::CategoryPick)
                    .and_then(|s| s.category.clone())
                    .unwrap();
                let after = page(
                    &with_category_feedback(raw.clone(), &target),
                    enabled,
                    day,
                    None,
                );
                assert!(
                    !shelf_categories(&after).contains(&target),
                    "day {day}: {target} still picked"
                );
                assert!(after.hero.iter().all(|h| !h
                    .app
                    .core
                    .category
                    .eq_ignore_ascii_case(&target)));
            }
        }
    }

    #[test]
    fn rich_without_because_you_falls_back_to_fresh() {
        let raw = RawAffinitySignals {
            repo_signals: (0..5)
                .map(|i| crate::db::UserRepoSignal {
                    full_name: format!("outside{i}/thing{i}"),
                    relation: "starred".to_string(),
                    language: "C".to_string(),
                    description: "video player".to_string(),
                    stars: 100,
                    forks: 1,
                    updated_at: NOW,
                })
                .collect(),
            ..Default::default()
        };
        let p = page(&raw, true, 1, None);
        assert_eq!(p.profile_state, ProfileState::Rich);
        assert!(!kinds(&p).contains(&ShelfKind::BecauseYou));
        assert!(kinds(&p).contains(&ShelfKind::Fresh));

        let full = page(&rich_raw(), true, 1, None);
        assert_eq!(
            kinds(&full)
                .iter()
                .filter(|k| **k == ShelfKind::BecauseYou)
                .count(),
            2
        );
        assert!(!kinds(&full).contains(&ShelfKind::Fresh));
    }

    #[test]
    fn explore_rotates_representative_within_category() {
        let mut picks: HashMap<String, HashSet<String>> = HashMap::new();
        for day in 20261101..20261131u64 {
            let p = page(&rich_raw(), true, day, None);
            for shelf in p.shelves.iter().filter(|s| s.kind == ShelfKind::Explore) {
                for it in &shelf.items {
                    picks
                        .entry(it.app.core.category.clone())
                        .or_default()
                        .insert(it.app.core.id.clone());
                }
            }
        }
        assert!(!picks.is_empty());
        for (cat, ids) in picks {
            assert!(ids.len() > 1, "{cat} explore pick never rotated: {ids:?}");
        }
    }

    fn page_categories(p: &FeaturedPage) -> HashSet<String> {
        p.hero
            .iter()
            .chain(p.shelves.iter().flat_map(|s| s.items.iter()))
            .map(|i| i.app.core.category.clone())
            .collect()
    }

    #[test]
    fn dismissed_category_leaves_because_you_and_fresh() {
        // rich：dev 是最强种子分类，被少推后不再作为种子，也不出现在任何货架
        let p = page(&with_category_feedback(rich_raw(), "dev"), true, 1, None);
        assert!(p
            .shelves
            .iter()
            .filter_map(|s| s.seed_id.as_deref())
            .all(|id| !id.starts_with("dev-")));
        assert!(
            !page_categories(&p).contains("dev"),
            "{:?}",
            page_categories(&p)
        );

        // off：每个分类都有一款新入库（未过滤时 media 的那款会补进本月新入库）
        for day in 1..10u64 {
            let p = page(
                &with_category_feedback(rich_raw(), "media"),
                false,
                day,
                None,
            );
            assert!(!page_categories(&p).contains("media"), "day {day}");
        }
    }

    /// 预提取词元的种子相似度与逐对分词版本逐位一致（货架复用词元的前提）。
    #[test]
    fn pre_tokenized_seed_similarity_matches_direct() {
        let c = catalog();
        let profile = UserAffinityProfile::from_signals(&rich_raw(), &c, NOW);
        let apps = summaries(&c);
        let tokens: Vec<Vec<String>> = apps.iter().map(|a| profile.similarity_tokens(a)).collect();
        for (si, seed) in apps.iter().enumerate().step_by(5) {
            for (ci, cand) in apps.iter().enumerate() {
                let direct = profile.seed_similarity(seed, cand);
                let cached =
                    profile.seed_similarity_with_tokens(seed, &tokens[si], cand, &tokens[ci]);
                assert_eq!(
                    direct.to_bits(),
                    cached.to_bits(),
                    "{} vs {}",
                    seed.core.id,
                    cand.core.id
                );
            }
        }
    }
}
