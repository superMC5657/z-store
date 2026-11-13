use super::resolve_active_github_token;
use crate::models::{DeveloperProfile, StarredPageResult};
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
/// 每页一次 GitHub 请求，卡片由列表里的仓库 JSON 本地组装，图标后台补齐；结果不落库。
#[tauri::command(rename_all = "camelCase")]
pub async fn list_github_starred(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    username: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
) -> crate::AppResult<StarredPageResult> {
    let token = resolve_active_github_token(&state);
    let page = page.unwrap_or(1).max(1);
    let fetched = state
        .catalog
        .fetch_starred_page(
            username.as_deref(),
            token.as_deref(),
            page,
            per_page.unwrap_or(20),
            None,
        )
        .await?;
    let (rows, need_icon) = {
        let db = state.db()?;
        super::catalog_search::cards_from_repo_payloads(&db, &state.catalog, fetched.repos)
    };
    super::catalog_search::spawn_starred_icon_stream(&app_handle, need_icon, token, page == 1);
    Ok(StarredPageResult {
        rows,
        has_more: fetched.has_more,
    })
}
