use crate::models::{UpdateItem, UpdateRule, WatchUpdatedPayload, WatchedApp};
use crate::AppState;
use super::catalog::{get_app_details, get_app_details_impl};
use super::installer::get_installed_apps;
use std::collections::HashMap;
use tauri::State;

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

        if let Ok(detail) = get_app_details(state.clone(), app.app_id.clone(), force_refresh).await {
            if should_include_update(&app.version, &detail.latest_version, rule_opt) {
                let (icon, icon_bg) = if let Some(item) = state.catalog.get_catalog_item(&app.app_id) {
                    (Some(item.icon), Some(item.icon_bg))
                } else {
                    (Some(detail.icon.clone()), Some(detail.icon_bg.clone()))
                };
                updates.push(UpdateItem {
                    app_id: app.app_id,
                    app_name: app.app_name,
                    current_version: app.version,
                    latest_version: detail.latest_version,
                    changelog: detail.changelog,
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
        let detail = match get_app_details_impl(state, w.app_id.clone(), force_refresh).await {
            Ok(d) => d,
            Err(_) => continue,
        };
        let latest = detail.latest_version.trim().to_string();
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
