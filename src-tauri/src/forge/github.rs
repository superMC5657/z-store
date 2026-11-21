use futures_util::future::BoxFuture;

use super::coord::ForgeType;
use super::http::{
    api_headers, get_with_d7_retry_observed, new_api_client, AuthScheme, HttpSpan,
    GITHUB_ACCEPT_VALUE,
};
use super::provider::{parse_assets, ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};
use serde::Deserialize;

pub struct GitHubProvider;

/// GitHub REST GET：D7 有限重试（含传输错误时代理快照重探）、每轮限流上报，401 触发凭据失效通知。
async fn get_github(
    client: &reqwest::Client,
    url: &str,
    headers: &reqwest::header::HeaderMap,
    op: &str,
    owner: &str,
    repo: &str,
) -> Result<reqwest::Response, String> {
    let span = HttpSpan::start();
    let resp = get_with_d7_retry_observed(client, url, headers, |r| span.notify(r, "github.com"))
        .await
        .result
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        crate::check_auth_expired(401, &format!("op={op} repo={owner}/{repo}"));
    }
    Ok(resp)
}

impl ForgeProvider for GitHubProvider {
    fn forge_type(&self) -> ForgeType {
        ForgeType::GitHub
    }

    fn fetch_repo<'a>(
        &'a self,
        _host: &'a str,
        owner: &'a str,
        repo: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ForgeRepoInfo, String>> {
        Box::pin(async move {
            let timeout_sec = crate::config::get_project_config()
                .network
                .api_timeout_seconds;
            let client = new_api_client(timeout_sec)?;
            let headers = api_headers(GITHUB_ACCEPT_VALUE, token, AuthScheme::Bearer);

            // owner/repo 段统一 percent-encoding（对齐 gitlab.rs）：解析出口已校验，
            // 此处兜底非 coord 来源的脏段（`/`→`%2F`、空格→`%20`），不致路径注入。
            let url = crate::github::github_repo_endpoint(owner, repo);
            let resp = get_github(&client, &url, &headers, "forge-repo", owner, repo).await?;
            if !resp.status().is_success() {
                return Err(format!("GitHub API 响应失败: {}", resp.status()));
            }

            #[derive(Deserialize)]
            struct GitHubLicense {
                spdx_id: Option<String>,
            }

            #[derive(Deserialize)]
            struct GitHubOwner {
                avatar_url: Option<String>,
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
                #[serde(default)]
                license: Option<GitHubLicense>,
                #[serde(default)]
                owner: Option<GitHubOwner>,
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
            )
            .with_license_and_avatar(
                payload.license.and_then(|l| l.spdx_id),
                payload.owner.and_then(|o| o.avatar_url),
            ))
        })
    }

    fn fetch_latest_release<'a>(
        &'a self,
        _host: &'a str,
        owner: &'a str,
        repo: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ForgeReleaseInfo, String>> {
        Box::pin(async move {
            let timeout_sec = crate::config::get_project_config()
                .network
                .api_timeout_seconds;
            let client = new_api_client(timeout_sec)?;
            let headers = api_headers(GITHUB_ACCEPT_VALUE, token, AuthScheme::Bearer);

            let url = crate::github::github_latest_release_endpoint(owner, repo);
            let resp = get_github(&client, &url, &headers, "forge-release", owner, repo).await?;
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
        })
    }
}
