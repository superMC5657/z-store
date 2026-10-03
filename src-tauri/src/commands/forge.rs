use super::resolve_active_github_token;
use crate::models::{DeveloperProfile, HostRateLimitStatus, HostTokenEntry, StarredSyncResult};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_developer_profile(
    state: State<'_, AppState>,
    developer: String,
) -> crate::AppResult<DeveloperProfile> {
    let token = resolve_active_github_token(&state);
    Ok(state
        .catalog
        .fetch_developer_profile(&developer, token.as_deref())
        .await?)
}

#[tauri::command]
pub async fn sync_github_starred(
    state: State<'_, AppState>,
    username: Option<String>,
) -> crate::AppResult<StarredSyncResult> {
    let token = resolve_active_github_token(&state);
    Ok(state
        .catalog
        .sync_starred_repos(username.as_deref(), token.as_deref())
        .await?)
}

#[tauri::command]
pub fn get_host_tokens(state: State<'_, AppState>) -> crate::AppResult<Vec<HostTokenEntry>> {
    let db = state.db()?;
    Ok(db.get_host_tokens()?)
}

#[tauri::command]
pub async fn set_host_token(
    state: State<'_, AppState>,
    host: String,
    token: String,
) -> crate::AppResult<()> {
    {
        let db = state.db()?;
        db.set_host_token(&host, &token)
            .map_err(|e| e.to_string())?;
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
pub async fn remove_host_token(state: State<'_, AppState>, host: String) -> crate::AppResult<()> {
    {
        let db = state.db()?;
        db.remove_host_token(&host)?;
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
) -> crate::AppResult<HostTokenEntry> {
    let clean_host = host
        .unwrap_or_else(|| "github.com".to_string())
        .trim()
        .to_lowercase();
    let token = {
        let db = state.db()?;
        db.get_host_token(&clean_host).ok().flatten()
    };
    if clean_host.contains("github.com") {
        crate::probe_github_rate_limit(token.as_deref()).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    let db = state.db()?;
    let tokens = db.get_host_tokens()?;
    if let Some(entry) = tokens
        .into_iter()
        .find(|t| t.host.eq_ignore_ascii_case(&clean_host))
    {
        Ok(entry)
    } else {
        Ok(HostTokenEntry {
            host: clean_host,
            token: token.unwrap_or_default(),
            rate_limit_remaining: None,
            rate_limit_limit: None,
            rate_limit_reset: None,
            updated_at: crate::now_secs(),
        })
    }
}

#[tauri::command]
pub async fn test_host_connection(
    state: State<'_, AppState>,
    host: String,
    token: Option<String>,
) -> crate::AppResult<HostRateLimitStatus> {
    let clean_host = host.trim().to_lowercase();
    let client = build_api_client()?;

    let effective_token = if let Some(ref tok) = token {
        if !tok.trim().is_empty() {
            Some(tok.trim().to_string())
        } else {
            None
        }
    } else if let Ok(db) = state.db() {
        db.get_host_token(&clean_host).ok().flatten()
    } else {
        None
    };

    let mut headers = base_ua_headers();

    if clean_host.contains("github.com") {
        if let Some(ref tok) = effective_token {
            try_insert_auth(&mut headers, "Bearer", tok);
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
            try_insert_auth(&mut headers, "token", tok);
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
) -> crate::AppResult<Vec<crate::forge::ForgeRepoInfo>> {
    let forge_type = match forge.to_lowercase().as_str() {
        "codeberg" => crate::forge::ForgeType::Codeberg,
        "gitea" | "forgejo" => crate::forge::ForgeType::Gitea,
        "gitlab" => crate::forge::ForgeType::GitLab,
        _ => crate::forge::ForgeType::GitHub,
    };
    let target_host = host.as_deref().unwrap_or_else(|| forge_type.default_host());
    let token = if let Ok(db) = state.db() {
        db.get_host_token(target_host).ok().flatten()
    } else {
        None
    };

    Ok(crate::forge::ForgeRegistry::search_repos(
        forge_type,
        Some(target_host),
        &query,
        token.as_deref(),
    )
    .await?)
}

/// H1/H2：本作用域 API 请求头/客户端收敛（UA 恒定；认证方案按调用方原样传递）。
/// 各调用点的 Accept/认证组合保持不变，仅收敛样板。
fn build_api_client() -> Result<reqwest::Client, String> {
    let timeout_sec = crate::config::get_project_config()
        .network
        .api_timeout_seconds;
    crate::forge::http::new_api_client(timeout_sec)
}

fn base_ua_headers() -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(crate::forge::http::USER_AGENT_VALUE),
    );
    headers
}

fn try_insert_auth(headers: &mut reqwest::header::HeaderMap, scheme: &str, token: &str) -> bool {
    match reqwest::header::HeaderValue::from_str(&format!("{} {}", scheme, token.trim())) {
        Ok(v) => {
            headers.insert(reqwest::header::AUTHORIZATION, v);
            true
        }
        Err(_) => false,
    }
}
