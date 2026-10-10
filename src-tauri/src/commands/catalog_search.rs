use crate::models::AppSummary;
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};

static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

/// 趋势流式世代：`enrich_trend_repos` 每次流式调用 +1（切榜/重拉/分片重拉均+1，
/// 类比 `SEARCH_GEN` 每次 `search_apps_online` +1）。
/// 后台 `fetch_icons_stream(Trend{board,gen})` 的落库前 + emit 前双检查用，
/// 用户切榜后旧榜在途探测结果直接抛弃（与搜索防串词同语义）。
static BOARD_GEN: AtomicU64 = AtomicU64::new(0);

/// 在线搜索回包：行 + 后端拍板的 search_id 回声。
/// 前端以此 sid 为准做图标门控（以后端为准，后端说什么前端认什么）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct OnlineSearchResult {
    pub rows: Vec<AppSummary>,
    pub sid: String,
}

/// ADR-0008：网络超时统一经 `get_project_config().network.api_timeout_seconds` 获取；
/// 配置为 0（未设置）时回退到调用方传入的历史硬编码值，行为保持不变。
pub(crate) fn api_timeout_or(fallback: std::time::Duration) -> std::time::Duration {
    let secs = crate::config::get_project_config()
        .network
        .api_timeout_seconds;
    if secs > 0 {
        std::time::Duration::from_secs(secs)
    } else {
        fallback
    }
}

/// 快/慢图标探测结果落库 + 前端 emit（`upsert_icon_cycle` + 单发新事件）。
/// level纯L：`level=2`写 `l2_url`，`level=3`写 `l3_url`；via=live|m2，远端探测走live，DB落盘回填走m2。
/// - 只发统一 `zstore://icon-ready{key,id,icon,level,via,context}`；
/// - 世代比对防串词：落库前 + emit 前双检查 `SEARCH_GEN == expected_gen`。
/// - 单条显式事务边界（单语句隐式事务显式化，仍 1 提交，emit 不延迟）；
///   失败 `ROLLBACK` 返回 Err，内部吞错下次补探重试。
#[allow(clippy::too_many_arguments)]
async fn save_and_emit(
    handle: &AppHandle,
    id: &str,
    owner: &str,
    repo: &str,
    sid: &str,
    url: &str,
    level: i32,
    via: &str,
    expected_gen: u64,
) {
    if SEARCH_GEN.load(Ordering::SeqCst) != expected_gen {
        return;
    }
    let state = handle.state::<AppState>();
    if let Ok(db) = state.db() {
        let mut cycle = crate::db::AppIconCycle::new(id, owner, repo);
        cycle.is_cataloged = false;
        cycle.level = level;
        if level == 2 {
            cycle.l2_url = url.to_owned();
        } else if level == 3 {
            cycle.l3_url = url.to_owned();
        }
        cycle.selected_url = url.to_owned();
        cycle.updated_at = crate::now_secs();
        let _ = db.with_immediate_transaction(|| {
            db.upsert_icon_cycle(&cycle)?;
            Ok(())
        });
    }
    if SEARCH_GEN.load(Ordering::SeqCst) != expected_gen {
        return;
    }
    // 单发：新统一事件（载荷 schema 归 core 所有，见 `github::icon_fetch`）。
    let ready = crate::github::icon_fetch::IconReadyPayload {
        key: crate::github::icon_fetch::icon_key(owner, repo),
        id: id.to_owned(),
        icon: url.to_owned(),
        level,
        via: via.to_owned(),
        context: crate::github::icon_fetch::IconFetchCtx::Search {
            search_id: sid.to_owned(),
            gen: expected_gen,
        },
    };
    crate::github::icon_fetch::emit_icon_ready(handle, &ready);
}

/// 趋势图标命中落库 + 前端 emit（流式，类比 `save_and_emit` 搜索链）：
/// - 只发统一 `zstore://icon-ready{key,id,icon,level,via,context=Trend{board,gen}}`；
/// - level纯L：`level=2` 快路径 SimpleIcons 写 `l2_url`；`level=3` 慢路径 Trees 写 `l3_url`；
///   via=live|m2，远端探测走live，DB落盘回填走m2；
/// - 世代比对防串榜：落库前 + emit 前双检查 `BOARD_GEN == expected_gen`，
///   用户在此期间切榜/重拉则抛弃过时探测结果（与搜索 `SEARCH_GEN` 双检查同语义）；
/// - 单条显式事务边界（与搜索同形，失败 `ROLLBACK` 返回，内部吞错下次补探重试）。
async fn save_and_emit_trend(
    handle: &AppHandle,
    id: &str,
    owner: &str,
    repo: &str,
    board: &str,
    url: &str,
    level: i32,
    via: &str,
    expected_gen: u64,
) {
    if BOARD_GEN.load(Ordering::SeqCst) != expected_gen {
        return;
    }
    let state = handle.state::<AppState>();
    if let Ok(db) = state.db() {
        let mut cycle = crate::db::AppIconCycle::new(id, owner, repo);
        cycle.is_cataloged = false;
        cycle.level = level;
        if level == 2 {
            cycle.l2_url = url.to_owned();
        } else if level == 3 {
            cycle.l3_url = url.to_owned();
        }
        cycle.selected_url = url.to_owned();
        cycle.updated_at = crate::now_secs();
        let _ = db.with_immediate_transaction(|| {
            db.upsert_icon_cycle(&cycle)?;
            Ok(())
        });
    }
    if BOARD_GEN.load(Ordering::SeqCst) != expected_gen {
        return;
    }
    let ready = crate::github::icon_fetch::IconReadyPayload {
        key: crate::github::icon_fetch::icon_key(owner, repo),
        id: id.to_owned(),
        icon: url.to_owned(),
        level,
        via: via.to_owned(),
        context: crate::github::icon_fetch::IconFetchCtx::Trend {
            board: board.to_owned(),
            gen: expected_gen,
        },
    };
    crate::github::icon_fetch::emit_icon_ready(handle, &ready);
}

/// `github::icon_fetch::fetch_icons_stream` 的命中回调（搜索接 Search，趋势接 Trend）。
/// 世代防串由 `save_and_emit` / `save_and_emit_trend` 内落库前 + emit 前双检查执行。
/// `via`=live|m2 透传（core探测一律live，M2回填走m2不占level）。
async fn emit_icon_job(
    handle: AppHandle,
    job: crate::github::icon_fetch::IconFetchJob,
    url: String,
    level: i32,
    via: String,
) {
    match job.ctx {
        crate::github::icon_fetch::IconFetchCtx::Search {
            ref search_id,
            gen,
        } => {
            save_and_emit(
                &handle, &job.id, &job.owner, &job.repo, search_id, &url, level, &via, gen,
            )
            .await;
        }
        crate::github::icon_fetch::IconFetchCtx::Trend { ref board, gen } => {
            save_and_emit_trend(
                &handle, &job.id, &job.owner, &job.repo, board, &url, level, &via, gen,
            )
            .await;
        }
    }
}

/// H8：隐藏规则 id 集合（本地收敛 `search_apps` / `get_category_apps` 重复块）。
pub(crate) fn hidden_rule_ids(state: &AppState) -> std::collections::HashSet<String> {
    if let Ok(db) = state.db() {
        db.get_all_rules()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.is_hidden)
            .map(|r| r.app_id)
            .collect()
    } else {
        std::collections::HashSet::new()
    }
}

/// 未收录卡片回填：确认图标覆盖 → 待写 icon_cycle 构建 → 详情缓存 platforms join。
/// level纯L，via正交：DB落盘命中为M2回填走via=m2不占level；远端只标L2/L3 live。
/// `simpleicons.org` 标 level 2 写 `l2_url`，其余标 level 3 写 `l3_url`。
/// 返回 `Some(cycle)` 时由调用方收进 `pending` 批量落库；无事可写返回 `None`。
/// 纯同步无 `await`（调用方单临界区内复用 db 锁，批量 upsert 仍在调用点）。
fn backfill_uncataloged_card(
    db: &crate::db::Database,
    item: &mut AppSummary,
    ttl_seconds: i64,
) -> Option<crate::db::AppIconCycle> {
    let pending = if let Some(ci) =
        crate::github::http::resolve_confirmed_icon_from_db(db, &item.id, &item.owner, &item.repo)
    {
        item.icon = ci;
        None
    } else if !item.icon.trim().is_empty() {
        let mut cycle = crate::db::AppIconCycle::new(&item.id, &item.owner, &item.repo);
        cycle.is_cataloged = false;
        if item.icon.contains("simpleicons.org") {
            cycle.level = 2;
            cycle.l2_url = item.icon.clone();
        } else {
            cycle.level = 3;
            cycle.l3_url = item.icon.clone();
        }
        cycle.selected_url = item.icon.clone();
        cycle.updated_at = crate::now_secs();
        Some(cycle)
    } else {
        None
    };
    // Option A：repeat-search 平台回填——TTL 内详情缓存命中且 platforms 非空时直接 join；
    // 缺失/过期/空平台一律保持 []（不 stamp ["other"]/["windows"]），由既有 lazyBackfill 兜底。
    if let Ok(Some(cached)) = db.get_cached_app_detail(&item.id, Some(ttl_seconds)) {
        if !cached.platforms.is_empty() {
            item.platforms = cached.platforms;
        }
    }
    pending
}

/// icon_cycle 待写批量落库（`search_apps_online` / `enrich_trend_repos` 双调用点收敛）：
/// 事务边界：`BEGIN IMMEDIATE` → N 条 `upsert_icon_cycles_batch` → `COMMIT`；
/// 失败整体 `ROLLBACK` 并回退逐条（保持 `let _ =` 吞错 + 下次重试语义）。
/// 空 pending 直接跳过；纯同步无 `await`（调用方单临界区内复用 db 锁）。
fn flush_icon_cycle_pending(db: &crate::db::Database, pending: &[crate::db::AppIconCycle]) {
    if pending.is_empty() {
        return;
    }
    if db.upsert_icon_cycles_batch(pending).is_err() {
        for c in pending {
            let _ = db.upsert_icon_cycle(c);
        }
    }
}

/// 分页切片（None=全量，Some 切 slice，越界守好）。
fn slice_paged<T: Clone>(items: Vec<T>, limit: Option<usize>, offset: Option<usize>) -> Vec<T> {
    match (limit, offset) {
        (None, None) => items,
        _ => {
            let off = offset.unwrap_or(0);
            if off >= items.len() {
                return Vec::new();
            }
            let end = match limit {
                Some(l) => off.saturating_add(l).min(items.len()),
                None => items.len(),
            };
            items[off..end].to_vec()
        }
    }
}

#[tauri::command]
pub async fn search_apps(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> crate::AppResult<Vec<AppSummary>> {
    let search_start = std::time::Instant::now();
    let hidden_ids: std::collections::HashSet<String> = hidden_rule_ids(&state);

    let results = state.catalog.search_apps(&query);
    let filtered: Vec<AppSummary> = if hidden_ids.is_empty() {
        results
    } else {
        results
            .into_iter()
            .filter(|a| !hidden_ids.contains(&a.id))
            .collect()
    };
    // 分页：None=全量（分类/趋势/搜索空态沿用 stars 降序默认），Some 时切 slice。
    // 空查询 stars 降序、非空线性打分逻辑在 `CatalogService::search_apps` 内保持不变，此处仅切片。
    let total = filtered.len();
    let paged = slice_paged(filtered, limit, offset);

    log::info!(
        "search done sid={} query='{}' hits={} total={} elapsed_ms={}",
        crate::z_log::new_session_id(),
        crate::log_support::short_reason(&query),
        paged.len(),
        total,
        search_start.elapsed().as_millis()
    );
    Ok(paged)
}

/// 在线搜索（可翻页）：`page`/`per_page` 均为 None=老行为（第 1 页 12 条）。
/// - `per_page` 默认复用 `limits.online_search_page_size`，钳制 1-50；
/// - `page` 默认 1（0 归一为 1）；`owner/repo` 直查短路只回第 1 页 1 条，page>1 回空（与 mock 同语义）。
#[tauri::command]
pub async fn search_apps_online(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    query: String,
    search_id: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
) -> crate::AppResult<OnlineSearchResult> {
    // Wave2：单次 search_apps 只记一行 INFO `search done`（行为链 sid 关联）；
    // 内层 github/search 的同名 debug 已移除，此处为唯一 `search done`。
    let search_start = std::time::Instant::now();
    let current_gen = SEARCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let actual_search_id = search_id.unwrap_or_else(|| current_gen.to_string());
    // 直查单条：page>1 直接回空（与 mock/前端翻页契约对齐，避免翻页重复首条）。
    let eff_page = crate::config::LimitsConfig::normalize_online_search_page(page);
    // 1. 优先检查是否为多源 (Codeberg, Gitea, 自建源) 仓库 URL 或 short syntax
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&query) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            // 直查单条：page>1 回空（mock 同语义）。
            if eff_page > 1 {
                return Ok(OnlineSearchResult { rows: Vec::new(), sid: actual_search_id.clone() });
            }
            let host_token = if let Ok(db) = state.db() {
                db.get_host_token(&coord.host).ok().flatten()
            } else {
                None
            };
            if let Ok(repo_info) =
                crate::forge::ForgeRegistry::fetch_repo(&coord, host_token.as_deref()).await
            {
                let release_res = crate::forge::ForgeRegistry::fetch_latest_release(
                    &coord,
                    host_token.as_deref(),
                )
                .await;
                let (latest_ver, platforms) = match release_res {
                    Ok(r) => {
                        let plats = super::catalog_detail::platforms_from_assets(&r.assets);
                        (r.tag_name, plats)
                    }
                    Err(_) => ("latest".to_string(), Vec::new()),
                };
                log::info!(
                    "search done sid={} query='{}' hits=1 elapsed_ms={}",
                    crate::z_log::new_session_id(),
                    crate::log_support::short_reason(&query),
                    search_start.elapsed().as_millis()
                );
                let app_id = coord.to_app_id();
                let icon = if let Ok(db) = state.db() {
                    crate::github::http::resolve_confirmed_icon_from_db(
                        &db,
                        &app_id,
                        &coord.owner,
                        &coord.repo,
                    )
                    .unwrap_or_default()
                } else {
                    String::new()
                };
                return Ok(OnlineSearchResult { rows: vec![AppSummary {
                    id: app_id,
                    name: repo_info.name,
                    description_en: repo_info.description.clone(),
                    owner: coord.owner,
                    repo: coord.repo,
                    icon,
                    icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
                    description: repo_info
                        .description
                        .unwrap_or_else(|| "跨平台开源项目".to_string()),
                    stars: repo_info.stars,
                    forks: repo_info.forks,
                    license: "OpenSource".to_string(),
                    latest_version: latest_ver,
                    category: "external".to_string(),
                    category_name: "跨平台开源".to_string(),
                    is_verified: false,
                    is_installed: None,
                    has_update: None,
                    installed_version: None,
                    forge: Some(coord.forge.as_str().to_string()),
                    forge_host: Some(coord.host),
                    homepage: repo_info.homepage.clone(),
                    platforms,
                }], sid: actual_search_id.clone() });
            }
        } else if query.contains('/')
            || query.starts_with("https://")
            || query.starts_with("gh:")
            || query.starts_with("github:")
        {
            // 直查单条：page>1 回空（mock 同语义）。
            if eff_page > 1 {
                return Ok(OnlineSearchResult { rows: Vec::new(), sid: actual_search_id.clone() });
            }
            let token = crate::commands::resolve_active_github_token(&state);
            // Top1（`Send` 安全）：短锁预解析 owned 确认图标（同步无 `await`，锁即取即放），
            // 传 owned `String` 跨 `await`（`Send`），`fetch` 内零查询零直连；传不进（锁失败）则 `None` 回退兜底不 panic。
            let pre_confirmed: Option<String> = state.db().ok().and_then(|db| {
                crate::github::http::resolve_confirmed_icon_from_db(
                    &db,
                    &coord.to_app_id(),
                    &coord.owner,
                    &coord.repo,
                )
            });
            if let Ok(mut item) = state
                .catalog
                .fetch_online_repo(&coord.owner, &coord.repo, token.as_deref(), pre_confirmed)
                .await
            {
                if let Ok(db) = state.db() {
                    if let Some(ci) = crate::github::http::resolve_confirmed_icon_from_db(
                        &db,
                        &item.id,
                        &item.owner,
                        &item.repo,
                    ) {
                        item.icon = ci;
                    } else if !item.icon.trim().is_empty() {
                        // 远端只标 L2/L3 live。
                        let mut cycle = crate::db::AppIconCycle::new(&item.id, &item.owner, &item.repo);
                        cycle.is_cataloged = false;
                        if item.icon.contains("simpleicons.org") {
                            cycle.level = 2;
                            cycle.l2_url = item.icon.clone();
                        } else {
                            cycle.level = 3;
                            cycle.l3_url = item.icon.clone();
                        }
                        cycle.selected_url = item.icon.clone();
                        cycle.updated_at = crate::now_secs();
                        let _ = db.upsert_icon_cycle(&cycle);
                    }
                }
                log::debug!("fetch repo ok id={}", item.id);
                log::info!(
                    "search done sid={} query='{}' hits=1 elapsed_ms={}",
                    crate::z_log::new_session_id(),
                    crate::log_support::short_reason(&query),
                    search_start.elapsed().as_millis()
                );
                return Ok(OnlineSearchResult { rows: vec![item], sid: actual_search_id.clone() });
            }
        }
    }

    let token = crate::commands::resolve_active_github_token(&state);
    let hidden_ids: std::collections::HashSet<String> = hidden_rule_ids(&state);

    // Top1（`Send` 安全）：直查 shortcut（`owner/repo`）短锁预解析 owned 确认图标（同步无 `await`），
    // 传 owned 跨 `await`（`Send`），搜索侧零直连；非直查传 `None`，首屏置空由下方批量回填（`ok()` 吞错不 panic）。
    let pre_for_direct: Option<String> = {
        let q = query.trim();
        if q.contains('/') && !q.contains(' ') {
            let parts: Vec<&str> = q.split('/').collect();
            if parts.len() == 2 {
                let owner = parts[0].trim();
                let repo = parts[1].trim();
                if !owner.is_empty() && !repo.is_empty() {
                    let app_id = format!("{}/{}", owner.to_lowercase(), repo.to_lowercase());
                    state.db().ok().and_then(|db| {
                        crate::github::http::resolve_confirmed_icon_from_db(
                            &db, &app_id, owner, repo,
                        )
                    })
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    };
    let mut results = state
        .catalog
        .search_github_online(&query, token.as_deref(), pre_for_direct, page, per_page)
        .await?;

    // Top1+2：循环外一次取 `db` 锁复用（单临界区同步无 `await`），读解析 + 写包事务化。
    // 事务边界：`BEGIN IMMEDIATE` → N 条 `upsert_icon_cycle` → `COMMIT`（N=当页条数逐条提交变 1 提交），
    // 失败整体 `ROLLBACK` 并回退逐条（保持 `let _ =` 吞错 + 下次重试语义）。
    if let Ok(db) = state.db() {
        let ttl_seconds = db.get_detail_cache_ttl_minutes() * 60;
        let mut pending: Vec<crate::db::AppIconCycle> = Vec::new();
        for item in &mut results {
            if let Some(cycle) = backfill_uncataloged_card(&db, item, ttl_seconds) {
                pending.push(cycle);
            }
        }
        flush_icon_cycle_pending(&db, &pending);
    }

    // 后台图标补探量随分页 `per_page` 伸缩：None=老行为 12 条，其余为钳制后 1-50。
    let probe_cap = crate::config::get_project_config()
        .limits
        .clamp_online_search_per_page(per_page);
    // 搜索对齐趋势：已确认（`selected_url` 非空非 avatar）不进 jobs，
    // 复用 `http::resolve_confirmed_icon_from_db` + `icon_fetch::icon_key`，
    // 抄趋势 `filter pre.is_none()` 语义，省重复探。
    let pre_confirmed: Vec<Option<String>> = if let Ok(db) = state.db() {
        results
            .iter()
            .map(|item| {
                crate::github::http::resolve_confirmed_icon_from_db(
                    &db,
                    &crate::github::icon_fetch::icon_key(&item.owner, &item.repo),
                    &item.owner,
                    &item.repo,
                )
            })
            .collect()
    } else {
        results.iter().map(|_| None).collect()
    };
    let candidates: Vec<(String, String, String)> = results
        .iter()
        .zip(pre_confirmed.iter())
        .filter(|(item, pre)| {
            state.catalog.get_catalog_item(&item.id).is_none()
                && !item.icon.contains("simpleicons.org")
                && pre.is_none()
        })
        .take(probe_cap)
        .map(|(item, _)| (item.id.to_lowercase(), item.owner.clone(), item.repo.clone()))
        .collect();

    log::info!(
        "search done sid={} query='{}' hits={} elapsed_ms={}",
        crate::z_log::new_session_id(),
        crate::log_support::short_reason(&query),
        results.len(),
        search_start.elapsed().as_millis()
    );

    let filtered_results: Vec<AppSummary> = if hidden_ids.is_empty() {
        results
    } else {
        results
            .into_iter()
            .filter(|a| !hidden_ids.contains(&a.id))
            .collect()
    };

    if !candidates.is_empty() {
        let handle = app_handle.clone();
        let sid = actual_search_id.clone();
        let bg_token = token.clone();
        // 搜索固定走新流式路（`compat_collect` 仅门控趋势等齐路，见 ADR-0015 §7）：
        // pool=5 buffer_unordered、快命中即返不等慢、慢仅快未命中且有 token 时跑、
        // 整批总量按页伸缩、逐张到达 emit。
        let jobs: Vec<crate::github::icon_fetch::IconFetchJob> = candidates
            .into_iter()
            .map(|(id, owner, repo)| crate::github::icon_fetch::IconFetchJob {
                id,
                owner,
                repo,
                ctx: crate::github::icon_fetch::IconFetchCtx::Search {
                    search_id: sid.clone(),
                    gen: current_gen,
                },
            })
            .collect();
        let cfg = crate::config::get_project_config().limits.icon_fetch;
        tokio::spawn(crate::github::icon_fetch::fetch_icons_stream(
            handle, jobs, bg_token, cfg, emit_icon_job,
        ));
    }

    Ok(OnlineSearchResult { rows: filtered_results, sid: actual_search_id.clone() })
}

/// 趋势未收录行 enrichment 入参：待查仓库坐标（与 TrendRepo.owner/repo 对齐）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrendEnrichRequest {
    pub owner: String,
    pub repo: String,
}

/// 趋势未收录行 enrichment：批量复用搜索单仓直查
/// （`fetch_online_repo` → `fallback_summary`，图标 initials 回退/分类猜测沿用，platforms 未知置空 []）。
/// 配额/鉴权沿用既有链路（`resolve_active_github_token` + 内层 `notify_rate_limit`）。
/// - 并发上限 5（`buffered` 保序，返回与入参一一对齐）；单仓 `api_timeout_or(10s)` 熔断；
/// - 单仓失败落 `None`（前端保留旧小行，榜单永不因此变空）；
///   入参上限 40（FE 分片串行 20/片×2 片，上限 40；BE 侧 take(40) 截断，buffered(5) 不变）。
/// - 趋势流式：首屏 `fallback_summary(probe=false)` 空壳快返（图标置空，
///   确认图标仍经 `pre_confirmed` 短锁回填，platforms 经详情缓存 join 照旧），
///   另起 `tokio::spawn(fetch_icons_stream(ctx=Trend{board,board_gen}))` 流式
///   `emit_icon_ready` 逐张到达补齐（弱网首屏先出裸行/初始富卡，图标逐个补齐，
///   空永不覆盖实由前端 `iconStore.applyHit` + 后端 `BOARD_GEN` 双检查保证）；
/// - 世代：每次流式调用 `BOARD_GEN+1`（切榜/重拉/分片重拉均+1，类比 `SEARCH_GEN`），
///   落库前 + emit 前双检查（见 `save_and_emit_trend`）；
/// - 逃生门：`IconFetchConfig.compat_collect=true`（默认）时保持
///   `buffered+collect` 等齐路（`probe=true` 内联慢探同步完成），
///   仅 `compat_collect=false` 时走新流式路。
#[tauri::command]
pub async fn enrich_trend_repos(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    repos: Vec<TrendEnrichRequest>,
    board: Option<String>,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    use futures_util::StreamExt;
    let enrich_start = std::time::Instant::now();
    let board_name = board.unwrap_or_default().trim().to_lowercase();
    let cfg_icon = crate::config::get_project_config().limits.icon_fetch;
    // 逃生门：compat_collect=true 保持老等齐路（含内联慢探）。
    if cfg_icon.compat_collect {
        return enrich_trend_repos_buffered(state, repos, enrich_start).await;
    }
    // 世代：流式路每次调用 +1（切榜/重拉均触发新调用，类比 SEARCH_GEN）。
    let current_gen = BOARD_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    // 流式路：首屏 probe=false 空壳快返 + 后台 fetch_icons_stream。
    // FE 已按 20/片×2 片串行（上限 40），此处 take(40) 为兜底截断，不静默吃超量。
    let targets: Vec<(String, String, String)> = repos
        .into_iter()
        .take(40)
        .map(|r| {
            let owner = r.owner.trim().to_string();
            let repo = r.repo.trim().to_string();
            let id = format!("{}/{}", owner.to_lowercase(), repo.to_lowercase());
            (id, owner, repo)
        })
        .collect();
    let requested = targets.len();
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let token = crate::commands::resolve_active_github_token(&state);
    let timeout_each = api_timeout_or(std::time::Duration::from_secs(10));
    // `State` 非 Copy：取共享引用供 FnMut 闭包多次捕获（`&CatalogService: Copy + Send`）。
    let catalog = &state.catalog;
    // 短锁预解析确认图标（同步无 await，锁即取即放），fetch 内零查询零直连。
    let pre_confirmed: Vec<Option<String>> = if let Ok(db) = state.db() {
        targets
            .iter()
            .map(|(id, owner, repo)| {
                crate::github::http::resolve_confirmed_icon_from_db(&db, id, owner, repo)
            })
            .collect()
    } else {
        targets.iter().map(|_| None).collect()
    };
    // 首屏：`probe=false` 等价——`pre` 恒为 `Some`（确认实图或空串），
    // `fetch_online_repo` 内 `fallback_summary(probe=true)` 见 `Some` 即直接采用、
    // 跳过 SimpleIcons/Trees 内联慢探，只剩 GitHub 元数据 fetch（描述/星数保留，
    // 图标置空等后台流式补齐）。确认图标仍直接回填，platforms 经下方 join 照旧。
    let pre_fast: Vec<Option<String>> = pre_confirmed
        .iter()
        .map(|p| Some(p.clone().unwrap_or_default()))
        .collect();
    let mut results: Vec<Option<AppSummary>> = futures_util::stream::iter(
        targets
            .clone()
            .into_iter()
            .zip(pre_fast)
            .map(|((id, owner, repo), pre)| {
                let token = token.clone();
                async move {
                    if owner.is_empty() || repo.is_empty() {
                        return None;
                    }
                    match tokio::time::timeout(
                        timeout_each,
                        catalog.fetch_online_repo(&owner, &repo, token.as_deref(), pre),
                    )
                    .await
                    {
                        Ok(Ok(item)) => Some(item),
                        Ok(Err(e)) => {
                            log::debug!(
                                "trend enrich miss id={} reason={}",
                                id,
                                crate::log_support::short_reason(&e)
                            );
                            None
                        }
                        Err(_) => {
                            log::debug!("trend enrich timeout id={}", id);
                            None
                        }
                    }
                }
            }),
    )
    .buffered(5)
    .collect()
    .await;

    // Top1+2 收敛：循环外一次取 db 锁复用，读解析 + 写包事务化（与 search_apps_online 同形）。
    // 快返壳图标为空，此处基本无 pending（确认图标已直接回填），platforms 经详情缓存 join 照旧。
    if let Ok(db) = state.db() {
        let ttl_seconds = db.get_detail_cache_ttl_minutes() * 60;
        let mut pending: Vec<crate::db::AppIconCycle> = Vec::new();
        for item in results.iter_mut().flatten() {
            if let Some(cycle) = backfill_uncataloged_card(&db, item, ttl_seconds) {
                pending.push(cycle);
            }
        }
        flush_icon_cycle_pending(&db, &pending);
    }

    // 后台流式：无确认图标的仓全部入 `fetch_icons_stream(Trend)`，
    // 快命中即返不等慢、逐张到达 `emit_icon_ready`（含 GitHub 失败的裸行仓，
    // 前端缓冲等 enrich 重试/详情治愈时合并，空永不覆盖实）。
    let jobs: Vec<crate::github::icon_fetch::IconFetchJob> = targets
        .into_iter()
        .zip(pre_confirmed)
        .filter(|(_, pre)| pre.is_none())
        .map(|((id, owner, repo), _)| crate::github::icon_fetch::IconFetchJob {
            id,
            owner,
            repo,
            ctx: crate::github::icon_fetch::IconFetchCtx::Trend {
                board: board_name.clone(),
                gen: current_gen,
            },
        })
        .collect();
    if !jobs.is_empty() {
        let handle = app_handle.clone();
        let bg_token = token.clone();
        tokio::spawn(crate::github::icon_fetch::fetch_icons_stream(
            handle,
            jobs,
            bg_token,
            cfg_icon,
            emit_icon_job,
        ));
    }

    log::info!(
        "trend enrich done requested={} hits={} elapsed_ms={} streamed_gen={}",
        requested,
        results.iter().filter(|r| r.is_some()).count(),
        enrich_start.elapsed().as_millis(),
        current_gen,
    );
    Ok(results)
}

/// 逃生门：`compat_collect=true` 时的 `buffered+collect` 等齐路。
/// `probe=true` 内联慢探在单仓超时内同步完成，命中经批量 enrich 落库；无后台 emit。
async fn enrich_trend_repos_buffered(
    state: State<'_, AppState>,
    repos: Vec<TrendEnrichRequest>,
    enrich_start: std::time::Instant,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    use futures_util::StreamExt;
    // FE 已按 20/片×2 片串行（上限 40），此处 take(40) 为兜底截断，不静默吃超量。
    let targets: Vec<(String, String, String)> = repos
        .into_iter()
        .take(40)
        .map(|r| {
            let owner = r.owner.trim().to_string();
            let repo = r.repo.trim().to_string();
            let id = format!("{}/{}", owner.to_lowercase(), repo.to_lowercase());
            (id, owner, repo)
        })
        .collect();
    let requested = targets.len();
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let token = crate::commands::resolve_active_github_token(&state);
    let timeout_each = api_timeout_or(std::time::Duration::from_secs(10));
    // `State` 非 Copy：取共享引用供 FnMut 闭包多次捕获（`&CatalogService: Copy + Send`）。
    let catalog = &state.catalog;
    // 短锁预解析确认图标（同步无 await，锁即取即放），fetch 内零查询零直连。
    let pre_confirmed: Vec<Option<String>> = if let Ok(db) = state.db() {
        targets
            .iter()
            .map(|(id, owner, repo)| {
                crate::github::http::resolve_confirmed_icon_from_db(&db, id, owner, repo)
            })
            .collect()
    } else {
        targets.iter().map(|_| None).collect()
    };
    let mut results: Vec<Option<AppSummary>> = futures_util::stream::iter(
        targets
            .into_iter()
            .zip(pre_confirmed)
            .map(|((id, owner, repo), pre)| {
                let token = token.clone();
                async move {
                    if owner.is_empty() || repo.is_empty() {
                        return None;
                    }
                    match tokio::time::timeout(
                        timeout_each,
                        catalog.fetch_online_repo(&owner, &repo, token.as_deref(), pre),
                    )
                    .await
                    {
                        Ok(Ok(item)) => Some(item),
                        Ok(Err(e)) => {
                            log::debug!(
                                "trend enrich miss id={} reason={}",
                                id,
                                crate::log_support::short_reason(&e)
                            );
                            None
                        }
                        Err(_) => {
                            log::debug!("trend enrich timeout id={}", id);
                            None
                        }
                    }
                }
            }),
    )
    .buffered(5)
    .collect()
    .await;

    // Top1+2 收敛：循环外一次取 db 锁复用，读解析 + 写包事务化（与 search_apps_online 同形）。
    if let Ok(db) = state.db() {
        let ttl_seconds = db.get_detail_cache_ttl_minutes() * 60;
        let mut pending: Vec<crate::db::AppIconCycle> = Vec::new();
        for item in results.iter_mut().flatten() {
            if let Some(cycle) = backfill_uncataloged_card(&db, item, ttl_seconds) {
                pending.push(cycle);
            }
        }
        flush_icon_cycle_pending(&db, &pending);
    }

    log::info!(
        "trend enrich done requested={} hits={} elapsed_ms={}",
        requested,
        results.iter().filter(|r| r.is_some()).count(),
        enrich_start.elapsed().as_millis()
    );
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_slow_falls_back_to_master() {
        // 慢路径 Trees 覆盖 master（ZCode 类老仓默认分支），顺序 main 优先。
        // 分支顺序收归 `github::icon_fetch` core，此处直引 core 常量断言。
        assert_eq!(
            crate::github::icon_fetch::SEARCH_PROBE_BRANCHES,
            ["main", "master"]
        );
        assert!(crate::github::icon_fetch::SEARCH_PROBE_BRANCHES.contains(&"master"));
    }

    fn sample_summary(id: &str, owner: &str, repo: &str, icon: &str) -> AppSummary {
        AppSummary {
            id: id.to_string(),
            name: "Demo".to_string(),
            description_en: None,
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: icon.to_string(),
            icon_bg: String::new(),
            description: String::new(),
            stars: 0,
            forks: 0,
            license: String::new(),
            latest_version: "latest".to_string(),
            category: "external".to_string(),
            category_name: String::new(),
            is_verified: false,
            is_installed: None,
            has_update: None,
            installed_version: None,
            forge: None,
            forge_host: None,
            homepage: None,
            platforms: Vec::new(),
        }
    }

    #[test]
    fn backfill_uncataloged_card_keeps_twin_loop_semantics() {
        // 空图标无 pending 且保持原样 / L2品牌库 pending 构建 /
        // 非品牌库远端只标 L3 live / DB 命中直接覆盖且无 pending（M2回填走via=m2不占level）。
        let db = crate::db::Database::open_in_memory().unwrap();
        let mut empty = sample_summary("o/r", "o", "r", "");
        assert!(backfill_uncataloged_card(&db, &mut empty, 1800).is_none());
        assert!(empty.icon.is_empty());
        assert!(empty.platforms.is_empty());

        let mut l2 = sample_summary("s/i", "s", "i", "https://cdn.simpleicons.org/i");
        let c = backfill_uncataloged_card(&db, &mut l2, 1800).expect("l2 pending");
        assert_eq!(c.level, 2);
        assert_eq!(c.l2_url, "https://cdn.simpleicons.org/i");
        assert_eq!(c.selected_url, "https://cdn.simpleicons.org/i");
        assert_eq!(l2.icon, "https://cdn.simpleicons.org/i");

        let mut l3 = sample_summary("t/r", "t", "r", "https://raw.githubusercontent.com/t/r/main/icon.png");
        let c3 = backfill_uncataloged_card(&db, &mut l3, 1800).expect("l3 pending");
        assert_eq!(c3.level, 3);
        assert_eq!(c3.l3_url, "https://raw.githubusercontent.com/t/r/main/icon.png");
        assert!(c3.l4_url.is_empty());
        assert_eq!(c3.selected_url, "https://raw.githubusercontent.com/t/r/main/icon.png");

        let mut cycle = crate::db::AppIconCycle::new("c/r", "c", "r");
        cycle.is_cataloged = false;
        cycle.level = 2;
        cycle.l2_url = "https://example.com/c.png".to_string();
        cycle.selected_url = "https://example.com/c.png".to_string();
        cycle.updated_at = crate::now_secs();
        db.upsert_icon_cycle(&cycle).unwrap();
        let mut confirmed = sample_summary("c/r", "c", "r", "");
        assert!(backfill_uncataloged_card(&db, &mut confirmed, 1800).is_none());
        assert_eq!(confirmed.icon, "https://example.com/c.png");
    }
}
