use crate::models::AppSummary;
use crate::AppState;
use futures_util::StreamExt;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchIconReadyPayload {
    pub search_id: String,
    pub app_id: String,
    pub icon: String,
    pub level: i32,
}

/// 快/慢图标探测结果落库 + 前端 emit（`upsert_icon_cycle` + `zstore://search-icon-ready`）。
/// - `level=2`：快路径 SimpleIcons，写 `l2_url`；`level=3`：慢路径 Trees，写 `l3_url`；
/// - 世代比对防串词：落库前 + emit 前双检查 `SEARCH_GEN == expected_gen`，
///   用户在此期间触发新搜索则抛弃过时探测结果（与原快/慢两路内联语义一致）。
/// - 单条显式事务边界（单语句隐式事务显式化，仍 1 提交，emit 不延迟）；
///   失败 `ROLLBACK` 返回 Err，上层 `let _ =` 吞错由吞错语义改为内部吞错、下次补探重试。
async fn save_and_emit(
    handle: &AppHandle,
    id: &str,
    owner: &str,
    repo: &str,
    sid: &str,
    url: &str,
    level: i32,
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
    let payload = SearchIconReadyPayload {
        search_id: sid.to_owned(),
        app_id: id.to_owned(),
        icon: url.to_owned(),
        level,
    };
    let _ = handle.emit("zstore://search-icon-ready", &payload);
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

/// 分页切片（Option 版，供 `search_apps` 向后兼容：None=全量，Some 切 slice，越界守好）。
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
    // 向后兼容分页：None=全量（分类/趋势/搜索空态沿用 stars 降序默认），Some 时切 slice。
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
) -> crate::AppResult<Vec<AppSummary>> {
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
                return Ok(Vec::new());
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
                return Ok(vec![AppSummary {
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
                }]);
            }
        } else if query.contains('/')
            || query.starts_with("https://")
            || query.starts_with("gh:")
            || query.starts_with("github:")
        {
            // 直查单条：page>1 回空（mock 同语义）。
            if eff_page > 1 {
                return Ok(Vec::new());
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
                        let mut cycle = crate::db::AppIconCycle::new(&item.id, &item.owner, &item.repo);
                        cycle.is_cataloged = false;
                        if item.icon.contains("simpleicons.org") {
                            cycle.level = 2;
                            cycle.l2_url = item.icon.clone();
                        } else {
                            cycle.level = 4;
                            cycle.l4_url = item.icon.clone();
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
                return Ok(vec![item]);
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
            if let Some(ci) = crate::github::http::resolve_confirmed_icon_from_db(
                &db,
                &item.id,
                &item.owner,
                &item.repo,
            ) {
                item.icon = ci;
            } else if !item.icon.trim().is_empty() {
                let mut cycle = crate::db::AppIconCycle::new(&item.id, &item.owner, &item.repo);
                cycle.is_cataloged = false;
                if item.icon.contains("simpleicons.org") {
                    cycle.level = 2;
                    cycle.l2_url = item.icon.clone();
                } else {
                    cycle.level = 4;
                    cycle.l4_url = item.icon.clone();
                }
                cycle.selected_url = item.icon.clone();
                cycle.updated_at = crate::now_secs();
                pending.push(cycle);
            }
            // Option A：repeat-search 平台回填——TTL 内详情缓存命中且 platforms 非空时直接 join；
            // 缺失/过期/空平台一律保持 []（不 stamp ["other"]/["windows"]），由既有 lazyBackfill 兜底。
            if let Ok(Some(cached)) = db.get_cached_app_detail(&item.id, Some(ttl_seconds)) {
                if !cached.platforms.is_empty() {
                    item.platforms = cached.platforms;
                }
            }
        }
        if !pending.is_empty() && db.upsert_icon_cycles_batch(&pending).is_err() {
            for c in &pending {
                let _ = db.upsert_icon_cycle(c);
            }
        }
    }

    // 后台图标补探量随分页 `per_page` 伸缩：None=老行为 12 条，其余为钳制后 1-50。
    let probe_cap = crate::config::get_project_config()
        .limits
        .clamp_online_search_per_page(per_page);
    let candidates: Vec<(String, String, String)> = results
        .iter()
        .filter(|item| {
            state.catalog.get_catalog_item(&item.id).is_none()
                && !item.icon.contains("simpleicons.org")
        })
        .take(probe_cap)
        .map(|item| (item.id.to_lowercase(), item.owner.clone(), item.repo.clone()))
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
        tokio::spawn(async move {
            let client = crate::commands::icon_http_client();
            // 慢路径鉴权头：有 token 才跑 Trees，无 token 只走快路径。
            let slow_headers = bg_token
                .as_deref()
                .filter(|t| !t.trim().is_empty())
                .map(|t| crate::github::http::token_headers(Some(t)));
            // P0-2 有界并发：双层无界 spawn 合并为单层 buffer_unordered(8)，
            // 快慢各一次 emit 语义不变（快命中即返不等慢，慢仅快未命中且有 token 时跑）。
            let batch = futures_util::stream::iter(candidates.into_iter().map(
                |(id, owner, repo)| {
                    let handle = handle.clone();
                    let client = client.clone();
                    let sid = sid.clone();
                    let slow_headers = slow_headers.clone();
                    async move {
                        // 快慢分离：快路径 SimpleIcons（repo+owner 去重单循环，每 slug 超时与
                        // 外层兜底均经 api_timeout_seconds 统一配置，未设置时回退 1500ms/8000ms 历史值），
                        // 快命中立即落库并 emit，不等慢路径。
                        let fast_url = tokio::time::timeout(
                            api_timeout_or(std::time::Duration::from_millis(8000)),
                            crate::github::icon_probe::probe_simple_icons(
                                &client, &owner, &repo,
                            ),
                        )
                        .await
                        .ok()
                        .flatten()
                        .map(|h| h.url)
                        .unwrap_or_default();

                        if !fast_url.trim().is_empty() {
                            // 世代比对防串词见 `save_and_emit`（落库前 + emit 前双检查）。
                            save_and_emit(
                                &handle, &id, &owner, &repo, &sid, &fast_url, 2, current_gen,
                            )
                            .await;
                            return;
                        }

                        // 慢路径：快未命中且有 token 才跑 Trees（内部 12s）；超时只弃慢不弃快。
                        if let Some(hdrs) = slow_headers.as_ref() {
                            if let Some(hit) = crate::github::icon_probe::probe_trees(
                                &client, hdrs, &owner, &repo, "main",
                            )
                            .await
                            {
                                save_and_emit(
                                    &handle, &id, &owner, &repo, &sid, &hit.url, 3, current_gen,
                                )
                                .await;
                            }
                        }
                    }
                },
            ))
            .buffer_unordered(8)
            .for_each(|()| async {});
            // 整批 15s 总超时：超时即降级结束（剩余候选直接丢弃，不炸不重试）。
            let _ = tokio::time::timeout(std::time::Duration::from_secs(15), batch).await;
        });
    }

    Ok(filtered_results)
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
/// - 单仓失败落 `None`（前端保留旧小行，榜单永不因此变空）；入参上限 20（单榜页量级）。
/// - 无后台慢探 emit：enrich 结果由 TrendsView 本地持有，`search-icon-ready` 订阅方
///   （App.tsx 世代门控）无对应 search_id，emit 无人消费；慢探由
///   `fallback_summary(probe=true)` 在单仓超时内同步完成，命中经下方批量 enrich 落库。
#[tauri::command]
pub async fn enrich_trend_repos(
    state: State<'_, AppState>,
    repos: Vec<TrendEnrichRequest>,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    use futures_util::StreamExt;
    let enrich_start = std::time::Instant::now();
    let targets: Vec<(String, String, String)> = repos
        .into_iter()
        .take(20)
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
    let catalog = &state.catalog;    // 短锁预解析确认图标（同步无 await，锁即取即放），fetch 内零查询零直连。
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
            if let Some(ci) = crate::github::http::resolve_confirmed_icon_from_db(
                &db,
                &item.id,
                &item.owner,
                &item.repo,
            ) {
                item.icon = ci;
            } else if !item.icon.trim().is_empty() {
                let mut cycle = crate::db::AppIconCycle::new(&item.id, &item.owner, &item.repo);
                cycle.is_cataloged = false;
                if item.icon.contains("simpleicons.org") {
                    cycle.level = 2;
                    cycle.l2_url = item.icon.clone();
                } else {
                    cycle.level = 4;
                    cycle.l4_url = item.icon.clone();
                }
                cycle.selected_url = item.icon.clone();
                cycle.updated_at = crate::now_secs();
                pending.push(cycle);
            }
            // 与 search_apps_online 同形：TTL 内详情缓存命中且 platforms 非空时 join；空保持 []。
            if let Ok(Some(cached)) = db.get_cached_app_detail(&item.id, Some(ttl_seconds)) {
                if !cached.platforms.is_empty() {
                    item.platforms = cached.platforms;
                }
            }
        }
        if !pending.is_empty() && db.upsert_icon_cycles_batch(&pending).is_err() {
            for c in &pending {
                let _ = db.upsert_icon_cycle(c);
            }
        }
    }

    log::info!(
        "trend enrich done requested={} hits={} elapsed_ms={}",
        requested,
        results.iter().filter(|r| r.is_some()).count(),
        enrich_start.elapsed().as_millis()
    );
    Ok(results)
}
