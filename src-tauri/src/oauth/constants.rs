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

/// 获取默认配置的 Client ID（统一读取自 config.toml [oauth].default_client_id）
pub fn default_oauth_client_id() -> String {
    crate::config::get_project_config().oauth.default_client_id.clone()
}

/// 解析 OAuth Client ID：设置项覆盖优先；空值回退 config.toml 中的 default_client_id。
pub fn resolve_oauth_client_id(settings_override: Option<&str>) -> String {
    match settings_override.map(|s| s.trim()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => default_oauth_client_id(),
    }
}
