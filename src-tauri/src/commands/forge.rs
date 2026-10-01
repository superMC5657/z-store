use super::catalog::get_app_details_impl;
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

// ---------- FR-8.3 所有权认证 ----------

/// 官方所有权认证（MVP）：校验码原文出现在仓库 README 中即通过；
/// 通过后持久化，`is_verified` 经合并规则在详情中生效。
/// 空校验码恒为 `false`（避免空串子串恒真导致误认证）。
pub fn is_verified_by_code(readme_markdown: &str, code: &str) -> bool {
    let needle = code.trim();
    if needle.is_empty() {
        return false;
    }
    readme_markdown.contains(needle)
}

/// 纯决策函数（离线可测）：仅靠 README 子串命中绝不予以认证；
/// 仅当 `api_authorized`（调用方 GitHub token 经仓库 API 确认具备
/// owner / collaborator / push 权限）为 true 且校验码命中时才通过。
/// 网络 I/O 全部隔离在 `check_github_push_access` 中，本函数无网络依赖。
pub fn decide_ownership_verified(readme_markdown: &str, code: &str, api_authorized: bool) -> bool {
    if !api_authorized {
        return false;
    }
    is_verified_by_code(readme_markdown, code)
}

/// 经 GitHub 仓库 API 确认调用方 token 具备 owner / collaborator /
/// write（push）权限：`GET /repos/{owner}/{repo}` 在认证上下文中返回
/// `permissions.push|admin|maintain`，任一为 true 即通过。
/// 无 token / 非 `owner/repo` 坐标 / 请求失败 / 权限不足均返回 false。
/// 仅支持 github.com；其余 forge 直接返回 false（拒绝误认证）。
/// H1/H2：本作用域 API 请求头/客户端收敛（UA 恒定；认证方案按调用方原样传递）。
/// 各调用点的 Accept/认证组合保持不变，仅收敛样板。
fn build_api_client() -> Result<reqwest::Client, String> {
    let timeout_sec = crate::config::get_project_config()
        .network
        .api_timeout_seconds;
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_sec))
        .build()
        .map_err(|e| e.to_string())
}

fn base_ua_headers() -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("ZStore-Client/0.1.0"),
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

async fn check_github_push_access(owner: &str, repo: &str, token: &str) -> bool {
    if owner.trim().is_empty() || repo.trim().is_empty() || token.trim().is_empty() {
        return false;
    }
    let client = match build_api_client() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let mut headers = base_ua_headers();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github.v3+json"),
    );
    if !try_insert_auth(&mut headers, "Bearer", token) {
        return false;
    }
    let url = format!(
        "https://api.github.com/repos/{}/{}",
        owner.trim(),
        repo.trim()
    );
    let resp = match client.get(&url).headers(headers).send().await {
        Ok(r) => r,
        Err(_) => return false,
    };
    if !resp.status().is_success() {
        return false;
    }
    #[derive(serde::Deserialize)]
    struct PermPayload {
        permissions: Option<PermDetail>,
    }
    #[derive(serde::Deserialize)]
    struct PermDetail {
        push: Option<bool>,
        admin: Option<bool>,
        maintain: Option<bool>,
    }
    match resp.json::<PermPayload>().await {
        Ok(p) => match p.permissions {
            Some(d) => {
                d.push.unwrap_or(false) || d.admin.unwrap_or(false) || d.maintain.unwrap_or(false)
            }
            None => false,
        },
        Err(_) => false,
    }
}

/// 官方所有权认证（加固）：README 校验码命中 **且** 调用方 GitHub token
/// 经仓库 API 确认具备 owner / collaborator / write 权限时才通过；
/// 通过后持久化，`is_verified` 经合并规则在详情中生效。
#[tauri::command]
pub async fn verify_ownership(
    state: State<'_, AppState>,
    app_id: String,
    code: String,
) -> crate::AppResult<bool> {
    let clean_id = app_id.trim().to_string();
    if clean_id.is_empty() {
        return Err("应用 ID 不能为空".into());
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
    if let Ok(db) = state.db() {
        if db.is_verified_app(&clean_id).unwrap_or(false) {
            return Ok(true);
        }
    }
    // 3. README 复用应用详情链路做子串命中比对 + 仓库 API 鉴权：
    // 子串命中 alone NEVER verifies，必须同时满足调用方 token 的
    // owner / collaborator / push 权限（经 GitHub 仓库 API 确认）。
    let readme = get_app_details_impl(&state, clean_id.clone(), None)
        .await
        .map(|d| d.readme_markdown)
        .unwrap_or_default();
    if !is_verified_by_code(&readme, &needle) {
        return Ok(false);
    }
    let token = match resolve_active_github_token(&state) {
        Some(t) if !t.trim().is_empty() => t,
        _ => return Ok(false),
    };
    let mut parts = clean_id.splitn(2, '/');
    let (owner, repo) = match (parts.next(), parts.next()) {
        (Some(o), Some(r)) if !o.trim().is_empty() && !r.trim().is_empty() => (o, r),
        _ => return Ok(false),
    };
    let api_authorized = check_github_push_access(owner, repo, &token).await;
    let passed = decide_ownership_verified(&readme, &needle, api_authorized);
    if passed {
        if let Ok(db) = state.db() {
            let _ = db.mark_verified_app(&clean_id);
        }
    }
    Ok(passed)
}
