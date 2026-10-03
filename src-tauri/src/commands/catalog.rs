use crate::models::{AppDetail, AppSummary, SyncCatalogResult};
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

/// ADR-0008：网络超时统一经 `get_project_config().network.api_timeout_seconds` 获取；
/// 配置为 0（未设置）时回退到调用方传入的历史硬编码值，行为保持不变。
fn api_timeout_or(fallback: std::time::Duration) -> std::time::Duration {
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

/// 通过 `installer::classify_asset` 的操作系统标签，从 Release 产物中推导支持的平台列表。
///
/// 对每个产物文件名进行分类并收集其 OS 标签（有序且去重；
/// `"all"` 标签代表无法明确分类，予以跳过）。
/// 若推导结果为空，则明确返回空向量 —— 此处特意不设置
/// 回退到 `["windows"]` 的兜底，确保仅限 Linux 或包含 Android 的发布版本绝不会被错误标记。
/// 前端 `matchPlatformSet` 如何处理缺失/空列表由前端规则决定。
fn platforms_from_assets(assets: &[crate::models::ReleaseAsset]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for a in assets {
        let (_, os, _) = crate::installer::classify_asset(&a.name);
        if os != "all" {
            set.insert(os.to_string());
        }
    }
    set.into_iter().collect()
}

/// H8：隐藏规则 id 集合（本地收敛 `search_apps` / `get_category_apps` 重复块）。
fn hidden_rule_ids(state: &AppState) -> std::collections::HashSet<String> {
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

#[tauri::command]
pub async fn search_apps(
    state: State<'_, AppState>,
    query: String,
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

    log::info!(
        "search done sid={} query='{}' hits={} elapsed_ms={}",
        crate::z_log::new_session_id(),
        crate::log_support::short_reason(&query),
        filtered.len(),
        search_start.elapsed().as_millis()
    );

    Ok(filtered)
}

#[tauri::command]
pub async fn search_apps_online(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    query: String,
    search_id: Option<String>,
) -> crate::AppResult<Vec<AppSummary>> {
    // Wave2：单次 search_apps 只记一行 INFO `search done`（行为链 sid 关联）；
    // 内层 github/search 的同名 debug 已移除，此处为唯一 `search done`。
    let search_start = std::time::Instant::now();
    let current_gen = SEARCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let actual_search_id = search_id.unwrap_or_else(|| current_gen.to_string());
    // 1. 优先检查是否为多源 (Codeberg, Gitea, 自建源) 仓库 URL 或 short syntax
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&query) {
        if coord.forge != crate::forge::ForgeType::GitHub {
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
                        let plats = platforms_from_assets(&r.assets);
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
            let token = super::resolve_active_github_token(&state);
            if let Ok(mut item) = state
                .catalog
                .fetch_online_repo(&coord.owner, &coord.repo, token.as_deref())
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

    let token = super::resolve_active_github_token(&state);
    let hidden_ids: std::collections::HashSet<String> = hidden_rule_ids(&state);

    let mut results = state
        .catalog
        .search_github_online(&query, token.as_deref())
        .await?;

    if let Ok(db) = state.db() {
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
                let _ = db.upsert_icon_cycle(&cycle);
            }
        }
    }

    let candidates: Vec<(String, String, String)> = results
        .iter()
        .filter(|item| {
            state.catalog.get_catalog_item(&item.id).is_none()
                && !item.icon.contains("simpleicons.org")
        })
        .take(12)
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
            let client = super::icon_http_client();
            // 慢路径鉴权头：有 token 才跑 Trees，无 token 只走快路径。
            let slow_headers = bg_token
                .as_deref()
                .filter(|t| !t.trim().is_empty())
                .map(|t| crate::github::http::token_headers(Some(t)));
            for (id, owner, repo) in candidates {
                let handle = handle.clone();
                let client = client.clone();
                let sid = sid.clone();
                let slow_headers = slow_headers.clone();
                tokio::spawn(async move {
                    // 快慢分离：快路径 SimpleIcons（repo+owner 去重单循环，每 slug 超时与
                    // 外层兜底均经 api_timeout_seconds 统一配置，未设置时回退 1500ms/8000ms 历史值），
                    // 快命中立即落库并 emit，不等慢路径。
                    let fast_url = tokio::time::timeout(
                        api_timeout_or(std::time::Duration::from_millis(8000)),
                        crate::github::icon_probe::probe_simple_icons(&client, &owner, &repo),
                    )
                    .await
                    .ok()
                    .flatten()
                    .map(|h| h.url)
                    .unwrap_or_default();

                    if !fast_url.trim().is_empty() {
                        // 世代比对防串词：若用户在此期间触发了新搜索，抛弃过时探测结果
                        if SEARCH_GEN.load(Ordering::SeqCst) != current_gen {
                            return;
                        }

                        let state = handle.state::<AppState>();
                        if let Ok(db) = state.db() {
                            let mut cycle = crate::db::AppIconCycle::new(&id, &owner, &repo);
                            cycle.is_cataloged = false;
                            cycle.level = 2;
                            cycle.l2_url = fast_url.clone();
                            cycle.selected_url = fast_url.clone();
                            cycle.updated_at = crate::now_secs();
                            let _ = db.upsert_icon_cycle(&cycle);
                        }

                        if SEARCH_GEN.load(Ordering::SeqCst) != current_gen {
                            return;
                        }

                        let payload = SearchIconReadyPayload {
                            search_id: sid.clone(),
                            app_id: id.clone(),
                            icon: fast_url.clone(),
                            level: 2,
                        };
                        let _ = handle.emit("zstore://search-icon-ready", &payload);
                        return;
                    }

                    // 慢路径：快未命中且有 token 才跑 Trees（内部 12s）；超时只弃慢不弃快。
                    if let Some(hdrs) = slow_headers.as_ref() {
                        if let Some(hit) =
                            crate::github::icon_probe::probe_trees(&client, hdrs, &owner, &repo, "main")
                                .await
                        {
                            if SEARCH_GEN.load(Ordering::SeqCst) != current_gen {
                                return;
                            }

                            let state = handle.state::<AppState>();
                            if let Ok(db) = state.db() {
                                let mut cycle = crate::db::AppIconCycle::new(&id, &owner, &repo);
                                cycle.is_cataloged = false;
                                cycle.level = 3;
                                cycle.l3_url = hit.url.clone();
                                cycle.selected_url = hit.url.clone();
                                cycle.updated_at = crate::now_secs();
                                let _ = db.upsert_icon_cycle(&cycle);
                            }

                            if SEARCH_GEN.load(Ordering::SeqCst) != current_gen {
                                return;
                            }

                            let payload = SearchIconReadyPayload {
                                search_id: sid.clone(),
                                app_id: id.clone(),
                                icon: hit.url.clone(),
                                level: 3,
                            };
                            let _ = handle.emit("zstore://search-icon-ready", &payload);
                        }
                    }
                });
            }
        });
    }

    Ok(filtered_results)
}

#[tauri::command]
pub fn get_category_apps(
    state: State<'_, AppState>,
    category: String,
) -> crate::AppResult<Vec<AppSummary>> {
    let cat_clean = category.trim().to_lowercase();
    let hidden_ids: std::collections::HashSet<String> = hidden_rule_ids(&state);

    let all = state.catalog.get_all_summaries();
    let filtered: Vec<AppSummary> = all
        .into_iter()
        .filter(|a| {
            (a.category.to_lowercase() == cat_clean || a.category_name.to_lowercase() == cat_clean)
                && !hidden_ids.contains(&a.id)
        })
        .collect();

    Ok(filtered)
}

#[tauri::command]
pub async fn get_app_details(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<AppDetail> {
    Ok(get_app_details_impl(&state, id, force_refresh).await?)
}

pub async fn get_app_details_impl(
    state: &AppState,
    id: String,
    force_refresh: Option<bool>,
) -> Result<AppDetail, String> {
    // ADR-0010：入站 id 统一归一化为 canonical（小写 owner/repo / forge 前缀坐标）；未知标识直接拒绝
    let clean_id = super::require_app_id(&id)?;
    let is_force = force_refresh.unwrap_or(false);
    let start = std::time::Instant::now();
    // db_save 日志关联用：复用进程级 sid；req 复用线程级（空则新建，仅日志用途，不改并发）。
    let sid = crate::z_log::new_session_id();
    let req_id = {
        let cur = crate::z_log::current_req_id();
        if cur.is_empty() {
            crate::z_log::new_req_id()
        } else {
            cur
        }
    };

    // 1. 若非主动强制刷新，优先从 SQLite 本地持久化缓存中读取，实现 0ms 瞬间秒开
    // 单次临界区完成 TTL + 缓存读取 + verified 标记解析，避免同请求内多次加/解锁；
    // 注意：锁守卫不得跨越 await（Tauri 命令 Future 需 Send），故查询收拢于单闭包内。
    // 后续优化方向：r2d2 连接池（当前仍用全局 Mutex<Database>，见 ADR-0003；无 schema 变更）。
    // 非法/缺失 TTL 挡位由 db 层回退默认 30 分钟（ADR-0007 有效集 {0,10,30,60,360,1440}）。
    if !is_force {
        let cached: Option<AppDetail> = state.db().ok().and_then(|db| {
            let ttl_seconds = db.get_detail_cache_ttl_minutes() * 60;
            let detail = db
                .get_cached_app_detail(&clean_id, Some(ttl_seconds))
                .ok()
                .flatten()?;
            Some(detail)
        });
        if let Some(mut cached_detail) = cached {
            cached_detail.id = clean_id.clone();
            if let Some(cat_item) = state.catalog.get_catalog_item(&clean_id) {
                if cat_item.description_en.is_some() {
                    cached_detail.description_en = cat_item.description_en.clone();
                }
            }
            log::debug!(
                "get_app_details id={} from=cache:db elapsed_ms={}",
                clean_id,
                start.elapsed().as_millis()
            );
            return Ok(cached_detail);
        }
    }

    // 2. 本地无缓存或用户主动要求强制刷新，执行远程拉取
    // 2.1 多源 (Codeberg, Gitea 等) 穿透解析
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            log::debug!(
                "fetch app detail multi-forge id={} host={} forge={:?}",
                clean_id,
                coord.host,
                coord.forge
            );
            let host_token = if let Ok(db) = state.db() {
                db.get_host_token(&coord.host).ok().flatten()
            } else {
                None
            };
            let (repo_info, release_info) = tokio::try_join!(
                crate::forge::ForgeRegistry::fetch_repo(&coord, host_token.as_deref()),
                crate::forge::ForgeRegistry::fetch_latest_release(&coord, host_token.as_deref())
            )?;
            let now = crate::now_secs();
            let platforms = platforms_from_assets(&release_info.assets);
            let detail = AppDetail {
                id: clean_id.clone(),
                name: repo_info.name.clone(),
                description_en: repo_info.description.clone(),
                owner: coord.owner,
                repo: coord.repo,
                icon: String::new(),
                icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
                description: repo_info.description.clone().unwrap_or_default(),
                stars: repo_info.stars,
                forks: repo_info.forks,
                license: "OpenSource".to_string(),
                latest_version: release_info.tag_name,
                changelog: release_info.body.unwrap_or_default(),
                is_verified: false,
                readme_markdown: format!(
                    "# {}\n\n{}",
                    repo_info.name,
                    repo_info.description.unwrap_or_default()
                ),
                releases: release_info.assets,
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                forge: Some(coord.forge.as_str().to_string()),
                forge_host: Some(coord.host),
                cached_at: Some(now),
                is_stale: None,
                homepage: repo_info.homepage.clone(),
                platforms,
            };

            // 存入 SQLite 本地持久化缓存，并动态更新内存中的收录库统计
            state.catalog.update_catalog_item_stats(
                &clean_id,
                Some(repo_info.stars),
                Some(repo_info.forks),
                Some(&detail.latest_version),
            );

            if let Ok(db) = state.db() {
                let start_db = std::time::Instant::now();
                log::debug!("db_save start id={} sid={} req={}", clean_id, sid, req_id);
                let _ = db.save_cached_app_detail(&clean_id, &detail);

                let icon_trimmed = detail.icon.trim();
                let is_avatar = crate::commands::is_avatar_url(icon_trimmed)
                    || (icon_trimmed.starts_with("https://github.com/") && icon_trimmed.ends_with(".png") && !icon_trimmed.contains("/raw/"));
                if !icon_trimmed.is_empty() && !is_avatar {
                    let mut cycle = db
                        .get_icon_cycle(&clean_id)
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| {
                            crate::db::AppIconCycle::new(&clean_id, &detail.owner, &detail.repo)
                        });
                    cycle.is_cataloged = false;
                    cycle.level = 4;
                    cycle.l4_url = icon_trimmed.to_string();
                    cycle.selected_url = icon_trimmed.to_string();
                    cycle.updated_at = crate::now_secs();
                    let _ = db.upsert_icon_cycle(&cycle);
                }
                log::debug!(
                    "db_save done id={} sid={} req={} elapsed_ms={}",
                    clean_id,
                    sid,
                    req_id,
                    start_db.elapsed().as_millis()
                );
            }

            return Ok(detail);
        }
    }

    // 2.2 GitHub 仓库拉取
    let (release_endpoint, cached_etag, cached_payload, token, cached_detail_opt) = {
        let token = super::resolve_active_github_token(state);
        let coords = match state.catalog.get_repo_coordinates(&clean_id) {
            Ok(c) => c,
            Err(e) => {
                if let Ok(db) = state.db() {
                    if let Ok(Some(mut fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                        fallback.id = clean_id.clone();
                        fallback.is_stale = Some(true);
                        log::debug!(
                            "fetch detail fallback id={} cache=stale elapsed_ms={}",
                            clean_id,
                            start.elapsed().as_millis()
                        );
                        return Ok(fallback);
                    }
                }
                return Err(e);
            }
        };
        let ep = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            coords.owner, coords.repo
        );
        let db = state.db()?;
        let (etag, payload) = if is_force {
            (None, None)
        } else {
            let etag = db.get_etag(&ep).ok().flatten();
            let payload = db.get_cached_payload(&ep).ok().flatten();
            (etag, payload)
        };
        let cached_detail = if is_force {
            None
        } else {
            db.get_cached_app_detail_fallback(&clean_id).ok().flatten()
        };
        (ep, etag, payload, token, cached_detail)
    };

    let safe_ep = crate::log_support::sanitize_url(&release_endpoint);
    log::debug!(
        "fetch app detail start id={} url='{}' force={}",
        clean_id,
        safe_ep,
        is_force
    );

    let fetch_result = state
        .catalog
        .fetch_app_detail(
            &clean_id,
            cached_etag,
            cached_payload,
            cached_detail_opt,
            token.as_deref(),
        )
        .await;

    match fetch_result {
        Ok((mut detail, to_cache)) => {
            let cache_type = if to_cache.is_none() { "304" } else { "miss" };
            log::debug!(
                "fetch app detail done id={} url='{}' cache={} elapsed_ms={}",
                clean_id,
                safe_ep,
                cache_type,
                start.elapsed().as_millis()
            );
            let now = crate::now_secs();
            detail.cached_at = Some(now);

            if let Some((etag, payload)) = to_cache {
                // 远端返回 200 OK，更新 ETag 缓存表
                if let Ok(db) = state.db() {
                    let _ = db.save_etag(&release_endpoint, &etag, &payload, now);
                }
            } else {
                // 远端返回 304 Not Modified（to_cache 为 None）
                // 仅刷新 cached_at 时间戳，零配额消耗延长保鲜期
                if let Ok(db) = state.db() {
                    let _ = db.touch_cached_app_detail(&clean_id, now);
                }
            }

            // 存入 SQLite 本地持久化缓存：若远端解析产物为空但本地已有资产，继承本地资产以防误清空
            let start_db = std::time::Instant::now();
            log::debug!("db_save start id={} sid={} req={}", clean_id, sid, req_id);
            if let Ok(db) = state.db() {
                if detail.releases.is_empty() {
                    if let Ok(Some(old)) = db.get_cached_app_detail_fallback(&clean_id) {
                        if !old.releases.is_empty() {
                            detail.releases = old.releases;
                        }
                    }
                }
                let _ = db.save_cached_app_detail(&clean_id, &detail);

                let icon_trimmed = detail.icon.trim();
                let is_avatar = crate::commands::is_avatar_url(icon_trimmed)
                    || (icon_trimmed.starts_with("https://github.com/") && icon_trimmed.ends_with(".png") && !icon_trimmed.contains("/raw/"));
                if !icon_trimmed.is_empty() && !is_avatar {
                    let level = if icon_trimmed.contains("simpleicons.org") {
                        2
                    } else if icon_trimmed.contains("/blob/") || icon_trimmed.to_lowercase().contains("readme") {
                        4
                    } else {
                        3
                    };

                    let mut cycle = db
                        .get_icon_cycle(&clean_id)
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| {
                            crate::db::AppIconCycle::new(&clean_id, &detail.owner, &detail.repo)
                        });

                    cycle.is_cataloged = state.catalog.get_catalog_item(&clean_id).is_some();
                    cycle.level = level;
                    if level == 3 {
                        cycle.l3_url = icon_trimmed.to_string();
                    } else if level == 4 {
                        cycle.l4_url = icon_trimmed.to_string();
                    } else if level == 2 {
                        cycle.l2_url = icon_trimmed.to_string();
                    }
                    cycle.selected_url = icon_trimmed.to_string();
                    cycle.updated_at = now;
                    let _ = db.upsert_icon_cycle(&cycle);
                }
            }
            log::debug!(
                "db_save done id={} sid={} req={} elapsed_ms={}",
                clean_id,
                sid,
                req_id,
                start_db.elapsed().as_millis()
            );

            Ok(detail)
        }
        Err(err) => {
            log::warn!(
                "fetch app detail failed id={} url='{}' reason={}",
                clean_id,
                safe_ep,
                crate::log_support::short_reason(&err)
            );
            // 网络或限额异常时，优雅降级返回已存储的历史缓存
            if let Ok(db) = state.db() {
                if let Ok(Some(mut fallback_detail)) = db.get_cached_app_detail_fallback(&clean_id)
                {
                    fallback_detail.id = clean_id.clone();
                    fallback_detail.is_stale = Some(true);
                    log::debug!(
                        "fetch app detail fallback id={} from=cache:stale elapsed_ms={}",
                        clean_id,
                        start.elapsed().as_millis()
                    );
                    return Ok(fallback_detail);
                }
            }
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn sync_catalog(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> crate::AppResult<SyncCatalogResult> {
    let (url, cached_etag) = {
        let db = state.db()?;
        let url = db
            .get_setting("catalog_source_url")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                crate::config::get_project_config()
                    .catalog
                    .default_source_url
                    .clone()
            });
        let is_force = force.unwrap_or(false);
        let etag = if is_force {
            None
        } else {
            db.get_etag(&url).ok().flatten()
        };
        (url, etag)
    };

    let safe_url = crate::log_support::sanitize_url(&url);
    let is_force = force.unwrap_or(false);
    log::info!("sync catalog start url='{}' force={}", safe_url, is_force);

    let res = state
        .catalog
        .sync_remote_catalog(&url, cached_etag.as_deref())
        .await;

    let (new_items, new_etag) = match res {
        Ok(val) => val,
        Err(err) => {
            // 如果请求远程失败且为默认或远程链接，检测本地配置的 catalog.json 路径作为无缝备选
            let mut local_fallback = None;
            let cfg = crate::config::get_project_config();
            if let Some(resolved_path) = cfg.catalog.resolve_local_path() {
                let path_str = resolved_path.to_string_lossy().to_string();
                if let Ok((Some(items), _)) =
                    state.catalog.sync_remote_catalog(&path_str, None).await
                {
                    local_fallback = Some((items, path_str));
                }
            }

            if let Some((items, candidate)) = local_fallback {
                let count = items.len();
                log::warn!(
                    "sync catalog remote failed url='{}' reason={}, fallback to local path='{}' count={}",
                    safe_url,
                    crate::log_support::short_reason(&err),
                    candidate,
                    count
                );
                return Ok(SyncCatalogResult {
                    updated: true,
                    count,
                    message: format!(
                        "远程源未就绪，已自动从本地 {} 载入 {} 款应用（本地开发模式）",
                        candidate, count
                    ),
                });
            } else {
                log::error!(
                    "sync catalog failed url='{}' reason={}",
                    safe_url,
                    crate::log_support::short_reason(&err)
                );
                return Err(err.into());
            }
        }
    };

    if let Some(items) = new_items {
        let count = items.len();
        if let Some(etag) = new_etag {
            if let Ok(db) = state.db() {
                let now = crate::now_secs();
                let json_str = serde_json::to_string(&items).unwrap_or_default();
                let _ = db.save_etag(&url, &etag, &json_str, now);
            }
        }
        log::info!(
            "sync catalog done url='{}' updated=true count={}",
            safe_url,
            count
        );
        Ok(SyncCatalogResult {
            updated: true,
            count,
            message: format!("成功同步收录清单，当前共 {} 个精选应用", count),
        })
    } else {
        let count = state.catalog.get_catalog_count();
        log::info!(
            "sync catalog done url='{}' updated=false (up-to-date) count={}",
            safe_url,
            count
        );
        Ok(SyncCatalogResult {
            updated: false,
            count,
            message: format!("收录清单已是最新，共 {} 个应用", count),
        })
    }
}

#[tauri::command]
pub fn get_catalog_count(state: State<'_, AppState>) -> crate::AppResult<usize> {
    Ok(state.catalog.get_catalog_count())
}

#[cfg(test)]
mod catalog_platform_tests {
    use super::platforms_from_assets;
    use crate::models::ReleaseAsset;

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            download_url: String::new(),
            size_bytes: 0,
            sha256: None,
            os: String::new(),
            arch: String::new(),
            kind: String::new(),
        }
    }

    #[test]
    fn linux_only_release_must_not_be_labeled_windows() {
        let assets = vec![asset("app-1.0_amd64.deb"), asset("app-1.0.AppImage")];
        let plats = platforms_from_assets(&assets);
        assert_eq!(plats, vec!["linux".to_string()]);
        assert!(!plats.contains(&"windows".to_string()));
    }

    #[test]
    fn android_containing_release_derives_android_without_windows_fallback() {
        let assets = vec![asset("app-1.0.apk"), asset("app-1.0_amd64.deb")];
        let plats = platforms_from_assets(&assets);
        assert!(plats.contains(&"android".to_string()));
        assert!(plats.contains(&"linux".to_string()));
        assert!(!plats.contains(&"windows".to_string()));
    }

    #[test]
    fn empty_assets_yield_explicit_empty_vec() {
        let plats: Vec<String> = platforms_from_assets(&[]);
        assert!(plats.is_empty());
    }

    #[test]
    fn unknown_only_assets_yield_explicit_empty_vec() {
        let assets = vec![asset("checksums-sha256.txt")];
        let plats = platforms_from_assets(&assets);
        assert!(plats.is_empty());
    }

    #[test]
    fn test_confirmed_icon_enrichment_logic() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let app_id = "testowner/testrepo";
        let icons_dir = crate::get_app_data_dir().join("icons");
        let _ = std::fs::create_dir_all(&icons_dir);
        let test_filename = "testowner_testrepo_l2.png";
        let test_file_path = icons_dir.join(test_filename);
        let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4";
        std::fs::write(&test_file_path, png_bytes).unwrap();

        let cycle = crate::db::AppIconCycle {
            app_id: app_id.to_string(),
            owner: "testowner".to_string(),
            repo: "testrepo".to_string(),
            level: 2,
            selected_url: "https://example.com/icon.png".to_string(),
            cache_file: test_filename.to_string(),
            ..Default::default()
        };
        db.upsert_icon_cycle(&cycle).unwrap();

        let mut summary = crate::models::AppSummary {
            id: app_id.to_string(),
            name: "testrepo".to_string(),
            description_en: None,
            owner: "testowner".to_string(),
            repo: "testrepo".to_string(),
            icon: String::new(),
            icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
            description: "A test project".to_string(),
            stars: 10,
            forks: 2,
            license: "MIT".to_string(),
            latest_version: "1.0.0".to_string(),
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            is_verified: false,
            is_installed: None,
            has_update: None,
            installed_version: None,
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            homepage: None,
            platforms: vec!["windows".to_string()],
        };

        if let Some(ci) = crate::github::http::resolve_confirmed_icon_from_db(
            &db,
            &summary.id,
            &summary.owner,
            &summary.repo,
        ) {
            summary.icon = ci;
        }

        assert!(summary.icon.starts_with("data:image/png;base64,"));

        let _ = std::fs::remove_file(&test_file_path);
    }
}
