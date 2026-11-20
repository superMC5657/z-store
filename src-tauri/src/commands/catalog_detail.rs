use crate::models::{
    AppCore, AppDetail, AppSummary, HydratedRepoCard, PlatformsLiteResult, ReadmeVariantsResponse,
};
use crate::AppState;
use std::collections::HashMap;
use tauri::State;

/// 仅 stale 结果（`is_stale == Some(true)`）跳过持久化；fresh 结果（含双空）一律落盘。
pub(crate) fn should_skip_persist(is_stale: Option<bool>) -> bool {
    is_stale == Some(true)
}

/// 详情缓存 TTL（秒）；`0` 表示每次实时校验。
pub(crate) fn detail_ttl_secs(db: &crate::db::Database) -> i64 {
    let m = db.get_detail_cache_ttl_minutes();
    if m <= 0 {
        return 0;
    }
    m * 60
}

/// 应用详情：网络默认允许；TTL 命中直返缓存，否则走 ETag 条件请求拉取并落库。
/// `force_refresh` 为手动刷新按钮透传位，`Some(true)` 时跳过 TTL 与 ETag 复用、直探远端。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_app_details(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<AppDetail> {
    get_app_details_impl(&state, id, force_refresh).await
}

/// 平台轻量回填：优先命中收录目录与 TTL 内缓存，未命中时仅拉取 `releases/latest` 推导平台列表（不写 `app_details`）。
/// `force_refresh = Some(true)` 时跳过缓存快径直探远端。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_platforms_lite(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<PlatformsLiteResult> {
    // 归一化入站 id；未知标识直接拒绝，避免触碰网络。
    let clean_id = crate::commands::require_app_id(&id)?;
    let start = std::time::Instant::now();
    let is_force = force_refresh.unwrap_or(false);

    // 收录库已有非空平台时直接作为真值返回（force_refresh 不绕过）。
    if let Some(clean_plats) = state
        .catalog
        .get_catalog_item(&clean_id)
        .and_then(|i| crate::github::detail_assets::clean_catalog_platforms(&i.platforms))
    {
        return Ok(PlatformsLiteResult {
            id: clean_id,
            platforms: clean_plats,
            from_cache: true,
            is_stale: None,
        });
    }

    // TTL 内缓存命中直返（显式强制刷新时跳过）。
    if !is_force {
        if let Some(lite) = platforms_lite_from_cache(&state, &clean_id) {
            return Ok(lite);
        }
    }

    // 多源 forge 通道
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            return platforms_lite_from_forge(&state, clean_id, coord, start).await;
        }
    }

    // GitHub ETag 条件请求通道
    platforms_lite_from_github(&state, clean_id, start).await
}

/// 从 TTL 内详情缓存或新鲜的 `repo_card_cache` 读取已推导平台列表。
fn platforms_lite_from_cache(state: &AppState, clean_id: &str) -> Option<PlatformsLiteResult> {
    let db = state.db().ok()?;
    let ttl_seconds = detail_ttl_secs(&db);
    if let Some(cached) = db
        .get_app_detail(clean_id, Some(ttl_seconds))
        .ok()
        .flatten()
    {
        let cat_plats = state
            .catalog
            .get_catalog_item(clean_id)
            .map(|i| i.platforms);
        let platforms = if !cached.releases.is_empty() {
            crate::github::detail_assets::platforms_with_catalog_priority(
                &cached.releases,
                cat_plats.as_deref(),
            )
        } else {
            crate::github::detail_assets::resolve_platforms_catalog_first(
                cached.core.platforms,
                cat_plats.as_deref(),
            )
        };
        return Some(PlatformsLiteResult {
            id: clean_id.to_string(),
            platforms,
            from_cache: true,
            is_stale: cached.is_stale,
        });
    }
    let card = db.get_repo_card_platform_state(clean_id).ok().flatten()?;
    let age = crate::now_secs().saturating_sub(card.fresh_at);
    let settled = !card.platforms.is_empty() || card.confirmed_other;
    if !settled || !(0..crate::db::REPO_CARD_FRESH_TTL_SECS).contains(&age) {
        return None;
    }
    Some(PlatformsLiteResult {
        id: clean_id.to_string(),
        platforms: card.platforms,
        from_cache: true,
        is_stale: None,
    })
}

/// 非 stale 平台决议写回单仓富卡（仅未收录应用；平台为空即确认 Other）。
fn patch_lite_repo_card(
    state: &AppState,
    clean_id: &str,
    owner: &str,
    repo: &str,
    platforms: &[String],
    tag: Option<&str>,
) {
    if state.catalog.is_cataloged(clean_id) {
        return;
    }
    if let Ok(db) = state.db() {
        patch_lite_repo_card_in(&db, &state.catalog, clean_id, owner, repo, platforms, tag);
    }
}

/// `patch_lite_repo_card` 的持锁版本：调用方已持有 `db` 锁时复用同一临界区。
fn patch_lite_repo_card_in(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    clean_id: &str,
    owner: &str,
    repo: &str,
    platforms: &[String],
    tag: Option<&str>,
) {
    if catalog.is_cataloged(clean_id) {
        return;
    }
    let _ =
        db.patch_repo_card_platforms(clean_id, owner, repo, platforms, tag, platforms.is_empty());
}

/// 多源（Codeberg/Gitea 等）穿透段：仅拉 latest release，deduce 即返（无缓存读写）。
async fn platforms_lite_from_forge(
    state: &AppState,
    clean_id: String,
    coord: crate::forge::UniversalRepoCoord,
    start: std::time::Instant,
) -> crate::AppResult<PlatformsLiteResult> {
    let host_token = if let Ok(db) = state.db() {
        db.get_host_token(&coord.host).ok().flatten()
    } else {
        None
    };
    let release_info = match crate::forge::ForgeRegistry::fetch_latest_release(
        &coord,
        host_token.as_deref(),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            let mut ev =
                crate::z_log::WideEvent::new("detail", "platforms-lite failed").with_started(start);
            ev.field("id", &clean_id)
                .field("reason", crate::log_support::short_reason(&e))
                .dev("forge", coord.forge.as_str());
            ev.warn();
            return Err(e.into());
        }
    };
    let platforms = crate::github::detail_assets::platforms_from_assets(&release_info.assets);
    patch_lite_repo_card(
        state,
        &clean_id,
        &coord.owner,
        &coord.repo,
        &platforms,
        Some(&release_info.tag_name),
    );
    Ok(PlatformsLiteResult {
        id: clean_id,
        platforms,
        from_cache: false,
        is_stale: None,
    })
}

/// `platforms-lite failed` 公共告警发射器（收口 unknown_coords / Parse / PayloadCorrupt / 304）。
fn warn_platforms_lite_failed(
    id: &str,
    reason: &str,
    status: Option<u16>,
    endpoint: Option<&str>,
    start: std::time::Instant,
) {
    let mut ev =
        crate::z_log::WideEvent::new("detail", "platforms-lite failed").with_started(start);
    ev.field("id", id)
        .field("reason", reason)
        .dev_opt("status", status);
    if let Some(ep) = endpoint {
        ev.dev_url("url", ep);
    }
    ev.warn();
}

/// 从浅层发布结果解析平台列表；`StaleRow` 兜底先重分类资产并保持收录库优先。
fn resolve_lite_platforms_from_shallow(
    catalog: &crate::github::CatalogService,
    clean_id: &str,
    rel: &crate::github::release_fetch::ShallowRelease,
    stale_row: Option<&crate::models::AppDetail>,
) -> Vec<String> {
    if rel.source == crate::github::release_fetch::ShallowSource::StaleRow {
        if let Some(row) = stale_row {
            let mut healed = row.clone();
            let catalog_item = catalog.get_catalog_item(clean_id);
            crate::github::detail_assets::heal_cached_detail(&mut healed, catalog_item.as_ref());
            return healed.core.platforms;
        }
    }
    match rel.row_platforms {
        Some(ref p) => p.clone(),
        None => catalog.deduce_lite_platforms(clean_id, &rel.assets),
    }
}

/// GitHub ETag 段：release_endpoint + ETag 条件请求（仅 releases/latest 单次 RTT）。
async fn platforms_lite_from_github(
    state: &AppState,
    clean_id: String,
    start: std::time::Instant,
) -> crate::AppResult<PlatformsLiteResult> {
    use crate::github::http::EtagGetOutcome;

    let (release_endpoint, cached_etag, cached_payload, coords) = {
        if let Err(e) = state.catalog.get_repo_coordinates(&clean_id) {
            if let Ok(db) = state.db() {
                if let Ok(Some(mut fallback)) = db.get_app_detail(&clean_id, None) {
                    let catalog_item = state.catalog.get_catalog_item(&clean_id);
                    crate::github::detail_assets::heal_cached_detail(
                        &mut fallback,
                        catalog_item.as_ref(),
                    );
                    let mut ev = crate::z_log::WideEvent::new("detail", "platforms-lite stale")
                        .with_started(start);
                    ev.field("id", &clean_id)
                        .field("reason", "unknown_coords")
                        .dev("from", "cache:stale");
                    ev.warn();
                    return Ok(PlatformsLiteResult {
                        id: clean_id,
                        platforms: fallback.core.platforms,
                        from_cache: true,
                        is_stale: Some(true),
                    });
                }
            }
            warn_platforms_lite_failed(&clean_id, "unknown_coords", None, None, start);
            return Err(e.into());
        }
        let coords = state.catalog.get_repo_coordinates(&clean_id)?;
        let ep = crate::github::github_latest_release_endpoint(&coords.owner, &coords.repo);
        let (etag, payload) = state
            .db()?
            .get_etag_and_payload(&ep)
            .ok()
            .flatten()
            .map_or((None, None), |(e, p)| (Some(e), Some(p)));
        (ep, etag, payload, coords)
    };

    let token = crate::commands::resolve_active_github_token(state);
    let headers = crate::github::http::token_headers(token.as_deref());
    let (outcome, diag) = crate::github::http::get_with_etag_diag(
        &crate::shared_http_client(),
        &release_endpoint,
        None,
        &headers,
        cached_etag.as_deref(),
    )
    .await;

    // 401 统一经 check_auth_expired 通知 + warn（与详情 release 分支同语义）。
    if matches!(outcome, EtagGetOutcome::Unauthorized) {
        crate::check_auth_expired(401, &format!("op=platforms-lite id={}", clean_id));
    }

    let stale_row: Option<crate::models::AppDetail> = match &outcome {
        EtagGetOutcome::Fresh { .. } => None,
        _ => state
            .db()
            .ok()
            .and_then(|db| db.get_app_detail(&clean_id, None).ok().flatten()),
    };
    match crate::github::release_fetch::decide_shallow_release(
        &outcome,
        cached_payload.as_deref(),
        stale_row.as_ref(),
        None,
    ) {
        Ok(rel) => {
            let platforms = resolve_lite_platforms_from_shallow(
                &state.catalog,
                &clean_id,
                &rel,
                stale_row.as_ref(),
            );
            // 缓存副作用、目录平台回写与单仓富卡平台补丁共用一次 `db` 临界区。
            if let Ok(db) = state.db() {
                crate::github::release_fetch::apply_release_cache_effects(
                    &db,
                    &release_endpoint,
                    &clean_id,
                    rel.touch,
                    rel.cache_to_save,
                    crate::now_secs(),
                );
                if rel.stale != Some(true) {
                    backfill_catalog_platforms(state, &db, &clean_id, &platforms);
                    let tag = release_tag_from_payload(cached_payload.as_deref(), &outcome);
                    patch_lite_repo_card_in(
                        &db,
                        &state.catalog,
                        &clean_id,
                        &coords.owner,
                        &coords.repo,
                        &platforms,
                        tag.as_deref(),
                    );
                }
            }
            if rel.stale == Some(true) {
                let mut ev = crate::z_log::WideEvent::new("detail", "platforms-lite stale")
                    .with_started(start);
                ev.field("id", &clean_id)
                    .field("reason", diag.err_reason.as_deref().unwrap_or("stale"))
                    .dev_opt("status", diag.status)
                    .dev("from", "cache:stale")
                    .dev_url("url", &release_endpoint);
                ev.warn();
            }
            Ok(PlatformsLiteResult {
                id: clean_id,
                platforms,
                from_cache: !matches!(
                    rel.source,
                    crate::github::release_fetch::ShallowSource::Fresh
                ),
                is_stale: rel.stale,
            })
        }
        Err(crate::github::release_fetch::ShallowError::Parse(e)) => {
            warn_platforms_lite_failed(
                &clean_id,
                &crate::log_support::short_reason(&e),
                diag.status,
                Some(&release_endpoint),
                start,
            );
            Err(e.into())
        }
        Err(crate::github::release_fetch::ShallowError::PayloadCorrupt(e)) => {
            if let Ok(db) = state.db() {
                let _ = db.touch_app_detail(&clean_id, crate::now_secs());
            }
            warn_platforms_lite_failed(
                &clean_id,
                &crate::log_support::short_reason(&e),
                diag.status,
                Some(&release_endpoint),
                start,
            );
            Err(e.into())
        }
        Err(crate::github::release_fetch::ShallowError::Miss(miss)) => match miss {
            crate::github::release_fetch::ShallowMiss::NotModifiedWithoutCache => {
                warn_platforms_lite_failed(
                    &clean_id,
                    "304_no_cache",
                    diag.status,
                    Some(&release_endpoint),
                    start,
                );
                Err("304 响应但本地未找到缓存数据".into())
            }
            crate::github::release_fetch::ShallowMiss::OfflineWithoutCache => {
                // 已知存在的仓库在 `releases/latest` 返回确定性 404 = 零发布，确认 Other。
                if diag.status == Some(404) && repo_known_to_exist(state, &clean_id) {
                    patch_lite_repo_card(state, &clean_id, &coords.owner, &coords.repo, &[], None);
                    return Ok(PlatformsLiteResult {
                        id: clean_id,
                        platforms: Vec::new(),
                        from_cache: false,
                        is_stale: None,
                    });
                }
                let mut ev = crate::z_log::WideEvent::new("detail", "platforms-lite stale")
                    .with_started(start);
                ev.field("id", &clean_id)
                    .field("reason", diag.err_reason.as_deref().unwrap_or("offline"))
                    .dev_opt("status", diag.status)
                    .dev("from", "empty:stale")
                    .dev_url("url", &release_endpoint);
                ev.warn();
                Ok(PlatformsLiteResult {
                    id: clean_id,
                    platforms: Vec::new(),
                    from_cache: false,
                    is_stale: Some(true),
                })
            }
        },
    }
}

/// `releases/latest` 的 `tag_name`：`200` 取本次载荷，`304` 取缓存载荷。
fn release_tag_from_payload(
    cached_payload: Option<&str>,
    outcome: &crate::github::http::EtagGetOutcome,
) -> Option<String> {
    let text = match outcome {
        crate::github::http::EtagGetOutcome::Fresh { text, .. } => Some(text.as_str()),
        crate::github::http::EtagGetOutcome::NotModified => cached_payload,
        _ => None,
    }?;
    serde_json::from_str::<crate::github::models::GitHubReleaseResponse>(text)
        .ok()
        .map(|r| r.tag_name.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// 仓库存在性的本地证据：未收录且 `repo_card_cache` 有完整卡片或 `app_details` 有行。
fn repo_known_to_exist(state: &AppState, clean_id: &str) -> bool {
    if state.catalog.is_cataloged(clean_id) {
        return false;
    }
    let Ok(db) = state.db() else {
        return false;
    };
    db.get_repo_card(clean_id).ok().flatten().is_some()
        || db.get_app_detail(clean_id, None).ok().flatten().is_some()
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
    let mut seen = std::collections::HashSet::new();
    let mut clean_ids = Vec::new();
    for raw in app_ids {
        if let Some(canon) = crate::forge::canonical_app_id(raw.trim()) {
            if seen.insert(canon.clone()) {
                clean_ids.push(canon);
                if clean_ids.len() >= crate::deeplink::MAX_COLLECTION_APPS {
                    break;
                }
            }
        }
    }
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

/// 获取应用详情；瞬时失败仅返回带 `is_stale = true` 的缓存回退或空壳，不污染 SQLite。
pub async fn get_app_details_impl(
    state: &AppState,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<AppDetail> {
    // 归一化入站 id；未知标识直接拒绝，避免触碰网络。
    let clean_id = crate::commands::require_app_id(&id)?;
    let is_force = force_refresh.unwrap_or(false);
    let start = std::time::Instant::now();

    // 非强制刷新时优先走 TTL 内缓存快径
    if !is_force {
        if let Some(hit) = project_from_cache(state, &clean_id, true) {
            let mut ev = crate::z_log::WideEvent::new("detail", "fetch ok").with_started(start);
            ev.field("id", &clean_id)
                .field("via", "cache:db")
                .dev("cache_why", "ttl_hit");
            ev.info();
            return Ok(hit);
        }
    }

    // 多源 forge 通道
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            return Ok(fetch_detail_from_forge(state, clean_id, coord, is_force, start).await?);
        }
    }

    // GitHub ETag 条件请求通道
    Ok(fetch_detail_from_github(state, &clean_id, is_force, start).await?)
}

/// 将非空平台补写进目录库（精选库与活跃本地库），任一落库成功即同步刷新内存目录。
fn backfill_catalog_platforms(
    state: &AppState,
    db: &crate::db::Database,
    clean_id: &str,
    platforms: &[String],
) {
    if platforms.is_empty() {
        return;
    }
    let cat_updated = db
        .update_catalog_app_platforms(clean_id, platforms)
        .unwrap_or(false);
    let custom_updated = db
        .update_custom_app_platforms(clean_id, platforms)
        .unwrap_or(false);
    if cat_updated || custom_updated {
        state
            .catalog
            .update_catalog_item_platforms(clean_id, platforms);
    }
}

/// 「读 app_details → 叠加目录精校 → 盖章 → 返回」共享投影。
fn project_from_cache(state: &AppState, clean_id: &str, ttl_gated: bool) -> Option<AppDetail> {
    let db = state.db().ok()?;
    let ttl_seconds = if ttl_gated {
        Some(detail_ttl_secs(&db))
    } else {
        None
    };
    let detail = crate::repositories::DetailRepository::project_detail(
        &db,
        &state.catalog,
        clean_id,
        ttl_seconds,
        !ttl_gated,
    )?;
    if ttl_gated && detail.is_stale != Some(true) {
        backfill_catalog_platforms(state, &db, clean_id, &detail.core.platforms);
    }
    Some(detail)
}

/// 多源 forge lite 段：repo + latest release 并发拉取合成详情。
async fn fetch_detail_from_forge(
    state: &AppState,
    clean_id: String,
    coord: crate::forge::UniversalRepoCoord,
    is_force: bool,
    start: std::time::Instant,
) -> Result<AppDetail, String> {
    // TTL 缓存快径已由 `get_app_details_impl` 在分派前检查，此处直接走远端。
    let host_token = if let Ok(db) = state.db() {
        db.get_host_token(&coord.host).ok().flatten()
    } else {
        None
    };
    let (repo_info, release_info) = match tokio::try_join!(
        crate::forge::ForgeRegistry::fetch_repo(&coord, host_token.as_deref()),
        crate::forge::ForgeRegistry::fetch_latest_release(&coord, host_token.as_deref())
    ) {
        Ok(pair) => pair,
        Err(e) => {
            let mut ev = crate::z_log::WideEvent::new("detail", "fetch failed").with_started(start);
            ev.field("id", &clean_id)
                .field("via", format!("forge:{}", coord.forge.as_str()))
                .field("reason", crate::log_support::short_reason(&e))
                .dev("host", &coord.host);
            ev.warn();
            return Err(e);
        }
    };
    let now = crate::now_secs();
    let catalog_item = state.catalog.get_catalog_item(&clean_id);
    let platforms = crate::github::detail_assets::platforms_with_catalog_priority(
        &release_info.assets,
        catalog_item.as_ref().map(|i| i.platforms.as_slice()),
    );
    let license = catalog_item
        .as_ref()
        .map(|i| i.license.trim())
        .filter(|l| crate::github::models::CatalogItem::is_concrete_license(l))
        .map(str::to_string)
        .unwrap_or_else(|| "OpenSource".to_string());
    let homepage = crate::github::detail_fetch::resolve_homepage(
        repo_info.homepage.as_deref(),
        catalog_item.as_ref().and_then(|i| i.homepage.as_deref()),
        &coord.host,
        &coord.owner,
        &coord.repo,
    );
    let mut detail = AppDetail {
        core: AppCore {
            id: clean_id.clone(),
            name: repo_info.name.clone(),
            description_en: repo_info.description.clone(),
            owner: coord.owner,
            repo: coord.repo,
            icon: String::new(),
            icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
            description: repo_info.description.clone().unwrap_or_default(),
            stars: repo_info.stars,
            forks: repo_info.forks,
            license,
            latest_version: release_info.tag_name,
            is_verified: catalog_item
                .as_ref()
                .map(|i| i.is_verified)
                .unwrap_or(false),
            category: "external".to_string(),
            category_name: "跨平台开源".to_string(),
            forge: Some(coord.forge.as_str().to_string()),
            forge_host: Some(coord.host.clone()),
            homepage,
            platforms,
            is_cataloged: None,
            source: None,
            status: None,
            added_at: None,
        },
        changelog: release_info.body.unwrap_or_default(),
        readme_markdown: format!(
            "# {}\n\n{}",
            repo_info.name,
            repo_info.description.unwrap_or_default()
        ),
        readme_variants: None,
        releases: release_info.assets,
        cached_at: Some(now),
        is_stale: None,
    };

    let mut db_ms: Option<u128> = None;
    if let Some(ref cat) = catalog_item {
        cat.overlay_detail_core(&mut detail.core);
    }
    if let Ok(db) = state.db() {
        let start_db = std::time::Instant::now();
        if detail.core.icon.trim().is_empty() {
            restore_existing_cycle_icon(&db, &clean_id, &mut detail);
        }
        persist_detail_and_sync_catalog(state, &db, &clean_id, &detail, None, &[]);
        db_ms = Some(start_db.elapsed().as_millis());
    }

    state.catalog.stamp_detail(&mut detail);
    let mut ev = crate::z_log::WideEvent::new("detail", "fetch ok").with_started(start);
    ev.field("id", &clean_id)
        .field("via", format!("forge:{}", coord.forge.as_str()))
        .dev("host", &coord.host);
    if is_force {
        ev.dev("force", true);
    }
    if let Some(d_ms) = db_ms {
        ev.step(format!("db:{}ms", d_ms));
    }
    ev.info();
    Ok(detail)
}

/// GitHub full 段：ETag 条件请求 + repo/README/平台/Checksum 全量组装落库。
async fn fetch_detail_from_github(
    state: &AppState,
    clean_id: &str,
    is_force: bool,
    start: std::time::Instant,
) -> Result<AppDetail, String> {
    let (release_endpoint, prefetch, token, cached_detail_opt) = {
        let token = crate::commands::resolve_active_github_token(state);
        let coords = match state.catalog.get_repo_coordinates(clean_id) {
            Ok(c) => c,
            Err(e) => {
                if let Some(fallback) = project_from_cache(state, clean_id, false) {
                    let mut ev =
                        crate::z_log::WideEvent::new("detail", "fetch stale").with_started(start);
                    ev.field("id", clean_id)
                        .field("via", "cache:stale")
                        .field("reason", "unknown_coords");
                    ev.warn();
                    return Ok(fallback);
                }
                let mut ev =
                    crate::z_log::WideEvent::new("detail", "fetch failed").with_started(start);
                ev.field("id", clean_id).field("reason", "unknown_coords");
                ev.warn();
                return Err(e);
            }
        };
        let ep = crate::github::github_latest_release_endpoint(&coords.owner, &coords.repo);
        let repo_ep = crate::github::github_repo_endpoint(&coords.owner, &coords.repo);
        let readme_ep = crate::github::github_readme_endpoint(&coords.owner, &coords.repo);
        let db = state.db()?;
        let cached_detail = if is_force {
            None
        } else {
            db.get_app_detail(clean_id, None).ok().flatten()
        };
        let prefetch = if is_force {
            crate::github::detail_fetch::DetailEtagPrefetch::default()
        } else {
            crate::github::detail_fetch::DetailEtagPrefetch {
                release_etag: db.get_etag(&ep).ok().flatten(),
                release_payload: db.get_cached_payload(&ep).ok().flatten(),
                repo_etag: db.get_etag(&repo_ep).ok().flatten(),
                repo_payload: db.get_cached_payload(&repo_ep).ok().flatten(),
                readme_etag: db.get_etag(&readme_ep).ok().flatten(),
                readme_payload: db.get_cached_payload(&readme_ep).ok().flatten(),
            }
        };
        (ep, prefetch, token, cached_detail)
    };

    let fetch_result = state
        .catalog
        .fetch_app_detail(clean_id, prefetch, cached_detail_opt, token.as_deref())
        .await;

    match fetch_result {
        Ok(mut out) => {
            let now = crate::now_secs();
            out.detail.cached_at = Some(now);

            let (persisted, db_ms) = persist_github_detail(
                state,
                clean_id,
                &mut out.detail,
                out.icon_resolution.as_ref(),
                &out.etag_writes,
                now,
            );
            out.diag.steps.push(if persisted {
                format!("db:{}ms", db_ms)
            } else {
                "db:skip(stale)".to_string()
            });

            state.catalog.stamp_detail(&mut out.detail);

            let is_stale = out.detail.is_stale == Some(true);
            let via = if out.release_cache_written {
                "network"
            } else if is_stale {
                "cache:stale"
            } else {
                "cache:304"
            };
            let action = if is_stale { "fetch stale" } else { "fetch ok" };
            let mut ev = crate::z_log::WideEvent::new("detail", action).with_started(start);
            ev.field("id", clean_id)
                .field("via", via)
                .dev("force", is_force)
                .dev_opt("rate", out.diag.rate_summary.as_deref())
                .dev_opt("chk", out.diag.checksum_why.as_deref())
                .dev_url("url", &release_endpoint);
            for s in out.diag.steps {
                ev.step(s);
            }
            if is_stale {
                ev.warn();
            } else {
                ev.info();
            }
            Ok(out.detail)
        }
        Err(err) => {
            let reason = crate::log_support::short_reason(&err);
            if let Some(fallback_detail) = project_from_cache(state, clean_id, false) {
                let mut ev =
                    crate::z_log::WideEvent::new("detail", "fetch stale").with_started(start);
                ev.field("id", clean_id)
                    .field("via", "cache:stale")
                    .field("reason", &reason)
                    .dev_url("url", &release_endpoint);
                ev.warn();
                return Ok(fallback_detail);
            }
            let mut ev = crate::z_log::WideEvent::new("detail", "fetch failed").with_started(start);
            ev.field("id", clean_id)
                .field("reason", &reason)
                .dev_url("url", &release_endpoint);
            ev.warn();
            Err(err)
        }
    }
}

/// 详情无图标时从已确认的 `app_icon_cycles` 恢复选定图标（跳过显式置空的 L5）。
fn restore_existing_cycle_icon(db: &crate::db::Database, clean_id: &str, detail: &mut AppDetail) {
    if let Ok(Some(existing_cycle)) = db.get_icon_cycle(clean_id) {
        if existing_cycle.pinned
            || (existing_cycle.level != 5 && !existing_cycle.selected_url.trim().is_empty())
        {
            detail.core.icon = existing_cycle.selected_url.clone();
        }
    }
}

/// 原子写入详情捆绑并在提交成功后同步刷新内存目录索引；失败时保持内存索引不变。
fn persist_detail_and_sync_catalog(
    state: &AppState,
    db: &crate::db::Database,
    clean_id: &str,
    detail: &AppDetail,
    staged_cycle: Option<&crate::db::AppIconCycle>,
    etag_writes: &[crate::repositories::EtagWrite],
) -> bool {
    if crate::repositories::DetailRepository::persist_detail_bundle(
        db,
        clean_id,
        detail,
        staged_cycle,
        etag_writes,
    )
    .is_ok()
    {
        state.catalog.update_catalog_item_from_detail(detail);
        true
    } else {
        log::warn!(
            target: "detail",
            "persist_detail_bundle failed id={}; keeping in-memory catalog unchanged",
            clean_id
        );
        false
    }
}

fn persist_github_detail(
    state: &AppState,
    clean_id: &str,
    detail: &mut AppDetail,
    icon_resolution: Option<&crate::icons::DetailIconResolution>,
    etag_writes: &[crate::repositories::EtagWrite],
    now: i64,
) -> (bool, u128) {
    let start_db = std::time::Instant::now();
    let mut persisted = false;
    if let Ok(db) = state.db() {
        if detail.releases.is_empty() {
            if let Ok(Some(old)) = db.get_app_detail(clean_id, None) {
                if !old.releases.is_empty() {
                    detail.releases = old.releases.clone();
                }
            }
        }
        if !detail.releases.is_empty() && detail.core.platforms.is_empty() {
            detail.core.platforms =
                crate::github::detail_assets::platforms_from_assets(&detail.releases);
        }
        if !should_skip_persist(detail.is_stale) {
            if state.catalog.get_catalog_item(clean_id).is_none() {
                let need_desc =
                    crate::github::models::is_placeholder_description(&detail.core.description);
                let need_en = detail
                    .core
                    .description_en
                    .as_deref()
                    .map(crate::github::models::is_placeholder_description)
                    .unwrap_or(false);
                let need_en_missing = detail
                    .core
                    .description_en
                    .as_ref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true);
                if need_desc || need_en || need_en_missing {
                    if let Some(real) = crate::github::detail_fetch::repo_real_description_from_etag(
                        &db,
                        &detail.core.owner,
                        &detail.core.repo,
                    ) {
                        if need_desc {
                            detail.core.description = real.clone();
                        }
                        if need_en || need_en_missing {
                            detail.core.description_en = Some(real);
                        }
                    }
                }
            }
            let icon_trimmed = detail.core.icon.trim().to_owned();
            let staged_cycle: Option<crate::db::AppIconCycle> = if !icon_trimmed.trim().is_empty()
                && !crate::icons::is_body_image_url(&icon_trimmed)
            {
                let mut cycle = db
                    .get_icon_cycle(clean_id)
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| {
                        crate::db::AppIconCycle::new(
                            clean_id,
                            &detail.core.owner,
                            &detail.core.repo,
                        )
                    });

                let sanitized_res = icon_resolution.cloned().map(|mut r| {
                    if r.extra_l4_url
                        .as_deref()
                        .is_some_and(crate::icons::is_body_image_url)
                    {
                        r.extra_l4_url = None;
                    }
                    r
                });
                let fallback_level = crate::icons::level_for_detail_icon(&icon_trimmed);
                if crate::icons::apply_detail_icon_resolution(
                    &mut cycle,
                    icon_trimmed.trim(),
                    sanitized_res.as_ref(),
                    fallback_level,
                    state.catalog.is_cataloged(clean_id),
                    now,
                ) {
                    detail.core.icon = cycle.selected_url.clone();
                }
                let sel = cycle.selected_url.trim().to_string();
                if !sel.is_empty() && cycle.cache_file.trim().is_empty() {
                    let icons_dir = crate::get_app_data_dir().join("icons");
                    if let Some((_, fname)) =
                        crate::icons::find_cached_icon_by_url(&icons_dir, &sel)
                    {
                        cycle.cache_file = fname;
                    }
                }
                Some(cycle)
            } else {
                restore_existing_cycle_icon(&db, clean_id, detail);
                None
            };
            if persist_detail_and_sync_catalog(
                state,
                &db,
                clean_id,
                detail,
                staged_cycle.as_ref(),
                etag_writes,
            ) {
                persisted = true;
                if let Some(ref c) = staged_cycle {
                    let sel = c.selected_url.trim().to_string();
                    if c.cache_file.trim().is_empty()
                        && (sel.starts_with("http://") || sel.starts_with("https://"))
                    {
                        crate::icons::spawn_cache_selected_icon(
                            std::sync::Arc::clone(&state.db),
                            clean_id.to_string(),
                            c.level,
                            sel,
                            c.is_cataloged,
                        );
                    }
                }
            }
        } else if !etag_writes.is_empty() {
            for w in etag_writes {
                let _ = db.save_etag(&w.url, &w.etag, &w.payload, w.timestamp);
            }
        }
    }
    (persisted, start_db.elapsed().as_millis())
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
        let ttl_secs = detail_ttl_secs(&db);
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
    fn persist_gate_only_stale_skips_fresh_true_empty_persists() {
        // 401/离线/合成空失败（stale）→ 跳过落库，保持旧行（仍黄，待 backfill）。
        assert!(super::should_skip_persist(Some(true)));
        // 200 真空（fresh，非 stale，双空）→ 落盘 fresh 空行（灭黄标）。
        assert!(!super::should_skip_persist(None));
        assert!(!super::should_skip_persist(Some(false)));
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

    #[test]
    fn platforms_lite_from_cache_prefers_catalog_platforms_over_cached_releases() {
        let state = crate::AppState {
            db: std::sync::Arc::new(std::sync::Mutex::new(
                crate::db::Database::open_in_memory().unwrap(),
            )),
            catalog: crate::github::CatalogService::new_empty(),
            mirror: std::sync::Mutex::new(crate::mirror::MirrorManager::new()),
            github_token: std::sync::Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            startup_catalog_synced: std::sync::atomic::AtomicBool::new(false),
        };
        let mut local_item = crate::github::CatalogItem {
            id: "demo/app".to_string(),
            name: "Demo App".to_string(),
            owner: "demo".to_string(),
            repo: "app".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: "Local desc".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 0,
            forks: 0,
            is_verified: false,
            homepage: Some("https://demo.example.com".to_string()),
            platforms: vec![
                "windows".to_string(),
                "ios".to_string(),
                "android".to_string(),
            ],
            identifiers: Default::default(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        };
        state.catalog.set_collected_items(vec![local_item.clone()]);

        let mut detail = batch_detail("demo/app", "");
        detail.core.platforms = vec!["windows".to_string()];
        detail.releases = vec![crate::models::ReleaseAsset {
            name: "demo-setup.exe".to_string(),
            download_url: "https://example.com/demo-setup.exe".to_string(),
            size_bytes: 20_000_000,
            sha256: None,
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            kind: "setup_exe".to_string(),
        }];
        state
            .db()
            .unwrap()
            .save_app_detail("demo/app", &detail)
            .unwrap();

        let lite = super::platforms_lite_from_cache(&state, "demo/app").expect("cache hit");
        assert_eq!(lite.platforms, vec!["windows", "ios", "android"]);

        // 自收录平台为空 [] 时回退 Release 推导
        local_item.platforms = Vec::new();
        state.catalog.set_collected_items(vec![local_item]);
        let fallback_lite =
            super::platforms_lite_from_cache(&state, "demo/app").expect("cache hit");
        assert_eq!(fallback_lite.platforms, vec!["windows"]);
    }

    #[test]
    fn platforms_lite_stale_row_heals_misclassified_maccy_assets_and_respects_catalog() {
        let catalog = crate::github::CatalogService::new_empty();
        let mut maccy_stale = batch_detail("p0deje/maccy", "");
        maccy_stale.core.owner = "p0deje".to_string();
        maccy_stale.core.repo = "Maccy".to_string();
        maccy_stale.core.platforms = vec!["windows".to_string()];
        maccy_stale.releases = vec![crate::models::ReleaseAsset {
            name: "Maccy.app.zip".to_string(),
            download_url: "https://example.com/Maccy.app.zip".to_string(),
            size_bytes: 5_288_775,
            sha256: None,
            os: "windows".to_string(),
            arch: "universal".to_string(),
            kind: "portable_zip".to_string(),
        }];

        let rel = crate::github::release_fetch::decide_shallow_release(
            &crate::github::http::EtagGetOutcome::Failed,
            None,
            Some(&maccy_stale),
            None,
        )
        .expect("stale row fallback");
        assert_eq!(
            rel.source,
            crate::github::release_fetch::ShallowSource::StaleRow
        );

        let platforms = super::resolve_lite_platforms_from_shallow(
            &catalog,
            "p0deje/maccy",
            &rel,
            Some(&maccy_stale),
        );
        assert_eq!(platforms, vec!["macos".to_string()]);

        // 若收录库明确指定了非空平台，stale 自愈仍保持收录库优先
        let curated_item = crate::github::CatalogItem {
            id: "p0deje/maccy".to_string(),
            name: "Maccy".to_string(),
            owner: "p0deje".to_string(),
            repo: "Maccy".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            category: "tools".to_string(),
            category_name: "效率工具".to_string(),
            aliases: vec![],
            default_version: "v2.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 0,
            forks: 0,
            is_verified: true,
            homepage: None,
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec!["macos".to_string(), "ios".to_string()],
            identifiers: Default::default(),
        };
        catalog.set_collected_items(vec![curated_item]);
        let platforms_with_catalog = super::resolve_lite_platforms_from_shallow(
            &catalog,
            "p0deje/maccy",
            &rel,
            Some(&maccy_stale),
        );
        assert_eq!(
            platforms_with_catalog,
            vec!["macos".to_string(), "ios".to_string()]
        );
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
    fn platforms_lite_fast_path_serves_settled_repo_cards_only() {
        let state = test_state();
        {
            let db = state.db().unwrap();
            db.upsert_repo_cards_batch(&[
                card("acme/other", &[], true),
                card("acme/win", &["windows"], false),
                card("acme/unknown", &[], false),
            ])
            .unwrap();
        }
        let other = platforms_lite_from_cache(&state, "acme/other").expect("confirmed other hit");
        assert!(other.from_cache);
        assert!(other.platforms.is_empty());
        assert_eq!(other.is_stale, None);
        let win = platforms_lite_from_cache(&state, "acme/win").expect("platform hit");
        assert_eq!(win.platforms, vec!["windows"]);
        assert!(platforms_lite_from_cache(&state, "acme/unknown").is_none());

        // 超出 12h 新鲜窗口的卡片不走快径。
        state
            .db()
            .unwrap()
            .exec_write("UPDATE repo_card_cache SET updated_at = 1", [])
            .unwrap();
        assert!(platforms_lite_from_cache(&state, "acme/win").is_none());
    }

    #[test]
    fn lite_patch_preseeds_and_confirms_other_for_uncataloged_only() {
        let state = test_state();
        state.catalog.update_items(vec![curated("acme/curated")]);
        patch_lite_repo_card(&state, "acme/curated", "acme", "curated", &[], None);
        patch_lite_repo_card(&state, "acme/zero", "acme", "zero", &[], None);
        let db = state.db().unwrap();
        assert!(db
            .get_repo_card_platform_state("acme/curated")
            .unwrap()
            .is_none());
        let zero = db
            .get_repo_card_platform_state("acme/zero")
            .unwrap()
            .unwrap();
        assert!(zero.confirmed_other);
        drop(db);
        assert!(platforms_lite_from_cache(&state, "acme/zero").is_some());
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
            core: card("acme/cached-detail", &["macos"], false)
                .summary
                .core,
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
}
