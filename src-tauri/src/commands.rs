use crate::installer::InstallerEngine;
use crate::models::{
    AppDetail, AppSummary, DeepLinkAction, DeveloperProfile, HostRateLimitStatus, HostTokenEntry,
    InstalledApp, MirrorNodeStatus, StarredSyncResult, UpdateItem, UpdateRule,
};
use crate::AppState;
use std::collections::HashMap;
use tauri::{AppHandle, State};

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
    let clean_id = id.trim().to_string();
    let repo_key = resolve_repo_key(&clean_id, &state.catalog);
    let is_force = force_refresh.unwrap_or(false);

    // 获取客户端设置的应用详情缓存保鲜期 (TTL，单位分钟，默认 30 分钟)
    let ttl_seconds = {
        if let Ok(db) = state.db.lock() {
            let mins = db
                .get_setting("detail_cache_ttl_minutes")
                .ok()
                .flatten()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(30);
            mins * 60
        } else {
            1800
        }
    };

    // 1. 若非主动强制刷新，按 TTL 从 SQLite 缓存中读取，未过期则 0ms 秒开
    if !is_force {
        if let Ok(db) = state.db.lock() {
            if let Ok(Some(mut cached_detail)) = db.get_cached_app_detail(&clean_id, Some(ttl_seconds)) {
                cached_detail.id = clean_id;
                return Ok(cached_detail);
            }
            if let Ok(Some(mut cached_detail)) = db.get_cached_app_detail(&repo_key, Some(ttl_seconds)) {
                cached_detail.id = clean_id;
                return Ok(cached_detail);
            }
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
            let detail = AppDetail {
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
            };

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
        let coords = state.catalog.get_repo_coordinates(&clean_id)?;
        let ep = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            coords.owner, coords.repo
        );
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let etag = db.get_etag(&ep).ok().flatten();
        let payload = db.get_cached_payload(&ep).ok().flatten();
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

            // 存入 SQLite 本地持久化缓存
            if let Ok(db) = state.db.lock() {
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
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                "https://raw.gitmirror.com/supermc/z-store/main/src-tauri/src/catalog.json"
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
    db.get_installed_apps().map_err(|e| e.to_string())
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
            score += 30;
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
) -> Result<InstalledApp, String> {
    // 读取用户配置（自定义下载路径、绿色便携根路径、安装后是否自动清理缓存）
    let (custom_download_dir, custom_portable_dir, auto_clean_cache) = {
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
            let auto_clean = db
                .get_setting("auto_clean_cache")
                .ok()
                .flatten()
                .map(|v| v == "true" || v == "1")
                .unwrap_or(true);
            (dl, port, auto_clean)
        } else {
            (None, None, true)
        }
    };

    // 1. 获取应用详情与根据当前系统架构择取最优匹配资产
    let detail = get_app_details(state.clone(), app_id.clone(), None).await?;

    let asset = select_best_asset(&detail.releases)
        .ok_or_else(|| "该 Release 未提供匹配当前操作系统的安装包资产".to_string())?;

    // 2. 获取加速下载重写地址
    let rewritten_url = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.rewrite_download_url(&asset.download_url)
    };

    // 3. 执行流式下载与 SHA-256 完整性防篡改强校验
    let (dest_path, actual_sha256) = InstallerEngine::download_with_progress(
        &app_handle,
        &app_id,
        &rewritten_url,
        &asset.name,
        asset.sha256.as_deref(),
        custom_download_dir.as_deref(),
    )
    .await?;

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

    // 4. 调用原生安装器或解压便携版
    let (kind, _, _) = InstallerEngine::classify_asset(&asset.name);
    let install_note = InstallerEngine::execute_installation(
        &dest_path,
        &kind,
        &detail.id,
        custom_portable_dir.as_deref(),
    )?;

    // 智能解析真实安装路径，避免存入临时安装包路径
    let real_install_path = match kind {
        crate::installer::AssetKind::PortableZip => {
            let app_dir = crate::installer::dirs_or_fallback_with_base(
                &detail.id,
                custom_portable_dir.as_deref(),
            );
            crate::scanner::AppScanner::resolve_executable_path(
                Some(&app_dir.to_string_lossy()),
                None,
                &detail.repo,
            )
            .unwrap_or_else(|| app_dir.to_string_lossy().to_string())
        }
        _ => crate::scanner::AppScanner::resolve_executable_path(None, None, &detail.repo)
            .or_else(|| {
                #[cfg(target_os = "windows")]
                {
                    let desktop = std::env::var("USERPROFILE")
                        .map(|p| std::path::PathBuf::from(p).join("Desktop"))
                        .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Users\Public\Desktop"));
                    let lnk = desktop.join(format!("{}.lnk", detail.name));
                    if lnk.is_file() {
                        return Some(lnk.to_string_lossy().to_string());
                    }
                }
                None
            })
            .unwrap_or_default(),
    };

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
        uninstall_command: Some(install_note),
    };

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.save_installed_app(&installed_app)
            .map_err(|e| e.to_string())?;
    }

    // 若开启自动清理安装缓存，清理下载的安装包临时文件
    if auto_clean_cache && dest_path.is_file() {
        let _ = std::fs::remove_file(&dest_path);
    }

    Ok(installed_app)
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
        // 便携版清理
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

    Ok(updates)
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
    let nodes = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.get_mirror_statuses()
    };
    let updated = crate::mirror::MirrorManager::ping_nodes(nodes).await;
    {
        let mut mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        let latencies: Vec<(String, u32)> = updated
            .iter()
            .map(|n| (n.id.clone(), n.latency_ms))
            .collect();
        mirror.update_latencies(&latencies);
    }
    let mut sorted = updated;
    sorted.sort_by_key(|a| a.latency_ms);
    Ok(sorted)
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
    db.get_all_settings().map_err(|e| e.to_string())
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
        let mut dialog = rfd::FileDialog::new().set_title("选择安装集中目录（绿色便携软件存放路径）");
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
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
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

pub fn get_icon_cache_path(
    owner: Option<&str>,
    repo: Option<&str>,
    app_id: Option<&str>,
    remote_url: &str,
) -> std::path::PathBuf {
    use sha2::Digest;
    let icons_dir = crate::get_app_data_dir().join("icons");

    // 方案一：优先使用 GitHub 唯一命名空间 {owner}_{repo}.png
    let filename = match (owner, repo) {
        (Some(o), Some(r)) => {
            let safe_o: String = o
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            let safe_r: String = r
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !safe_o.is_empty() && !safe_r.is_empty() {
                format!("{}_{}.png", safe_o, safe_r)
            } else if let Some(id) = app_id {
                let safe_id: String = id
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                format!("{}.png", safe_id)
            } else {
                let mut hasher = sha2::Sha256::new();
                hasher.update(remote_url.as_bytes());
                let hash = hex::encode(hasher.finalize());
                format!("{}.png", &hash[..16])
            }
        }
        _ => {
            if let Some(id) = app_id {
                let clean_id = id.trim();
                // 支持类似 "owner/repo" 或 "owner_repo" 格式的 app_id
                if clean_id.contains('/') {
                    let parts: Vec<&str> = clean_id.split('/').collect();
                    if parts.len() == 2 {
                        let safe_o: String = parts[0]
                            .chars()
                            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                            .collect();
                        let safe_r: String = parts[1]
                            .chars()
                            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                            .collect();
                        if !safe_o.is_empty() && !safe_r.is_empty() {
                            return icons_dir.join(format!("{}_{}.png", safe_o, safe_r));
                        }
                    }
                }
                let safe_id: String = clean_id
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                if !safe_id.is_empty() {
                    format!("{}.png", safe_id)
                } else {
                    let mut hasher = sha2::Sha256::new();
                    hasher.update(remote_url.as_bytes());
                    let hash = hex::encode(hasher.finalize());
                    format!("{}.png", &hash[..16])
                }
            } else {
                let mut hasher = sha2::Sha256::new();
                hasher.update(remote_url.as_bytes());
                let hash = hex::encode(hasher.finalize());
                format!("{}.png", &hash[..16])
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
pub fn clear_cache(state: State<'_, AppState>) -> Result<bool, String> {
    let download_dir = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.clear_cache().map_err(|e| e.to_string())?;
        db.get_setting("download_dir").ok().flatten().and_then(|s| {
            let t = s.trim();
            if !t.is_empty() {
                Some(crate::installer::expand_env_path(t))
            } else {
                None
            }
        })
    };

    let target_dirs = vec![
        download_dir.unwrap_or_else(|| std::env::temp_dir().join("zstore_downloads")),
        std::env::temp_dir().join("zstore_downloads"),
    ];

    for dir in target_dirs {
        if dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }

    // 注意：图标缓存 (icons/) 作为本地持久化资产受保护，不随普通缓存清理而被删除。
    // 保证用户在离线或弱网时图标永远秒开，绝不因清理缓存导致重复发起网络拉取。

    Ok(true)
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

#[tauri::command]
pub fn launch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let installed_app = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.app_id.eq_ignore_ascii_case(&app_id))
            .ok_or_else(|| format!("未找到已安装或纳管的应用: {}", app_id))?
    };

    let target_path = installed_app
        .install_path
        .trim()
        .trim_matches('"')
        .to_string();
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

    // 2. 检查安装路径是否为目录，调用智能嗅探器寻找真正的 exe
    let candidate_exe = crate::scanner::AppScanner::resolve_executable_path(
        if target_path.is_empty() {
            None
        } else {
            Some(&target_path)
        },
        None,
        &installed_app.app_name,
    )
    .or_else(|| {
        crate::scanner::AppScanner::resolve_executable_path(
            if target_path.is_empty() {
                None
            } else {
                Some(&target_path)
            },
            None,
            &app_id,
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

            // 自动将探测到的真实物理路径写回数据库，加速下次启动
            if target_path != exe_str {
                if let Ok(db) = state.db.lock() {
                    let mut updated = installed_app.clone();
                    updated.install_path = exe_str;
                    let _ = db.save_installed_app(&updated);
                }
            }

            return Ok(true);
        }
    }

    // 3. 检查便携应用目录 ~/AppData/Local/Programs/z-store-apps/<app_id>/
    let portable_dir = crate::installer::dirs_or_fallback(&installed_app.app_id);
    if portable_dir.is_dir() {
        if let Some(exe_str) = crate::scanner::AppScanner::resolve_executable_path(
            Some(&portable_dir.to_string_lossy()),
            None,
            &installed_app.app_name,
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
            desktop.join(format!("{}.lnk", installed_app.app_name)),
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

