use crate::AppState;
use std::collections::HashMap;
use tauri::State;

fn get_default_settings() -> HashMap<String, String> {
    let cfg = crate::config::get_project_config();
    let mut map = HashMap::new();
    map.insert("theme".to_string(), "system".to_string());
    map.insert("language".to_string(), "zh-CN".to_string());
    map.insert("ui_scale".to_string(), "100".to_string());
    map.insert("font_size".to_string(), "14".to_string());
    map.insert(
        "portable_dir".to_string(),
        "%LOCALAPPDATA%\\Programs\\z-store-apps".to_string(),
    );
    map.insert("download_dir".to_string(), "~/Downloads".to_string());
    map.insert("active_mirror".to_string(), "ghproxy".to_string());
    map.insert("launch_on_startup".to_string(), "false".to_string());
    map.insert("update_frequency".to_string(), "startup".to_string());
    map.insert(
        "detail_cache_ttl_minutes".to_string(),
        cfg.cache.detail_ttl_minutes.to_string(),
    );
    map.insert(
        "catalog_source_url".to_string(),
        cfg.catalog.default_source_url.clone(),
    );
    map.insert("watch_notify_frequency".to_string(), "daily".to_string());
    map
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let db_settings = db.get_all_settings().map_err(|e| e.to_string())?;

    // 1. 以 config.toml 及项目基准作为权威默认底表
    let mut map = get_default_settings();

    // 2. 将用户在 SQLite 中持久化的修改项合并覆盖
    for (k, v) in db_settings {
        if !v.trim().is_empty() {
            map.insert(k, v);
        }
    }

    Ok(map)
}

#[cfg(target_os = "windows")]
pub fn sync_launch_on_startup(enabled: bool) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_path = std::path::Path::new("Software")
        .join("Microsoft")
        .join("Windows")
        .join("CurrentVersion")
        .join("Run");

    if let Ok((key, _)) = hkcu.create_subkey_with_flags(&run_path, KEY_ALL_ACCESS) {
        if enabled {
            if let Ok(exe_path) = std::env::current_exe() {
                let cmd = format!("\"{}\"", exe_path.to_string_lossy());
                let _ = key.set_value("ZStore", &cmd);
            }
        } else {
            let _ = key.delete_value("ZStore");
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sync_launch_on_startup(_enabled: bool) {}

#[tauri::command]
pub fn save_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let value = crate::db::normalize_setting_value(&key, &value);
    db.set_setting(&key, &value).map_err(|e| e.to_string())?;

    if key == "launch_on_startup" {
        let enabled = value == "true" || value == "1";
        sync_launch_on_startup(enabled);
    }

    Ok(true)
}

#[tauri::command]
pub async fn select_folder(
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let dialog_title = title.unwrap_or_else(|| "选择目录".to_string());
        let mut dialog = rfd::FileDialog::new().set_title(&dialog_title);
        if let Some(ref path_str) = default_path {
            let expanded = crate::installer::expand_env_path(path_str);
            if expanded.exists() {
                dialog = dialog.set_directory(&expanded);
            }
        }
        let folder = dialog.pick_folder();
        folder.map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}
