use futures_util::future::BoxFuture;

use super::coord::ForgeType;
use super::http::{
    api_headers, get_with_retry_after_once, new_api_client, AuthScheme, HttpSpan, JSON_ACCEPT_VALUE,
};
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

    fn fetch_repo<'a>(
        &'a self,
        host: &'a str,
        owner: &'a str,
        repo: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ForgeRepoInfo, String>> {
        Box::pin(async move {
            let timeout_sec = crate::config::get_project_config()
                .network
                .api_timeout_seconds;
            let client = new_api_client(timeout_sec)?;
            let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Token);

            // Gitea / Forgejo 接口 v1；owner/repo 段统一 percent-encoding（对齐 gitlab.rs），
            // 解析出口已校验，此处兜底非 coord 来源的脏段（`/`→`%2F`、空格→`%20`）。
            let url = format!(
                "https://{}/api/v1/repos/{}/{}",
                host,
                urlencoding::encode(owner),
                urlencoding::encode(repo)
            );
            let span = HttpSpan::start(&url);
            let repo_id = format!("{owner}/{repo}");
            span.log_start("fetch repo", &repo_id);
            let resp = get_with_retry_after_once(&client, &url, &headers)
                .await
                .map_err(|e| {
                    span.log_fail("fetch repo", &repo_id, &e.to_string());
                    e.to_string()
                })?;
            span.log_done("fetch repo", &repo_id, resp.status().as_u16());
            // 三家限流口径对齐：x-ratelimit 头存在即上报配额事件（无头时为 no-op）。
            span.notify(&resp, host);

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
        })
    }

    fn fetch_latest_release<'a>(
        &'a self,
        host: &'a str,
        owner: &'a str,
        repo: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ForgeReleaseInfo, String>> {
        Box::pin(async move {
            let timeout_sec = crate::config::get_project_config()
                .network
                .api_timeout_seconds;
            let client = new_api_client(timeout_sec)?;
            let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Token);

            let url = format!(
                "https://{}/api/v1/repos/{}/{}/releases/latest",
                host,
                urlencoding::encode(owner),
                urlencoding::encode(repo)
            );
            let span = HttpSpan::start(&url);
            let repo_id = format!("{owner}/{repo}");
            span.log_start("fetch release", &repo_id);
            let resp = get_with_retry_after_once(&client, &url, &headers)
                .await
                .map_err(|e| {
                    span.log_fail("fetch release", &repo_id, &e.to_string());
                    e.to_string()
                })?;
            span.log_done("fetch release", &repo_id, resp.status().as_u16());
            span.notify(&resp, host);

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
        })
    }
}
