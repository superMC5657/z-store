use crate::models::{AppDetail, AppSummary, SyncCatalogResult};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn search_apps(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<AppSummary>, String> {
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
                let latest_ver = release_res
                    .map(|r| r.tag_name)
                    .unwrap_or_else(|_| "latest".to_string());
                return Ok(vec![AppSummary {
                    id: coord.to_app_id(),
                    name: repo_info.name,
                    owner: coord.owner,
                    repo: coord.repo,
                    icon: coord.forge.icon().to_string(),
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
                    platforms: vec!["windows".to_string()],
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
                .map(|r| r.app_id.to_lowercase())
                .collect()
        } else {
            std::collections::HashSet::new()
        }
    };

    let results = state
        .catalog
        .search_github_online(&query, token.as_deref())
        .await?;

    if hidden_ids.is_empty() {
        Ok(results)
    } else {
        Ok(results
            .into_iter()
            .filter(|a| !hidden_ids.contains(&a.id.to_lowercase()))
            .collect())
    }
}

pub fn resolve_repo_key(id: &str, catalog: &crate::github::CatalogService) -> String {
    let clean = id.trim().to_lowercase();
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean) {
        return coord.to_repo_key();
    }
    if let Ok(coords) = catalog.get_repo_coordinates(&clean) {
        return format!("github.com/{}/{}", coords.owner, coords.repo).to_lowercase();
    }
    if clean.contains('/') {
        return format!("github.com/{}", clean);
    }
    clean
}

/// FR-8.1：`z-store.toml` 原文获取（SQLite 缓存优先，共用详情 TTL gears；缺失时联网拉取）。
/// 缺失文件 / 非 GitHub 仓库 / 网络异常均返回 None（调用方用仓库数据兜底）。
pub async fn get_store_toml_raw_cached(
    state: &AppState,
    app_id: &str,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let ttl_seconds = {
        if let Ok(db) = state.db.lock() {
            db.get_detail_cache_ttl_minutes() * 60
        } else {
            crate::db::DETAIL_CACHE_TTL_DEFAULT_MINUTES * 60
        }
    };
    if let Ok(db) = state.db.lock() {
        if let Ok(Some(raw)) = db.get_cached_store_meta_raw(app_id, Some(ttl_seconds)) {
            return Some(raw);
        }
    }
    let (host_token, mirror_proxy) = {
        let db_guard = state.db.lock().ok()?;
        let token = db_guard.get_host_token("github.com").ok().flatten();
        let proxy = state.mirror.lock().ok()?.get_proxy_url();
        (token, proxy)
    };
    let raw = crate::store_meta::fetch_store_toml_raw(
        owner,
        repo,
        host_token.as_deref(),
        mirror_proxy.as_deref(),
    )
    .await?;
    if let Ok(db) = state.db.lock() {
        let _ = db.save_cached_store_meta_raw(app_id, &raw);
    }
    Some(raw)
}

/// FR-8.1 / FR-8.3：将 `z-store.toml` 解析产物挂载到应用详情，
/// 并合并 `is_verified`（收录库标记为真，或历史认证通过）。
/// 全程最佳努力：任何失败均保持原详情不变。
pub async fn attach_store_meta(state: &AppState, detail: &mut AppDetail) {
    if !detail.is_verified {
        if let Ok(db) = state.db.lock() {
            if db.is_verified_app(&detail.id).unwrap_or(false) {
                detail.is_verified = true;
            }
        }
    }
    if detail.store_meta.is_some() {
        return;
    }
    let is_github = detail
        .forge
        .as_deref()
        .map(|f| f == "github")
        .unwrap_or(true)
        && detail
            .forge_host
            .as_deref()
            .map(|h| h.contains("github.com"))
            .unwrap_or(true);
    if !is_github {
        return;
    }
    let (app_id, owner, repo) = (
        detail.id.clone(),
        detail.owner.clone(),
        detail.repo.clone(),
    );
    if let Some(raw) = get_store_toml_raw_cached(state, &app_id, &owner, &repo).await {
        if let Ok(meta) = crate::store_meta::parse_store_toml(&raw) {
            // toml 声明的签名指纹可补齐收录库未标注的指纹
            if detail.signature_fingerprint.is_none() {
                if let Some(fp) = meta.store.signature_fingerprint.clone() {
                    if !fp.trim().is_empty() {
                        detail.signature_fingerprint = Some(fp);
                    }
                }
            }
            detail.store_meta = Some(meta);
        }
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
                .map(|r| r.app_id.to_lowercase())
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
                && !hidden_ids.contains(&a.id.to_lowercase())
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
    let clean_id = id.trim().to_string();
    let repo_key = resolve_repo_key(&clean_id, &state.catalog);
    let is_force = force_refresh.unwrap_or(false);

    // 获取客户端设置的应用详情缓存保鲜期 (TTL，单位秒；0 表示每次实时校验)。
    // 非法/缺失挡位由 db 层回退默认 30 分钟（ADR-0007 有效集 {0,10,30,60,360,1440}）。
    let ttl_seconds = {
        if let Ok(db) = state.db.lock() {
            db.get_detail_cache_ttl_minutes() * 60
        } else {
            crate::db::DETAIL_CACHE_TTL_DEFAULT_MINUTES * 60
        }
    };

    // 1. 若非主动强制刷新，优先从 SQLite 本地持久化缓存中读取，实现 0ms 瞬间秒开
    // 注意：锁守卫不得跨越 await（Tauri 命令 Future 需 Send），故查询收拢于闭包内
    if !is_force {
        let cached: Option<AppDetail> = state.db.lock().ok().and_then(|db| {
            db.get_cached_app_detail(&clean_id, Some(ttl_seconds))
                .ok()
                .flatten()
                .or_else(|| {
                    db.get_cached_app_detail(&repo_key, Some(ttl_seconds))
                        .ok()
                        .flatten()
                })
        });
        if let Some(mut cached_detail) = cached {
            cached_detail.id = clean_id.clone();
            if let Some(cat_item) = state.catalog.get_catalog_item(&clean_id) {
                cached_detail.signature_fingerprint = cat_item.publisher_fingerprint;
            }
            attach_store_meta(state, &mut cached_detail).await;
            return Ok(cached_detail);
        }
    }

    // 2. 本地无缓存或用户主动要求强制刷新，执行远程拉取
    // 2.1 多源 (Codeberg, Gitea 等) 穿透解析
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
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
            let mut detail = AppDetail {
                id: clean_id.clone(),
                name: repo_info.name.clone(),
                owner: coord.owner,
                repo: coord.repo,
                icon: coord.forge.icon().to_string(),
                icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
                description: repo_info.description.clone().unwrap_or_default(),
                stars: repo_info.stars,
                forks: repo_info.forks,
                license: "OpenSource".to_string(),
                latest_version: release_info.tag_name,
                changelog: release_info.body.unwrap_or_default(),
                is_verified: false,
                signature_fingerprint: None,
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
                is_stale_fallback: None,
                homepage: repo_info.homepage.clone(),
                platforms: vec!["windows".to_string()],
                store_meta: None,
            };
            attach_store_meta(state, &mut detail).await;

            // 存入 SQLite 本地持久化缓存，并动态更新内存中的收录库统计
            state.catalog.update_catalog_item_stats(
                &clean_id,
                Some(repo_info.stars),
                Some(repo_info.forks),
                Some(&detail.latest_version),
            );

            if let Ok(db) = state.db.lock() {
                let _ = db.save_cached_app_detail(&clean_id, &repo_key, &detail);
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
                        fallback.id = clean_id;
                        fallback.is_stale_fallback = Some(true);
                        return Ok(fallback);
                    }
                    if let Ok(Some(mut fallback)) = db.get_cached_app_detail_fallback(&repo_key) {
                        fallback.id = clean_id;
                        fallback.is_stale_fallback = Some(true);
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
                .or_else(|| db.get_cached_app_detail_fallback(&repo_key).ok().flatten())
        };
        (ep, etag, payload, token, cached_detail)
    };

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
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            detail.cached_at = Some(now);
            // FR-8.1/FR-8.3：挂载 z-store.toml 并合并认证标记（入库前完成，缓存即带元数据）
            attach_store_meta(state, &mut detail).await;

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
                    let _ = db.touch_cached_app_detail(&repo_key, now);
                }
            }

            // 存入 SQLite 本地持久化缓存：若远端解析产物为空但本地已有资产，继承本地资产以防误清空
            if let Ok(db) = state.db.lock() {
                if detail.releases.is_empty() {
                    if let Ok(Some(old)) = db.get_cached_app_detail_fallback(&clean_id) {
                        if !old.releases.is_empty() {
                            detail.releases = old.releases;
                        }
                    }
                }
                let _ = db.save_cached_app_detail(&clean_id, &repo_key, &detail);
            }

            Ok(detail)
        }
        Err(err) => {
            // 网络或限额异常时，优雅降级返回已存储的历史缓存
            if let Ok(db) = state.db.lock() {
                if let Ok(Some(mut fallback_detail)) = db.get_cached_app_detail_fallback(&clean_id) {
                    fallback_detail.id = clean_id;
                    fallback_detail.is_stale_fallback = Some(true);
                    return Ok(fallback_detail);
                }
                if let Ok(Some(mut fallback_detail)) = db.get_cached_app_detail_fallback(&repo_key) {
                    fallback_detail.id = clean_id;
                    fallback_detail.is_stale_fallback = Some(true);
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
                return Ok(SyncCatalogResult {
                    updated: true,
                    count,
                    message: format!(
                        "远程源未就绪，已自动从本地 {} 载入 {} 款应用（本地开发模式）",
                        candidate, count
                    ),
                });
            } else {
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
        Ok(SyncCatalogResult {
            updated: true,
            count,
            message: format!("成功同步收录清单，当前共 {} 个精选应用", count),
        })
    } else {
        let count = state.catalog.get_catalog_count();
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
