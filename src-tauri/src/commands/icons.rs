use crate::icons::IconCycleResult;
use crate::AppState;
use tauri::State;

/// 获取并缓存远程图标为 M2 `data:` URI。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_or_fetch_icon(
    state: State<'_, AppState>,
    app_id: Option<String>,
    remote_url: String,
) -> crate::AppResult<String> {
    crate::icons::get_or_fetch_icon(&state, app_id, remote_url).await
}

/// 循环切换应用图标 (L1..=L5)。
#[tauri::command(rename_all = "camelCase")]
pub async fn cycle_app_icon(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    crate::icons::cycle_app_icon(&state, app_id).await
}

/// 只读恢复或探测应用当前图标轮换状态。
#[tauri::command(rename_all = "camelCase")]
pub async fn restore_or_fetch_icon_cycle(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    crate::icons::restore_or_fetch_icon_cycle(&state, app_id).await
}
