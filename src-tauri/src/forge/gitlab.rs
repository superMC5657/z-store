use super::coord::ForgeType;
use super::http::{api_headers, new_api_client, AuthScheme, HttpSpan, JSON_ACCEPT_VALUE};
use super::provider::{AssetKindExt, ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};
use crate::installer::InstallerEngine;
use crate::models::ReleaseAsset;
use serde::Deserialize;

pub struct GitLabProvider;

impl ForgeProvider for GitLabProvider {
    fn forge_type(&self) -> ForgeType {
        ForgeType::GitLab
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
        let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Bearer);

        let encoded_path = format!(
            "{}%2F{}",
            urlencoding::encode(owner),
            urlencoding::encode(repo)
        );
        let url = format!("https://{}/api/v4/projects/{}", host, encoded_path);
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

        let span = HttpSpan::start(&latest_url);
        let repo_id = format!("{owner}/{repo}");
        span.log_start("fetch release", &repo_id);
        let resp = client
            .get(&latest_url)
            .headers(headers.clone())
            .send()
            .await
            .map_err(|e| {
                span.log_fail("fetch release", &repo_id, &e.to_string());
                e.to_string()
            })?;
        span.log_done("fetch release", &repo_id, resp.status().as_u16());

        let release: GitLabReleasePayload = if resp.status().is_success() {
            resp.json().await.map_err(|e| e.to_string())?
        } else {
            // 回退到 /releases 列表首项
            let list_url = format!(
                "https://{}/api/v4/projects/{}/releases?per_page=1",
                host, encoded_path
            );
            let safe_list = crate::log_support::sanitize_url(&list_url);
            let start_list = std::time::Instant::now();
            log::debug!(
                "http get forge release fallback id={}/{} sid={} req={} url='{}'",
                owner,
                repo,
                span.sid,
                span.req_id,
                safe_list
            );
            let list_resp = client
                .get(&list_url)
                .headers(headers)
                .send()
                .await
                .map_err(|e| {
                    log::warn!("http get forge release fallback failed id={}/{} sid={} req={} host={} reason={}", owner, repo, span.sid, span.req_id, span.host, crate::log_support::short_reason(&e.to_string()));
                    e.to_string()
                })?;
            // fallback 出入口合一：单条 debug 记列表回退结果。
            log::debug!("http forge release fallback id={}/{} sid={} req={} url='{}' status={} elapsed_ms={}", owner, repo, span.sid, span.req_id, safe_list, list_resp.status().as_u16(), start_list.elapsed().as_millis());
            log::info!("http resp forge release fallback id={}/{} sid={} req={} host={} status={} elapsed_ms={}", owner, repo, span.sid, span.req_id, span.host, list_resp.status().as_u16(), start_list.elapsed().as_millis());
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

        let mut assets = Vec::new();
        if let Some(rel_assets) = release.assets {
            if let Some(links) = rel_assets.links {
                for l in links {
                    let (kind, os, arch) = InstallerEngine::classify_asset(&l.name);
                    let dl_url = l.direct_asset_url.unwrap_or(l.url);
                    let kind_str = kind.as_str();
                    assets.push(ReleaseAsset {
                        name: l.name,
                        download_url: dl_url,
                        size_bytes: 0,
                        sha256: None,
                        os: os.to_string(),
                        arch: arch.to_string(),
                        kind: kind_str.to_string(),
                    });
                }
            }
        }

        Ok(ForgeReleaseInfo {
            tag_name: release.tag_name,
            name: release.name,
            body: release.description,
            published_at: release.released_at,
            assets,
        })
    }

    async fn search_repos(
        &self,
        host: &str,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<ForgeRepoInfo>, String> {
        let net_conf = &crate::config::get_project_config().network;
        let page_size = crate::config::get_project_config()
            .limits
            .online_search_page_size;
        let client = new_api_client(net_conf.api_timeout_seconds)?;
        let headers = api_headers(JSON_ACCEPT_VALUE, token, AuthScheme::Bearer);

        let encoded_q = urlencoding::encode(query);
        let url = format!(
            "https://{}/api/v4/projects?search={}&per_page={}",
            host, encoded_q, page_size
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
            return Err(format!("GitLab 搜索失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitLabProjectItem {
            name: String,
            description: Option<String>,
            star_count: Option<u64>,
            forks_count: Option<u64>,
            default_branch: Option<String>,
        }

        let items: Vec<GitLabProjectItem> = resp.json().await.map_err(|e| e.to_string())?;
        let result = items
            .into_iter()
            .map(|item| {
                ForgeRepoInfo::from_counts(
                    item.name,
                    item.description,
                    item.star_count,
                    item.forks_count,
                    None,
                    item.default_branch,
                    None,
                )
            })
            .collect();

        Ok(result)
    }
}
