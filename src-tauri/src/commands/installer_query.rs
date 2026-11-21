use crate::models::InstalledApp;
use crate::{AppResult, AppState};
use tauri::{AppHandle, Manager, State};

/// 已安装应用列表（含路径自愈、导入版本更正与幽灵隐藏）。
#[tauri::command]
pub async fn get_installed_apps(state: State<'_, AppState>) -> AppResult<Vec<InstalledApp>> {
    crate::installer::managed::load_installed_apps(&state).await
}

/// 启动应用：在阻塞线程池中解析可执行路径并启动进程。
#[tauri::command(rename_all = "camelCase")]
pub async fn launch_app(app_handle: AppHandle, app_id: String) -> AppResult<bool> {
    let app_id = super::require_app_id(&app_id)?;
    crate::installer::run_blocking(move || {
        crate::installer::managed::launch_installed_app(&app_handle.state::<AppState>(), &app_id)
    })
    .await?
}
