use crate::models::InstalledApp;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn scan_and_match_local_apps(
    state: State<'_, AppState>,
) -> Result<Vec<crate::scanner::AppMatchResult>, String> {
    // Wave2：行为链 sid 关联 + 耗时，汇总行保持只记数量。
    let sid = crate::z_log::new_session_id();
    let scan_start = std::time::Instant::now();
    log::info!("scanner start sid={}", sid);
    let scanned = crate::scanner::AppScanner::scan_system_apps();
    let catalog_items = state.catalog.get_catalog_items();

    let installed_ids: std::collections::HashSet<String> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .unwrap_or_default()
            .into_iter()
            .map(|a| a.app_id)
            .collect()
    };

    let matches = crate::scanner::AppScanner::match_apps(&scanned, &catalog_items);
    let unmanaged_matches = matches
        .into_iter()
        .filter(|m| !installed_ids.contains(&m.catalog_id))
        .collect();
    let unmanaged: Vec<crate::scanner::AppMatchResult> = unmanaged_matches;

    // 汇总一行 info：只记数量，不记路径/名称原文。
    log::info!(
        "scanner done sid={} scanned={} unmanaged={} elapsed_ms={}",
        sid,
        scanned.len(),
        unmanaged.len(),
        scan_start.elapsed().as_millis()
    );

    Ok(unmanaged)
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
        let app_id = crate::forge::canonical_app_id(&req.app_id)
            .ok_or_else(|| format!("无法识别的应用标识: {}", req.app_id))?;
        let (icon, icon_bg) = if let Some(cat) = state.catalog.get_catalog_item(&app_id) {
            (Some(cat.icon), Some(cat.icon_bg))
        } else {
            (None, None)
        };
        let installed_at = req
            .installed_at
            .or_else(|| {
                crate::scanner::AppScanner::resolve_app_installed_at(
                    &req.app_name,
                    &app_id,
                    req.install_path.as_deref().unwrap_or_default(),
                )
            })
            .unwrap_or(now);

        let installed = InstalledApp {
            app_id,
            app_name: req.app_name,
            version: req.version,
            installed_at,
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

/// 本地已安装探测结果内存缓存过期时效（秒）
pub const DETECTED_APP_IDS_CACHE_TTL_SECS: u64 = 120;

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
            ids.retain(|id| id != app_id);
        }
    }
}

pub fn add_to_detected_cache(app_id: &str) {
    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        if let Some((_, ref mut ids)) = *guard {
            if !ids.iter().any(|id| id == app_id) {
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
                if instant.elapsed().as_secs() < DETECTED_APP_IDS_CACHE_TTL_SECS {
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
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    let cat = state
        .catalog
        .get_catalog_item(&app_id)
        .ok_or_else(|| format!("Catalog 中未收录该应用: {}", app_id))?;

    let resolved_path = crate::scanner::AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo));
    let resolved_path_str = resolved_path.unwrap_or_default();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let installed_at = crate::scanner::AppScanner::resolve_app_installed_at(
        &cat.name,
        &cat.id,
        &resolved_path_str,
    )
    .unwrap_or(now);

    let installed = InstalledApp {
        app_id: cat.id.clone(),
        app_name: cat.name.clone(),
        version: cat.default_version.clone(),
        installed_at,
        install_method: "system_import".to_string(),
        install_path: resolved_path_str,
        asset_name: "system_detected".to_string(),
        asset_sha256: "system_verified".to_string(),
        uninstall_command: None,
        icon: Some(cat.icon),
        icon_bg: Some(cat.icon_bg),
    };

    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_installed_app(&installed).map_err(|e| e.to_string())?;

    // 添加管理后让探测缓存也包含该 ID
    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        if let Some((_, ref mut ids)) = *guard {
            if !ids.contains(&installed.app_id) {
                ids.push(installed.app_id.clone());
            }
        }
    }

    Ok(true)
}
