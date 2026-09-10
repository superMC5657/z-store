use crate::models::{AppSummary, ImportUserDataResult, WatchedApp};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_favorites(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_favorites().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.toggle_favorite(&app_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_search_query(state: State<'_, AppState>, query: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.record_search_query(&query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_search_history(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_search_history().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_search_history(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_search_history().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_search_query(state: State<'_, AppState>, query: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_search_query(&query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_app_view(state: State<'_, AppState>, app_id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.record_app_view(&app_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recently_viewed_apps(state: State<'_, AppState>) -> Result<Vec<AppSummary>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ids = db.get_recently_viewed_app_ids().map_err(|e| e.to_string())?;
    let catalog_items = state.catalog.get_catalog_items();
    let mut result = Vec::new();

    for id in ids {
        if let Some(item) = catalog_items.iter().find(|i| i.id.eq_ignore_ascii_case(&id)) {
            result.push(item.to_summary());
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn clear_view_history(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_view_history().map_err(|e| e.to_string())
}

// ---------- FR-6.2 关注订阅 ----------

#[tauri::command]
pub fn watch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let id = app_id.trim();
    if id.is_empty() {
        return Err("应用 ID 不能为空".to_string());
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.watch_app(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unwatch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.unwatch_app(app_id.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_watched_apps(state: State<'_, AppState>) -> Result<Vec<WatchedApp>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_watched_apps().map_err(|e| e.to_string())
}

// ---------- FR-6.3 手动跨设备同步（导入侧；导出由前端经现有 getters 组装） ----------

/// 合并式导入用户数据：只增不删；已安装应用对应条目跳过计数；
/// 设置项仅接受白名单（主题/语言/缓存保鲜期/关注频率）。
#[tauri::command]
pub fn import_user_data(
    state: State<'_, AppState>,
    json: String,
) -> Result<ImportUserDataResult, String> {
    let plan = crate::oauth::parse_import_payload(&json)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let installed: std::collections::HashSet<String> = db
        .get_installed_apps()
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.app_id.to_lowercase())
        .collect();

    let mut favorites_added = 0usize;
    let mut watched_added = 0usize;
    let mut settings_applied = 0usize;
    let mut installed_skipped = 0usize;

    for id in &plan.favorites {
        if installed.contains(&id.to_lowercase()) {
            installed_skipped += 1;
            continue;
        }
        if db.add_favorite(id).map_err(|e| e.to_string())? {
            favorites_added += 1;
        }
    }
    for id in &plan.watched {
        if installed.contains(&id.to_lowercase()) {
            installed_skipped += 1;
            continue;
        }
        if db.watch_app(id).map_err(|e| e.to_string())? {
            watched_added += 1;
        }
    }
    for (key, value) in &plan.settings {
        let normalized = if key == "detail_cache_ttl_minutes" {
            let parsed = value
                .trim()
                .parse::<i64>()
                .unwrap_or_else(|_| crate::db::default_detail_cache_ttl_minutes());
            crate::db::normalize_detail_cache_ttl(parsed).to_string()
        } else if key == "watch_notify_frequency" {
            crate::db::normalize_watch_notify_frequency(value)
        } else {
            value.clone()
        };
        db.set_setting(key, &normalized).map_err(|e| e.to_string())?;
        settings_applied += 1;
    }

    Ok(ImportUserDataResult {
        favorites_added,
        watched_added,
        settings_applied,
        installed_skipped,
    })
}
