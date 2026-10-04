use super::coord::ForgeType;
use super::http::{api_headers, new_api_client, AuthScheme, HttpSpan, GITHUB_ACCEPT_VALUE};
use super::provider::{parse_assets, ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};
use serde::Deserialize;

pub struct GitHubProvider;

impl ForgeProvider for GitHubProvider {
    fn forge_type(&self) -> ForgeType {
        ForgeType::GitHub
    }

    async fn fetch_repo(
        &self,
        _host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String> {
        let timeout_sec = crate::config::get_project_config()
            .network
            .api_timeout_seconds;
        let client = new_api_client(timeout_sec)?;
        let headers = api_headers(GITHUB_ACCEPT_VALUE, token, AuthScheme::Bearer);

        let url = format!("https://api.github.com/repos/{}/{}", owner, repo);
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
        span.notify(&resp, "github.com");

        if !resp.status().is_success() {
            return Err(format!("GitHub API 响应失败: {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitHubRepoPayload {
            name: String,
            description: Option<String>,
            stargazers_count: Option<u64>,
            forks_count: Option<u64>,
            language: Option<String>,
            default_branch: Option<String>,
            homepage: Option<String>,
        }

        let payload: GitHubRepoPayload = resp.json().await.map_err(|e| e.to_string())?;

        Ok(ForgeRepoInfo::from_counts(
            payload.name,
            payload.description,
            payload.stargazers_count,
            payload.forks_count,
            payload.language,
            payload.default_branch,
            payload.homepage,
        ))
    }

    async fn fetch_latest_release(
        &self,
        _host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String> {
        let timeout_sec = crate::config::get_project_config()
            .network
            .api_timeout_seconds;
        let client = new_api_client(timeout_sec)?;
        let headers = api_headers(GITHUB_ACCEPT_VALUE, token, AuthScheme::Bearer);

        let url = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            owner, repo
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
        span.notify(&resp, "github.com");

        if !resp.status().is_success() {
            return Err(format!("获取 GitHub Release 失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitHubAsset {
            name: String,
            browser_download_url: String,
            size: u64,
        }

        #[derive(Deserialize)]
        struct GitHubRelease {
            tag_name: String,
            name: Option<String>,
            body: Option<String>,
            published_at: Option<String>,
            assets: Vec<GitHubAsset>,
        }

        let release: GitHubRelease = resp.json().await.map_err(|e| e.to_string())?;

        let assets = parse_assets(
            release
                .assets
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
        _host: &str,
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
        let headers = api_headers(GITHUB_ACCEPT_VALUE, token, AuthScheme::Bearer);

        let encoded_q = urlencoding::encode(query);
        let url = format!(
            "https://api.github.com/search/repositories?q={}&per_page={}&page={}",
            encoded_q, eff_per_page, eff_page
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
        span.notify(&resp, "github.com");

        if !resp.status().is_success() {
            return Err(format!("GitHub 搜索失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitHubSearchItem {
            name: String,
            description: Option<String>,
            stargazers_count: Option<u64>,
            forks_count: Option<u64>,
            language: Option<String>,
            default_branch: Option<String>,
        }

        #[derive(Deserialize)]
        struct GitHubSearchResult {
            items: Option<Vec<GitHubSearchItem>>,
        }

        let result: GitHubSearchResult = resp.json().await.map_err(|e| e.to_string())?;
        let items = result
            .items
            .unwrap_or_default()
            .into_iter()
            .map(|item| {
                ForgeRepoInfo::from_counts(
                    item.name,
                    item.description,
                    item.stargazers_count,
                    item.forks_count,
                    item.language,
                    item.default_branch,
                    None,
                )
            })
            .collect();

        Ok(items)
    }
}
