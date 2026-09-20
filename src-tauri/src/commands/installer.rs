use crate::models::InstalledApp;
use crate::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn install_app(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    asset_name: Option<String>,
    custom_install_dir: Option<String>,
) -> Result<InstalledApp, String> {
    super::installer_install::install_app(app_handle, state, app_id, asset_name, custom_install_dir).await
}

#[tauri::command]
pub async fn uninstall_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    super::installer_uninstall::uninstall_app(state, app_id).await
}

#[tauri::command]
pub fn unmanage_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    super::installer_uninstall::unmanage_app(state, app_id)
}

#[tauri::command]
pub fn get_installed_apps(state: State<'_, AppState>) -> Result<Vec<InstalledApp>, String> {
    super::installer_query::get_installed_apps(state)
}

#[tauri::command]
pub fn launch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    super::installer_query::launch_app(state, app_id)
}
