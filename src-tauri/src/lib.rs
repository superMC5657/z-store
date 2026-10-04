pub mod commands;
pub mod config;
pub mod db;
pub mod deeplink;
pub mod error;
pub mod forge;
pub mod github;
pub mod installer;
pub mod log_support;
pub mod mirror;
pub mod models;
pub mod oauth;
pub mod scanner;
pub mod z_log;

pub use error::{AppError, AppResult};

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
    pub http: reqwest::Client,
}

/// 集中统一秒级 Unix 时间戳，替换各模块手写 SystemTime::now() 样板。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 集中统一毫秒级 Unix 时间戳。
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 计算数据的 SHA-256 哈希并返回小写十六进制字符串。
pub fn sha256_digest_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// 校验实际 SHA-256 哈希值与期望哈希值是否匹配（大小写不敏感且去除首尾空白）。
pub fn verify_sha256_str(actual_hex: &str, expected_hex: &str) -> bool {
    let exp = expected_hex.trim();
    let act = actual_hex.trim();
    !exp.is_empty() && !act.is_empty() && act.eq_ignore_ascii_case(exp)
}

impl AppState {
    /// H5：集中收敛 `state.db.lock()` 样板（含毒锁映射）。
    /// `tauri::State<AppState>` 经 `Deref` 自动命中本方法，`&AppState` 直接调用。
    pub fn db(&self) -> Result<std::sync::MutexGuard<'_, Database>, String> {
        self.db.lock().map_err(|e| e.to_string())
    }
}

/// H7：401 统一收敛（通知 + warn 日志），返回是否命中过期。
/// `ctx` 仅传 `op=...` 及必要的 `owner/repo` 上下文，不含 token/body。
pub(crate) fn check_auth_expired(status: u16, ctx: &str) -> bool {
    if status == 401 {
        notify_auth_expired();
        log::warn!("oauth auth expired status=401 {}", ctx);
        true
    } else {
        false
    }
}

static SHARED_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn build_shared_http_client() -> reqwest::Client {
    let api_timeout =
        std::time::Duration::from_secs(config::get_project_config().network.api_timeout_seconds);
    reqwest::Client::builder()
        .timeout(api_timeout)
        .user_agent(crate::forge::http::USER_AGENT_VALUE)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

pub fn shared_http_client() -> reqwest::Client {
    SHARED_HTTP_CLIENT
        .get_or_init(build_shared_http_client)
        .clone()
}

pub static GLOBAL_QUOTA_TX: OnceLock<UnboundedSender<models::HostQuotaEvent>> = OnceLock::new();
/// FR-6.2 关注更新通知事件通道（`zstore://watch-updated`）。
pub static GLOBAL_WATCH_TX: OnceLock<UnboundedSender<models::WatchUpdatedPayload>> =
    OnceLock::new();
/// GitHub OAuth 登录凭证失效通知通道（`zstore://oauth-expired`）。
pub static GLOBAL_AUTH_EXPIRED_TX: OnceLock<UnboundedSender<()>> = OnceLock::new();

pub fn notify_auth_expired() {
    if let Some(tx) = GLOBAL_AUTH_EXPIRED_TX.get() {
        let _ = tx.send(());
    }
}

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
        log_rate_limit_water_mark(host, remaining, limit);
    }
}

/// 限额低水位日志：remaining<=10% warn，用尽 error；每进程每 host 每种只记一次。
fn log_rate_limit_water_mark(host: &str, remaining: u32, limit: u32) {
    use std::collections::HashSet;
    use std::sync::Mutex;
    static WARNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    if limit == 0 {
        return;
    }
    let kind: Option<&str> = if remaining == 0 {
        Some("exhausted")
    } else if remaining.saturating_mul(10) <= limit {
        Some("low")
    } else {
        None
    };
    let Some(kind) = kind else { return };
    let key = format!("{}:{}", host.to_lowercase(), kind);
    let first = WARNED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|mut g| g.insert(key))
        .unwrap_or(false);
    if !first {
        return;
    }
    if kind == "exhausted" {
        log::error!(
            "rate limit exhausted host={} remaining=0 limit={}",
            host.to_lowercase(),
            limit
        );
    } else {
        log::warn!(
            "rate limit low host={} remaining={}/{}",
            host.to_lowercase(),
            remaining,
            limit
        );
    }
}

/// H1：探针请求头收敛（委托 `forge::http` SSOT，与 `oauth::star::auth_headers` 同值）。
fn probe_headers(token: Option<&str>) -> reqwest::header::HeaderMap {
    crate::forge::http::api_headers(
        crate::forge::http::GITHUB_ACCEPT_VALUE,
        token,
        crate::forge::http::AuthScheme::Bearer,
    )
}

pub async fn probe_github_rate_limit(token: Option<&str>) {
    let client = shared_http_client();
    let headers = probe_headers(token);
    if let Ok(resp) = client
        .get("https://api.github.com/rate_limit")
        .headers(headers)
        .send()
        .await
    {
        notify_rate_limit("github.com", resp.headers());
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            notify_auth_expired();
        }
    }
}

static APP_DATA_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

pub fn get_app_data_dir() -> std::path::PathBuf {
    if let Some(dir) = APP_DATA_DIR.get() {
        return dir.clone();
    }
    resolve_default_app_data_dir()
}

pub fn resolve_default_app_data_dir() -> std::path::PathBuf {
    const IDENTIFIER: &str = "com.zstore.app";

    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            return std::path::PathBuf::from(app_data).join(IDENTIFIER);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return std::path::PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(IDENTIFIER);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            return std::path::PathBuf::from(xdg).join(IDENTIFIER);
        } else if let Ok(home) = std::env::var("HOME") {
            return std::path::PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(IDENTIFIER);
        }
    }

    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        std::path::PathBuf::from(home).join(format!(".{}", IDENTIFIER))
    } else {
        std::env::temp_dir().join(IDENTIFIER)
    }
}

#[cfg(target_os = "windows")]
fn init_windows_system_proxy() {
    if std::env::var("http_proxy").is_err() && std::env::var("HTTP_PROXY").is_err() {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(settings) =
            hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        {
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
mod proxy_tests {
    use super::normalize_windows_proxy_server;

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    z_log::install_panic_hook();
    #[cfg(target_os = "windows")]
    init_windows_system_proxy();

    let db_dir = get_app_data_dir();
    let _ = std::fs::create_dir_all(&db_dir);
    let db_path = db_dir.join("z_store.db");

    let db = Database::open(&db_path)
        .or_else(|_| {
            log::error!("db open failed fallback to in-memory");
            Database::open_in_memory()
        })
        .expect("failed to init database");

    let saved_token = db
        .get_setting(crate::oauth::SETTING_OAUTH_TOKEN)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
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
    let (auth_tx, mut auth_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let _ = GLOBAL_AUTH_EXPIRED_TX.set(auth_tx);

    let db_arc = Arc::new(Mutex::new(db));
    let http = shared_http_client();
    let state = AppState {
        db: Arc::clone(&db_arc),
        catalog,
        mirror: Mutex::new(mirror),
        github_token: Mutex::new(saved_token.clone()),
        http,
    };

    let db_for_worker = Arc::clone(&db_arc);
    let db_for_auth = Arc::clone(&db_arc);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(z_log::init())
        .manage(state)
        .setup(move |app| {
            use tauri::Manager;
            // 记录新会话启动横幅
            z_log::log_session_start();
            // setup 之前先 prune：清理过期/超量日志
            if let Ok(log_dir) = app.path().app_log_dir() {
                z_log::prune(&log_dir);
            }
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = APP_DATA_DIR.set(data_dir);
            }
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
            let auth_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::{Emitter, Manager};
                while auth_rx.recv().await.is_some() {
                    if let Ok(db) = db_for_auth.lock() {
                        let _ = db.remove_setting(crate::oauth::SETTING_OAUTH_TOKEN);
                        if let Ok(Some(user_json)) = db.get_setting(crate::oauth::SETTING_OAUTH_USER) {
                            match serde_json::from_str::<crate::oauth::OAuthUser>(&user_json) {
                                Ok(mut user) => {
                                    user.is_expired = true;
                                    if let Ok(updated_json) = serde_json::to_string(&user) {
                                        let _ = db.set_setting(crate::oauth::SETTING_OAUTH_USER, &updated_json);
                                    }
                                }
                                Err(e) => {
                                    // 旧持久化缺字段无法解析：清理过期快照，用户需重新登录。
                                    log::warn!(
                                        "oauth user snapshot invalid reason={} action=clear-and-relogin",
                                        crate::log_support::short_reason(&e.to_string())
                                    );
                                    let _ = db.remove_setting(crate::oauth::SETTING_OAUTH_USER);
                                }
                            }
                        }
                    }
                    if let Some(state) = auth_handle.try_state::<AppState>() {
                        if let Ok(mut mem) = state.github_token.lock() {
                            *mem = None;
                        }
                    }
                    let _ = auth_handle.emit("zstore://oauth-expired", ());
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
            commands::search_apps_online,
            commands::get_category_apps,
            commands::get_app_details,
            commands::get_readme_variants,
            commands::get_installed_apps,
            commands::install_app,
            commands::download_asset,
            commands::show_file_in_folder,
            commands::open_folder,
            commands::uninstall_app,
            commands::unmanage_app,
            commands::check_for_updates,
            commands::get_mirror_status,
            commands::switch_mirror,
            commands::get_settings,
            commands::save_setting,
            commands::get_favorites,
            commands::toggle_favorite,
            commands::test_proxy,
            commands::fetch_trends_text,
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
            commands::cycle_app_icon,
            commands::get_app_icon_cycle,
            commands::open_url,
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
            commands::import_user_data,
            z_log::zlog_get_dir,
            z_log::zlog_export_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_default_app_data_dir() {
        let dir = resolve_default_app_data_dir();
        let s = dir.to_string_lossy();
        assert!(s.ends_with("com.zstore.app") || s.ends_with(".com.zstore.app"));
    }
}
