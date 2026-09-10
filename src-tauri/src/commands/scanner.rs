use crate::models::InstalledApp;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn scan_and_match_local_apps(
    state: State<'_, AppState>,
) -> Result<Vec<crate::scanner::AppMatchResult>, String> {
    let scanned = crate::scanner::AppScanner::scan_system_apps();
    let catalog_items = state.catalog.get_catalog_items();

    let installed_ids: std::collections::HashSet<String> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .unwrap_or_default()
            .into_iter()
            .map(|a| a.app_id.to_lowercase())
            .collect()
    };

    let matches = crate::scanner::AppScanner::match_apps(&scanned, &catalog_items);
    let unmanaged_matches = matches
        .into_iter()
        .filter(|m| !installed_ids.contains(&m.catalog_id.to_lowercase()))
        .collect();

    Ok(unmanaged_matches)
}

#[tauri::command]
pub fn import_matched_apps(
    state: State<'_, AppState>,
    apps: Vec<crate::scanner::ImportAppRequest>,
) -> Result<usize, String> {
    let mut imported_count = 0;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let db = state.db.lock().map_err(|e| e.to_string())?;

    for req in apps {
        let (icon, icon_bg) = if let Some(cat) = state.catalog.get_catalog_item(&req.app_id) {
            (Some(cat.icon), Some(cat.icon_bg))
        } else {
            (None, None)
        };
        let installed = InstalledApp {
            app_id: req.app_id,
            app_name: req.app_name,
            version: req.version,
            installed_at: now,
            install_method: "system_import".to_string(),
            install_path: req.install_path.unwrap_or_default(),
            asset_name: "system_detected".to_string(),
            asset_sha256: "system_verified".to_string(),
            uninstall_command: req.uninstall_command,
            icon,
            icon_bg,
        };

        if db.save_installed_app(&installed).is_ok() {
            imported_count += 1;
        }
    }

    Ok(imported_count)
}

static DETECTED_APP_IDS_CACHE: std::sync::RwLock<Option<(std::time::Instant, Vec<String>)>> =
    std::sync::RwLock::new(None);

pub fn invalidate_detected_app_ids_cache() {
    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        *guard = None;
    }
}

pub fn remove_from_detected_cache(app_id: &str) {
    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        if let Some((_, ref mut ids)) = *guard {
            ids.retain(|id| !id.eq_ignore_ascii_case(app_id));
        }
    }
}

pub fn add_to_detected_cache(app_id: &str) {
    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        if let Some((_, ref mut ids)) = *guard {
            if !ids.iter().any(|id| id.eq_ignore_ascii_case(app_id)) {
                ids.push(app_id.to_string());
            }
        }
    }
}

#[tauri::command]
pub async fn get_detected_installed_app_ids(
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> Result<Vec<String>, String> {
    let force = force_refresh.unwrap_or(false);
    if !force {
        if let Ok(guard) = DETECTED_APP_IDS_CACHE.read() {
            if let Some((instant, ref ids)) = *guard {
                if instant.elapsed().as_secs() < 120 {
                    return Ok(ids.clone());
                }
            }
        }
    }

    let catalog_items = state.catalog.get_catalog_items();
    let detected: Vec<String> = tokio::task::spawn_blocking(move || {
        let mut detected = Vec::new();
        for cat in &catalog_items {
            if crate::scanner::AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo)).is_some() {
                detected.push(cat.id.clone());
            }
        }
        detected
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        *guard = Some((std::time::Instant::now(), detected.clone()));
    }

    Ok(detected)
}

#[tauri::command]
pub fn import_single_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let cat = state
        .catalog
        .get_catalog_items()
        .into_iter()
        .find(|c| c.id.eq_ignore_ascii_case(&app_id))
        .ok_or_else(|| format!("Catalog 中未收录该应用: {}", app_id))?;

    let resolved_path = crate::scanner::AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo));

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let installed = InstalledApp {
        app_id: cat.id.clone(),
        app_name: cat.name.clone(),
        version: cat.default_version.clone(),
        installed_at: now,
        install_method: "system_import".to_string(),
        install_path: resolved_path.unwrap_or_default(),
        asset_name: "system_detected".to_string(),
        asset_sha256: "system_verified".to_string(),
        uninstall_command: None,
        icon: Some(cat.icon),
        icon_bg: Some(cat.icon_bg),
    };

    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_installed_app(&installed).map_err(|e| e.to_string())?;

    // 纳管后让探测缓存也包含该 ID
    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        if let Some((_, ref mut ids)) = *guard {
            if !ids.iter().any(|id| id.eq_ignore_ascii_case(&installed.app_id)) {
                ids.push(installed.app_id.clone());
            }
        }
    }

    Ok(true)
}
