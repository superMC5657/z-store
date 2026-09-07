pub mod commands;
pub mod db;
pub mod deeplink;
pub mod forge;
pub mod github;
pub mod installer;
pub mod mirror;
pub mod models;
pub mod oauth;
pub mod scanner;
pub mod store_meta;
pub mod verifier;

use db::Database;
use github::CatalogService;
use mirror::MirrorManager;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::mpsc::UnboundedSender;

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub catalog: CatalogService,
    pub mirror: Mutex<MirrorManager>,
    pub github_token: Mutex<Option<String>>,
}

pub static GLOBAL_QUOTA_TX: OnceLock<UnboundedSender<models::HostQuotaEvent>> = OnceLock::new();
/// FR-6.2 关注更新通知事件通道（`zstore://watch-updated`）。
pub static GLOBAL_WATCH_TX: OnceLock<UnboundedSender<models::WatchUpdatedPayload>> =
    OnceLock::new();

pub fn extract_rate_limit_headers(
    headers: &reqwest::header::HeaderMap,
) -> Option<(u32, u32, Option<i64>)> {
    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok())?;
    let limit = headers
        .get("x-ratelimit-limit")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok())?;
    let reset = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok());
    Some((remaining, limit, reset))
}

pub fn notify_rate_limit(host: &str, headers: &reqwest::header::HeaderMap) {
    if let Some((remaining, limit, reset)) = extract_rate_limit_headers(headers) {
        if let Some(tx) = GLOBAL_QUOTA_TX.get() {
            let _ = tx.send(models::HostQuotaEvent {
                host: host.to_lowercase(),
                rate_limit_remaining: Some(remaining),
                rate_limit_limit: Some(limit),
                rate_limit_reset: reset,
            });
        }
    }
}

pub async fn probe_github_rate_limit(token: Option<&str>) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("ZStore-Client/0.1.0"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github.v3+json"),
    );
    if let Some(tok) = token {
        if !tok.trim().is_empty() {
            if let Ok(v) =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", tok.trim()))
            {
                headers.insert(reqwest::header::AUTHORIZATION, v);
            }
        }
    }
    if let Ok(resp) = client
        .get("https://api.github.com/rate_limit")
        .headers(headers)
        .send()
        .await
    {
        notify_rate_limit("github.com", resp.headers());
    }
}

pub fn get_app_data_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
            return std::path::PathBuf::from(app_data).join("ZStore");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return std::path::PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("ZStore");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            return std::path::PathBuf::from(xdg).join("z-store");
        } else if let Ok(home) = std::env::var("HOME") {
            return std::path::PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("z-store");
        }
    }

    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        std::path::PathBuf::from(home).join(".z-store")
    } else {
        std::env::temp_dir().join("ZStore")
    }
}

#[cfg(target_os = "windows")]
fn init_windows_system_proxy() {
    if std::env::var("http_proxy").is_err() && std::env::var("HTTP_PROXY").is_err() {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(settings) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings") {
            let proxy_enable: u32 = settings.get_value("ProxyEnable").unwrap_or(0);
            if proxy_enable == 1 {
                if let Ok(proxy_server) = settings.get_value::<String, _>("ProxyServer") {
                    let trimmed = proxy_server.trim();
                    if !trimmed.is_empty() {
                        let full = if trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.starts_with("socks5://") {
                            trimmed.to_string()
                        } else {
                            format!("http://{}", trimmed)
                        };
                        std::env::set_var("http_proxy", &full);
                        std::env::set_var("https_proxy", &full);
                    }
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    init_windows_system_proxy();

    let db_dir = get_app_data_dir();
    let _ = std::fs::create_dir_all(&db_dir);
    let db_path = db_dir.join("z_store.db");

    let db = Database::open(&db_path)
        .or_else(|_| Database::open_in_memory())
        .expect("failed to init database");

    let saved_token = db
        .get_setting("github_token")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let saved_mirror = db.get_setting("active_mirror").ok().flatten();

    let catalog = CatalogService::new();
    let mut mirror = MirrorManager::new();
    if let Some(ref m_id) = saved_mirror {
        mirror.set_active_mirror(m_id);
    }

    let (quota_tx, mut quota_rx) = tokio::sync::mpsc::unbounded_channel::<models::HostQuotaEvent>();
    let _ = GLOBAL_QUOTA_TX.set(quota_tx);
    let (watch_tx, mut watch_rx) =
        tokio::sync::mpsc::unbounded_channel::<models::WatchUpdatedPayload>();
    let _ = GLOBAL_WATCH_TX.set(watch_tx);

    let db_arc = Arc::new(Mutex::new(db));
    let state = AppState {
        db: Arc::clone(&db_arc),
        catalog,
        mirror: Mutex::new(mirror),
        github_token: Mutex::new(saved_token.clone()),
    };

    let db_for_worker = Arc::clone(&db_arc);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                while let Some(ev) = quota_rx.recv().await {
                    if let Ok(db) = db_for_worker.lock() {
                        let _ = db.update_host_rate_limit(
                            &ev.host,
                            ev.rate_limit_remaining,
                            ev.rate_limit_limit,
                            ev.rate_limit_reset,
                        );
                    }
                    let _ = handle.emit("zstore://quota-updated", ev);
                }
            });
            let watch_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                while let Some(ev) = watch_rx.recv().await {
                    let _ = watch_handle.emit("zstore://watch-updated", ev);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::search_apps,
            commands::get_category_apps,
            commands::warmup_top_apps,
            commands::get_app_details,
            commands::get_installed_apps,
            commands::install_app,
            commands::uninstall_app,
            commands::unmanage_app,
            commands::check_for_updates,
            commands::get_mirror_status,
            commands::switch_mirror,
            commands::set_github_token,
            commands::get_settings,
            commands::save_setting,
            commands::get_favorites,
            commands::toggle_favorite,
            commands::ping_mirrors,
            commands::test_proxy,
            commands::get_app_readme,
            commands::get_catalog_count,
            commands::scan_and_match_local_apps,
            commands::import_matched_apps,
            commands::get_detected_installed_app_ids,
            commands::import_single_app,
            commands::launch_app,
            commands::get_update_rules,
            commands::set_app_skip_version,
            commands::set_app_frozen,
            commands::set_app_hidden,
            commands::remove_update_rule,
            commands::verify_file_signature,
            commands::get_developer_profile,
            commands::sync_github_starred,
            commands::record_search_query,
            commands::get_search_history,
            commands::clear_search_history,
            commands::remove_search_query,
            commands::record_app_view,
            commands::get_recently_viewed_apps,
            commands::clear_view_history,
            commands::get_host_tokens,
            commands::set_host_token,
            commands::remove_host_token,
            commands::refresh_host_rate_limit,
            commands::test_host_connection,
            commands::register_deep_link_scheme,
            commands::handle_deep_link,
            commands::get_cli_deep_link,
            commands::search_forge_repos,
            commands::sync_catalog,
            commands::select_folder,
            commands::get_or_fetch_icon,
            commands::open_url,
            commands::verify_ownership,
            commands::watch_app,
            commands::unwatch_app,
            commands::get_watched_apps,
            commands::oauth_device_start,
            commands::oauth_device_poll,
            commands::get_oauth_user,
            commands::oauth_logout,
            commands::star_app,
            commands::unstar_app,
            commands::is_starred,
            commands::import_user_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
