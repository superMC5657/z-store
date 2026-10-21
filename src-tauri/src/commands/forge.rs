use super::resolve_active_github_token;
use crate::models::{
    DeveloperProfile, HostRateLimitRefresh, HostRateLimitStatus, HostTokenEntry, StarredSyncResult,
};
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
        crate::probe_and_announce_rate_limit(tok_opt).await;
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
        crate::probe_and_announce_rate_limit(None).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn refresh_host_rate_limit(
    state: State<'_, AppState>,
    host: Option<String>,
) -> crate::AppResult<HostRateLimitRefresh> {
    let clean_host = host
        .unwrap_or_else(|| "github.com".to_string())
        .trim()
        .to_lowercase();
    let token = {
        let db = state.db()?;
        db.get_host_token(&clean_host).ok().flatten()
    };
    // GitHub 探测即取值；配额事件仍异步落库/emit，命令侧对读出的 entry 确定性覆写探测值。
    let probed = if crate::forge::ForgeType::GitHub.matches_host(&clean_host) {
        crate::probe_and_announce_rate_limit(token.as_deref()).await
    } else {
        None
    };
    let db = state.db()?;
    let tokens = db.get_host_tokens()?;
    let entry = tokens
        .into_iter()
        .find(|t| t.host.eq_ignore_ascii_case(&clean_host))
        .unwrap_or_else(|| HostTokenEntry {
            host: clean_host,
            token: token.unwrap_or_default(),
            rate_limit_remaining: None,
            rate_limit_limit: None,
            rate_limit_reset: None,
            updated_at: crate::now_secs(),
        });
    let entry = overlay_probed_quota(entry, probed);
    Ok(HostRateLimitRefresh {
        host: entry.host,
        rate_limit_remaining: entry.rate_limit_remaining,
        rate_limit_limit: entry.rate_limit_limit,
        rate_limit_reset: entry.rate_limit_reset,
        updated_at: entry.updated_at,
    })
}

/// 探测值确定性覆写：probe 命中即以响应头为准（事件通道仍异步落库/emit）；
/// 未探测到（`None`）保持 DB 原值，unknown 不伪造数值。
fn overlay_probed_quota(
    mut entry: HostTokenEntry,
    probed: Option<(u32, u32, Option<i64>)>,
) -> HostTokenEntry {
    if let Some((remaining, limit, reset)) = probed {
        entry.rate_limit_remaining = Some(remaining);
        entry.rate_limit_limit = Some(limit);
        entry.rate_limit_reset = reset;
        entry.updated_at = crate::now_secs();
    }
    entry
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(host: &str) -> HostTokenEntry {
        HostTokenEntry {
            host: host.to_string(),
            token: String::new(),
            rate_limit_remaining: None,
            rate_limit_limit: None,
            rate_limit_reset: None,
            updated_at: 1,
        }
    }

    #[test]
    fn test_overlay_probed_quota() {
        // probe 命中：以响应头为准并刷新 updated_at。
        let e = overlay_probed_quota(entry("github.com"), Some((42, 5000, Some(123))));
        assert_eq!(e.rate_limit_remaining, Some(42));
        assert_eq!(e.rate_limit_limit, Some(5000));
        assert_eq!(e.rate_limit_reset, Some(123));
        assert!(e.updated_at >= crate::now_secs() - 5);

        // probe 未命中（网络失败/无头）：保持 DB 原值，不伪造数值。
        let mut stale = entry("gitea.com");
        stale.rate_limit_remaining = Some(7);
        stale.rate_limit_limit = Some(100);
        let e = overlay_probed_quota(stale, None);
        assert_eq!(e.rate_limit_remaining, Some(7));
        assert_eq!(e.rate_limit_limit, Some(100));
        assert_eq!(e.updated_at, 1);
    }
}

#[tauri::command]
pub async fn test_host_connection(
    state: State<'_, AppState>,
    host: String,
    token: Option<String>,
) -> crate::AppResult<HostRateLimitStatus> {
    let clean_host = host.trim().to_lowercase();
    // host 段直拼 `https://{host}/api/...`（Gitea 分支）前的注入面收口：
    // 拒绝空值、scheme 前缀、路径/查询/空白等 URL 结构字符，脏 host 不发请求。
    if !valid_self_hosted_host(&clean_host) {
        return Ok(HostRateLimitStatus {
            host: clean_host,
            is_connected: false,
            rate_limit_remaining: None,
            rate_limit_limit: None,
            message: Some("host 不合法".to_string()),
        });
    }
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

    if crate::forge::ForgeType::GitHub.matches_host(&clean_host) {
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
                // 未知配额保持 None，不伪造数值。
                let remaining = resp
                    .headers()
                    .get("x-ratelimit-remaining")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u32>().ok());
                let limit = resp
                    .headers()
                    .get("x-ratelimit-limit")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u32>().ok());

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

#[tauri::command(rename_all = "camelCase")]
pub async fn search_forge_repos(
    state: State<'_, AppState>,
    forge: String,
    host: Option<String>,
    query: String,
    page: Option<u32>,
    per_page: Option<u32>,
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
        page,
        per_page,
    )
    .await?)
}

/// 本作用域 API 请求头/客户端收敛（UA 恒定；认证方案按调用方原样传递）。
/// Accept/认证组合由调用点给定，本函数只收敛样板。
fn build_api_client() -> Result<reqwest::Client, String> {
    let timeout_sec = crate::config::get_project_config()
        .network
        .api_timeout_seconds;
    crate::forge::http::new_api_client(timeout_sec)
}

/// 自建实例 host 段校验：非空、无 scheme 前缀、无 `/?#\` 与空白。
/// `:`（非标端口）放行；Gitea 分支 `https://{host}/api/v1/...` 直拼前唯一闸口。
fn valid_self_hosted_host(host: &str) -> bool {
    !host.is_empty()
        && !host.contains("://")
        && !host.contains(['/', '?', '#', '\\'])
        && !host.chars().any(char::is_whitespace)
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
