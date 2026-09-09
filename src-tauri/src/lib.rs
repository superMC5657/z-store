pub mod commands;
pub mod config;
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
                    // 注册表可能是多协议形态（http=..;https=..;socks=..），需解析；
                    // 解析失败返回 None 时不设置，避免污染环境变量导致直连也被拖累。
                    if let Some(full) = normalize_windows_proxy_server(&proxy_server) {
                        std::env::set_var("http_proxy", &full);
                        std::env::set_var("https_proxy", &full);
                    }
                }
            }
        }
    }
}

/// 解析 Windows 注册表 `ProxyServer` 值（纯函数，可单元测试）。
/// 接受三种形态：`host:port`、`scheme://host:port`、多协议
/// （`http=..;https=..;socks=..`，优先取 https 条目）。
/// 返回归一化的代理 URL；无法解析返回 None（调用方不设置环境变量，
/// 保持直连，避免一条坏代理拖累所有请求）。
#[cfg(target_os = "windows")]
fn normalize_windows_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut https_pick: Option<&str> = None;
    let mut http_pick: Option<&str> = None;
    let mut other_pick: Option<&str> = None;
    let mut plain_pick: Option<&str> = None;
    for part in raw.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((proto, addr)) = part.split_once('=') {
            let addr = addr.trim();
            if addr.is_empty() {
                continue;
            }
            match proto.trim().to_ascii_lowercase().as_str() {
                "https" => {
                    https_pick = Some(addr);
                    break;
                }
                "http" => {
                    if http_pick.is_none() {
                        http_pick = Some(addr);
                    }
                }
                _ => {
                    if other_pick.is_none() {
                        other_pick = Some(addr);
                    }
                }
            }
        } else if plain_pick.is_none() {
            plain_pick = Some(part);
        }
    }
    let addr = https_pick
        .or(http_pick)
        .or(other_pick)
        .or(plain_pick)?
        .trim();
    if addr.is_empty() {
        return None;
    }
    let lower = addr.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
        || lower.starts_with("socks4")
    {
        Some(addr.to_string())
    } else if addr.contains(':') {
        Some(format!("http://{}", addr))
    } else {
        None
    }
}

#[cfg(all(test, target_os = "windows"))]
mod proxy_tests {    use super::normalize_windows_proxy_server;

    #[test]
    fn test_normalize_proxy_server_forms() {
        // 裸 host:port
        assert_eq!(
            normalize_windows_proxy_server("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        // 自带 scheme
        assert_eq!(
            normalize_windows_proxy_server("http://127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_windows_proxy_server("socks5://127.0.0.1:7890"),
            Some("socks5://127.0.0.1:7890".to_string())
        );
        // 多协议形态优先 https
        assert_eq!(
            normalize_windows_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891"),
            Some("http://127.0.0.1:7891".to_string())
        );
        // 垃圾输入不污染环境
        assert_eq!(normalize_windows_proxy_server(""), None);
        assert_eq!(normalize_windows_proxy_server("   "), None);
        assert_eq!(normalize_windows_proxy_server("notaproxy"), None);
        assert_eq!(normalize_windows_proxy_server("http=;https="), None);
    }

    #[test]
    fn test_normalize_forward_proxy() {
        use super::normalize_forward_proxy;
        // 空输入 = 清空
        assert_eq!(normalize_forward_proxy(""), Ok(None));
        assert_eq!(normalize_forward_proxy("   "), Ok(None));
        // 裸 host:port 默认 http
        assert_eq!(
            normalize_forward_proxy("127.0.0.1:7890"),
            Ok(Some("http://127.0.0.1:7890/".to_string()))
        );
        // socks 形态保留（非标准 scheme，序列化不补斜杠）
        assert_eq!(
            normalize_forward_proxy("socks5://127.0.0.1:7890"),
            Ok(Some("socks5://127.0.0.1:7890".to_string()))
        );
        // 非法输入给原因
        assert!(normalize_forward_proxy("notaproxy").is_err());
        assert!(normalize_forward_proxy("http://127.0.0.1").is_err());
        assert!(normalize_forward_proxy("ftp://127.0.0.1:21").is_err());
    }
}

/// 出站代理（登录与 API 直连共用）的设置项键。
pub const FORWARD_PROXY_SETTING: &str = "http_proxy_url";

/// 校验并归一化用户填写的出站代理（纯函数，可单元测试）。
/// 接受 `host:port`、`http(s)://host:port`、`socks5(h)://host:port`；
/// 空输入返回 `Ok(None)`（表示清空，回退系统代理/直连）；非法返回 Err(原因)。
pub fn normalize_forward_proxy(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };
    let url = reqwest::Url::parse(&with_scheme)
        .map_err(|_| format!("代理地址无法解析：{}", trimmed))?;
    match url.scheme() {
        "http" | "https" | "socks5" | "socks5h" | "socks4" | "socks4a" => {}
        other => {
            return Err(format!(
                "不支持的代理协议：{}（仅支持 http/https/socks5）",
                other
            ))
        }
    }
    if url.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err("代理地址缺少主机名".to_string());
    }
    if url.port().is_none() {
        return Err("代理地址缺少端口，如 127.0.0.1:7890".to_string());
    }
    Ok(Some(url.to_string()))
}

/// 将出站代理应用到进程环境变量（reqwest 默认读取，全部请求即时生效，无需重启）。
/// `None` 表示清空，回退系统代理/直连（Windows 下重新读取注册表系统代理）。
pub fn apply_forward_proxy_env(url: Option<&str>) {
    match url {
        Some(u) if !u.trim().is_empty() => {
            std::env::set_var("http_proxy", u.trim());
            std::env::set_var("https_proxy", u.trim());
        }
        _ => {
            std::env::remove_var("http_proxy");
            std::env::remove_var("https_proxy");
            #[cfg(target_os = "windows")]
            init_windows_system_proxy();
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

    // 出站代理：用户配置优先，缺省回退系统代理 env/直连。
    if let Ok(Some(saved_proxy)) = db.get_setting(FORWARD_PROXY_SETTING) {
        if let Ok(Some(url)) = normalize_forward_proxy(&saved_proxy) {
            apply_forward_proxy_env(Some(&url));
        }
    }

    let saved_token = db
        .get_setting(crate::oauth::SETTING_OAUTH_TOKEN)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            db.get_setting("github_token")
                .ok()
                .flatten()
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| {
            db.get_host_token("github.com")
                .ok()
                .flatten()
                .filter(|s| !s.trim().is_empty())
        });
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

            let init_token = saved_token.clone();
            tauri::async_runtime::spawn(async move {
                crate::probe_github_rate_limit(init_token.as_deref()).await;
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
            commands::set_forward_proxy,
            commands::test_forward_proxy,
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
