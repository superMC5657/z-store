use super::coord::ForgeType;
use super::provider::{ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};
use crate::installer::InstallerEngine;
use crate::models::ReleaseAsset;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::Deserialize;

pub struct GitHubProvider;

impl ForgeProvider for GitHubProvider {
    fn forge_type(&self) -> ForgeType {
        ForgeType::GitHub
    }

    fn default_host(&self) -> &str {
        "github.com"
    }

    async fn fetch_repo(
        &self,
        _host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String> {
        let timeout_sec = crate::config::get_project_config().network.api_timeout_seconds;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_sec))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3+json"),
        );
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let url = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let req_id = crate::z_log::new_req_id();
        let sid = crate::z_log::new_session_id();
        let host = crate::log_support::host_of(&url);
        log::debug!("forge fetch repo id={}/{} sid={} req={} url='{}'", owner, repo, sid, req_id, crate::log_support::sanitize_url(&url));
        let start = std::time::Instant::now();
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| {
                log::warn!("forge fetch repo failed id={}/{} sid={} req={} host={} reason={}", owner, repo, sid, req_id, host, crate::log_support::short_reason(&e.to_string()));
                e.to_string()
            })?;
        log::debug!("forge fetch repo done id={}/{} sid={} req={} url='{}' status={} elapsed_ms={}", owner, repo, sid, req_id, crate::log_support::sanitize_url(&url), resp.status().as_u16(), start.elapsed().as_millis());
        log::info!("http resp forge repo id={}/{} sid={} req={} host={} status={} elapsed_ms={}", owner, repo, sid, req_id, host, resp.status().as_u16(), start.elapsed().as_millis());
        crate::notify_rate_limit("github.com", resp.headers());

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

        Ok(ForgeRepoInfo {
            name: payload.name,
            description: payload.description,
            stars: payload.stargazers_count.unwrap_or(0),
            forks: payload.forks_count.unwrap_or(0),
            language: payload.language,
            default_branch: payload.default_branch.unwrap_or_else(|| "main".to_string()),
            homepage: payload.homepage.filter(|h| !h.trim().is_empty()),
        })
    }

    async fn fetch_latest_release(
        &self,
        _host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String> {
        let timeout_sec = crate::config::get_project_config().network.api_timeout_seconds;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_sec))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3+json"),
        );
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let url = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            owner, repo
        );
        let req_id = crate::z_log::new_req_id();
        let sid = crate::z_log::new_session_id();
        let host = crate::log_support::host_of(&url);
        log::debug!("forge fetch release id={}/{} sid={} req={} url='{}'", owner, repo, sid, req_id, crate::log_support::sanitize_url(&url));
        let start = std::time::Instant::now();
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| {
                log::warn!("forge fetch release failed id={}/{} sid={} req={} host={} reason={}", owner, repo, sid, req_id, host, crate::log_support::short_reason(&e.to_string()));
                e.to_string()
            })?;
        log::debug!("forge fetch release done id={}/{} sid={} req={} url='{}' status={} elapsed_ms={}", owner, repo, sid, req_id, crate::log_support::sanitize_url(&url), resp.status().as_u16(), start.elapsed().as_millis());
        log::info!("http resp forge release id={}/{} sid={} req={} host={} status={} elapsed_ms={}", owner, repo, sid, req_id, host, resp.status().as_u16(), start.elapsed().as_millis());
        crate::notify_rate_limit("github.com", resp.headers());

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

        let assets = release
            .assets
            .into_iter()
            .map(|a| {
                let (kind, os, arch) = InstallerEngine::classify_asset(&a.name);
                let kind_str = match kind {
                    crate::installer::AssetKind::Msi => "msi",
                    crate::installer::AssetKind::SetupExe => "setup_exe",
                    crate::installer::AssetKind::PortableZip => "portable_zip",
                    crate::installer::AssetKind::Deb => "deb",
                    crate::installer::AssetKind::Rpm => "rpm",
                    crate::installer::AssetKind::AppImage => "appimage",
                    crate::installer::AssetKind::Dmg => "dmg",
                    crate::installer::AssetKind::Pkg => "pkg",
                    crate::installer::AssetKind::Apk => "apk",
                    crate::installer::AssetKind::Other => "other",
                };
                ReleaseAsset {
                    name: a.name,
                    download_url: a.browser_download_url,
                    size_bytes: a.size,
                    sha256: None,
                    os: os.to_string(),
                    arch: arch.to_string(),
                    kind: kind_str.to_string(),
                }
            })
            .collect();

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
    ) -> Result<Vec<ForgeRepoInfo>, String> {
        let net_conf = &crate::config::get_project_config().network;
        let page_size = crate::config::get_project_config().limits.online_search_page_size;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(net_conf.api_timeout_seconds))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3+json"),
        );
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let encoded_q = urlencoding::encode(query);
        let url = format!(
            "https://api.github.com/search/repositories?q={}&per_page={}",
            encoded_q, page_size
        );
        let req_id = crate::z_log::new_req_id();
        let sid = crate::z_log::new_session_id();
        let host = crate::log_support::host_of(&url);
        log::debug!("forge search sid={} req={} url='{}'", sid, req_id, crate::log_support::sanitize_url(&url));
        let start = std::time::Instant::now();
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| {
                log::warn!("forge search failed sid={} req={} host={} reason={}", sid, req_id, host, crate::log_support::short_reason(&e.to_string()));
                e.to_string()
            })?;
        log::debug!("forge search done sid={} req={} status={} elapsed_ms={}", sid, req_id, resp.status().as_u16(), start.elapsed().as_millis());
        log::info!("http resp forge search sid={} req={} host={} status={} elapsed_ms={}", sid, req_id, host, resp.status().as_u16(), start.elapsed().as_millis());
        crate::notify_rate_limit("github.com", resp.headers());

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
            .map(|item| ForgeRepoInfo {
                name: item.name,
                description: item.description,
                stars: item.stargazers_count.unwrap_or(0),
                forks: item.forks_count.unwrap_or(0),
                language: item.language,
                default_branch: item.default_branch.unwrap_or_else(|| "main".to_string()),
                homepage: None,
            })
            .collect();

        Ok(items)
    }
}
