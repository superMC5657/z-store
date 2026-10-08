pub mod catalog;
pub mod forge;
pub mod history;
pub mod icons;
pub mod installer;
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
pub mod updates;

#[cfg(test)]
mod tests;

pub use catalog::*;
pub use forge::*;
pub use history::*;
pub use icons::*;
pub use installer::*;
pub use installer_download::*;
pub use network::*;
pub use oauth::*;
pub use scanner::*;
pub use settings::*;
pub use system::*;
pub use trends_cache::*;
pub use updates::*;

pub use catalog::{catalog_detail, catalog_feed, catalog_search, catalog_sync};
pub use icons::icons_cycle;
pub use updates::{updates_check, updates_rules};

pub use crate::error::{AppError, AppResult};
pub use crate::installer::{resolve_uninstaller_command, select_best_asset, InstallerEngine};

use crate::AppState;

/// H6：入站 `app_id` 统一归一化守卫（ADR-0010）。
/// 成功返回 canonical id；未知标识直接拒绝，调用方永不触碰 SQLite。
pub(crate) fn require_app_id(raw: &str) -> Result<String, String> {
    crate::forge::canonical_app_id(raw).ok_or_else(|| format!("无法识别的应用标识: {}", raw))
}

/// 获取当前生效的 GitHub API 访问令牌（OAuth 登录令牌优先，其次主机令牌）。
pub fn resolve_active_github_token(state: &AppState) -> Option<String> {
    if let Ok(t) = state.github_token.lock() {
        if let Some(ref tok) = *t {
            if !tok.trim().is_empty() {
                return Some(tok.trim().to_string());
            }
        }
    }
    if let Ok(db) = state.db() {
        if let Ok(Some(t)) = db.get_setting(crate::oauth::SETTING_OAUTH_TOKEN) {
            let clean = t.trim().to_string();
            if !clean.is_empty() {
                if let Ok(mut mem) = state.github_token.lock() {
                    *mem = Some(clean.clone());
                }
                return Some(clean);
            }
        }
        if let Ok(Some(t)) = db.get_host_token("github.com") {
            let clean = t.trim().to_string();
            if !clean.is_empty() {
                return Some(clean);
            }
        }
    }
    None
}

pub(crate) fn resolve_oauth_client_id_from_db(state: &AppState) -> String {
    let override_id = state.db().ok().and_then(|db| {
        db.get_setting(crate::oauth::SETTING_OAUTH_CLIENT_ID)
            .ok()
            .flatten()
    });
    crate::oauth::resolve_oauth_client_id(override_id.as_deref())
}

pub(crate) fn resolve_write_token(state: &AppState) -> Option<String> {
    resolve_active_github_token(state)
}
