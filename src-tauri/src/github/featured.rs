//! 精选页货架组装（ADR-0023）：纯函数，输入合并目录与本地画像，输出整页结构。

use super::affinity::{seed_similarity, Reason, SeedRelation, UserAffinityProfile, MAX_REASONS};
use super::catalog_feed_score::{feed_jitter01, feed_stars_forks_base, FEED_JITTER_HALF};
use crate::models::AppSummary;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// hero 条目数（1 大 2 小）。
pub const HERO_SIZE: usize = 3;
/// 货架条目数。
pub const SHELF_SIZE: usize = 4;
/// 货架最少条目数：不足则整排不出。
pub const SHELF_MIN: usize = 3;
/// `because_you` 候选与种子的最低相似度。
pub const SEED_SIMILARITY_MIN: f64 = 0.35;
/// hero 附带种子理由的最低相似度。
const HERO_SEED_REASON_MIN: f64 = 0.5;
/// 画像分类权重低于此值视为「较少接触」，进入探索候选。
pub const EXPLORE_WEIGHT_MAX: f64 = 0.15;
/// 「本月新入库」窗口（天）。
pub const FRESH_WINDOW_DAYS: i64 = 30;
/// 画像信号数达到此值进入 `rich`。
pub const RICH_SIGNAL_MIN: usize = 5;

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
    /// 页面自上而下的展示位次（spec §2）；与组装去重顺序无关。
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
    /// 本地画像（关闭个性化时也传入，用于排除已安装与「不感兴趣」）。
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

struct Scored {
    app: AppSummary,
    score: f64,
    quality: f64,
}

pub fn assemble_featured_page(input: FeaturedInput<'_>) -> FeaturedPage {
    let state = resolve_profile_state(input.enabled, input.profile);
    let personalized = state.personalized();
    let profile = input.profile;
    let seed = input.day_seed;

    let mut by_id: HashMap<String, AppSummary> = HashMap::with_capacity(input.all.len());
    for app in &input.all {
        by_id
            .entry(app.core.id.to_lowercase())
            .or_insert_with(|| app.clone());
    }

    let installed = profile.map(|p| &p.installed_ids);
    let dismissed = profile.map(|p| &p.dismissed_app_ids);
    let mut seen: HashSet<String> = HashSet::new();
    let mut ranked: Vec<Scored> = Vec::new();
    for app in input.all {
        let id = app.core.id.to_lowercase();
        if !seen.insert(id.clone())
            || input.hidden_ids.contains(&id)
            || input.allowed_ids.map(|s| !s.contains(&id)).unwrap_or(false)
            || installed.map(|s| s.contains(&id)).unwrap_or(false)
            || dismissed.map(|s| s.contains(&id)).unwrap_or(false)
        {
            continue;
        }
        let jitter = (feed_jitter01(&id, seed) - 0.5) * FEED_JITTER_HALF * 2.0;
        let quality = feed_stars_forks_base(app.core.stars, app.core.forks) + jitter;
        let boost = if personalized {
            profile.map(|p| p.affinity_boost(&app)).unwrap_or(0.0)
        } else {
            0.0
        };
        ranked.push(Scored {
            score: quality + boost,
            quality,
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
        match (personalized, profile) {
            (true, Some(p)) => p.affinity_explain(app),
            _ => Vec::new(),
        }
    };

    // ---- hero：分类互斥取头部 ----
    let mut hero: Vec<FeaturedPick> = Vec::new();
    let mut hero_cats: HashSet<String> = HashSet::new();
    let seeds = profile.map(|p| p.seeds.as_slice()).unwrap_or(&[]);
    for s in &ranked {
        if hero.len() >= HERO_SIZE {
            break;
        }
        let cat = s.app.core.category.trim().to_lowercase();
        if !hero_cats.insert(cat) {
            continue;
        }
        let mut reasons = Vec::new();
        if personalized {
            if let Some((seed_ref, _)) = seeds
                .iter()
                .filter_map(|sr| {
                    let seed_app = by_id.get(&sr.id)?;
                    let sim = seed_similarity(seed_app, &s.app);
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
        reasons.extend(explain(&s.app));
        reasons.truncate(MAX_REASONS);
        used.insert(s.app.core.id.to_lowercase());
        hero.push(FeaturedPick {
            app: s.app.clone(),
            reasons,
        });
    }

    let mut shelves: Vec<FeaturedShelf> = Vec::new();
    let max_score = ranked
        .iter()
        .map(|s| s.score)
        .fold(f64::MIN, f64::max)
        .max(1e-9);

    // ---- because_you ----
    let mut seed_cats: HashSet<String> = HashSet::new();
    if personalized {
        let want = if state == ProfileState::Rich { 2 } else { 1 };
        let p = profile.expect("personalized implies profile");
        for seed_ref in p.top_seeds(want + 2) {
            if shelves.len() >= want {
                break;
            }
            let Some(seed_app) = by_id.get(&seed_ref.id) else {
                continue;
            };
            let mut cands: Vec<(f64, &Scored)> = ranked
                .iter()
                .filter(|s| !used.contains(&s.app.core.id.to_lowercase()))
                .filter(|s| !s.app.core.id.eq_ignore_ascii_case(&seed_ref.id))
                .filter_map(|s| {
                    let sim = seed_similarity(seed_app, &s.app);
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
                .map(|(_, s)| {
                    let mut reasons = explain(&s.app);
                    reasons.retain(|r| !matches!(r, Reason::Category { .. }));
                    if reasons.is_empty() {
                        reasons.push(Reason::Category {
                            category: s.app.core.category.trim().to_lowercase(),
                        });
                    }
                    reasons.truncate(1);
                    FeaturedPick {
                        app: s.app.clone(),
                        reasons,
                    }
                })
                .collect();
            for it in &items {
                used.insert(it.app.core.id.to_lowercase());
            }
            seed_cats.insert(seed_ref.category.clone());
            shelves.push(FeaturedShelf {
                kind: ShelfKind::BecauseYou,
                seed_id: Some(seed_ref.id.clone()),
                seed_relation: Some(seed_ref.relation),
                category: None,
                items,
            });
        }
    }

    // ---- fresh（非 rich）----
    if state != ProfileState::Rich {
        let cutoff = date_string_days_ago(input.now_secs, FRESH_WINDOW_DAYS);
        let mut fresh: Vec<&Scored> = ranked
            .iter()
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
        rotated_categories(&ranked, seed)
    };
    let want_cats = match state {
        ProfileState::Warm => 1,
        _ => 2,
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
                let mut reasons = explain(&s.app);
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

    // ---- explore（仅 rich）----
    if state == ProfileState::Rich {
        let p = profile.expect("rich implies profile");
        let mut best_per_cat: HashMap<String, &Scored> = HashMap::new();
        for s in &ranked {
            let cat = s.app.core.category.trim().to_lowercase();
            if cat.is_empty() || used.contains(&s.app.core.id.to_lowercase()) {
                continue;
            }
            if p.category_weights.get(&cat).copied().unwrap_or(0.0) >= EXPLORE_WEIGHT_MAX {
                continue;
            }
            let replace = best_per_cat
                .get(&cat)
                .map(|cur| s.quality > cur.quality)
                .unwrap_or(true);
            if replace {
                best_per_cat.insert(cat, s);
            }
        }
        let mut cats: Vec<(&String, &&Scored)> = best_per_cat.iter().collect();
        cats.sort_by(|a, b| {
            feed_jitter01(a.0, seed)
                .partial_cmp(&feed_jitter01(b.0, seed))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(b.0))
        });
        let items: Vec<FeaturedPick> = cats
            .into_iter()
            .take(SHELF_SIZE)
            .map(|(cat, s)| FeaturedPick {
                app: s.app.clone(),
                reasons: vec![Reason::Explore {
                    category: cat.clone(),
                }],
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
fn rotated_categories(ranked: &[Scored], seed: u64) -> Vec<String> {
    let mut cats: Vec<String> = ranked
        .iter()
        .map(|s| s.app.core.category.trim().to_lowercase())
        .filter(|c| !c.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    cats.sort_by(|a, b| {
        feed_jitter01(a, seed)
            .partial_cmp(&feed_jitter01(b, seed))
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
            for i in 0..6 {
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
}
