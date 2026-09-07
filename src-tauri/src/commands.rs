use crate::installer::InstallerEngine;
use crate::models::{
    AppDetail, AppSummary, DeepLinkAction, DeveloperProfile, DevicePollResult, HostRateLimitStatus,
    HostTokenEntry, ImportUserDataResult, InstalledApp, MirrorNodeStatus, StarredSyncResult,
    UpdateItem, UpdateRule, WatchUpdatedPayload, WatchedApp,
};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

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
                }]);
            }
        } else if query.starts_with("http://")
            || query.starts_with("https://")
            || query.starts_with("gh:")
            || query.starts_with("github:")
        {
            let token = {
                let t = state.github_token.lock().map_err(|e| e.to_string())?;
                t.clone()
            };
            if let Ok(item) = state
                .catalog
                .fetch_online_repo(&coord.owner, &coord.repo, token.as_deref())
                .await
            {
                return Ok(vec![item]);
            }
        }
    }

    let token = {
        let t = state.github_token.lock().map_err(|e| e.to_string())?;
        t.clone()
    };
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
async fn get_store_toml_raw_cached(
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
async fn attach_store_meta(state: &AppState, detail: &mut AppDetail) {
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
    let (release_endpoint, cached_etag, cached_payload, token) = {
        let token = state
            .github_token
            .lock()
            .map_err(|e| e.to_string())?
            .clone();
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
        (ep, etag, payload, token)
    };

    let fetch_result = state
        .catalog
        .fetch_app_detail(&clean_id, cached_etag, cached_payload, token.as_deref())
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
) -> Result<crate::models::SyncCatalogResult, String> {
    let (url, cached_etag) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let url = db
            .get_setting("catalog_source_url")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty() && !s.contains("gitmirror.com"))
            .unwrap_or_else(|| {
                "https://gh-proxy.com/https://raw.githubusercontent.com/supermc/z-store/main/src-tauri/src/catalog.json"
                    .to_string()
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
            // 如果请求远程失败且为默认或远程链接，检测本地开发目录是否存在 catalog.json 作为无缝备选
            let mut local_fallback = None;
            let local_candidates = [
                "catalog.json",
                "../catalog.json",
                "src-tauri/src/catalog.json",
            ];
            for candidate in &local_candidates {
                if std::path::Path::new(candidate).exists() {
                    if let Ok((Some(items), _)) = state.catalog.sync_remote_catalog(candidate, None).await {
                        local_fallback = Some((items, *candidate));
                        break;
                    }
                }
            }

            if let Some((items, candidate)) = local_fallback {
                let count = items.len();
                return Ok(crate::models::SyncCatalogResult {
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
        Ok(crate::models::SyncCatalogResult {
            updated: true,
            count,
            message: format!("成功同步收录清单，当前共 {} 个精选应用", count),
        })
    } else {
        let count = state.catalog.get_catalog_count();
        Ok(crate::models::SyncCatalogResult {
            updated: false,
            count,
            message: format!("收录清单已是最新，共 {} 个应用", count),
        })
    }
}

#[tauri::command]
pub fn get_installed_apps(state: State<'_, AppState>) -> Result<Vec<InstalledApp>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut apps = db.get_installed_apps().map_err(|e| e.to_string())?;

    let mut needs_db_update = Vec::new();
    for app in &mut apps {
        let is_empty = app.install_path.trim().is_empty();
        let not_exist = !is_empty && !std::path::Path::new(&app.install_path).exists();
        if is_empty || not_exist {
            if let Some(repaired_path) = crate::scanner::AppScanner::resolve_installed_app_path(
                &app.app_name,
                &app.app_id,
                None,
            ) {
                app.install_path = repaired_path.clone();
                if app.uninstall_command.is_none() {
                    app.uninstall_command = resolve_uninstaller_command(
                        &app.app_name,
                        &app.app_id,
                        &repaired_path,
                        None,
                    );
                }
                needs_db_update.push(app.clone());
            }
        }
    }

    for updated in needs_db_update {
        let _ = db.save_installed_app(&updated);
    }

    Ok(apps)
}

/// 根据当前系统平台（Windows / macOS / Linux）与 CPU 架构（x86_64 / aarch64）智能择取最优安装包资产
pub fn select_best_asset(
    assets: &[crate::models::ReleaseAsset],
) -> Option<&crate::models::ReleaseAsset> {
    #[cfg(target_os = "windows")]
    let target_os = "windows";
    #[cfg(target_os = "macos")]
    let target_os = "macos";
    #[cfg(target_os = "linux")]
    let target_os = "linux";
    #[cfg(target_os = "android")]
    let target_os = "android";
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    let target_os = "all";

    #[cfg(target_arch = "x86_64")]
    let target_arch = "x86_64";
    #[cfg(target_arch = "aarch64")]
    let target_arch = "aarch64";
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    let target_arch = "universal";

    let os_matches: Vec<&crate::models::ReleaseAsset> = assets
        .iter()
        .filter(|a| a.os == target_os || a.os == "all")
        .collect();

    let candidates = if os_matches.is_empty() {
        assets.iter().collect::<Vec<&crate::models::ReleaseAsset>>()
    } else {
        os_matches
    };

    candidates.into_iter().max_by_key(|a| {
        let mut score: i32 = 0;
        if a.os == target_os {
            score += 100;
        }
        if a.arch == target_arch {
            score += 50;
        } else if a.arch == "universal" {
            score += 25;
        } else if target_arch == "x86_64" && a.arch == "x86" {
            score += 10;
        } else {
            score -= 50;
        }

        #[cfg(target_os = "windows")]
        match a.kind.as_str() {
            "msi" => score += 20,
            "setup_exe" => score += 15,
            "portable_zip" => score += 10,
            _ => {}
        }

        #[cfg(target_os = "macos")]
        match a.kind.as_str() {
            "dmg" => score += 20,
            "pkg" => score += 15,
            "portable_zip" => score += 10,
            _ => {}
        }

        #[cfg(target_os = "linux")]
        match a.kind.as_str() {
            "appimage" => score += 20,
            "deb" => score += 15,
            "rpm" => score += 12,
            "portable_zip" => score += 10,
            _ => {}
        }

        score
    })
}

#[tauri::command]
pub async fn install_app(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    asset_name: Option<String>,
    custom_install_dir: Option<String>,
) -> Result<InstalledApp, String> {
    // 读取用户配置（自定义下载路径、绿色便携根路径）
    let (custom_download_dir, custom_portable_dir) = {
        if let Ok(db) = state.db.lock() {
            let dl = db.get_setting("download_dir").ok().flatten().and_then(|s| {
                let t = s.trim();
                if !t.is_empty() {
                    Some(crate::installer::expand_env_path(t))
                } else {
                    None
                }
            });
            let port = db.get_setting("portable_dir").ok().flatten().and_then(|s| {
                let t = s.trim().to_string();
                if !t.is_empty() {
                    Some(t)
                } else {
                    None
                }
            });
            (dl, port)
        } else {
            (None, None)
        }
    };

    // 1. 获取应用详情与择取匹配资产（支持前端主动指定 asset_name，若未指定则按当前架构自适应择优）
    let mut detail = get_app_details(state.clone(), app_id.clone(), None).await?;
    if let Some(cat_item) = state.catalog.get_catalog_item(&app_id) {
        detail.signature_fingerprint = cat_item.publisher_fingerprint;
    }

    let selected_asset = if let Some(ref target_name) = asset_name {
        detail.releases.iter().find(|r| &r.name == target_name)
    } else {
        None
    };

    let asset = selected_asset
        .or_else(|| select_best_asset(&detail.releases))
        .ok_or_else(|| "该 Release 未提供匹配当前操作系统的安装包资产".to_string())?;

    // 2. 获取加速下载重写地址
    let rewritten_url = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.rewrite_download_url(&asset.download_url)
    };

    // 3. 执行流式下载与 SHA-256 完整性防篡改强校验
    let download_res = InstallerEngine::download_with_progress(
        &app_handle,
        &app_id,
        &rewritten_url,
        &asset.name,
        asset.sha256.as_deref(),
        custom_download_dir.as_deref(),
    )
    .await;

    // 若直连下载失败且当前为 GitHub 官方链接，尝试自动切换备用加速镜像进行重试
    let (dest_path, actual_sha256) = match download_res {
        Ok(ok) => ok,
        Err(e) => {
            let is_github = asset.download_url.contains("github.com");
            let is_direct = rewritten_url == asset.download_url;
            if is_github && is_direct {
                let fallback_url = format!("https://gh-proxy.com/{}", asset.download_url);
                let _ = app_handle.emit(
                    "zstore://download-progress",
                    crate::models::DownloadProgressPayload {
                        task_id: app_id.clone(),
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        speed_bytes_per_sec: 0,
                        state: "downloading".to_string(),
                        message: Some("直连通道不稳定，正在切换公共加速镜像自动重试...".to_string()),
                    },
                );
                InstallerEngine::download_with_progress(
                    &app_handle,
                    &app_id,
                    &fallback_url,
                    &asset.name,
                    asset.sha256.as_deref(),
                    custom_download_dir.as_deref(),
                )
                .await
                .map_err(|fallback_err| {
                    format!("下载失败（直连: {}；镜像重试: {}）", e, fallback_err)
                })?
            } else {
                return Err(e);
            }
        }
    };

    // 3.5. 增强防御：Windows Authenticode 签名与发布者证书指纹校验 (Feature C)
    #[cfg(target_os = "windows")]
    {
        let is_windows_binary = asset.name.to_lowercase().ends_with(".exe")
            || asset.name.to_lowercase().ends_with(".msi");
        if is_windows_binary {
            if let Some(ref expected_fp) = detail.signature_fingerprint {
                let trimmed = expected_fp.trim();
                if !trimmed.is_empty() {
                    let sig_info = crate::verifier::AuthenticodeVerifier::extract_signature(&dest_path)
                        .map_err(|e| {
                            let _ = std::fs::remove_file(&dest_path);
                            format!("安全拦截：无法提取安装包 Authenticode 数字签名信息（{}），已中止安装", e)
                        })?;
                    if let Err(mismatch_err) = crate::verifier::AuthenticodeVerifier::verify_fingerprint(&sig_info, trimmed) {
                        // 证书指纹不符或无效签名（疑似供应链投毒或替换），销毁临时文件并强行阻断
                        let _ = std::fs::remove_file(&dest_path);
                        return Err(mismatch_err);
                    }
                }
            }
        }
    }

    // 4. 调用原生安装器或解压便携版（优先使用用户在前端主动选择的目录）
    let (kind, _, _) = InstallerEngine::classify_asset(&asset.name);
    let effective_portable_dir = custom_install_dir.or(custom_portable_dir);
    let _install_note = InstallerEngine::execute_installation(
        &dest_path,
        &kind,
        &detail.id,
        effective_portable_dir.as_deref(),
    )?;

    // 智能解析真实安装路径，避免存入临时安装包路径
    let mut real_install_path = match kind {
        crate::installer::AssetKind::PortableZip => {
            let app_dir = crate::installer::dirs_or_fallback_with_base(
                &detail.id,
                effective_portable_dir.as_deref(),
            );
            crate::scanner::AppScanner::resolve_executable_path(
                Some(&app_dir.to_string_lossy()),
                None,
                &detail.repo,
            )
            .unwrap_or_else(|| app_dir.to_string_lossy().to_string())
        }
        _ => crate::scanner::AppScanner::resolve_installed_app_path(
            &detail.name,
            &detail.id,
            Some(&detail.repo),
        )
        .unwrap_or_default(),
    };

    // 针对外部向导安装，若未立即捕获路径，进行短暂重试嗅探 (最多 3 次，每次 500ms)
    if real_install_path.is_empty() && kind != crate::installer::AssetKind::PortableZip {
        for _ in 0..3 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Some(p) = crate::scanner::AppScanner::resolve_installed_app_path(
                &detail.name,
                &detail.id,
                Some(&detail.repo),
            ) {
                real_install_path = p;
                break;
            }
        }
    }

    let resolved_uninst = resolve_uninstaller_command(
        &detail.name,
        &detail.id,
        &real_install_path,
        None,
    );

    // 5. 写入本地 SQLite 持久化
    let installed_app = InstalledApp {
        app_id: detail.id.clone(),
        app_name: detail.name.clone(),
        version: detail.latest_version.clone(),
        installed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        install_method: asset.kind.clone(),
        install_path: real_install_path,
        asset_name: asset.name.clone(),
        asset_sha256: actual_sha256,
        uninstall_command: resolved_uninst,
    };

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.save_installed_app(&installed_app)
            .map_err(|e| e.to_string())?;
    }

    // 仅便携版 (PortableZip) 在此处同步清理临时安装包；MSI 与 SetupExe 已由后台守护线程在安装进程退出后安全移除
    if kind == crate::installer::AssetKind::PortableZip && dest_path.is_file() {
        let _ = std::fs::remove_file(&dest_path);
    }

    Ok(installed_app)
}

pub fn resolve_uninstaller_command(
    app_name: &str,
    app_id: &str,
    install_path: &str,
    existing_command: Option<&str>,
) -> Option<String> {
    // 1. 如果已有明确且有效的卸载指令（非向导提示文案）
    if let Some(cmd) = existing_command {
        let trimmed = cmd.trim();
        if !trimmed.is_empty()
            && !trimmed.contains("已调起")
            && !trimmed.contains("跳过")
            && !trimmed.contains("非 Windows")
            && !trimmed.contains("已解压至")
        {
            return Some(trimmed.to_string());
        }
    }

    // 2. Windows 平台：动态查询注册表中的 UninstallString
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let targets = [
            (
                HKEY_LOCAL_MACHINE,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
        ];

        let name_lower = app_name.to_lowercase();
        let id_lower = app_id.to_lowercase();
        let clean_id = id_lower.replace(['-', '_', '.'], "");

        for (hive, subpath) in targets {
            let root = RegKey::predef(hive);
            if let Ok(uninstall_key) = root.open_subkey(subpath) {
                for key_name in uninstall_key.enum_keys().map_while(Result::ok) {
                    if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                        let display_name: String = app_key
                            .get_value::<String, _>("DisplayName")
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                        let disp_lower = display_name.to_lowercase();

                        let matched = !disp_lower.is_empty()
                            && (disp_lower == name_lower
                                || disp_lower == id_lower
                                || disp_lower.contains(&name_lower)
                                || name_lower.contains(&disp_lower)
                                || (!clean_id.is_empty()
                                    && disp_lower.replace(['-', '_', '.'], "").contains(&clean_id)));

                        if matched {
                            if let Ok(uninst) = app_key.get_value::<String, _>("UninstallString") {
                                let trimmed_uninst = uninst.trim().to_string();
                                if !trimmed_uninst.is_empty() {
                                    return Some(trimmed_uninst);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. 检查安装目录中的标准卸载程序
        let p = std::path::Path::new(install_path);
        let base_dir = if p.is_file() {
            p.parent()
        } else if p.is_dir() {
            Some(p)
        } else {
            None
        };

        if let Some(dir) = base_dir {
            let candidates = [
                "uninstall.exe",
                "Uninstall.exe",
                "unins000.exe",
                "unins001.exe",
                "uninst.exe",
            ];
            for c in candidates {
                let candidate_path = dir.join(c);
                if candidate_path.is_file() {
                    return Some(format!("\"{}\"", candidate_path.to_string_lossy()));
                }
            }
        }

        // 4. 检查开始菜单程序组中的卸载快捷方式
        let start_menu_candidates = [
            std::env::var("APPDATA")
                .ok()
                .map(|p| std::path::PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs").join(app_name)),
            Some(
                std::path::PathBuf::from(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs")
                    .join(app_name),
            ),
        ];

        for sdir_opt in start_menu_candidates.into_iter().flatten() {
            if sdir_opt.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&sdir_opt) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let fname = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                        if fname.contains("uninstall") && fname.ends_with(".lnk") {
                            return Some(format!("\"{}\"", path.to_string_lossy()));
                        }
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
pub fn uninstall_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let installed_app = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.app_id == app_id)
    };

    if let Some(app) = installed_app {
        // 动态探测与获取真实有效的卸载程序（注册表 UninstallString、卸载向导 exe 或开始菜单快捷方式）
        let resolved_uninst = resolve_uninstaller_command(
            &app.app_name,
            &app.app_id,
            &app.install_path,
            app.uninstall_command.as_deref(),
        );

        if let Some(cmd_str) = resolved_uninst {
            #[cfg(target_os = "windows")]
            {
                let lower = cmd_str.to_lowercase();
                if lower.starts_with("msiexec") {
                    let _ = std::process::Command::new("cmd")
                        .args(["/C", &cmd_str])
                        .spawn();
                } else if cmd_str.ends_with(".lnk\"") || cmd_str.ends_with(".lnk") {
                    let clean = cmd_str.trim_matches('"');
                    let _ = std::process::Command::new("cmd")
                        .args(["/C", "start", "", clean])
                        .spawn();
                } else {
                    let _ = std::process::Command::new("cmd")
                        .args(["/C", &cmd_str])
                        .spawn();
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("sh")
                    .args(["-c", &cmd_str])
                    .spawn();
            }
        }

        // 便携版清理：移除安装目录与释放的文件
        if app.install_method == "portable_zip" {
            let path = std::path::Path::new(&app.install_path);
            let dir = if path.is_file() {
                path.parent()
            } else if path.is_dir() {
                Some(path)
            } else {
                None
            };
            if let Some(d) = dir {
                let d_str = d.to_string_lossy().to_lowercase();
                if !d_str.ends_with("program files")
                    && !d_str.ends_with("windows")
                    && !d_str.ends_with("users")
                    && !d_str.ends_with("desktop")
                    && d.exists()
                {
                    let _ = std::fs::remove_dir_all(d);
                }
            }
        }

        // 默认便携缓存目录清理
        let app_dir = crate::installer::dirs_or_fallback(&app.app_id);
        if app_dir.exists() {
            let _ = std::fs::remove_dir_all(&app_dir);
        }

        // 快捷方式清理
        #[cfg(target_os = "windows")]
        {
            let desktop = std::env::var("USERPROFILE")
                .map(|p| std::path::PathBuf::from(p).join("Desktop"))
                .unwrap_or_else(|_| std::path::PathBuf::from("C:\\Users\\Public\\Desktop"));
            let lnk = desktop.join(format!("{}.lnk", app.app_name));
            if lnk.exists() {
                let _ = std::fs::remove_file(lnk);
            }
        }

        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.remove_installed_app(&app_id).map_err(|e| e.to_string())
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn unmanage_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_installed_app(&app_id).map_err(|e| e.to_string())
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

        if let Ok(detail) = get_app_details(state.clone(), app.app_id.clone(), force_refresh).await {
            if should_include_update(&app.version, &detail.latest_version, rule_opt) {
                updates.push(UpdateItem {
                    app_id: app.app_id,
                    app_name: app.app_name,
                    current_version: app.version,
                    latest_version: detail.latest_version,
                    changelog: detail.changelog,
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

#[tauri::command]
pub fn verify_file_signature(file_path: String) -> Result<crate::verifier::SignatureInfo, String> {
    let p = std::path::Path::new(&file_path);
    crate::verifier::AuthenticodeVerifier::extract_signature(p)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyTestResult {
    pub success: bool,
    pub latency_ms: u32,
    pub message: String,
}

#[tauri::command]
pub async fn test_proxy(proxy_url: Option<String>) -> Result<ProxyTestResult, String> {
    let (success, latency_ms, message) =
        crate::mirror::MirrorManager::test_proxy_latency(proxy_url.as_deref()).await;
    Ok(ProxyTestResult {
        success,
        latency_ms,
        message,
    })
}

#[tauri::command]
pub fn get_mirror_status(state: State<'_, AppState>) -> Result<Vec<MirrorNodeStatus>, String> {
    let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    Ok(mirror.get_mirror_statuses())
}

#[tauri::command]
pub fn switch_mirror(state: State<'_, AppState>, mirror_id: String) -> Result<bool, String> {
    let mut mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    let ok = mirror.set_active_mirror(&mirror_id);
    if ok {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let _ = db.set_setting("active_mirror", &mirror_id);
    }
    Ok(ok)
}

#[tauri::command]
pub async fn ping_mirrors(state: State<'_, AppState>) -> Result<Vec<MirrorNodeStatus>, String> {
    let proxy = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.get_proxy_url()
    };
    let (_success, latency, _msg) =
        crate::mirror::MirrorManager::test_proxy_latency(proxy.as_deref()).await;
    let mut statuses = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.get_mirror_statuses()
    };
    for s in &mut statuses {
        if s.is_active {
            s.latency_ms = latency;
        }
    }
    Ok(statuses)
}

#[tauri::command]
pub fn set_github_token(state: State<'_, AppState>, token: String) -> Result<bool, String> {
    let tok_opt = if token.trim().is_empty() {
        None
    } else {
        Some(token.trim().to_string())
    };
    {
        let mut t = state.github_token.lock().map_err(|e| e.to_string())?;
        *t = tok_opt.clone();
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let _ = db.set_setting("github_token", tok_opt.as_deref().unwrap_or(""));
    Ok(true)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut map = db.get_all_settings().map_err(|e| e.to_string())?;
    if let Some(url) = map.get("catalog_source_url") {
        if url.contains("gitmirror.com") {
            map.insert(
                "catalog_source_url".to_string(),
                "https://gh-proxy.com/https://raw.githubusercontent.com/supermc/z-store/main/src-tauri/src/catalog.json".to_string(),
            );
        }
    }
    Ok(map)
}

#[cfg(target_os = "windows")]
pub fn sync_launch_on_startup(enabled: bool) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_path = std::path::Path::new("Software")
        .join("Microsoft")
        .join("Windows")
        .join("CurrentVersion")
        .join("Run");

    if let Ok((key, _)) = hkcu.create_subkey_with_flags(&run_path, KEY_ALL_ACCESS) {
        if enabled {
            if let Ok(exe_path) = std::env::current_exe() {
                let cmd = format!("\"{}\"", exe_path.to_string_lossy());
                let _ = key.set_value("ZStore", &cmd);
            }
        } else {
            let _ = key.delete_value("ZStore");
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sync_launch_on_startup(_enabled: bool) {}

#[tauri::command]
pub fn save_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // TTL 挡位归一化：非法值回退默认 30，保证库中只存 ADR-0007 有效集 {0,10,30,60,360,1440}
    let value = if key == "detail_cache_ttl_minutes" {
        let parsed = value
            .trim()
            .parse::<i64>()
            .unwrap_or(crate::db::DETAIL_CACHE_TTL_DEFAULT_MINUTES);
        crate::db::normalize_detail_cache_ttl(parsed).to_string()
    } else if key == "watch_notify_frequency" {
        // FR-6.2：非法频率回退默认 daily，保证库中只存 {startup, daily}
        crate::db::normalize_watch_notify_frequency(&value)
    } else {
        value
    };
    db.set_setting(&key, &value).map_err(|e| e.to_string())?;

    if key == "launch_on_startup" {
        let enabled = value == "true" || value == "1";
        sync_launch_on_startup(enabled);
    }

    Ok(true)
}

#[tauri::command]
pub async fn select_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("选择解压安装目录（免安装便携版）");
        if let Some(ref path_str) = default_path {
            let expanded = crate::installer::expand_env_path(path_str);
            if expanded.exists() {
                dialog = dialog.set_directory(&expanded);
            }
        }
        let folder = dialog.pick_folder();
        folder.map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

        result.push(BASE64_ALPHABET[(b0 >> 2) as usize] as char);
        result.push(BASE64_ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            result.push(BASE64_ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(BASE64_ALPHABET[(b2 & 0x3f) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

fn detect_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"<?xml") || bytes.starts_with(b"<svg") {
        "image/svg+xml"
    } else if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        "image/x-icon"
    } else {
        "image/png"
    }
}

/// 图标缓存文件名消毒：仅保留字母数字及 `-`/`_`，用于构造本地图标缓存文件名。
/// 消毒后为空时，调用方回退到基于 remote_url 的 SHA-256 哈希命名（见 icon_hash_filename）。
pub fn sanitize_icon_segment(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

fn icon_hash_filename(remote_url: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(remote_url.as_bytes());
    let hash = hex::encode(hasher.finalize());
    format!("{}.png", &hash[..16])
}

pub fn get_icon_cache_path(
    owner: Option<&str>,
    repo: Option<&str>,
    app_id: Option<&str>,
    remote_url: &str,
) -> std::path::PathBuf {
    let icons_dir = crate::get_app_data_dir().join("icons");

    // 方案一：优先使用 GitHub 唯一命名空间 {owner}_{repo}.png
    let filename = match (owner, repo) {
        (Some(o), Some(r)) => {
            let safe_o = sanitize_icon_segment(o);
            let safe_r = sanitize_icon_segment(r);
            if !safe_o.is_empty() && !safe_r.is_empty() {
                format!("{}_{}.png", safe_o, safe_r)
            } else if let Some(id) = app_id {
                format!("{}.png", sanitize_icon_segment(id))
            } else {
                icon_hash_filename(remote_url)
            }
        }
        _ => {
            if let Some(id) = app_id {
                let clean_id = id.trim();
                // 支持类似 "owner/repo" 或 "owner_repo" 格式的 app_id
                if clean_id.contains('/') {
                    let parts: Vec<&str> = clean_id.split('/').collect();
                    if parts.len() == 2 {
                        let safe_o = sanitize_icon_segment(parts[0]);
                        let safe_r = sanitize_icon_segment(parts[1]);
                        if !safe_o.is_empty() && !safe_r.is_empty() {
                            return icons_dir.join(format!("{}_{}.png", safe_o, safe_r));
                        }
                    }
                }
                let safe_id = sanitize_icon_segment(clean_id);
                if !safe_id.is_empty() {
                    format!("{}.png", safe_id)
                } else {
                    icon_hash_filename(remote_url)
                }
            } else {
                icon_hash_filename(remote_url)
            }
        }
    };
    icons_dir.join(filename)
}

#[tauri::command]
pub async fn get_or_fetch_icon(
    state: State<'_, AppState>,
    owner: Option<String>,
    repo: Option<String>,
    app_id: Option<String>,
    remote_url: String,
) -> Result<String, String> {
    let url_trimmed = remote_url.trim();
    if url_trimmed.is_empty() {
        return Err("图标链接不能为空".to_string());
    }

    if url_trimmed.starts_with("data:") {
        return Ok(url_trimmed.to_string());
    }

    let icons_dir = crate::get_app_data_dir().join("icons");
    if !icons_dir.exists() {
        let _ = std::fs::create_dir_all(&icons_dir);
    }

    // 优先使用传入的 (owner, repo)；若未显式传入，在应用目录清单中尝试根据 app_id 查找
    let (resolved_owner, resolved_repo) = match (owner.as_deref(), repo.as_deref()) {
        (Some(o), Some(r)) if !o.trim().is_empty() && !r.trim().is_empty() => {
            (Some(o.trim().to_string()), Some(r.trim().to_string()))
        }
        _ => {
            if let Some(id) = app_id.as_deref() {
                let items = state.catalog.get_catalog_items();
                if let Some(item) = items
                    .iter()
                    .find(|i| i.id.eq_ignore_ascii_case(id) || format!("{}/{}", i.owner, i.repo).eq_ignore_ascii_case(id))
                {
                    (Some(item.owner.clone()), Some(item.repo.clone()))
                } else {
                    (owner, repo)
                }
            } else {
                (owner, repo)
            }
        }
    };

    let cache_file = get_icon_cache_path(
        resolved_owner.as_deref(),
        resolved_repo.as_deref(),
        app_id.as_deref(),
        url_trimmed,
    );

    // 1. 严格优先查找本地内部缓存！缓存有直接读取，绝不发出任何网络请求！
    if cache_file.is_file() {
        if let Ok(meta) = std::fs::metadata(&cache_file) {
            if meta.len() > 0 {
                if let Ok(bytes) = std::fs::read(&cache_file) {
                    let mime = detect_image_mime(&bytes);
                    let b64 = base64_encode(&bytes);
                    return Ok(format!("data:{};base64,{}", mime, b64));
                }
            }
        }
    }

    // 2. 本地缓存找不到，才去外部链接拉取
    // 注意：GitHub 官方头像链接 (github.com/*.png 与 avatars.githubusercontent.com)
    // 属于用户头像与全球 CDN 资源，GH-Proxy 等镜像节点会对其直接拦截并返回 403 Forbidden。
    // 因此对于头像类链接直接直连全球 CDN；对于其他资源优先尝试镜像，若失败自动降级直连。
    let is_avatar_url = url_trimmed.contains("github.com/") && url_trimmed.ends_with(".png")
        || url_trimmed.contains("avatars.githubusercontent.com")
        || url_trimmed.contains("identicons.github.com");

    let mut candidate_urls = Vec::new();
    if !is_avatar_url {
        if let Ok(mirror) = state.mirror.lock() {
            let rewritten = mirror.rewrite_download_url(url_trimmed);
            if rewritten != url_trimmed {
                candidate_urls.push(rewritten);
            }
        }
    }
    candidate_urls.push(url_trimmed.to_string());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut fetched_bytes = None;
    let mut last_err = String::new();

    for url in candidate_urls {
        match client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes().await {
                        if !bytes.is_empty() {
                            fetched_bytes = Some(bytes);
                            break;
                        }
                    }
                } else {
                    last_err = format!("HTTP 状态码: {}", resp.status());
                }
            }
            Err(e) => {
                last_err = format!("请求失败: {}", e);
            }
        }
    }

    let bytes = fetched_bytes.ok_or_else(|| {
        format!("拉取远程图标失败 ({}): {}", url_trimmed, last_err)
    })?;

    // 3. 缓存在用户的配置目录里 (icons/)
    let _ = std::fs::write(&cache_file, &bytes);

    let mime = detect_image_mime(&bytes);
    let b64 = base64_encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
pub fn get_favorites(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_favorites().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.toggle_favorite(&app_id).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn scan_and_match_local_apps(
    state: State<'_, AppState>,
) -> Result<Vec<crate::scanner::AppMatchResult>, String> {
    let scanned = crate::scanner::AppScanner::scan_system_apps();
    let catalog_items = state.catalog.get_catalog_items();

    let installed_ids: std::collections::HashSet<String> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .unwrap_or_default()
            .into_iter()
            .map(|a| a.app_id.to_lowercase())
            .collect()
    };

    let matches = crate::scanner::AppScanner::match_apps(&scanned, &catalog_items);
    let unmanaged_matches = matches
        .into_iter()
        .filter(|m| !installed_ids.contains(&m.catalog_id.to_lowercase()))
        .collect();

    Ok(unmanaged_matches)
}

#[tauri::command]
pub fn import_matched_apps(
    state: State<'_, AppState>,
    apps: Vec<crate::scanner::ImportAppRequest>,
) -> Result<usize, String> {
    let mut imported_count = 0;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let db = state.db.lock().map_err(|e| e.to_string())?;

    for req in apps {
        let installed = InstalledApp {
            app_id: req.app_id,
            app_name: req.app_name,
            version: req.version,
            installed_at: now,
            install_method: "system_import".to_string(),
            install_path: req.install_path.unwrap_or_default(),
            asset_name: "system_detected".to_string(),
            asset_sha256: "system_verified".to_string(),
            uninstall_command: req.uninstall_command,
        };

        if db.save_installed_app(&installed).is_ok() {
            imported_count += 1;
        }
    }

    Ok(imported_count)
}

static DETECTED_APP_IDS_CACHE: std::sync::RwLock<Option<(std::time::Instant, Vec<String>)>> =
    std::sync::RwLock::new(None);

#[tauri::command]
pub async fn get_detected_installed_app_ids(
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> Result<Vec<String>, String> {
    let force = force_refresh.unwrap_or(false);
    if !force {
        if let Ok(guard) = DETECTED_APP_IDS_CACHE.read() {
            if let Some((instant, ref ids)) = *guard {
                if instant.elapsed().as_secs() < 120 {
                    return Ok(ids.clone());
                }
            }
        }
    }

    let catalog_items = state.catalog.get_catalog_items();
    let detected: Vec<String> = tokio::task::spawn_blocking(move || {
        let mut detected = Vec::new();
        for cat in &catalog_items {
            if crate::scanner::AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo)).is_some() {
                detected.push(cat.id.clone());
            }
        }
        detected
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        *guard = Some((std::time::Instant::now(), detected.clone()));
    }

    Ok(detected)
}

#[tauri::command]
pub fn import_single_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let cat = state
        .catalog
        .get_catalog_items()
        .into_iter()
        .find(|c| c.id.eq_ignore_ascii_case(&app_id))
        .ok_or_else(|| format!("Catalog 中未收录该应用: {}", app_id))?;

    let resolved_path = crate::scanner::AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo));

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let installed = InstalledApp {
        app_id: cat.id,
        app_name: cat.name,
        version: cat.default_version,
        installed_at: now,
        install_method: "system_import".to_string(),
        install_path: resolved_path.unwrap_or_default(),
        asset_name: "system_detected".to_string(),
        asset_sha256: "system_verified".to_string(),
        uninstall_command: None,
    };

    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_installed_app(&installed).map_err(|e| e.to_string())?;

    // 纳管后让探测缓存也包含该 ID
    if let Ok(mut guard) = DETECTED_APP_IDS_CACHE.write() {
        if let Some((_, ref mut ids)) = *guard {
            if !ids.iter().any(|id| id.eq_ignore_ascii_case(&installed.app_id)) {
                ids.push(installed.app_id.clone());
            }
        }
    }

    Ok(true)
}

#[tauri::command]
pub fn launch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let installed_app_opt = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.app_id.eq_ignore_ascii_case(&app_id))
    };

    let (app_name, target_path, catalog_repo) = if let Some(ref app) = installed_app_opt {
        (
            app.app_name.clone(),
            app.install_path.trim().trim_matches('"').to_string(),
            None,
        )
    } else {
        let cat = state
            .catalog
            .get_catalog_items()
            .into_iter()
            .find(|c| c.id.eq_ignore_ascii_case(&app_id));
        if let Some(c) = cat {
            let p = crate::scanner::AppScanner::resolve_installed_app_path(&c.name, &c.id, Some(&c.repo))
                .unwrap_or_default();
            (c.name, p, Some(c.repo))
        } else {
            return Err(format!("未找到已安装或纳管的应用: {}", app_id));
        }
    };

    let path_obj = std::path::Path::new(&target_path);

    // 检查是否为临时下载目录中的安装包（避免误重新调起安装向导）
    let is_temp_installer = target_path.to_lowercase().contains("zstore_downloads")
        || target_path.to_lowercase().contains(r"\temp\")
        || target_path.to_lowercase().ends_with("-setup.exe")
        || target_path.to_lowercase().ends_with("_setup.exe")
        || target_path.to_lowercase().ends_with("-installer.exe");

    // 1. 如果路径本身是存在的可执行文件或快捷方式/应用包，且并非临时下载安装包
    if !is_temp_installer {
        #[cfg(target_os = "macos")]
        if path_obj.exists() && ((path_obj.is_dir() && target_path.ends_with(".app")) || path_obj.is_file()) {
            std::process::Command::new("open")
                .arg(&target_path)
                .spawn()
                .map_err(|e| format!("启动 macOS 应用程序失败: {}", e))?;
            return Ok(true);
        }

        if path_obj.is_file() {
            let ext = path_obj
                .extension()
                .map_or("", |e| e.to_str().unwrap_or(""));
            if ext.eq_ignore_ascii_case("lnk") {
                #[cfg(target_os = "windows")]
                {
                    std::process::Command::new("explorer.exe")
                        .arg(&target_path)
                        .spawn()
                        .map_err(|e| format!("调起快捷方式失败: {}", e))?;
                    return Ok(true);
                }
            } else if ext.eq_ignore_ascii_case("exe") {
                let parent = path_obj
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new("."));
                std::process::Command::new(path_obj)
                    .current_dir(parent)
                    .spawn()
                    .map_err(|e| format!("启动应用程序失败: {}", e))?;
                return Ok(true);
            } else {
                #[cfg(target_os = "linux")]
                {
                    let _ = std::process::Command::new("chmod").arg("+x").arg(path_obj).status();
                    let parent = path_obj
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new("."));
                    std::process::Command::new(path_obj)
                        .current_dir(parent)
                        .spawn()
                        .map_err(|e| format!("启动 Linux 应用程序失败: {}", e))?;
                    return Ok(true);
                }
            }
        }
    }

    // 2. 检查安装路径是否为目录或无效，调用全源智能嗅探器寻找真正的 exe
    let candidate_exe = crate::scanner::AppScanner::resolve_installed_app_path(
        &app_name,
        &app_id,
        catalog_repo.as_deref(),
    )
    .or_else(|| {
        crate::scanner::AppScanner::resolve_executable_path(
            if target_path.is_empty() {
                None
            } else {
                Some(&target_path)
            },
            None,
            &app_name,
        )
    });

    if let Some(exe_str) = candidate_exe {
        let exe_path = std::path::Path::new(&exe_str);
        if exe_path.is_file() {
            let parent = exe_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            std::process::Command::new(exe_path)
                .current_dir(parent)
                .spawn()
                .map_err(|e| format!("启动应用程序失败: {}", e))?;

            // 如果该应用已被纳管，自动将探测到的真实物理路径写回数据库，加速下次启动
            if let Some(mut updated) = installed_app_opt {
                if target_path != exe_str {
                    if let Ok(db) = state.db.lock() {
                        updated.install_path = exe_str;
                        let _ = db.save_installed_app(&updated);
                    }
                }
            }

            return Ok(true);
        }
    }

    // 3. 检查便携应用目录 ~/AppData/Local/Programs/z-store-apps/<app_id>/
    let portable_dir = crate::installer::dirs_or_fallback(&app_id);
    if portable_dir.is_dir() {
        if let Some(exe_str) = crate::scanner::AppScanner::resolve_executable_path(
            Some(&portable_dir.to_string_lossy()),
            None,
            &app_name,
        ) {
            let exe_path = std::path::Path::new(&exe_str);
            if exe_path.is_file() {
                let parent = exe_path
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new("."));
                std::process::Command::new(exe_path)
                    .current_dir(parent)
                    .spawn()
                    .map_err(|e| format!("启动便携版失败: {}", e))?;
                return Ok(true);
            }
        }
    }

    // 4. 在 Windows 桌面查找同名快捷方式
    #[cfg(target_os = "windows")]
    {
        let desktop = std::env::var("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join("Desktop"))
            .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Users\Public\Desktop"));

        let candidate_lnks = [
            desktop.join(format!("{}.lnk", app_name)),
            desktop.join(format!("{}.lnk", app_id)),
        ];

        for lnk in candidate_lnks {
            if lnk.is_file() {
                std::process::Command::new("explorer.exe")
                    .arg(lnk.to_string_lossy().to_string())
                    .spawn()
                    .map_err(|e| format!("通过快捷方式启动失败: {}", e))?;
                return Ok(true);
            }
        }
    }

    Err(format!(
        "未能定位到该软件的可执行程序。\n记录路径: {}\n建议检查软件是否已被重命名或迁移，或重新纳管。",
        if target_path.is_empty() { "无" } else { &target_path }
    ))
}

#[tauri::command]
pub async fn get_developer_profile(
    state: State<'_, AppState>,
    developer: String,
) -> Result<DeveloperProfile, String> {
    let token = state
        .github_token
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    state
        .catalog
        .fetch_developer_profile(&developer, token.as_deref())
        .await
}

#[tauri::command]
pub async fn sync_github_starred(
    state: State<'_, AppState>,
    username: Option<String>,
) -> Result<StarredSyncResult, String> {
    let token = state
        .github_token
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    state
        .catalog
        .sync_starred_repos(username.as_deref(), token.as_deref())
        .await
}

#[tauri::command]
pub fn record_search_query(state: State<'_, AppState>, query: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.record_search_query(&query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_search_history(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_search_history().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_search_history(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_search_history().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_search_query(state: State<'_, AppState>, query: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_search_query(&query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_app_view(state: State<'_, AppState>, app_id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.record_app_view(&app_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recently_viewed_apps(state: State<'_, AppState>) -> Result<Vec<AppSummary>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ids = db.get_recently_viewed_app_ids().map_err(|e| e.to_string())?;
    let catalog_items = state.catalog.get_catalog_items();
    let mut result = Vec::new();

    for id in ids {
        if let Some(item) = catalog_items.iter().find(|i| i.id.eq_ignore_ascii_case(&id)) {
            result.push(item.to_summary());
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn clear_view_history(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_view_history().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_host_tokens(state: State<'_, AppState>) -> Result<Vec<HostTokenEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_host_tokens().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_host_token(
    state: State<'_, AppState>,
    host: String,
    token: String,
) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.set_host_token(&host, &token).map_err(|e| e.to_string())?;
    }
    if host.eq_ignore_ascii_case("github.com") {
        let clean_tok = token.trim().to_string();
        {
            let mut t = state.github_token.lock().map_err(|e| e.to_string())?;
            *t = if clean_tok.is_empty() {
                None
            } else {
                Some(clean_tok.clone())
            };
        }
        let tok_opt = if clean_tok.is_empty() {
            None
        } else {
            Some(clean_tok.as_str())
        };
        crate::probe_github_rate_limit(tok_opt).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_host_token(state: State<'_, AppState>, host: String) -> Result<(), String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.remove_host_token(&host).map_err(|e| e.to_string())?;
    }
    if host.eq_ignore_ascii_case("github.com") {
        {
            let mut t = state.github_token.lock().map_err(|e| e.to_string())?;
            *t = None;
        }
        crate::probe_github_rate_limit(None).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn refresh_host_rate_limit(
    state: State<'_, AppState>,
    host: Option<String>,
) -> Result<HostTokenEntry, String> {
    let clean_host = host
        .unwrap_or_else(|| "github.com".to_string())
        .trim()
        .to_lowercase();
    let token = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_host_token(&clean_host).ok().flatten()
    };
    if clean_host.contains("github.com") {
        crate::probe_github_rate_limit(token.as_deref()).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let tokens = db.get_host_tokens().map_err(|e| e.to_string())?;
    if let Some(entry) = tokens.into_iter().find(|t| t.host.eq_ignore_ascii_case(&clean_host)) {
        Ok(entry)
    } else {
        Ok(HostTokenEntry {
            host: clean_host,
            token: token.unwrap_or_default(),
            rate_limit_remaining: None,
            rate_limit_limit: None,
            rate_limit_reset: None,
            updated_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
        })
    }
}

#[tauri::command]
pub async fn test_host_connection(
    state: State<'_, AppState>,
    host: String,
    token: Option<String>,
) -> Result<HostRateLimitStatus, String> {
    let clean_host = host.trim().to_lowercase();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    let effective_token = if let Some(ref tok) = token {
        if !tok.trim().is_empty() {
            Some(tok.trim().to_string())
        } else {
            None
        }
    } else if let Ok(db) = state.db.lock() {
        db.get_host_token(&clean_host).ok().flatten()
    } else {
        None
    };

    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("ZStore-Client/0.1.0"),
    );

    if clean_host.contains("github.com") {
        if let Some(ref tok) = effective_token {
            if let Ok(v) =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", tok))
            {
                headers.insert(reqwest::header::AUTHORIZATION, v);
            }
        }
        let url = "https://api.github.com/rate_limit";
        match client.get(url).headers(headers).send().await {
            Ok(resp) if resp.status().is_success() => {
                crate::notify_rate_limit(&clean_host, resp.headers());
                #[derive(serde::Deserialize)]
                struct GhRate {
                    rate: GhRateDetail,
                }
                #[derive(serde::Deserialize)]
                struct GhRateDetail {
                    limit: u32,
                    remaining: u32,
                }
                let rate_data: Option<GhRate> = resp.json().await.ok();
                let remaining = rate_data.as_ref().map(|r| r.rate.remaining);
                let limit = rate_data.as_ref().map(|r| r.rate.limit);

                Ok(HostRateLimitStatus {
                    host: clean_host,
                    is_connected: true,
                    rate_limit_remaining: remaining,
                    rate_limit_limit: limit,
                    message: Some("连接 GitHub API 成功".to_string()),
                })
            }
            Ok(resp) => Ok(HostRateLimitStatus {
                host: clean_host,
                is_connected: false,
                rate_limit_remaining: None,
                rate_limit_limit: None,
                message: Some(format!("HTTP 状态码: {}", resp.status())),
            }),
            Err(e) => Ok(HostRateLimitStatus {
                host: clean_host,
                is_connected: false,
                rate_limit_remaining: None,
                rate_limit_limit: None,
                message: Some(format!("网络请求失败: {}", e)),
            }),
        }
    } else {
        // Gitea / Codeberg / 自建实例
        if let Some(ref tok) = effective_token {
            if let Ok(v) =
                reqwest::header::HeaderValue::from_str(&format!("token {}", tok))
            {
                headers.insert(reqwest::header::AUTHORIZATION, v);
            }
        }
        let url = format!("https://{}/api/v1/version", clean_host);
        match client.get(&url).headers(headers).send().await {
            Ok(resp) if resp.status().is_success() => {
                crate::notify_rate_limit(&clean_host, resp.headers());
                let remaining = resp
                    .headers()
                    .get("x-ratelimit-remaining")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u32>().ok())
                    .or(Some(5000));
                let limit = resp
                    .headers()
                    .get("x-ratelimit-limit")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u32>().ok())
                    .or(Some(5000));

                Ok(HostRateLimitStatus {
                    host: clean_host,
                    is_connected: true,
                    rate_limit_remaining: remaining,
                    rate_limit_limit: limit,
                    message: Some("连接 Gitea/Codeberg API 成功".to_string()),
                })
            }
            Ok(resp) => Ok(HostRateLimitStatus {
                host: clean_host,
                is_connected: false,
                rate_limit_remaining: None,
                rate_limit_limit: None,
                message: Some(format!("HTTP 状态码: {}", resp.status())),
            }),
            Err(e) => Ok(HostRateLimitStatus {
                host: clean_host,
                is_connected: false,
                rate_limit_remaining: None,
                rate_limit_limit: None,
                message: Some(format!("连接超时或失败: {}", e)),
            }),
        }
    }
}

/// 设置出站代理（登录与 API 直连共用）：校验 → 落库 → 即时生效（进程 env，无需重启）。
/// 空字符串表示清空，回退系统代理/直连。
#[tauri::command]
pub fn set_forward_proxy(state: State<'_, AppState>, url: String) -> Result<bool, String> {
    let normalized = crate::normalize_forward_proxy(&url)?;
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.set_setting(
            crate::FORWARD_PROXY_SETTING,
            normalized.as_deref().unwrap_or(""),
        )
        .map_err(|e| e.to_string())?;
    }
    crate::apply_forward_proxy_env(normalized.as_deref());
    Ok(true)
}

/// 测试出站代理：经指定代理 GET api.github.com/rate_limit，返回连通性与延迟。
/// 空输入表示测试直连/系统代理。地址非法直接返回 Err（前端红字提示）。
#[tauri::command]
pub async fn test_forward_proxy(proxy_url: String) -> Result<ProxyTestResult, String> {
    let normalized = crate::normalize_forward_proxy(&proxy_url)?;
    let via = normalized
        .as_deref()
        .unwrap_or("直连/系统代理")
        .to_string();
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8));
    if let Some(ref u) = normalized {
        let proxy = reqwest::Proxy::all(u).map_err(|e| format!("代理不可用：{}", e))?;
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    match client
        .get("https://api.github.com/rate_limit")
        .header(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_static("ZStore-Client/0.1.0"),
        )
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => Ok(ProxyTestResult {
            success: true,
            latency_ms: start.elapsed().as_millis() as u32,
            message: format!(
                "{} ms（经 {} 连接正常）",
                start.elapsed().as_millis(),
                via
            ),
        }),
        Ok(resp) => Ok(ProxyTestResult {
            success: false,
            latency_ms: start.elapsed().as_millis() as u32,
            message: format!("HTTP 状态码: {}（经 {}）", resp.status(), via),
        }),
        Err(e) => Ok(ProxyTestResult {
            success: false,
            latency_ms: 8000,
            message: format!("连接失败（经 {}）：{}", via, e),
        }),
    }
}

#[tauri::command]
pub fn register_deep_link_scheme() -> Result<bool, String> {
    crate::deeplink::register_windows_protocol()
}

#[tauri::command]
pub fn handle_deep_link(url: String) -> Result<DeepLinkAction, String> {
    crate::deeplink::DeepLinkParser::parse(&url)
        .ok_or_else(|| format!("无法识别的 Z-Store 深度链接: {}", url))
}

#[tauri::command]
pub fn get_cli_deep_link() -> Option<String> {
    for arg in std::env::args().skip(1) {
        let lower = arg.to_lowercase();
        if lower.starts_with("zstore://") {
            return Some(arg);
        }
    }
    None
}

#[tauri::command]
pub async fn search_forge_repos(
    state: State<'_, AppState>,
    forge: String,
    host: Option<String>,
    query: String,
) -> Result<Vec<crate::forge::ForgeRepoInfo>, String> {
    let forge_type = match forge.to_lowercase().as_str() {
        "codeberg" => crate::forge::ForgeType::Codeberg,
        "gitea" | "forgejo" => crate::forge::ForgeType::Gitea,
        "gitlab" => crate::forge::ForgeType::GitLab,
        _ => crate::forge::ForgeType::GitHub,
    };
    let target_host = host.as_deref().unwrap_or_else(|| forge_type.default_host());
    let token = if let Ok(db) = state.db.lock() {
        db.get_host_token(target_host).ok().flatten()
    } else {
        None
    };

    crate::forge::ForgeRegistry::search_repos(forge_type, Some(target_host), &query, token.as_deref()).await
}

#[tauri::command]
pub fn open_url(url: String) -> Result<bool, String> {
    let clean = url.trim();
    if !clean.starts_with("http://") && !clean.starts_with("https://") {
        return Err("仅支持打开 http/https 协议的安全链接".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", clean])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("无法调起系统默认浏览器: {}", e))?;
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(clean)
            .spawn()
            .map_err(|e| format!("无法调起系统默认浏览器: {}", e))?;
        Ok(true)
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(clean)
            .spawn()
            .map_err(|e| format!("无法调起系统默认浏览器: {}", e))?;
        Ok(true)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("当前操作系统不支持调起外部浏览器".to_string())
    }
}

// ---------- FR-8.3 所有权认证 ----------

/// 官方所有权认证（MVP）：校验码原文出现在仓库 README 或 `z-store.toml`
/// 内容中即通过；通过后持久化，`is_verified` 经合并规则在详情中生效。
#[tauri::command]
pub async fn verify_ownership(
    state: State<'_, AppState>,
    app_id: String,
    code: String,
) -> Result<bool, String> {
    let clean_id = app_id.trim().to_string();
    if clean_id.is_empty() {
        return Err("应用 ID 不能为空".to_string());
    }
    let needle = code.trim().to_string();
    if needle.is_empty() {
        return Ok(false);
    }

    // 1. 精选收录库已标记认证
    if let Some(item) = state.catalog.get_catalog_item(&clean_id) {
        if item.is_verified {
            return Ok(true);
        }
    }
    // 2. 历史认证通过
    if let Ok(db) = state.db.lock() {
        if db.is_verified_app(&clean_id).unwrap_or(false) {
            return Ok(true);
        }
    }
    // 3. 仓库坐标（MVP 仅支持 GitHub 仓库）
    let coords = state
        .catalog
        .get_repo_coordinates(&clean_id)
        .map_err(|_| format!("仅支持 GitHub 仓库的所有权校验: {}", clean_id))?;

    // 4. README 复用应用详情链路；toml 原文走缓存优先
    let readme = get_app_details_impl(&state, clean_id.clone(), None)
        .await
        .map(|d| d.readme_markdown)
        .unwrap_or_default();
    let toml_raw =
        get_store_toml_raw_cached(&state, &clean_id, &coords.owner, &coords.repo).await;
    let passed =
        crate::store_meta::is_verified_by_code(&readme, toml_raw.as_deref(), &needle);
    if passed {
        if let Ok(db) = state.db.lock() {
            let _ = db.mark_verified_app(&clean_id);
        }
    }
    Ok(passed)
}

// ---------- FR-6.2 关注订阅 ----------

#[tauri::command]
pub fn watch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let id = app_id.trim();
    if id.is_empty() {
        return Err("应用 ID 不能为空".to_string());
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.watch_app(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unwatch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.unwatch_app(app_id.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_watched_apps(state: State<'_, AppState>) -> Result<Vec<WatchedApp>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_watched_apps().map_err(|e| e.to_string())
}

// ---------- FR-7.1/FR-7.2 GitHub OAuth Device Flow + Star ----------

fn resolve_oauth_client_id_from_db(state: &AppState) -> String {
    let override_id = state
        .db
        .lock()
        .ok()
        .and_then(|db| db.get_setting(crate::oauth::SETTING_OAUTH_CLIENT_ID).ok().flatten());
    crate::oauth::resolve_oauth_client_id(override_id.as_deref())
}

/// 写操作令牌：OAuth 令牌优先，`github.com` 主机令牌（PAT）兜底。
fn resolve_write_token(state: &AppState) -> Option<String> {
    let db = state.db.lock().ok()?;
    if let Ok(Some(t)) = db.get_setting(crate::oauth::SETTING_OAUTH_TOKEN) {
        if !t.trim().is_empty() {
            return Some(t.trim().to_string());
        }
    }
    db.get_host_token("github.com").ok().flatten()
}

/// 开始 Device Flow：返回用户验证码与浏览器授权地址（前端展示二维码/链接并轮询）。
#[tauri::command]
pub async fn oauth_device_start(
    state: State<'_, AppState>,
) -> Result<crate::oauth::DeviceStartResult, String> {
    let client_id = resolve_oauth_client_id_from_db(&state);
    if client_id.trim().is_empty() || client_id == crate::oauth::OAUTH_CLIENT_ID_PLACEHOLDER {
        return Err(
            "尚未配置 GitHub OAuth Client ID，请在「设置」中填写后重试".to_string(),
        );
    }
    crate::oauth::request_device_code(&client_id).await
}

/// 轮询 Device Flow 授权结果（前端按返回 `interval` 节流调用）。
/// `pending` 继续轮询；`authorized` 已持久化令牌+用户；`error` 停止并提示。
#[tauri::command]
pub async fn oauth_device_poll(
    state: State<'_, AppState>,
    device_code: String,
) -> Result<DevicePollResult, String> {
    let code = device_code.trim().to_string();
    if code.is_empty() {
        return Err("设备验证码不能为空".to_string());
    }
    let client_id = resolve_oauth_client_id_from_db(&state);
    match crate::oauth::poll_device_once(&client_id, &code).await? {
        crate::oauth::DevicePollOutcome::Authorized { access_token } => {
            let user = crate::oauth::fetch_oauth_user(&access_token).await.ok();
            if let Ok(db) = state.db.lock() {
                let _ = db.set_setting(crate::oauth::SETTING_OAUTH_TOKEN, access_token.trim());
                if let Some(u) = user {
                    if let Ok(json) = serde_json::to_string(&u) {
                        let _ = db.set_setting(crate::oauth::SETTING_OAUTH_USER, &json);
                    }
                }
            }
            Ok(DevicePollResult {
                status: "authorized".to_string(),
                message: None,
            })
        }
        crate::oauth::DevicePollOutcome::Pending { message } => Ok(DevicePollResult {
            status: "pending".to_string(),
            message: Some(message),
        }),
        crate::oauth::DevicePollOutcome::Expired { message } => Ok(DevicePollResult {
            status: "expired".to_string(),
            message: Some(message),
        }),
        crate::oauth::DevicePollOutcome::Denied { message } => Ok(DevicePollResult {
            status: "denied".to_string(),
            message: Some(message),
        }),
        crate::oauth::DevicePollOutcome::Error { message } => Ok(DevicePollResult {
            status: "error".to_string(),
            message: Some(message),
        }),
    }
}

/// 当前 OAuth 登录用户；未登录返回 null。
#[tauri::command]
pub async fn get_oauth_user(
    state: State<'_, AppState>,
) -> Result<Option<crate::oauth::OAuthUser>, String> {
    let stored: Option<crate::oauth::OAuthUser> = state
        .db
        .lock()
        .ok()
        .and_then(|db| db.get_setting(crate::oauth::SETTING_OAUTH_USER).ok().flatten())
        .filter(|s| !s.trim().is_empty())
        .and_then(|json| serde_json::from_str::<crate::oauth::OAuthUser>(&json).ok());
    if stored.is_some() {
        return Ok(stored);
    }
    // 有令牌但缺用户快照时实时补拉一次
    let token = resolve_write_token(&state);
    let is_oauth = state
        .db
        .lock()
        .ok()
        .and_then(|db| db.get_setting(crate::oauth::SETTING_OAUTH_TOKEN).ok().flatten())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if is_oauth {
        if let Some(t) = token {
            if let Ok(user) = crate::oauth::fetch_oauth_user(&t).await {
                if let Ok(db) = state.db.lock() {
                    if let Ok(json) = serde_json::to_string(&user) {
                        let _ = db.set_setting(crate::oauth::SETTING_OAUTH_USER, &json);
                    }
                }
                return Ok(Some(user));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn oauth_logout(state: State<'_, AppState>) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_setting(crate::oauth::SETTING_OAUTH_TOKEN)
        .map_err(|e| e.to_string())?;
    db.remove_setting(crate::oauth::SETTING_OAUTH_USER)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn star_app(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
) -> Result<bool, String> {
    if owner.trim().is_empty() || repo.trim().is_empty() {
        return Err("仓库 owner 与 repo 不能为空".to_string());
    }
    let token = resolve_write_token(&state)
        .ok_or_else(|| "请先完成 GitHub 登录，或在「设置」中配置个人访问令牌 (PAT)".to_string())?;
    crate::oauth::star_repo(&token, owner.trim(), repo.trim())
        .await
        .map(|_| true)
}

#[tauri::command]
pub async fn unstar_app(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
) -> Result<bool, String> {
    if owner.trim().is_empty() || repo.trim().is_empty() {
        return Err("仓库 owner 与 repo 不能为空".to_string());
    }
    let token = resolve_write_token(&state)
        .ok_or_else(|| "请先完成 GitHub 登录，或在「设置」中配置个人访问令牌 (PAT)".to_string())?;
    crate::oauth::unstar_repo(&token, owner.trim(), repo.trim())
        .await
        .map(|_| true)
}

#[tauri::command]
pub async fn is_starred(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
) -> Result<bool, String> {
    if owner.trim().is_empty() || repo.trim().is_empty() {
        return Err("仓库 owner 与 repo 不能为空".to_string());
    }
    let token = resolve_write_token(&state)
        .ok_or_else(|| "请先完成 GitHub 登录，或在「设置」中配置个人访问令牌 (PAT)".to_string())?;
    crate::oauth::check_starred(&token, owner.trim(), repo.trim()).await
}

// ---------- FR-6.3 手动跨设备同步（导入侧；导出由前端经现有 getters 组装） ----------

/// 合并式导入用户数据：只增不删；已安装应用对应条目跳过计数；
/// 设置项仅接受白名单（主题/语言/缓存保鲜期/关注频率）。
#[tauri::command]
pub fn import_user_data(
    state: State<'_, AppState>,
    json: String,
) -> Result<ImportUserDataResult, String> {
    let plan = crate::oauth::parse_import_payload(&json)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let installed: std::collections::HashSet<String> = db
        .get_installed_apps()
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.app_id.to_lowercase())
        .collect();

    let mut favorites_added = 0usize;
    let mut watched_added = 0usize;
    let mut settings_applied = 0usize;
    let mut installed_skipped = 0usize;

    for id in &plan.favorites {
        if installed.contains(&id.to_lowercase()) {
            installed_skipped += 1;
            continue;
        }
        if db.add_favorite(id).map_err(|e| e.to_string())? {
            favorites_added += 1;
        }
    }
    for id in &plan.watched {
        if installed.contains(&id.to_lowercase()) {
            installed_skipped += 1;
            continue;
        }
        if db.watch_app(id).map_err(|e| e.to_string())? {
            watched_added += 1;
        }
    }
    for (key, value) in &plan.settings {
        let normalized = if key == "detail_cache_ttl_minutes" {
            let parsed = value
                .trim()
                .parse::<i64>()
                .unwrap_or(crate::db::DETAIL_CACHE_TTL_DEFAULT_MINUTES);
            crate::db::normalize_detail_cache_ttl(parsed).to_string()
        } else if key == "watch_notify_frequency" {
            crate::db::normalize_watch_notify_frequency(value)
        } else {
            value.clone()
        };
        db.set_setting(key, &normalized).map_err(|e| e.to_string())?;
        settings_applied += 1;
    }

    Ok(ImportUserDataResult {
        favorites_added,
        watched_added,
        settings_applied,
        installed_skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_version_newer() {
        // 4 段式 MSI 与 3 段式 GitHub Release 相同版本时不误报
        assert!(!is_version_newer("3.0.21.0", "v3.0.21"));
        assert!(!is_version_newer("3.0.21", "3.0.21.0"));
        assert!(!is_version_newer("v1.2.3", "1.2.3"));

        // 真实新版本应当触发
        assert!(is_version_newer("3.0.20", "3.0.21"));
        assert!(is_version_newer("v1.0.0", "v1.1.0"));
        assert!(is_version_newer("1.9.9", "2.0.0"));

        // 降级（如 nightly 或用户更高版本）不应当触发
        assert!(!is_version_newer("3.0.22", "3.0.21"));
        assert!(!is_version_newer("1.4.0", "1.3.1"));
    }

    #[test]
    fn test_should_include_update() {
        // 1. 无规则，有新版本 -> 应当包含
        assert!(should_include_update("v1.0.0", "v1.1.0", None));
        // 2. 无规则，相同版本 -> 不应当包含
        assert!(!should_include_update("v1.1.0", "v1.1.0", None));

        // 3. 规则锁定 (is_frozen == true) -> 即使有新版本也忽略
        let frozen_rule = UpdateRule {
            app_id: "test".to_string(),
            skipped_version: None,
            is_frozen: true,
            is_hidden: false,
            updated_at: 1000,
        };
        assert!(!should_include_update("v1.0.0", "v2.0.0", Some(&frozen_rule)));

        // 4. 规则隐藏 (is_hidden == true) -> 即使有新版本也忽略
        let hidden_rule = UpdateRule {
            app_id: "test".to_string(),
            skipped_version: None,
            is_frozen: false,
            is_hidden: true,
            updated_at: 1000,
        };
        assert!(!should_include_update("v1.0.0", "v2.0.0", Some(&hidden_rule)));

        // 5. 规则跳过当前最新版本 -> 忽略此最新版本
        let skip_rule = UpdateRule {
            app_id: "test".to_string(),
            skipped_version: Some("v2.0.0".to_string()),
            is_frozen: false,
            is_hidden: false,
            updated_at: 1000,
        };
        assert!(!should_include_update("v1.0.0", "v2.0.0", Some(&skip_rule)));
        assert!(!should_include_update("v1.0.0", "2.0.0", Some(&skip_rule))); // v 前缀容错

        // 6. 规则跳过了 v2.0.0，但推出了更新的 v2.1.0 -> 应当恢复提示！
        assert!(should_include_update("v1.0.0", "v2.1.0", Some(&skip_rule)));
    }

    #[test]
    fn test_resolve_repo_key() {
        let catalog = crate::github::CatalogService::new();

        // 1. Catalog short id
        let k1 = resolve_repo_key("rustdesk", &catalog);
        assert_eq!(k1, "github.com/rustdesk/rustdesk");

        // 2. Full repo owner/repo
        let k2 = resolve_repo_key("rustdesk/rustdesk", &catalog);
        assert_eq!(k2, "github.com/rustdesk/rustdesk");

        // 3. Full GitHub URL
        let k3 = resolve_repo_key("https://github.com/rustdesk/rustdesk", &catalog);
        assert_eq!(k3, "github.com/rustdesk/rustdesk");

        // 4. Codeberg
        let k4 = resolve_repo_key("codeberg:user/repo", &catalog);
        assert_eq!(k4, "codeberg.org/user/repo");
    }

    #[test]
    fn test_select_best_asset() {
        let assets = vec![
            crate::models::ReleaseAsset {
                name: "app-macos.dmg".to_string(),
                download_url: "http://example.com/dmg".to_string(),
                size_bytes: 1000,
                sha256: None,
                os: "macos".to_string(),
                arch: "universal".to_string(),
                kind: "dmg".to_string(),
            },
            crate::models::ReleaseAsset {
                name: "app-setup.exe".to_string(),
                download_url: "http://example.com/exe".to_string(),
                size_bytes: 1000,
                sha256: None,
                os: "windows".to_string(),
                arch: "x86_64".to_string(),
                kind: "setup_exe".to_string(),
            },
            crate::models::ReleaseAsset {
                name: "app-linux.AppImage".to_string(),
                download_url: "http://example.com/appimage".to_string(),
                size_bytes: 1000,
                sha256: None,
                os: "linux".to_string(),
                arch: "x86_64".to_string(),
                kind: "appimage".to_string(),
            },
        ];

        let selected = select_best_asset(&assets).unwrap();
        #[cfg(target_os = "windows")]
        assert_eq!(selected.os, "windows");
        #[cfg(target_os = "macos")]
        assert_eq!(selected.os, "macos");
        #[cfg(target_os = "linux")]
        assert_eq!(selected.os, "linux");
    }

    #[test]
    fn test_select_best_asset_arch_priority() {
        let assets = vec![
            crate::models::ReleaseAsset {
                name: "rustdesk-1.4.9-aarch64.exe".to_string(),
                download_url: "http://example.com/aarch64".to_string(),
                size_bytes: 1000,
                sha256: None,
                os: "windows".to_string(),
                arch: "aarch64".to_string(),
                kind: "setup_exe".to_string(),
            },
            crate::models::ReleaseAsset {
                name: "rustdesk-1.4.9-x86_64.msi".to_string(),
                download_url: "http://example.com/x86_64".to_string(),
                size_bytes: 1000,
                sha256: None,
                os: "windows".to_string(),
                arch: "x86_64".to_string(),
                kind: "msi".to_string(),
            },
        ];

        let selected = select_best_asset(&assets).unwrap();
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        assert_eq!(selected.name, "rustdesk-1.4.9-x86_64.msi");
    }

    #[test]
    fn test_base64_encode_and_icon_cache_path() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");

        assert_eq!(detect_image_mime(b"\x89PNG\r\n\x1a\n123"), "image/png");
        assert_eq!(detect_image_mime(b"GIF89a..."), "image/gif");
        assert_eq!(detect_image_mime(&[0xff, 0xd8, 0xff, 0x00]), "image/jpeg");
        assert_eq!(detect_image_mime(b"<svg xmlns=..."), "image/svg+xml");

        // 验证方案一：优先格式化为 {owner}_{repo}.png
        let p1 = get_icon_cache_path(
            Some("rustdesk"),
            Some("rustdesk"),
            Some("rustdesk"),
            "https://github.com/rustdesk.png",
        );
        assert!(p1.to_string_lossy().ends_with("rustdesk_rustdesk.png"));

        let p2 = get_icon_cache_path(
            Some("microsoft"),
            Some("terminal"),
            None,
            "https://github.com/microsoft.png",
        );
        assert!(p2.to_string_lossy().ends_with("microsoft_terminal.png"));

        let p3 = get_icon_cache_path(
            None,
            None,
            Some("alacritty/alacritty"),
            "https://github.com/alacritty.png",
        );
        assert!(p3.to_string_lossy().ends_with("alacritty_alacritty.png"));

        let p4 = get_icon_cache_path(None, None, Some("localsend"), "https://github.com/localsend.png");
        assert!(p4.to_string_lossy().ends_with("localsend.png"));
    }
}

