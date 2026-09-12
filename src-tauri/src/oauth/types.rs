use serde::{Deserialize, Serialize};

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
    #[serde(default)]
    pub has_list_scope: bool,
    #[serde(default)]
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
