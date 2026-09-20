use crate::models::{AppDetail, AppSummary, SyncCatalogResult};
use crate::AppState;
use tauri::State;

/// Derive the platform list from release assets via `installer::classify_asset` OS labels.
///
/// Each asset filename is classified and its OS label collected (sorted, deduplicated;
/// the `"all"` label means unclassifiable and is skipped).
/// An empty derivation yields an explicitly empty vec — there is intentionally NO
/// fallback to `["windows"]`, so Linux-only or Android-containing releases are never
/// mislabeled. How `matchPlatformSet` treats a missing/empty list is out of scope.
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

#[tauri::command]
pub async fn search_apps(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<AppSummary>, String> {
    // Wave2：单次 search_apps 只记一行 INFO `search done`（行为链 sid 关联）；
    // 内层 github/search 的同名 debug 已移除，此处为唯一 `search done`。
    let search_start = std::time::Instant::now();
    // 1. 优先检查是否为多源 (Codeberg, Gitea, 自建源) 仓库 URL 或 short syntax
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&query) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            let host_token = if let Ok(db) = state.db.lock() {
                db.get_host_token(&coord.host).ok().flatten()
            } else {
                None
            };
            if let Ok(repo_info) =
                crate::forge::ForgeRegistry::fetch_repo(&coord, host_token.as_deref()).await
            {
                let release_res =
                    crate::forge::ForgeRegistry::fetch_latest_release(&coord, host_token.as_deref())
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
                return Ok(vec![AppSummary {
                    id: coord.to_app_id(),
                    name: repo_info.name,
                    owner: coord.owner,
                    repo: coord.repo,
                    icon: String::new(),
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
            if let Ok(item) = state
                .catalog
                .fetch_online_repo(&coord.owner, &coord.repo, token.as_deref())
                .await
            {
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
    let hidden_ids: std::collections::HashSet<String> = {
        if let Ok(db) = state.db.lock() {
            db.get_all_rules()
                .unwrap_or_default()
                .into_iter()
                .filter(|r| r.is_hidden)
                .map(|r| r.app_id)
                .collect()
        } else {
            std::collections::HashSet::new()
        }
    };

    let results = state
        .catalog
        .search_github_online(&query, token.as_deref())
        .await?;
    log::info!(
        "search done sid={} query='{}' hits={} elapsed_ms={}",
        crate::z_log::new_session_id(),
        crate::log_support::short_reason(&query),
        results.len(),
        search_start.elapsed().as_millis()
    );

    if hidden_ids.is_empty() {
        Ok(results)
    } else {
        Ok(results
            .into_iter()
            .filter(|a| !hidden_ids.contains(&a.id))
            .collect())
    }
}

#[tauri::command]
pub fn get_category_apps(
    state: State<'_, AppState>,
    category: String,
) -> Result<Vec<AppSummary>, String> {
    let cat_clean = category.trim().to_lowercase();
    let hidden_ids: std::collections::HashSet<String> = {
        if let Ok(db) = state.db.lock() {
            db.get_all_rules()
                .unwrap_or_default()
                .into_iter()
                .filter(|r| r.is_hidden)
                .map(|r| r.app_id)
                .collect()
        } else {
            std::collections::HashSet::new()
        }
    };

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
pub async fn warmup_top_apps(
    _state: State<'_, AppState>,
    _limit: Option<usize>,
) -> Result<usize, String> {
    // 完全移除后台静默预热逻辑，保障用户 API 限额不被后台请求消耗
    Ok(0)
}

#[tauri::command]
pub async fn get_app_details(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> Result<AppDetail, String> {
    get_app_details_impl(&state, id, force_refresh).await
}

pub async fn get_app_details_impl(
    state: &AppState,
    id: String,
    force_refresh: Option<bool>,
) -> Result<AppDetail, String> {
    // ADR-0010：入站 id 统一归一化为 canonical（小写 owner/repo / forge 前缀坐标）；未知标识直接拒绝
    let Some(clean_id) = crate::forge::canonical_app_id(&id) else {
        return Err(format!("无法识别的应用标识: {}", id));
    };
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
        let cached: Option<AppDetail> = state.db.lock().ok().and_then(|db| {
            let ttl_seconds = db.get_detail_cache_ttl_minutes() * 60;
            let mut detail = db
                .get_cached_app_detail(&clean_id, Some(ttl_seconds))
                .ok()
                .flatten()?;
            if !detail.is_verified && db.is_verified_app(&clean_id).unwrap_or(false) {
                detail.is_verified = true;
            }
            Some(detail)
        });
        if let Some(mut cached_detail) = cached {
            cached_detail.id = clean_id.clone();
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
            let host_token = if let Ok(db) = state.db.lock() {
                db.get_host_token(&coord.host).ok().flatten()
            } else {
                None
            };
            let (repo_info, release_info) = tokio::try_join!(
                crate::forge::ForgeRegistry::fetch_repo(&coord, host_token.as_deref()),
                crate::forge::ForgeRegistry::fetch_latest_release(&coord, host_token.as_deref())
            )?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let platforms = platforms_from_assets(&release_info.assets);
            let mut detail = AppDetail {
                id: clean_id.clone(),
                name: repo_info.name.clone(),
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
            if let Ok(db) = state.db.lock() {
                if db.is_verified_app(&detail.id).unwrap_or(false) {
                    detail.is_verified = true;
                }
            }

            // 存入 SQLite 本地持久化缓存，并动态更新内存中的收录库统计
            state.catalog.update_catalog_item_stats(
                &clean_id,
                Some(repo_info.stars),
                Some(repo_info.forks),
                Some(&detail.latest_version),
            );

            if let Ok(db) = state.db.lock() {
                let start_db = std::time::Instant::now();
                log::debug!(
                    "db_save start id={} sid={} req={}",
                    clean_id,
                    sid,
                    req_id
                );
                let _ = db.save_cached_app_detail(&clean_id, &detail);
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
                if let Ok(db) = state.db.lock() {
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
        let db = state.db.lock().map_err(|e| e.to_string())?;
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
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            detail.cached_at = Some(now);
            if !detail.is_verified {
                if let Ok(db) = state.db.lock() {
                    if db.is_verified_app(&detail.id).unwrap_or(false) {
                        detail.is_verified = true;
                    }
                }
            }

            if let Some((etag, payload)) = to_cache {
                // 远端返回 200 OK，更新 ETag 缓存表
                if let Ok(db) = state.db.lock() {
                    let _ = db.save_etag(&release_endpoint, &etag, &payload, now);
                }
            } else {
                // 远端返回 304 Not Modified（to_cache 为 None）
                // 仅刷新 cached_at 时间戳，零配额消耗延长保鲜期
                if let Ok(db) = state.db.lock() {
                    let _ = db.touch_cached_app_detail(&clean_id, now);
                }
            }

            // 存入 SQLite 本地持久化缓存：若远端解析产物为空但本地已有资产，继承本地资产以防误清空
            let start_db = std::time::Instant::now();
            log::debug!(
                "db_save start id={} sid={} req={}",
                clean_id,
                sid,
                req_id
            );
            if let Ok(db) = state.db.lock() {
                if detail.releases.is_empty() {
                    if let Ok(Some(old)) = db.get_cached_app_detail_fallback(&clean_id) {
                        if !old.releases.is_empty() {
                            detail.releases = old.releases;
                        }
                    }
                }
                let _ = db.save_cached_app_detail(&clean_id, &detail);
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
            if let Ok(db) = state.db.lock() {
                if let Ok(Some(mut fallback_detail)) = db.get_cached_app_detail_fallback(&clean_id) {
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
) -> Result<SyncCatalogResult, String> {
    let (url, cached_etag) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let url = db
            .get_setting("catalog_source_url")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty() && !s.contains("gitmirror.com"))
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
                if let Ok((Some(items), _)) = state.catalog.sync_remote_catalog(&path_str, None).await {
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
                log::error!("sync catalog failed url='{}' reason={}", safe_url, crate::log_support::short_reason(&err));
                return Err(err);
            }
        }
    };

    if let Some(items) = new_items {
        let count = items.len();
        if let Some(etag) = new_etag {
            if let Ok(db) = state.db.lock() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                let json_str = serde_json::to_string(&items).unwrap_or_default();
                let _ = db.save_etag(&url, &etag, &json_str, now);
            }
        }
        log::info!("sync catalog done url='{}' updated=true count={}", safe_url, count);
        Ok(SyncCatalogResult {
            updated: true,
            count,
            message: format!("成功同步收录清单，当前共 {} 个精选应用", count),
        })
    } else {
        let count = state.catalog.get_catalog_count();
        log::info!("sync catalog done url='{}' updated=false (up-to-date) count={}", safe_url, count);
        Ok(SyncCatalogResult {
            updated: false,
            count,
            message: format!("收录清单已是最新，共 {} 个应用", count),
        })
    }
}

#[tauri::command]
pub fn get_catalog_count(state: State<'_, AppState>) -> Result<usize, String> {
    Ok(state.catalog.get_catalog_count())
}

#[tauri::command]
pub async fn get_app_readme(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let detail = get_app_details(state, id, None).await?;
    Ok(detail.readme_markdown)
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
}
