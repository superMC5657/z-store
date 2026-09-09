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
/// Device Flow 申请的 scope（public_repo + user，支持 Star 与 GitHub Star List 管理）。
pub const OAUTH_SCOPE: &str = "public_repo user";

pub const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
pub const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
pub const GITHUB_API_BASE: &str = "https://api.github.com";

/// 设置覆盖值优先；空值回退内置常量。
pub fn resolve_oauth_client_id(settings_override: Option<&str>) -> String {
    match settings_override.map(|s| s.trim()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => match option_env!("ZSTORE_GITHUB_OAUTH_CLIENT_ID") {
            Some(id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => crate::config::get_project_config().oauth.default_client_id.clone(),
        },
    }
}
