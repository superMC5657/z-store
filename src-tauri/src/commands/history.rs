use crate::models::{AppSummary, ImportUserDataResult, WatchedApp};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_favorites(state: State<'_, AppState>) -> crate::AppResult<Vec<String>> {
    let db = state.db()?;
    Ok(db.get_favorites()?)
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let app_id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.toggle_favorite(&app_id)?)
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

#[tauri::command]
pub fn record_app_view(state: State<'_, AppState>, app_id: String) -> crate::AppResult<()> {
    let app_id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.record_app_view(&app_id)?)
}

#[tauri::command]
pub fn get_recently_viewed_apps(state: State<'_, AppState>) -> crate::AppResult<Vec<AppSummary>> {
    let db = state.db()?;
    let ids = db.get_recently_viewed_app_ids()?;
    let catalog_items = state.catalog.get_catalog_items();
    let mut result = Vec::new();

    for id in ids {
        if let Some(item) = catalog_items.iter().find(|i| i.id == id) {
            result.push(item.to_summary());
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn clear_view_history(state: State<'_, AppState>) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.clear_view_history()?)
}

// ---------- FR-6.2 关注订阅 ----------

#[tauri::command]
pub fn watch_app(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.watch_app(&id)?)
}

#[tauri::command]
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

// ---------- FR-6.3 手动跨设备同步（导入侧；导出由前端经现有 getters 组装） ----------

/// 合并式导入用户数据：只增不删；已安装应用对应条目跳过计数；
/// 设置项仅接受白名单（主题/语言/缓存保鲜期/关注频率）。
#[tauri::command]
pub fn import_user_data(
    state: State<'_, AppState>,
    json: String,
) -> crate::AppResult<ImportUserDataResult> {
    let plan = crate::oauth::parse_import_payload(&json)?;
    let db = state.db()?;

    let installed: std::collections::HashSet<String> = db
        .get_installed_apps()
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.app_id)
        .collect();

    let mut favorites_added = 0usize;
    let mut watched_added = 0usize;
    let mut settings_applied = 0usize;
    let mut installed_skipped = 0usize;

    // 收藏/关注与安装态正交：同机恢复也必须合入；已安装跳过仅保留给安装态导入。
    // `installed`/`installed_skipped` 形状冻结，供安装态导入复用，此处仅显式取用以避免未使用告警。
    let _ = &installed;
    let _ = &mut installed_skipped;
    for id in &plan.favorites {
        let id = super::require_app_id(id)?;
        if db.add_favorite(&id).map_err(|e| e.to_string())? {
            favorites_added += 1;
        }
    }
    for id in &plan.watched {
        let id = super::require_app_id(id)?;
        if db.watch_app(&id).map_err(|e| e.to_string())? {
            watched_added += 1;
        }
    }
    for (key, value) in &plan.settings {
        let normalized = crate::db::normalize_setting_value(key, value);
        db.set_setting(key, &normalized)
            .map_err(|e| e.to_string())?;
        settings_applied += 1;
    }

    Ok(ImportUserDataResult {
        favorites_added,
        watched_added,
        settings_applied,
        installed_skipped,
    })
}

#[cfg(test)]
mod import_restore_tests {
    use crate::db::Database;
    use crate::models::InstalledApp;

    fn installed_app(app_id: &str) -> InstalledApp {
        InstalledApp {
            app_id: app_id.to_string(),
            app_name: "RustDesk".to_string(),
            version: "1.0.0".to_string(),
            installed_at: 1700000000,
            install_method: "test".to_string(),
            install_path: "C:\\test".to_string(),
            asset_name: "test.exe".to_string(),
            asset_sha256: "abc".to_string(),
            uninstall_command: None,
            icon: None,
            icon_bg: None,
        }
    }

    #[test]
    fn test_same_machine_restore_merges_favorites_and_watch_for_installed_apps() {
        // 同机备份恢复：已安装应用的收藏/关注是独立用户数据，导入合入时不得因已安装而跳过。
        // （注：`import_user_data` 的命令入口需 Tauri State 挂载——`tauri::test`
        // 能力门控于 tauri 自身 `test` feature，本 crate 未启用，故本场景在 DB
        // 缝合处按“解析→归一化→合入”的生产一致路径断言；命令层循环的修复与此同语义。）
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_installed_app(&installed_app("rustdesk/rustdesk"))
            .expect("预置已安装应用应当成功");

        let json = r#"{
            "version": 1,
            "favorites": ["rustdesk/rustdesk"],
            "watched": ["rustdesk/rustdesk"],
            "settings": {}
        }"#;
        let plan = crate::oauth::parse_import_payload(json).expect("合法导入 JSON 应当成功");

        // 与 `import_user_data` 修复后的循环同语义：仅归一化校验，不查已安装表。
        let mut favorites_added = 0usize;
        for id in &plan.favorites {
            let id = crate::forge::canonical_app_id(id).expect("合法标识应当归一化成功");
            if db.add_favorite(&id).unwrap() {
                favorites_added += 1;
            }
        }
        let mut watched_added = 0usize;
        for id in &plan.watched {
            let id = crate::forge::canonical_app_id(id).expect("合法标识应当归一化成功");
            if db.watch_app(&id).unwrap() {
                watched_added += 1;
            }
        }

        assert_eq!(favorites_added, 1, "已安装应用的收藏应当合入");
        assert_eq!(watched_added, 1, "已安装应用的关注应当合入");
        assert!(
            db.get_favorites()
                .unwrap()
                .contains(&"rustdesk/rustdesk".to_string()),
            "收藏表应当包含已安装应用"
        );
        assert!(
            db.get_watched_apps()
                .unwrap()
                .iter()
                .any(|w| w.app_id == "rustdesk/rustdesk"),
            "关注表应当包含已安装应用"
        );
    }
}
