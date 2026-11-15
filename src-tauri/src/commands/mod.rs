pub mod catalog_custom;
pub mod catalog_detail;
pub mod catalog_featured;
pub mod catalog_feed;
pub mod catalog_search;
pub mod catalog_sync;
pub mod forge;
pub mod history;
pub mod icons;
pub mod installer_download;
pub mod installer_install;
pub mod installer_query;
pub mod installer_uninstall;
pub mod network;
pub mod oauth;
pub mod scanner;
pub mod settings;
pub mod system;
pub mod trends_cache;
pub mod updates_check;
pub mod updates_rules;

#[cfg(test)]
mod tests;

pub use catalog_custom::*;
pub use catalog_detail::*;
pub use catalog_featured::*;
pub use catalog_feed::*;
pub use catalog_search::*;
pub use catalog_sync::*;
pub use forge::*;
pub use history::*;
pub use icons::*;
pub use installer_download::*;
pub use installer_install::*;
pub use installer_query::*;
pub use installer_uninstall::*;
pub use network::*;
pub use oauth::*;
pub use scanner::*;
pub use settings::*;
pub use system::*;
pub use trends_cache::*;
pub use updates_check::*;
pub use updates_rules::*;

pub use crate::installer::{resolve_uninstaller_command, select_best_asset};

use crate::AppState;

/// 入站 `app_id` 统一归一化守卫（ADR-0010）。
/// 成功返回 canonical id；未知标识直接拒绝，调用方永不触碰 SQLite。
pub(crate) fn require_app_id(raw: &str) -> Result<String, String> {
    crate::forge::canonical_app_id(raw).ok_or_else(|| format!("无法识别的应用标识: {}", raw))
}

/// 获取当前生效的 GitHub API 访问令牌（OAuth 登录令牌优先，其次主机令牌）。
pub fn resolve_active_github_token(state: &AppState) -> Option<String> {
    state.active_github_token()
}

pub(crate) fn resolve_oauth_client_id_from_db(state: &AppState) -> String {
    let override_id = state.db().ok().and_then(|db| {
        db.get_setting(crate::oauth::SETTING_OAUTH_CLIENT_ID)
            .ok()
            .flatten()
    });
    crate::oauth::resolve_oauth_client_id(override_id.as_deref())
}
