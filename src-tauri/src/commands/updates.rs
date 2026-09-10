use crate::models::{UpdateItem, UpdateRule, WatchUpdatedPayload, WatchedApp};
use crate::AppState;
use super::installer::get_installed_apps;
use std::collections::HashMap;
use tauri::State;

/// 轻量级获取应用最新版本号与更新说明（专为更新检查与关注动态设计）
/// 坚决不拉取 README.md、不拉取仓库详情与 Stars、不拉取 z-store.toml、不拉取校验和文件
/// 优先利用本地 ETag 缓存返回 304 Not Modified，将请求量与延迟降到最低
pub async fn fetch_app_latest_version_lightweight(
    state: &AppState,
    app_id: &str,
    force_refresh: Option<bool>,
) -> Result<(String, String), String> {
    let is_force = force_refresh.unwrap_or(false);
    let clean_id = app_id.trim().to_lowercase();

    let ttl_seconds = {
        if let Ok(db) = state.db.lock() {
            (db.get_detail_cache_ttl_minutes() as i64) * 60
        } else {
            crate::db::DETAIL_CACHE_TTL_DEFAULT_MINUTES * 60
        }
    };

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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let req = client.get(&ep).headers(headers).send();
    let resp = match tokio::time::timeout(std::time::Duration::from_secs(6), req).await {
        Ok(r) => r.ok(),
        Err(_) => None,
    };

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
            if let Some(ref payload) = cached_payload {
                if let Ok(parsed) =
                    serde_json::from_str::<crate::github::models::GitHubReleaseResponse>(payload)
                {
                    return Ok((parsed.tag_name, parsed.body.unwrap_or_default()));
                }
            }
            if let Ok(db) = state.db.lock() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                    return Ok((fallback.latest_version, fallback.changelog));
                }
            }
            if let Some(cat) = state.catalog.get_catalog_item(&clean_id) {
                return Ok((cat.default_version, String::new()));
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
pub fn is_version_newer(current: &str, latest: &str) -> bool {
    let parse_nums = |s: &str| -> Vec<u64> {
        let clean = s.trim_start_matches('v').trim();
        clean
            .split(['.', '-', '_'])
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
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> Result<Vec<UpdateItem>, String> {
    let installed = get_installed_apps(state.clone())?;
    let rules_map: HashMap<String, UpdateRule> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_all_rules()
            .unwrap_or_default()
            .into_iter()
            .map(|r| (r.app_id.to_lowercase(), r))
            .collect()
    };
    let mut updates = Vec::new();

    for app in installed {
        let rule_opt = rules_map.get(&app.app_id.to_lowercase());
        if let Some(rule) = rule_opt {
            if rule.is_frozen || rule.is_hidden {
                continue;
            }
        }

        if let Ok((latest_version, changelog)) =
            fetch_app_latest_version_lightweight(&state, &app.app_id, force_refresh).await
        {
            if should_include_update(&app.version, &latest_version, rule_opt) {
                let (icon, icon_bg) = if let Some(item) = state.catalog.get_catalog_item(&app.app_id) {
                    (Some(item.icon), Some(item.icon_bg))
                } else {
                    (app.icon.clone(), app.icon_bg.clone())
                };
                updates.push(UpdateItem {
                    app_id: app.app_id,
                    app_name: app.app_name,
                    current_version: app.version,
                    latest_version,
                    changelog,
                    icon,
                    icon_bg,
                });
            }
        }
    }

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
        if let Some(rule) = rules_map.get(&w.app_id.to_lowercase()) {
            if rule.is_frozen || rule.is_hidden {
                continue;
            }
        }
        let (latest, _) =
            match fetch_app_latest_version_lightweight(state, &w.app_id, force_refresh).await {
                Ok(res) => res,
                Err(_) => continue,
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
                if now.saturating_sub(t) < 86400 {
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
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_hidden_status(&app_id, is_hidden)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn remove_update_rule(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_rule(&app_id).map_err(|e| e.to_string())
}
