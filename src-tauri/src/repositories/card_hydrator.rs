//! 单仓富卡（`AppSummary`）批量水合深模块 `CardHydrator`。
//!
//! - 只读批量水合：短锁批量取 SQLite 行 → 锁外解析 `DeferredIcon` 磁盘确认图标 →
//!   `CatalogService::stamp_summary` 统一盖章（单仓富卡、缓存详情摘要、合集、最近浏览、开源广场图标）。
//! - 远端载荷写透：一次完成本地快照预取、非破坏合并、`repo_card_cache` 与 `app_icon_cycles`
//!   批量落库、锁外确认图标解析、目录盖章与待补探坐标筛出。

use crate::github::models::{
    is_placeholder_description, is_placeholder_license, is_placeholder_version,
};
use crate::icons::{DeferredIcon, PendingIcon, RepoCoord, ResolvedIcons};
use crate::models::{AppCore, AppSummary, HydratedRepoCard};
use crate::repositories::DetailRepository;
use crate::AppState;
use std::collections::HashMap;

// ===========================================================================
// 只读批量水合
// ===========================================================================

/// 单仓富卡批量水合（无网络）：收录项投影目录元数据，未收录项读 `repo_card_cache`
///（刷新访问时间，缺失回退 `app_details`），叠加确认图标与收录标记；与入参对齐。
pub(crate) async fn repo_cards(
    state: &AppState,
    ids: &[String],
) -> crate::AppResult<Vec<Option<HydratedRepoCard>>> {
    let (mut cards, jobs) = {
        let db = state.db()?;
        hydrate_repo_cards_deferred(&db, &state.catalog, ids, crate::now_secs())
    };
    crate::icons::resolve_and_patch_icons(
        state,
        jobs,
        cards
            .iter_mut()
            .map(|c| c.as_mut().map(|c| &mut c.summary.core)),
    )
    .await;
    Ok(cards)
}

/// 缓存详情摘要批量水合（无网络）：`app_details` → `repo_card_cache` → 收录目录回退；与入参对齐。
pub(crate) async fn cached_summaries(
    state: &AppState,
    ids: &[String],
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    let (mut rows, jobs) = {
        let db = state.db()?;
        cached_or_catalog_summaries_deferred(&db, &state.catalog, ids)
    };
    crate::icons::resolve_and_patch_icons(
        state,
        jobs,
        rows.iter_mut().map(|r| r.as_mut().map(|s| &mut s.core)),
    )
    .await;
    Ok(rows)
}

/// 合集应用批量水合（零网络）：保序去重前 30 条合法坐标，缓存回填，未知合法坐标合成最小占位卡。
pub(crate) async fn collection_apps(
    state: &AppState,
    app_ids: &[String],
) -> crate::AppResult<Vec<AppSummary>> {
    let (mut summaries, jobs) = {
        let db = state.db()?;
        resolve_collection_apps_deferred(&db, &state.catalog, app_ids, crate::now_secs())
    };
    crate::icons::resolve_and_patch_icons(
        state,
        jobs,
        summaries.iter_mut().map(|s| Some(&mut s.core)),
    )
    .await;
    Ok(summaries)
}

/// 最近浏览批量水合：收录项投影目录、未收录项回退本地详情 / 单仓富卡（无缓存即跳过），
/// 占位简介统一治愈；返回 `(摘要, 最近浏览时间)`。
pub(crate) async fn recently_viewed(
    state: &AppState,
    limit: usize,
) -> crate::AppResult<Vec<(AppSummary, i64)>> {
    let (mut rows, jobs) = {
        let db = state.db()?;
        recently_viewed_deferred(&db, &state.catalog, limit)?
    };
    crate::icons::resolve_and_patch_icons(
        state,
        jobs,
        rows.iter_mut().map(|r| Some(&mut r.0.core)),
    )
    .await;
    Ok(rows)
}

/// 空图标行的确认图标规划（DB 阶段，持锁；与入参对齐，非空图标行不解析）。
pub(crate) fn plan_blank_icons<'a>(
    db: &crate::db::Database,
    cores: impl IntoIterator<Item = &'a AppCore>,
) -> Vec<DeferredIcon> {
    let pendings: Vec<PendingIcon> = cores
        .into_iter()
        .map(|c| {
            if c.icon.trim().is_empty() {
                PendingIcon::confirmed(&c.id, &c.owner, &c.repo)
            } else {
                PendingIcon::none()
            }
        })
        .collect();
    crate::icons::plan_pending_icons(db, &pendings)
}

/// 锁外解析已规划的确认图标并叠加到对应行（调用方此时不得持有 `db` 锁）。
pub(crate) async fn overlay_planned_icons<'a>(
    state: &AppState,
    jobs: Vec<DeferredIcon>,
    cores: impl Iterator<Item = &'a mut AppCore>,
) {
    crate::icons::resolve_and_patch_icons(state, jobs, cores.map(Some)).await;
}

/// 同步叠加（图标磁盘阶段就地执行，测试入口）。
#[cfg(test)]
pub(crate) fn overlay_planned_icons_inline<'a>(
    db: &crate::db::Database,
    jobs: &[DeferredIcon],
    cores: impl Iterator<Item = &'a mut AppCore>,
) {
    let icons_dir = crate::get_app_data_dir().join("icons");
    let icons = crate::icons::materialize_icons_inline(db, &icons_dir, jobs);
    crate::icons::patch_core_icons(cores.map(Some), icons);
}

/// 最近浏览行：`(摘要, 最近浏览时间)`。
type RecentRow = (AppSummary, i64);

fn recently_viewed_deferred(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    limit: usize,
) -> crate::AppResult<(Vec<RecentRow>, Vec<DeferredIcon>)> {
    let entries = db.get_recently_viewed_entries(limit)?;
    let mut result = Vec::with_capacity(entries.len());
    let mut pendings = Vec::with_capacity(entries.len());
    for (id, viewed_at) in entries {
        let summary = if let Some(item) = catalog.get_catalog_item(&id) {
            let mut summary = catalog.item_to_stamped_summary(&item);
            heal_placeholder_summary(db, &mut summary);
            summary
        } else if let Some(mut summary) = recent_detail_summary_without_icon(db, &id) {
            catalog.stamp_summary(&mut summary);
            summary
        } else {
            continue;
        };
        pendings.push(PendingIcon::confirmed(
            &summary.core.id,
            &summary.core.owner,
            &summary.core.repo,
        ));
        result.push((summary, viewed_at));
    }
    Ok((result, crate::icons::plan_pending_icons(db, &pendings)))
}

/// 最近浏览未收录行的本地回退（叠加确认图标，测试入口）。
#[cfg(test)]
pub(crate) fn recent_detail_summary(db: &crate::db::Database, id: &str) -> Option<AppSummary> {
    let mut summary = recent_detail_summary_without_icon(db, id)?;
    let jobs = crate::icons::plan_pending_icons(
        db,
        &[PendingIcon::confirmed(
            &summary.core.id,
            &summary.core.owner,
            &summary.core.repo,
        )],
    );
    overlay_planned_icons_inline(db, &jobs, std::iter::once(&mut summary.core));
    Some(summary)
}

/// 最近浏览未收录行：按多种 id 形态顺序查 `app_details`（离线仍可读），无详情行回退单仓富卡。
fn recent_detail_summary_without_icon(db: &crate::db::Database, id: &str) -> Option<AppSummary> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut keys: Vec<String> = Vec::new();
    let mut push_unique = |k: String| {
        if !k.trim().is_empty() && !keys.contains(&k) {
            keys.push(k);
        }
    };
    push_unique(trimmed.to_string());
    if let Some(canon) = crate::forge::canonical_app_id(trimmed) {
        push_unique(canon);
    }
    push_unique(trimmed.to_lowercase());
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(trimmed) {
        if !coord.owner.is_empty() && !coord.repo.is_empty() {
            let bare = format!("{}/{}", coord.owner, coord.repo);
            push_unique(bare.clone());
            push_unique(bare.to_lowercase());
            push_unique(format!("github.com/{}", bare));
            push_unique(format!("github.com/{}", bare.to_lowercase()));
        }
    }
    for key in keys {
        if let Ok(Some(detail)) = db.get_app_detail(&key, None) {
            let mut summary = DetailRepository::detail_summary_without_icon(detail);
            heal_placeholder_summary(db, &mut summary);
            return Some(summary);
        }
    }
    let clean_id = crate::forge::canonical_app_id(trimmed)?;
    DetailRepository::repo_card_summary_without_icon(db, &clean_id)
}

/// 占位简介治愈：回填 `api_etag_cache` 仓库 JSON 的真实简介，无真值时置空（前端显示「暂无简介」）；
/// 非占位人工简介保留。
pub(crate) fn heal_placeholder_summary(db: &crate::db::Database, summary: &mut AppSummary) {
    let need_desc = is_placeholder_description(&summary.core.description);
    let need_en = summary
        .core
        .description_en
        .as_deref()
        .is_some_and(is_placeholder_description);
    if !need_desc && !need_en {
        return;
    }
    let real = crate::github::detail_fetch::repo_real_description_from_etag(
        db,
        &summary.core.owner,
        &summary.core.repo,
    );
    if need_desc {
        summary.core.description = real.clone().unwrap_or_default();
    }
    if need_en {
        summary.core.description_en = Some(real.unwrap_or_default());
    }
}

/// 批量富卡摘要（不含确认图标）+ 与之对齐的图标延迟任务：缓存行优先（叠加目录元数据并盖章）；
/// 无缓存行时回退收录目录项；两者皆无或 id 不可解析即 `None`。
fn cached_or_catalog_summaries_deferred(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    ids: &[String],
) -> (Vec<Option<AppSummary>>, Vec<crate::icons::DeferredIcon>) {
    let cached =
        crate::repositories::DetailRepository::cached_detail_summaries_without_icon(db, ids, true);
    let mut rows = Vec::with_capacity(ids.len());
    let mut pendings = Vec::with_capacity(ids.len());
    for (raw, cached) in ids.iter().zip(cached) {
        if let Some(mut summary) = cached {
            let cat_item = catalog.get_catalog_item(&summary.core.id);
            // 目录官方图标非空时 overlay 覆盖确认图标：此类行无需解析。
            let pending = if cat_item.as_ref().is_some_and(|c| !c.icon.trim().is_empty()) {
                crate::icons::PendingIcon::none()
            } else {
                crate::icons::PendingIcon::confirmed(
                    &summary.core.id,
                    &summary.core.owner,
                    &summary.core.repo,
                )
            };
            if let Some(cat_item) = cat_item {
                cat_item.overlay_detail_core(&mut summary.core);
            }
            catalog.stamp_summary(&mut summary);
            rows.push(Some(summary));
            pendings.push(pending);
            continue;
        }
        let cat_item = crate::forge::canonical_app_id(raw.trim())
            .and_then(|clean_id| catalog.get_catalog_item(&clean_id));
        match cat_item {
            Some(cat_item) => {
                rows.push(Some(catalog.item_to_stamped_summary(&cat_item)));
                pendings.push(crate::icons::PendingIcon::for_clean_id(
                    catalog,
                    &cat_item.id,
                ));
            }
            None => {
                rows.push(None);
                pendings.push(crate::icons::PendingIcon::none());
            }
        }
    }
    (rows, crate::icons::plan_pending_icons(db, &pendings))
}

/// 单 id 富卡摘要（测试入口）：图标磁盘阶段就地执行。
#[cfg(test)]
fn resolve_cached_or_catalog_summary(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    icons_dir: &std::path::Path,
    raw: &str,
) -> Option<AppSummary> {
    let (mut rows, jobs) = cached_or_catalog_summaries_deferred(db, catalog, &[raw.to_string()]);
    let icons = crate::icons::materialize_icons_inline(db, icons_dir, &jobs);
    crate::icons::patch_core_icons(
        rows.iter_mut().map(|r| r.as_mut().map(|s| &mut s.core)),
        icons,
    );
    rows.pop().flatten()
}

/// 单 id 的 DB-only 投影：`AppDetail` 子集转 `AppSummary`，无网络、无写盘。
#[cfg(test)]
fn cached_detail_summary(db: &crate::db::Database, raw_id: &str) -> Option<AppSummary> {
    crate::repositories::DetailRepository::cached_detail_summary(db, raw_id)
}

/// 同步水合（图标磁盘阶段就地执行，测试入口）。
#[cfg(test)]
pub(crate) fn hydrate_repo_cards(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    ids: &[String],
    now: i64,
) -> Vec<Option<HydratedRepoCard>> {
    let (mut cards, jobs) = hydrate_repo_cards_deferred(db, catalog, ids, now);
    let icons_dir = crate::get_app_data_dir().join("icons");
    let icons = crate::icons::materialize_icons_inline(db, &icons_dir, &jobs);
    crate::icons::patch_core_icons(
        cards
            .iter_mut()
            .map(|c| c.as_mut().map(|c| &mut c.summary.core)),
        icons,
    );
    cards
}

/// 水合 DB 阶段（持锁）：`repo_card_cache`、`app_details`、`app_icon_cycles` 各一次分片查询，
/// 返回不含确认图标的卡片与对齐的图标延迟任务。
fn hydrate_repo_cards_deferred(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    ids: &[String],
    now: i64,
) -> (
    Vec<Option<HydratedRepoCard>>,
    Vec<crate::icons::DeferredIcon>,
) {
    let canonical: Vec<Option<String>> = ids
        .iter()
        .map(|raw| crate::forge::canonical_app_id(raw))
        .collect();
    let uncataloged: Vec<String> = canonical
        .iter()
        .flatten()
        .filter(|id| !catalog.is_cataloged(id))
        .cloned()
        .collect();
    let cards = db
        .get_repo_cards_batch_and_touch(&uncataloged, now)
        .unwrap_or_default();
    let missing: Vec<String> = uncataloged
        .iter()
        .filter(|id| !cards.contains_key(*id))
        .cloned()
        .collect();
    let details: HashMap<String, AppSummary> =
        crate::repositories::DetailRepository::cached_detail_summaries_without_icon(
            db, &missing, false,
        )
        .into_iter()
        .zip(missing.iter())
        .filter_map(|(summary, id)| summary.map(|s| (id.clone(), s)))
        .collect();
    let mut pendings = Vec::with_capacity(canonical.len());
    let out: Vec<Option<HydratedRepoCard>> = canonical
        .into_iter()
        .map(|id| {
            let Some(id) = id else {
                pendings.push(crate::icons::PendingIcon::none());
                return None;
            };
            if let Some(cat_item) = catalog.get_catalog_item(&id) {
                pendings.push(crate::icons::PendingIcon::for_clean_id(catalog, &id));
                return Some(HydratedRepoCard {
                    summary: catalog.item_to_stamped_summary(&cat_item),
                    confirmed_other: false,
                    is_private: false,
                    updated_at: now,
                });
            }
            let hydrated = match cards.get(&id) {
                Some(card) => Some(HydratedRepoCard {
                    summary: card.summary.clone(),
                    confirmed_other: card.confirmed_other,
                    is_private: card.is_private,
                    updated_at: card.updated_at,
                }),
                None => details.get(&id).map(|summary| HydratedRepoCard {
                    summary: summary.clone(),
                    confirmed_other: false,
                    is_private: false,
                    updated_at: 0,
                }),
            };
            let Some(mut hydrated) = hydrated else {
                pendings.push(crate::icons::PendingIcon::none());
                return None;
            };
            let core = &hydrated.summary.core;
            pendings.push(crate::icons::PendingIcon::confirmed(
                &core.id,
                &core.owner,
                &core.repo,
            ));
            catalog.stamp_summary(&mut hydrated.summary);
            Some(hydrated)
        })
        .collect();
    (out, crate::icons::plan_pending_icons(db, &pendings))
}

/// 合成合法仓库坐标的最小占位 `AppSummary`（全本地零网络，用于冷门未收录合集条目）。
fn placeholder_collection_summary(clean_id: &str) -> Option<AppSummary> {
    let coord = crate::forge::RepositoryUrlParser::parse(clean_id)?;
    Some(AppSummary {
        core: AppCore {
            id: clean_id.to_string(),
            name: coord.repo.clone(),
            description_en: None,
            owner: coord.owner,
            repo: coord.repo,
            icon: String::new(),
            icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
            description: String::new(),
            stars: 0,
            forks: 0,
            license: String::new(),
            latest_version: "latest".to_string(),
            category: "external".to_string(),
            category_name: "跨平台开源".to_string(),
            is_verified: false,
            forge: Some(coord.forge.as_str().to_string()),
            forge_host: Some(coord.host),
            homepage: None,
            platforms: Vec::new(),
            is_cataloged: Some(false),
            source: None,
            status: None,
            added_at: None,
            alternatives: Vec::new(),
        },
    })
}

/// 批量本地水合合集应用列表（DB 阶段，持锁）：
/// 归一化并去重前 `MAX_COLLECTION_APPS` 条合法坐标，优先合并目录，其次 `repo_card_cache` /
/// `app_details` 本地缓存，均未命中则合成最小占位卡片并规划确认图标延迟任务。
fn resolve_collection_apps_deferred(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    app_ids: &[String],
    now: i64,
) -> (Vec<AppSummary>, Vec<crate::icons::DeferredIcon>) {
    let clean_ids =
        crate::deeplink::normalize_collection_app_ids(app_ids.iter().map(String::as_str));
    if clean_ids.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let (hydrated, mut jobs) = hydrate_repo_cards_deferred(db, catalog, &clean_ids, now);
    let mut summaries: Vec<Option<AppSummary>> = Vec::with_capacity(clean_ids.len());
    let mut missing_indices: Vec<usize> = Vec::new();
    let mut missing_pendings: Vec<crate::icons::PendingIcon> = Vec::new();

    for (idx, (clean_id, card_opt)) in clean_ids.iter().zip(hydrated).enumerate() {
        if let Some(card) = card_opt {
            summaries.push(Some(card.summary));
            continue;
        }
        if let Some(mut placeholder) = placeholder_collection_summary(clean_id) {
            catalog.stamp_summary(&mut placeholder);
            missing_indices.push(idx);
            missing_pendings.push(crate::icons::PendingIcon::confirmed(
                &placeholder.core.id,
                &placeholder.core.owner,
                &placeholder.core.repo,
            ));
            summaries.push(Some(placeholder));
        } else {
            summaries.push(None);
        }
    }

    if !missing_pendings.is_empty() {
        let missing_jobs = crate::icons::plan_pending_icons(db, &missing_pendings);
        for (idx, job) in missing_indices.into_iter().zip(missing_jobs) {
            if let Some(slot) = jobs.get_mut(idx) {
                *slot = job;
            }
        }
    }

    let mut out_summaries = Vec::with_capacity(summaries.len());
    let mut out_jobs = Vec::with_capacity(jobs.len());
    for (summary_opt, job) in summaries.into_iter().zip(jobs) {
        if let Some(summary) = summary_opt {
            out_summaries.push(summary);
            out_jobs.push(job);
        }
    }
    (out_summaries, out_jobs)
}

/// 同步水合合集应用列表（图标磁盘阶段就地执行，测试入口）。
#[cfg(test)]
pub(crate) fn resolve_collection_apps_sync(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    app_ids: &[String],
    now: i64,
) -> Vec<AppSummary> {
    let (mut summaries, jobs) = resolve_collection_apps_deferred(db, catalog, app_ids, now);
    let icons_dir = crate::get_app_data_dir().join("icons");
    let icons = crate::icons::materialize_icons_inline(db, &icons_dir, &jobs);
    crate::icons::patch_core_icons(summaries.iter_mut().map(|s| Some(&mut s.core)), icons);
    summaries
}

// ===========================================================================
// 写透内部：本地快照预取与非破坏回填
// ===========================================================================

/// `api_etag_cache` 仓库载荷软 TTL（12 小时，对齐趋势 L2 周期）：未满 12h 零网络秒返，
/// 满 12h 后进入条件请求发 `If-None-Match`（`304` 零配额 `touch_etag` 续期）。
pub(crate) const ENRICH_ETAG_SOFT_TTL_SECS: i64 = 12 * 3600;

/// 一批行的本地水合快照：已解析确认图标 + `app_icon_cycles` + `repo_card_cache` + `app_details` 摘要
/// + `api_etag_cache`。加载阶段每表常数次分片查询；回填计算阶段零 SQL、零磁盘。
#[derive(Default)]
pub(crate) struct BackfillCtx {
    cycles: crate::icons::IconCycleIndex,
    icons: crate::icons::ResolvedIcons,
    cards: HashMap<String, crate::db::RepoCardSnapshot>,
    details: HashMap<String, crate::models::AppDetail>,
    etags: HashMap<String, crate::db::etag::EtagCacheEntry>,
}

/// `BackfillCtx` 的预读键集合。
#[derive(Default)]
pub(crate) struct PrefetchKeys {
    coords: Vec<crate::icons::IconCoord>,
    ids: Vec<String>,
    urls: Vec<String>,
}

impl PrefetchKeys {
    /// 行自身：确认图标坐标、单仓富卡 / 详情 id 与 `releases/latest` 载荷端点。
    fn add_item(&mut self, item: &AppSummary) {
        let c = &item.core;
        self.coords
            .push(crate::icons::IconCoord::new(&c.id, &c.owner, &c.repo));
        self.ids.push(c.id.clone());
        if let Some((exact, lower)) = release_latest_urls(item) {
            self.urls.push(exact);
            self.urls.push(lower);
        }
    }

    /// 命中收录库的行：收录投影后的确认图标坐标。
    fn add_curated(&mut self, catalog: &crate::github::CatalogService, item: &AppSummary) {
        if let Some(cat) = catalog.get_catalog_item(&item.core.id) {
            self.coords
                .push(crate::icons::IconCoord::new(cat.id, cat.owner, cat.repo));
        }
    }

    /// 仓库坐标：确认图标、单仓富卡 / 详情 id；`with_endpoint` 时含 `/repos/{o}/{r}` 端点。
    fn add_coord(&mut self, coord: &crate::icons::RepoCoord, with_endpoint: bool) {
        self.coords.push(crate::icons::IconCoord::new(
            &coord.id,
            &coord.owner,
            &coord.repo,
        ));
        self.ids.push(coord.id.clone());
        if with_endpoint {
            self.urls.push(crate::github::github_repo_endpoint(
                &coord.owner,
                &coord.repo,
            ));
        }
    }
}

/// `releases/latest` 端点的原大小写与小写形态（非 GitHub 源或坐标缺失为 `None`）。
fn release_latest_urls(item: &AppSummary) -> Option<(String, String)> {
    let is_github = item
        .core
        .forge
        .as_deref()
        .unwrap_or("github")
        .eq_ignore_ascii_case("github");
    let owner = item.core.owner.trim();
    let repo = item.core.repo.trim();
    if !is_github || owner.is_empty() || repo.is_empty() {
        return None;
    }
    let exact = crate::github::github_latest_release_endpoint(owner, repo);
    let lower =
        crate::github::github_latest_release_endpoint(&owner.to_lowercase(), &repo.to_lowercase());
    Some((exact, lower))
}

impl BackfillCtx {
    /// DB 阶段（持锁）：批量读各表并产出确认图标解析计划（`known` 中已解析的坐标不再规划）。
    fn load(
        db: &crate::db::Database,
        keys: &PrefetchKeys,
        known: Option<&crate::icons::ResolvedIcons>,
    ) -> (Self, crate::icons::IconPlanBatch) {
        let cycles = crate::icons::IconCycleIndex::load(db, &keys.coords);
        let batch = crate::icons::IconPlanBatch::new(&cycles, &keys.coords, known);
        let ctx = Self {
            cards: db
                .get_repo_card_snapshots_batch(&keys.ids)
                .unwrap_or_default(),
            details: db
                .get_app_detail_summaries_batch(&keys.ids, false)
                .unwrap_or_default(),
            etags: db.get_etag_entries_batch(&keys.urls).unwrap_or_default(),
            icons: known.cloned().unwrap_or_default(),
            cycles,
        };
        (ctx, batch)
    }

    /// 持锁调用方的同步版本：图标磁盘阶段就地执行（测试入口）。
    #[cfg(test)]
    pub(crate) fn load_inline(
        db: &crate::db::Database,
        keys: &PrefetchKeys,
        known: Option<&crate::icons::ResolvedIcons>,
    ) -> Self {
        let (mut ctx, batch) = Self::load(db, keys, known);
        let icons = batch.resolve_inline(db, &crate::get_app_data_dir().join("icons"));
        ctx.icons.extend(icons);
        ctx
    }

    /// 已解析确认图标（`None`：无确认图标）。
    fn confirmed_icon(&self, app_id: &str, owner: &str, repo: &str) -> Option<String> {
        self.icons
            .get(&crate::icons::IconCoord::new(app_id, owner, repo))
    }

    fn card(&self, raw_id: &str) -> Option<&crate::db::RepoCardSnapshot> {
        crate::forge::canonical_app_id(raw_id).and_then(|id| self.cards.get(&id))
    }

    fn detail(&self, app_id: &str) -> Option<&crate::models::AppDetail> {
        self.details.get(app_id.trim())
    }

    fn etag(&self, url: &str) -> Option<String> {
        self.etags
            .get(url)
            .map(|e| e.etag.trim())
            .filter(|e| !e.is_empty())
            .map(str::to_string)
    }

    fn payload(&self, url: &str) -> Option<String> {
        self.etags.get(url).map(|e| e.payload_json.clone())
    }

    /// 仅当 `api_etag_cache` 条目存在且在 `max_age_secs` 软 TTL 窗口内时返回载荷。
    fn fresh_etag_payload(&self, url: &str, now: i64, max_age_secs: i64) -> Option<String> {
        let entry = self.etags.get(url)?;
        if now >= entry.last_checked_at && now.saturating_sub(entry.last_checked_at) < max_age_secs
        {
            Some(entry.payload_json.clone())
        } else {
            None
        }
    }

    /// 抽取 `api_etag_cache` 条件请求参数 `(cached_etag, cached_payload, soft_fresh_payload)`。
    fn enrich_etag_inputs(
        &self,
        repo_url: &str,
        now: i64,
        is_force: bool,
    ) -> (Option<String>, Option<String>, Option<String>) {
        let cached_payload = self.payload(repo_url);
        if is_force {
            (None, cached_payload, None)
        } else {
            (
                self.etag(repo_url),
                cached_payload,
                self.fresh_etag_payload(repo_url, now, ENRICH_ETAG_SOFT_TTL_SECS),
            )
        }
    }
}

/// 异步三段预读：短锁批量读表（`before_load` 在同一临界区内先执行，如落库新 ETag）→
/// 释放锁后在阻塞线程池读图标文件并编码 → 仅有自愈认领时再取短锁回写 `cache_file`。
async fn prefetch_backfill(
    state: &AppState,
    keys: &PrefetchKeys,
    known: Option<&crate::icons::ResolvedIcons>,
    before_load: impl FnOnce(&crate::db::Database),
) -> BackfillCtx {
    let loaded = match state.db() {
        Ok(db) => {
            before_load(&db);
            Some(BackfillCtx::load(&db, keys, known))
        }
        Err(_) => None,
    };
    let Some((mut ctx, batch)) = loaded else {
        return BackfillCtx::default();
    };
    let icons = batch.resolve_offloaded(state).await;
    ctx.icons.extend(icons);
    ctx
}

/// 从本地快照回填未收录卡片（图标、单仓富卡派生缓存、详情缓存与 Release 载荷）；需写入时返回待落库的 `AppIconCycle`。
fn backfill_uncataloged_card_in(
    ctx: &BackfillCtx,
    item: &mut AppSummary,
) -> Option<crate::db::AppIconCycle> {
    let staged =
        if let Some(ci) = ctx.confirmed_icon(&item.core.id, &item.core.owner, &item.core.repo) {
            item.core.icon = ci;
            None
        } else if !item.core.icon.trim().is_empty() {
            // 合并首屏图标到对应槽位，保留已有槽位与 pinned 选择。
            let icon = item.core.icon.trim().to_string();
            let level = crate::icons::level_for_detail_icon(&icon);
            let mut cycle = ctx.cycles.exact(&item.core.id).cloned().unwrap_or_else(|| {
                crate::db::AppIconCycle::new(&item.core.id, &item.core.owner, &item.core.repo)
            });
            crate::icons::merge_detail_icon(&mut cycle, level, &icon, false, crate::now_secs());
            Some(cycle)
        } else {
            None
        };
    backfill_from_repo_card(ctx, item);
    if let Some(cached) = ctx.detail(&item.core.id) {
        crate::github::CatalogService::apply_detail_to_summary_core(&mut item.core, cached);
    }
    backfill_release_from_etag_cache(ctx, item);
    staged
}

/// 单条回填（测试入口）：就地加载该行快照后回填。
#[cfg(test)]
fn backfill_uncataloged_card(
    db: &crate::db::Database,
    item: &mut AppSummary,
) -> Option<crate::db::AppIconCycle> {
    let mut keys = PrefetchKeys::default();
    keys.add_item(item);
    let ctx = BackfillCtx::load_inline(db, &keys, None);
    backfill_uncataloged_card_in(&ctx, item)
}

/// 零网络单仓富卡回填：只补入站行的空缺或占位字段（平台、真实版本、简介、协议、主页、远端图标）；
/// 平台与版本含 `get_platforms_lite` 预写的平台壳。平台态与完整卡片取自同一行快照。
fn backfill_from_repo_card(ctx: &BackfillCtx, item: &mut AppSummary) {
    let core = &mut item.core;
    let Some(snap) = ctx.card(&core.id) else {
        return;
    };
    let state = &snap.platform;
    if core.platforms.is_empty() && !state.platforms.is_empty() {
        core.platforms = state.platforms.clone();
    }
    if is_placeholder_version(&core.latest_version)
        && !is_placeholder_version(&state.latest_version)
    {
        core.latest_version = state.latest_version.clone();
    }
    let Some(card) = &snap.card else {
        return;
    };
    let c = &card.summary.core;
    if is_placeholder_description(&core.description) && !c.description.trim().is_empty() {
        core.description = c.description.clone();
    }
    if core
        .description_en
        .as_deref()
        .is_none_or(is_placeholder_description)
        && c.description_en.is_some()
    {
        core.description_en = c.description_en.clone();
    }
    if is_placeholder_license(&core.license) && !c.license.trim().is_empty() {
        core.license = c.license.clone();
    }
    if core.homepage.as_deref().is_none_or(|h| h.trim().is_empty()) && c.homepage.is_some() {
        core.homepage = c.homepage.clone();
    }
    if core.icon.trim().is_empty() && !c.icon.trim().is_empty() {
        core.icon = c.icon.clone();
    }
}

/// 回填后仍无平台且 `repo_card_cache` 已确认无可安装资产。
fn repo_card_confirmed_other(ctx: &BackfillCtx, item: &AppSummary) -> bool {
    item.core.platforms.is_empty()
        && ctx
            .card(&item.core.id)
            .is_some_and(|s| s.platform.confirmed_other)
}

/// 未收录行写入 `repo_card_cache` 的待写条目（已收录返回 `None`）。
fn stage_repo_card(
    catalog: &crate::github::CatalogService,
    item: &AppSummary,
    confirmed_other: bool,
    is_private: Option<bool>,
) -> Option<crate::db::RepoCardUpsert> {
    if catalog.is_cataloged(&item.core.id) {
        return None;
    }
    Some(crate::db::RepoCardUpsert {
        summary: item.clone(),
        confirmed_other,
        is_private,
    })
}

/// 待写条目均经 `stage_repo_card` 按内存目录过滤，DAO 跳过已收录查表。
fn flush_repo_cards(db: &crate::db::Database, staged: &[crate::db::RepoCardUpsert]) {
    if !staged.is_empty() {
        let _ = db.upsert_uncataloged_repo_cards_batch(staged);
    }
}

/// 从 `api_etag_cache` 中的 `releases/latest` 载荷回填缺失的平台与版本号。
fn backfill_release_from_etag_cache(ctx: &BackfillCtx, item: &mut AppSummary) {
    let need_platforms = item.core.platforms.is_empty();
    let need_version = is_placeholder_version(&item.core.latest_version);
    if !need_platforms && !need_version {
        return;
    }
    let Some((exact, lower)) = release_latest_urls(item) else {
        return;
    };
    let payload = ctx.payload(&exact).or_else(|| {
        if lower == exact {
            None
        } else {
            ctx.payload(&lower)
        }
    });
    let Some(payload) = payload else {
        return;
    };
    let Ok(release) =
        serde_json::from_str::<crate::github::models::GitHubReleaseResponse>(&payload)
    else {
        return;
    };
    if need_platforms {
        let platforms =
            crate::github::detail_assets::lite_platforms_for_github_assets(&release.assets, None);
        if !platforms.is_empty() {
            item.core.platforms = platforms;
        }
    }
    if need_version && !release.tag_name.trim().is_empty() {
        item.core.latest_version = release.tag_name.trim().to_string();
    }
}

/// 搜索命中收录库时投影精选元数据（中文简介、官方图标、分类、预置平台），保留更新的远端 Star/Fork；
/// 用户轮换过的确认图标优先。返回是否已投影（已投影行不走未收录回填）。
fn project_curated_hit_in(
    ctx: &BackfillCtx,
    catalog: &crate::github::CatalogService,
    item: &mut AppSummary,
) -> bool {
    let Some(cat_item) = catalog.get_catalog_item(&item.core.id) else {
        return false;
    };
    let stars = item.core.stars.max(cat_item.stars);
    let forks = item.core.forks.max(cat_item.forks);
    let mut projected = catalog.item_to_stamped_summary(&cat_item);
    projected.core.stars = stars;
    projected.core.forks = forks;
    if let Some(ci) = ctx.confirmed_icon(
        &projected.core.id,
        &projected.core.owner,
        &projected.core.repo,
    ) {
        projected.core.icon = ci;
    }
    *item = projected;
    true
}

#[cfg(test)]
fn project_curated_hit(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    item: &mut AppSummary,
) -> bool {
    let mut keys = PrefetchKeys::default();
    keys.add_curated(catalog, item);
    let ctx = BackfillCtx::load_inline(db, &keys, None);
    project_curated_hit_in(&ctx, catalog, item)
}

/// 批量写入待更新的 `AppIconCycle`（批量事务失败时回退逐条写入）。
fn flush_icon_cycle_staged(db: &crate::db::Database, staged: &[crate::db::AppIconCycle]) {
    if staged.is_empty() {
        return;
    }
    if db.upsert_icon_cycles_batch(staged).is_err() {
        for c in staged {
            let _ = db.upsert_icon_cycle(c);
        }
    }
}

/// 本地富卡命中来源（决定命中后是否回写 `repo_card_cache`：单仓富卡自身命中不刷新新鲜度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalHitSource {
    Catalog,
    RepoCard,
    Detail,
    Payload,
}

/// 趋势 enrich 本地缓存优先解析（零网络，测试入口：就地加载该坐标快照）。
#[cfg(test)]
pub(crate) fn resolve_local_enrich_hit(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    coord: &crate::icons::RepoCoord,
    pre_icon: Option<&str>,
    cached_payload: Option<&str>,
) -> Option<AppSummary> {
    resolve_local_enrich_hit_sourced(db, catalog, coord, pre_icon, cached_payload, true)
        .map(|(summary, _)| summary)
}

#[cfg(test)]
pub(crate) fn resolve_local_enrich_hit_sourced(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    coord: &crate::icons::RepoCoord,
    pre_icon: Option<&str>,
    cached_payload: Option<&str>,
    use_repo_card: bool,
) -> Option<(AppSummary, LocalHitSource)> {
    let mut keys = PrefetchKeys::default();
    keys.add_coord(coord, false);
    let ctx = BackfillCtx::load_inline(db, &keys, None);
    resolve_local_enrich_hit_in(
        &ctx,
        catalog,
        coord,
        pre_icon,
        cached_payload,
        use_repo_card,
    )
}

/// 按优先级从本地快照解析卡片：目录 → 新鲜 `repo_card_cache` → 详情缓存 → 仓库 JSON 载荷。
/// `use_repo_card = false` 时跳过 `repo_card_cache`（优先消费本次载荷）。
fn resolve_local_enrich_hit_in(
    ctx: &BackfillCtx,
    catalog: &crate::github::CatalogService,
    coord: &crate::icons::RepoCoord,
    pre_icon: Option<&str>,
    cached_payload: Option<&str>,
    use_repo_card: bool,
) -> Option<(AppSummary, LocalHitSource)> {
    let pre_icon = pre_icon.filter(|s| !s.trim().is_empty());
    if let Some(cat_item) = catalog.get_catalog_item(&coord.id) {
        let mut summary = catalog.item_to_stamped_summary(&cat_item);
        if let Some(ci) = pre_icon {
            summary.core.icon = ci.to_string();
        }
        return Some((summary, LocalHitSource::Catalog));
    }
    if use_repo_card {
        if let Some(card) = ctx.card(&coord.id).and_then(|s| s.card.as_ref()) {
            let age = crate::now_secs().saturating_sub(card.updated_at);
            if (0..crate::db::REPO_CARD_FRESH_TTL_SECS).contains(&age) {
                let mut summary = card.summary.clone();
                if let Some(ci) = pre_icon {
                    summary.core.icon = ci.to_string();
                }
                return Some((summary, LocalHitSource::RepoCard));
            }
        }
    }
    let detail = ctx.detail(&coord.id);
    if let Some(detail) = detail {
        let desc_ok = !detail.core.description.trim().is_empty()
            && !crate::github::models::is_placeholder_description(&detail.core.description);
        if desc_ok {
            let mut core = detail.core.clone();
            if let Some(ci) = pre_icon {
                core.icon = ci.to_string();
            } else if core.icon.trim().starts_with("data:") {
                core.icon.clear();
            }
            return Some((AppSummary { core }, LocalHitSource::Detail));
        }
    }
    if let Some(payload_json) = cached_payload {
        if let Ok(mut summary) = crate::github::CatalogService::parse_summary_from_repo_json(
            &coord.owner,
            &coord.repo,
            payload_json,
            pre_icon.map(|s| s.to_string()),
        ) {
            if let Some(detail) = detail {
                crate::github::CatalogService::apply_detail_to_summary_core(
                    &mut summary.core,
                    detail,
                );
            }
            return Some((summary, LocalHitSource::Payload));
        }
    }
    None
}

// ===========================================================================
// 远端载荷写透
// ===========================================================================

/// 写透行的 `repo_card_cache` 落库策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CardWrite {
    /// 不刷新单仓富卡新鲜度（富卡自身命中、失败回退或 stale 载荷）。
    Skip,
    /// 写回单仓富卡（已收录行自动跳过）；`is_private` 为 `None` 时保留库内原值。
    Upsert { is_private: Option<bool> },
}

/// 一条远端组装好的卡片及其写透策略。
pub(crate) struct RemoteRow {
    pub summary: AppSummary,
    pub card: CardWrite,
    /// 命中收录库时投影精选元数据（投影行不走未收录回填）。
    pub project_curated: bool,
}

/// 写透后的卡片（已回填、落库并盖章）。
pub(crate) struct HydratedRow {
    pub summary: AppSummary,
    /// 回填后仍无平台且 `repo_card_cache` 已确认无可安装资产（投影收录行恒 `false`）。
    pub confirmed_other: bool,
    /// 回填前已有确认图标（投影收录行恒 `true`）。
    pub had_confirmed_icon: bool,
    /// `repo_card_cache` 已有完整卡片时的私有标记。
    pub cached_private: bool,
}

impl HydratedRow {
    /// 未收录、非 SimpleIcons 且回填前无确认图标：需后台补探。
    pub(crate) fn needs_icon_probe(&self, catalog: &crate::github::CatalogService) -> bool {
        !catalog.is_cataloged(&self.summary.core.id)
            && !self.summary.core.icon.contains("simpleicons.org")
            && !self.had_confirmed_icon
    }

    /// 补探坐标（`id` 归一小写）。
    pub(crate) fn icon_coord(&self) -> RepoCoord {
        let core = &self.summary.core;
        RepoCoord {
            id: core.id.to_lowercase(),
            owner: core.owner.clone(),
            repo: core.repo.clone(),
        }
    }
}

fn keys_for_rows(catalog: &crate::github::CatalogService, rows: &[RemoteRow]) -> PrefetchKeys {
    let mut keys = PrefetchKeys::default();
    for row in rows {
        keys.add_item(&row.summary);
        if row.project_curated {
            keys.add_curated(catalog, &row.summary);
        }
    }
    keys
}

/// 纯内存回填阶段（零 SQL、零磁盘）：返回写透行与待落库的图标轮换、单仓富卡。
fn hydrate_rows(
    ctx: &BackfillCtx,
    catalog: &crate::github::CatalogService,
    rows: Vec<RemoteRow>,
) -> (
    Vec<HydratedRow>,
    Vec<crate::db::AppIconCycle>,
    Vec<crate::db::RepoCardUpsert>,
) {
    let mut out = Vec::with_capacity(rows.len());
    let mut cycles = Vec::new();
    let mut cards = Vec::new();
    for RemoteRow {
        mut summary,
        card,
        project_curated,
    } in rows
    {
        if project_curated && project_curated_hit_in(ctx, catalog, &mut summary) {
            catalog.stamp_summary(&mut summary);
            out.push(HydratedRow {
                summary,
                confirmed_other: false,
                had_confirmed_icon: true,
                cached_private: false,
            });
            continue;
        }
        let core = &summary.core;
        let had_confirmed_icon = ctx
            .confirmed_icon(&core.id, &core.owner, &core.repo)
            .is_some();
        if let Some(cycle) = backfill_uncataloged_card_in(ctx, &mut summary) {
            cycles.push(cycle);
        }
        let confirmed_other = repo_card_confirmed_other(ctx, &summary);
        let cached_private = ctx
            .card(&summary.core.id)
            .and_then(|s| s.card.as_ref())
            .is_some_and(|c| c.is_private);
        if let CardWrite::Upsert { is_private } = card {
            cards.extend(stage_repo_card(
                catalog,
                &summary,
                confirmed_other,
                is_private,
            ));
        }
        catalog.stamp_summary(&mut summary);
        out.push(HydratedRow {
            summary,
            confirmed_other,
            had_confirmed_icon,
            cached_private,
        });
    }
    (out, cycles, cards)
}

fn flush_staged(
    db: &crate::db::Database,
    cycles: &[crate::db::AppIconCycle],
    cards: &[crate::db::RepoCardUpsert],
) {
    flush_icon_cycle_staged(db, cycles);
    flush_repo_cards(db, cards);
}

/// 远端卡片写透：短锁批量预取（`before_load` 在同一临界区先执行，如落库新 ETag）→
/// 锁外解析确认图标（`known` 已解析的坐标不再读盘）→ 纯内存非破坏回填 → 短锁批量落库 → 盖章。
pub(crate) async fn write_through(
    state: &AppState,
    rows: Vec<RemoteRow>,
    known: Option<&ResolvedIcons>,
    before_load: impl FnOnce(&crate::db::Database),
) -> Vec<HydratedRow> {
    let keys = keys_for_rows(&state.catalog, &rows);
    let ctx = prefetch_backfill(state, &keys, known, before_load).await;
    let (out, cycles, cards) = hydrate_rows(&ctx, &state.catalog, rows);
    if !cycles.is_empty() || !cards.is_empty() {
        if let Ok(db) = state.db() {
            flush_staged(&db, &cycles, &cards);
        }
    }
    out
}

/// 同步写透（图标磁盘阶段就地执行，测试入口）。
#[cfg(test)]
pub(crate) fn write_through_inline(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    rows: Vec<RemoteRow>,
    known: Option<&ResolvedIcons>,
) -> Vec<HydratedRow> {
    let keys = keys_for_rows(catalog, &rows);
    let ctx = BackfillCtx::load_inline(db, &keys, known);
    let (out, cycles, cards) = hydrate_rows(&ctx, catalog, rows);
    flush_staged(db, &cycles, &cards);
    out
}

/// 远端请求前的本地快照：确认图标、单仓富卡、详情缓存与仓库 ETag 条目。
pub(crate) struct RemoteSnapshot(BackfillCtx);

/// 远端请求前短锁批量预取坐标快照（`with_endpoint` 时含 `/repos/{o}/{r}` ETag 条目），锁外解析确认图标。
pub(crate) async fn preload(
    state: &AppState,
    coords: &[RepoCoord],
    with_endpoint: bool,
    before_load: impl FnOnce(&crate::db::Database),
) -> RemoteSnapshot {
    let mut keys = PrefetchKeys::default();
    for coord in coords {
        keys.add_coord(coord, with_endpoint);
    }
    RemoteSnapshot(prefetch_backfill(state, &keys, None, before_load).await)
}

impl RemoteSnapshot {
    /// 已解析确认图标（`None`：无确认图标）。
    pub(crate) fn confirmed_icon(&self, coord: &RepoCoord) -> Option<String> {
        self.0.confirmed_icon(&coord.id, &coord.owner, &coord.repo)
    }

    /// 已解析的确认图标集合（供写透阶段跳过重复读盘）。
    pub(crate) fn icons(&self) -> &ResolvedIcons {
        &self.0.icons
    }

    /// 仓库 `/repos/{o}/{r}` 条件请求参数 `(cached_etag, cached_payload, soft_fresh_payload)`。
    pub(crate) fn etag_inputs(
        &self,
        coord: &RepoCoord,
        now: i64,
        is_force: bool,
    ) -> (Option<String>, Option<String>, Option<String>) {
        let repo_url = crate::github::github_repo_endpoint(&coord.owner, &coord.repo);
        self.0.enrich_etag_inputs(&repo_url, now, is_force)
    }

    /// 零网络本地命中：目录 → 新鲜 `repo_card_cache` → 详情缓存 → 仓库 JSON 载荷。
    pub(crate) fn local_hit(
        &self,
        catalog: &crate::github::CatalogService,
        coord: &RepoCoord,
        pre_icon: Option<&str>,
        cached_payload: Option<&str>,
        use_repo_card: bool,
    ) -> Option<(AppSummary, LocalHitSource)> {
        resolve_local_enrich_hit_in(
            &self.0,
            catalog,
            coord,
            pre_icon,
            cached_payload,
            use_repo_card,
        )
    }

    /// 远端失败时的详情缓存回退卡片：确认图标优先，`data:` 详情图标置空。
    pub(crate) fn detail_fallback(
        &self,
        coord: &RepoCoord,
        pre_icon: Option<&str>,
    ) -> Option<AppSummary> {
        self.0.detail(&coord.id).map(|detail| {
            let mut core = detail.core.clone();
            match pre_icon {
                Some(ci) => {
                    if !ci.trim().is_empty() {
                        core.icon = ci.to_string();
                    }
                }
                None => {
                    if core.icon.trim().starts_with("data:") {
                        core.icon.clear();
                    }
                }
            }
            AppSummary { core }
        })
    }
}

/// 单坐标确认图标：短锁读 `app_icon_cycles`，锁外读图标文件。
pub(crate) async fn confirmed_icon(state: &AppState, coord: &RepoCoord) -> Option<String> {
    preload(state, std::slice::from_ref(coord), false, |_| {})
        .await
        .confirmed_icon(coord)
}

/// 未收录行直接写入 `repo_card_cache`（不回填，已收录返回 `false`）。
pub(crate) fn upsert_repo_card(
    state: &AppState,
    item: &AppSummary,
    confirmed_other: bool,
    is_private: Option<bool>,
) -> bool {
    let Some(up) = stage_repo_card(&state.catalog, item, confirmed_other, is_private) else {
        return false;
    };
    if let Ok(db) = state.db() {
        flush_repo_cards(&db, std::slice::from_ref(&up));
    }
    true
}

/// Star 列表单页组卡结果。
pub(crate) struct StarredCards {
    pub rows: Vec<AppSummary>,
    /// 无确认图标、需后台补图的坐标。
    pub need_icon: Vec<RepoCoord>,
    /// `repo_card_cache` 已确认无可安装资产的未收录行规范 id。
    pub confirmed_other_ids: Vec<String>,
    /// 私有仓库规范 id。
    pub private_ids: Vec<String>,
}

/// 组卡元数据：补探坐标、私有标记与预取阶段是否已有确认图标。
struct StarredMeta {
    coord: RepoCoord,
    is_private: bool,
    had_pre_icon: bool,
}

fn starred_rows(
    pre: &BackfillCtx,
    catalog: &crate::github::CatalogService,
    items: Vec<crate::github::developer_starred::StarredRepoPayload>,
    persist: bool,
) -> (Vec<RemoteRow>, Vec<StarredMeta>) {
    let mut rows = Vec::with_capacity(items.len());
    let mut metas = Vec::with_capacity(items.len());
    for item in items {
        let pre_icon = pre.confirmed_icon(&item.coord.id, &item.coord.owner, &item.coord.repo);
        let Some((summary, _)) = resolve_local_enrich_hit_in(
            pre,
            catalog,
            &item.coord,
            pre_icon.as_deref(),
            Some(&item.payload),
            false,
        ) else {
            continue;
        };
        rows.push(RemoteRow {
            summary,
            card: if persist {
                CardWrite::Upsert {
                    is_private: Some(item.is_private),
                }
            } else {
                CardWrite::Skip
            },
            project_curated: false,
        });
        metas.push(StarredMeta {
            coord: item.coord,
            is_private: item.is_private,
            had_pre_icon: pre_icon.is_some(),
        });
    }
    (rows, metas)
}

fn assemble_starred(
    catalog: &crate::github::CatalogService,
    hydrated: Vec<HydratedRow>,
    metas: Vec<StarredMeta>,
) -> StarredCards {
    let mut out = StarredCards {
        rows: Vec::with_capacity(hydrated.len()),
        need_icon: Vec::new(),
        confirmed_other_ids: Vec::new(),
        private_ids: Vec::new(),
    };
    for (row, meta) in hydrated.into_iter().zip(metas) {
        let cataloged = catalog.is_cataloged(&row.summary.core.id);
        if !cataloged {
            let id = row.summary.core.id.to_lowercase();
            if row.confirmed_other {
                out.confirmed_other_ids.push(id.clone());
            }
            if meta.is_private {
                out.private_ids.push(id);
            }
            if !row.summary.core.icon.contains("simpleicons.org") && !meta.had_pre_icon {
                out.need_icon.push(meta.coord);
            }
        }
        out.rows.push(row.summary);
    }
    out
}

/// 基于仓库 JSON 载荷批量组卡（Star 列表 / 开发者 Star）：`before_load` 在预取临界区内先执行；
/// `persist = false` 时不刷新单仓富卡（stale 页）。
pub(crate) async fn cards_from_repo_payloads_offloaded(
    state: &AppState,
    items: Vec<crate::github::developer_starred::StarredRepoPayload>,
    persist: bool,
    before_load: impl FnOnce(&crate::db::Database),
) -> StarredCards {
    let coords: Vec<RepoCoord> = items.iter().map(|i| i.coord.clone()).collect();
    let pre = preload(state, &coords, false, before_load).await;
    let (rows, metas) = starred_rows(&pre.0, &state.catalog, items, persist);
    let hydrated = write_through(state, rows, Some(pre.icons()), |_| {}).await;
    assemble_starred(&state.catalog, hydrated, metas)
}

/// 同步组卡（测试入口，图标磁盘阶段就地执行）。
#[cfg(test)]
pub(crate) fn cards_from_repo_payloads(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    items: Vec<crate::github::developer_starred::StarredRepoPayload>,
    persist: bool,
) -> StarredCards {
    let mut keys = PrefetchKeys::default();
    for i in &items {
        keys.add_coord(&i.coord, false);
    }
    let pre = BackfillCtx::load_inline(db, &keys, None);
    let (rows, metas) = starred_rows(&pre, catalog, items, persist);
    let hydrated = write_through_inline(db, catalog, rows, Some(&pre.icons));
    assemble_starred(catalog, hydrated, metas)
}

#[cfg(test)]
#[path = "card_hydrator_tests.rs"]
mod tests;
