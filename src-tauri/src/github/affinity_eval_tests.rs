//! 基于仓库根目录真实 `catalog.json` 的推荐质量门禁：轮换多样性、抗淹没、
//! 推荐理由纯净度、分类推断准确率与「少推这类」全态闭环。

use super::affinity::{infer_categories_from_repo, Reason, UserAffinityProfile};
use super::featured::{
    assemble_featured_page, FeaturedInput, FeaturedPage, ProfileState, ShelfKind,
    EXPLORE_WEIGHT_MAX,
};
use super::models::CatalogItem;
use crate::db::{FeedFeedback, FeedbackScope, RawAffinitySignals, UserRepoSignal};
use crate::models::AppSummary;
use std::collections::HashSet;

/// 2026-11-15 00:00:00 UTC。
const NOW: i64 = 1_794_700_800;
const DAYS: std::ops::RangeInclusive<u64> = 20261101..=20261130;

fn real_catalog() -> Vec<CatalogItem> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../catalog.json");
    let raw = std::fs::read_to_string(path).expect("读取仓库根目录 catalog.json");
    serde_json::from_str(&raw).expect("解析 catalog.json")
}

fn ids_in(catalog: &[CatalogItem], category: &str, n: usize) -> Vec<String> {
    let mut items: Vec<&CatalogItem> = catalog.iter().filter(|c| c.category == category).collect();
    items.sort_by(|a, b| b.stars.cmp(&a.stars).then_with(|| a.id.cmp(&b.id)));
    items.into_iter().take(n).map(|c| c.id.to_lowercase()).collect()
}

/// 典型 rich 画像：收藏 2 款 media、安装 2 款 security、关注 1 款 office。
fn rich_raw(catalog: &[CatalogItem]) -> RawAffinitySignals {
    let pairs = |ids: Vec<String>| ids.into_iter().map(|id| (id, NOW - 3600)).collect();
    RawAffinitySignals {
        favorites: pairs(ids_in(catalog, "media", 2)),
        installed: pairs(ids_in(catalog, "security", 2)),
        watched: pairs(ids_in(catalog, "office", 1)),
        ..Default::default()
    }
}

fn page(
    catalog: &[CatalogItem],
    raw: &RawAffinitySignals,
    enabled: bool,
    day_seed: u64,
) -> (FeaturedPage, UserAffinityProfile) {
    let profile = UserAffinityProfile::from_signals(raw, catalog, NOW);
    let hidden = HashSet::new();
    let all: Vec<AppSummary> = catalog.iter().map(|c| c.to_summary()).collect();
    let page = assemble_featured_page(FeaturedInput {
        all,
        allowed_ids: None,
        hidden_ids: &hidden,
        profile: Some(&profile),
        enabled,
        day_seed,
        now_secs: NOW,
    });
    (page, profile)
}

fn page_ids(p: &FeaturedPage) -> Vec<String> {
    p.hero
        .iter()
        .chain(p.shelves.iter().flat_map(|s| s.items.iter()))
        .map(|x| x.app.core.id.to_lowercase())
        .collect()
}

#[test]
fn thirty_day_rotation_keeps_hero_diverse_and_guarded() {
    let catalog = real_catalog();
    let stars_of = |id: &str| {
        catalog
            .iter()
            .find(|c| c.id.eq_ignore_ascii_case(id))
            .map(|c| c.stars)
            .unwrap_or(0)
    };
    for (name, raw, enabled, state) in [
        ("off", RawAffinitySignals::default(), false, ProfileState::Off),
        ("rich", rich_raw(&catalog), true, ProfileState::Rich),
    ] {
        let explicit: HashSet<String> = raw
            .favorites
            .iter()
            .chain(&raw.watched)
            .chain(&raw.installed)
            .map(|(id, _)| id.clone())
            .collect();
        let mut main_heroes: HashSet<String> = HashSet::new();
        let mut triples: HashSet<Vec<String>> = HashSet::new();
        for day in DAYS {
            let (p, _) = page(&catalog, &raw, enabled, day);
            assert_eq!(p.profile_state, state, "{name}");
            let hero: Vec<String> = p.hero.iter().map(|h| h.app.core.id.clone()).collect();
            main_heroes.insert(hero[0].clone());
            triples.insert(hero.clone());
            for id in &hero {
                assert!(stars_of(id) >= 500, "{name} day {day}: 长尾 {id} 登上 hero");
            }
            let ids = page_ids(&p);
            let uniq: HashSet<&String> = ids.iter().collect();
            assert_eq!(uniq.len(), ids.len(), "{name} day {day}: 整页重复");
            for id in &ids {
                assert!(!explicit.contains(id), "{name} day {day}: 已知应用 {id} 混入");
            }
        }
        assert!(
            main_heroes.len() >= 5,
            "{name}: 30 天主 hero 只有 {} 款：{main_heroes:?}",
            main_heroes.len()
        );
        assert!(
            triples.len() >= 12,
            "{name}: 30 天 hero 三元组只有 {} 组",
            triples.len()
        );
    }
}

fn github_flood(n: usize) -> Vec<UserRepoSignal> {
    let langs = ["Rust", "Python", "TypeScript"];
    let descs = [
        "A library for parsing configuration files",
        "Command line helper for developers",
        "Async web framework with batteries included",
        "My personal dotfiles and scripts",
        "Machine learning experiments",
        "",
    ];
    (0..n)
        .map(|i| UserRepoSignal {
            full_name: format!("someone{i}/project-{i}"),
            relation: if i % 3 == 0 { "owned" } else { "starred" }.to_string(),
            language: langs[i % langs.len()].to_string(),
            description: descs[i % descs.len()].to_string(),
            stars: (i as u64 * 37) % 20_000,
            forks: (i as u64 * 7) % 2_000,
            updated_at: NOW - (i as i64) * 3600,
        })
        .collect()
}

#[test]
fn heavy_github_account_does_not_drown_local_intent() {
    let catalog = real_catalog();
    let raw = RawAffinitySignals {
        repo_signals: github_flood(300),
        favorites: ids_in(&catalog, "media", 2)
            .into_iter()
            .map(|id| (id, NOW - 600))
            .collect(),
        interest_seeds: vec!["reading".to_string()],
        ..Default::default()
    };
    let profile = UserAffinityProfile::from_signals(&raw, &catalog, NOW);
    for cat in ["media", "reading"] {
        let w = profile.category_weights.get(cat).copied().unwrap_or(0.0);
        assert!(w >= 0.45, "{cat} = {w}: {:?}", profile.category_weights);
        assert!(w >= EXPLORE_WEIGHT_MAX);
    }
    let top: Vec<String> = profile
        .top_categories(3)
        .into_iter()
        .map(|(c, _)| c)
        .collect();
    assert!(top.contains(&"media".to_string()), "{top:?}");
    assert!(top.contains(&"reading".to_string()), "{top:?}");
}

#[test]
fn keyword_reasons_never_surface_generic_words() {
    let catalog = real_catalog();
    let mut raw = rich_raw(&catalog);
    raw.repo_signals = github_flood(60);
    raw.searches = vec![
        ("open-source cross-platform desktop app".to_string(), NOW),
        ("远程桌面".to_string(), NOW - 600),
        ("markdown notes https://example.com".to_string(), NOW - 1200),
    ];
    raw.views = ids_in(&catalog, "dev", 3)
        .into_iter()
        .map(|id| (id, NOW - 300))
        .collect();
    const BANNED: &[&str] = &[
        "open-source",
        "cross-platform",
        "desktop",
        "https",
        "http",
        "your",
        "you",
        "open",
        "source",
        "app",
    ];
    let mut seen_keywords = 0usize;
    for day in DAYS {
        let (p, _) = page(&catalog, &raw, true, day);
        for pick in p.hero.iter().chain(p.shelves.iter().flat_map(|s| s.items.iter())) {
            for r in &pick.reasons {
                if let Reason::Keywords { tokens } = r {
                    seen_keywords += 1;
                    for t in tokens {
                        assert!(!BANNED.contains(&t.as_str()), "泛化词 {t} 出现在推荐理由");
                    }
                }
            }
        }
    }
    assert!(seen_keywords > 0, "画像应当产出关键词理由");
}

#[test]
fn category_inference_is_word_bounded_and_accurate_on_real_catalog() {
    for (desc, bad) in [
        ("Command line video client", "dev"),
        ("Hosted on github, a notebook app", "reading"),
        ("A client for videos", "dev"),
    ] {
        let cats = infer_categories_from_repo("", desc, "x/y");
        assert!(
            !cats.iter().any(|(c, _)| *c == bad),
            "{desc} 误判为 {bad}: {cats:?}"
        );
    }

    let catalog = real_catalog();
    let (mut with_result, mut correct, mut dev_pred) = (0usize, 0usize, 0usize);
    for it in &catalog {
        let cats =
            infer_categories_from_repo("", it.description_en.as_deref().unwrap_or(""), &it.id);
        let Some((top, _)) = cats.first() else {
            continue;
        };
        with_result += 1;
        if *top == "dev" {
            dev_pred += 1;
        }
        if *top == it.category {
            correct += 1;
        }
    }
    let dev_real = catalog.iter().filter(|c| c.category == "dev").count();
    let acc = correct as f64 / with_result.max(1) as f64;
    assert!(
        (dev_pred as f64) <= 1.35 * dev_real as f64,
        "dev 过度预测：{dev_pred} vs 真实 {dev_real}"
    );
    assert!(acc >= 0.72, "Top-1 准确率 {acc:.3}（{correct}/{with_result}）");
}

/// 页面上第一个可「少推这类」的目标：探索货架或分类精选里的首个条目。
fn first_dismiss_target(p: &FeaturedPage) -> (String, String) {
    for kind in [ShelfKind::Explore, ShelfKind::CategoryPick] {
        if let Some(shelf) = p.shelves.iter().find(|s| s.kind == kind) {
            let app = &shelf.items[0].app.core;
            return (app.category.trim().to_lowercase(), app.id.to_lowercase());
        }
    }
    panic!("页面没有探索或分类精选货架");
}

/// 整页出现过的分类：hero、每个货架的条目分类与分类精选的分类 key。
fn page_categories(p: &FeaturedPage) -> HashSet<String> {
    p.hero
        .iter()
        .chain(p.shelves.iter().flat_map(|s| s.items.iter()))
        .map(|i| i.app.core.category.trim().to_lowercase())
        .chain(p.shelves.iter().filter_map(|s| s.category.clone()))
        .collect()
}

#[test]
fn category_dismissal_closes_the_loop_in_every_state() {
    let catalog = real_catalog();
    // warm：两个画像分类，种子分类出 because_you，另一个出分类精选
    let warm = RawAffinitySignals {
        favorites: ids_in(&catalog, "graphics", 1)
            .into_iter()
            .map(|id| (id, NOW))
            .collect(),
        watched: ids_in(&catalog, "reading", 1)
            .into_iter()
            .map(|id| (id, NOW))
            .collect(),
        ..Default::default()
    };
    let cases = [
        ("off", rich_raw(&catalog), false, ProfileState::Off),
        ("cold", RawAffinitySignals::default(), true, ProfileState::Cold),
        ("warm", warm, true, ProfileState::Warm),
        ("rich", rich_raw(&catalog), true, ProfileState::Rich),
    ];
    for (name, raw, enabled, state) in cases {
        for day in [20261101u64, 20261115, 20261130] {
            let (before, _) = page(&catalog, &raw, enabled, day);
            assert_eq!(before.profile_state, state, "{name}");
            let (cat, card) = first_dismiss_target(&before);

            let mut after_raw = raw.clone();
            after_raw.feedback.extend([
                FeedFeedback {
                    target: cat.clone(),
                    scope: FeedbackScope::Category,
                    created_at: NOW,
                },
                FeedFeedback {
                    target: card.clone(),
                    scope: FeedbackScope::App,
                    created_at: NOW,
                },
            ]);
            let (after, _) = page(&catalog, &after_raw, enabled, day);
            // 其余分类充足，hero 不需要用被少推的分类补位，整页都不应再出现它
            assert!(
                !page_categories(&after).contains(&cat),
                "{name} day {day}: {cat} 仍出现在页面上"
            );
            assert!(
                !page_ids(&after).contains(&card),
                "{name} day {day}: 触发卡片 {card} 仍在页面上"
            );
        }
    }
}
