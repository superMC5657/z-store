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

pub mod backup;
pub mod constants;
pub mod device_flow;
pub mod star;
pub mod types;

#[cfg(test)]
mod tests;

pub use backup::{
    parse_import_payload, validate_app_id, ImportPlan, IMPORT_SETTINGS_ALLOWLIST,
};
pub use constants::{
    resolve_oauth_client_id, ACCESS_TOKEN_URL, DEVICE_CODE_URL, GITHUB_API_BASE,
    GITHUB_OAUTH_CLIENT_ID, OAUTH_CLIENT_ID_PLACEHOLDER, OAUTH_SCOPE, SETTING_OAUTH_CLIENT_ID,
    SETTING_OAUTH_TOKEN, SETTING_OAUTH_USER,
};
pub use device_flow::{poll_device_once, request_device_code};
pub use star::{
    add_repo_to_star_list, check_starred, fetch_oauth_user, star_repo, starred_api_url,
    unstar_repo,
};
pub use types::{
    classify_device_poll, AddToListOutcome, DeviceCodeResponse, DevicePollOutcome,
    DeviceStartResult, OAuthUser, StarRepoOutcome,
};
