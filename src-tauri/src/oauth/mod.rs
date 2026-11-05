//! GitHub OAuth Device Flow 与 Star 操作（FR-7.1 / FR-7.2、FR-6.3 手动同步）。
//!
//! 说明：
//! - Device Flow 无需应用密钥（secret），客户端仅需 `client_id`；
//!   解析优先级：设置项覆盖（`github_oauth_client_id`）＞ 全局配置（`config.toml` 中 `default_client_id`）；
//! - 申请 scope 为 `public_repo user`：`public_repo` 是 Star 写操作的最小 scope
//!   （`read:user` 等只读 scope 会返回 403/404），`user` 覆盖 GitHub Star List 管理；
//!   均不触碰任何私有仓库，符合最小权限原则。
//! - OAuth 令牌仅存于本地 SQLite（`user_settings.github_oauth_token`），永不打印日志。

pub mod constants;
pub mod device_flow;
pub mod http;
pub mod star;
pub mod types;

#[cfg(test)]
mod tests;

pub use constants::{
    default_oauth_client_id, resolve_oauth_client_id, OAUTH_CLIENT_ID_PLACEHOLDER,
    SETTING_OAUTH_CLIENT_ID, SETTING_OAUTH_TOKEN, SETTING_OAUTH_USER,
};
pub use device_flow::{poll_device_once, request_device_code};
pub use star::{check_starred, fetch_oauth_user, star_repo, starred_api_url, unstar_repo};
pub use types::{
    classify_device_poll, DevicePollOutcome, DeviceStartResult, OAuthUser, StarRepoOutcome,
};
