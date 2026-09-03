use crate::installer::InstallerEngine;
use crate::models::{AppDetail, AppSummary, InstalledApp, MirrorNodeStatus, UpdateItem};
use crate::AppState;
use std::collections::HashMap;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn search_apps(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<AppSummary>, String> {
    let token = {
        let t = state.github_token.lock().map_err(|e| e.to_string())?;
        t.clone()
    };
    state
        .catalog
        .search_github_online(&query, token.as_deref())
        .await
}

#[tauri::command]
pub async fn get_app_details(state: State<'_, AppState>, id: String) -> Result<AppDetail, String> {
    let (release_endpoint, cached_etag, cached_payload, token) = {
        let token = state
            .github_token
            .lock()
            .map_err(|e| e.to_string())?
            .clone();
        let (owner, repo, _, _, _, _) = state.catalog.get_endpoints(&id)?;
        let ep = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            owner, repo
        );
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

    // 智能解析真实安装路径，避免存入临时安装包路径
    let real_install_path = match kind {
        crate::installer::AssetKind::PortableZip => {
            let app_dir = crate::installer::dirs_or_fallback(&detail.id);
            crate::scanner::AppScanner::resolve_executable_path(
                Some(&app_dir.to_string_lossy()),
                None,
                &detail.repo,
            )
            .unwrap_or_else(|| app_dir.to_string_lossy().to_string())
        }
        _ => crate::scanner::AppScanner::resolve_executable_path(None, None, &detail.repo)
            .or_else(|| {
                #[cfg(target_os = "windows")]
                {
                    let desktop = std::env::var("USERPROFILE")
                        .map(|p| std::path::PathBuf::from(p).join("Desktop"))
                        .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Users\Public\Desktop"));
                    let lnk = desktop.join(format!("{}.lnk", detail.name));
                    if lnk.is_file() {
                        return Some(lnk.to_string_lossy().to_string());
                    }
                }
                None
            })
            .unwrap_or_default(),
    };

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
        install_path: real_install_path,
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

/// 严格比较两个版本号，仅当 latest 严格高于 current 时返回 true（避免 4 段式 MSI 误报及降级风险）
pub fn is_version_newer(current: &str, latest: &str) -> bool {
    let parse_nums = |s: &str| -> Vec<u64> {
        let clean = s.trim_start_matches('v').trim();
        clean
            .split(|c: char| c == '.' || c == '-' || c == '_')
            .filter_map(|part| {
                part.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .ok()
            })
            .collect()
    };

    let cur_nums = parse_nums(current);
    let lat_nums = parse_nums(latest);

    if cur_nums.is_empty() || lat_nums.is_empty() {
        return current.trim_start_matches('v') != latest.trim_start_matches('v');
    }

    let max_len = cur_nums.len().max(lat_nums.len());
    for i in 0..max_len {
        let c = cur_nums.get(i).copied().unwrap_or(0);
        let l = lat_nums.get(i).copied().unwrap_or(0);
        if l > c {
            return true;
        } else if l < c {
            return false;
        }
    }

    false
}

#[tauri::command]
pub async fn check_for_updates(state: State<'_, AppState>) -> Result<Vec<UpdateItem>, String> {
    let installed = get_installed_apps(state.clone())?;
    let mut updates = Vec::new();

    for app in installed {
        if let Ok(detail) = get_app_details(state.clone(), app.app_id.clone()).await {
            if is_version_newer(&app.version, &detail.latest_version) {
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
    let tok_opt = if token.trim().is_empty() {
        None
    } else {
        Some(token.trim().to_string())
    };
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
pub fn save_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<bool, String> {
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

    let matches = crate::scanner::AppScanner::match_apps(&scanned, catalog_items);
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
        };

        if db.save_installed_app(&installed).is_ok() {
            imported_count += 1;
        }
    }

    Ok(imported_count)
}

#[tauri::command]
pub fn launch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let installed_app = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.app_id.eq_ignore_ascii_case(&app_id))
            .ok_or_else(|| format!("未找到已安装或纳管的应用: {}", app_id))?
    };

    let target_path = installed_app
        .install_path
        .trim()
        .trim_matches('"')
        .to_string();
    let path_obj = std::path::Path::new(&target_path);

    // 检查是否为临时下载目录中的安装包（避免误重新调起安装向导）
    let is_temp_installer = target_path.to_lowercase().contains("zstore_downloads")
        || target_path.to_lowercase().contains(r"\temp\")
        || target_path.to_lowercase().ends_with("-setup.exe")
        || target_path.to_lowercase().ends_with("_setup.exe")
        || target_path.to_lowercase().ends_with("-installer.exe");

    // 1. 如果路径本身是存在的可执行文件或快捷方式，且并非临时下载安装包
    if !is_temp_installer && path_obj.is_file() {
        let ext = path_obj
            .extension()
            .map_or("", |e| e.to_str().unwrap_or(""));
        if ext.eq_ignore_ascii_case("lnk") {
            #[cfg(target_os = "windows")]
            {
                std::process::Command::new("explorer.exe")
                    .arg(&target_path)
                    .spawn()
                    .map_err(|e| format!("调起快捷方式失败: {}", e))?;
                return Ok(true);
            }
        } else if ext.eq_ignore_ascii_case("exe") {
            let parent = path_obj
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            std::process::Command::new(path_obj)
                .current_dir(parent)
                .spawn()
                .map_err(|e| format!("启动应用程序失败: {}", e))?;
            return Ok(true);
        }
    }

    // 2. 检查安装路径是否为目录，调用智能嗅探器寻找真正的 exe
    let candidate_exe = crate::scanner::AppScanner::resolve_executable_path(
        if target_path.is_empty() {
            None
        } else {
            Some(&target_path)
        },
        None,
        &installed_app.app_name,
    )
    .or_else(|| {
        crate::scanner::AppScanner::resolve_executable_path(
            if target_path.is_empty() {
                None
            } else {
                Some(&target_path)
            },
            None,
            &app_id,
        )
    });

    if let Some(exe_str) = candidate_exe {
        let exe_path = std::path::Path::new(&exe_str);
        if exe_path.is_file() {
            let parent = exe_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            std::process::Command::new(exe_path)
                .current_dir(parent)
                .spawn()
                .map_err(|e| format!("启动应用程序失败: {}", e))?;

            // 自动将探测到的真实物理路径写回数据库，加速下次启动
            if target_path != exe_str {
                if let Ok(db) = state.db.lock() {
                    let mut updated = installed_app.clone();
                    updated.install_path = exe_str;
                    let _ = db.save_installed_app(&updated);
                }
            }

            return Ok(true);
        }
    }

    // 3. 检查便携应用目录 ~/AppData/Local/Programs/z-store-apps/<app_id>/
    let portable_dir = crate::installer::dirs_or_fallback(&installed_app.app_id);
    if portable_dir.is_dir() {
        if let Some(exe_str) = crate::scanner::AppScanner::resolve_executable_path(
            Some(&portable_dir.to_string_lossy()),
            None,
            &installed_app.app_name,
        ) {
            let exe_path = std::path::Path::new(&exe_str);
            if exe_path.is_file() {
                let parent = exe_path
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new("."));
                std::process::Command::new(exe_path)
                    .current_dir(parent)
                    .spawn()
                    .map_err(|e| format!("启动便携版失败: {}", e))?;
                return Ok(true);
            }
        }
    }

    // 4. 在 Windows 桌面查找同名快捷方式
    #[cfg(target_os = "windows")]
    {
        let desktop = std::env::var("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join("Desktop"))
            .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Users\Public\Desktop"));

        let candidate_lnks = [
            desktop.join(format!("{}.lnk", installed_app.app_name)),
            desktop.join(format!("{}.lnk", app_id)),
        ];

        for lnk in candidate_lnks {
            if lnk.is_file() {
                std::process::Command::new("explorer.exe")
                    .arg(lnk.to_string_lossy().to_string())
                    .spawn()
                    .map_err(|e| format!("通过快捷方式启动失败: {}", e))?;
                return Ok(true);
            }
        }
    }

    Err(format!(
        "未能定位到该软件的可执行程序。\n记录路径: {}\n建议检查软件是否已被重命名或迁移，或重新纳管。",
        if target_path.is_empty() { "无" } else { &target_path }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_version_newer() {
        // 4 段式 MSI 与 3 段式 GitHub Release 相同版本时不误报
        assert!(!is_version_newer("3.0.21.0", "v3.0.21"));
        assert!(!is_version_newer("3.0.21", "3.0.21.0"));
        assert!(!is_version_newer("v1.2.3", "1.2.3"));

        // 真实新版本应当触发
        assert!(is_version_newer("3.0.20", "3.0.21"));
        assert!(is_version_newer("v1.0.0", "v1.1.0"));
        assert!(is_version_newer("1.9.9", "2.0.0"));

        // 降级（如 nightly 或用户更高版本）不应当触发
        assert!(!is_version_newer("3.0.22", "3.0.21"));
        assert!(!is_version_newer("1.4.0", "1.3.1"));
    }
}
