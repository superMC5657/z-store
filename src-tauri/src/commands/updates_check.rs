use crate::models::{UpdateItem, UpdateRule, WatchUpdatedPayload, WatchedApp};
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

/// 轻量级获取应用最新版本号与更新说明（专为更新检查与关注动态设计）
/// 坚决不拉取 README.md、不拉取仓库详情与 Stars、不拉取校验和文件
/// - 默认 DB-only（`force_refresh != Some(true)`）：仅读 `get_cached_app_detail(None)` /
///   收录库默认版本，零网络（启动/登录不触网）；
/// - 显式手动刷新（`Some(true)`）：跳过详情 Cache TTL 短路，携带本地 `api_etag_cache` 中的
///   ETag 发送 `If-None-Match` 条件请求；命中 `304 Not Modified` 时零配额消耗从 `cached_payload`
///   恢复最新版本，离线/限流时降级返回本地已有缓存。
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
            if let Ok(Some(cached)) = db.get_app_detail(&clean_id, None) {
                return Ok((cached.core.latest_version, cached.changelog));
            }
        }
        if let Some(item) = state.catalog.get_catalog_item(&clean_id) {
            return Ok((item.default_version, String::new()));
        }
        return Err("检查更新网络不可达且无本地缓存".to_string());
    }

    // 显式手动刷新（force==true）：跳过详情 Cache TTL 短路，向 `releases/latest` 发起带 ETag 的条件请求。
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
                if let Ok(Some(fallback)) = db.get_app_detail(&clean_id, None) {
                    return Ok((fallback.core.latest_version, fallback.changelog));
                }
            }
            return Err(format!("未识别的应用坐标: {}", app_id));
        }
    };

    let ep = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        coords.owner, coords.repo
    );

    // 手动刷新条件重验：跳过详情 Cache TTL 短路，但携带本地 ETag 发送 If-None-Match，
    // 远端 304 Not Modified 时零配额消耗从 cached_payload 恢复最新版本。
    let (cached_etag, cached_payload) = if let Ok(db) = state.db() {
        (
            db.get_etag(&ep)
                .ok()
                .flatten()
                .filter(|s| !s.trim().is_empty()),
            db.get_cached_payload(&ep).ok().flatten(),
        )
    } else {
        (None, None)
    };
    let token = crate::commands::resolve_active_github_token(state);
    let base_headers = crate::github::http::token_headers(token.as_deref());

    let outcome = crate::github::http::get_with_etag(
        &crate::shared_http_client(),
        &ep,
        None,
        &base_headers,
        cached_etag.as_deref(),
    )
    .await;

    if matches!(outcome, crate::github::http::EtagGetOutcome::Unauthorized) {
        crate::check_auth_expired(401, &format!("op=check_updates app={}", clean_id));
    }

    // 收敛：轻量决议经 `github::release_fetch` shallow adapter（与 `get_platforms_lite`
    // 同一 interface）。
    // ADR-0007 豁免对照分支（consult_ttl = false 侧）：此处故意不读详情 Cache TTL
    // （缓存生存时效），每次向远端发起条件请求；TTL 快径仅 `get_platforms_lite` 有。
    // Fresh 无需回退源，避免无谓 DB 读。
    let (stale_row, catalog_default) = match &outcome {
        crate::github::http::EtagGetOutcome::Fresh { .. } => (None, None),
        _ => {
            let row = state
                .db()
                .ok()
                .and_then(|db| db.get_app_detail(&clean_id, None).ok().flatten());
            let cat = state
                .catalog
                .get_catalog_item(&clean_id)
                .map(|c| c.default_version);
            (row, cat)
        }
    };
    let mut resolution = resolve_update_shallow_with_fallback(
        &outcome,
        cached_payload.as_deref(),
        stale_row.as_ref(),
        catalog_default.as_deref(),
    );
    // 若 304 但本地 payload 损坏/缺失且无 stale_row / catalog_default 可兜底，
    // 剥除坏 ETag 发起一次无条件请求自愈。
    if matches!(
        resolution,
        Err(crate::github::release_fetch::ShallowError::PayloadCorrupt(
            _
        )) | Err(crate::github::release_fetch::ShallowError::Miss(
            crate::github::release_fetch::ShallowMiss::NotModifiedWithoutCache
        ))
    ) {
        let retry_outcome = crate::github::http::get_with_etag(
            &crate::shared_http_client(),
            &ep,
            None,
            &base_headers,
            None,
        )
        .await;
        if matches!(
            retry_outcome,
            crate::github::http::EtagGetOutcome::Unauthorized
        ) {
            crate::check_auth_expired(401, &format!("op=check_updates app={}", clean_id));
        }
        resolution = crate::github::release_fetch::decide_shallow_release(
            &retry_outcome,
            None,
            stale_row.as_ref(),
            catalog_default.as_deref(),
        );
    }
    match resolution {
        Ok(rel) => {
            // 304 命中时 touch 延长详情缓存保鲜期；Fresh 保存新 ETag。
            if rel.touch {
                if let Ok(db) = state.db() {
                    let _ = db.touch_app_detail(&clean_id, crate::now_secs());
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
        Err(crate::github::release_fetch::ShallowError::PayloadCorrupt(_))
        | Err(crate::github::release_fetch::ShallowError::Miss(
            crate::github::release_fetch::ShallowMiss::NotModifiedWithoutCache,
        )) => Err("304 响应但未能提取到有效版本信息".to_string()),
        Err(crate::github::release_fetch::ShallowError::Miss(
            crate::github::release_fetch::ShallowMiss::OfflineWithoutCache,
        )) => Err("检查更新网络不可达且无本地缓存".to_string()),
    }
}

/// 更新检查 shallow 决议包装：304 命中优先解析 `cached_payload`，若缓存 JSON 损坏则自动退回
/// `stale_row` / `catalog_default_version` 兜底。
pub(crate) fn resolve_update_shallow_with_fallback(
    outcome: &crate::github::http::EtagGetOutcome,
    cached_payload: Option<&str>,
    stale_row: Option<&crate::models::AppDetail>,
    catalog_default_version: Option<&str>,
) -> Result<crate::github::release_fetch::ShallowRelease, crate::github::release_fetch::ShallowError>
{
    match crate::github::release_fetch::decide_shallow_release(
        outcome,
        cached_payload,
        stale_row,
        catalog_default_version,
    ) {
        Err(crate::github::release_fetch::ShallowError::PayloadCorrupt(_)) => {
            crate::github::release_fetch::decide_shallow_release(
                outcome,
                None,
                stale_row,
                catalog_default_version,
            )
        }
        other => other,
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
    /// 归一化：去 `v` 前缀与空白；4 段式纯数字 MSI 且末段为 0 时截断为 3 段；
    /// 无后缀的 2 段纯数字（`0.16`、`10.38`）补成 3 段，以便与 PE 版本资源的 `0.15.0` 比较。
    fn normalize(s: &str) -> String {
        let clean = s.trim_start_matches('v').trim();
        let parts: Vec<&str> = clean.split('.').collect();
        if parts.len() == 2
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.bytes().all(|b| b.is_ascii_digit())
                    && (p.len() == 1 || !p.starts_with('0'))
            })
        {
            return format!("{}.{}.0", parts[0], parts[1]);
        }
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

/// 判定是否应当提示此更新，综合考量版本策略表（锁定、跳过指定版本）。
/// 隐藏不在此排除：隐藏应用的更新仍进入列表，供「已隐藏」签与规则管理跳过版本；
/// 前端各更新计数与「有更新」签自行排除隐藏应用。
pub(crate) fn should_include_update(
    current_version: &str,
    latest_version: &str,
    rule: Option<&UpdateRule>,
) -> bool {
    if let Some(r) = rule {
        if r.is_frozen {
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
    let installed = super::installer_query::load_installed_apps(&state).await?;
    let installed_ids: Vec<String> = installed.iter().map(|a| a.app_id.clone()).collect();
    // 规则读取失败必须中止：退化为空集会让已冻结/已跳过版本的应用误报更新。
    let rules_map: HashMap<String, UpdateRule> = {
        let db = state.db()?;
        db.get_all_rules()?
            .into_iter()
            .map(|r| (r.app_id.clone(), r))
            .collect()
    };

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
                            // 🚀 核心：发现更新立即触发单项流式推送，前端实现逐项弹入跳出动效
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

    // 手动刷新落库：同轮判定行批量 upsert + 已卸载剪枝；失败 `let _ =` 吞错下次重试。
    // 非 force 臂零写（启动/登录只读，保持 DB 快照语义）。
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

    // 关注订阅检查（最佳努力，汇总结果折叠进本轮宽事件）
    let watch = notify_watched_updates(&state, &rules_map, force_refresh).await;

    let mut ev = crate::z_log::WideEvent::new("updater", "check done").with_started(check_start);
    ev.field("total", total)
        .field("updates", updates.len())
        .field("failures", failed_count.load(Ordering::SeqCst))
        .dev("persisted", if is_force { write_rows.len() } else { 0 })
        .dev("watch_notified", watch.notified)
        .dev("watch_deferred", watch.deferred());
    ev.info();

    Ok(updates)
}

/// 更新中心列表读（DB-only，无网络）：登录/UpdatesView 首屏直读快照。
/// - 仅 `has_update=1` 行；逐行与当前已安装版本比对（`installed_version` 不一致视为过期跳过，
///   覆盖安装/导入未及时失效的缺口）；
/// - 规则过滤与 `check_for_updates` 同口径（frozen 跳过、skip 版本跳过，经
///   `should_include_update` 重校验；hidden 不跳过，由前端各计数自行排除）；
/// - 纯 DB 只读：已安装版本取 `installed_apps` 库内行，不触发注册表重扫与路径修复
///   （路径自愈、导入版本更正与幽灵隐藏由 `get_installed_apps` 负责，更正版本时同步重算判定行）；
/// - 已安装列表、规则与判定行在同一次 `db` 临界区内读取。
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

/// 从 `releases/latest` 响应体取发布时间（Unix 秒）；tag 与 `version` 不符时视为未知，
/// 避免拿旧载荷的时间去判定新版本。
fn release_published_at_from_payload(payload: &str, version: &str) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    if v.get("tag_name")?.as_str()?.trim() != version.trim() {
        return None;
    }
    let raw = v.get("published_at")?.as_str()?;
    time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|t| t.unix_timestamp())
}

/// 最新 Release 的发布时间，读手动检查时落库的 GitHub `releases/latest` ETag 载荷；
/// 无载荷或非 GitHub 来源时为 None。
fn cached_release_published_at(state: &AppState, app_id: &str, version: &str) -> Option<i64> {
    let coords = state.catalog.get_repo_coordinates(app_id).ok()?;
    let ep = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        coords.owner, coords.repo
    );
    let payload = state.db().ok()?.get_cached_payload(&ep).ok().flatten()?;
    release_published_at_from_payload(&payload, version)
}

/// 遍历被关注应用，若出现较 `last_notified_version` 更新的
/// Release，按 `watch_notify_frequency`（`startup`|`daily`）决定是否经由
/// `zstore://watch-updated` 事件应用内通知。
/// 从未提醒过的应用（新关注或仅有静默基线）若最新 Release 发布不足 7 天，也提醒一次。
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
                let (latest, _) =
                    match fetch_app_latest_version_lightweight(state, &w.app_id, force_refresh)
                        .await
                    {
                        Ok(res) => res,
                        Err(_) => {
                            deferred_err.fetch_add(1, Ordering::Relaxed);
                            return;
                        }
                    };
                let latest = latest.trim().to_string();
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
                    let published_at = cached_release_published_at(state, &w.app_id, &latest);
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
    use super::{
        decide_first_seen, release_published_at_from_payload, FirstSeenAction,
        WATCH_RECENT_RELEASE_SECONDS,
    };

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

    #[test]
    fn publish_time_parsed_only_for_matching_tag() {
        let payload = r#"{"tag_name":"v0.101.0","published_at":"2026-11-13T00:00:00Z"}"#;
        assert_eq!(
            release_published_at_from_payload(payload, "v0.101.0"),
            Some(1_794_528_000)
        );
        assert_eq!(release_published_at_from_payload(payload, "v0.102.0"), None);
        assert_eq!(
            release_published_at_from_payload(r#"{"tag_name":"v1","published_at":null}"#, "v1"),
            None
        );
        assert_eq!(release_published_at_from_payload("not json", "v1"), None);
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_update_shallow_with_fallback;
    use crate::github::http::EtagGetOutcome;
    use crate::github::release_fetch::{ShallowError, ShallowMiss, ShallowSource};

    #[test]
    fn update_check_304_restores_payload_and_falls_back_on_corrupt_cache() {
        let valid_payload = r#"{"tag_name":"v2.4.0","body":"release notes","assets":[]}"#;
        let rel = resolve_update_shallow_with_fallback(
            &EtagGetOutcome::NotModified,
            Some(valid_payload),
            None,
            Some("v1.0.0"),
        )
        .expect("304 with valid cached payload should succeed");
        assert_eq!(rel.source, ShallowSource::Payload);
        assert_eq!(rel.tag, "v2.4.0");
        assert_eq!(rel.body, "release notes");
        assert!(rel.touch);

        // 损坏的 cached_payload 自动降级至 catalog_default_version
        let fallback = resolve_update_shallow_with_fallback(
            &EtagGetOutcome::NotModified,
            Some("{corrupt-json"),
            None,
            Some("v1.8.0"),
        )
        .expect("304 with corrupt payload should fall back to catalog default");
        assert_eq!(fallback.source, ShallowSource::Catalog);
        assert_eq!(fallback.tag, "v1.8.0");

        // 损坏的 cached_payload 且无 stale_row / catalog_default 时返回 NotModifiedWithoutCache 供上层自愈重试
        let err = resolve_update_shallow_with_fallback(
            &EtagGetOutcome::NotModified,
            Some("{corrupt-json"),
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(
            err,
            ShallowError::Miss(ShallowMiss::NotModifiedWithoutCache)
        );
    }
}
