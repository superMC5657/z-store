use crate::models::DevicePollResult;
use crate::AppState;
use super::{resolve_oauth_client_id_from_db, resolve_write_token};
use tauri::State;

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
            let clean_token = access_token.trim().to_string();
            let user = crate::oauth::fetch_oauth_user(&clean_token).await.ok();
            if let Ok(db) = state.db.lock() {
                let _ = db.set_setting(crate::oauth::SETTING_OAUTH_TOKEN, &clean_token);
                if let Some(u) = user {
                    if let Ok(json) = serde_json::to_string(&u) {
                        let _ = db.set_setting(crate::oauth::SETTING_OAUTH_USER, &json);
                    }
                }
            }
            if let Ok(mut t) = state.github_token.lock() {
                *t = Some(clean_token.clone());
            }
            crate::probe_github_rate_limit(Some(&clean_token)).await;
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
    if let Some(ref u) = stored {
        if u.is_expired {
            return Ok(stored);
        }
        if u.has_list_scope {
            return Ok(stored);
        }
    }
    // 有令牌但缺用户快照或旧版快照未标记权限范围时实时补拉一次
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
    Ok(stored)
}

#[tauri::command]
pub async fn oauth_logout(state: State<'_, AppState>) -> Result<bool, String> {
    let fallback_pat = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.remove_setting(crate::oauth::SETTING_OAUTH_TOKEN)
            .map_err(|e| e.to_string())?;
        db.remove_setting(crate::oauth::SETTING_OAUTH_USER)
            .map_err(|e| e.to_string())?;
        db.get_setting("github_token")
            .ok()
            .flatten()
            .or_else(|| db.get_host_token("github.com").ok().flatten())
            .filter(|s| !s.trim().is_empty())
    };
    if let Ok(mut t) = state.github_token.lock() {
        *t = fallback_pat.clone();
    }
    crate::probe_github_rate_limit(fallback_pat.as_deref()).await;
    Ok(true)
}

#[tauri::command]
pub async fn star_app(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
) -> Result<crate::oauth::StarRepoOutcome, String> {
    if owner.trim().is_empty() || repo.trim().is_empty() {
        return Err("仓库 owner 与 repo 不能为空".to_string());
    }
    let token = resolve_write_token(&state)
        .ok_or_else(|| "请先完成 GitHub 登录，或在「设置」中配置个人访问令牌 (PAT)".to_string())?;
    let outcome = crate::oauth::star_repo(&token, owner.trim(), repo.trim()).await?;
    if outcome.starred {
        if let Ok(db) = state.db.lock() {
            let _ = db.set_starred(&owner, &repo, true);
        }
    }
    Ok(outcome)
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
        .map(|_| {
            if let Ok(db) = state.db.lock() {
                let _ = db.set_starred(&owner, &repo, false);
            }
            true
        })
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
    let token = resolve_write_token(&state);
    if let Some(ref t) = token {
        if let Ok(remote_val) = crate::oauth::check_starred(t, owner.trim(), repo.trim()).await {
            if let Ok(db) = state.db.lock() {
                let _ = db.set_starred(&owner, &repo, remote_val);
            }
            return Ok(remote_val);
        }
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.is_starred(&owner, &repo).unwrap_or(false))
}
