//! GitHub OAuth Device Flow 与 Star 操作及用户资料同步。
//!
//! 说明：
//! - Device Flow 无需应用密钥（secret），客户端仅需 `client_id`；
//!   解析优先级：设置项覆盖（`github_oauth_client_id`）＞ 全局配置（`config.toml` 中 `default_client_id`）；
//! - 申请 scope 为 `public_repo user`：`public_repo` 是 Star 写操作的最小 scope
//!   （`read:user` 等只读 scope 会返回 403/404），`user` 覆盖 GitHub Star List 管理；
//!   均不触碰任何私有仓库，符合最小权限原则。
//! - OAuth 令牌仅存于本地 SQLite（`user_settings.github_oauth_token`），永不打印日志。

pub mod star;

#[cfg(test)]
mod tests;

pub use star::{check_starred, fetch_oauth_user, star_repo, starred_api_url, unstar_repo};

use serde::{Deserialize, Serialize};

/// 未配置 Client ID 时的占位；命中它意味着 Device Flow 无法发起。
pub const OAUTH_CLIENT_ID_PLACEHOLDER: &str = "YOUR_CLIENT_ID_HERE";

/// 设置项键：覆盖内置 Client ID。
pub const SETTING_OAUTH_CLIENT_ID: &str = "github_oauth_client_id";
/// 设置项键：持久化 OAuth 访问令牌。
pub const SETTING_OAUTH_TOKEN: &str = "github_oauth_token";
/// 设置项键：持久化 OAuth 登录用户（JSON：`{login, avatar_url}`）。
pub const SETTING_OAUTH_USER: &str = "github_oauth_user";
/// Device Flow 申请的 scope（public_repo + user，支持 Star 与 GitHub Star List 管理）。
pub const OAUTH_SCOPE: &str = "public_repo user";

pub const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
pub const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
pub const GITHUB_API_BASE: &str = "https://api.github.com";
/// L1：Device Flow 授权轮询 grant_type（RFC 8628 `device_code` 固定值）。
pub const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// 获取默认配置的 Client ID（统一读取自 config.toml [oauth].default_client_id）
pub fn default_oauth_client_id() -> String {
    crate::config::get_project_config()
        .oauth
        .default_client_id
        .clone()
}

/// 解析 OAuth Client ID：设置项覆盖优先；空值回退 config.toml 中的 default_client_id。
pub fn resolve_oauth_client_id(settings_override: Option<&str>) -> String {
    match settings_override.map(|s| s.trim()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => default_oauth_client_id(),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceStartResult {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

impl From<DeviceCodeResponse> for DeviceStartResult {
    fn from(r: DeviceCodeResponse) -> Self {
        Self {
            device_code: r.device_code,
            user_code: r.user_code,
            verification_uri: r.verification_uri_complete.unwrap_or(r.verification_uri),
            expires_in: r.expires_in,
            interval: r.interval,
        }
    }
}

/// Device 轮询的归一化结果（纯状态机，可单元测试）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePollOutcome {
    /// 仍在等待用户授权（`authorization_pending` / `slow_down`）。
    Pending { message: String },
    /// 用户已授权，携带访问令牌。
    Authorized { access_token: String },
    /// 设备码过期（GitHub 侧约 15 分钟有效；需重新发起登录）。
    Expired { message: String },
    /// 用户拒绝授权。
    Denied { message: String },
    /// 失败（网络与协议错误等）。
    Error { message: String },
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct DevicePollBody {
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_description: Option<String>,
}

/// 解析 `/login/oauth/access_token` 轮询响应体为状态机结果（纯函数）。
pub fn classify_device_poll(body: &str) -> DevicePollOutcome {
    let parsed: Result<DevicePollBody, _> = serde_json::from_str(body);
    let parsed = match parsed {
        Ok(p) => p,
        Err(_) => {
            return DevicePollOutcome::Error {
                message: "授权轮询响应无法解析，请稍后重试".to_string(),
            };
        }
    };
    if let Some(token) = parsed.access_token {
        if !token.trim().is_empty() {
            return DevicePollOutcome::Authorized {
                access_token: token,
            };
        }
    }
    match parsed.error.as_deref().unwrap_or("") {
        "authorization_pending" => DevicePollOutcome::Pending {
            message: "等待用户在浏览器中完成授权".to_string(),
        },
        "slow_down" => DevicePollOutcome::Pending {
            message: "轮询过于频繁，已自动放慢等待用户授权".to_string(),
        },
        "expired_token" => DevicePollOutcome::Expired {
            message: "设备验证码已过期，请重新开始授权".to_string(),
        },
        "access_denied" => DevicePollOutcome::Denied {
            message: "用户拒绝了授权请求".to_string(),
        },
        "" => DevicePollOutcome::Error {
            message: parsed
                .error_description
                .unwrap_or_else(|| "授权轮询失败，请稍后重试".to_string()),
        },
        other => DevicePollOutcome::Error {
            message: parsed
                .error_description
                .unwrap_or_else(|| format!("授权失败（{}），请重新开始授权", other)),
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuthUser {
    pub login: String,
    pub avatar_url: String,
    pub has_list_scope: bool,
    pub is_expired: bool,
}

/// 添加到 Star 清单的结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddToListOutcome {
    Success,
    InsufficientScopes,
    OrgRestricted(String),
    Failed(String),
}

/// 标星与清单归类结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StarRepoOutcome {
    pub starred: bool,
    pub in_list: bool,
    pub warning: Option<String>,
}

/// 带认证通用请求：Star 三函数共用（send + rate_limit 上报收敛于此）。
pub(crate) async fn authed_req(
    method: reqwest::Method,
    url: &str,
    token: &str,
    body: Option<serde_json::Value>,
    send_err: &str,
) -> Result<reqwest::Response, String> {
    let mut req = crate::shared_http_client()
        .request(method.clone(), url)
        .headers(star::auth_headers(token)?);
    if method == reqwest::Method::PUT && body.is_none() {
        req = req.header("Content-Length", "0");
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("{}: {}", send_err, e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    Ok(resp)
}

/// 401/403 统一映射：文案由调用方传入，不可硬合并（各 op 的 403 语义不同）。
/// 命中返回 Err(文案)，未命中返回 Ok(()) 由调用方继续处理其他状态码。
pub(crate) fn map_auth_status(
    code: u16,
    op_ctx: &str,
    unauthorized_msg: &str,
    forbidden_msg: &str,
) -> Result<(), String> {
    if code == 401 {
        crate::check_auth_expired(code, op_ctx);
        return Err(unauthorized_msg.to_string());
    }
    if code == 403 {
        let mut ev = crate::z_log::WideEvent::new("oauth", "forbidden");
        ev.field("status", 403).dev("ctx", op_ctx);
        ev.warn();
        return Err(forbidden_msg.to_string());
    }
    Ok(())
}

/// Device Flow 共用 POST：JsonApi 预设 + json body 收敛于此，调用方自行映射 transport 错误以保留文案差异。
async fn post_oauth_json(
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, reqwest::Error> {
    crate::shared_http_client()
        .post(url)
        .headers(crate::forge::http::preset_headers(
            crate::forge::http::ApiPreset::JsonApi,
            None,
            crate::forge::http::AuthScheme::Bearer,
        ))
        .json(body)
        .send()
        .await
}

/// 发起 Device Flow：向 GitHub 申请 `device_code` 与用户验证码。
pub async fn request_device_code(client_id: &str) -> Result<DeviceStartResult, String> {
    let resp = post_oauth_json(
        DEVICE_CODE_URL,
        &serde_json::json!({
            "client_id": client_id,
            "scope": OAUTH_SCOPE,
        }),
    )
    .await
    .map_err(|e| {
        format!(
            "连接 GitHub 授权服务失败: {}。如遇国内网络阻断，请检查网络设置。",
            e
        )
    })?;
    if !resp.status().is_success() {
        return Err(format!(
            "申请设备验证码失败，HTTP 状态码: {}",
            resp.status()
        ));
    }
    let body: DeviceCodeResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析设备验证码响应失败: {}", e))?;
    Ok(body.into())
}

/// 单次轮询授权结果；调用方按返回的 `interval` 节流。
pub async fn poll_device_once(
    client_id: &str,
    device_code: &str,
) -> Result<DevicePollOutcome, String> {
    let resp = post_oauth_json(
        ACCESS_TOKEN_URL,
        &serde_json::json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": DEVICE_GRANT_TYPE,
        }),
    )
    .await
    .map_err(|e| format!("连接 GitHub 授权服务失败: {}", e))?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取授权响应失败: {}", e))?;
    Ok(classify_device_poll(&text))
}

/// 快照缺失或未标记权限范围时需实时补拉（纯谓词，可单元测试）。
/// `is_expired` 快照原样返回（前端处理重登），`has_list_scope` 快照直接返回；
/// 其余情况（无快照/损坏快照/未标记 scope）有令牌则补拉一次。
pub fn should_refetch_oauth_user(stored: Option<&OAuthUser>) -> bool {
    match stored {
        None => true,
        Some(u) if u.is_expired => false,
        Some(u) if u.has_list_scope => false,
        _ => true,
    }
}

/// 从本地 DB 读取 OAuth 用户快照及是否持有 OAuth 令牌。
pub fn load_oauth_user_snapshot(db: &crate::db::Database) -> (Option<OAuthUser>, bool) {
    let stored = db
        .get_setting(SETTING_OAUTH_USER)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .and_then(|json| serde_json::from_str::<OAuthUser>(&json).ok());
    let has_oauth_token = db
        .get_setting(SETTING_OAUTH_TOKEN)
        .ok()
        .flatten()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    (stored, has_oauth_token)
}

/// 持久化 OAuth 登录令牌与用户快照。
pub fn save_oauth_session(db: &crate::db::Database, token: &str, user: Option<&OAuthUser>) {
    let _ = db.set_setting(SETTING_OAUTH_TOKEN, token);
    if let Some(u) = user {
        save_oauth_user_snapshot(db, u);
    }
}

/// 持久化 OAuth 用户快照。
pub fn save_oauth_user_snapshot(db: &crate::db::Database, user: &OAuthUser) {
    if let Ok(json) = serde_json::to_string(user) {
        let _ = db.set_setting(SETTING_OAUTH_USER, &json);
    }
}

/// 清除 OAuth 登录态与 GitHub 账号特征信号，并返回回退主机令牌（如 PAT）。
pub fn clear_oauth_session(db: &crate::db::Database) -> Result<Option<String>, String> {
    db.remove_setting(SETTING_OAUTH_TOKEN)
        .map_err(|e| e.to_string())?;
    db.remove_setting(SETTING_OAUTH_USER)
        .map_err(|e| e.to_string())?;
    let _ = db.clear_github_account_signals();
    let _ = db.delete_etags_by_prefix("https://api.github.com/user/");
    Ok(db
        .get_host_token("github.com")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty()))
}

/// ADR-0010：GitHub Star 仅面向 owner/repo 形态的 canonical 应用标识。
pub fn split_github_repo_id(app_id: &str) -> Result<(String, String), String> {
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

/// Star 本地缓存同步（仅在实际状态变更时通知画像刷新）。
pub fn sync_star_cache(db: &crate::db::Database, owner: &str, repo: &str, starred: bool) {
    let prev = db.is_starred(owner, repo).unwrap_or(false);
    let _ = db.set_starred(owner, repo, starred);
    if !starred {
        let full_name = crate::forge::canonical_app_id_from_parts(owner, repo);
        let _ = db.remove_user_repo_signal(&full_name, crate::db::RepoRelation::Starred.as_str());
    }
    if prev != starred {
        crate::notify_affinity_updated();
    }
}
