use super::CatalogService;

/// 开发者画像仓库列表单次拉取数量
pub const DEVELOPER_REPOS_PAGE_SIZE: usize = 30;
/// GitHub Starred 列表单页最大数量（GitHub 允许的最大上限，单次拉取最大化配额效益）
pub const GITHUB_STARRED_MAX_PAGE_SIZE: usize = 100;
/// GitHub API 基址（生产默认；测试经 `api_base` 覆写指向本地 mock，键仍用此基址保持与
/// `api_etag_cache` 表中既有 `https://api.github.com/...` 键一致）。
pub const GITHUB_API_BASE: &str = "https://api.github.com";
/// 配额护栏：单次 Star 同步中最多对多少个目录外仓库做 live `releases/latest` 探测。
/// 缓存命中不计入该预算；超限仓库保留旧行为（`has_releases: false`），不发网络请求。
pub const STARRED_RELEASE_ENRICH_LIMIT: usize = 20;

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

    /// 目录外 Star 仓库的 `releases/latest` 端点（canonical cache key，与
    /// `updates.rs`/`catalog.rs` 共用 `api_etag_cache` 表，零新 schema）。
    pub fn starred_release_endpoint(full_name: &str) -> String {
        let key = crate::forge::canonical_app_id(full_name)
            .unwrap_or_else(|| full_name.trim().to_lowercase());
        format!("{}/repos/{}/releases/latest", GITHUB_API_BASE, key)
    }

    /// 从缓存 payload（`GitHubReleaseResponse` JSON）提取 `tag_name`，独立真相源。
    pub fn parse_release_tag(payload: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(payload)
            .ok()?
            .get("tag_name")?
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
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

#[cfg(test)]
mod developer_endpoints_tests {
    use super::*;

    #[test]
    fn test_release_endpoint_key_matches_updates_ep_format() {
        // Cache key must equal the canonical release endpoint used by updates.rs/catalog.rs
        // so the existing api_etag_cache table is shared with zero new schema.
        let key = CatalogService::starred_release_endpoint("SomeOne/R1");
        assert_eq!(
            key,
            "https://api.github.com/repos/someone/r1/releases/latest"
        );
    }

    #[test]
    fn test_parse_release_tag_from_cached_payload() {
        let payload =
            serde_json::json!({"tag_name": "v3.1.4", "body": "", "assets": []}).to_string();
        assert_eq!(
            CatalogService::parse_release_tag(&payload).as_deref(),
            Some("v3.1.4")
        );
        assert!(CatalogService::parse_release_tag("{}").is_none());
        assert!(CatalogService::parse_release_tag("not-json").is_none());
    }
}
