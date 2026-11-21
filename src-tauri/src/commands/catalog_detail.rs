use crate::models::{
    AppCore, AppDetail, AppSummary, HydratedRepoCard, PlatformsLiteResult, ReadmeVariantsResponse,
};
use crate::repositories::{detail_service, DetailSources};
use crate::AppState;
use std::collections::HashMap;
use tauri::State;

/// 应用详情：网络默认允许；TTL 命中直返缓存，否则走 ETag 条件请求拉取并落库。
/// `force_refresh` 为手动刷新按钮透传位，`Some(true)` 时跳过 TTL 与 ETag 复用、直探远端。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_app_details(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<AppDetail> {
    let clean_id = crate::commands::require_app_id(&id)?;
    detail_service::resolve_app_detail(
        &state,
        DetailSources::default(),
        &clean_id,
        force_refresh.unwrap_or(false),
    )
    .await
}

/// 平台轻量回填：优先命中收录目录与 TTL 内缓存，未命中时仅拉取 latest release 推导平台列表（不写 `app_details`）。
/// `force_refresh = Some(true)` 时跳过缓存快径直探远端。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_platforms_lite(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<PlatformsLiteResult> {
    let clean_id = crate::commands::require_app_id(&id)?;
    detail_service::resolve_platforms_lite(
        &state,
        DetailSources::default(),
        &clean_id,
        force_refresh.unwrap_or(false),
    )
    .await
}

/// 批量读取本地缓存的应用详情摘要（无网络、只读）：优先读详情与富卡缓存，缺失时回退收录目录。
#[tauri::command]
pub async fn get_cached_app_details_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    let (mut rows, jobs) = {
        let db = state.db()?;
        cached_or_catalog_summaries_deferred(&db, &state.catalog, &ids)
    };
    crate::icons::resolve_and_patch_icons(
        &state,
        jobs,
        rows.iter_mut().map(|r| r.as_mut().map(|s| &mut s.core)),
    )
    .await;
    Ok(rows)
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

/// 批量读取已确认的本地图标（无网络、不触发后台补图）：优先 `app_icon_cycles`，其次收录项官方图标。
#[tauri::command]
pub async fn get_confirmed_icons_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<Vec<Option<String>>> {
    let jobs = {
        let db = state.db()?;
        let pendings: Vec<crate::icons::PendingIcon> = ids
            .iter()
            .map(|raw| {
                let clean_id = crate::forge::canonical_app_id(raw.trim()).unwrap_or_default();
                crate::icons::PendingIcon::for_clean_id(&state.catalog, &clean_id)
            })
            .collect();
        crate::icons::plan_pending_icons(&db, &pendings)
    };
    let icons = crate::icons::resolve_icons_offloaded(&state, jobs).await;
    Ok(icons)
}

/// 批量水合单仓富卡（无网络）：收录项投影目录元数据，未收录项读 `repo_card_cache`（缺失回退 `app_details`），
/// 并叠加确认图标与收录标记。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_repo_cards_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<Vec<Option<HydratedRepoCard>>> {
    let (mut cards, jobs) = {
        let db = state.db()?;
        hydrate_repo_cards_deferred(&db, &state.catalog, &ids, crate::now_secs())
    };
    crate::icons::resolve_and_patch_icons(
        &state,
        jobs,
        cards
            .iter_mut()
            .map(|c| c.as_mut().map(|c| &mut c.summary.core)),
    )
    .await;
    Ok(cards)
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
pub(crate) fn hydrate_repo_cards_deferred(
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
pub(crate) fn resolve_collection_apps_deferred(
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

/// 批量本地水合合集应用概要（零网络）：用于 `zstore://collection` 预览弹窗。
#[tauri::command(rename_all = "camelCase")]
pub async fn resolve_collection_apps(
    state: State<'_, AppState>,
    app_ids: Vec<String>,
) -> crate::AppResult<Vec<AppSummary>> {
    let (mut summaries, jobs) = {
        let db = state.db()?;
        resolve_collection_apps_deferred(&db, &state.catalog, &app_ids, crate::now_secs())
    };
    crate::icons::resolve_and_patch_icons(
        &state,
        jobs,
        summaries.iter_mut().map(|s| Some(&mut s.core)),
    )
    .await;
    Ok(summaries)
}

/// 通用图片磁盘缓存查询：命中或下载后返回 `data:` URI，失败回退原地址。
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_or_cache_asset_url(
    state: State<'_, AppState>,
    url: String,
    app_id: Option<String>,
) -> crate::AppResult<String> {
    let app = app_id.unwrap_or_default();
    Ok(crate::github::asset_fetch::fetch_or_cache_asset_url_inner(&state.db, &url, &app).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_readme_variants(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<ReadmeVariantsResponse> {
    // 归一化入站 id；未知标识直接拒绝，避免触碰网络。
    let clean_id = crate::commands::require_app_id(&app_id)?;
    if let Ok(db) = state.db() {
        let ttl_secs = detail_service::detail_ttl_secs(&db);
        if ttl_secs > 0 {
            if let Ok(Some(cached)) = db.get_app_detail(&clean_id, Some(ttl_secs)) {
                if let Some(variants) = cached.readme_variants {
                    if !variants.is_empty() {
                        return Ok(ReadmeVariantsResponse { variants });
                    }
                }
            }
        }
    }
    let token = crate::commands::resolve_active_github_token(&state);
    let variants = state
        .catalog
        .fetch_readme_variants(&clean_id, token.as_deref(), None)
        .await?;
    if !variants.is_empty() {
        if let Ok(db) = state.db() {
            let _ = db.update_detail_readme_variants(&clean_id, &variants);
        }
    }
    Ok(ReadmeVariantsResponse { variants })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SimilarAppItem {
    pub app: AppSummary,
    pub similarity: f64,
    pub reasons: Vec<crate::github::affinity::Reason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternatives: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SimilarAppsResponse {
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_alternatives: Vec<String>,
    pub items: Vec<SimilarAppItem>,
}

/// `get_similar_apps` 核心同步执行逻辑（拆出供单测直测）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn get_similar_apps_sync(
    state: &AppState,
    app_id: &str,
    name: Option<&str>,
    owner: Option<&str>,
    category: Option<&str>,
    description: Option<&str>,
    description_en: Option<&str>,
    limit: Option<usize>,
) -> crate::AppResult<SimilarAppsResponse> {
    let clean_id = crate::commands::require_app_id(app_id)?;
    let hidden_ids: std::collections::HashSet<String> =
        super::catalog_search::hidden_rule_ids(state)?
            .into_iter()
            .map(|id| id.to_lowercase())
            .collect();

    let mut plan = state.catalog.find_similar_apps(
        &crate::github::catalog_service::SimilarAppSeed {
            clean_id: &clean_id,
            name,
            owner,
            category,
            description,
            description_en,
        },
        &hidden_ids,
        limit,
    );

    if let Ok(db) = state.db() {
        for entry in &mut plan.items {
            if let Some(ci) = crate::icons::resolve_confirmed_icon_from_db(
                &db,
                &entry.app.core.id,
                &entry.app.core.owner,
                &entry.app.core.repo,
            ) {
                entry.app.core.icon = ci;
            }
        }
    }

    let items = plan
        .items
        .into_iter()
        .map(|entry| {
            let alternatives = entry.app.core.alternatives.clone();
            SimilarAppItem {
                app: entry.app,
                similarity: entry.similarity,
                reasons: entry.reasons,
                alternatives,
            }
        })
        .collect();

    Ok(SimilarAppsResponse {
        target_id: plan.target_id,
        target_alternatives: plan.target_alternatives,
        items,
    })
}

/// 详情页「相似开源项目」推荐（零网络复用 `CatalogDerived` 词袋 IDF 与 `seed_similarity_with_idf`）。
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub fn get_similar_apps(
    state: State<'_, AppState>,
    app_id: String,
    name: Option<String>,
    owner: Option<String>,
    category: Option<String>,
    description: Option<String>,
    description_en: Option<String>,
    limit: Option<usize>,
) -> crate::AppResult<SimilarAppsResponse> {
    get_similar_apps_sync(
        &state,
        &app_id,
        name.as_deref(),
        owner.as_deref(),
        category.as_deref(),
        description.as_deref(),
        description_en.as_deref(),
        limit,
    )
}

#[cfg(test)]
mod catalog_platform_tests {
    use crate::github::detail_assets::platforms_from_assets;
    use crate::models::ReleaseAsset;

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            download_url: String::new(),
            // is_valid 过滤要求 >1MB：默认给足体积，仅占位/签名类用例显式覆写。
            size_bytes: 20_000_000,
            sha256: None,
            os: String::new(),
            arch: String::new(),
            kind: String::new(),
        }
    }

    #[test]
    fn linux_only_release_must_not_be_labeled_windows() {
        let assets = vec![asset("app-1.0_amd64.deb"), asset("app-1.0.AppImage")];
        let plats = platforms_from_assets(&assets);
        assert_eq!(plats, vec!["linux".to_string()]);
    }

    #[test]
    fn android_containing_release_derives_android_without_windows_fallback() {
        let assets = vec![
            asset("app-arm64-v8a-release.apk"),
            asset("app-armeabi-v7a-release.apk"),
        ];
        let plats = platforms_from_assets(&assets);
        assert_eq!(plats, vec!["android".to_string()]);
    }

    #[test]
    fn unknown_only_assets_yield_explicit_empty_vec() {
        let assets = vec![asset("checksums.txt"), asset("README.md")];
        let plats = platforms_from_assets(&assets);
        assert!(plats.is_empty());
    }

    #[test]
    fn empty_assets_yield_explicit_empty_vec() {
        let plats = platforms_from_assets(&[]);
        assert!(plats.is_empty());
    }

    #[test]
    fn test_confirmed_icon_enrichment_logic() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let app_id = "testowner/testrepo";
        let test_filename = "testowner_testrepo_l2.png";
        let icons_dir = crate::get_app_data_dir().join("icons");
        let _ = std::fs::create_dir_all(&icons_dir);
        let test_file_path = icons_dir.join(test_filename);
        let png_bytes = b"\x89PNG\r\n\x1a\nfake png data";
        std::fs::write(&test_file_path, png_bytes).unwrap();

        let cycle = crate::db::AppIconCycle {
            app_id: app_id.to_string(),
            owner: "testowner".to_string(),
            repo: "testrepo".to_string(),
            level: 2,
            selected_url: "https://example.com/icon.png".to_string(),
            cache_file: test_filename.to_string(),
            ..Default::default()
        };
        db.upsert_icon_cycle(&cycle).unwrap();

        let mut summary = crate::models::AppSummary {
            core: crate::models::AppCore {
                id: app_id.to_string(),
                name: "testrepo".to_string(),
                description_en: None,
                owner: "testowner".to_string(),
                repo: "testrepo".to_string(),
                icon: String::new(),
                icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                description: "A test project".to_string(),
                stars: 10,
                forks: 2,
                license: "MIT".to_string(),
                latest_version: "1.0.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: Vec::new(),
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
        };

        if let Some(ci) = crate::icons::resolve_confirmed_icon_from_db(
            &db,
            &summary.core.id,
            &summary.core.owner,
            &summary.core.repo,
        ) {
            summary.core.icon = ci;
        }

        assert!(summary.core.icon.starts_with("data:image/png;base64,"));

        let _ = std::fs::remove_file(&test_file_path);
    }

    fn batch_detail(id: &str, icon: &str) -> crate::models::AppDetail {
        crate::models::AppDetail {
            core: crate::models::AppCore {
                id: id.to_string(),
                name: "Demo App".to_string(),
                description_en: None,
                owner: "demo".to_string(),
                repo: "app".to_string(),
                icon: icon.to_string(),
                icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                description: "演示应用".to_string(),
                stars: 7,
                forks: 3,
                license: "MIT".to_string(),
                latest_version: "v1.2.3".to_string(),
                is_verified: false,
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: vec!["windows".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        }
    }

    #[test]
    fn cached_batch_hit_projects_detail_with_platforms() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.save_app_detail(
            "demo/app",
            &batch_detail("demo/app", "https://example.com/icon.png"),
        )
        .unwrap();
        let hit = super::cached_detail_summary(&db, "demo/app").expect("缓存行应当命中");
        assert_eq!(hit.core.id, "demo/app");
        assert_eq!(hit.core.name, "Demo App");
        assert_eq!(hit.core.icon, "https://example.com/icon.png");
        assert_eq!(hit.core.platforms, vec!["windows".to_string()]);
        assert_eq!(hit.core.latest_version, "v1.2.3");
    }

    #[test]
    fn cached_batch_miss_and_invalid_id_yield_none() {
        let db = crate::db::Database::open_in_memory().unwrap();
        assert!(super::cached_detail_summary(&db, "ghost/nobody").is_none());
        assert!(super::cached_detail_summary(&db, "not an id !!!").is_none());
        assert!(super::cached_detail_summary(&db, "   ").is_none());
    }

    #[test]
    fn cached_batch_blanks_data_icon_without_confirmed() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.save_app_detail(
            "demo/app",
            &batch_detail("demo/app", "data:image/png;base64,AAA"),
        )
        .unwrap();
        let hit = super::cached_detail_summary(&db, "demo/app").expect("缓存行应当命中");
        assert_eq!(hit.core.icon, "", "无确认图标时 data: 详情图标必须置空");
    }
}

#[cfg(test)]
mod repo_card_hydration_tests {
    use super::*;
    use crate::db::{Database, RepoCardUpsert};

    fn test_state() -> AppState {
        AppState {
            db: std::sync::Arc::new(std::sync::Mutex::new(Database::open_in_memory().unwrap())),
            catalog: crate::github::CatalogService::new_empty(),
            mirror: std::sync::Mutex::new(crate::mirror::MirrorManager::new()),
            github_token: std::sync::Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            startup_catalog_synced: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn card(id: &str, platforms: &[&str], confirmed_other: bool) -> RepoCardUpsert {
        let (owner, repo) = id.split_once('/').unwrap();
        RepoCardUpsert {
            summary: AppSummary {
                core: AppCore {
                    id: id.to_string(),
                    name: repo.to_string(),
                    description_en: None,
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    icon: "https://avatars.githubusercontent.com/u/9".to_string(),
                    icon_bg: String::new(),
                    description: "Real tool".to_string(),
                    stars: 42,
                    forks: 1,
                    license: "MIT".to_string(),
                    latest_version: "v1.0.0".to_string(),
                    category: "external".to_string(),
                    category_name: "跨平台开源".to_string(),
                    is_verified: false,
                    forge: Some("github".to_string()),
                    forge_host: Some("github.com".to_string()),
                    homepage: None,
                    platforms: platforms.iter().map(|p| p.to_string()).collect(),
                    is_cataloged: Some(false),
                    source: None,
                    status: None,
                    added_at: None,
                    alternatives: Vec::new(),
                },
            },
            confirmed_other,
            is_private: Some(false),
        }
    }

    fn curated(id: &str) -> crate::github::CatalogItem {
        let (owner, repo) = id.split_once('/').unwrap();
        crate::github::CatalogItem {
            id: id.to_string(),
            name: "精选".to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: "https://official.example/logo.png".to_string(),
            icon_bg: String::new(),
            description: "精选简介".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v9".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 1,
            forks: 1,
            is_verified: true,
            homepage: None,
            platforms: vec!["windows".to_string()],
            identifiers: Default::default(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        }
    }

    #[test]
    fn hydrate_repo_cards_keeps_order_prefers_catalog_and_touches_rows() {
        let state = test_state();
        state.catalog.update_items(vec![curated("acme/curated")]);
        let db = state.db().unwrap();
        db.upsert_repo_cards_batch(&[card("acme/a", &["linux"], false), card("acme/b", &[], true)])
            .unwrap();
        db.exec_write("UPDATE repo_card_cache SET last_accessed_at = 5", [])
            .unwrap();
        let mut cycle = crate::db::AppIconCycle::new("acme/b", "acme", "b");
        cycle.level = 2;
        cycle.l2_url = "https://cdn.simpleicons.org/b".to_string();
        cycle.selected_url = "https://cdn.simpleicons.org/b".to_string();
        cycle.updated_at = crate::now_secs();
        db.upsert_icon_cycle(&cycle).unwrap();

        let ids = vec![
            "acme/b".to_string(),
            "bad id".to_string(),
            "acme/curated".to_string(),
            "acme/missing".to_string(),
            "ACME/A".to_string(),
        ];
        let out = hydrate_repo_cards(&db, &state.catalog, &ids, 1_000);
        assert_eq!(out.len(), 5);
        let b = out[0].as_ref().unwrap();
        assert_eq!(b.summary.core.id, "acme/b");
        assert!(b.confirmed_other);
        assert_eq!(b.summary.core.icon, "https://cdn.simpleicons.org/b");
        assert_eq!(b.summary.core.is_cataloged, Some(false));
        assert!(out[1].is_none());
        let curated = out[2].as_ref().unwrap();
        assert_eq!(curated.summary.core.description, "精选简介");
        assert_eq!(curated.summary.core.is_cataloged, Some(true));
        assert!(out[3].is_none());
        assert_eq!(
            out[4].as_ref().unwrap().summary.core.platforms,
            vec!["linux"]
        );

        let touched = db.get_repo_card("acme/a").unwrap().unwrap();
        assert_eq!(touched.last_accessed_at, 1_000);
        // 收录章只在线上投影，不写回表。
        assert_eq!(touched.summary.core.is_cataloged, None);
    }

    #[test]
    fn cached_or_catalog_summary_falls_back_to_catalog_without_cache_rows() {
        let state = test_state();
        let mut remote = curated("acme/curated");
        remote.platforms = vec!["windows".to_string(), "macos".to_string()];
        state.catalog.update_items(vec![remote]);
        let mut local = curated("acme/local");
        local.name = "本地库".to_string();
        local.is_verified = false;
        local.platforms = vec!["linux".to_string()];
        state.catalog.set_collected_items(vec![local]);
        let db = state.db().unwrap();
        let icons_dir = std::env::temp_dir().join("z-store-test-no-icons");

        let remote_hit =
            resolve_cached_or_catalog_summary(&db, &state.catalog, &icons_dir, "ACME/Curated")
                .expect("remote catalog fallback");
        assert_eq!(remote_hit.core.id, "acme/curated");
        assert_eq!(remote_hit.core.name, "精选");
        assert_eq!(remote_hit.core.platforms, vec!["windows", "macos"]);
        assert_eq!(remote_hit.core.is_cataloged, Some(true));
        assert_eq!(remote_hit.core.icon, "https://official.example/logo.png");

        let local_hit =
            resolve_cached_or_catalog_summary(&db, &state.catalog, &icons_dir, "acme/local")
                .expect("local catalog fallback");
        assert_eq!(local_hit.core.name, "本地库");
        assert_eq!(local_hit.core.platforms, vec!["linux"]);
        assert_eq!(local_hit.core.is_cataloged, Some(true));

        assert!(
            resolve_cached_or_catalog_summary(&db, &state.catalog, &icons_dir, "acme/missing")
                .is_none()
        );
        assert!(
            resolve_cached_or_catalog_summary(&db, &state.catalog, &icons_dir, "bad id").is_none()
        );
    }

    #[test]
    fn resolve_collection_apps_preserves_order_and_hydrates_all_tiers() {
        let state = test_state();
        state.catalog.update_items(vec![curated("acme/curated")]);
        let mut local = curated("acme/local");
        local.name = "Local Pick".to_string();
        local.is_verified = false;
        state.catalog.set_collected_items(vec![local]);

        let db = state.db().unwrap();
        db.upsert_repo_cards_batch(&[card("acme/cached-card", &["linux"], false)])
            .unwrap();

        let mut detail = crate::models::AppDetail {
            core: card("acme/cached-detail", &["macos"], false).summary.core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        };
        detail.core.name = "Cached Detail App".to_string();
        db.save_app_detail("acme/cached-detail", &detail).unwrap();

        let input = vec![
            "bad-id".to_string(),
            "ACME/Curated".to_string(),
            "acme/cached-card".to_string(),
            "acme/curated".to_string(), // duplicate should be dropped
            "acme/cached-detail".to_string(),
            "codeberg:FreeTubeApp/FreeTube".to_string(),
            "acme/local".to_string(),
        ];
        let out = resolve_collection_apps_sync(&db, &state.catalog, &input, 2_000);
        assert_eq!(
            out.iter().map(|s| s.core.id.as_str()).collect::<Vec<_>>(),
            vec![
                "acme/curated",
                "acme/cached-card",
                "acme/cached-detail",
                "codeberg:freetubeapp/freetube",
                "acme/local",
            ]
        );
        assert_eq!(out[0].core.is_cataloged, Some(true));
        assert_eq!(out[1].core.is_cataloged, Some(false));
        assert_eq!(out[1].core.platforms, vec!["linux"]);
        assert_eq!(out[2].core.is_cataloged, Some(false));
        assert_eq!(out[2].core.name, "Cached Detail App");
        assert_eq!(out[2].core.platforms, vec!["macos"]);
        assert_eq!(out[3].core.is_cataloged, Some(false));
        assert_eq!(out[3].core.name, "freetube");
        assert_eq!(out[3].core.forge.as_deref(), Some("codeberg"));
        assert_eq!(out[3].core.forge_host.as_deref(), Some("codeberg.org"));
        assert!(out[3].core.platforms.is_empty());
        assert_eq!(out[4].core.is_cataloged, Some(true));
        assert_eq!(out[4].core.name, "Local Pick");
    }

    #[test]
    fn similar_apps_response_serializes_without_empty_alternatives() {
        let resp = SimilarAppsResponse {
            target_id: "o/r".to_string(),
            target_alternatives: Vec::new(),
            items: vec![SimilarAppItem {
                app: card("o/peer", &["windows"], false).summary,
                similarity: 0.72,
                reasons: vec![crate::github::affinity::Reason::Category {
                    category: "dev".to_string(),
                }],
                alternatives: Vec::new(),
            }],
        };
        let val = serde_json::to_value(&resp).unwrap();
        assert_eq!(val["target_id"], "o/r");
        assert!(val.get("target_alternatives").is_none());
        assert!(val["items"][0].get("alternatives").is_none());
        assert_eq!(val["items"][0]["reasons"][0]["kind"], "category");
    }

    #[test]
    fn get_similar_apps_sync_covers_curated_external_hidden_and_empty() {
        let state = test_state();
        let mut rustdesk = curated("rustdesk/rustdesk");
        rustdesk.name = "RustDesk".to_string();
        rustdesk.category = "system".to_string();
        rustdesk.description = "远程桌面控制工具 remote desktop control".to_string();
        rustdesk.stars = 50_000;

        let mut peer_same_owner = curated("rustdesk/rustdesk-server");
        peer_same_owner.name = "RustDesk Server".to_string();
        peer_same_owner.category = "system".to_string();
        peer_same_owner.description = "远程桌面自建中继服务 remote desktop relay".to_string();
        peer_same_owner.stars = 4_000;

        let mut hidden_peer = curated("acme/hidden-remote");
        hidden_peer.name = "Hidden Remote".to_string();
        hidden_peer.category = "system".to_string();
        hidden_peer.description = "远程桌面控制工具 remote desktop control".to_string();
        hidden_peer.stars = 10_000;

        let mut unrelated = curated("other/music-box");
        unrelated.name = "Music Box".to_string();
        unrelated.category = "media".to_string();
        unrelated.description = "无损音频播放器 lossless audio player".to_string();
        unrelated.stars = 2_000;

        state
            .catalog
            .update_items(vec![rustdesk, peer_same_owner, hidden_peer, unrelated]);
        state
            .db()
            .unwrap()
            .set_hidden_status("acme/hidden-remote", true)
            .unwrap();

        // 1. 已收录 seed：排除自身与隐藏条目，并产出 Reason::Owner / target_alternatives
        let curated_res = get_similar_apps_sync(
            &state,
            "RustDesk/RustDesk",
            None,
            None,
            None,
            None,
            None,
            Some(4),
        )
        .unwrap();
        assert_eq!(curated_res.target_id, "rustdesk/rustdesk");
        assert!(curated_res
            .target_alternatives
            .iter()
            .any(|a| a == "TeamViewer"));
        let ids: Vec<&str> = curated_res
            .items
            .iter()
            .map(|e| e.app.core.id.as_str())
            .collect();
        assert_eq!(ids, vec!["rustdesk/rustdesk-server"]);
        assert!(curated_res.items[0]
            .reasons
            .iter()
            .any(|r| matches!(r, crate::github::affinity::Reason::Owner { .. })));

        // 2. 未收录动态 seed：利用入参元数据匹配同赛道目录项
        let ext_res = get_similar_apps_sync(
            &state,
            "moonlight-stream/moonlight-qt",
            Some("Moonlight"),
            Some("moonlight-stream"),
            Some("system"),
            Some("远程桌面串流控制 remote desktop streaming"),
            None,
            Some(4),
        )
        .unwrap();
        assert_eq!(ext_res.target_id, "moonlight-stream/moonlight-qt");
        assert!(ext_res.target_alternatives.iter().any(|a| a == "Parsec"));
        assert!(ext_res
            .items
            .iter()
            .any(|e| e.app.core.id == "rustdesk/rustdesk"));

        // 3. 零结果边界
        let empty_res = get_similar_apps_sync(
            &state,
            "unknown/isolated",
            Some("Isolated"),
            Some("unknown"),
            Some("games"),
            Some("completely disjoint domain token"),
            None,
            Some(4),
        )
        .unwrap();
        assert!(empty_res.items.is_empty());
    }
}
