pub mod catalog;
pub mod forge;
pub mod history;
pub mod icons;
pub mod installer;
pub mod network;
pub mod oauth;
pub mod scanner;
pub mod settings;
pub mod system;
pub mod updates;

#[cfg(test)]
mod tests;

pub use catalog::*;
pub use forge::*;
pub use history::*;
pub use icons::*;
pub use installer::*;
pub use network::*;
pub use oauth::*;
pub use scanner::*;
pub use settings::*;
pub use system::*;
pub use updates::*;

pub use crate::installer::{resolve_uninstaller_command, select_best_asset, InstallerEngine};

use crate::AppState;

/// 获取当前生效的 GitHub API 访问令牌（OAuth 登录令牌优先，其次个人访问令牌 PAT，再次主机令牌）。
pub fn resolve_active_github_token(state: &AppState) -> Option<String> {
    if let Ok(t) = state.github_token.lock() {
        if let Some(ref tok) = *t {
            if !tok.trim().is_empty() {
                return Some(tok.trim().to_string());
            }
        }
    }
    if let Ok(db) = state.db.lock() {
        if let Ok(Some(t)) = db.get_setting(crate::oauth::SETTING_OAUTH_TOKEN) {
            let clean = t.trim().to_string();
            if !clean.is_empty() {
                if let Ok(mut mem) = state.github_token.lock() {
                    *mem = Some(clean.clone());
                }
                return Some(clean);
            }
        }
        if let Ok(Some(t)) = db.get_setting("github_token") {
            let clean = t.trim().to_string();
            if !clean.is_empty() {
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
    let override_id = state
        .db
        .lock()
        .ok()
        .and_then(|db| db.get_setting(crate::oauth::SETTING_OAUTH_CLIENT_ID).ok().flatten());
    crate::oauth::resolve_oauth_client_id(override_id.as_deref())
}

pub(crate) fn resolve_write_token(state: &AppState) -> Option<String> {
    resolve_active_github_token(state)
}
