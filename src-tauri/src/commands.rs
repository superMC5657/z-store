use crate::installer::InstallerEngine;
use crate::models::{AppDetail, AppSummary, InstalledApp, MirrorNodeStatus, UpdateItem};
use crate::AppState;
use std::collections::HashMap;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn search_apps(state: State<'_, AppState>, query: String) -> Result<Vec<AppSummary>, String> {
    let token = {
        let t = state.github_token.lock().map_err(|e| e.to_string())?;
        t.clone()
    };
    state.catalog.search_github_online(&query, token.as_deref()).await
}

#[tauri::command]
pub async fn get_app_details(state: State<'_, AppState>, id: String) -> Result<AppDetail, String> {
    let (release_endpoint, cached_etag, cached_payload, token) = {
        let token = state.github_token.lock().map_err(|e| e.to_string())?.clone();
        let (owner, repo, _, _, _, _) = state.catalog.get_endpoints(&id)?;
        let ep = format!("https://api.github.com/repos/{}/{}/releases/latest", owner, repo);
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let etag = db.get_etag(&ep).ok().flatten();
        let payload = db.get_cached_payload(&ep).ok().flatten();
        (ep, etag, payload, token)
    };

    let (detail, to_cache) = state
        .catalog
        .fetch_app_detail(&id, cached_etag, cached_payload, token.as_deref())
        .await?;

    if let Some((etag, payload)) = to_cache {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let _ = db.save_etag(&release_endpoint, &etag, &payload, now);
    }

    Ok(detail)
}

#[tauri::command]
pub fn get_installed_apps(state: State<'_, AppState>) -> Result<Vec<InstalledApp>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_installed_apps().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_app(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
) -> Result<InstalledApp, String> {
    // 1. 获取应用详情与匹配资产
    let detail = get_app_details(state.clone(), app_id.clone()).await?;

    let asset = detail
        .releases
        .first()
        .ok_or_else(|| "该 Release 未提供匹配当前操作系统的安装包资产".to_string())?;

    // 2. 获取加速下载重写地址
    let rewritten_url = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.rewrite_download_url(&asset.download_url)
    };

    // 3. 执行流式下载与 SHA-256 完整性防篡改强校验
    let (dest_path, actual_sha256) = InstallerEngine::download_with_progress(
        &app_handle,
        &app_id,
        &rewritten_url,
        &asset.name,
        asset.sha256.as_deref(),
    )
    .await?;

    // 4. 调用原生安装器或解压便携版
    let (kind, _, _) = InstallerEngine::classify_asset(&asset.name);
    let install_note = InstallerEngine::execute_installation(&dest_path, &kind, &detail.id)?;

    // 5. 写入本地 SQLite 持久化
    let installed_app = InstalledApp {
        app_id: detail.id.clone(),
        app_name: detail.name.clone(),
        version: detail.latest_version.clone(),
        installed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        install_method: asset.kind.clone(),
        install_path: dest_path.to_string_lossy().to_string(),
        asset_name: asset.name.clone(),
        asset_sha256: actual_sha256,
        uninstall_command: Some(install_note),
    };

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.save_installed_app(&installed_app)
            .map_err(|e| e.to_string())?;
    }

    Ok(installed_app)
}

#[tauri::command]
pub fn uninstall_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let installed_app = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.app_id == app_id)
    };

    if let Some(app) = installed_app {
        // 便携版清理
        let app_dir = crate::installer::dirs_or_fallback(&app.app_id);
        if app_dir.exists() {
            let _ = std::fs::remove_dir_all(&app_dir);
        }

        // 快捷方式清理
        #[cfg(target_os = "windows")]
        {
            let desktop = std::env::var("USERPROFILE")
                .map(|p| std::path::PathBuf::from(p).join("Desktop"))
                .unwrap_or_else(|_| std::path::PathBuf::from("C:\\Users\\Public\\Desktop"));
            let lnk = desktop.join(format!("{}.lnk", app.app_name));
            if lnk.exists() {
                let _ = std::fs::remove_file(lnk);
            }
        }

        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.remove_installed_app(&app_id).map_err(|e| e.to_string())
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn check_for_updates(state: State<'_, AppState>) -> Result<Vec<UpdateItem>, String> {
    let installed = get_installed_apps(state.clone())?;
    let mut updates = Vec::new();

    for app in installed {
        if let Ok(detail) = get_app_details(state.clone(), app.app_id.clone()).await {
            let clean_current = app.version.trim_start_matches('v');
            let clean_latest = detail.latest_version.trim_start_matches('v');

            if clean_current != clean_latest && !clean_latest.is_empty() {
                updates.push(UpdateItem {
                    app_id: app.app_id,
                    app_name: app.app_name,
                    current_version: app.version,
                    latest_version: detail.latest_version,
                    changelog: detail.changelog,
                });
            }
        }
    }

    Ok(updates)
}

#[tauri::command]
pub fn get_mirror_status(state: State<'_, AppState>) -> Result<Vec<MirrorNodeStatus>, String> {
    let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    Ok(mirror.get_mirror_statuses())
}

#[tauri::command]
pub fn switch_mirror(state: State<'_, AppState>, mirror_id: String) -> Result<bool, String> {
    let mut mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    let ok = mirror.set_active_mirror(&mirror_id);
    if ok {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let _ = db.set_setting("active_mirror", &mirror_id);
    }
    Ok(ok)
}

#[tauri::command]
pub async fn ping_mirrors(state: State<'_, AppState>) -> Result<Vec<MirrorNodeStatus>, String> {
    let nodes = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.get_mirror_statuses()
    };
    let updated = crate::mirror::MirrorManager::ping_nodes(nodes).await;
    {
        let mut mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        let latencies: Vec<(String, u32)> = updated
            .iter()
            .map(|n| (n.id.clone(), n.latency_ms))
            .collect();
        mirror.update_latencies(&latencies);
    }
    let mut sorted = updated;
    sorted.sort_by_key(|a| a.latency_ms);
    Ok(sorted)
}

#[tauri::command]
pub fn set_github_token(state: State<'_, AppState>, token: String) -> Result<bool, String> {
    let tok_opt = if token.trim().is_empty() { None } else { Some(token.trim().to_string()) };
    {
        let mut t = state.github_token.lock().map_err(|e| e.to_string())?;
        *t = tok_opt.clone();
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let _ = db.set_setting("github_token", tok_opt.as_deref().unwrap_or(""));
    Ok(true)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_setting(state: State<'_, AppState>, key: String, value: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_setting(&key, &value).map_err(|e| e.to_string())?;
    Ok(true)
}

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
pub fn clear_cache(state: State<'_, AppState>) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_cache().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn get_catalog_count(state: State<'_, AppState>) -> Result<usize, String> {
    Ok(state.catalog.get_catalog_count())
}

#[tauri::command]
pub async fn get_app_readme(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let detail = get_app_details(state, id).await?;
    Ok(detail.readme_markdown)
}
