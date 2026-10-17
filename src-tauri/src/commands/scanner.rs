use crate::models::InstalledApp;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn scan_and_match_local_apps(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<crate::scanner::AppMatchResult>> {
    // Wave2：行为链 sid 关联 + 耗时，汇总行保持只记数量。
    let sid = crate::z_log::new_session_id();
    let scan_start = std::time::Instant::now();
    log::info!("scanner start sid={}", sid);
    let scanned = crate::scanner::AppScanner::scan_system_apps();
    let catalog_items = state.catalog.get_catalog_items();

    let installed_ids: std::collections::HashSet<String> = {
        let db = state.db()?;
        // 深 join 模块 exact 侧：建集时一次归一（canonical 数据零行为变更，
        // 存量大小写漂移行被治愈，接 ADR-0010 修订）。
        crate::scanner::join::canonical_id_set(
            db.get_installed_apps().unwrap_or_default().into_iter().map(|a| a.app_id),
        )
    };

    // 深 join 模块 fuzzy 侧：启发式评分唯一入口（与 `match_apps` 同语义）。
    let matches = crate::scanner::join::join_fuzzy(&scanned, &catalog_items);
    let unmanaged_matches = matches
        .into_iter()
        .filter(|m| !crate::scanner::join::is_managed_id(&m.catalog_id, &installed_ids))
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
) -> crate::AppResult<usize> {
    let mut imported_count = 0;
    let now = crate::now_secs();

    let db = state.db()?;

    for req in apps {
        let app_id = super::require_app_id(&req.app_id)?;
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
