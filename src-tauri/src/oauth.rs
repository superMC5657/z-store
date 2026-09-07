//! GitHub OAuth Device Flow、Star 操作与用户数据导入（FR-7.1 / FR-7.2、FR-6.3 手动同步）。
//!
//! 说明：
//! - Device Flow 无需应用密钥（secret），客户端仅需 `client_id`；
//!   解析优先级：设置项覆盖（`github_oauth_client_id`）＞ 编译期环境变量
//!   （`ZSTORE_GITHUB_OAUTH_CLIENT_ID`）＞ 内置默认；
//! - 申请 scope 为 `public_repo`：Star 本质是对公开仓库的写操作，
//!   `public_repo` 是仍能 Star 的最小 scope（`read:user` 等只读 scope
//!   会返回 403/404），且不触碰任何私有仓库，符合最小权限原则。
//! - OAuth 令牌仅存于本地 SQLite（`user_settings.github_oauth_token`），永不打印日志。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 未配置 Client ID 时的占位；命中它意味着 Device Flow 无法发起。
pub const OAUTH_CLIENT_ID_PLACEHOLDER: &str = "YOUR_CLIENT_ID_HERE";
/// 内置 OAuth App Client ID：编译期环境变量 `ZSTORE_GITHUB_OAUTH_CLIENT_ID`
/// 优先（CI 打包机注入；空字符串视为未设置，回退内置默认），未设置时回退内置默认；
/// 仍为占位则视为未配置，调用方可对比 `OAUTH_CLIENT_ID_PLACEHOLDER` 判定。
/// 用户亦可在设置中填写 `github_oauth_client_id` 覆盖（设置值优先，见 commands）。
pub const GITHUB_OAUTH_CLIENT_ID: &str = match option_env!("ZSTORE_GITHUB_OAUTH_CLIENT_ID") {
    Some(id) if !id.is_empty() => id,
    _ => "Ov23lik0b7fDGMLTiOYH",
};
/// 设置项键：覆盖内置 Client ID。
pub const SETTING_OAUTH_CLIENT_ID: &str = "github_oauth_client_id";
/// 设置项键：持久化 OAuth 访问令牌。
pub const SETTING_OAUTH_TOKEN: &str = "github_oauth_token";
/// 设置项键：持久化 OAuth 登录用户（JSON：`{login, avatar_url}`）。
pub const SETTING_OAUTH_USER: &str = "github_oauth_user";
/// Device Flow 申请的最小 scope（仍能 Star，见模块注释）。
pub const OAUTH_SCOPE: &str = "public_repo";

pub const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
pub const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
pub const GITHUB_API_BASE: &str = "https://api.github.com";

/// 设置覆盖值优先；空值回退内置常量。
pub fn resolve_oauth_client_id(settings_override: Option<&str>) -> String {
    match settings_override.map(|s| s.trim()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => GITHUB_OAUTH_CLIENT_ID.to_string(),
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
struct DevicePollBody {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
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
            message: parsed.error_description.unwrap_or_else(|| {
                format!("授权失败（{}），请重新开始授权", other)
            }),
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuthUser {
    pub login: String,
    pub avatar_url: String,
}

/// Star API 地址构造（纯函数）。
pub fn starred_api_url(owner: &str, repo: &str) -> String {
    format!(
        "{}/user/starred/{}/{}",
        GITHUB_API_BASE,
        owner.trim(),
        repo.trim()
    )
}

/// 用户数据导入：允许合入设置项的白名单（仅主题/语言/缓存保鲜期/关注通知频率）。
pub const IMPORT_SETTINGS_ALLOWLIST: &[&str] = &[
    "theme",
    "language",
    "detail_cache_ttl_minutes",
    "watch_notify_frequency",
];

/// 校验应用 ID 形态（纯函数）：非空、仅含常规仓库坐标字符。
/// 接受 `owner/repo`、`gh:owner/repo`、`cb:owner/repo` 等收录库 ID 形态。
pub fn validate_app_id(app_id: &str) -> bool {
    let id = app_id.trim();
    if id.is_empty() || id.len() > 200 {
        return false;
    }
    if id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '/' | ':' | '.' | '-' | '_' | '+'))
    {
        return false;
    }
    id.chars().any(|c| c.is_alphanumeric())
}

#[derive(Debug, Clone, Deserialize)]
struct ImportPayload {
    version: i32,
    #[serde(default)]
    favorites: Vec<serde_json::Value>,
    #[serde(default)]
    watched: Vec<serde_json::Value>,
    #[serde(default)]
    settings: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportPlan {
    pub favorites: Vec<String>,
    pub watched: Vec<String>,
    pub settings: Vec<(String, String)>,
}

/// 解析并清洗导入 JSON（纯函数）：版本必须为 1；非法 ID 与非白名单
/// 设置项直接丢弃；`settings` 值统一转字符串。
pub fn parse_import_payload(json: &str) -> Result<ImportPlan, String> {
    let payload: ImportPayload =
        serde_json::from_str(json).map_err(|e| format!("导入数据不是有效的 JSON: {}", e))?;
    if payload.version != 1 {
        return Err(format!(
            "不支持的导入数据版本: {}（仅支持 version 1）",
            payload.version
        ));
    }

    let clean_ids = |vals: &[serde_json::Value]| -> Vec<String> {
        let mut out = Vec::new();
        for v in vals {
            if let Some(s) = v.as_str() {
                let t = s.trim().to_string();
                if validate_app_id(&t) && !out.contains(&t) {
                    out.push(t);
                }
            }
        }
        out
    };

    let mut settings = Vec::new();
    for (k, v) in &payload.settings {
        if !IMPORT_SETTINGS_ALLOWLIST.contains(&k.as_str()) {
            continue;
        }
        let s = match v {
            serde_json::Value::String(s) => s.trim().to_string(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        if !s.is_empty() {
            settings.push((k.clone(), s));
        }
    }

    Ok(ImportPlan {
        favorites: clean_ids(&payload.favorites),
        watched: clean_ids(&payload.watched),
        settings,
    })
}

/// 发起 Device Flow：向 GitHub 申请 `device_code` 与用户验证码。
pub async fn request_device_code(client_id: &str) -> Result<DeviceStartResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建网络请求失败: {}", e))?;
    let resp = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "ZStore-Client/0.1.0")
        .json(&serde_json::json!({
            "client_id": client_id,
            "scope": OAUTH_SCOPE,
        }))
        .send()
        .await
        .map_err(|e| format!("连接 GitHub 授权服务失败: {}。如遇国内网络阻断，请检查网络设置。", e))?;
    if !resp.status().is_success() {
        return Err(format!("申请设备验证码失败，HTTP 状态码: {}", resp.status()));
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建网络请求失败: {}", e))?;
    let resp = client
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "ZStore-Client/0.1.0")
        .json(&serde_json::json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()
        .await
        .map_err(|e| format!("连接 GitHub 授权服务失败: {}", e))?;
    let text = resp.text().await.map_err(|e| format!("读取授权响应失败: {}", e))?;
    Ok(classify_device_poll(&text))
}

/// 构建带认证头的 GitHub API 客户端（令牌仅放 header，永不落日志）。
fn authed_client(token: &str) -> Result<reqwest::Client, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建网络请求失败: {}", e))?;
    let _ = token;
    Ok(client)
}

fn auth_headers(token: &str) -> Result<reqwest::header::HeaderMap, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("ZStore-Client/0.1.0"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github.v3+json"),
    );
    let v = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.trim()))
        .map_err(|_| "认证令牌格式无效".to_string())?;
    headers.insert(reqwest::header::AUTHORIZATION, v);
    Ok(headers)
}

/// 拉取当前令牌对应的 GitHub 用户（`login` + `avatar_url`）。
pub async fn fetch_oauth_user(token: &str) -> Result<OAuthUser, String> {
    let client = authed_client(token)?;
    let resp = client
        .get(format!("{}/user", GITHUB_API_BASE))
        .headers(auth_headers(token)?)
        .send()
        .await
        .map_err(|e| format!("获取 GitHub 用户信息失败: {}", e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    if resp.status().as_u16() == 401 {
        return Err("GitHub 授权已失效 (401)，请重新登录".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("获取 GitHub 用户信息失败，HTTP 状态码: {}", resp.status()));
    }
    #[derive(Deserialize)]
    struct UserBody {
        login: String,
        #[serde(default)]
        avatar_url: Option<String>,
    }
    let body: UserBody = resp.json().await.map_err(|e| format!("解析用户信息失败: {}", e))?;
    Ok(OAuthUser {
        login: body.login.clone(),
        avatar_url: body
            .avatar_url
            .unwrap_or_else(|| format!("https://github.com/{}.png", body.login)),
    })
}

/// 查询是否已 Star（204 = 已 Star，404 = 未 Star）。
pub async fn check_starred(token: &str, owner: &str, repo: &str) -> Result<bool, String> {
    let client = authed_client(token)?;
    let resp = client
        .get(starred_api_url(owner, repo))
        .headers(auth_headers(token)?)
        .send()
        .await
        .map_err(|e| format!("查询 Star 状态失败: {}", e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    match resp.status().as_u16() {
        204 => Ok(true),
        404 => Ok(false),
        401 => Err("GitHub 授权已失效 (401)，请重新登录".to_string()),
        403 => Err("GitHub API 限额已耗尽 (403)，请稍后重试".to_string()),
        code => Err(format!("查询 Star 状态失败，HTTP 状态码: {}", code)),
    }
}

/// Star 指定仓库（幂等，PUT 成功返回 204）。
pub async fn star_repo(token: &str, owner: &str, repo: &str) -> Result<(), String> {
    let client = authed_client(token)?;
    let resp = client
        .put(starred_api_url(owner, repo))
        .headers(auth_headers(token)?)
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| format!("Star 失败: {}", e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    if resp.status().is_success() {
        Ok(())
    } else if resp.status().as_u16() == 401 {
        Err("GitHub 授权已失效 (401)，请重新登录".to_string())
    } else if resp.status().as_u16() == 403 {
        Err("Star 失败 (403)：令牌缺少 public_repo 权限或 API 限额已耗尽".to_string())
    } else {
        Err(format!("Star 失败，HTTP 状态码: {}", resp.status()))
    }
}

/// 取消 Star（幂等，DELETE 成功返回 204）。
pub async fn unstar_repo(token: &str, owner: &str, repo: &str) -> Result<(), String> {
    let client = authed_client(token)?;
    let resp = client
        .delete(starred_api_url(owner, repo))
        .headers(auth_headers(token)?)
        .send()
        .await
        .map_err(|e| format!("取消 Star 失败: {}", e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    if resp.status().is_success() {
        Ok(())
    } else if resp.status().as_u16() == 401 {
        Err("GitHub 授权已失效 (401)，请重新登录".to_string())
    } else {
        Err(format!("取消 Star 失败，HTTP 状态码: {}", resp.status()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_client_id_override() {
        assert_eq!(
            resolve_oauth_client_id(Some("  abc123  ")),
            "abc123".to_string()
        );
        assert_eq!(
            resolve_oauth_client_id(Some("")),
            GITHUB_OAUTH_CLIENT_ID.to_string()
        );
        assert_eq!(resolve_oauth_client_id(None), GITHUB_OAUTH_CLIENT_ID.to_string());
    }

    #[test]
    fn test_classify_device_poll_state_machine() {
        // 等待中
        assert_eq!(
            classify_device_poll(r#"{"error":"authorization_pending","error_description":"pending"}"#),
            DevicePollOutcome::Pending {
                message: "等待用户在浏览器中完成授权".to_string()
            }
        );
        assert_eq!(
            classify_device_poll(r#"{"error":"slow_down","error_description":"slow"}"#),
            DevicePollOutcome::Pending {
                message: "轮询过于频繁，已自动放慢等待用户授权".to_string()
            }
        );
        // 已授权
        assert_eq!(
            classify_device_poll(r#"{"access_token":"gho_abc","token_type":"bearer","scope":"public_repo"}"#),
            DevicePollOutcome::Authorized {
                access_token: "gho_abc".to_string()
            }
        );
        // 过期 / 拒绝（独立状态，前端可分别提示）
        assert!(matches!(
            classify_device_poll(r#"{"error":"expired_token"}"#),
            DevicePollOutcome::Expired { .. }
        ));
        assert_eq!(
            classify_device_poll(r#"{"error":"access_denied","error_description":"no"}"#),
            DevicePollOutcome::Denied {
                message: "用户拒绝了授权请求".to_string()
            }
        );
        // 未知错误透出描述
        assert_eq!(
            classify_device_poll(r#"{"error":"incorrect_device_code","error_description":"bad code"}"#),
            DevicePollOutcome::Error {
                message: "bad code".to_string()
            }
        );
        // 非 JSON 体
        assert!(matches!(
            classify_device_poll("not json at all"),
            DevicePollOutcome::Error { .. }
        ));
        // 空令牌视为错误而非授权
        assert!(matches!(
            classify_device_poll(r#"{"access_token":"  "}"#),
            DevicePollOutcome::Error { .. }
        ));
    }

    #[test]
    fn test_validate_app_id() {
        assert!(validate_app_id("rustdesk/rustdesk"));
        assert!(validate_app_id("rustdesk"));
        assert!(validate_app_id("gh:rustdesk/rustdesk"));
        assert!(validate_app_id("cb:owner/repo"));
        assert!(!validate_app_id(""));
        assert!(!validate_app_id("   "));
        assert!(!validate_app_id("owner/repo with space"));
        assert!(!validate_app_id("a\nb"));
        assert!(!validate_app_id("///"));
        assert!(!validate_app_id("rm -rf /"));
    }

    #[test]
    fn test_parse_import_payload_merge_rules() {
        let json = r#"{
            "version": 1,
            "favorites": ["rustdesk", " vlc ", "bad id!", 123, "rustdesk"],
            "watched": ["localsend", ""],
            "settings": {
                "theme": "dark",
                "language": "en",
                "detail_cache_ttl_minutes": 60,
                "watch_notify_frequency": "daily",
                "evil_key": "rm -rf",
                "github_token": "should-be-ignored"
            }
        }"#;
        let plan = parse_import_payload(json).expect("合法导入 JSON 应当解析成功");
        assert_eq!(plan.favorites, vec!["rustdesk".to_string(), "vlc".to_string()]);
        assert_eq!(plan.watched, vec!["localsend".to_string()]);
        // 仅白名单设置项通过，数值转字符串
        let mut keys: Vec<&str> = plan.settings.iter().map(|(k, _)| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "detail_cache_ttl_minutes",
                "language",
                "theme",
                "watch_notify_frequency"
            ]
        );
        assert!(plan.settings.contains(&(
            "detail_cache_ttl_minutes".to_string(),
            "60".to_string()
        )));

        // 非法版本拒绝
        assert!(parse_import_payload(r#"{"version": 2}"#).is_err());
        // 非 JSON 拒绝
        assert!(parse_import_payload("not json").is_err());
        // 缺省字段视为空
        let minimal = parse_import_payload(r#"{"version": 1}"#).unwrap();
        assert!(minimal.favorites.is_empty());
        assert!(minimal.watched.is_empty());
        assert!(minimal.settings.is_empty());
    }

    #[test]
    fn test_starred_api_url() {
        assert_eq!(
            starred_api_url("rustdesk", "rustdesk"),
            "https://api.github.com/user/starred/rustdesk/rustdesk"
        );
    }
}
