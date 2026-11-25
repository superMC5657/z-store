//! 应用详情决议深模块：完整详情（`AppDetail`）、平台轻量回填（`platforms_lite`）与轻量 Release
//! 三条读取路径的唯一编排点。
//!
//! 内部收口 `Cache TTL` 快径、GitHub ETag 条件请求、多源 `ForgeProvider` 拉取、
//! `Checksum Manifest` 填充、失败旧缓存（`is_stale`）降级、空 `releases` 与占位简介自愈、
//! `AppIconCycle` 归并、`persist_detail_bundle` 同事务落盘、`repo_card_cache` 平台写回与
//! `CatalogService` 内存回写。命令层只做参数校验与返回映射。

use crate::forge::{
    ForgeProvider, ForgeRegistry, ForgeType, RepositoryUrlParser, UniversalRepoCoord,
};
use crate::github::http::EtagGetOutcome;
use crate::github::release_fetch::{
    apply_release_cache_effects, decide_shallow_release, ShallowError, ShallowMiss, ShallowRelease,
    ShallowSource,
};
use crate::log_support::HttpDiag;
use crate::models::{AppCore, AppDetail, PlatformsLiteResult};
use crate::repositories::{DetailRepository, EtagWrite};
use crate::AppState;

/// 远端数据源注入点：生产取 `Default`；测试把 GitHub REST 基址指向本地 mock，
/// 并以 mock adapter 替换多源 `ForgeProvider`（缓存键恒为 `api.github.com` 形态）。
#[derive(Clone, Copy, Default)]
pub struct DetailSources<'a> {
    pub github_api_base: Option<&'a str>,
    pub forge: Option<&'a dyn ForgeProvider>,
}

impl<'a> DetailSources<'a> {
    fn provider(&self, forge: ForgeType) -> &'a dyn ForgeProvider {
        self.forge
            .unwrap_or_else(|| ForgeRegistry::provider_for(forge))
    }
}

/// 轻量 Release 投影：最新 tag、说明与发布时间（Unix 秒，未知为 `None`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LightweightRelease {
    pub tag: String,
    pub body: String,
    pub published_at: Option<i64>,
}

/// 详情缓存 TTL（秒）；`0` 表示每次实时校验。
pub(crate) fn detail_ttl_secs(db: &crate::db::Database) -> i64 {
    let m = db.get_detail_cache_ttl_minutes();
    if m <= 0 {
        return 0;
    }
    m * 60
}

/// 仅 stale 结果（`is_stale == Some(true)`）跳过持久化；fresh 结果（含双空）一律落盘。
fn should_skip_persist(is_stale: Option<bool>) -> bool {
    is_stale == Some(true)
}

fn non_github_coord(clean_id: &str) -> Option<UniversalRepoCoord> {
    RepositoryUrlParser::parse(clean_id).filter(|c| c.forge != ForgeType::GitHub)
}

fn host_token(state: &AppState, coord: &UniversalRepoCoord) -> Option<String> {
    let db = state.db().ok()?;
    crate::oauth::resolve_host_token(&db, coord.forge, &coord.host, &state.github_token)
}

// ---------------------------------------------------------------------------
// 完整详情
// ---------------------------------------------------------------------------

/// 应用详情决议（`clean_id` 须已归一）：非强制时 TTL 命中直返缓存；否则按 forge 拉取远端并落库，
/// 瞬时失败仅返回带 `is_stale = true` 的旧缓存，无旧缓存时返回错误，不污染 SQLite。
pub async fn resolve_app_detail(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
    force_refresh: bool,
) -> crate::AppResult<AppDetail> {
    let start = std::time::Instant::now();
    if !force_refresh {
        if let Some(hit) = project_from_cache(state, clean_id, true) {
            let mut ev = crate::z_log::WideEvent::new("detail", "fetch ok").with_started(start);
            ev.field("id", clean_id)
                .field("via", "cache:db")
                .dev("cache_why", "ttl_hit");
            ev.info();
            return Ok(hit);
        }
    }
    if let Some(coord) = non_github_coord(clean_id) {
        return Ok(
            resolve_forge_detail(state, sources, clean_id, coord, force_refresh, start).await?,
        );
    }
    Ok(resolve_github_detail(state, sources, clean_id, force_refresh, start).await?)
}

/// 「读 app_details → 叠加目录精校 → 盖章」共享投影；`ttl_gated = false` 时读任意旧行并标 stale。
fn project_from_cache(state: &AppState, clean_id: &str, ttl_gated: bool) -> Option<AppDetail> {
    let db = state.db().ok()?;
    let ttl_seconds = ttl_gated.then(|| detail_ttl_secs(&db));
    let detail =
        DetailRepository::project_detail(&db, &state.catalog, clean_id, ttl_seconds, !ttl_gated)?;
    if ttl_gated && detail.is_stale != Some(true) {
        state
            .catalog
            .backfill_platforms(&db, clean_id, &detail.core.platforms);
    }
    Some(detail)
}

/// 详情失败的统一降级：有旧行即返回 stale 投影，否则透传错误。
fn stale_or_fail(
    state: &AppState,
    clean_id: &str,
    err: String,
    via: Option<String>,
    endpoint: Option<&str>,
    start: std::time::Instant,
) -> Result<AppDetail, String> {
    let reason = crate::log_support::short_reason(&err);
    if let Some(fallback) = project_from_cache(state, clean_id, false) {
        let mut ev = crate::z_log::WideEvent::new("detail", "fetch stale").with_started(start);
        ev.field("id", clean_id)
            .field("via", "cache:stale")
            .field("reason", &reason)
            .dev_opt("forge", via.as_deref());
        if let Some(ep) = endpoint {
            ev.dev_url("url", ep);
        }
        ev.warn();
        return Ok(fallback);
    }
    let mut ev = crate::z_log::WideEvent::new("detail", "fetch failed").with_started(start);
    ev.field("id", clean_id)
        .field("reason", &reason)
        .dev_opt("forge", via.as_deref());
    if let Some(ep) = endpoint {
        ev.dev_url("url", ep);
    }
    ev.warn();
    Err(err)
}

/// 多源 forge 段：repo + latest release 并发拉取、`Checksum Manifest` 填充并合成详情落库。
async fn resolve_forge_detail(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
    coord: UniversalRepoCoord,
    is_force: bool,
    start: std::time::Instant,
) -> Result<AppDetail, String> {
    let token = host_token(state, &coord);
    let cached_detail = if is_force {
        None
    } else {
        state
            .db()
            .ok()
            .and_then(|db| db.get_app_detail(clean_id, None).ok().flatten())
    };
    let provider = sources.provider(coord.forge);
    let via = format!("forge:{}", coord.forge.as_str());
    let (repo_info, mut release_info) = match tokio::try_join!(
        provider.fetch_repo(&coord.host, &coord.owner, &coord.repo, token.as_deref()),
        provider.fetch_latest_release(&coord.host, &coord.owner, &coord.repo, token.as_deref())
    ) {
        Ok(pair) => pair,
        Err(e) => return stale_or_fail(state, clean_id, e, Some(via), None, start),
    };

    let now = crate::now_secs();
    let version_changed = cached_detail
        .as_ref()
        .map(|c| c.core.latest_version != release_info.tag_name)
        .unwrap_or(true);
    let skip_checksum = crate::github::detail_fetch::should_skip_checksum_fetch(
        cached_detail.as_ref(),
        version_changed,
        now,
    );
    let client = crate::forge::http::api_client(crate::github::http::api_timeout().as_secs());
    let (chk_step, chk_why) = crate::github::detail_fetch::fill_release_checksums(
        &mut release_info.assets,
        &client,
        skip_checksum,
    )
    .await;

    let catalog_item = state.catalog.get_catalog_item(clean_id);
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
            id: clean_id.to_string(),
            name: repo_info.name.clone(),
            description_en: repo_info.description.clone(),
            owner: coord.owner.clone(),
            repo: coord.repo.clone(),
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
            alternatives: catalog_item
                .as_ref()
                .map(crate::github::alternatives::resolved_alternatives)
                .unwrap_or_default(),
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
        is_private: false,
    };
    if let Some(ref cat) = catalog_item {
        cat.overlay_detail_core(&mut detail.core);
    }

    let mut db_ms: Option<u128> = None;
    if let Ok(db) = state.db() {
        let start_db = std::time::Instant::now();
        if detail.core.icon.trim().is_empty() {
            restore_existing_cycle_icon(&db, clean_id, &mut detail);
        }
        persist_detail_and_sync_catalog(state, &db, clean_id, &detail, None, &[]);
        db_ms = Some(start_db.elapsed().as_millis());
    }

    state.catalog.stamp_detail(&mut detail);
    let mut ev = crate::z_log::WideEvent::new("detail", "fetch ok").with_started(start);
    ev.field("id", clean_id)
        .field("via", &via)
        .dev("host", &coord.host)
        .dev_opt("chk", chk_why.as_deref());
    if is_force {
        ev.dev("force", true);
    }
    ev.step(chk_step);
    if let Some(d_ms) = db_ms {
        ev.step(format!("db:{}ms", d_ms));
    }
    ev.info();
    Ok(detail)
}

/// 详情 ETag 预读（单次查询）：release / repo / readme 三端点的 `(etag, payload)`。
fn prefetch_detail_etags(
    db: &crate::db::Database,
    owner: &str,
    repo: &str,
) -> crate::github::detail_fetch::DetailEtagPrefetch {
    let release_ep = crate::github::github_latest_release_endpoint(owner, repo);
    let repo_ep = crate::github::github_repo_endpoint(owner, repo);
    let readme_ep = crate::github::github_readme_endpoint(owner, repo);
    let mut rows = db
        .get_detail_etag_rows(&[&release_ep, &repo_ep, &readme_ep])
        .unwrap_or_default();
    let mut take = |ep: &str| {
        rows.remove(ep)
            .map_or((None, None), |(e, p)| (Some(e), Some(p)))
    };
    let (release_etag, release_payload) = take(&release_ep);
    let (repo_etag, repo_payload) = take(&repo_ep);
    let (readme_etag, readme_payload) = take(&readme_ep);
    crate::github::detail_fetch::DetailEtagPrefetch {
        release_etag,
        release_payload,
        repo_etag,
        repo_payload,
        readme_etag,
        readme_payload,
    }
}

/// GitHub full 段：ETag 条件请求 + repo/README/平台/Checksum 全量组装落库。
async fn resolve_github_detail(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
    is_force: bool,
    start: std::time::Instant,
) -> Result<AppDetail, String> {
    let token = state.active_github_token();
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
            let mut ev = crate::z_log::WideEvent::new("detail", "fetch failed").with_started(start);
            ev.field("id", clean_id).field("reason", "unknown_coords");
            ev.warn();
            return Err(e);
        }
    };
    let release_endpoint =
        crate::github::github_latest_release_endpoint(&coords.owner, &coords.repo);
    let (prefetch, cached_detail) = if is_force {
        (Default::default(), None)
    } else {
        let db = state.db()?;
        (
            prefetch_detail_etags(&db, &coords.owner, &coords.repo),
            db.get_app_detail(clean_id, None).ok().flatten(),
        )
    };

    let mut out = match state
        .catalog
        .fetch_app_detail(
            clean_id,
            prefetch,
            cached_detail,
            token.as_deref(),
            sources.github_api_base,
        )
        .await
    {
        Ok(out) => out,
        Err(err) => {
            return stale_or_fail(state, clean_id, err, None, Some(&release_endpoint), start)
        }
    };

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
    etag_writes: &[EtagWrite],
) -> bool {
    if DetailRepository::persist_detail_bundle(db, clean_id, detail, staged_cycle, etag_writes)
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

/// 未收录应用的占位简介治愈：用 `api_etag_cache` 中仓库 JSON 的真实简介回填。
fn heal_placeholder_descriptions(db: &crate::db::Database, detail: &mut AppDetail) {
    use crate::github::models::is_placeholder_description;
    let need_desc = is_placeholder_description(&detail.core.description);
    let need_en = match detail.core.description_en.as_deref() {
        Some(s) => s.trim().is_empty() || is_placeholder_description(s),
        None => true,
    };
    if !(need_desc || need_en) {
        return;
    }
    if let Some(real) = crate::github::detail_fetch::repo_real_description_from_etag(
        db,
        &detail.core.owner,
        &detail.core.repo,
    ) {
        if need_desc {
            detail.core.description = real.clone();
        }
        if need_en {
            detail.core.description_en = Some(real);
        }
    }
}

/// 把本次图标决议并入 `AppIconCycle`（缺行新建）；返回待同事务落盘的轮换行。
fn stage_detail_icon_cycle(
    state: &AppState,
    db: &crate::db::Database,
    clean_id: &str,
    detail: &mut AppDetail,
    icon_resolution: Option<&crate::icons::DetailIconResolution>,
    now: i64,
) -> Option<crate::db::AppIconCycle> {
    let icon_trimmed = detail.core.icon.trim().to_owned();
    if icon_trimmed.is_empty() || crate::icons::is_body_image_url(&icon_trimmed) {
        restore_existing_cycle_icon(db, clean_id, detail);
        return None;
    }
    let mut cycle = db
        .get_icon_cycle(clean_id)
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            crate::db::AppIconCycle::new(clean_id, &detail.core.owner, &detail.core.repo)
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
        &icon_trimmed,
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
        if let Some((_, fname)) = crate::icons::find_cached_icon_by_url(&icons_dir, &sel) {
            cycle.cache_file = fname;
        }
    }
    Some(cycle)
}

/// GitHub 详情落库：空 `releases` 沿用旧行、平台补推、占位简介治愈、图标轮换归并，
/// 同事务落盘后同步内存目录并后台预热确认图标；stale 结果仅落 ETag。返回 `(是否落盘, 耗时 ms)`。
fn persist_github_detail(
    state: &AppState,
    clean_id: &str,
    detail: &mut AppDetail,
    icon_resolution: Option<&crate::icons::DetailIconResolution>,
    etag_writes: &[EtagWrite],
    now: i64,
) -> (bool, u128) {
    let start_db = std::time::Instant::now();
    let Ok(db) = state.db() else {
        return (false, start_db.elapsed().as_millis());
    };
    if detail.releases.is_empty() {
        if let Ok(Some(old)) = db.get_app_detail(clean_id, None) {
            if !old.releases.is_empty() {
                detail.releases = old.releases;
            }
        }
    }
    if !detail.releases.is_empty() && detail.core.platforms.is_empty() {
        detail.core.platforms =
            crate::github::detail_assets::platforms_from_assets(&detail.releases);
    }
    if should_skip_persist(detail.is_stale) {
        for w in etag_writes {
            let _ = db.save_etag(&w.url, &w.etag, &w.payload, w.timestamp);
        }
        return (false, start_db.elapsed().as_millis());
    }
    if let Some(is_priv) =
        crate::repositories::detail_repo::repo_private_flag(&db, &detail.core, etag_writes)
    {
        detail.is_private = is_priv;
    }
    if state.catalog.get_catalog_item(clean_id).is_none() {
        heal_placeholder_descriptions(&db, detail);
    }
    let staged_cycle = stage_detail_icon_cycle(state, &db, clean_id, detail, icon_resolution, now);
    let persisted = persist_detail_and_sync_catalog(
        state,
        &db,
        clean_id,
        detail,
        staged_cycle.as_ref(),
        etag_writes,
    );
    if persisted {
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
    (persisted, start_db.elapsed().as_millis())
}

// ---------------------------------------------------------------------------
// GitHub `releases/latest` 轻量探查（platforms-lite 与轻量 Release 共用）
// ---------------------------------------------------------------------------

/// 一次 `releases/latest` ETag 条件请求的完整上下文。
struct GithubReleaseProbe {
    endpoint: String,
    owner: String,
    repo: String,
    cached_payload: Option<String>,
    outcome: EtagGetOutcome,
    diag: HttpDiag,
    /// 非 `Fresh` 时读取的旧详情行（离线/304 兜底源）。
    stale_row: Option<AppDetail>,
}

impl GithubReleaseProbe {
    /// `200` 取本次载荷、`304` 取缓存载荷。
    fn release_text(&self) -> Option<&str> {
        match &self.outcome {
            EtagGetOutcome::Fresh { text, .. } => Some(text.as_str()),
            EtagGetOutcome::NotModified => self.cached_payload.as_deref(),
            _ => None,
        }
    }
}

/// `releases/latest` 条件 GET：401 统一触发凭据失效通知。
async fn get_release(
    state: &AppState,
    sources: DetailSources<'_>,
    endpoint: &str,
    etag: Option<&str>,
    ctx: &str,
) -> (EtagGetOutcome, HttpDiag) {
    let token = state.active_github_token();
    let headers = crate::github::http::token_headers(token.as_deref());
    let (outcome, diag) = crate::github::http::get_with_etag_diag(
        &crate::shared_http_client(),
        endpoint,
        sources.github_api_base,
        &headers,
        etag,
    )
    .await;
    if matches!(outcome, EtagGetOutcome::Unauthorized) {
        crate::check_auth_expired(401, ctx);
    }
    (outcome, diag)
}

/// 坐标解析 + 预读 `api_etag_cache` + 条件 GET + 非 `Fresh` 时读旧行；坐标未知返回 `Err`。
async fn probe_github_release(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
    ctx: &str,
) -> Result<GithubReleaseProbe, String> {
    let coords = state.catalog.get_repo_coordinates(clean_id)?;
    let endpoint = crate::github::github_latest_release_endpoint(&coords.owner, &coords.repo);
    let (cached_etag, cached_payload) = state
        .db()?
        .get_etag_and_payload(&endpoint)
        .ok()
        .flatten()
        .map_or((None, None), |(e, p)| (Some(e), Some(p)));
    let (outcome, diag) = get_release(state, sources, &endpoint, cached_etag.as_deref(), ctx).await;
    let stale_row = match &outcome {
        EtagGetOutcome::Fresh { .. } => None,
        _ => state
            .db()
            .ok()
            .and_then(|db| db.get_app_detail(clean_id, None).ok().flatten()),
    };
    Ok(GithubReleaseProbe {
        endpoint,
        owner: coords.owner,
        repo: coords.repo,
        cached_payload,
        outcome,
        diag,
        stale_row,
    })
}

// ---------------------------------------------------------------------------
// platforms-lite
// ---------------------------------------------------------------------------

/// 平台轻量回填：收录库非空平台为真值（强制刷新也不绕过）；非强制时命中 TTL 内详情或
/// `repo_card_cache` 12h 三态快径；否则仅探查 latest release 推导平台（不写 `app_details`）。
pub async fn resolve_platforms_lite(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
    force_refresh: bool,
) -> crate::AppResult<PlatformsLiteResult> {
    let start = std::time::Instant::now();
    if let Some(clean_plats) = state
        .catalog
        .get_catalog_item(clean_id)
        .and_then(|i| crate::github::detail_assets::clean_catalog_platforms(&i.platforms))
    {
        return Ok(lite_result(clean_id, clean_plats, true, None));
    }
    if !force_refresh {
        if let Some(lite) = platforms_lite_from_cache(state, clean_id) {
            return Ok(lite);
        }
    }
    if let Some(coord) = non_github_coord(clean_id) {
        return platforms_lite_from_forge(state, sources, clean_id, coord, start).await;
    }
    platforms_lite_from_github(state, sources, clean_id, start).await
}

fn lite_result(
    clean_id: &str,
    platforms: Vec<String>,
    from_cache: bool,
    is_stale: Option<bool>,
) -> PlatformsLiteResult {
    PlatformsLiteResult {
        id: clean_id.to_string(),
        platforms,
        from_cache,
        is_stale,
    }
}

/// 从 TTL 内详情缓存或新鲜的 `repo_card_cache`（已定平台或确认 Other）读取平台列表。
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
        return Some(lite_result(clean_id, platforms, true, cached.is_stale));
    }
    let card = db.get_repo_card_platform_state(clean_id).ok().flatten()?;
    let age = crate::now_secs().saturating_sub(card.fresh_at);
    let settled = !card.platforms.is_empty() || card.confirmed_other;
    if !settled || !(0..crate::db::REPO_CARD_FRESH_TTL_SECS).contains(&age) {
        return None;
    }
    Some(lite_result(clean_id, card.platforms, true, None))
}

/// 非 stale 平台决议写回：目录库补平台（非空时）+ 未收录应用单仓富卡（平台为空即确认 Other）。
fn write_back_lite_platforms(
    state: &AppState,
    db: &crate::db::Database,
    clean_id: &str,
    owner: &str,
    repo: &str,
    platforms: &[String],
    tag: Option<&str>,
) {
    state.catalog.backfill_platforms(db, clean_id, platforms);
    if state.catalog.is_cataloged(clean_id) {
        return;
    }
    let _ =
        db.patch_repo_card_platforms(clean_id, owner, repo, platforms, tag, platforms.is_empty());
}

/// `platforms-lite failed` 公共告警发射器。
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

fn warn_platforms_lite_stale(
    id: &str,
    reason: &str,
    from: &str,
    probe: Option<&GithubReleaseProbe>,
    start: std::time::Instant,
) {
    let mut ev = crate::z_log::WideEvent::new("detail", "platforms-lite stale").with_started(start);
    ev.field("id", id).field("reason", reason).dev("from", from);
    if let Some(p) = probe {
        ev.dev_opt("status", p.diag.status)
            .dev_url("url", &p.endpoint);
    }
    ev.warn();
}

/// 多源 forge 段：仅拉 latest release 推导平台并写回目录与单仓富卡。
async fn platforms_lite_from_forge(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
    coord: UniversalRepoCoord,
    start: std::time::Instant,
) -> crate::AppResult<PlatformsLiteResult> {
    let token = host_token(state, &coord);
    let release_info = match sources
        .provider(coord.forge)
        .fetch_latest_release(&coord.host, &coord.owner, &coord.repo, token.as_deref())
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let mut ev =
                crate::z_log::WideEvent::new("detail", "platforms-lite failed").with_started(start);
            ev.field("id", clean_id)
                .field("reason", crate::log_support::short_reason(&e))
                .dev("forge", coord.forge.as_str());
            ev.warn();
            return Err(e.into());
        }
    };
    let platforms = crate::github::detail_assets::platforms_from_assets(&release_info.assets);
    if let Ok(db) = state.db() {
        write_back_lite_platforms(
            state,
            &db,
            clean_id,
            &coord.owner,
            &coord.repo,
            &platforms,
            Some(&release_info.tag_name),
        );
    }
    Ok(lite_result(clean_id, platforms, false, None))
}

/// 从浅层发布结果解析平台列表；`StaleRow` 兜底先重分类资产并保持收录库优先。
fn resolve_lite_platforms_from_shallow(
    catalog: &crate::github::CatalogService,
    clean_id: &str,
    rel: &ShallowRelease,
    stale_row: Option<&AppDetail>,
) -> Vec<String> {
    if rel.source == ShallowSource::StaleRow {
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

fn release_tag(text: &str) -> Option<String> {
    serde_json::from_str::<crate::github::models::GitHubReleaseResponse>(text)
        .ok()
        .map(|r| r.tag_name.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// 仓库存在性的本地证据：未收录且 `repo_card_cache` 有完整卡片或 `app_details` 有行。
fn repo_known_to_exist(state: &AppState, db: &crate::db::Database, clean_id: &str) -> bool {
    !state.catalog.is_cataloged(clean_id)
        && (db.get_repo_card(clean_id).ok().flatten().is_some()
            || db.get_app_detail(clean_id, None).ok().flatten().is_some())
}

/// GitHub 段：`releases/latest` 单次 ETag 条件请求推导平台。
async fn platforms_lite_from_github(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
    start: std::time::Instant,
) -> crate::AppResult<PlatformsLiteResult> {
    let ctx = format!("op=platforms-lite id={}", clean_id);
    let probe = match probe_github_release(state, sources, clean_id, &ctx).await {
        Ok(p) => p,
        Err(e) => {
            if let Ok(db) = state.db() {
                if let Ok(Some(mut fallback)) = db.get_app_detail(clean_id, None) {
                    let catalog_item = state.catalog.get_catalog_item(clean_id);
                    crate::github::detail_assets::heal_cached_detail(
                        &mut fallback,
                        catalog_item.as_ref(),
                    );
                    warn_platforms_lite_stale(
                        clean_id,
                        "unknown_coords",
                        "cache:stale",
                        None,
                        start,
                    );
                    return Ok(lite_result(
                        clean_id,
                        fallback.core.platforms,
                        true,
                        Some(true),
                    ));
                }
            }
            warn_platforms_lite_failed(clean_id, "unknown_coords", None, None, start);
            return Err(e.into());
        }
    };
    let fail = |reason: &str| {
        warn_platforms_lite_failed(
            clean_id,
            reason,
            probe.diag.status,
            Some(&probe.endpoint),
            start,
        )
    };
    match decide_shallow_release(
        &probe.outcome,
        probe.cached_payload.as_deref(),
        probe.stale_row.as_ref(),
        None,
    ) {
        Ok(rel) => {
            let platforms = resolve_lite_platforms_from_shallow(
                &state.catalog,
                clean_id,
                &rel,
                probe.stale_row.as_ref(),
            );
            let stale = rel.stale;
            let from_cache = rel.source != ShallowSource::Fresh;
            if let Ok(db) = state.db() {
                apply_release_cache_effects(
                    &db,
                    &probe.endpoint,
                    clean_id,
                    rel.touch,
                    rel.cache_to_save,
                    crate::now_secs(),
                );
                if stale != Some(true) {
                    let tag = probe.release_text().and_then(release_tag);
                    write_back_lite_platforms(
                        state,
                        &db,
                        clean_id,
                        &probe.owner,
                        &probe.repo,
                        &platforms,
                        tag.as_deref(),
                    );
                }
            }
            if stale == Some(true) {
                let reason = probe.diag.err_reason.as_deref().unwrap_or("stale");
                warn_platforms_lite_stale(clean_id, reason, "cache:stale", Some(&probe), start);
            }
            Ok(lite_result(clean_id, platforms, from_cache, stale))
        }
        Err(ShallowError::Parse(e)) => {
            fail(&crate::log_support::short_reason(&e));
            Err(e.into())
        }
        Err(ShallowError::PayloadCorrupt(e)) => {
            if let Ok(db) = state.db() {
                let _ = db.touch_app_detail(clean_id, crate::now_secs());
            }
            fail(&crate::log_support::short_reason(&e));
            Err(e.into())
        }
        Err(ShallowError::Miss(ShallowMiss::NotModifiedWithoutCache)) => {
            fail("304_no_cache");
            Err("304 响应但本地未找到缓存数据".into())
        }
        Err(ShallowError::Miss(ShallowMiss::OfflineWithoutCache)) => {
            // 已知存在的仓库在 `releases/latest` 返回确定性 404 = 零发布，确认 Other。
            if probe.diag.status == Some(404) {
                if let Ok(db) = state.db() {
                    if repo_known_to_exist(state, &db, clean_id) {
                        write_back_lite_platforms(
                            state,
                            &db,
                            clean_id,
                            &probe.owner,
                            &probe.repo,
                            &[],
                            None,
                        );
                        return Ok(lite_result(clean_id, Vec::new(), false, None));
                    }
                }
            }
            let reason = probe.diag.err_reason.as_deref().unwrap_or("offline");
            warn_platforms_lite_stale(clean_id, reason, "empty:stale", Some(&probe), start);
            Ok(lite_result(clean_id, Vec::new(), false, Some(true)))
        }
    }
}

// ---------------------------------------------------------------------------
// 轻量 Release（更新检查与关注提醒）
// ---------------------------------------------------------------------------

/// 轻量获取最新 Release（不拉 README、仓库详情或校验清单）。`force_refresh == false` 纯本地三级回退
///（`update_results` → `app_details` → 目录默认版本）；`true` 时跨 forge 探查并落缓存副作用。
pub(crate) async fn resolve_latest_release_lightweight(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
    force_refresh: bool,
) -> Result<LightweightRelease, String> {
    if !force_refresh {
        return local_latest_release(state, clean_id)
            .ok_or_else(|| "检查更新网络不可达且无本地缓存".to_string());
    }
    if let Some(coord) = non_github_coord(clean_id) {
        let token = host_token(state, &coord);
        let info = sources
            .provider(coord.forge)
            .fetch_latest_release(&coord.host, &coord.owner, &coord.repo, token.as_deref())
            .await?;
        return Ok(LightweightRelease {
            tag: info.tag_name,
            body: info.body.unwrap_or_default(),
            published_at: info.published_at.as_deref().and_then(parse_rfc3339_unix),
        });
    }
    github_latest_release_lightweight(state, sources, clean_id).await
}

fn local_latest_release(state: &AppState, clean_id: &str) -> Option<LightweightRelease> {
    let release = |tag: String, body: String| LightweightRelease {
        tag,
        body,
        published_at: None,
    };
    if let Ok(db) = state.db() {
        if let Ok(Some((latest, changelog))) = db.get_cached_update_version(clean_id) {
            return Some(release(latest, changelog));
        }
        if let Ok(Some(cached)) = db.get_app_detail(clean_id, None) {
            return Some(release(cached.core.latest_version, cached.changelog));
        }
    }
    state
        .catalog
        .get_catalog_item(clean_id)
        .map(|item| release(item.default_version, String::new()))
}

/// 304 命中优先解析缓存载荷；载荷损坏时退回 `stale_row` / 目录默认版本兜底。
fn resolve_update_shallow_with_fallback(
    outcome: &EtagGetOutcome,
    cached_payload: Option<&str>,
    stale_row: Option<&AppDetail>,
    catalog_default_version: Option<&str>,
) -> Result<ShallowRelease, ShallowError> {
    match decide_shallow_release(outcome, cached_payload, stale_row, catalog_default_version) {
        Err(ShallowError::PayloadCorrupt(_)) => {
            decide_shallow_release(outcome, None, stale_row, catalog_default_version)
        }
        other => other,
    }
}

async fn github_latest_release_lightweight(
    state: &AppState,
    sources: DetailSources<'_>,
    clean_id: &str,
) -> Result<LightweightRelease, String> {
    let ctx = format!("op=check_updates app={}", clean_id);
    let probe = match probe_github_release(state, sources, clean_id, &ctx).await {
        Ok(p) => p,
        Err(_) => {
            let row = state
                .db()
                .ok()
                .and_then(|db| db.get_app_detail(clean_id, None).ok().flatten());
            return match row {
                Some(fallback) => Ok(LightweightRelease {
                    tag: fallback.core.latest_version,
                    body: fallback.changelog,
                    published_at: None,
                }),
                None => Err(format!("未识别的应用坐标: {}", clean_id)),
            };
        }
    };
    let catalog_default = match probe.outcome {
        EtagGetOutcome::Fresh { .. } => None,
        _ => state
            .catalog
            .get_catalog_item(clean_id)
            .map(|c| c.default_version),
    };
    let mut fresh_text = match &probe.outcome {
        EtagGetOutcome::Fresh { text, .. } => Some(text.clone()),
        _ => None,
    };
    let mut resolution = resolve_update_shallow_with_fallback(
        &probe.outcome,
        probe.cached_payload.as_deref(),
        probe.stale_row.as_ref(),
        catalog_default.as_deref(),
    );
    // 304 但本地载荷损坏/缺失且无兜底时，剥除坏 ETag 发起一次无条件请求自愈。
    if matches!(
        resolution,
        Err(ShallowError::PayloadCorrupt(_))
            | Err(ShallowError::Miss(ShallowMiss::NotModifiedWithoutCache))
    ) {
        let (retry, _) = get_release(state, sources, &probe.endpoint, None, &ctx).await;
        fresh_text = match &retry {
            EtagGetOutcome::Fresh { text, .. } => Some(text.clone()),
            _ => None,
        };
        resolution = decide_shallow_release(
            &retry,
            None,
            probe.stale_row.as_ref(),
            catalog_default.as_deref(),
        );
    }
    match resolution {
        Ok(rel) => {
            if let Ok(db) = state.db() {
                apply_release_cache_effects(
                    &db,
                    &probe.endpoint,
                    clean_id,
                    rel.touch,
                    rel.cache_to_save,
                    crate::now_secs(),
                );
            }
            let published_at = fresh_text
                .as_deref()
                .and_then(|t| release_published_at_from_payload(t, &rel.tag));
            Ok(LightweightRelease {
                tag: rel.tag,
                body: rel.body,
                published_at,
            })
        }
        Err(ShallowError::Parse(e)) => Err(e),
        Err(ShallowError::PayloadCorrupt(_))
        | Err(ShallowError::Miss(ShallowMiss::NotModifiedWithoutCache)) => {
            Err("304 响应但未能提取到有效版本信息".to_string())
        }
        Err(ShallowError::Miss(ShallowMiss::OfflineWithoutCache)) => {
            Err("检查更新网络不可达且无本地缓存".to_string())
        }
    }
}

pub(crate) fn parse_rfc3339_unix(raw: &str) -> Option<i64> {
    let clean = raw.trim();
    if clean.is_empty() {
        return None;
    }
    time::OffsetDateTime::parse(clean, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|t| t.unix_timestamp())
}

/// 从 `releases/latest` 响应体取发布时间（Unix 秒）；tag 与 `version` 不符时视为未知，
/// 避免拿旧载荷的时间去判定新版本。
fn release_published_at_from_payload(payload: &str, version: &str) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    if v.get("tag_name")?.as_str()?.trim() != version.trim() {
        return None;
    }
    parse_rfc3339_unix(v.get("published_at")?.as_str()?)
}

/// 最新 Release 的发布时间：读手动检查时落库的 GitHub `releases/latest` ETag 载荷；
/// 无载荷或非 GitHub 来源时为 `None`。
pub(crate) fn cached_release_published_at(
    state: &AppState,
    clean_id: &str,
    version: &str,
) -> Option<i64> {
    let coords = state.catalog.get_repo_coordinates(clean_id).ok()?;
    let ep = crate::github::github_latest_release_endpoint(&coords.owner, &coords.repo);
    let payload = state.db().ok()?.get_cached_payload(&ep).ok().flatten()?;
    release_published_at_from_payload(&payload, version)
}

#[cfg(test)]
#[path = "detail_service_tests.rs"]
mod tests;
