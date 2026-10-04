use super::coord::ForgeType;
use super::http::{api_headers, new_api_client, AuthScheme, HttpSpan, JSON_ACCEPT_VALUE};
use super::provider::{parse_assets, ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};
use serde::Deserialize;

pub struct GiteaProvider {
    pub forge_type: ForgeType,
}

impl GiteaProvider {
    pub fn new(forge_type: ForgeType) -> Self {
        Self { forge_type }
    }
}

impl ForgeProvider for GiteaProvider {
    fn forge_type(&self) -> ForgeType {
        self.forge_type
    }

    async fn fetch_repo(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String> {
        let timeout_sec = crate::config::get_project_config()
            .network
            .api_timeout_seconds;
        let client = new_api_client(timeout_sec)?;
        let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Token);

        // Gitea / Forgejo 接口 v1
        let url = format!("https://{}/api/v1/repos/{}/{}", host, owner, repo);
        let span = HttpSpan::start(&url);
        let repo_id = format!("{owner}/{repo}");
        span.log_start("fetch repo", &repo_id);
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| {
                span.log_fail("fetch repo", &repo_id, &e.to_string());
                e.to_string()
            })?;
        span.log_done("fetch repo", &repo_id, resp.status().as_u16());

        if !resp.status().is_success() {
            return Err(format!(
                "Gitea/Codeberg API 响应失败: HTTP {}",
                resp.status()
            ));
        }

        #[derive(Deserialize)]
        struct GiteaRepoPayload {
            name: String,
            description: Option<String>,
            stars_count: Option<u64>,
            forks_count: Option<u64>,
            primary_language: Option<String>,
            default_branch: Option<String>,
            website: Option<String>,
        }

        let payload: GiteaRepoPayload = resp.json().await.map_err(|e| e.to_string())?;

        Ok(ForgeRepoInfo::from_counts(
            payload.name,
            payload.description,
            payload.stars_count,
            payload.forks_count,
            payload.primary_language,
            payload.default_branch,
            payload.website,
        ))
    }

    async fn fetch_latest_release(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String> {
        let timeout_sec = crate::config::get_project_config()
            .network
            .api_timeout_seconds;
        let client = new_api_client(timeout_sec)?;
        let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Token);

        let url = format!(
            "https://{}/api/v1/repos/{}/{}/releases/latest",
            host, owner, repo
        );
        let span = HttpSpan::start(&url);
        let repo_id = format!("{owner}/{repo}");
        span.log_start("fetch release", &repo_id);
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| {
                span.log_fail("fetch release", &repo_id, &e.to_string());
                e.to_string()
            })?;
        span.log_done("fetch release", &repo_id, resp.status().as_u16());

        if !resp.status().is_success() {
            return Err(format!(
                "获取 Gitea/Codeberg Release 失败: HTTP {}",
                resp.status()
            ));
        }

        #[derive(Deserialize)]
        struct GiteaAsset {
            name: String,
            browser_download_url: String,
            size: u64,
        }

        #[derive(Deserialize)]
        struct GiteaRelease {
            tag_name: String,
            name: Option<String>,
            body: Option<String>,
            published_at: Option<String>,
            assets: Option<Vec<GiteaAsset>>,
        }

        let release: GiteaRelease = resp.json().await.map_err(|e| e.to_string())?;

        let assets = parse_assets(
            release
                .assets
                .unwrap_or_default()
                .into_iter()
                .map(|a| (a.name, a.browser_download_url, a.size)),
        );

        Ok(ForgeReleaseInfo {
            tag_name: release.tag_name,
            name: release.name,
            body: release.body,
            published_at: release.published_at,
            assets,
        })
    }

    async fn search_repos(
        &self,
        host: &str,
        query: &str,
        token: Option<&str>,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<Vec<ForgeRepoInfo>, String> {
        let net_conf = &crate::config::get_project_config().network;
        let limits = &crate::config::get_project_config().limits;
        let eff_per_page = limits.clamp_online_search_per_page(per_page);
        let eff_page = crate::config::LimitsConfig::normalize_online_search_page(page);
        let client = new_api_client(net_conf.api_timeout_seconds)?;
        let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Token);

        let encoded_q = urlencoding::encode(query);
        let url = format!(
            "https://{}/api/v1/repos/search?q={}&limit={}&page={}",
            host, encoded_q, eff_per_page, eff_page
        );
        let span = HttpSpan::start(&url);
        span.log_search_start("search");
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| {
                span.log_search_fail("search", &e.to_string());
                e.to_string()
            })?;
        span.log_search_done("search", resp.status().as_u16());

        if !resp.status().is_success() {
            return Err(format!("Gitea/Codeberg 搜索失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GiteaSearchItem {
            name: String,
            description: Option<String>,
            stars_count: Option<u64>,
            forks_count: Option<u64>,
            default_branch: Option<String>,
        }

        #[derive(Deserialize)]
        struct GiteaSearchResult {
            data: Option<Vec<GiteaSearchItem>>,
        }

        let result: GiteaSearchResult = resp.json().await.map_err(|e| e.to_string())?;
        let items = result
            .data
            .unwrap_or_default()
            .into_iter()
            .map(|item| {
                ForgeRepoInfo::from_counts(
                    item.name,
                    item.description,
                    item.stars_count,
                    item.forks_count,
                    None,
                    item.default_branch,
                    None,
                )
            })
            .collect();

        Ok(items)
    }
}
