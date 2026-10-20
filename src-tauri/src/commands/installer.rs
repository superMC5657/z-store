use crate::models::InstalledApp;
use crate::{AppResult, AppState};
use tauri::{AppHandle, State};

#[tauri::command(rename_all = "camelCase")]
pub async fn install_app(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    asset_name: Option<String>,
    custom_install_dir: Option<String>,
    allow_unverified: Option<bool>,
) -> AppResult<InstalledApp> {
    Ok(super::installer_install::install_app(
        app_handle,
        state,
        app_id,
        asset_name,
        custom_install_dir,
        allow_unverified,
    )
    .await?)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn uninstall_app(state: State<'_, AppState>, app_id: String) -> AppResult<bool> {
    Ok(super::installer_uninstall::uninstall_app(state, app_id).await?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn unmanage_app(state: State<'_, AppState>, app_id: String) -> AppResult<bool> {
    Ok(super::installer_uninstall::unmanage_app(state, app_id)?)
}

#[tauri::command]
pub fn get_installed_apps(state: State<'_, AppState>) -> AppResult<Vec<InstalledApp>> {
    Ok(super::installer_query::get_installed_apps(state)?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn launch_app(state: State<'_, AppState>, app_id: String) -> AppResult<bool> {
    Ok(super::installer_query::launch_app(state, app_id)?)
}
