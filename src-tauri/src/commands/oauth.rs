use super::{resolve_oauth_client_id_from_db, resolve_write_token};
use crate::models::DevicePollResult;
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

/// Wave2：登录/登出 INFO 去重窗口（毫秒）。StrictMode 双调用与重复点击只产生一行 INFO，
/// 窗口内重复调用降级为 debug，行为本身（落盘 token / 清理）不受影响。
static LAST_LOGIN_INFO_MS: AtomicU64 = AtomicU64::new(0);
static LAST_LOGOUT_INFO_MS: AtomicU64 = AtomicU64::new(0);
const LOGIN_DEDUP_WINDOW_MS: u64 = 5000;
const LOGOUT_DEDUP_WINDOW_MS: u64 = 2000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 开始 Device Flow：返回用户验证码与浏览器授权地址（前端展示二维码/链接并轮询）。
#[tauri::command]
pub async fn oauth_device_start(
    state: State<'_, AppState>,
) -> Result<crate::oauth::DeviceStartResult, String> {
    let client_id = resolve_oauth_client_id_from_db(&state);
    if client_id.trim().is_empty() || client_id == crate::oauth::OAUTH_CLIENT_ID_PLACEHOLDER {
        return Err("尚未配置 GitHub OAuth Client ID，请在「设置」中填写后重试".to_string());
    }
    crate::oauth::request_device_code(&client_id)
        .await
        .inspect_err(|e| {
            log::warn!(
                "oauth device start failed reason={}",
                crate::log_support::short_reason(e)
            );
        })
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
    let outcome = crate::oauth::poll_device_once(&client_id, &code)
        .await
        .inspect_err(|e| {
            log::warn!(
                "oauth poll failed reason={}",
                crate::log_support::short_reason(e)
            );
        })?;
    match outcome {
        crate::oauth::DevicePollOutcome::Authorized { access_token } => {
            let clean_token = access_token.trim().to_string();
            let user = crate::oauth::fetch_oauth_user(&clean_token).await.ok();
            // 登录成功：只记 GitHub login 用户名，不记 token/device_code/user_code。
            // Wave2：幂等去重 + sid 关联，窗口内重复授权只记一行 INFO。
            let sid = crate::z_log::new_session_id();
            let now = now_ms();
            let last = LAST_LOGIN_INFO_MS.swap(now, Ordering::SeqCst);
            if now.saturating_sub(last) < LOGIN_DEDUP_WINDOW_MS {
                log::debug!("oauth login skipped reason=duplicate sid={}", sid);
            } else if let Some(ref u) = user {
                log::info!("oauth login ok sid={} user={}", sid, u.login);
            } else {
                log::info!("oauth login ok sid={}", sid);
            }
            if let Ok(db) = state.db() {
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
        crate::oauth::DevicePollOutcome::Denied { message } => {
            // 用户取消授权属正常流程：debug，不记 token/user_code。
            log::debug!("oauth device denied");
            Ok(DevicePollResult {
                status: "denied".to_string(),
                message: Some(message),
            })
        }
        crate::oauth::DevicePollOutcome::Error { message } => {
            log::warn!(
                "oauth poll failed reason={}",
                crate::log_support::short_reason(&message)
            );
            Ok(DevicePollResult {
                status: "error".to_string(),
                message: Some(message),
            })
        }
    }
}

/// 当前 OAuth 登录用户；未登录返回 null。
#[tauri::command]
pub async fn get_oauth_user(
    state: State<'_, AppState>,
) -> Result<Option<crate::oauth::OAuthUser>, String> {
    let raw_stored: Option<String> = state
        .db
        .lock()
        .ok()
        .and_then(|db| {
            db.get_setting(crate::oauth::SETTING_OAUTH_USER)
                .ok()
                .flatten()
        })
        .filter(|s| !s.trim().is_empty());
    let stored: Option<crate::oauth::OAuthUser> = match raw_stored {
        Some(json) => match serde_json::from_str::<crate::oauth::OAuthUser>(&json) {
            Ok(u) => Some(u),
            Err(e) => {
                // 旧持久化缺字段无法解析：视为过期快照，清理后提示需重新登录。
                log::warn!(
                    "oauth user snapshot invalid reason={} action=clear-and-relogin",
                    crate::log_support::short_reason(&e.to_string())
                );
                if let Ok(db) = state.db() {
                    let _ = db.remove_setting(crate::oauth::SETTING_OAUTH_USER);
                }
                None
            }
        },
        None => None,
    };
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
        .and_then(|db| {
            db.get_setting(crate::oauth::SETTING_OAUTH_TOKEN)
                .ok()
                .flatten()
        })
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if is_oauth {
        if let Some(t) = token {
            match crate::oauth::fetch_oauth_user(&t).await {
                Ok(user) => {
                    if let Ok(db) = state.db() {
                        if let Ok(json) = serde_json::to_string(&user) {
                            let _ = db.set_setting(crate::oauth::SETTING_OAUTH_USER, &json);
                        }
                    }
                    return Ok(Some(user));
                }
                Err(e) => {
                    // 刷新/换 token 失败：warn，只记首行，不记 token。
                    log::warn!(
                        "oauth refresh failed reason={}",
                        crate::log_support::short_reason(&e)
                    );
                }
            }
        }
    }
    Ok(stored)
}

#[tauri::command]
pub async fn oauth_logout(state: State<'_, AppState>) -> Result<bool, String> {
    let fallback_pat = {
        let db = state.db()?;
        db.remove_setting(crate::oauth::SETTING_OAUTH_TOKEN)
            .map_err(|e| e.to_string())?;
        db.remove_setting(crate::oauth::SETTING_OAUTH_USER)
            .map_err(|e| e.to_string())?;
        db.get_host_token("github.com")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
    };
    if let Ok(mut t) = state.github_token.lock() {
        *t = fallback_pat.clone();
    }
    // Wave2：登出幂等去重 + sid 关联，清理行为每次都执行，INFO 窗口内只记一行。
    let sid = crate::z_log::new_session_id();
    let now = now_ms();
    let last = LAST_LOGOUT_INFO_MS.swap(now, Ordering::SeqCst);
    if now.saturating_sub(last) < LOGOUT_DEDUP_WINDOW_MS {
        log::debug!("oauth logout skipped reason=duplicate sid={}", sid);
    } else {
        log::info!("oauth logout ok sid={}", sid);
    }
    crate::probe_github_rate_limit(fallback_pat.as_deref()).await;
    Ok(true)
}

/// ADR-0010：GitHub Star 仅面向 owner/repo 形态的 canonical 应用标识
fn split_github_repo_id(app_id: &str) -> Result<(String, String), String> {
    let id = crate::forge::canonical_app_id(app_id)
        .ok_or_else(|| format!("GitHub Star 仅支持 owner/repo 仓库坐标: {}", app_id))?;
    let (owner, repo) = id
        .split_once('/')
        .ok_or_else(|| format!("GitHub Star 仅支持 owner/repo 仓库坐标: {}", app_id))?;
    if owner.is_empty() || repo.is_empty() || owner.contains(':') || repo.contains('/') {
        return Err(format!(
            "GitHub Star 仅支持 owner/repo 仓库坐标: {}",
            app_id
        ));
    }
    Ok((owner.to_string(), repo.to_string()))
}

/// H9：Star 本地缓存同步收敛（`star/unstar/is_starred` 三处共用，最佳努力）。
fn sync_star_cache(state: &AppState, owner: &str, repo: &str, starred: bool) {
    if let Ok(db) = state.db() {
        let _ = db.set_starred(owner, repo, starred);
    }
}

#[tauri::command]
pub async fn star_app(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<crate::oauth::StarRepoOutcome, String> {
    let (owner, repo) = split_github_repo_id(&app_id)?;
    let token = resolve_write_token(&state).ok_or_else(|| "请先完成 GitHub 登录".to_string())?;
    let outcome = crate::oauth::star_repo(&token, &owner, &repo).await?;
    if outcome.starred {
        sync_star_cache(&state, &owner, &repo, true);
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn unstar_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let (owner, repo) = split_github_repo_id(&app_id)?;
    let token = resolve_write_token(&state).ok_or_else(|| "请先完成 GitHub 登录".to_string())?;
    crate::oauth::unstar_repo(&token, &owner, &repo)
        .await
        .map(|_| {
            sync_star_cache(&state, &owner, &repo, false);
            true
        })
}

#[tauri::command]
pub async fn is_starred(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let (owner, repo) = split_github_repo_id(&app_id)?;
    let token = resolve_write_token(&state);
    if let Some(ref t) = token {
        if let Ok(remote_val) = crate::oauth::check_starred(t, &owner, &repo).await {
            sync_star_cache(&state, &owner, &repo, remote_val);
            return Ok(remote_val);
        }
    }
    let db = state.db()?;
    Ok(db.is_starred(&owner, &repo).unwrap_or(false))
}
