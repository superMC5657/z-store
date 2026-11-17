pub mod commands;
pub mod config;
pub mod date_utils;
pub mod db;
pub mod deeplink;
pub mod error;
pub mod forge;
pub mod github;
pub mod icons;
pub mod installer;
pub mod launchpad;
pub mod log_support;
pub mod mirror;
pub mod models;
pub mod oauth;
pub mod proxy;
pub mod repositories;
pub mod scanner;
#[cfg(test)]
pub(crate) mod test_support;
pub mod userdata;
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
    /// 清单同步串行互斥锁：防止启动后台增量同步与设置页手动同步并发交叉写库。
    pub sync_lock: tokio::sync::Mutex<()>,
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
    /// 集中收敛 `state.db.lock()` 样板（含毒锁映射）。
    /// `tauri::State<AppState>` 经 `Deref` 自动命中本方法，`&AppState` 直接调用。
    pub fn db(&self) -> Result<std::sync::MutexGuard<'_, Database>, String> {
        self.db.lock().map_err(|e| e.to_string())
    }

    /// 获取当前生效的 GitHub API 访问令牌（OAuth 登录令牌优先，其次主机令牌）。
    pub(crate) fn active_github_token(&self) -> Option<String> {
        if let Ok(t) = self.github_token.lock() {
            if let Some(ref tok) = *t {
                if !tok.trim().is_empty() {
                    return Some(tok.trim().to_string());
                }
            }
        }
        if let Ok(db) = self.db() {
            if let Ok(Some(t)) = db.get_setting(crate::oauth::SETTING_OAUTH_TOKEN) {
                let clean = t.trim().to_string();
                if !clean.is_empty() {
                    if let Ok(mut mem) = self.github_token.lock() {
                        *mem = Some(clean.clone());
                    }
                    return Some(clean);
                }
            }
            if let Ok(Some(t)) = db.get_host_token("github.com") {
                let clean = t.trim().to_string();
                if !clean.is_empty() {
                    return Some(clean);
                }
            }
        }
        None
    }
}

/// 401 统一收敛（通知 + warn 日志），返回是否命中过期。
/// 30 秒内并发请求命中 401 仅记录一条日志，避免详情并发子请求重复刷屏。
pub(crate) fn check_auth_expired(status: u16, ctx: &str) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST_401_LOG_MS: AtomicU64 = AtomicU64::new(0);
    if status == 401 {
        notify_auth_expired();
        let now = now_ms();
        let prev = LAST_401_LOG_MS.load(Ordering::Relaxed);
        if now.saturating_sub(prev) >= 30_000
            && LAST_401_LOG_MS
                .compare_exchange(prev, now, Ordering::SeqCst, Ordering::Relaxed)
                .is_ok()
        {
            log::warn!(target: "oauth", "auth expired status=401 {}", ctx);
        }
        true
    } else {
        false
    }
}

/// 共享 API 连接池（与 `forge::http::new_api_client` 同一池，跟随当前系统代理快照热重建）。
/// 命令层每次调用即取当前池，不持有启动期 Client。
pub fn shared_http_client() -> reqwest::Client {
    crate::forge::http::api_client(config::get_project_config().network.api_timeout_seconds)
}

pub static GLOBAL_QUOTA_TX: OnceLock<UnboundedSender<models::HostQuotaEvent>> = OnceLock::new();
/// 关注更新通知事件通道（`zstore://watch-updated`）。
pub static GLOBAL_WATCH_TX: OnceLock<UnboundedSender<models::WatchUpdatedPayload>> =
    OnceLock::new();
/// GitHub OAuth 登录凭证失效通知通道（`zstore://oauth-expired`）。
pub static GLOBAL_AUTH_EXPIRED_TX: OnceLock<UnboundedSender<()>> = OnceLock::new();
/// 本地用户亲和度画像变更通知通道（`zstore://affinity-updated`）。
pub static GLOBAL_AFFINITY_TX: OnceLock<UnboundedSender<()>> = OnceLock::new();

pub fn notify_auth_expired() {
    if let Some(tx) = GLOBAL_AUTH_EXPIRED_TX.get() {
        let _ = tx.send(());
    }
}

pub fn notify_affinity_updated() {
    if let Some(tx) = GLOBAL_AFFINITY_TX.get() {
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
            target: "network",
            "rate limit exhausted host={} remaining=0 limit={}",
            host.to_lowercase(),
            limit
        );
    } else {
        log::warn!(
            target: "network",
            "rate limit low host={} remaining={}/{}",
            host.to_lowercase(),
            remaining,
            limit
        );
    }
}

/// 探针请求头收敛（委托 `forge::http` SSOT，与 `oauth::star::auth_headers` 同值）。
fn probe_headers(token: Option<&str>) -> reqwest::header::HeaderMap {
    crate::forge::http::api_headers(
        crate::forge::http::GITHUB_ACCEPT_VALUE,
        token,
        crate::forge::http::AuthScheme::Bearer,
    )
}

/// 主动探测 GitHub 配额并经 `notify_rate_limit` 走统一事件通道（DB 落库 + 前端 emit）。
/// 返回响应头提取的 `(remaining, limit, reset)`：调用方需要即时值时不必等事件落库
///（消除「sleep 等写入」竞态），网络失败/无头返回 `None`。
pub async fn probe_and_announce_rate_limit(token: Option<&str>) -> Option<(u32, u32, Option<i64>)> {
    let client = shared_http_client();
    let headers = probe_headers(token);
    if let Ok(resp) = client
        .get("https://api.github.com/rate_limit")
        .headers(headers)
        .send()
        .await
    {
        let quotas = extract_rate_limit_headers(resp.headers());
        notify_rate_limit("github.com", resp.headers());
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            notify_auth_expired();
        }
        quotas
    } else {
        None
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    z_log::install_panic_hook();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(z_log::init())
        .setup(move |app| {
            use tauri::Manager;
            // 在执行任何 DB / proxy / mirror / config 逻辑前，logger 已由 z_log::init() 就绪；
            // 先清理过期切片并记录 data_dir，保证后续所有告警与 panic 都能落盘。
            if let Ok(log_dir) = app.path().app_log_dir() {
                z_log::prune(&log_dir);
            }
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = APP_DATA_DIR.set(data_dir);
            }

            // 冻结启动期外部 env 代理并取首个快照摘要；此后运行期按快照实时感知系统代理变化。
            let proxy_summary = crate::proxy::capture_initial_env_proxy();

            let db_dir = get_app_data_dir();
            let _ = std::fs::create_dir_all(&db_dir);
            let db_path = db_dir.join("z_store.db");

            let config_source = crate::config::config_source_summary();
            let strict_errors = crate::config::is_strict_errors();

            let (db, db_mode, db_fallback_err) = match Database::open(&db_path) {
                Ok(db) => (db, "disk", None),
                Err(open_err) => {
                    if strict_errors {
                        panic!("db open failed strict_errors=true: {open_err}");
                    }
                    (
                        Database::open_in_memory().expect("failed to init database"),
                        "memory",
                        Some(open_err.to_string()),
                    )
                }
            };

            // 趋势榜与 ETag/详情缓存：启动后 best-effort 清扫过期/超量快照（吞错，不阻塞启动）。
            {
                let _ = db.prune_expired_trend_board_cache(now_secs());
                let _ = db.prune_starred_feed_cache(now_secs());
                let _ = db.prune_bounded_caches(
                    crate::db::cache::API_ETAG_CACHE_MAX_ROWS,
                    crate::db::cache::APP_DETAILS_CACHE_MAX_ROWS,
                );
                let assets_dir = db_dir.join("cache").join("assets");
                let _ = db.enforce_asset_quota_lru(&assets_dir);
            }

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

            // 首次启动且 catalog_apps 为空时从 catalog.json 播种写入；此后目录权威完全归 SQLite catalog_apps 维护。
            let _ = crate::repositories::CatalogRepository::seed_from_config_if_empty(&db);

            let catalog = CatalogService::new_empty();
            // 启动即从 SQLite catalog_apps + custom_apps 装载远端精选与本地收录 overlay（零网络）。
            catalog.sync_from_db(&db);
            let mut mirror = MirrorManager::new();
            if let Some(ref m_id) = saved_mirror {
                mirror.apply_initial_mirror(m_id);
            }
            let mirror_summary = mirror.active_summary();

            let (quota_tx, mut quota_rx) =
                tokio::sync::mpsc::unbounded_channel::<models::HostQuotaEvent>();
            let _ = GLOBAL_QUOTA_TX.set(quota_tx);
            let (watch_tx, mut watch_rx) =
                tokio::sync::mpsc::unbounded_channel::<models::WatchUpdatedPayload>();
            let _ = GLOBAL_WATCH_TX.set(watch_tx);
            let (auth_tx, mut auth_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
            let _ = GLOBAL_AUTH_EXPIRED_TX.set(auth_tx);
            let (affinity_tx, mut affinity_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
            let _ = GLOBAL_AFFINITY_TX.set(affinity_tx);

            let db_arc = Arc::new(Mutex::new(db));
            let state = AppState {
                db: Arc::clone(&db_arc),
                catalog,
                mirror: Mutex::new(mirror),
                github_token: Mutex::new(saved_token.clone()),
                sync_lock: tokio::sync::Mutex::new(()),
            };
            app.manage(state);

            let db_for_worker = Arc::clone(&db_arc);
            let db_for_auth = Arc::clone(&db_arc);
            let db_for_startup_affinity = Arc::clone(&db_arc);

            z_log::log_startup_banner(&z_log::StartupBanner {
                config_source,
                proxy: &proxy_summary,
                mirror: &mirror_summary,
                strict_errors,
                db_mode,
            });
            if db_fallback_err.is_some() {
                log::error!(target: "app", "db open failed fallback to in-memory");
            }
            for warn_msg in crate::config::take_startup_warnings() {
                log::warn!(target: "app", "{}", warn_msg);
            }
            // 收藏/关注收录标记回填：存量行按内存目录一次性校准（零网络）。
            crate::commands::backfill_cataloged_flags(app.state::<AppState>().inner());
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
                        // 无 github.com 主机令牌兜底时，私有列表快照与私有仓富卡随凭据失效一并清除。
                        let has_host_fallback = db
                            .get_host_token("github.com")
                            .ok()
                            .flatten()
                            .is_some_and(|s| !s.trim().is_empty());
                        if !has_host_fallback {
                            let _ = db.delete_starred_feed_cache_by_scope_prefix("@me:");
                            let _ = db.delete_private_repo_cards();
                            let _ = db.delete_private_search_list_cache();
                        }
                        if let Ok(Some(user_json)) =
                            db.get_setting(crate::oauth::SETTING_OAUTH_USER)
                        {
                            match serde_json::from_str::<crate::oauth::OAuthUser>(&user_json) {
                                Ok(mut user) => {
                                    user.is_expired = true;
                                    if let Ok(updated_json) = serde_json::to_string(&user) {
                                        let _ = db.set_setting(
                                            crate::oauth::SETTING_OAUTH_USER,
                                            &updated_json,
                                        );
                                    }
                                }
                                Err(e) => {
                                    // 无法解析的损坏快照直接清理，避免坏行永久残留。
                                    log::warn!(
                                        target: "oauth",
                                        "user snapshot invalid reason={} action=clear-and-relogin",
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

            let affinity_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                while affinity_rx.recv().await.is_some() {
                    let _ = affinity_handle.emit("zstore://affinity-updated", ());
                }
            });

            let init_token = saved_token.clone();
            tauri::async_runtime::spawn(async move {
                crate::probe_and_announce_rate_limit(init_token.as_deref()).await;
                if let Some(ref tok) = init_token {
                    let should_sync = db_for_startup_affinity
                        .lock()
                        .ok()
                        .map(|db| CatalogService::should_sync_affinity(&db, crate::now_secs()))
                        .unwrap_or(false);
                    if should_sync
                        && CatalogService::sync_github_affinity_signals_bg(
                            &db_for_startup_affinity,
                            tok,
                            None,
                        )
                        .await
                        .is_ok()
                    {
                        crate::notify_affinity_updated();
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::search_apps,
            commands::get_home_feed,
            commands::get_launchpad_feed,
            commands::sync_launchpad_discussions,
            commands::get_launchpad_discussion,
            commands::add_launchpad_comment,
            commands::toggle_launchpad_upvote,
            commands::get_featured_page,
            commands::get_affinity_profile_summary,
            commands::save_interest_seeds,
            commands::dismiss_featured,
            commands::clear_feed_feedback,
            commands::search_apps_online,
            commands::enrich_trend_repos,
            commands::get_category_apps,
            commands::get_latest_catalog_apps,
            commands::get_app_details,
            commands::get_platforms_lite,
            commands::get_cached_app_details_batch,
            commands::get_confirmed_icons_batch,
            commands::get_readme_variants,
            commands::fetch_or_cache_asset_url,
            commands::get_installed_apps,
            commands::install_app,
            commands::download_asset,
            commands::show_file_in_folder,
            commands::open_folder,
            commands::uninstall_app,
            commands::unmanage_app,
            commands::check_for_updates,
            commands::get_cached_updates,
            commands::switch_mirror,
            commands::get_settings,
            commands::save_setting,
            commands::get_favorites,
            commands::get_favorite_entries,
            commands::toggle_favorite,
            commands::test_proxy,
            commands::fetch_trends_text,
            commands::get_trend_board_cache,
            commands::save_trend_board_cache,
            commands::scan_and_match_local_apps,
            commands::import_matched_apps,
            commands::launch_app,
            commands::get_update_rules,
            commands::set_app_skip_version,
            commands::set_app_frozen,
            commands::set_app_hidden,
            commands::get_developer_profile,
            commands::list_github_starred,
            commands::get_starred_feed_cache,
            commands::save_starred_feed_cache,
            commands::get_repo_cards_batch,
            commands::get_search_list_cache,
            commands::save_search_list_cache,
            commands::sync_affinity_signals,
            commands::record_search_query,
            commands::get_search_history,
            commands::clear_search_history,
            commands::remove_search_query,
            commands::record_app_view,
            commands::get_recently_viewed_apps,
            commands::register_deep_link_scheme,
            commands::handle_deep_link,
            commands::get_cli_deep_link,
            commands::sync_catalog,
            commands::list_custom_apps,
            commands::save_custom_app,
            commands::delete_custom_app,
            commands::collect_local_app,
            commands::revert_collected_to_draft,
            commands::withdraw_submitted,
            commands::mark_submitted,
            commands::get_custom_app_pr_url,
            commands::get_custom_app_pr_payload,
            commands::get_license_allowlist,
            commands::select_folder,
            commands::get_or_fetch_icon,
            commands::cycle_app_icon,
            commands::restore_or_fetch_icon_cycle,
            commands::open_url,
            commands::watch_app,
            commands::unwatch_app,
            commands::get_watched_apps,
            commands::get_watch_notifications,
            commands::dismiss_watch_notification,
            commands::get_dismissed_watch_notifications,
            commands::restore_watch_notification,
            commands::oauth_device_start,
            commands::oauth_device_poll,
            commands::get_oauth_user,
            commands::oauth_logout,
            commands::star_app,
            commands::unstar_app,
            commands::fetch_starred_status,
            commands::import_user_data,
            commands::export_backup_file,
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
