pub mod affinity;
#[cfg(test)]
mod affinity_eval_tests;
pub mod affinity_text;
pub mod asset_fetch;
pub mod catalog_feed_score;
pub mod catalog_service;
pub mod detail_assets;
pub mod detail_fetch;
pub mod developer_profile;
pub mod developer_starred;
#[cfg(test)]
mod developer_starred_tests;
pub mod discussions;
pub mod featured;
pub mod http;
pub mod markdown;
pub mod models;
pub mod readme_fetch;
pub mod readme_parse;
pub mod release_fetch;
pub mod search;

#[cfg(test)]
mod tests;

pub use models::CatalogItem;

use std::sync::RwLock;

/// 开发者画像仓库列表单次拉取数量
pub const DEVELOPER_REPOS_PAGE_SIZE: usize = 30;
/// GitHub Starred 列表单页最大数量（GitHub 允许的最大上限，单次拉取最大化配额效益）
pub const GITHUB_STARRED_MAX_PAGE_SIZE: usize = 100;
/// GitHub API 基址（生产默认；测试经 `api_base` 覆写指向本地 mock，键仍用此基址保持与
/// `api_etag_cache` 表中既有 `https://api.github.com/...` 键一致）。
pub const GITHUB_API_BASE: &str = "https://api.github.com";

pub struct CatalogService {
    pub(crate) items: RwLock<Vec<CatalogItem>>,
    /// 本地收录 overlay（`custom_apps` 中 collected 系/`submitted` 且未归档行），
    /// 由 `sync_collected_from_db` 在启动与 `custom_apps` 变更后同步；远端优先去重。
    pub(crate) collected: RwLock<Vec<CatalogItem>>,
    /// 清单专属连接池（无 Token，跟随系统代理快照热重建），经 [`CatalogService::http_client`] 取用。
    pub(crate) client: crate::proxy::ClientSlot,
}

impl CatalogService {
    /// 开发者画像用户端点（canonical cache key，直存 `api_etag_cache.endpoint_url`）。
    pub fn dev_user_endpoint(developer: &str) -> String {
        format!("{}/users/{}", GITHUB_API_BASE, developer.trim())
    }

    /// 开发者画像仓库列表端点（canonical cache key）。
    pub fn dev_repos_endpoint(developer: &str) -> String {
        format!(
            "{}/users/{}/repos?sort=updated&per_page={}",
            GITHUB_API_BASE,
            developer.trim(),
            DEVELOPER_REPOS_PAGE_SIZE
        )
    }

    /// canonical key → 实际请求 URL（测试覆写 `api_base` 时仅换前缀，key 不变）。
    pub(crate) fn request_url(canonical_url: &str, api_base: Option<&str>) -> String {
        match api_base {
            Some(base) if !base.trim().is_empty() => {
                let base = base.trim().trim_end_matches('/');
                if let Some(rest) = canonical_url.strip_prefix(GITHUB_API_BASE) {
                    format!("{}{}", base, rest)
                } else {
                    canonical_url.to_string()
                }
            }
            _ => canonical_url.to_string(),
        }
    }
}
