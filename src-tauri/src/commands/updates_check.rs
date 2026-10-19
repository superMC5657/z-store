use crate::models::{UpdateItem, UpdateRule, WatchUpdatedPayload, WatchedApp};
use crate::AppState;
use futures_util::stream::{self, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// FR-6.2：按天限频关注通知的最小间隔时间（秒，24 小时）
pub const DAILY_NOTIFY_INTERVAL_SECONDS: i64 = 24 * 60 * 60;

/// 轻量级获取应用最新版本号与更新说明（专为更新检查与关注动态设计）
/// 坚决不拉取 README.md、不拉取仓库详情与 Stars、不拉取校验和文件
/// - 默认 DB-only（`force_refresh != Some(true)`）：仅读 `get_cached_app_detail(None)` /
///   收录库默认版本，零网络（启动/登录不触网）；
/// - 显式手动刷新（`Some(true)`）才走 ETag 轻量探查（无新版本时 304 零配额返回）；
/// 离线/限流时仍降级返回本地已有缓存。
pub(crate) async fn fetch_app_latest_version_lightweight(
    state: &AppState,
    app_id: &str,
    force_refresh: Option<bool>,
) -> Result<(String, String), String> {
    let is_force = force_refresh.unwrap_or(false);
    let clean_id = crate::commands::require_app_id(app_id)?;

    // 启动/登录默认 DB-only：非显式手动刷新一律不触网（ETag 探针门控在 force 臂内）。
    // 口径：更新判定行（update_results 上次刷新快照）优先，其次详情缓存行（忽略 TTL），
    // 再次收录库默认版本；均无则报离线无缓存。
    if !is_force {
        if let Ok(db) = state.db() {
            if let Ok(Some((latest, changelog))) = db.get_cached_update_version(&clean_id) {
                return Ok((latest, changelog));
            }
            if let Ok(Some(cached)) = db.get_cached_app_detail(&clean_id, None) {
                return Ok((cached.latest_version, cached.changelog));
            }
        }
        if let Some(item) = state.catalog.get_catalog_item(&clean_id) {
            return Ok((item.default_version, String::new()));
        }
        return Err("检查更新网络不可达且无本地缓存".to_string());
    }

    // 显式手动刷新（force==true）：直探 ETag，不读详情 Cache TTL（更新发现不受浏览 TTL 拖累）。
    // 失败时再降级读本地缓存（见下方 shallow adapter 回退）。

    // 2. 多源支持 (Codeberg, Gitea 等)
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            let host_token = if let Ok(db) = state.db() {
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
            if let Ok(db) = state.db() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail(&clean_id, None) {
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

    // 手动刷新直探：不带 ETag 条件头，强制取远端最新（304 延保仅非 force 臂，此处不可达）。
    let (cached_etag, cached_payload): (Option<String>, Option<String>) = (None, None);

    let token = crate::commands::resolve_active_github_token(state);
    let base_headers = crate::github::http::token_headers(token.as_deref());

    let outcome = crate::github::http::get_with_etag(
        &state.http,
        &ep,
        None,
        &base_headers,
        cached_etag.as_deref(),
        "updates",
    )
    .await;

    if matches!(
        outcome,
        crate::github::http::EtagGetOutcome::Unauthorized
    ) {
        crate::check_auth_expired(401, &format!("op=check_updates app={}", clean_id));
    }

    // 收敛：轻量决议经 `github::release_fetch` shallow adapter（与 `get_platforms_lite`
    // 同一 interface）。
    // ADR-0007 豁免对照分支（consult_ttl = false 侧）：此处故意不读详情 Cache TTL
    // （缓存生存时效），每次直探 ETag；TTL 快径仅 `get_platforms_lite` 有。语义见模块注释。
    // 失败路径不做 ETag payload 恢复：仅 304 时传入 payload。
    // Fresh 无需回退源，避免无谓 DB 读。
    let decide_payload = match &outcome {
        crate::github::http::EtagGetOutcome::NotModified => cached_payload.as_deref(),
        _ => None,
    };
    let (stale_row, catalog_default) = match &outcome {
        crate::github::http::EtagGetOutcome::Fresh { .. } => (None, None),
        _ => {
            let row = state
                .db()
                .ok()
                .and_then(|db| db.get_cached_app_detail(&clean_id, None).ok().flatten());
            let cat = state
                .catalog
                .get_catalog_item(&clean_id)
                .map(|c| c.default_version);
            (row, cat)
        }
    };
    let mut resolution = crate::github::release_fetch::decide_shallow_release(
        &outcome,
        decide_payload,
        stale_row.as_ref(),
        catalog_default.as_deref(),
    );
    // 现行 tolerant 语义：304 payload 腐坏时跳过 payload 继续沿行/收录库回退
    //（`get_platforms_lite`-304 对同错报硬错，见模块注释）。
    if matches!(
        resolution,
        Err(crate::github::release_fetch::ShallowError::PayloadCorrupt(_))
    ) {
        resolution = crate::github::release_fetch::decide_shallow_release(
            &outcome,
            None,
            stale_row.as_ref(),
            catalog_default.as_deref(),
        );
    }
    match resolution {
        Ok(rel) => {
            // 304 一律 touch 延保（decide 置位）；Fresh/穿透不 touch。
            if rel.touch {
                if let Ok(db) = state.db() {
                    let _ = db.touch_cached_app_detail(&clean_id, crate::now_secs());
                }
            }
            if let Some((etag_val, payload_text)) = rel.cache_to_save {
                if let Ok(db) = state.db() {
                    let _ = db.save_etag(&ep, &etag_val, &payload_text, crate::now_secs());
                }
            }
            Ok((rel.tag, rel.body))
        }
        Err(crate::github::release_fetch::ShallowError::Parse(e)) => Err(e),
        // 防御：tolerant 重试已去 payload，理论不可达；文案与 304 缺缓存一致。
        Err(crate::github::release_fetch::ShallowError::PayloadCorrupt(_)) => {
            Err("304 响应但未能提取到有效版本信息".to_string())
        }
        Err(crate::github::release_fetch::ShallowError::Miss(miss)) => match miss {
            crate::github::release_fetch::ShallowMiss::NotModifiedWithoutCache => {
                Err("304 响应但未能提取到有效版本信息".to_string())
            }
            crate::github::release_fetch::ShallowMiss::OfflineWithoutCache => {
                Err("检查更新网络不可达且无本地缓存".to_string())
            }
        },
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
pub(crate) fn is_version_newer(current: &str, latest: &str) -> bool {
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
pub(crate) fn should_include_update(
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

#[tauri::command(rename_all = "camelCase")]
pub async fn check_for_updates(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> crate::AppResult<Vec<UpdateItem>> {
    // 整轮耗时 + sid 关联，结束只记一行汇总。
    // 持久化语义：仅显式手动刷新（force==true）写 `update_results`；
    // 默认 DB-only 臂不写库（读经 `fetch_app_latest_version_lightweight` 判定行快径）。
    let is_force = force_refresh.unwrap_or(false);
    let check_start = std::time::Instant::now();
    let installed = crate::commands::installer::get_installed_apps(state.clone())?;
    let installed_ids: Vec<String> = installed.iter().map(|a| a.app_id.clone()).collect();
    let rules_map: HashMap<String, UpdateRule> = {
        let db = state.db()?;
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

    // 并发度 6，兼顾检查速度与 GitHub API 稳定性。
    // 关键体验优化：只要某款应用检测出有新版本，立即通过事件单项推流，实现“检测出一项跳出一项”的流畅反馈。
    // emit 顺序语义：zstore://update-item-found/progress 为无序发射，前端按 app_id 去重/累计，不依赖顺序；
    // zstore://update-check-finished 在 collect 完成后统一发射，保持终态语义。
    // 持久化行与推流项同源：Ok 即产行（has_update 经 `should_include_update` 判定），Err 不产行（保留旧行）。
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

                match fetch_app_latest_version_lightweight(state_ref, &app.app_id, force_refresh)
                    .await
                {
                    Ok((latest_version, changelog)) => {
                        let has_update = should_include_update(
                            &app.version,
                            &latest_version,
                            rule_opt.as_ref(),
                        );
                        let (icon, icon_bg) = if let Some(item) =
                            state_ref.catalog.get_catalog_item(&app.app_id)
                        {
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

    // 手动刷新落库：同轮判定行批量 upsert + 已卸载剪枝；失败 `let _ =` 吞错下次重试。
    // 非 force 臂零写（启动/登录只读，保持 DB 快照语义）。
    if is_force {
        if let Ok(db) = state.db() {
            let _ = db.save_update_checks_batch(&write_rows);
            let _ = db.prune_update_results_not_in(&installed_ids);
        }
    }

    // 一轮一行：更新检查轮结束 info（new/failures 计数 + 耗时 + sid）。
    log::info!(
        "update batch check done sid={} total={} updates={} failures={} elapsed_ms={} persisted={}",
        crate::z_log::new_session_id(),
        total,
        updates.len(),
        failed_count.load(Ordering::SeqCst),
        check_start.elapsed().as_millis(),
        if is_force { write_rows.len() } else { 0 },
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

/// 更新中心列表读（DB-only，无网络）：登录/UpdatesView 首屏直读快照。
/// - 仅 `has_update=1` 行；逐行与当前已安装版本比对（`installed_version` 不一致视为过期跳过，
///   覆盖安装/导入未及时失效的缺口）；
/// - 规则过滤与 `check_for_updates` 同口径（frozen/hidden 跳过，skip 版本跳过，
///   `should_include_update` 重校验）；
/// - 幽灵隐藏语义沿用 `get_installed_apps`（未安装/幽灵不行，`stale_passthrough` 不动）。
#[tauri::command]
pub fn get_cached_updates(state: State<'_, AppState>) -> crate::AppResult<Vec<UpdateItem>> {
    let start = std::time::Instant::now();
    let installed = crate::commands::installer::get_installed_apps(state.clone())?;
    let installed_map: HashMap<String, String> = installed
        .into_iter()
        .map(|a| (a.app_id.clone(), a.version.clone()))
        .collect();
    let rules_map: HashMap<String, UpdateRule> = state
        .db()
        .map(|db| {
            db.get_all_rules()
                .unwrap_or_default()
                .into_iter()
                .map(|r| (r.app_id.clone(), r))
                .collect()
        })
        .unwrap_or_default();
    let rows = state
        .db()
        .map(|db| db.get_cached_updates().unwrap_or_default())
        .unwrap_or_default();
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
        if let Some(r) = rule_opt {
            if r.is_frozen || r.is_hidden {
                continue;
            }
        }
        if !should_include_update(current, &item.latest_version, rule_opt) {
            continue;
        }
        // 当前版本以安装表为准（快照可能滞后一个版本写窗口）。
        item.current_version = current.clone();
        out.push(item);
    }
    log::debug!(
        "cached updates done rows={} hits={} elapsed_ms={}",
        installed_map.len(),
        out.len(),
        start.elapsed().as_millis()
    );
    Ok(out)
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
    let watched: Vec<WatchedApp> = match state.db() {
        Ok(db) => db.get_watched_apps().unwrap_or_default(),
        Err(_) => return,
    };
    if watched.is_empty() {
        return;
    }
    let frequency = match state.db() {
        Ok(db) => db.get_watch_notify_frequency(),
        Err(_) => crate::db::WATCH_NOTIFY_FREQUENCY_DEFAULT.to_string(),
    };
    let now = crate::now_secs();

    // 关注通知路径用 buffer_unordered(6) 并发，
    // 每项经 GLOBAL_WATCH_TX 无序发送，前端按 app_id 去重，不依赖顺序；
    // frozen/hidden 过滤、baseline 静默、daily 24h 节流语义照常。
    // frequency 按引用复用（is_daily 预计算，Copy 无每项 String clone）；
    // 终端用 for_each 替代 collect，零 Vec 分配。
    let is_daily = frequency.as_str() == "daily";
    stream::iter(watched)
        .map(|w| {
            let skip_by_rule = matches!(
                rules_map.get(&w.app_id),
                Some(rule) if rule.is_frozen || rule.is_hidden
            );
            async move {
                if skip_by_rule {
                    return;
                }
                let (latest, _) = match fetch_app_latest_version_lightweight(
                    state,
                    &w.app_id,
                    force_refresh,
                )
                .await
                {
                    Ok(res) => res,
                    Err(e) => {
                        log::debug!(
                            "watch deferred id={} reason={}",
                            w.app_id,
                            crate::log_support::short_reason(&e)
                        );
                        return;
                    }
                };
                let latest = latest.trim().to_string();
                if latest.is_empty() {
                    return;
                }
                let Some(base) = w.last_notified_version.clone() else {
                    // 首次关注：静默建立基线
                    if let Ok(db) = state.db() {
                        let _ = db.init_watch_baseline(&w.app_id, &latest);
                    }
                    log::debug!("watch deferred id={} reason=baseline-init", w.app_id);
                    return;
                };
                if !is_version_newer(&base, &latest) {
                    return;
                }
                if is_daily {
                    let last_at = state
                        .db
                        .lock()
                        .ok()
                        .and_then(|db| db.get_watch_last_notified_at(&w.app_id).ok().flatten());
                    if let Some(t) = last_at {
                        if now.saturating_sub(t) < DAILY_NOTIFY_INTERVAL_SECONDS {
                            log::debug!("watch deferred id={} reason=daily-throttle", w.app_id);
                            return;
                        }
                    }
                }
                if let Ok(db) = state.db() {
                    let _ = db.set_watch_notified(&w.app_id, &latest, now);
                }
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
}
