use crate::installer::managed::{is_version_newer, should_include_update};
use crate::models::{UpdateItem, UpdateRule, WatchUpdatedPayload, WatchedApp};
use crate::repositories::detail_service::{self, LightweightRelease};
use crate::repositories::DetailSources;
use crate::AppState;
use futures_util::stream::{self, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// 按天限频关注通知的最小间隔时间（秒，24 小时）
pub const DAILY_NOTIFY_INTERVAL_SECONDS: i64 = 24 * 60 * 60;

/// 关注时的「近期发布」窗口（秒，7 天）：从未提醒过的关注应用，其最新 Release
/// 发布不足 7 天即作为一条动态提醒一次，而非静默记为基线。
pub const WATCH_RECENT_RELEASE_SECONDS: i64 = 7 * 24 * 60 * 60;

/// 轻量获取应用最新 Release（入参 id 归一后交由详情决议模块）。
async fn latest_release(
    state: &AppState,
    app_id: &str,
    force_refresh: Option<bool>,
) -> Result<LightweightRelease, String> {
    let clean_id = crate::commands::require_app_id(app_id)?;
    detail_service::resolve_latest_release_lightweight(
        state,
        DetailSources::default(),
        &clean_id,
        force_refresh.unwrap_or(false),
    )
    .await
}

/// 读取全量更新规则并按 `app_id` 建表；读取失败必须中止，避免已冻结/已隐藏/已跳过应用误报或误发提醒。
fn load_rules_map(state: &AppState) -> crate::AppResult<HashMap<String, UpdateRule>> {
    let db = state.db()?;
    Ok(db
        .get_all_rules()?
        .into_iter()
        .map(|r| (r.app_id.clone(), r))
        .collect())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn check_for_updates(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> crate::AppResult<Vec<UpdateItem>> {
    // 仅显式手动刷新（force_refresh == Some(true)）回写 update_results，默认只读。
    let is_force = force_refresh.unwrap_or(false);
    let check_start = std::time::Instant::now();
    let installed = crate::installer::managed::load_installed_apps(&state).await?;
    let installed_ids: Vec<String> = installed.iter().map(|a| a.app_id.clone()).collect();
    let rules_map = load_rules_map(&state)?;

    // 过滤掉已锁定版本的应用；隐藏应用照常检查，以便跳过其新版本
    let eligible_apps: Vec<_> = installed
        .into_iter()
        .filter(|app| {
            !rules_map
                .get(&app.app_id)
                .is_some_and(|rule| rule.is_frozen)
        })
        .collect();

    let total = eligible_apps.len();
    let checked_count = Arc::new(AtomicUsize::new(0));
    let failed_count = Arc::new(AtomicUsize::new(0));
    // 写包时间戳单点：同轮同 `checked_at`，读侧按行比对过期 decisions 一致。
    let checked_at = crate::now_secs();

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

    // 并发检查并逐项流式推送新版本事件（无序发射），全部完成后发射结束事件。
    let check_stream = stream::iter(eligible_apps)
        .map(|app| {
            let app_handle = app_handle.clone();
            let state_ref = &state;
            let checked_count = Arc::clone(&checked_count);
            let failed_count = Arc::clone(&failed_count);
            let rule_opt = rules_map.get(&app.app_id).cloned();
            async move {
                let mut found_item: Option<UpdateItem> = None;
                let mut write_row: Option<crate::db::UpdateCheckRow> = None;

                match latest_release(state_ref, &app.app_id, force_refresh).await {
                    Ok(rel) => {
                        let (latest_version, changelog) = (rel.tag, rel.body);
                        let has_update =
                            should_include_update(&app.version, &latest_version, rule_opt.as_ref());
                        let (icon, icon_bg) =
                            if let Some(item) = state_ref.catalog.get_catalog_item(&app.app_id) {
                                (Some(item.icon), Some(item.icon_bg))
                            } else {
                                (app.icon.clone(), app.icon_bg.clone())
                            };
                        write_row = Some(crate::db::UpdateCheckRow {
                            app_id: app.app_id.clone(),
                            app_name: app.app_name.clone(),
                            installed_version: app.version.clone(),
                            latest_version: latest_version.clone(),
                            has_update,
                            changelog: changelog.clone(),
                            icon: icon.clone(),
                            icon_bg: icon_bg.clone(),
                            checked_at,
                        });
                        if has_update {
                            let update_item = UpdateItem {
                                app_id: app.app_id.clone(),
                                app_name: app.app_name.clone(),
                                current_version: app.version.clone(),
                                latest_version,
                                changelog,
                                icon,
                                icon_bg,
                            };
                            // 发现更新立即单项流式推送
                            let _ = app_handle.emit("zstore://update-item-found", &update_item);
                            found_item = Some(update_item);
                        }
                    }
                    Err(e) => {
                        failed_count.fetch_add(1, Ordering::SeqCst);
                        let mut ev = crate::z_log::WideEvent::new("updater", "item failed");
                        ev.field("id", &app.app_id)
                            .field("host", "github.com")
                            .field("reason", crate::log_support::short_reason(&e));
                        ev.warn();
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

                (found_item, write_row)
            }
        })
        .buffer_unordered(6);

    let results: Vec<(Option<UpdateItem>, Option<crate::db::UpdateCheckRow>)> =
        check_stream.collect().await;
    let mut updates: Vec<UpdateItem> = Vec::new();
    let mut write_rows: Vec<crate::db::UpdateCheckRow> = Vec::new();
    for (item, row) in results {
        if let Some(u) = item {
            updates.push(u);
        }
        if let Some(r) = row {
            write_rows.push(r);
        }
    }

    // 手动刷新批量落库并清理已卸载项的旧判定行。
    if is_force {
        if let Ok(db) = state.db() {
            let _ = db.save_update_checks_batch(&write_rows);
            let _ = db.prune_update_results_not_in(&installed_ids);
        }
    }

    // 发送检查完成事件
    let _ = app_handle.emit(
        "zstore://update-check-finished",
        serde_json::json!({
            "total_checked": total,
            "total_found": updates.len(),
        }),
    );

    let mut ev = crate::z_log::WideEvent::new("updater", "check done").with_started(check_start);
    ev.field("total", total)
        .field("updates", updates.len())
        .field("failures", failed_count.load(Ordering::SeqCst))
        .dev("persisted", if is_force { write_rows.len() } else { 0 });
    ev.info();

    Ok(updates)
}

/// 检查关注应用的新版本并推送更新提醒（独立于已安装列表，返回待处理提醒）。
/// 缺省或 `forceRefresh=true` 走 ETag 条件请求联网；`forceRefresh=false` 只读本地缓存。
#[tauri::command(rename_all = "camelCase")]
pub async fn check_watched_updates(
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> crate::AppResult<Vec<WatchUpdatedPayload>> {
    let check_start = std::time::Instant::now();
    let rules_map = load_rules_map(&state)?;
    let force_refresh = Some(force_refresh.unwrap_or(true));
    let watch = notify_watched_updates(&state, &rules_map, force_refresh).await;

    let mut ev =
        crate::z_log::WideEvent::new("updater", "watch check done").with_started(check_start);
    ev.field("notified", watch.notified)
        .field("deferred", watch.deferred())
        .dev("deferred_err", watch.deferred_err)
        .dev("deferred_baseline", watch.deferred_baseline)
        .dev("deferred_throttle", watch.deferred_throttle);
    ev.info();

    Ok(state.db()?.get_pending_watch_notifications()?)
}

/// 读取本地缓存的待更新列表（纯 DB 只读，校验当前已安装版本与冻结/跳过规则）。
#[tauri::command]
pub fn get_cached_updates(state: State<'_, AppState>) -> crate::AppResult<Vec<UpdateItem>> {
    let (installed, rules, rows) = {
        let db = state.db()?;
        let installed = db.get_installed_apps()?;
        // 规则读取 fail-closed（与 `check_for_updates` 同口径）。
        let rules = db.get_all_rules()?;
        let rows = db.get_cached_updates().unwrap_or_default();
        (installed, rules, rows)
    };
    let installed_map: HashMap<String, String> = installed
        .into_iter()
        .map(|a| (a.app_id, a.version))
        .collect();
    let rules_map: HashMap<String, UpdateRule> =
        rules.into_iter().map(|r| (r.app_id.clone(), r)).collect();
    let mut out: Vec<UpdateItem> = Vec::with_capacity(rows.len());
    for mut item in rows {
        // 已卸载/幽灵不行。
        let Some(current) = installed_map.get(&item.app_id) else {
            continue;
        };
        // 安装版本变更即过期（安装/导入失效缺口的读侧兜底）。
        if current.trim() != item.current_version.trim() {
            continue;
        }
        let rule_opt = rules_map.get(&item.app_id);
        if !should_include_update(current, &item.latest_version, rule_opt) {
            continue;
        }
        // 当前版本以安装表为准（快照可能滞后一个版本写窗口）。
        item.current_version = current.clone();
        out.push(item);
    }
    Ok(out)
}

#[derive(Default)]
struct WatchCheckSummary {
    notified: usize,
    deferred_err: usize,
    deferred_baseline: usize,
    deferred_throttle: usize,
}

impl WatchCheckSummary {
    fn deferred(&self) -> usize {
        self.deferred_err + self.deferred_baseline + self.deferred_throttle
    }
}

/// 从未提醒过的关注应用面对其最新版本时的处置。
#[derive(Debug, PartialEq, Eq)]
enum FirstSeenAction {
    /// 最新 Release 发布不足 7 天：提醒一次。
    Notify,
    /// 发布已久：静默记为基线，只提醒之后的新版本。
    Baseline,
    /// 发布时间未知且本轮未联网：暂不建立基线，留待手动检查拿到发布时间再判定。
    Defer,
}

fn decide_first_seen(published_at: Option<i64>, now: i64, is_force: bool) -> FirstSeenAction {
    match published_at {
        Some(t) if now.saturating_sub(t) < WATCH_RECENT_RELEASE_SECONDS => FirstSeenAction::Notify,
        Some(_) => FirstSeenAction::Baseline,
        None if is_force => FirstSeenAction::Baseline,
        None => FirstSeenAction::Defer,
    }
}

/// 遍历关注应用并按通知频率推送新版本提醒；首次关注的近期发布（7 天内）提醒一次，否则记为基线。
async fn notify_watched_updates(
    state: &AppState,
    rules_map: &HashMap<String, UpdateRule>,
    force_refresh: Option<bool>,
) -> WatchCheckSummary {
    // 关注列表与提醒频率单次短锁合并读取。
    let (watched, frequency): (Vec<WatchedApp>, String) = match state.db() {
        Ok(db) => (
            db.get_watched_apps().unwrap_or_default(),
            db.get_watch_notify_frequency(),
        ),
        Err(_) => return WatchCheckSummary::default(),
    };
    if watched.is_empty() {
        return WatchCheckSummary::default();
    }
    let now = crate::now_secs();
    let is_daily = frequency.as_str() == "daily";
    let is_force = force_refresh.unwrap_or(false);
    let notified = Arc::new(AtomicUsize::new(0));
    let deferred_err = Arc::new(AtomicUsize::new(0));
    let deferred_baseline = Arc::new(AtomicUsize::new(0));
    let deferred_throttle = Arc::new(AtomicUsize::new(0));

    stream::iter(watched)
        .map(|w| {
            let skip_by_rule = matches!(
                rules_map.get(&w.app_id),
                Some(rule) if rule.is_frozen || rule.is_hidden
            );
            let notified = Arc::clone(&notified);
            let deferred_err = Arc::clone(&deferred_err);
            let deferred_baseline = Arc::clone(&deferred_baseline);
            let deferred_throttle = Arc::clone(&deferred_throttle);
            async move {
                if skip_by_rule {
                    return;
                }
                let rel = match latest_release(state, &w.app_id, force_refresh).await {
                    Ok(res) => res,
                    Err(_) => {
                        deferred_err.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                };
                let latest = rel.tag.trim().to_string();
                if latest.is_empty() {
                    return;
                }
                // 上次提醒时间单次读取，供「从未提醒」判定与 daily 节流共用；
                // 读取失败保守跳过本轮（不当作从未提醒、也不绕过节流）。
                let last_notified_at = match state.db().and_then(|db| {
                    db.get_watch_last_notified_at(&w.app_id)
                        .map_err(|e| e.to_string())
                }) {
                    Ok(t) => t,
                    Err(_) => {
                        deferred_err.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                };
                // 从未提醒过：新关注（无基线），或基线即当前最新版本且从未发出过提醒
                let never_notified_at_latest = match w.last_notified_version.as_deref() {
                    None => true,
                    Some(base) if base.trim() == latest => last_notified_at.is_none(),
                    Some(_) => false,
                };
                if never_notified_at_latest {
                    // 仅尚无基线的新关注计入 deferred_baseline；已有静默基线的应用本轮无事可做，不计数
                    let is_new_watch = w.last_notified_version.is_none();
                    let published_at = rel.published_at.or_else(|| {
                        detail_service::cached_release_published_at(state, &w.app_id, &latest)
                    });
                    match decide_first_seen(published_at, now, is_force) {
                        FirstSeenAction::Notify => {}
                        FirstSeenAction::Baseline => {
                            if is_new_watch {
                                if let Ok(db) = state.db() {
                                    let _ = db.init_watch_baseline(&w.app_id, &latest);
                                }
                                deferred_baseline.fetch_add(1, Ordering::Relaxed);
                            }
                            return;
                        }
                        FirstSeenAction::Defer => {
                            if is_new_watch {
                                deferred_baseline.fetch_add(1, Ordering::Relaxed);
                            }
                            return;
                        }
                    }
                } else {
                    let base = w.last_notified_version.clone().unwrap_or_default();
                    if !is_version_newer(&base, &latest) {
                        return;
                    }
                }
                if is_daily {
                    if let Some(t) = last_notified_at {
                        if now.saturating_sub(t) < DAILY_NOTIFY_INTERVAL_SECONDS {
                            deferred_throttle.fetch_add(1, Ordering::Relaxed);
                            return;
                        }
                    }
                }
                if let Ok(db) = state.db() {
                    let _ = db.set_watch_notified(&w.app_id, &latest, now);
                }
                notified.fetch_add(1, Ordering::Relaxed);
                if let Some(tx) = crate::GLOBAL_WATCH_TX.get() {
                    let _ = tx.send(WatchUpdatedPayload {
                        app_id: w.app_id.clone(),
                        version: latest,
                    });
                }
            }
        })
        .buffer_unordered(6)
        .for_each(|_| async {})
        .await;

    WatchCheckSummary {
        notified: notified.load(Ordering::Relaxed),
        deferred_err: deferred_err.load(Ordering::Relaxed),
        deferred_baseline: deferred_baseline.load(Ordering::Relaxed),
        deferred_throttle: deferred_throttle.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod watch_first_seen_tests {
    use super::{decide_first_seen, FirstSeenAction, WATCH_RECENT_RELEASE_SECONDS};

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn recent_release_notifies_old_release_baselines() {
        let six_hours_ago = NOW - 6 * 3600;
        assert_eq!(
            decide_first_seen(Some(six_hours_ago), NOW, false),
            FirstSeenAction::Notify
        );
        assert_eq!(
            decide_first_seen(Some(six_hours_ago), NOW, true),
            FirstSeenAction::Notify
        );
        let just_over = NOW - WATCH_RECENT_RELEASE_SECONDS;
        assert_eq!(
            decide_first_seen(Some(just_over), NOW, true),
            FirstSeenAction::Baseline
        );
        assert_eq!(
            decide_first_seen(Some(NOW - 30 * 86400), NOW, false),
            FirstSeenAction::Baseline
        );
    }

    #[test]
    fn unknown_publish_time_defers_offline_and_baselines_online() {
        assert_eq!(decide_first_seen(None, NOW, false), FirstSeenAction::Defer);
        assert_eq!(
            decide_first_seen(None, NOW, true),
            FirstSeenAction::Baseline
        );
    }
}
