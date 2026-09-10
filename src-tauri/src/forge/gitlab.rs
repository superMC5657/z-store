use super::coord::{ForgeType, UniversalRepoCoord};
use super::provider::{ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};
use crate::installer::InstallerEngine;
use crate::models::ReleaseAsset;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::Deserialize;

pub struct GitLabProvider;

impl ForgeProvider for GitLabProvider {
    fn forge_type(&self) -> ForgeType {
        ForgeType::GitLab
    }

    fn default_host(&self) -> &str {
        "gitlab.com"
    }

    async fn fetch_repo(
        &self,
        host: &str,
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
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let encoded_path = format!(
            "{}%2F{}",
            urlencoding::encode(owner),
            urlencoding::encode(repo)
        );
        let url = format!("https://{}/api/v4/projects/{}", host, encoded_path);
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| e.to_string())?;

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

        Ok(ForgeRepoInfo {
            coord: UniversalRepoCoord {
                forge: ForgeType::GitLab,
                host: host.to_string(),
                owner: owner.to_string(),
                repo: repo.to_string(),
            },
            name: payload.name,
            description: payload.description,
            stars: payload.star_count.unwrap_or(0),
            forks: payload.forks_count.unwrap_or(0),
            language: None,
            default_branch: payload.default_branch.unwrap_or_else(|| "main".to_string()),
            homepage: None,
        })
    }

    async fn fetch_latest_release(
        &self,
        host: &str,
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
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

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

        let resp = client
            .get(&latest_url)
            .headers(headers.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let release: GitLabReleasePayload = if resp.status().is_success() {
            resp.json().await.map_err(|e| e.to_string())?
        } else {
            // 回退到 /releases 列表首项
            let list_url = format!(
                "https://{}/api/v4/projects/{}/releases?per_page=1",
                host, encoded_path
            );
            let list_resp = client
                .get(&list_url)
                .headers(headers)
                .send()
                .await
                .map_err(|e| e.to_string())?;
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
        let page_size = crate::config::get_project_config().limits.online_search_page_size;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(net_conf.api_timeout_seconds))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let encoded_q = urlencoding::encode(query);
        let url = format!(
            "https://{}/api/v4/projects?search={}&per_page={}",
            host, encoded_q, page_size
        );
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("GitLab 搜索失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitLabNamespace {
            path: String,
        }

        #[derive(Deserialize)]
        struct GitLabProjectItem {
            name: String,
            path: String,
            description: Option<String>,
            star_count: Option<u64>,
            forks_count: Option<u64>,
            default_branch: Option<String>,
            namespace: GitLabNamespace,
        }

        let items: Vec<GitLabProjectItem> = resp.json().await.map_err(|e| e.to_string())?;
        let result = items
            .into_iter()
            .map(|item| ForgeRepoInfo {
                coord: UniversalRepoCoord {
                    forge: ForgeType::GitLab,
                    host: host.to_string(),
                    owner: item.namespace.path,
                    repo: item.path,
                },
                name: item.name,
                description: item.description,
                stars: item.star_count.unwrap_or(0),
                forks: item.forks_count.unwrap_or(0),
                language: None,
                default_branch: item.default_branch.unwrap_or_else(|| "main".to_string()),
                homepage: None,
            })
            .collect();

        Ok(result)
    }
}
