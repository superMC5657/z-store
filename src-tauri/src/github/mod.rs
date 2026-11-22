pub mod affinity;
#[cfg(test)]
mod affinity_eval_tests;
pub mod affinity_text;
pub mod alternatives;
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

/// GitHub `/repos/{owner}/{repo}` 端点（`api_etag_cache` 键）。`owner`/`repo` 段一律
/// percent-encoding，所有调用点共用以保证缓存键与请求 URL 同形。
pub fn github_repo_endpoint(owner: &str, repo: &str) -> String {
    format!(
        "{}/repos/{}/{}",
        GITHUB_API_BASE,
        urlencoding::encode(owner),
        urlencoding::encode(repo)
    )
}

/// GitHub `/repos/{owner}/{repo}/releases/latest` 端点（编码口径同 [`github_repo_endpoint`]）。
pub fn github_latest_release_endpoint(owner: &str, repo: &str) -> String {
    format!("{}/releases/latest", github_repo_endpoint(owner, repo))
}

/// GitHub `/repos/{owner}/{repo}/readme` 端点（编码口径同 [`github_repo_endpoint`]）。
pub fn github_readme_endpoint(owner: &str, repo: &str) -> String {
    format!("{}/readme", github_repo_endpoint(owner, repo))
}

pub struct CatalogService {
    /// 远端精选目录与本地收录 overlay（`custom_apps` 中 collected 系/`submitted` 且未归档行）
    /// 的带索引存储；同一把锁保证两侧与派生缓存（IDF、别名）一致。
    pub(crate) store: RwLock<catalog_service::CatalogStore>,
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
