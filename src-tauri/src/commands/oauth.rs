use super::{resolve_active_github_token, resolve_oauth_client_id_from_db};
use crate::models::DevicePollResult;
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

/// 登录/登出 INFO 去重窗口（毫秒）。StrictMode 双调用与重复点击只产生一行 INFO，
/// 窗口内重复调用降级为 debug，行为本身（落盘 token / 清理）不受影响。
static LAST_LOGIN_INFO_MS: AtomicU64 = AtomicU64::new(0);
static LAST_LOGOUT_INFO_MS: AtomicU64 = AtomicU64::new(0);
const LOGIN_DEDUP_WINDOW_MS: u64 = 5000;
const LOGOUT_DEDUP_WINDOW_MS: u64 = 2000;

/// 开始 Device Flow：返回用户验证码与浏览器授权地址（前端展示二维码/链接并轮询）。
#[tauri::command]
pub async fn oauth_device_start(
    state: State<'_, AppState>,
) -> crate::AppResult<crate::oauth::DeviceStartResult> {
    let client_id = resolve_oauth_client_id_from_db(&state);
    if client_id.trim().is_empty() || client_id == crate::oauth::OAUTH_CLIENT_ID_PLACEHOLDER {
        return Err("尚未配置 GitHub OAuth Client ID，请在「设置」中填写后重试".into());
    }
    Ok(crate::oauth::request_device_code(&client_id)
        .await
        .inspect_err(|e| {
            let mut ev = crate::z_log::WideEvent::new("oauth", "device start failed");
            ev.field("reason", crate::log_support::short_reason(e));
            ev.warn();
        })?)
}

/// 轮询 Device Flow 授权结果（前端按返回 `interval` 节流调用）。
/// `pending` 继续轮询；`authorized` 已持久化令牌+用户；`error` 停止并提示。
#[tauri::command(rename_all = "camelCase")]
pub async fn oauth_device_poll(
    state: State<'_, AppState>,
    device_code: String,
) -> crate::AppResult<DevicePollResult> {
    let code = device_code.trim().to_string();
    if code.is_empty() {
        return Err("设备验证码不能为空".into());
    }
    let client_id = resolve_oauth_client_id_from_db(&state);
    let outcome = crate::oauth::poll_device_once(&client_id, &code)
        .await
        .inspect_err(|e| {
            let mut ev = crate::z_log::WideEvent::new("oauth", "poll failed");
            ev.field("reason", crate::log_support::short_reason(e));
            ev.warn();
        })?;
    match outcome {
        crate::oauth::DevicePollOutcome::Authorized { access_token } => {
            let clean_token = access_token.trim().to_string();
            let user = crate::oauth::fetch_oauth_user(&clean_token).await.ok();
            // 登录成功：只记 GitHub login 用户名，不记 token/device_code/user_code。
            let now = crate::now_ms();
            let last = LAST_LOGIN_INFO_MS.swap(now, Ordering::SeqCst);
            if now.saturating_sub(last) >= LOGIN_DEDUP_WINDOW_MS {
                let mut ev = crate::z_log::WideEvent::new("oauth", "login ok");
                if let Some(ref u) = user {
                    ev.field("user", &u.login);
                }
                ev.info();
            }
            if let Ok(db) = state.db() {
                crate::oauth::save_oauth_session(&db, &clean_token, user.as_ref());
            }
            if let Ok(mut t) = state.github_token.lock() {
                *t = Some(clean_token.clone());
            }
            crate::probe_and_announce_rate_limit(Some(&clean_token)).await;
            crate::github::CatalogService::spawn_github_affinity_sync(
                std::sync::Arc::clone(&state.db),
                clean_token,
            );
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
        crate::oauth::DevicePollOutcome::Error { message } => {
            let mut ev = crate::z_log::WideEvent::new("oauth", "poll failed");
            ev.field("reason", crate::log_support::short_reason(&message));
            ev.warn();
            Ok(DevicePollResult {
                status: "error".to_string(),
                message: Some(message),
            })
        }
    }
}

/// 当前 OAuth 登录用户；未登录或快照无效返回 null（过期快照原样返回，`is_expired` 供前端处理重登）。
#[tauri::command]
pub async fn get_oauth_user(
    state: State<'_, AppState>,
) -> crate::AppResult<Option<crate::oauth::OAuthUser>> {
    let (stored, is_oauth) = state
        .db
        .lock()
        .ok()
        .map(|db| crate::oauth::load_oauth_user_snapshot(&db))
        .unwrap_or((None, false));
    if !crate::oauth::should_refetch_oauth_user(stored.as_ref()) {
        return Ok(stored);
    }
    // 有令牌但缺用户快照或快照未标记权限范围时实时补拉一次
    if is_oauth {
        if let Some(t) = resolve_active_github_token(&state) {
            match crate::oauth::fetch_oauth_user(&t).await {
                Ok(user) => {
                    if let Ok(db) = state.db() {
                        crate::oauth::save_oauth_user_snapshot(&db, &user);
                    }
                    return Ok(Some(user));
                }
                Err(e) => {
                    let mut ev = crate::z_log::WideEvent::new("oauth", "refresh failed");
                    ev.field("reason", crate::log_support::short_reason(&e));
                    ev.warn();
                }
            }
        }
    }
    Ok(stored)
}

#[tauri::command]
pub async fn oauth_logout(state: State<'_, AppState>) -> crate::AppResult<bool> {
    let fallback_pat = {
        let db = state.db()?;
        crate::oauth::clear_oauth_session(&db)?
    };
    if let Ok(mut t) = state.github_token.lock() {
        *t = fallback_pat.clone();
    }
    let now = crate::now_ms();
    let last = LAST_LOGOUT_INFO_MS.swap(now, Ordering::SeqCst);
    if now.saturating_sub(last) >= LOGOUT_DEDUP_WINDOW_MS {
        crate::z_log::WideEvent::new("oauth", "logout ok").info();
    }
    crate::probe_and_announce_rate_limit(fallback_pat.as_deref()).await;
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn star_app(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<crate::oauth::StarRepoOutcome> {
    let (owner, repo) = crate::oauth::split_github_repo_id(&app_id)?;
    let token =
        resolve_active_github_token(&state).ok_or_else(|| "请先完成 GitHub 登录".to_string())?;
    let outcome = crate::oauth::star_repo(&token, &owner, &repo).await?;
    if outcome.starred {
        if let Ok(db) = state.db() {
            crate::oauth::sync_star_cache(&db, &owner, &repo, true);
        }
    }
    Ok(outcome)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn unstar_app(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let (owner, repo) = crate::oauth::split_github_repo_id(&app_id)?;
    let token =
        resolve_active_github_token(&state).ok_or_else(|| "请先完成 GitHub 登录".to_string())?;
    crate::oauth::unstar_repo(&token, &owner, &repo).await?;
    if let Ok(db) = state.db() {
        crate::oauth::sync_star_cache(&db, &owner, &repo, false);
    }
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_starred_status(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<bool> {
    let (owner, repo) = crate::oauth::split_github_repo_id(&app_id)?;
    if let Some(ref t) = resolve_active_github_token(&state) {
        if let Ok(remote_val) = crate::oauth::check_starred(t, &owner, &repo).await {
            if let Ok(db) = state.db() {
                crate::oauth::sync_star_cache(&db, &owner, &repo, remote_val);
            }
            return Ok(remote_val);
        }
    }
    let db = state.db()?;
    Ok(db.is_starred(&owner, &repo).unwrap_or(false))
}
