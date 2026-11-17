use futures_util::future::BoxFuture;

use super::coord::ForgeType;
use super::http::{
    api_headers, get_with_d7_retry, new_api_client, AuthScheme, HttpSpan, JSON_ACCEPT_VALUE,
};
use super::provider::{parse_assets, ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};
use serde::Deserialize;

pub struct GitLabProvider;

impl ForgeProvider for GitLabProvider {
    fn forge_type(&self) -> ForgeType {
        ForgeType::GitLab
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
            let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Bearer);

            let encoded_path = format!(
                "{}%2F{}",
                urlencoding::encode(owner),
                urlencoding::encode(repo)
            );
            let url = format!("https://{}/api/v4/projects/{}", host, encoded_path);
            let span = HttpSpan::start();
            let resp = get_with_d7_retry(&client, &url, &headers)
                .await
                .map_err(|e| e.to_string())?;
            // 三家限流口径对齐：x-ratelimit 头存在即上报配额事件（无头时为 no-op）。
            span.notify(&resp, host);

            if !resp.status().is_success() {
                return Err(format!("GitLab API 响应失败: HTTP {}", resp.status()));
            }

            #[derive(Deserialize)]
            struct GitLabRepoPayload {
                name: String,
                description: Option<String>,
                star_count: Option<u64>,
                forks_count: Option<u64>,
                default_branch: Option<String>,
            }

            let payload: GitLabRepoPayload = resp.json().await.map_err(|e| e.to_string())?;

            Ok(ForgeRepoInfo::from_counts(
                payload.name,
                payload.description,
                payload.star_count,
                payload.forks_count,
                None,
                payload.default_branch,
                None,
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
            let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Bearer);

            #[derive(Deserialize)]
            struct GitLabAssetLink {
                name: String,
                url: String,
                direct_asset_url: Option<String>,
            }

            #[derive(Deserialize)]
            struct GitLabReleaseAssets {
                links: Option<Vec<GitLabAssetLink>>,
            }

            #[derive(Deserialize)]
            struct GitLabReleasePayload {
                tag_name: String,
                name: Option<String>,
                description: Option<String>,
                released_at: Option<String>,
                assets: Option<GitLabReleaseAssets>,
            }

            let encoded_path = format!(
                "{}%2F{}",
                urlencoding::encode(owner),
                urlencoding::encode(repo)
            );
            let latest_url = format!(
                "https://{}/api/v4/projects/{}/releases/permalink/latest",
                host, encoded_path
            );

            let span = HttpSpan::start();
            let resp = get_with_d7_retry(&client, &latest_url, &headers)
                .await
                .map_err(|e| e.to_string())?;
            span.notify(&resp, host);

            let release: GitLabReleasePayload = if resp.status().is_success() {
                resp.json().await.map_err(|e| e.to_string())?
            } else {
                // 回退到 /releases 列表首项
                let list_url = format!(
                    "https://{}/api/v4/projects/{}/releases?per_page=1",
                    host, encoded_path
                );
                let list_resp = get_with_d7_retry(&client, &list_url, &headers)
                    .await
                    .map_err(|e| e.to_string())?;
                span.notify(&list_resp, host);
                if !list_resp.status().is_success() {
                    return Err(format!(
                        "获取 GitLab Release 失败: HTTP {}",
                        list_resp.status()
                    ));
                }
                let list: Vec<GitLabReleasePayload> =
                    list_resp.json().await.map_err(|e| e.to_string())?;
                list.into_iter()
                    .next()
                    .ok_or_else(|| "该 GitLab 项目未找到任何 Release".to_string())?
            };

            let links = release.assets.and_then(|a| a.links).unwrap_or_default();
            let assets = parse_assets(links.into_iter().map(|l| {
                let dl_url = l.direct_asset_url.unwrap_or(l.url);
                (l.name, dl_url, 0)
            }));

            Ok(ForgeReleaseInfo {
                tag_name: release.tag_name,
                name: release.name,
                body: release.description,
                published_at: release.released_at,
                assets,
            })
        })
    }
}
