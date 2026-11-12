use crate::models::{AppCore, AppDetail, AppSummary, PlatformsLiteResult, ReadmeVariantsResponse};
use crate::AppState;
use tauri::State;

/// 落库门（真空语义）：仅 stale 穿透/合成空失败（`is_stale==Some(true)`）跳过持久化；
/// fresh（含 200 真空双空）一律落盘——真空以 fresh 空行落盘（`is_stale=None`，
/// `cached_at=now`），下次 TTL 内命中直接复用，前端灭黄标。
/// 401/离线仍黄（skip 保持旧行），200 真空不黄（persist fresh 空行）。
pub(crate) fn should_skip_persist(is_stale: Option<bool>) -> bool {
    is_stale == Some(true)
}

/// FINAL 详情 TTL（分钟→秒）：分钟数经 `get_detail_cache_ttl_minutes`
///（内用 `get_or_config`，DB 设置优先、挡位归一、缺省回退 config 基线）已归一，
/// 此处仅做单位换算。
/// - `0`（每次实时校验）原样透传 0；
/// - 其余一律 `m * 60`（挡位合法性由 DB 层保证，不做二次钳制）。
///   图标 TTL 另见 `icons::ICON_TTL_SECS`（7 天，图标通道禁用 ETag）。
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
    Ok(get_app_details_impl(&state, id, force_refresh).await?)
}

/// 平台轻量回填（`get_platforms_lite`）：列表平台懒回填专用通道。
///
/// `lazyBackfillPlatforms` 仅需 deduced platforms，
/// 此处仅做单次 `releases/latest` ETag 条件请求 + `platforms_from_assets` 推导。
///
/// 语义与 `get_app_details_impl` 对齐（仅做减法）：
/// - TTL 内详情缓存命中（`get_detail_cache_ttl_minutes()*60`）直接复用已 deduce 的
///   platforms，`from_cache=true`；
/// - miss 时仅 GET `releases/latest`（`get_with_etag` 复用 304/200/ETag 与限流上报），
///   无 repo、无 README、无图标探测、无 checksum；`detail_json` 仅 TTL 命中时复用，
///   网络路径只解析 release assets；
/// - 304-touch/save/回退决议收归 `github::release_fetch` shallow adapter
///   （与 Streaming Update Check〈流式更新检查〉同一 interface）：
///   304 命中经 payload 恢复 deduce 并 `touch_cached_app_detail` 延长保鲜期
///   （`from_cache=true`，与详情 304 短路同形）；
/// - stale 穿透（401/离线复用旧行）标 `is_stale=true` 且不 touch（与详情一致，
///   避免把过期 stale 洗成 fresh）；
/// - 空 platforms 明确返回空向量，不 stamp `["other"]`/`["windows"]`；
///   `other` 仍为纯前端虚拟概念，永不过 IPC。
/// 本命令永不写入 `app_details_cache`（不构造全量 `AppDetail`，避免污染详情缓存），
/// 仅读写 `api_etag_cache`（条件请求键）与详情 `cached_at` touch。
/// - 网络默认允许：TTL 命中直返缓存，否则走 forge 直拉 / ETag 条件请求；
///   `force_refresh` 为手动刷新按钮透传位，`Some(true)` 时跳过 TTL 快径直探远端。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_platforms_lite(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<PlatformsLiteResult> {
    // ADR-0010：入站 id 统一归一化为 canonical；未知标识直接拒绝，不触碰网络。
    let clean_id = crate::commands::require_app_id(&id)?;
    let start = std::time::Instant::now();
    let is_force = force_refresh.unwrap_or(false);

    // 1. TTL 内详情缓存命中段：零网络开销复用已 deduce 的 platforms。
    // 显式强制刷新时跳过此快径，直探远端。
    if !is_force {
        if let Some(lite) = platforms_lite_from_cache(&state, &clean_id) {
            return Ok(lite);
        }
    }

    // 2. 多源（Codeberg/Gitea 等）穿透段：仅拉 latest release，deduce 即返。
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            return platforms_lite_from_forge(&state, clean_id, coord, start).await;
        }
    }

    // 3. GitHub ETag 段：release_endpoint + 条件请求（仅 releases/latest 单次 RTT）。
    platforms_lite_from_github(&state, clean_id, start).await
}

/// TTL 内详情缓存命中段：复用已 deduce 的 platforms（TTL 口径与 get_app_details_impl
/// 缓存链一致，见 `detail_ttl_secs`）；stale 标记原样透传（持久化行正常为 None，
/// 透传仅为防御性一致）。
fn platforms_lite_from_cache(
    state: &AppState,
    clean_id: &str,
) -> Option<PlatformsLiteResult> {
    let db = state.db().ok()?;
    let ttl_seconds = detail_ttl_secs(&db);
    let cached = db
        .get_cached_app_detail(clean_id, Some(ttl_seconds))
        .ok()
        .flatten()?;
    Some(PlatformsLiteResult {
        id: clean_id.to_string(),
        platforms: cached.core.platforms,
        from_cache: true,
        is_stale: cached.is_stale,
    })
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
    Ok(PlatformsLiteResult {
        id: clean_id,
        platforms: crate::github::detail_assets::platforms_from_assets(&release_info.assets),
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
    let mut ev = crate::z_log::WideEvent::new("detail", "platforms-lite failed").with_started(start);
    ev.field("id", id)
        .field("reason", reason)
        .dev_opt("status", status);
    if let Some(ep) = endpoint {
        ev.dev_url("url", ep);
    }
    ev.warn();
}

/// GitHub ETag 段：release_endpoint + ETag 条件请求（仅 releases/latest 单次 RTT）。
async fn platforms_lite_from_github(
    state: &AppState,
    clean_id: String,
    start: std::time::Instant,
) -> crate::AppResult<PlatformsLiteResult> {
    use crate::github::http::EtagGetOutcome;

    let (release_endpoint, cached_etag, cached_payload) = {
        if let Err(e) = state.catalog.get_repo_coordinates(&clean_id) {
            if let Ok(db) = state.db() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail(&clean_id, None) {
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
        let ep = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            coords.owner, coords.repo
        );
        let db = state.db()?;
        let etag = db.get_etag(&ep).ok().flatten();
        let payload = db.get_cached_payload(&ep).ok().flatten();
        (ep, etag, payload)
    };

    let token = crate::commands::resolve_active_github_token(state);
    let headers = crate::github::http::token_headers(token.as_deref());
    let (outcome, diag) = crate::github::http::get_with_etag_diag(
        &state.http,
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
            .and_then(|db| db.get_cached_app_detail(&clean_id, None).ok().flatten()),
    };
    match crate::github::release_fetch::decide_shallow_release(
        &outcome,
        cached_payload.as_deref(),
        stale_row.as_ref(),
        None,
    ) {
        Ok(rel) => {
            if let Ok(db) = state.db() {
                crate::github::release_fetch::apply_release_cache_effects(
                    &db,
                    &release_endpoint,
                    &clean_id,
                    rel.touch,
                    rel.cache_to_save,
                    crate::now_secs(),
                );
            }
            let platforms = match rel.row_platforms {
                Some(p) => p,
                None => state.catalog.deduce_lite_platforms(&clean_id, &rel.assets),
            };
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
                let _ = db.touch_cached_app_detail(&clean_id, crate::now_secs());
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

/// DB-only 批量详情回填（Favorites/Watching 富卡专用）：零网络、零写盘。
/// - 入参逐个经 `require_app_id` 归一为 canonical；不可解析的未知标识直接落 `None`，不触碰 SQLite；
/// - 命中行读 `get_cached_app_detail(None)`（无 TTL 门控，过期行同样复用；无行即 `None`，永不穿透网络/ETag/forge）；
/// - 确认图标经 `resolve_confirmed_icon_from_db` 覆盖（`Some` 才覆盖，`None` 保持 `detail.icon`）；
/// - platforms 随详情行自带，无需二次 join（空即未知，前端视为待 backfill，不 stamp `["other"]`/`["windows"]`）；
/// - 全程只读：不 `touch` 保鲜期、不落库、不 spawn 后台任务；返回与入参一一对齐（含 `None` 占位）。
/// `get_app_details` 的 force 语义不受影响（本命令永不走其网络分支）。
#[tauri::command]
pub fn get_cached_app_details_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    let db = state.db()?;
    Ok(ids
        .iter()
        .map(|raw| {
            let mut summary = cached_detail_summary(&db, raw)?;
            state.catalog.stamp_summary(&mut summary);
            Some(summary)
        })
        .collect())
}

/// 单 id 的 DB-only 投影：`AppDetail` 子集转 `AppSummary`，无网络、无写盘。
/// changelog/readme/releases 不进卡；`is_stale` 不进卡（前端小行不黄，详情黄标另行）。
/// `data:` 详情图标置空兜底（确认图标随后覆盖，M2 `data:` 仍可呈现）。
fn cached_detail_summary(db: &crate::db::Database, raw_id: &str) -> Option<AppSummary> {
    let clean_id = crate::commands::require_app_id(raw_id).ok()?;
    let detail = db.get_cached_app_detail(&clean_id, None).ok().flatten()?;
    let icon_trimmed = detail.core.icon.trim();
    let mut summary = AppSummary {
        core: AppCore {
            icon: if icon_trimmed.is_empty() || icon_trimmed.starts_with("data:") {
                String::new()
            } else {
                detail.core.icon.clone()
            },
            // 卡片不携带收录标记/来源/状态，恒为 None。
            is_cataloged: None,
            source: None,
            status: None,
            ..detail.core.clone()
        },
    };
    if let Some(ci) = crate::icons::resolve_confirmed_icon_from_db(
        db,
        &summary.core.id,
        &summary.core.owner,
        &summary.core.repo,
    ) {
        summary.core.icon = ci;
    }
    Some(summary)
}

/// DB-only 确认图标批量回填（趋势榜重挂图标自愈专用）：零网络、零 ETag、零写盘、不 spawn 后台任务。
/// - 入参与返回一一对齐：每个 id 经 `canonical_app_id` 归一（不可解析即 `None`，不触碰 SQLite）；
/// - 命中经 `resolve_confirmed_icon_from_db`（cycle 表 + 本地图标文件，`M2` dataURI 直显或 L1..L3 远端回退；L4/`None` 即 `None`）；
/// - 全程只读：不 `touch` 保鲜期、不落库、不触发 `fetch_icons_stream`；前端经店内唯一写口 `admitIconHit`（`via=m2`，不占 `level`）合流进镜像。
#[tauri::command]
pub fn get_confirmed_icons_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<Vec<Option<String>>> {
    let db = state.db()?;
    let icons_dir = crate::get_app_data_dir().join("icons");
    Ok(ids
        .iter()
        .map(|raw| {
            let clean_id = crate::forge::canonical_app_id(raw.trim()).unwrap_or_default();
            if clean_id.is_empty() || !clean_id.contains('/') {
                return None;
            }
            let (owner, repo) = clean_id.split_once('/').unwrap_or_default();
            if owner.is_empty() || repo.is_empty() {
                return None;
            }
            if let Some(hit) =
                crate::icons::resolve_confirmed_icon_from_db(&db, &clean_id, owner, repo)
            {
                return Some(hit);
            }
            if let Some(cat_item) = state.catalog.get_catalog_item(&clean_id) {
                let icon_url = cat_item.icon.trim();
                if !icon_url.is_empty() {
                    if let Some((bytes, _)) =
                        crate::icons::find_cached_icon_by_url(&icons_dir, icon_url)
                    {
                        return Some(crate::icons::bytes_to_data_uri(&bytes));
                    }
                    return Some(icon_url.to_string());
                }
            }
            None
        })
        .collect())
}

/// stale 契约：瞬时失败（401/限流/离线）永不污染 SQLite。
/// - 合成空（无缓存失败）以 `is_stale=true` 返回，调用方跳过落库，无旧行则不建行；
/// - stale 穿透（复用旧行）保持旧行不动（含 `cached_at` 不刷新），`Ok(stale)` 为 IPC 形状约定；
/// - 前端必须将 `stale + releases/platforms 双空` 视为 loading/待 backfill-loading，永不确认 Other。
pub async fn get_app_details_impl(
    state: &AppState,
    id: String,
    force_refresh: Option<bool>,
) -> Result<AppDetail, String> {
    // ADR-0010：入站 id 统一归一化为 canonical（小写 owner/repo / forge 前缀坐标）；未知标识直接拒绝
    let clean_id = crate::commands::require_app_id(&id)?;
    let is_force = force_refresh.unwrap_or(false);
    let start = std::time::Instant::now();

    // 1. 缓存命中段：非主动强制刷新时优先走 TTL 内快径（0ms 秒开）
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

    // 2. 多源 forge lite 段（Codeberg/Gitea 等）：repo + latest release 合成。
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            return fetch_detail_from_forge(state, clean_id, coord, is_force, start).await;
        }
    }

    // 3. GitHub full 段：ETag 条件请求 + repo/README/平台/Checksum 全量组装落库。
    fetch_detail_from_github(state, &clean_id, is_force, start).await
}

/// 「读缓存行 → id 回写 → 盖章 → 返回」共享投影。
fn project_from_cache(state: &AppState, clean_id: &str, ttl_gated: bool) -> Option<AppDetail> {
    let db = state.db().ok()?;
    let ttl_seconds = if ttl_gated {
        Some(detail_ttl_secs(&db))
    } else {
        None
    };
    let mut detail = db
        .get_cached_app_detail(clean_id, ttl_seconds)
        .ok()
        .flatten()?;
    detail.core.id = clean_id.to_string();
    if !ttl_gated {
        detail.is_stale = Some(true);
    }
    if let Some(cat_item) = state.catalog.get_catalog_item(clean_id) {
        cat_item.overlay_detail_core(&mut detail.core);
    }
    state.catalog.stamp_detail(&mut detail);
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
    if !is_force {
        if let Some(hit) = project_from_cache(state, &clean_id, true) {
            let mut ev = crate::z_log::WideEvent::new("detail", "fetch ok").with_started(start);
            ev.field("id", &clean_id)
                .field("via", "cache:db")
                .dev("forge", coord.forge.as_str())
                .dev("cache_why", "ttl_hit");
            ev.info();
            return Ok(hit);
        }
    }
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
            let mut ev =
                crate::z_log::WideEvent::new("detail", "fetch failed").with_started(start);
            ev.field("id", &clean_id)
                .field("via", format!("forge:{}", coord.forge.as_str()))
                .field("reason", crate::log_support::short_reason(&e))
                .dev("host", &coord.host);
            ev.warn();
            return Err(e);
        }
    };
    let now = crate::now_secs();
    let platforms = crate::github::detail_assets::platforms_from_assets(&release_info.assets);
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
            license: "OpenSource".to_string(),
            latest_version: release_info.tag_name,
            is_verified: false,
            category: "external".to_string(),
            category_name: "跨平台开源".to_string(),
            forge: Some(coord.forge.as_str().to_string()),
            forge_host: Some(coord.host.clone()),
            homepage: repo_info.homepage.clone(),
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

    state.catalog.update_catalog_item_stats(
        &clean_id,
        Some(repo_info.stars),
        Some(repo_info.forks),
        Some(&detail.core.latest_version),
    );

    let mut db_ms: Option<u128> = None;
    if let Ok(db) = state.db() {
        let start_db = std::time::Instant::now();
        let icon_trimmed = detail.core.icon.trim();
        let staged_cycle: Option<crate::db::AppIconCycle> = if !icon_trimmed.is_empty() {
            let mut cycle = db
                .get_icon_cycle(&clean_id)
                .ok()
                .flatten()
                .unwrap_or_else(|| {
                    crate::db::AppIconCycle::new(&clean_id, &detail.core.owner, &detail.core.repo)
                });
            cycle.is_cataloged = false;
            cycle.level = 4;
            cycle.l4_url = icon_trimmed.to_string();
            cycle.selected_url = icon_trimmed.to_string();
            cycle.updated_at = crate::now_secs();
            Some(cycle)
        } else {
            None
        };
        if db
            .save_detail_with_cycle_row(&clean_id, &detail, staged_cycle.as_ref())
            .is_err()
        {
            let _ = db.save_cached_app_detail(&clean_id, &detail);
            if let Some(c) = staged_cycle.as_ref() {
                let _ = db.upsert_icon_cycle(c);
            }
        }
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
    let (release_endpoint, cached_etag, cached_payload, token, cached_detail_opt) = {
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
        let ep = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            coords.owner, coords.repo
        );
        let db = state.db()?;
        let (etag, payload) = if is_force {
            (None, None)
        } else {
            let etag = db.get_etag(&ep).ok().flatten();
            let payload = db.get_cached_payload(&ep).ok().flatten();
            (etag, payload)
        };
        let cached_detail = if is_force {
            None
        } else {
            db.get_cached_app_detail(clean_id, None).ok().flatten()
        };
        (ep, etag, payload, token, cached_detail)
    };

    let fetch_result = state
        .catalog
        .fetch_app_detail(
            clean_id,
            cached_etag,
            cached_payload,
            cached_detail_opt,
            token.as_deref(),
        )
        .await;

    match fetch_result {
        Ok((mut detail, to_cache, icon_resolution, mut diag)) => {
            let now = crate::now_secs();
            detail.cached_at = Some(now);

            if let Ok(db) = state.db() {
                let touch_on_304 = to_cache.is_none() && detail.is_stale != Some(true);
                crate::github::release_fetch::apply_release_cache_effects(
                    &db,
                    &release_endpoint,
                    clean_id,
                    touch_on_304,
                    to_cache.clone(),
                    now,
                );
            }

            let (persisted, db_ms) = persist_github_detail(
                state,
                clean_id,
                &mut detail,
                icon_resolution.as_ref(),
                now,
            );
            diag.steps.push(if persisted {
                format!("db:{}ms", db_ms)
            } else {
                "db:skip(stale)".to_string()
            });

            state.catalog.stamp_detail(&mut detail);

            let is_stale = detail.is_stale == Some(true);
            let via = if to_cache.is_some() {
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
                .dev_opt("rate", diag.rate_summary.as_deref())
                .dev_opt("chk", diag.checksum_why.as_deref())
                .dev_url("url", &release_endpoint);
            for s in diag.steps {
                ev.step(s);
            }
            if is_stale {
                ev.warn();
            } else {
                ev.info();
            }
            Ok(detail)
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
            let mut ev =
                crate::z_log::WideEvent::new("detail", "fetch failed").with_started(start);
            ev.field("id", clean_id)
                .field("reason", &reason)
                .dev_url("url", &release_endpoint);
            ev.warn();
            Err(err)
        }
    }
}

fn persist_github_detail(
    state: &AppState,
    clean_id: &str,
    detail: &mut AppDetail,
    icon_resolution: Option<&crate::icons::DetailIconResolution>,
    now: i64,
) -> (bool, u128) {
    let start_db = std::time::Instant::now();
    let mut persisted = false;
    if let Ok(db) = state.db() {
        if detail.releases.is_empty() {
            if let Ok(Some(old)) = db.get_cached_app_detail(clean_id, None) {
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
            persisted = true;
            if state.catalog.get_catalog_item(clean_id).is_none() {
                let need_desc = crate::github::detail_fetch::is_placeholder_description(
                    &detail.core.description,
                );
                let need_en = detail
                    .core
                    .description_en
                    .as_deref()
                    .map(crate::github::detail_fetch::is_placeholder_description)
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
                    if let Some((_, fname)) = crate::icons::find_cached_icon_by_url(&icons_dir, &sel)
                    {
                        cycle.cache_file = fname;
                    }
                }
                Some(cycle)
            } else {
                if let Ok(Some(existing_cycle)) = db.get_icon_cycle(clean_id) {
                    if existing_cycle.pinned
                        || (existing_cycle.level != 5
                            && !existing_cycle.selected_url.trim().is_empty())
                    {
                        detail.core.icon = existing_cycle.selected_url.clone();
                    }
                }
                None
            };
            state.catalog.update_catalog_item_from_detail(detail);
            if db
                .save_detail_with_cycle_row(clean_id, detail, staged_cycle.as_ref())
                .is_err()
            {
                let _ = db.save_cached_app_detail(clean_id, detail);
                if let Some(c) = staged_cycle.as_ref() {
                    let _ = db.upsert_icon_cycle(c);
                }
            }
            if let Some(ref c) = staged_cycle {
                let sel = c.selected_url.trim().to_string();
                if c.cache_file.trim().is_empty()
                    && (sel.starts_with("http://") || sel.starts_with("https://"))
                {
                    crate::icons::spawn_cache_selected_icon(
                        clean_id.to_string(),
                        c.level,
                        sel,
                        c.is_cataloged,
                    );
                }
            }
        }
    }
    (persisted, start_db.elapsed().as_millis())
}

/// 通用图片磁盘缓存查询：已缓存返回本地路径，未命中下载后返回本地路径，失败回退原地址。
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_or_cache_asset_url(
    url: String,
    app_id: Option<String>,
) -> crate::AppResult<String> {
    let app = app_id.unwrap_or_default();
    Ok(crate::github::asset_fetch::fetch_or_cache_asset_url_inner(&url, &app).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_readme_variants(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<ReadmeVariantsResponse> {
    // ADR-0010：入站 id 统一归一化为 canonical；未知标识直接拒绝，不触碰网络。
    // token 经服务端鉴权头透传（token_headers），永不回传前端。
    let clean_id = crate::commands::require_app_id(&app_id)?;
    let token = crate::commands::resolve_active_github_token(&state);
    let variants = state
        .catalog
        .fetch_readme_variants(&clean_id, token.as_deref(), None)
        .await?;
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
        db.save_cached_app_detail(
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
        db.save_cached_app_detail(
            "demo/app",
            &batch_detail("demo/app", "data:image/png;base64,AAA"),
        )
        .unwrap();
        let hit = super::cached_detail_summary(&db, "demo/app").expect("缓存行应当命中");
        assert_eq!(hit.core.icon, "", "无确认图标时 data: 详情图标必须置空");
    }
}
