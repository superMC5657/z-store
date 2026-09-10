use crate::models::{DeveloperProfile, HostRateLimitStatus, HostTokenEntry, StarredSyncResult};
use crate::AppState;
use super::catalog::{get_app_details_impl, get_store_toml_raw_cached};
use super::resolve_active_github_token;
use tauri::State;

#[tauri::command]
pub async fn get_developer_profile(
    state: State<'_, AppState>,
    developer: String,
) -> Result<DeveloperProfile, String> {
    let token = resolve_active_github_token(&state);
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
    let token = resolve_active_github_token(&state);
    state
        .catalog
        .sync_starred_repos(username.as_deref(), token.as_deref())
        .await
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
    let timeout_sec = crate::config::get_project_config().network.api_timeout_seconds;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_sec))
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
