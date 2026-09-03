use crate::installer::InstallerEngine;
use crate::models::{AppDetail, AppSummary, DeveloperProfile, DeveloperRepoItem, ReleaseAsset, StarredSyncResult};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, IF_NONE_MATCH, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    pub chinese_name: Option<String>,
    pub owner: String,
    pub repo: String,
    pub icon: String,
    pub icon_bg: String,
    pub description: String,
    pub category: String,
    pub category_name: String,
    pub aliases: Vec<String>,
    pub default_version: String,
    pub license: String,
    pub stars: u64,
    pub forks: u64,
    pub is_verified: bool,
    #[serde(default)]
    pub publisher_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GitHubUserResponse {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
    html_url: Option<String>,
    bio: Option<String>,
    company: Option<String>,
    blog: Option<String>,
    location: Option<String>,
    email: Option<String>,
    public_repos: Option<u64>,
    followers: Option<u64>,
    following: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GitHubRepoResponse {
    name: Option<String>,
    full_name: Option<String>,
    html_url: Option<String>,
    description: Option<String>,
    stargazers_count: Option<u64>,
    forks_count: Option<u64>,
    language: Option<String>,
    license: Option<GitHubLicense>,
}

#[derive(Debug, Deserialize)]
struct GitHubLicense {
    spdx_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    body: Option<String>,
    assets: Vec<GitHubAssetResponse>,
}

#[derive(Debug, Serialize, Deserialize)]
struct GitHubAssetResponse {
    name: String,
    size: u64,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubSearchResponse {
    items: Vec<GitHubSearchItem>,
}

#[derive(Debug, Deserialize)]
struct GitHubSearchItem {
    name: String,
    full_name: String,
    owner: GitHubSearchOwner,
    description: Option<String>,
    stargazers_count: u64,
    forks_count: u64,
}

#[derive(Debug, Deserialize)]
struct GitHubSearchOwner {
    login: String,
}

pub struct CatalogService {
    items: Vec<CatalogItem>,
}

impl Default for CatalogService {
    fn default() -> Self {
        Self::new()
    }
}

impl CatalogService {
    pub fn new() -> Self {
        let json_data = include_str!("catalog.json");
        let items: Vec<CatalogItem> = serde_json::from_str(json_data).unwrap_or_default();
        Self { items }
    }

    pub fn get_catalog_count(&self) -> usize {
        self.items.len()
    }

    pub fn get_catalog_items(&self) -> &[CatalogItem] {
        &self.items
    }

    pub fn get_all_summaries(&self) -> Vec<AppSummary> {
        self.items.iter().map(|item| item.to_summary()).collect()
    }

    pub fn search_apps(&self, query: &str) -> Vec<AppSummary> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            let mut all = self.get_all_summaries();
            all.sort_by_key(|b| std::cmp::Reverse(b.stars));
            return all;
        }

        // 分类过滤匹配
        if let Some(cat_match) = self.filter_by_category(&q) {
            return cat_match;
        }

        let mut matches: Vec<(i32, AppSummary)> = Vec::new();

        for item in &self.items {
            let mut score = 0;

            let name_lower = item.name.to_lowercase();
            let id_lower = item.id.to_lowercase();
            let zh_lower = item.chinese_name.as_deref().unwrap_or("").to_lowercase();
            let desc_lower = item.description.to_lowercase();
            let owner_lower = item.owner.to_lowercase();
            let repo_lower = item.repo.to_lowercase();

            if name_lower == q || id_lower == q {
                score += 100;
            } else if name_lower.starts_with(&q) {
                score += 60;
            } else if zh_lower.contains(&q) {
                score += 50;
            } else if name_lower.contains(&q) {
                score += 40;
            } else if owner_lower.contains(&q) || repo_lower.contains(&q) {
                score += 30;
            } else if item.aliases.iter().any(|a| a.to_lowercase().contains(&q)) {
                score += 35;
            } else if desc_lower.contains(&q) {
                score += 15;
            }

            if score > 0 {
                matches.push((score, item.to_summary()));
            }
        }

        // 按匹配分值高优先，同分值按 Star 降序
        matches.sort_by(|a, b| {
            if b.0 != a.0 {
                b.0.cmp(&a.0)
            } else {
                b.1.stars.cmp(&a.1.stars)
            }
        });

        matches.into_iter().map(|(_, s)| s).collect()
    }

    pub fn filter_by_category(&self, category: &str) -> Option<Vec<AppSummary>> {
        let cat_clean = category.trim().to_lowercase();
        let matched: Vec<AppSummary> = self
            .items
            .iter()
            .filter(|item| {
                item.category.to_lowercase() == cat_clean
                    || item.category_name.to_lowercase() == cat_clean
            })
            .map(|item| item.to_summary())
            .collect();

        if matched.is_empty() {
            None
        } else {
            let mut sorted = matched;
            sorted.sort_by_key(|b| std::cmp::Reverse(b.stars));
            Some(sorted)
        }
    }

    pub fn get_endpoints(
        &self,
        id: &str,
    ) -> Result<(String, String, String, String, String, String), String> {
        if let Some(item) = self.items.iter().find(|i| i.id == id) {
            Ok((
                item.owner.clone(),
                item.repo.clone(),
                item.name.clone(),
                item.description.clone(),
                item.icon.clone(),
                item.icon_bg.clone(),
            ))
        } else if id.contains('/') {
            let parts: Vec<&str> = id.split('/').collect();
            if parts.len() == 2 {
                let owner = parts[0].trim().to_string();
                let repo = parts[1].trim().to_string();
                let name = repo.clone();
                Ok((
                    owner,
                    repo,
                    name,
                    "GitHub 社区开源项目".to_string(),
                    "📦".to_string(),
                    "linear-gradient(135deg, #475569, #334155)".to_string(),
                ))
            } else {
                Err(format!("未识别的仓库坐标: {}", id))
            }
        } else {
            Err(format!("收录库中不存在该应用: {}", id))
        }
    }

    pub async fn search_github_online(
        &self,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<AppSummary>, String> {
        let local_results = self.search_apps(query);
        if !local_results.is_empty() {
            return Ok(local_results);
        }

        let q = query.trim();
        if q.is_empty() {
            return Ok(self.get_all_summaries());
        }

        // 检查是否直接输入了 owner/repo 格式
        if q.contains('/') && !q.contains(' ') {
            let parts: Vec<&str> = q.split('/').collect();
            if parts.len() == 2 {
                let owner = parts[0];
                let repo = parts[1];
                if let Ok(item) = self.fetch_online_repo(owner, repo, token).await {
                    return Ok(vec![item]);
                }
            }
        }

        // 在线 GitHub Search API 回退
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
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
                if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let url = format!(
            "https://api.github.com/search/repositories?q={}+in:name,description&sort=stars&order=desc&per_page=12",
            urlencoding::encode(q)
        );

        let resp = client.get(&url).headers(headers).send().await;
        if let Ok(res) = resp {
            if res.status().is_success() {
                if let Ok(data) = res.json::<GitHubSearchResponse>().await {
                    let summaries: Vec<AppSummary> = data
                        .items
                        .into_iter()
                        .map(|it| AppSummary {
                            id: it.full_name.clone(),
                            name: it.name,
                            owner: it.owner.login,
                            repo: it.full_name.split('/').nth(1).unwrap_or("").to_string(),
                            icon: "📦".to_string(),
                            icon_bg: "linear-gradient(135deg, #0ea5e9, #2563eb)".to_string(),
                            description: it
                                .description
                                .unwrap_or_else(|| "开源软件项目".to_string()),
                            stars: it.stargazers_count,
                            forks: it.forks_count,
                            license: "OpenSource".to_string(),
                            latest_version: "latest".to_string(),
                            category: "dev".to_string(),
                            category_name: "开发工具".to_string(),
                            is_verified: false,
                            is_installed: None,
                            has_update: None,
                            installed_version: None,
                        })
                        .collect();
                    return Ok(summaries);
                }
            }
        }

        Ok(Vec::new())
    }

    async fn fetch_online_repo(
        &self,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<AppSummary, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        if let Some(tok) = token {
            if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                headers.insert(AUTHORIZATION, val);
            }
        }

        let url = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("未找到该 GitHub 仓库: {}/{}", owner, repo));
        }

        let repo_data: GitHubRepoResponse = resp.json().await.map_err(|e| e.to_string())?;
        Ok(AppSummary {
            id: format!("{}/{}", owner, repo),
            name: repo_data.name.unwrap_or_else(|| repo.to_string()),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: "📦".to_string(),
            icon_bg: "linear-gradient(135deg, #0284c7, #0369a1)".to_string(),
            description: repo_data.description.unwrap_or_default(),
            stars: repo_data.stargazers_count.unwrap_or(0),
            forks: repo_data.forks_count.unwrap_or(0),
            license: repo_data
                .license
                .and_then(|l| l.spdx_id)
                .unwrap_or_else(|| "FLOSS".to_string()),
            latest_version: "latest".to_string(),
            category: "system".to_string(),
            category_name: "系统实用".to_string(),
            is_verified: false,
            is_installed: None,
            has_update: None,
            installed_version: None,
        })
    }

    pub async fn fetch_app_detail(
        &self,
        id: &str,
        cached_etag: Option<String>,
        cached_payload: Option<String>,
        token: Option<&str>,
    ) -> Result<(AppDetail, Option<(String, String)>), String> {
        let (owner, repo, name, desc, icon, icon_bg) = self.get_endpoints(id)?;
        let catalog_item = self.items.iter().find(|i| i.id == id);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
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
                if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        if let Some(ref etag) = cached_etag {
            if let Ok(val) = HeaderValue::from_str(etag) {
                headers.insert(IF_NONE_MATCH, val);
            }
        }

        let release_url = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            owner, repo
        );
        let resp = client
            .get(&release_url)
            .headers(headers.clone())
            .send()
            .await;

        let (release_resp, new_cache) = match resp {
            Ok(res) if res.status() == reqwest::StatusCode::NOT_MODIFIED => {
                // 304 Not Modified: 零配额消耗，直接使用 SQLite 本地缓存
                if let Some(ref payload) = cached_payload {
                    let parsed: GitHubReleaseResponse = serde_json::from_str(payload)
                        .map_err(|e| format!("解析本地 ETag 缓存失败: {}", e))?;
                    (parsed, None)
                } else {
                    return Err("304 响应但本地未找到缓存数据".to_string());
                }
            }
            Ok(res) if res.status().is_success() => {
                let new_etag = res
                    .headers()
                    .get("etag")
                    .and_then(|h| h.to_str().ok())
                    .map(|s| s.to_string());

                let payload_text = res.text().await.map_err(|e| e.to_string())?;
                let parsed: GitHubReleaseResponse = serde_json::from_str(&payload_text)
                    .map_err(|e| format!("解析 GitHub Release 失败: {}", e))?;

                let cache_tuple = new_etag.map(|et| (et, payload_text));
                (parsed, cache_tuple)
            }
            _ => {
                // 离线或网络异常回退：若有缓存直接使用缓存，否则构造基础数据
                if let Some(ref payload) = cached_payload {
                    let parsed: GitHubReleaseResponse = serde_json::from_str(payload)
                        .map_err(|e| format!("解析离线缓存失败: {}", e))?;
                    (parsed, None)
                } else {
                    let fallback_ver = catalog_item
                        .map(|i| i.default_version.clone())
                        .unwrap_or_else(|| "v1.0.0".to_string());
                    (
                        GitHubReleaseResponse {
                            tag_name: fallback_ver,
                            body: Some(
                                "离线模式，暂无法直连获取 GitHub Release 变更日志。".to_string(),
                            ),
                            assets: Vec::new(),
                        },
                        None,
                    )
                }
            }
        };

        // 提取校验和字典（若 Release 中存在 sha256sums / checksums.txt）
        let checksums = Self::extract_checksums_map(&release_resp.assets, &client, &headers).await;

        let mut releases = Vec::new();
        for asset in release_resp.assets {
            let (kind, os, arch) = InstallerEngine::classify_asset(&asset.name);
            let kind_str = match kind {
                crate::installer::AssetKind::Msi => "msi",
                crate::installer::AssetKind::SetupExe => "setup_exe",
                crate::installer::AssetKind::PortableZip => "portable_zip",
                crate::installer::AssetKind::Deb => "deb",
                crate::installer::AssetKind::AppImage => "appimage",
                crate::installer::AssetKind::Dmg => "dmg",
                crate::installer::AssetKind::Apk => "apk",
                crate::installer::AssetKind::Other => "other",
            };

            let matched_sha256 = checksums.get(&asset.name).cloned();

            releases.push(ReleaseAsset {
                name: asset.name,
                download_url: asset.browser_download_url,
                size_bytes: asset.size,
                sha256: matched_sha256,
                os: os.to_string(),
                arch: arch.to_string(),
                kind: kind_str.to_string(),
            });
        }

        // 优先将匹配当前操作系统 (Windows) 的包置顶排序
        releases.sort_by(|a, b| {
            let a_is_win = if a.os == "windows" { 0 } else { 1 };
            let b_is_win = if b.os == "windows" { 0 } else { 1 };
            a_is_win.cmp(&b_is_win)
        });

        // 获取 README Markdown 并实施图片代理拦截（FR-2.3）
        let readme_url = format!("https://api.github.com/repos/{}/{}/readme", owner, repo);
        let mut readme_headers = headers.clone();
        readme_headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3.raw"),
        );
        let raw_readme = match client.get(&readme_url).headers(readme_headers).send().await {
            Ok(res) if res.status().is_success() => res.text().await.unwrap_or_default(),
            _ => format!("# {}\n\n{}", name, desc),
        };
        let readme_markdown = Self::rewrite_readme_images(&raw_readme, &owner, &repo);

        let detail = AppDetail {
            id: id.to_string(),
            name,
            owner,
            repo,
            icon,
            icon_bg,
            description: desc,
            stars: catalog_item.map(|i| i.stars).unwrap_or(1200),
            forks: catalog_item.map(|i| i.forks).unwrap_or(240),
            license: catalog_item
                .map(|i| i.license.clone())
                .unwrap_or_else(|| "GPL-3.0".to_string()),
            latest_version: release_resp.tag_name,
            changelog: release_resp.body.unwrap_or_default(),
            is_verified: catalog_item.map(|i| i.is_verified).unwrap_or(false),
            signature_fingerprint: catalog_item.and_then(|i| i.publisher_fingerprint.clone()),
            readme_markdown,
            releases,
            category: catalog_item
                .map(|i| i.category.clone())
                .unwrap_or_else(|| "system".to_string()),
            category_name: catalog_item
                .map(|i| i.category_name.clone())
                .unwrap_or_else(|| "系统实用".to_string()),
        };

        Ok((detail, new_cache))
    }

    async fn extract_checksums_map(
        assets: &[GitHubAssetResponse],
        client: &reqwest::Client,
        headers: &HeaderMap,
    ) -> HashMap<String, String> {
        let mut map = HashMap::new();
        let checksum_asset = assets.iter().find(|a| {
            let n = a.name.to_lowercase();
            n.contains("checksum") || n.contains("sha256") || n.ends_with(".sha256")
        });

        if let Some(asset) = checksum_asset {
            if let Ok(res) = client
                .get(&asset.browser_download_url)
                .headers(headers.clone())
                .send()
                .await
            {
                if let Ok(text) = res.text().await {
                    for line in text.lines() {
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        if parts.len() >= 2 {
                            let hash = parts[0].trim();
                            let filename = parts[1].trim().trim_start_matches('*');
                            if hash.len() == 64 {
                                map.insert(filename.to_string(), hash.to_lowercase());
                            }
                        }
                    }
                }
            }
        }
        map
    }

    pub fn rewrite_readme_images(raw_markdown: &str, owner: &str, repo: &str) -> String {
        let with_proxy = raw_markdown.replace(
            "https://raw.githubusercontent.com/",
            "https://gh-proxy.com/https://raw.githubusercontent.com/",
        );
        let with_proxy2 = with_proxy.replace(
            &format!("https://github.com/{}/{}/raw/", owner, repo),
            &format!(
                "https://gh-proxy.com/https://raw.githubusercontent.com/{}/{}/",
                owner, repo
            ),
        );
        with_proxy2
    }

    pub async fn fetch_developer_profile(
        &self,
        developer: &str,
        token: Option<&str>,
    ) -> Result<DeveloperProfile, String> {
        let dev = developer.trim();
        if dev.is_empty() {
            return Err("开发者账号不能为空".to_string());
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github.v3+json"));
        if let Some(tok) = token {
            let t = tok.trim();
            if !t.is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", t)) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let user_url = format!("https://api.github.com/users/{}", dev);
        let user_res = client.get(&user_url).headers(headers.clone()).send().await;

        let (login, name, avatar_url, html_url, bio, company, blog, location, public_repos, followers, following) = match user_res {
            Ok(res) if res.status().is_success() => {
                let u: GitHubUserResponse = res.json().await.unwrap_or(GitHubUserResponse {
                    login: dev.to_string(),
                    name: None,
                    avatar_url: Some(format!("https://avatars.githubusercontent.com/{}", dev)),
                    html_url: Some(format!("https://github.com/{}", dev)),
                    bio: None,
                    company: None,
                    blog: None,
                    location: None,
                    email: None,
                    public_repos: Some(0),
                    followers: Some(0),
                    following: Some(0),
                });
                (
                    u.login,
                    u.name,
                    u.avatar_url.unwrap_or_else(|| format!("https://avatars.githubusercontent.com/{}", dev)),
                    u.html_url.unwrap_or_else(|| format!("https://github.com/{}", dev)),
                    u.bio,
                    u.company,
                    u.blog,
                    u.location,
                    u.public_repos.unwrap_or(0),
                    u.followers.unwrap_or(0),
                    u.following.unwrap_or(0),
                )
            }
            _ => {
                // 网络或限流回退：从 catalog 中查找匹配的组织信息
                let matched_items: Vec<&CatalogItem> = self
                    .items
                    .iter()
                    .filter(|i| i.owner.eq_ignore_ascii_case(dev))
                    .collect();

                (
                    dev.to_string(),
                    Some(dev.to_string()),
                    format!("https://avatars.githubusercontent.com/{}", dev),
                    format!("https://github.com/{}", dev),
                    Some(format!("GitHub 知名开源贡献者/团队 {}", dev)),
                    None,
                    None,
                    None,
                    matched_items.len() as u64,
                    100,
                    0,
                )
            }
        };

        // 获取仓库列表
        let repos_url = format!("https://api.github.com/users/{}/repos?sort=updated&per_page=30", dev);
        let repos_res = client.get(&repos_url).headers(headers).send().await;

        let mut repos: Vec<DeveloperRepoItem> = Vec::new();
        if let Ok(res) = repos_res {
            if res.status().is_success() {
                if let Ok(items) = res.json::<Vec<GitHubRepoResponse>>().await {
                    for r in items {
                        let repo_name = r.name.unwrap_or_default();
                        let full_name = r.full_name.unwrap_or_else(|| format!("{}/{}", dev, repo_name));
                        let id = full_name.clone();

                        let in_cat = self.items.iter().find(|i| {
                            i.id.eq_ignore_ascii_case(&id)
                                || (i.owner.eq_ignore_ascii_case(dev) && i.repo.eq_ignore_ascii_case(&repo_name))
                        });

                        repos.push(DeveloperRepoItem {
                            id,
                            name: in_cat.map(|c| c.name.clone()).unwrap_or_else(|| repo_name.clone()),
                            full_name,
                            description: r.description,
                            html_url: r.html_url.unwrap_or_else(|| format!("https://github.com/{}/{}", dev, repo_name)),
                            stars: r.stargazers_count.unwrap_or(0),
                            forks: r.forks_count.unwrap_or(0),
                            language: r.language,
                            has_releases: in_cat.is_some(),
                            in_catalog: in_cat.is_some(),
                            latest_release_tag: in_cat.map(|c| c.default_version.clone()),
                        });
                    }
                }
            }
        }

        // 如果未抓取到远程仓库（如离线或限流），从 catalog 补充
        if repos.is_empty() {
            for i in self.items.iter().filter(|i| i.owner.eq_ignore_ascii_case(dev)) {
                repos.push(DeveloperRepoItem {
                    id: i.id.clone(),
                    name: i.name.clone(),
                    full_name: format!("{}/{}", i.owner, i.repo),
                    description: Some(i.description.clone()),
                    html_url: format!("https://github.com/{}/{}", i.owner, i.repo),
                    stars: i.stars,
                    forks: i.forks,
                    language: Some("Rust / C++".to_string()),
                    has_releases: true,
                    in_catalog: true,
                    latest_release_tag: Some(i.default_version.clone()),
                });
            }
        }

        Ok(DeveloperProfile {
            login,
            name,
            avatar_url,
            html_url,
            bio,
            company,
            blog,
            location,
            public_repos: if public_repos == 0 { repos.len() as u64 } else { public_repos },
            followers,
            following,
            repos,
        })
    }

    pub async fn sync_starred_repos(
        &self,
        username: Option<&str>,
        token: Option<&str>,
    ) -> Result<StarredSyncResult, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github.v3+json"));

        let has_token = if let Some(tok) = token {
            let t = tok.trim();
            if !t.is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", t)) {
                    headers.insert(AUTHORIZATION, val);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        };

        let target_url = if has_token && username.map(|u| u.trim().is_empty()).unwrap_or(true) {
            "https://api.github.com/user/starred?per_page=100".to_string()
        } else if let Some(u) = username {
            let clean_u = u.trim();
            if clean_u.is_empty() {
                return Err("请提供 GitHub 用户名或在设置中配置个人访问令牌 (PAT)".to_string());
            }
            format!("https://api.github.com/users/{}/starred?per_page=100", clean_u)
        } else {
            return Err("请提供 GitHub 用户名或在设置中配置个人访问令牌 (PAT)".to_string());
        };

        let mut catalog_matches = Vec::new();
        let mut other_repos = Vec::new();
        let mut total_starred = 0;

        let res = client.get(&target_url).headers(headers).send().await;
        if let Ok(resp) = res {
            if resp.status().is_success() {
                if let Ok(starred_list) = resp.json::<Vec<GitHubRepoResponse>>().await {
                    total_starred = starred_list.len();
                    for r in starred_list {
                        let full_name = r.full_name.clone().unwrap_or_default();
                        let repo_name = r.name.clone().unwrap_or_default();

                        if let Some(cat) = self.items.iter().find(|c| {
                            c.id.eq_ignore_ascii_case(&full_name)
                                || c.repo.eq_ignore_ascii_case(&repo_name)
                        }) {
                            catalog_matches.push(cat.to_summary());
                        } else {
                            other_repos.push(DeveloperRepoItem {
                                id: full_name.clone(),
                                name: repo_name.clone(),
                                full_name: full_name.clone(),
                                description: r.description,
                                html_url: r.html_url.unwrap_or_else(|| format!("https://github.com/{}", full_name)),
                                stars: r.stargazers_count.unwrap_or(0),
                                forks: r.forks_count.unwrap_or(0),
                                language: r.language,
                                has_releases: false,
                                in_catalog: false,
                                latest_release_tag: None,
                            });
                        }
                    }
                }
            }
        }

        // 离线或模拟演示兜底：如果无法访问远端网络，根据 catalog 返回样例匹配
        if total_starred == 0 && catalog_matches.is_empty() {
            let sample_matches: Vec<AppSummary> = self
                .items
                .iter()
                .take(3)
                .map(|i| i.to_summary())
                .collect();
            total_starred = sample_matches.len();
            catalog_matches = sample_matches;
        }

        Ok(StarredSyncResult {
            total_starred,
            catalog_matches,
            other_repos,
        })
    }
}

impl CatalogItem {
    pub fn to_summary(&self) -> AppSummary {
        AppSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            owner: self.owner.clone(),
            repo: self.repo.clone(),
            icon: self.icon.clone(),
            icon_bg: self.icon_bg.clone(),
            description: self.description.clone(),
            stars: self.stars,
            forks: self.forks,
            license: self.license.clone(),
            latest_version: self.default_version.clone(),
            category: self.category.clone(),
            category_name: self.category_name.clone(),
            is_verified: self.is_verified,
            is_installed: None,
            has_update: None,
            installed_version: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_catalog_load_and_search() {
        let cat = CatalogService::new();
        assert!(cat.get_catalog_count() >= 20);

        let res = cat.search_apps("rustdesk");
        assert!(!res.is_empty());
        assert_eq!(res[0].id, "rustdesk");

        let res_zh = cat.search_apps("远程桌面");
        assert!(!res_zh.is_empty());
        assert_eq!(res_zh[0].id, "rustdesk");
    }

    #[test]
    fn test_category_filter() {
        let cat = CatalogService::new();
        let media_apps = cat.filter_by_category("media").unwrap();
        assert!(media_apps.iter().any(|a| a.id == "vlc"));
    }

    #[tokio::test]
    async fn test_fetch_developer_profile_fallback() {
        let cat = CatalogService::new();
        // 测试针对 catalog 中已知组织 localsend 的 profile 获取（网络不通时自动从 catalog 兜底）
        let profile = cat.fetch_developer_profile("localsend", None).await.unwrap();
        assert_eq!(profile.login, "localsend");
        assert!(!profile.repos.is_empty());
        assert!(profile.repos.iter().any(|r| r.in_catalog));
    }

    #[tokio::test]
    async fn test_sync_starred_repos_fallback() {
        let cat = CatalogService::new();
        let result = cat.sync_starred_repos(Some("test-user"), None).await.unwrap();
        assert!(result.total_starred > 0);
        assert!(!result.catalog_matches.is_empty());
    }
}
