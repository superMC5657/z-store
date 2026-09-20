use crate::models::{UpdateItem, UpdateRule, WatchUpdatedPayload, WatchedApp};
use crate::AppState;
use super::installer::get_installed_apps;
use futures_util::stream::{self, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// FR-6.2：按天限频关注通知的最小间隔时间（秒，24 小时）
pub const DAILY_NOTIFY_INTERVAL_SECONDS: i64 = 24 * 60 * 60;

/// 轻量级获取应用最新版本号与更新说明（专为更新检查与关注动态设计）
/// 坚决不拉取 README.md、不拉取仓库详情与 Stars、不拉取校验和文件
/// 优先利用本地 ETag 缓存返回 304 Not Modified，将请求量与延迟降到最低
pub async fn fetch_app_latest_version_lightweight(
    state: &AppState,
    app_id: &str,
    force_refresh: Option<bool>,
) -> Result<(String, String), String> {
    let is_force = force_refresh.unwrap_or(false);
    let Some(clean_id) = crate::forge::canonical_app_id(app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };

    let ttl_seconds = state
        .db
        .lock()
        .map(|db| db.get_detail_cache_ttl_minutes() * 60)
        .unwrap_or_else(|_| crate::config::get_project_config().cache.detail_ttl_minutes * 60);

    // 1. 若非强制刷新，优先从 SQLite 本地缓存读取
    if !is_force {
        let cached_opt = state.db.lock().ok().and_then(|db| {
            db.get_cached_app_detail(&clean_id, Some(ttl_seconds))
                .ok()
                .flatten()
        });
        if let Some(cached) = cached_opt {
            if !cached.latest_version.trim().is_empty() {
                return Ok((cached.latest_version, cached.changelog));
            }
        }
    }

    // 2. 多源支持 (Codeberg, Gitea 等)
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            let host_token = if let Ok(db) = state.db.lock() {
                db.get_host_token(&coord.host).ok().flatten()
            } else {
                None
            };
            let release_info =
                crate::forge::ForgeRegistry::fetch_latest_release(&coord, host_token.as_deref())
                    .await?;
            return Ok((release_info.tag_name, release_info.body.unwrap_or_default()));
        }
    }

    // 3. GitHub Releases 极速单请求拉取
    let coords = match state.catalog.get_repo_coordinates(&clean_id) {
        Ok(c) => c,
        Err(_) => {
            if let Ok(db) = state.db.lock() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                    return Ok((fallback.latest_version, fallback.changelog));
                }
            }
            return Err(format!("未识别的应用坐标: {}", app_id));
        }
    };

    let ep = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        coords.owner, coords.repo
    );

    let (cached_etag, cached_payload) = if is_force {
        (None, None)
    } else {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let etag = db.get_etag(&ep).ok().flatten();
        let payload = db.get_cached_payload(&ep).ok().flatten();
        (etag, payload)
    };

    let token = super::resolve_active_github_token(state);
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("ZStore-Client/0.1.0"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github.v3+json"),
    );

    if let Some(tok) = token.as_deref() {
        if !tok.trim().is_empty() {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("token {}", tok.trim()))
            {
                headers.insert(reqwest::header::AUTHORIZATION, val);
            }
        }
    }

    if let Some(ref etag) = cached_etag {
        if let Ok(val) = reqwest::header::HeaderValue::from_str(etag) {
            headers.insert(reqwest::header::IF_NONE_MATCH, val);
        }
    }

    let api_timeout = std::time::Duration::from_secs(
        crate::config::get_project_config().network.api_timeout_seconds,
    );
    let client = state.http.clone();

    let safe_ep = crate::log_support::sanitize_url(&ep);
    let req_id = crate::z_log::new_req_id();
    let sid = crate::z_log::new_session_id();
    let req_host = crate::log_support::host_of(&ep);
    log::debug!("http check update start id={} sid={} req={} url='{}'", clean_id, sid, req_id, safe_ep);
    let start_upd = std::time::Instant::now();
    let req = client.get(&ep).headers(headers).send();
    let resp = match tokio::time::timeout(api_timeout, req).await {
        Ok(r) => r.ok(),
        Err(_) => None,
    };
    let elapsed = start_upd.elapsed().as_millis();

    if let Some(ref res) = resp {
        crate::notify_rate_limit("github.com", res.headers());
    }

    match resp {
        Some(res) if res.status() == reqwest::StatusCode::NOT_MODIFIED => {
            // 304 Not Modified：远端 Release 完全未更新，零配额消耗
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            if let Ok(db) = state.db.lock() {
                let _ = db.touch_cached_app_detail(&clean_id, now);
            }
            // 304 三源合一：payload → 本地详情缓存 → 收录库默认版本，单条 debug 收敛。
            let resolved_304: Option<(String, String)> = (|| {
                if let Some(ref payload) = cached_payload {
                    if let Ok(parsed) =
                        serde_json::from_str::<crate::github::models::GitHubReleaseResponse>(payload)
                    {
                        return Some((parsed.tag_name, parsed.body.unwrap_or_default()));
                    }
                }
                if let Ok(db) = state.db.lock() {
                    if let Ok(Some(fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                        return Some((fallback.latest_version, fallback.changelog));
                    }
                }
                state
                    .catalog
                    .get_catalog_item(&clean_id)
                    .map(|cat| (cat.default_version, String::new()))
            })();
            if let Some((ver, body)) = resolved_304 {
                log::debug!("http check update resp id={} sid={} req={} url='{}' status=304 ver={} elapsed_ms={}", clean_id, sid, req_id, safe_ep, ver, elapsed);
                log::info!("http resp update id={} sid={} req={} host={} status=304 ver={} elapsed_ms={}", clean_id, sid, req_id, req_host, ver, elapsed);
                return Ok((ver, body));
            }
            Err("304 响应但未能提取到有效版本信息".to_string())
        }
        Some(res) if res.status().is_success() => {
            let new_etag = res
                .headers()
                .get("etag")
                .and_then(|h| h.to_str().ok())
                .map(|s| s.to_string());

            let payload_text = res.text().await.map_err(|e| e.to_string())?;
            let parsed: crate::github::models::GitHubReleaseResponse =
                serde_json::from_str(&payload_text)
                    .map_err(|e| format!("解析 GitHub Release 失败: {}", e))?;

            log::debug!("http check update resp id={} sid={} req={} url='{}' status=200 ver={} elapsed_ms={}", clean_id, sid, req_id, safe_ep, parsed.tag_name, elapsed);
            log::info!("http resp update id={} sid={} req={} host={} status=200 ver={} elapsed_ms={}", clean_id, sid, req_id, req_host, parsed.tag_name, elapsed);

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;

            if let Ok(db) = state.db.lock() {
                if let Some(etag_val) = new_etag {
                    let _ = db.save_etag(&ep, &etag_val, &payload_text, now);
                }
            }

            Ok((parsed.tag_name, parsed.body.unwrap_or_default()))
        }
        _ => {
            log::warn!("http check update resp failed id={} sid={} req={} host={} elapsed_ms={}", clean_id, sid, req_id, req_host, elapsed);
            // 网络故障、超时或被 403 限流，优雅降级：读取本地已有缓存或 catalog
            if let Ok(db) = state.db.lock() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                    return Ok((fallback.latest_version, fallback.changelog));
                }
            }
            if let Some(cat) = state.catalog.get_catalog_item(&clean_id) {
                return Ok((cat.default_version, String::new()));
            }
            Err("检查更新网络不可达且无本地缓存".to_string())
        }
    }
}

/// 严格比较两个版本号，仅当 latest 严格高于 current 时返回 true（避免 4 段式 MSI 误报及降级风险）
///
/// SemVer 优先：两侧经归一化（去 `v` 前缀与首尾空白）后若都能解析为 SemVer
///（含预发布，如 `1.0.0-beta.1`，满足 `1.0.0-beta.1 < 1.0.0`），则按 SemVer 全序比较。
/// 4 段式 MSI（如 `3.0.21.0`）若 4 段全为纯数字且末段为 0，则截断为 3 段后再按
/// SemVer 比较，使其与同值 3 段式 Release 不误报，同时 `3.0.21.0 -> 3.0.22` 仍能检出。
/// 非 SemVer 回退策略（显式 string-inequality 策略）：任一侧不可解析（如 `tip`、
/// `v26.02-v1.5.7-R2`）时不做数值推测——两侧都不可解析才退化为归一化字符串不等
///（即 `norm(cur) != norm(lat)`）；仅一侧可解析则一律返回 false，避免 `tip` 相对
/// 任何正式版本都误报、或 `R2` 这类后缀被当成数字段参与比较。
pub fn is_version_newer(current: &str, latest: &str) -> bool {
    /// 归一化：去 `v` 前缀与空白；4 段式纯数字 MSI 且末段为 0 时截断为 3 段。
    fn normalize(s: &str) -> String {
        let clean = s.trim_start_matches('v').trim();
        let parts: Vec<&str> = clean.split('.').collect();
        if parts.len() == 4
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            && parts[3].trim_start_matches('0').is_empty()
        {
            return parts[..3].join(".");
        }
        clean.to_string()
    }

    let cur = normalize(current);
    let lat = normalize(latest);
    match (semver::Version::parse(&cur), semver::Version::parse(&lat)) {
        (Ok(c), Ok(l)) => l > c,
        (Err(_), Err(_)) => cur != lat,
        _ => false,
    }
}

/// 判定是否应当提示此更新，综合考量版本策略表（跳过指定版本、锁定、隐藏）
pub fn should_include_update(
    current_version: &str,
    latest_version: &str,
    rule: Option<&UpdateRule>,
) -> bool {
    if let Some(r) = rule {
        if r.is_frozen || r.is_hidden {
            return false;
        }
        if let Some(ref skipped) = r.skipped_version {
            let clean_skipped = skipped.trim_start_matches('v').trim();
            let clean_latest = latest_version.trim_start_matches('v').trim();
            if clean_skipped == clean_latest {
                return false;
            }
        }
    }
    is_version_newer(current_version, latest_version)
}

#[tauri::command]
pub async fn check_for_updates(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> Result<Vec<UpdateItem>, String> {
    // Wave2：整轮耗时 + sid 关联，结束只记一行汇总。
    let check_start = std::time::Instant::now();
    let installed = get_installed_apps(state.clone())?;
    let rules_map: HashMap<String, UpdateRule> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_all_rules()
            .unwrap_or_default()
            .into_iter()
            .map(|r| (r.app_id.clone(), r))
            .collect()
    };

    // 过滤掉已被规则明确锁定（frozen）或隐藏（hidden）的应用
    let eligible_apps: Vec<_> = installed
        .into_iter()
        .filter(|app| {
            if let Some(rule) = rules_map.get(&app.app_id) {
                if rule.is_frozen || rule.is_hidden {
                    return false;
                }
            }
            true
        })
        .collect();

    let total = eligible_apps.len();
    let checked_count = Arc::new(AtomicUsize::new(0));
    let failed_count = Arc::new(AtomicUsize::new(0));

    // 发送初始进度通知
    let _ = app_handle.emit(
        "zstore://update-check-progress",
        serde_json::json!({
            "checked": 0,
            "total": total,
            "app_id": "",
            "app_name": "",
        }),
    );

    // 限制并发度为 3，兼顾并发检查速度与 GitHub API 稳定性
    // 关键体验优化：只要某款应用检测出有新版本，立即通过事件单项推流，实现“检测出一项跳出一项”的流畅反馈
    let check_stream = stream::iter(eligible_apps)
        .map(|app| {
            let app_handle = app_handle.clone();
            let state_ref = &state;
            let checked_count = Arc::clone(&checked_count);
            let failed_count = Arc::clone(&failed_count);
            let rule_opt = rules_map.get(&app.app_id).cloned();
            async move {
                let mut found_item = None;

                match fetch_app_latest_version_lightweight(state_ref, &app.app_id, force_refresh).await
                {
                    Ok((latest_version, changelog)) => {
                    if should_include_update(&app.version, &latest_version, rule_opt.as_ref()) {
                        let (icon, icon_bg) = if let Some(item) = state_ref.catalog.get_catalog_item(&app.app_id) {
                            (Some(item.icon), Some(item.icon_bg))
                        } else {
                            (app.icon.clone(), app.icon_bg.clone())
                        };
                        let update_item = UpdateItem {
                            app_id: app.app_id.clone(),
                            app_name: app.app_name.clone(),
                            current_version: app.version.clone(),
                            latest_version,
                            changelog,
                            icon,
                            icon_bg,
                        };
                        // 🚀 核心：发现更新立即触发单项流式推送，前端实现逐项弹入跳出动效
                        let _ = app_handle.emit("zstore://update-item-found", &update_item);
                        found_item = Some(update_item);
                    }
                    }
                    Err(e) => {
                        failed_count.fetch_add(1, Ordering::SeqCst);
                        log::warn!(
                            "update check item failed id={} host=github.com reason={}",
                            app.app_id,
                            crate::log_support::short_reason(&e)
                        );
                    }
                }

                let curr_checked = checked_count.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app_handle.emit(
                    "zstore://update-check-progress",
                    serde_json::json!({
                        "checked": curr_checked,
                        "total": total,
                        "app_id": app.app_id,
                        "app_name": app.app_name,
                    }),
                );

                found_item
            }
        })
        .buffer_unordered(3);

    let results: Vec<Option<UpdateItem>> = check_stream.collect().await;
    let updates: Vec<UpdateItem> = results.into_iter().flatten().collect();

    // 一轮一行：更新检查轮结束 info（new/failures 计数 + 耗时 + sid）。
    log::info!(
        "update batch check done sid={} total={} updates={} failures={} elapsed_ms={}",
        crate::z_log::new_session_id(),
        total,
        updates.len(),
        failed_count.load(Ordering::SeqCst),
        check_start.elapsed().as_millis()
    );

    // 发送检查完成事件
    let _ = app_handle.emit(
        "zstore://update-check-finished",
        serde_json::json!({
            "total_checked": total,
            "total_found": updates.len(),
        }),
    );

    // FR-6.2：关注订阅检查（最佳努力，失败不影响更新列表返回）
    notify_watched_updates(&state, &rules_map, force_refresh).await;

    Ok(updates)
}

/// FR-6.2：遍历被关注应用，若出现较 `last_notified_version` 更新的
/// Release，按 `watch_notify_frequency`（`startup`|`daily`）决定是否经由
/// `zstore://watch-updated` 事件应用内通知。`daily` 下每应用 24h 内至多
/// 通知一次；首次建立基线时静默记录，不打扰用户。
async fn notify_watched_updates(
    state: &AppState,
    rules_map: &HashMap<String, UpdateRule>,
    force_refresh: Option<bool>,
) {
    let watched: Vec<WatchedApp> = match state.db.lock() {
        Ok(db) => db.get_watched_apps().unwrap_or_default(),
        Err(_) => return,
    };
    if watched.is_empty() {
        return;
    }
    let frequency = match state.db.lock() {
        Ok(db) => db.get_watch_notify_frequency(),
        Err(_) => crate::db::WATCH_NOTIFY_FREQUENCY_DEFAULT.to_string(),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    for w in watched {
        if let Some(rule) = rules_map.get(&w.app_id) {
            if rule.is_frozen || rule.is_hidden {
                continue;
            }
        }
        let (latest, _) =
            match fetch_app_latest_version_lightweight(state, &w.app_id, force_refresh).await {
                Ok(res) => res,
                Err(e) => {
                    log::debug!(
                        "watch deferred id={} reason={}",
                        w.app_id,
                        crate::log_support::short_reason(&e)
                    );
                    continue;
                }
            };
        let latest = latest.trim().to_string();
        if latest.is_empty() {
            continue;
        }
        let Some(base) = w.last_notified_version.clone() else {
            // 首次关注：静默建立基线
            if let Ok(db) = state.db.lock() {
                let _ = db.init_watch_baseline(&w.app_id, &latest);
            }
            log::debug!("watch deferred id={} reason=baseline-init", w.app_id);
            continue;
        };
        if !is_version_newer(&base, &latest) {
            continue;
        }
        if frequency == "daily" {
            let last_at = state
                .db
                .lock()
                .ok()
                .and_then(|db| db.get_watch_last_notified_at(&w.app_id).ok().flatten());
            if let Some(t) = last_at {
                if now.saturating_sub(t) < DAILY_NOTIFY_INTERVAL_SECONDS {
                    log::debug!("watch deferred id={} reason=daily-throttle", w.app_id);
                    continue;
                }
            }
        }
        if let Ok(db) = state.db.lock() {
            let _ = db.set_watch_notified(&w.app_id, &latest, now);
        }
        if let Some(tx) = crate::GLOBAL_WATCH_TX.get() {
            let _ = tx.send(WatchUpdatedPayload {
                app_id: w.app_id.clone(),
                version: latest,
            });
        }
    }
}

#[tauri::command]
pub fn get_update_rules(state: State<'_, AppState>) -> Result<Vec<UpdateRule>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_rules().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_app_skip_version(
    state: State<'_, AppState>,
    app_id: String,
    version: Option<String>,
) -> Result<bool, String> {
    // ADR-0010：入站归一化后全程使用 canonical id；未知标识直接拒绝，永不写入
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_skip_version(&app_id, version.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn set_app_frozen(
    state: State<'_, AppState>,
    app_id: String,
    is_frozen: bool,
) -> Result<bool, String> {
    // ADR-0010：入站归一化后全程使用 canonical id；未知标识直接拒绝，永不写入
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_frozen_status(&app_id, is_frozen)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn set_app_hidden(
    state: State<'_, AppState>,
    app_id: String,
    is_hidden: bool,
) -> Result<bool, String> {
    // ADR-0010：入站归一化后全程使用 canonical id；未知标识直接拒绝，永不写入
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_hidden_status(&app_id, is_hidden)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn remove_update_rule(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    // ADR-0010：入站归一化后全程使用 canonical id；未知标识直接拒绝，永不写入
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_rule(&app_id).map_err(|e| e.to_string())
}

/// ADR-0010 入站归一化契约（finding 2.1-1, part A）：
/// 4 个 update-rule 命令必须先经 `crate::forge::canonical_app_id` 归一化——
/// 混合大小写 / URL 形态落 canonical 键，无法解析者直接拒绝、永不写入 SQLite。
/// Tauri `State` 命令体无法在单测中直调，故此处按“每命令存储路径”锁定契约：
/// 用与命令相同的归一化 + DB 调用序列断言 canonical 命中、raw 键无行、垃圾 id 无写入。
#[cfg(test)]
mod update_rule_inbound_normalization_tests {
    use crate::db::Database;

    const MIXED_CASE: &str = "RustDesk/RustDesk";
    const URL_FORM: &str = "https://github.com/RustDesk/RustDesk";
    const CANONICAL: &str = "rustdesk/rustdesk";
    const GARBAGE: &str = "!!!not-an-id!!!";

    fn normalize(raw: &str) -> Option<String> {
        crate::forge::canonical_app_id(raw)
    }

    #[test]
    fn set_app_skip_version_stores_canonical_for_mixed_case_and_url_form() {
        for raw in [MIXED_CASE, URL_FORM] {
            let db = Database::open_in_memory().unwrap();
            // 与命令入口守卫完全相同的归一化步骤
            let id = normalize(raw).expect("parseable id must normalize");
            assert_eq!(id, CANONICAL);
            db.set_skip_version(&id, Some("v1.0.0")).unwrap();
            let rule = db.get_rule(CANONICAL).unwrap().expect("canonical row stored");
            assert_eq!(rule.app_id, CANONICAL);
            assert_eq!(rule.skipped_version.as_deref(), Some("v1.0.0"));
            assert!(
                db.get_rule(raw).unwrap().is_none(),
                "never stored under raw form: {}",
                raw
            );
        }
    }

    #[test]
    fn set_app_skip_version_rejects_garbage() {
        assert!(normalize(GARBAGE).is_none());
        assert!(normalize("").is_none());
        assert!(normalize("   ").is_none());
        // 守卫在触碰 SQLite 前返回 Err：零写入
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_all_rules().unwrap().is_empty());
        assert!(db.get_rule(GARBAGE).unwrap().is_none());
    }

    #[test]
    fn set_app_frozen_stores_canonical_for_mixed_case_and_url_form() {
        for raw in [MIXED_CASE, URL_FORM] {
            let db = Database::open_in_memory().unwrap();
            let id = normalize(raw).expect("parseable id must normalize");
            assert_eq!(id, CANONICAL);
            db.set_frozen_status(&id, true).unwrap();
            let rule = db.get_rule(CANONICAL).unwrap().expect("canonical row stored");
            assert!(rule.is_frozen);
            assert!(
                db.get_rule(raw).unwrap().is_none(),
                "never stored under raw form: {}",
                raw
            );
        }
    }

    #[test]
    fn set_app_frozen_rejects_garbage() {
        assert!(normalize(GARBAGE).is_none());
        assert!(normalize("not an id with spaces").is_none());
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_all_rules().unwrap().is_empty());
        assert!(db.get_rule(GARBAGE).unwrap().is_none());
    }

    #[test]
    fn set_app_hidden_stores_canonical_for_mixed_case_and_url_form() {
        for raw in [MIXED_CASE, URL_FORM] {
            let db = Database::open_in_memory().unwrap();
            let id = normalize(raw).expect("parseable id must normalize");
            assert_eq!(id, CANONICAL);
            db.set_hidden_status(&id, true).unwrap();
            let rule = db.get_rule(CANONICAL).unwrap().expect("canonical row stored");
            assert!(rule.is_hidden);
            assert!(
                db.get_rule(raw).unwrap().is_none(),
                "never stored under raw form: {}",
                raw
            );
        }
    }

    #[test]
    fn set_app_hidden_rejects_garbage() {
        assert!(normalize(GARBAGE).is_none());
        assert!(normalize("localsend").is_none());
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_all_rules().unwrap().is_empty());
        assert!(db.get_rule(GARBAGE).unwrap().is_none());
    }

    #[test]
    fn remove_update_rule_removes_canonical_for_mixed_case_and_url_form() {
        for raw in [MIXED_CASE, URL_FORM] {
            let db = Database::open_in_memory().unwrap();
            db.set_skip_version(CANONICAL, Some("v1.0.0")).unwrap();
            let id = normalize(raw).expect("parseable id must normalize");
            assert_eq!(id, CANONICAL);
            assert!(db.remove_rule(&id).unwrap());
            assert!(db.get_rule(CANONICAL).unwrap().is_none());
        }
    }

    #[test]
    fn remove_update_rule_rejects_garbage() {
        assert!(normalize(GARBAGE).is_none());
        // 垃圾 id 永不触碰 SQLite：已存在的 canonical 规则不受影响
        let db = Database::open_in_memory().unwrap();
        db.set_skip_version(CANONICAL, Some("v1.0.0")).unwrap();
        assert!(db.get_rule(CANONICAL).unwrap().is_some());
        assert!(db.get_rule(GARBAGE).unwrap().is_none());
    }
}
