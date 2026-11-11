use super::resolve_active_github_token;
use crate::models::{DeveloperProfile, StarredSyncResult};
use crate::AppState;
use tauri::State;

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

#[tauri::command]
pub async fn sync_github_starred(
    state: State<'_, AppState>,
    username: Option<String>,
) -> crate::AppResult<StarredSyncResult> {
    let token = resolve_active_github_token(&state);
    let is_self_sync = username
        .as_deref()
        .map(|u| u.trim().is_empty())
        .unwrap_or(true);
    if is_self_sync {
        if let Some(ref tok) = token {
            crate::github::CatalogService::sync_github_affinity_signals_bg(&state.db, tok, None)
                .await?;
            crate::notify_affinity_updated();
            return Ok(state
                .catalog
                .build_starred_sync_result_from_cached(&state.db)?);
        }
    }
    let res = state
        .catalog
        .sync_starred_repos(username.as_deref(), token.as_deref())
        .await?;
    Ok(res)
}
