use crate::models::{
    AppSummary, FavoriteEntry, ImportUserDataResult, WatchDismissedEntry, WatchUpdatedPayload,
    WatchedApp,
};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_favorites(state: State<'_, AppState>) -> crate::AppResult<Vec<String>> {
    let db = state.db()?;
    Ok(db.get_favorites()?)
}

/// 收藏条目列表（含收录标记），与 `get_favorites` 同序。
#[tauri::command]
pub fn get_favorite_entries(state: State<'_, AppState>) -> crate::AppResult<Vec<FavoriteEntry>> {
    let db = state.db()?;
    Ok(db.get_favorite_entries()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn toggle_favorite(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let app_id = super::require_app_id(&app_id)?;
    let flag = state.catalog.is_cataloged(&app_id);
    let db = state.db()?;
    Ok(db.toggle_favorite(&app_id, flag)?)
}

#[tauri::command]
pub fn record_search_query(state: State<'_, AppState>, query: String) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.record_search_query(&query)?)
}

#[tauri::command]
pub fn get_search_history(state: State<'_, AppState>) -> crate::AppResult<Vec<String>> {
    let db = state.db()?;
    Ok(db.get_search_history()?)
}

#[tauri::command]
pub fn clear_search_history(state: State<'_, AppState>) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.clear_search_history()?)
}

#[tauri::command]
pub fn remove_search_query(state: State<'_, AppState>, query: String) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.remove_search_query(&query)?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn record_app_view(state: State<'_, AppState>, app_id: String) -> crate::AppResult<()> {
    let app_id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.record_app_view(&app_id)?)
}

/// 前端「最近浏览」展示条的去重上限（给平台筛选留出余量）。
const RECENT_VIEW_DISPLAY_LIMIT: usize = 30;

/// 最近浏览响应条目：在 `AppSummary` 基础上透出最近一次浏览时间戳（供前端展示遮罩比较）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecentlyViewedApp {
    #[serde(flatten)]
    pub summary: AppSummary,
    pub viewed_at: i64,
}

/// 最近浏览：短锁内读浏览记录与本地详情并规划确认图标，释放锁后读图标文件并编码。
#[tauri::command]
pub async fn get_recently_viewed_apps(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<RecentlyViewedApp>> {
    Ok(
        crate::repositories::card_hydrator::recently_viewed(&state, RECENT_VIEW_DISPLAY_LIMIT)
            .await?
            .into_iter()
            .map(|(summary, viewed_at)| RecentlyViewedApp { summary, viewed_at })
            .collect(),
    )
}

// ---------- 关注订阅 ----------

#[tauri::command(rename_all = "camelCase")]
pub fn watch_app(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let flag = state.catalog.is_cataloged(&id);
    let db = state.db()?;
    Ok(db.watch_app(&id, flag)?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn unwatch_app(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.unwatch_app(&id)?)
}

#[tauri::command]
pub fn get_watched_apps(state: State<'_, AppState>) -> crate::AppResult<Vec<WatchedApp>> {
    let db = state.db()?;
    Ok(db.get_watched_apps()?)
}

/// 待处理的关注提醒（持久化，重启后可读回）；实时提醒仍经 `zstore://watch-updated` 推送。
#[tauri::command]
pub fn get_watch_notifications(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<WatchUpdatedPayload>> {
    let db = state.db()?;
    Ok(db.get_pending_watch_notifications()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn dismiss_watch_notification(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.dismiss_watch_notification(&id)?)
}

/// 已确认的关注提醒，供规则管理列出与恢复。
#[tauri::command]
pub fn get_dismissed_watch_notifications(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<WatchDismissedEntry>> {
    let db = state.db()?;
    Ok(db.get_dismissed_watch_notifications()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_watch_notification(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.restore_watch_notification(&id)?)
}

/// 校验导出预设文件名（纯函数）：仅允许单层 `.json` 文件名，拒绝路径分隔符、父目录引用与空值。
fn validate_export_file_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err("导出文件名无效".to_string());
    }
    if !trimmed.ends_with(".json") {
        return Err("仅支持导出 .json 文件".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("导出文件名包含非法字符".to_string());
    }
    if trimmed.starts_with('.') || trimmed.contains("..") {
        return Err("导出文件名不能包含相对路径段".to_string());
    }
    Ok(trimmed.to_string())
}

fn write_export_json(out_path: &std::path::Path, content: &str) -> Result<String, String> {
    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(out_path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(out_path.to_string_lossy().to_string())
}

/// 弹出系统保存文件对话框（默认目录指向 `app_log_dir`，预填 `file_name`），
/// 用户确认后写入导出的 JSON（已安装应用列表 / 用户数据备份）并返回落盘绝对路径；取消时返回 `None`。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_backup_file(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
) -> crate::AppResult<Option<String>> {
    use tauri::Manager;
    let safe_name = validate_export_file_name(&file_name).map_err(crate::AppError::new)?;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| crate::AppError::new(e.to_string()))?;
    std::fs::create_dir_all(&log_dir).map_err(|e| crate::AppError::new(e.to_string()))?;

    let saved = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let picked = rfd::FileDialog::new()
            .set_directory(&log_dir)
            .set_file_name(&safe_name)
            .add_filter("JSON", &["json"])
            .save_file();
        let Some(out_path) = picked else {
            return Ok(None);
        };
        write_export_json(&out_path, &content).map(Some)
    })
    .await
    .map_err(|e| crate::AppError::new(e.to_string()))?
    .map_err(crate::AppError::new)?;

    Ok(saved)
}

// ---------- 手动跨设备同步（导入侧；导出由前端经 getters 组装） ----------

/// 合并式导入用户数据：只增不删；
/// 设置项仅接受白名单（主题/语言/缓存保鲜期/关注频率）。
pub(crate) fn import_user_data_inner(
    state: &AppState,
    json: &str,
    apply_os_startup: bool,
) -> crate::AppResult<ImportUserDataResult> {
    let (result, effects) = {
        let db = state.db()?;
        crate::userdata::import_backup_with_effects(&db, |id| state.catalog.is_cataloged(id), json)?
    };
    if let Some(mirror_id) = effects.active_mirror.as_deref() {
        crate::commands::settings::sync_active_mirror(state, mirror_id);
    }
    if apply_os_startup {
        if let Some(enabled) = effects.launch_on_startup {
            crate::commands::settings::sync_launch_on_startup(enabled);
        }
    }
    if result.favorites_added > 0 || result.watched_added > 0 {
        crate::notify_affinity_updated();
    }
    let mut ev = crate::z_log::WideEvent::new("app", "userdata import ok");
    ev.field("favorites", result.favorites_added)
        .field("watched", result.watched_added)
        .field("settings", result.settings_applied);
    ev.info();
    Ok(result)
}

#[tauri::command]
pub fn import_user_data(
    state: State<'_, AppState>,
    json: String,
) -> crate::AppResult<ImportUserDataResult> {
    import_user_data_inner(&state, &json, true)
}

#[cfg(test)]
mod export_file_tests {
    use super::{validate_export_file_name, write_export_json};

    #[test]
    fn accepts_valid_json_file_names() {
        assert_eq!(
            validate_export_file_name("z-store-backup-20261113-120000.json").unwrap(),
            "z-store-backup-20261113-120000.json"
        );
        assert_eq!(
            validate_export_file_name("zstore-installed-backup-20261113-120000.json").unwrap(),
            "zstore-installed-backup-20261113-120000.json"
        );
    }

    #[test]
    fn write_export_json_creates_parent_and_writes_payload() {
        let dir = std::env::temp_dir().join(format!(
            "zstore-export-test-{}-{}",
            std::process::id(),
            crate::now_secs()
        ));
        let target = dir.join("nested").join("backup.json");
        let saved = write_export_json(&target, "{\"version\":1}").unwrap();
        assert_eq!(saved, target.to_string_lossy());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"version\":1}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_traversal_separators_and_non_json() {
        for bad in [
            "",
            "   ",
            "../secret.json",
            "sub/file.json",
            "sub\\file.json",
            ".hidden.json",
            "a..b.json",
            "backup.txt",
            "backup.json.exe",
        ] {
            assert!(
                validate_export_file_name(bad).is_err(),
                "should reject invalid export filename: {:?}",
                bad
            );
        }
    }

    #[test]
    fn import_user_data_syncs_in_memory_mirror() {
        let state = crate::AppState {
            db: std::sync::Arc::new(std::sync::Mutex::new(
                crate::db::Database::open_in_memory().unwrap(),
            )),
            catalog: crate::github::CatalogService::with_items(vec![]),
            mirror: std::sync::Mutex::new(crate::mirror::MirrorManager::new()),
            github_token: std::sync::Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            startup_catalog_synced: std::sync::atomic::AtomicBool::new(false),
        };
        let json = r#"{"version":1,"settings":{"active_mirror":"https://mirror.example.com"}}"#;
        let res = super::import_user_data_inner(&state, json, false).unwrap();
        assert_eq!(res.settings_applied, 1);
        assert_eq!(
            state.mirror.lock().unwrap().active_mirror_prefix().as_deref(),
            Some("https://mirror.example.com")
        );
    }
}
