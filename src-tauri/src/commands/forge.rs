use super::resolve_active_github_token;
use crate::models::{DeveloperProfile, StarredFeedCacheEntry, StarredPageResult};
use crate::AppState;
use tauri::{AppHandle, State};

/// 开发者主页：通过 ETag 条件请求拉取用户信息与仓库列表并更新缓存。
#[tauri::command]
pub async fn get_developer_profile(
    state: State<'_, AppState>,
    developer: String,
) -> crate::AppResult<DeveloperProfile> {
    let token = resolve_active_github_token(&state);
    let dev = crate::github::validate_github_username(&developer)?;
    let user_key = crate::github::CatalogService::dev_user_endpoint(dev);
    let repos_key = crate::github::CatalogService::dev_repos_endpoint(dev);
    let (user_cache, repos_cache) = {
        let db = state.db()?;
        let read = |endpoint: &str| {
            let payload = db
                .get_cached_payload(endpoint)
                .ok()
                .flatten()
                .filter(|p| !p.trim().is_empty());
            // 无载荷可恢复时不发条件请求，避免 304 后无数据可用。
            let etag = payload
                .as_ref()
                .and_then(|_| db.get_etag(endpoint).ok().flatten());
            crate::github::developer_profile::CachedEtagPayload { etag, payload }
        };
        (read(&user_key), read(&repos_key))
    };
    let fetched = state
        .catalog
        .fetch_developer_profile_with_cache(dev, token.as_deref(), user_cache, repos_cache, None)
        .await?;
    if !fetched.etag_writes.is_empty() || !fetched.touched.is_empty() {
        if let Ok(db) = state.db() {
            let now = crate::now_secs();
            for w in &fetched.etag_writes {
                let _ = db.save_etag(&w.url, &w.etag, &w.payload, w.timestamp);
            }
            for endpoint in &fetched.touched {
                let _ = db.touch_etag(endpoint, now);
            }
        }
    }
    Ok(fetched.profile)
}

/// Star 列表单页查询（按 Star 时间倒序）：走 ETag 条件请求，失败时回退旧载荷并标 `is_stale`。
/// 图标在后台流式补齐；`force_refresh` 仍携带 ETag 进行条件校验。
#[tauri::command(rename_all = "camelCase")]
pub async fn list_github_starred(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    username: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    force_refresh: Option<bool>,
) -> crate::AppResult<StarredPageResult> {
    let start = std::time::Instant::now();
    let token = resolve_active_github_token(&state);
    let page = page.unwrap_or(1).max(1);
    let per_page = per_page.unwrap_or(20);
    let url = crate::github::developer_starred::starred_url_for_token(
        username.as_deref(),
        token.as_deref(),
        page,
        per_page,
    )?;
    let (cached_etag, cached_payload) = {
        let db = state.db()?;
        (
            db.get_etag(&url).ok().flatten(),
            db.get_cached_payload(&url).ok().flatten(),
        )
    };
    let is_self_query = username
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .is_none();
    let fetched = match state
        .catalog
        .fetch_starred_page_diag(
            username.as_deref(),
            token.as_deref(),
            page,
            per_page,
            cached_etag.as_deref(),
            cached_payload.as_deref(),
            None,
        )
        .await
    {
        Ok(out) => out,
        Err((err, recoverable)) => {
            let affinity_fallback = if is_self_query && recoverable {
                state.db().ok().and_then(|db| {
                    crate::github::developer_starred::slice_self_starred_from_affinity_cache(
                        &db, page, per_page,
                    )
                })
            } else {
                None
            };
            match affinity_fallback {
                Some(fallback_page) => crate::github::developer_starred::StarredFetchOutcome {
                    page: fallback_page,
                    etag_write: None,
                    touched_url: None,
                    is_stale: Some(true),
                },
                None => return Err(err.into()),
            }
        }
    };
    let not_modified = fetched.touched_url.is_some();
    let persist_cards = fetched.is_stale != Some(true);
    let etag_write = fetched.etag_write;
    let touched_url = fetched.touched_url;
    let repo_seeds: Vec<(String, String)> = if persist_cards {
        fetched
            .page
            .repos
            .iter()
            .filter(|r| !state.catalog.is_cataloged(&r.coord.id))
            .map(|r| {
                (
                    crate::github::github_repo_endpoint(&r.coord.owner, &r.coord.repo),
                    r.payload.clone(),
                )
            })
            .collect()
    } else {
        Vec::new()
    };
    let cards = crate::repositories::card_hydrator::cards_from_repo_payloads_offloaded(
        &state,
        fetched.page.repos,
        persist_cards,
        move |db| {
            let now = crate::now_secs();
            if let Some((u, etag, text)) = &etag_write {
                let _ = db.save_etag(u, etag, text, now);
            }
            if let Some(u) = &touched_url {
                let _ = db.touch_etag(u, now);
            }
            if !repo_seeds.is_empty() {
                let _ = db.seed_repo_payloads_batch(&repo_seeds, now);
            }
        },
    )
    .await;
    let rows = cards.rows;
    crate::icons::spawn_starred_icon_stream(&app_handle, cards.need_icon, token, page == 1);
    if fetched.is_stale == Some(true) {
        let mut ev =
            crate::z_log::WideEvent::new("detail", "starred page stale").with_started(start);
        ev.field("page", page)
            .dev("force", force_refresh.unwrap_or(false));
        ev.warn();
    } else {
        let mut ev = crate::z_log::WideEvent::new("detail", "starred page ok").with_started(start);
        ev.field("page", page)
            .field("rows", rows.len())
            .dev("not_modified", not_modified)
            .dev("force", force_refresh.unwrap_or(false));
        ev.emit(log::Level::Debug);
    }
    Ok(StarredPageResult {
        rows,
        has_more: fetched.page.has_more,
        is_stale: fetched.is_stale,
        confirmed_other_ids: cards.confirmed_other_ids,
        private_ids: cards.private_ids,
    })
}

/// 读取 Star 同步快照：`cache_key` 经 trim，空返回 `None`；新鲜度由前端判定。
#[tauri::command(rename_all = "camelCase")]
pub fn get_starred_feed_cache(
    state: State<'_, AppState>,
    cache_key: String,
) -> crate::AppResult<Option<StarredFeedCacheEntry>> {
    let db = state.db()?;
    Ok(db
        .get_starred_feed_cache(&cache_key)?
        .map(|(payload_json, cached_at)| StarredFeedCacheEntry {
            payload_json,
            cached_at,
        }))
}

/// 保存 Star 同步快照：键、范围与载荷经 trim，空串跳过；单条超过 64 KiB 拒绝。
#[tauri::command(rename_all = "camelCase")]
pub fn save_starred_feed_cache(
    state: State<'_, AppState>,
    cache_key: String,
    owner_scope: String,
    payload_json: String,
) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.save_starred_feed_cache(&cache_key, &owner_scope, &payload_json)?)
}
