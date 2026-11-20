use futures_util::future::BoxFuture;

use super::coord::ForgeType;
use super::http::{
    api_headers, get_with_d7_retry, new_api_client, AuthScheme, HttpSpan, JSON_ACCEPT_VALUE,
};
use super::provider::{
    extract_license_value, parse_assets, ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo,
};
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

            // owner/repo 统一 percent-encoding，防止非 coord 来源的特殊字符污染路径。
            let url = format!(
                "https://{}/api/v1/repos/{}/{}",
                host,
                urlencoding::encode(owner),
                urlencoding::encode(repo)
            );
            let span = HttpSpan::start();
            let resp = get_with_d7_retry(&client, &url, &headers)
                .await
                .map_err(|e| e.to_string())?;
            // 三家限流口径对齐：x-ratelimit 头存在即上报配额事件（无头时为 no-op）。
            span.notify(&resp, host);

            if !resp.status().is_success() {
                return Err(format!(
                    "Gitea/Codeberg API 响应失败: HTTP {}",
                    resp.status()
                ));
            }

            #[derive(Deserialize)]
            struct GiteaOwner {
                avatar_url: Option<String>,
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
                #[serde(default)]
                licenses: Option<Vec<String>>,
                #[serde(default)]
                license: Option<serde_json::Value>,
                #[serde(default)]
                owner: Option<GiteaOwner>,
            }

            let payload: GiteaRepoPayload = resp.json().await.map_err(|e| e.to_string())?;
            let license = payload
                .licenses
                .and_then(|list| {
                    list.into_iter()
                        .map(|s| s.trim().to_string())
                        .find(|s| !s.is_empty())
                })
                .or_else(|| extract_license_value(payload.license.as_ref()));

            Ok(ForgeRepoInfo::from_counts(
                payload.name,
                payload.description,
                payload.stars_count,
                payload.forks_count,
                payload.primary_language,
                payload.default_branch,
                payload.website,
            )
            .with_license_and_avatar(license, payload.owner.and_then(|o| o.avatar_url)))
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
            let span = HttpSpan::start();
            let resp = get_with_d7_retry(&client, &url, &headers)
                .await
                .map_err(|e| e.to_string())?;
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
