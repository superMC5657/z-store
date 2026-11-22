use crate::icons::{IconFetchCtx, IconLane, RepoCoord};
use crate::models::{AppCore, AppSummary};
use crate::repositories::card_hydrator::{self, CardWrite, LocalHitSource, RemoteRow};
use crate::AppState;
use tauri::{AppHandle, State};

/// 在线搜索回包：行 + 后端拍板的 search_id 回声。
/// 前端以此 sid 为准做图标门控（以后端为准，后端说什么前端认什么）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct OnlineSearchResult {
    pub rows: Vec<AppSummary>,
    pub sid: String,
    /// 关键词搜索联网失败、回退旧载荷时为 `true`；前端据此不把这批行当新鲜结果写入列表缓存。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_stale: bool,
    /// 本页 `repo_card_cache` 已确认无可安装资产（平台为空）的未收录行规范 id。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub confirmed_other_ids: Vec<String>,
    /// 本页私有仓库的规范 id（登出时前端据此清理内存私有卡）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub private_ids: Vec<String>,
}

impl OnlineSearchResult {
    fn rows_only(rows: Vec<AppSummary>, sid: String) -> Self {
        Self {
            rows,
            sid,
            is_stale: false,
            confirmed_other_ids: Vec::new(),
            private_ids: Vec::new(),
        }
    }
}

/// 单仓直查命中：卡片 + 平台已确认 Other + 私有标记 + 是否需后台流式补图。
struct DirectLookupHit {
    item: AppSummary,
    confirmed_other: bool,
    is_private: bool,
    needs_icon_stream: bool,
}

/// 派生搜索结果后台流式图标探测（`Search` 通道世代推进后协作取消）。
fn spawn_search_icon_stream(
    app_handle: &AppHandle,
    candidates: Vec<RepoCoord>,
    token: Option<String>,
    search_id: &str,
    gen: u64,
) {
    crate::icons::spawn_icon_fetch_lane(
        app_handle,
        IconFetchCtx::Search {
            search_id: search_id.to_string(),
            gen,
        },
        candidates,
        token,
    );
}

/// GitHub 单仓直查：优先命中本地缓存，未命中再请求 `/repos/{owner}/{repo}` 并回填详情与平台。
/// 缺确认图标时由调用方异步流式补图；失败返回 `None` 以便回退关键词搜索。
async fn direct_github_lookup(
    state: &AppState,
    coord: &crate::forge::UniversalRepoCoord,
    is_force: bool,
) -> Option<DirectLookupHit> {
    let target = RepoCoord {
        id: coord.to_app_id(),
        owner: coord.owner.clone(),
        repo: coord.repo.clone(),
    };
    let pre = card_hydrator::preload(state, std::slice::from_ref(&target), true, |_| {}).await;
    let pre_confirmed = pre.confirmed_icon(&target);
    let (cached_etag, cached_payload, soft_fresh_payload) =
        pre.etag_inputs(&target, crate::now_secs(), is_force);
    let local_hit = if is_force {
        None
    } else {
        pre.local_hit(
            &state.catalog,
            &target,
            pre_confirmed.as_deref(),
            soft_fresh_payload.as_deref(),
            true,
        )
    };
    let from_repo_card = matches!(&local_hit, Some((_, LocalHitSource::RepoCard)));
    let (item, etag_write, touched_url, is_stale_hit) = match local_hit {
        Some((hit, _)) => (hit, None, None, false),
        None => {
            let token = crate::commands::resolve_active_github_token(state);
            let out = state
                .catalog
                .fetch_online_repo_with_etag_outcome(
                    &target.owner,
                    &target.repo,
                    token.as_deref(),
                    Some(pre_confirmed.clone().unwrap_or_default()),
                    cached_etag,
                    cached_payload.clone(),
                    false,
                )
                .await
                .ok()?;
            (out.item, out.etag_write, out.touched_url, out.is_stale)
        }
    };
    let payload_private = etag_write
        .as_ref()
        .map(|(_, _, text)| text.as_str())
        .or(cached_payload.as_deref())
        .and_then(crate::github::search::repo_json_is_private);
    let card = if from_repo_card || is_stale_hit {
        CardWrite::Skip
    } else {
        CardWrite::Upsert {
            is_private: payload_private,
        }
    };
    let row = RemoteRow {
        summary: item,
        card,
        project_curated: true,
    };
    let hydrated = card_hydrator::write_through(state, vec![row], Some(pre.icons()), |db| {
        let now = crate::now_secs();
        if let Some((url, etag, text)) = &etag_write {
            let _ = db.save_etag(url, etag, text, now);
        }
        if let Some(url) = &touched_url {
            let _ = db.touch_etag(url, now);
        }
    })
    .await
    .pop()?;
    let card_private = from_repo_card && hydrated.cached_private;
    let item = hydrated.summary;
    let needs_icon_stream = !state.catalog.is_cataloged(&item.core.id)
        && !item.core.icon.contains("simpleicons.org")
        && item.core.icon.trim().is_empty();
    Some(DirectLookupHit {
        item,
        confirmed_other: hydrated.confirmed_other,
        is_private: payload_private.unwrap_or(card_private),
        needs_icon_stream,
    })
}

#[tauri::command]
pub async fn search_apps(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> crate::AppResult<Vec<AppSummary>> {
    let hidden_ids: std::collections::HashSet<String> = super::hidden_rule_ids(&state)?;

    let results = state.catalog.search_local_catalog(&query);
    let filtered: Vec<AppSummary> = if hidden_ids.is_empty() {
        results
    } else {
        results
            .into_iter()
            .filter(|a| !hidden_ids.contains(&a.core.id))
            .collect()
    };
    let paged = crate::github::catalog_feed_score::paginate_optional(filtered, limit, offset);
    Ok(paged)
}

/// 在线搜索：支持多源/GitHub 单仓直查（第 1 页返回单条）与 GitHub 关键词分页搜索。
/// 非强制刷新走 ETag 条件请求并合并本地缓存，缺图标的未收录项后台流式补齐。
#[tauri::command(rename_all = "camelCase")]
pub async fn search_apps_online(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    query: String,
    search_id: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    force_refresh: Option<bool>,
) -> crate::AppResult<OnlineSearchResult> {
    let is_force = force_refresh.unwrap_or(false);
    let search_start = std::time::Instant::now();
    let current_gen = IconLane::Search.advance();
    let actual_search_id = search_id.unwrap_or_else(|| current_gen.to_string());
    let eff_page = crate::config::LimitsConfig::normalize_online_search_page(page);
    let hidden_ids: std::collections::HashSet<String> = super::hidden_rule_ids(&state)?;
    // 优先检查是否为多源或单仓仓库直查坐标
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&query) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            // 单仓直查在 page > 1 时返回空页。
            if eff_page > 1 {
                return Ok(OnlineSearchResult::rows_only(
                    Vec::new(),
                    actual_search_id.clone(),
                ));
            }
            let host_token = state.db().ok().and_then(|db| {
                crate::oauth::resolve_host_token(&db, coord.forge, &coord.host, &state.github_token)
            });
            if let Ok(repo_info) =
                crate::forge::ForgeRegistry::fetch_repo(&coord, host_token.as_deref()).await
            {
                let release_res = crate::forge::ForgeRegistry::fetch_latest_release(
                    &coord,
                    host_token.as_deref(),
                )
                .await;
                let release_ok = release_res.is_ok();
                let (latest_ver, platforms) = match release_res {
                    Ok(r) => {
                        let plats = crate::github::detail_assets::platforms_from_assets(&r.assets);
                        (r.tag_name, plats)
                    }
                    Err(_) => ("latest".to_string(), Vec::new()),
                };
                let mut ev =
                    crate::z_log::WideEvent::new("search", "online ok").with_started(search_start);
                ev.field("query", crate::log_support::short_reason(&query))
                    .field("hits", 1)
                    .dev("mode", "forge")
                    .dev("forge", coord.forge.as_str())
                    .dev("force", is_force);
                ev.info();
                let app_id = coord.to_app_id();
                if hidden_ids.contains(&app_id) {
                    return Ok(OnlineSearchResult::rows_only(
                        Vec::new(),
                        actual_search_id.clone(),
                    ));
                }
                let icon_coord = RepoCoord {
                    id: app_id.clone(),
                    owner: coord.owner.clone(),
                    repo: coord.repo.clone(),
                };
                let icon = card_hydrator::confirmed_icon(&state, &icon_coord)
                    .await
                    .unwrap_or_default();
                let mut row = AppSummary {
                    core: AppCore {
                        id: app_id,
                        name: repo_info.name,
                        description_en: repo_info.description.clone(),
                        owner: coord.owner,
                        repo: coord.repo,
                        icon,
                        icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                        description: repo_info
                            .description
                            .unwrap_or_else(|| "跨平台开源项目".to_string()),
                        stars: repo_info.stars,
                        forks: repo_info.forks,
                        license: "OpenSource".to_string(),
                        latest_version: latest_ver,
                        category: "external".to_string(),
                        category_name: "跨平台开源".to_string(),
                        is_verified: false,
                        forge: Some(coord.forge.as_str().to_string()),
                        forge_host: Some(coord.host),
                        homepage: repo_info.homepage.clone(),
                        platforms,
                        is_cataloged: None,
                        source: None,
                        status: None,
                        added_at: None,
                        alternatives: Vec::new(),
                    },
                };
                let confirmed_other = release_ok && row.core.platforms.is_empty();
                let written = card_hydrator::upsert_repo_card(&state, &row, confirmed_other, None);
                state.catalog.stamp_summary(&mut row);
                let id = row.core.id.to_lowercase();
                let mut result = OnlineSearchResult::rows_only(vec![row], actual_search_id.clone());
                if confirmed_other && written {
                    result.confirmed_other_ids.push(id);
                }
                return Ok(result);
            }
        } else if query.contains('/')
            || query.starts_with("https://")
            || query.starts_with("gh:")
            || query.starts_with("github:")
        {
            // 单仓直查在 page > 1 时返回空页。
            if eff_page > 1 {
                return Ok(OnlineSearchResult::rows_only(
                    Vec::new(),
                    actual_search_id.clone(),
                ));
            }
            if let Some(hit) = direct_github_lookup(&state, &coord, is_force).await {
                if hidden_ids.contains(&hit.item.core.id) {
                    return Ok(OnlineSearchResult::rows_only(
                        Vec::new(),
                        actual_search_id.clone(),
                    ));
                }
                let mut ev =
                    crate::z_log::WideEvent::new("search", "online ok").with_started(search_start);
                ev.field("query", crate::log_support::short_reason(&query))
                    .field("hits", 1)
                    .dev("mode", "direct")
                    .dev("force", is_force);
                ev.info();
                if hit.needs_icon_stream {
                    let token = crate::commands::resolve_active_github_token(&state);
                    let icon_coord = RepoCoord {
                        id: hit.item.core.id.to_lowercase(),
                        owner: hit.item.core.owner.clone(),
                        repo: hit.item.core.repo.clone(),
                    };
                    spawn_search_icon_stream(
                        &app_handle,
                        vec![icon_coord],
                        token,
                        &actual_search_id,
                        current_gen,
                    );
                }
                let id = hit.item.core.id.to_lowercase();
                let mut result =
                    OnlineSearchResult::rows_only(vec![hit.item], actual_search_id.clone());
                if hit.confirmed_other {
                    result.confirmed_other_ids.push(id.clone());
                }
                if hit.is_private {
                    result.private_ids.push(id);
                }
                return Ok(result);
            }
        }
    }

    let token = crate::commands::resolve_active_github_token(&state);

    // 关键词搜索走 ETag 条件请求，await 期间不持 DB 锁。
    let endpoint = crate::github::search::online_search_endpoint(&query, page, per_page);
    let (cached_etag, cached_payload) = match (&endpoint, state.db()) {
        (Some(ep), Ok(db)) => {
            let etag = if is_force {
                None
            } else {
                db.get_etag(ep).ok().flatten()
            };
            (etag, db.get_cached_payload(ep).ok().flatten())
        }
        _ => (None, None),
    };
    let fetched = match state
        .catalog
        .search_github_online(
            &query,
            token.as_deref(),
            page,
            per_page,
            cached_etag.as_deref(),
            cached_payload.as_deref(),
            None,
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let mut ev =
                crate::z_log::WideEvent::new("search", "online failed").with_started(search_start);
            ev.field("query", crate::log_support::short_reason(&query))
                .field("reason", crate::log_support::short_reason(&e))
                .dev("page", eff_page)
                .dev("force", is_force);
            ev.warn();
            return Err(e.into());
        }
    };
    let search_stale = fetched.is_stale;
    let search_not_modified = fetched.touched_url.is_some();
    let private_set: std::collections::HashSet<String> = fetched.private_ids.into_iter().collect();
    let repo_seeds: Vec<(String, String)> = if search_stale {
        Vec::new()
    } else {
        fetched
            .repo_payloads
            .into_iter()
            .filter(|(id, _, _)| !state.catalog.is_cataloged(id))
            .map(|(_, url, json)| (url, json))
            .collect()
    };

    // 回退旧载荷的 stale 结果不刷新单仓富卡新鲜度。
    let rows: Vec<RemoteRow> = fetched
        .summaries
        .into_iter()
        .map(|summary| {
            let is_private = Some(private_set.contains(&summary.core.id.to_lowercase()));
            RemoteRow {
                summary,
                card: if search_stale {
                    CardWrite::Skip
                } else {
                    CardWrite::Upsert { is_private }
                },
                project_curated: true,
            }
        })
        .collect();
    let etag_write = fetched.etag_write;
    let touched_url = fetched.touched_url;
    let hydrated = card_hydrator::write_through(&state, rows, None, |db| {
        let now = crate::now_secs();
        if let Some((url, etag, text)) = &etag_write {
            let _ = db.save_etag(url, etag, text, now);
        }
        if let Some(url) = &touched_url {
            let _ = db.touch_etag(url, now);
        }
        if !repo_seeds.is_empty() {
            let _ = db.seed_repo_payloads_batch(&repo_seeds, now);
        }
    })
    .await;
    let confirmed_other_set: std::collections::HashSet<String> = hydrated
        .iter()
        .filter(|h| h.confirmed_other)
        .map(|h| h.summary.core.id.to_lowercase())
        .collect();

    let probe_cap = crate::config::get_project_config()
        .limits
        .clamp_online_search_per_page(per_page);
    let candidates: Vec<RepoCoord> = hydrated
        .iter()
        .filter(|h| h.needs_icon_probe(&state.catalog))
        .take(probe_cap)
        .map(|h| h.icon_coord())
        .collect();
    let results: Vec<AppSummary> = hydrated.into_iter().map(|h| h.summary).collect();

    let mut ev = crate::z_log::WideEvent::new("search", "online ok").with_started(search_start);
    ev.field("query", crate::log_support::short_reason(&query))
        .field("hits", results.len())
        .dev("mode", "keyword")
        .dev("page", eff_page)
        .dev("force", is_force)
        .dev("not_modified", search_not_modified)
        .dev("stale", search_stale)
        .dev("icon_jobs", candidates.len());
    ev.info();

    let filtered_results: Vec<AppSummary> = if hidden_ids.is_empty() {
        results
    } else {
        results
            .into_iter()
            .filter(|a| !hidden_ids.contains(&a.core.id))
            .collect()
    };

    spawn_search_icon_stream(
        &app_handle,
        candidates,
        token,
        &actual_search_id,
        current_gen,
    );

    let row_ids: Vec<String> = filtered_results
        .iter()
        .map(|r| r.core.id.to_lowercase())
        .collect();
    Ok(OnlineSearchResult {
        confirmed_other_ids: row_ids
            .iter()
            .filter(|id| confirmed_other_set.contains(*id))
            .cloned()
            .collect(),
        private_ids: row_ids
            .iter()
            .filter(|id| private_set.contains(*id))
            .cloned()
            .collect(),
        rows: filtered_results,
        sid: actual_search_id.clone(),
        is_stale: search_stale,
    })
}

/// 趋势未收录行 enrichment 入参：待查仓库坐标（与 TrendRepo.owner/repo 对齐）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrendEnrichRequest {
    pub owner: String,
    pub repo: String,
}

/// 校验趋势 enrich 仓库段：非空、非 `.`/`..` 且不含路径分隔符或空白控制字符。
fn valid_enrich_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg != "."
        && seg != ".."
        && !seg.contains(['/', '\\', ':', '?', '#'])
        && !seg.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// 规范化并截断趋势 enrich 目标列表（最多 40 项），非法坐标以 `None` 占位以保持位置对齐。
fn enrich_targets(repos: Vec<TrendEnrichRequest>) -> Vec<Option<RepoCoord>> {
    repos
        .into_iter()
        .take(40)
        .map(|r| {
            let owner = r.owner.trim().to_string();
            let repo = r.repo.trim().to_string();
            if !valid_enrich_segment(&owner) || !valid_enrich_segment(&repo) {
                return None;
            }
            let id = format!("{}/{}", owner.to_lowercase(), repo.to_lowercase());
            crate::forge::coord::canonical_app_id(&id)?;
            Some(RepoCoord { id, owner, repo })
        })
        .collect()
}

struct EnrichBatchJob {
    coord: RepoCoord,
    pre: Option<String>,
    cached_etag: Option<String>,
    cached_payload: Option<String>,
    fallback_detail: Option<AppSummary>,
}

/// 单仓直查结果：卡片、待落库 ETag、304 待 touch 端点，以及是否为远端（含 `304`）成功结果（失败回退为 `false`）。
#[derive(Default)]
struct EnrichFetchOutcome {
    item: Option<AppSummary>,
    etag: Option<(String, String, String)>,
    touched_url: Option<String>,
    fetched: bool,
}

/// 批量直查趋势仓库详情（并发上限 5，单仓失败回退本地详情或 `None`）。
async fn fetch_enrich_batch(
    catalog: &crate::github::CatalogService,
    token: Option<String>,
    timeout_each: std::time::Duration,
    jobs: Vec<EnrichBatchJob>,
) -> Vec<EnrichFetchOutcome> {
    use futures_util::StreamExt;
    futures_util::stream::iter(jobs.into_iter().map(|job| {
        let token = token.clone();
        async move {
            if job.coord.owner.is_empty() || job.coord.repo.is_empty() {
                return EnrichFetchOutcome::default();
            }
            match tokio::time::timeout(
                timeout_each,
                catalog.fetch_online_repo_with_etag_outcome(
                    &job.coord.owner,
                    &job.coord.repo,
                    token.as_deref(),
                    job.pre,
                    job.cached_etag,
                    job.cached_payload,
                    // 首包只取仓库元数据快返；图标统一由后台 `fetch_icons_stream(Trend)` 补探一次。
                    false,
                ),
            )
            .await
            {
                Ok(Ok(out)) => EnrichFetchOutcome {
                    item: Some(out.item),
                    etag: out.etag_write,
                    touched_url: out.touched_url,
                    fetched: !out.is_stale,
                },
                Ok(Err(_)) | Err(_) => EnrichFetchOutcome {
                    item: job.fallback_detail,
                    etag: None,
                    touched_url: None,
                    fetched: false,
                },
            }
        }
    }))
    .buffered(5)
    .collect()
    .await
}

/// 批量丰富趋势榜未收录仓库卡片，并在后台流式补齐缺失图标（每次调用推进趋势通道世代 `IconLane::Trend`）。
/// 最多处理前 40 项，单仓失败返回 `None` 以保持位置对齐。
#[tauri::command(rename_all = "camelCase")]
pub async fn enrich_trend_repos(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    repos: Vec<TrendEnrichRequest>,
    board: Option<String>,
    force_refresh: Option<bool>,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    let is_force = force_refresh.unwrap_or(false);
    let enrich_start = std::time::Instant::now();
    let board_name = board.unwrap_or_default().trim().to_lowercase();
    let current_gen = IconLane::Trend.advance();
    let slots = enrich_targets(repos);
    let requested = slots.len();
    let targets: Vec<RepoCoord> = slots.iter().flatten().cloned().collect();
    if targets.is_empty() {
        return Ok(vec![None; requested]);
    }
    let token = crate::commands::resolve_active_github_token(&state);
    let timeout_each = crate::config::api_timeout_or(std::time::Duration::from_secs(10));
    let catalog = &state.catalog;
    // 短锁预读本地富卡与 ETag（并发网络请求期间不持 DB 锁）。
    let pre = card_hydrator::preload(&state, &targets, true, |_| {}).await;
    let pre_confirmed: Vec<Option<String>> =
        targets.iter().map(|t| pre.confirmed_icon(t)).collect();
    let mut local_hits: Vec<Option<AppSummary>> = vec![None; targets.len()];
    // 需写回 `repo_card_cache` 的结果下标（单仓富卡自身命中与失败回退不刷新新鲜度）。
    let mut card_writable: Vec<bool> = vec![false; targets.len()];
    let mut remote_indices: Vec<usize> = Vec::new();
    let mut batch_jobs: Vec<EnrichBatchJob> = Vec::new();
    let now = crate::now_secs();
    for (idx, coord) in targets.iter().enumerate() {
        let (cached_etag, cached_payload, soft_fresh_payload) =
            pre.etag_inputs(coord, now, is_force);
        if !is_force {
            if let Some((hit, source)) = pre.local_hit(
                catalog,
                coord,
                pre_confirmed[idx].as_deref(),
                soft_fresh_payload.as_deref(),
                true,
            ) {
                card_writable[idx] =
                    matches!(source, LocalHitSource::Detail | LocalHitSource::Payload);
                local_hits[idx] = Some(hit);
                continue;
            }
        }
        remote_indices.push(idx);
        batch_jobs.push(EnrichBatchJob {
            coord: coord.clone(),
            pre: Some(pre_confirmed[idx].clone().unwrap_or_default()),
            cached_etag,
            cached_payload,
            fallback_detail: pre.detail_fallback(coord, pre_confirmed[idx].as_deref()),
        });
    }
    let remote_results = if batch_jobs.is_empty() {
        Vec::new()
    } else {
        fetch_enrich_batch(catalog, token.clone(), timeout_each, batch_jobs).await
    };
    let mut results: Vec<Option<AppSummary>> = local_hits;
    let mut etags_to_save: Vec<(String, String, String)> = Vec::new();
    let mut etags_to_touch: Vec<String> = Vec::new();
    for (idx, outcome) in remote_indices.into_iter().zip(remote_results) {
        results[idx] = outcome.item;
        card_writable[idx] = outcome.fetched;
        if let Some(entry) = outcome.etag {
            etags_to_save.push(entry);
        }
        if let Some(url) = outcome.touched_url {
            etags_to_touch.push(url);
        }
    }

    // 落库新 ETag 并批量回填富卡与图标周期状态。
    let mut positions: Vec<usize> = Vec::new();
    let mut rows: Vec<RemoteRow> = Vec::new();
    for (idx, slot) in results.iter_mut().enumerate() {
        if let Some(summary) = slot.take() {
            positions.push(idx);
            rows.push(RemoteRow {
                summary,
                card: if card_writable[idx] {
                    CardWrite::Upsert { is_private: None }
                } else {
                    CardWrite::Skip
                },
                project_curated: false,
            });
        }
    }
    let hydrated = card_hydrator::write_through(&state, rows, Some(pre.icons()), |db| {
        let now = crate::now_secs();
        for (url, etag, text) in &etags_to_save {
            let _ = db.save_etag(url, etag, text, now);
        }
        for url in &etags_to_touch {
            let _ = db.touch_etag(url, now);
        }
    })
    .await;
    for (idx, row) in positions.into_iter().zip(hydrated) {
        results[idx] = Some(row.summary);
    }

    // 为未收录且无确认图标的仓库派发后台流式补图。
    let icon_coords: Vec<RepoCoord> = targets
        .into_iter()
        .zip(pre_confirmed)
        .filter(|(coord, pre)| !state.catalog.is_cataloged(&coord.id) && pre.is_none())
        .map(|(coord, _)| coord)
        .collect();
    crate::icons::spawn_icon_fetch_lane(
        &app_handle,
        IconFetchCtx::Trend {
            board: board_name.clone(),
            gen: current_gen,
        },
        icon_coords,
        token,
    );

    let hits = results.iter().filter(|r| r.is_some()).count();
    let missed = requested.saturating_sub(hits);
    if missed > 0 {
        let mut ev =
            crate::z_log::WideEvent::new("trends", "enrich partial").with_started(enrich_start);
        ev.field("requested", requested)
            .field("hits", hits)
            .field("missed", missed)
            .dev("board", &board_name)
            .dev("force", is_force);
        ev.warn();
    }
    // 按入参位置回填：非法坐标槽位保持 `None`。
    let mut valid_results = results.into_iter();
    Ok(slots
        .iter()
        .map(|slot| slot.as_ref().and_then(|_| valid_results.next().flatten()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrich_targets_keeps_positions_and_rejects_dirty_segments() {
        let req = |owner: &str, repo: &str| TrendEnrichRequest {
            owner: owner.to_string(),
            repo: repo.to_string(),
        };
        let slots = enrich_targets(vec![
            req(" Owner ", " Repo "),
            req("", "repo"),
            req(".", "repo"),
            req("owner", ".."),
            req("own/er", "repo"),
            req("owner", "re po"),
            req("owner", "re\u{7}po"),
            req("gh:owner", "repo"),
            req("owner", "repo?x=1"),
            req("ok", "fine"),
        ]);
        assert_eq!(slots.len(), 10, "结果必须与入参逐位对齐");
        let first = slots[0].as_ref().expect("合法坐标保留");
        assert_eq!(
            (first.id.as_str(), first.owner.as_str(), first.repo.as_str()),
            ("owner/repo", "Owner", "Repo")
        );
        for (i, slot) in slots.iter().enumerate().take(9).skip(1) {
            assert!(slot.is_none(), "slot {i} 应被拒绝");
        }
        assert_eq!(slots[9].as_ref().map(|c| c.id.as_str()), Some("ok/fine"));
    }
}
