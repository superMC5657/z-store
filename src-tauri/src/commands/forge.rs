use super::resolve_active_github_token;
use crate::models::{DeveloperProfile, StarredFeedCacheEntry, StarredPageResult};
use crate::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_developer_profile(
    state: State<'_, AppState>,
    developer: String,
) -> crate::AppResult<DeveloperProfile> {
    let token = resolve_active_github_token(&state);
    Ok(state
        .catalog
        .fetch_developer_profile(&developer, token.as_deref())
        .await?)
}

/// Star 列表单页查询（收藏页「Star 同步」）：任意用户名或当前登录账号，按 Star 时间倒序。
/// 每页一次 GitHub 条件请求（`api_etag_cache`，未变 `304` 零配额），卡片由列表里的仓库 JSON 本地组装，
/// 图标后台补齐；网络或限流失败时回退旧载荷并标 `is_stale`。
/// `force_refresh` 为手动同步透传位：条件请求本就实时比对服务端，强刷同样携带 ETag。
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
    let fetched = state
        .catalog
        .fetch_starred_page(
            username.as_deref(),
            token.as_deref(),
            page,
            per_page,
            cached_etag.as_deref(),
            cached_payload.as_deref(),
            None,
        )
        .await?;
    let not_modified = fetched.touched_url.is_some();
    let (rows, need_icon) = {
        let db = state.db()?;
        let now = crate::now_secs();
        if let Some((u, etag, text)) = &fetched.etag_write {
            let _ = db.save_etag(u, etag, text, now);
        }
        if let Some(u) = &fetched.touched_url {
            let _ = db.touch_etag(u, now);
        }
        super::catalog_search::cards_from_repo_payloads(&db, &state.catalog, fetched.page.repos)
    };
    super::catalog_search::spawn_starred_icon_stream(&app_handle, need_icon, token, page == 1);
    if fetched.is_stale == Some(true) {
        let mut ev = crate::z_log::WideEvent::new("detail", "starred page stale").with_started(start);
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

/// 保存 Star 同步快照：键、范围与载荷经 trim，空串跳过；单条超过 512 KiB 拒绝。
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
