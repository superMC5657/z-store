use crate::AppState;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut map = db.get_all_settings().map_err(|e| e.to_string())?;
    if let Some(url) = map.get("catalog_source_url") {
        if url.contains("gitmirror.com") {
            map.insert(
                "catalog_source_url".to_string(),
                "https://gh-proxy.com/https://raw.githubusercontent.com/supermc/z-store/main/src-tauri/src/catalog.json".to_string(),
            );
        }
    }
    let dl_val = map.get("download_dir").cloned().unwrap_or_default();
    if dl_val.trim().is_empty() || dl_val.contains("zstore_downloads") {
        map.insert("download_dir".to_string(), "~/Downloads".to_string());
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
    // TTL 挡位归一化：非法值回退默认 30，保证库中只存 ADR-0007 有效集 {0,10,30,60,360,1440}
    let value = if key == "detail_cache_ttl_minutes" {
        let parsed = value
            .trim()
            .parse::<i64>()
            .unwrap_or(crate::db::DETAIL_CACHE_TTL_DEFAULT_MINUTES);
        crate::db::normalize_detail_cache_ttl(parsed).to_string()
    } else if key == "watch_notify_frequency" {
        // FR-6.2：非法频率回退默认 daily，保证库中只存 {startup, daily}
        crate::db::normalize_watch_notify_frequency(&value)
    } else {
        value
    };
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
