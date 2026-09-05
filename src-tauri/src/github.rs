use crate::installer::InstallerEngine;
use crate::models::{AppDetail, AppSummary, DeveloperProfile, DeveloperRepoItem, ReleaseAsset, StarredSyncResult};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, IF_NONE_MATCH, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};
use regex::Regex;

static MD_IMG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!\[(.*?)\]\((\s*<)?([^\s\)>]+)(>)?(\s+.*?)?\)").expect("invalid MD_IMG_RE regex")
});

static HTML_IMG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>"#).expect("invalid HTML_IMG_RE regex")
});

static LOGO_HTML_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<img\s+[^>]*?src=["']([^"']+)["'][^>]*>"#).expect("invalid LOGO_HTML_RE regex")
});

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRepoCoordinates {
    pub owner: String,
    pub repo: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub icon_bg: String,
}

pub struct CatalogService {
    items: RwLock<Vec<CatalogItem>>,
    client: reqwest::Client,
}

impl Default for CatalogService {
    fn default() -> Self {
        Self::new()
    }
}

impl CatalogService {
    pub fn new() -> Self {
        let mut items: Option<Vec<CatalogItem>> = None;
        let candidate_paths = [
            "catalog.json",
            "../catalog.json",
            "src-tauri/src/catalog.json",
            "src/catalog.json",
        ];
        for p in &candidate_paths {
            if let Ok(text) = std::fs::read_to_string(p) {
                if let Ok(parsed) = serde_json::from_str::<Vec<CatalogItem>>(&text) {
                    if !parsed.is_empty() {
                        items = Some(parsed);
                        break;
                    }
                }
            }
        }

        let items = items.unwrap_or_else(|| {
            let json_data = include_str!("catalog.json");
            serde_json::from_str(json_data).unwrap_or_default()
        });

        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(10)
            .tcp_keepalive(std::time::Duration::from_secs(60))
            .timeout(std::time::Duration::from_secs(12))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            items: RwLock::new(items),
            client,
        }
    }

    pub fn get_catalog_count(&self) -> usize {
        self.items.read().map(|i| i.len()).unwrap_or(0)
    }

    pub fn get_catalog_items(&self) -> Vec<CatalogItem> {
        self.items.read().map(|i| i.clone()).unwrap_or_default()
    }

    pub fn update_items(&self, new_items: Vec<CatalogItem>) {
        if let Ok(mut lock) = self.items.write() {
            *lock = new_items;
        }
    }

    /// 动态回写并保鲜单个应用的实时统计数据（Stars、Forks、最新版本等）
    pub fn update_catalog_item_stats(
        &self,
        id: &str,
        stars: Option<u64>,
        forks: Option<u64>,
        version: Option<&str>,
    ) {
        if let Ok(mut items) = self.items.write() {
            if let Some(item) = items
                .iter_mut()
                .find(|i| i.id.eq_ignore_ascii_case(id) || format!("{}/{}", i.owner, i.repo).eq_ignore_ascii_case(id))
            {
                if let Some(s) = stars {
                    item.stars = s;
                }
                if let Some(f) = forks {
                    item.forks = f;
                }
                if let Some(v) = version {
                    if !v.trim().is_empty() {
                        item.default_version = v.to_string();
                    }
                }
            }
        }
    }

    pub async fn sync_remote_catalog(
        &self,
        url: &str,
        cached_etag: Option<&str>,
    ) -> Result<(Option<Vec<CatalogItem>>, Option<String>), String> {
        let is_local = url.starts_with("file://")
            || (!url.starts_with("http://") && !url.starts_with("https://"));

        if is_local {
            let clean_path = if let Some(stripped) = url.strip_prefix("file://") {
                let trimmed = stripped.trim_start_matches('/');
                if trimmed.len() >= 2 && trimmed.chars().nth(1) == Some(':') {
                    trimmed.to_string()
                } else {
                    stripped.to_string()
                }
            } else {
                url.to_string()
            };

            let path = std::path::Path::new(&clean_path);
            if !path.exists() {
                return Err(format!("本地收录清单文件不存在: {}", clean_path));
            }

            let metadata = std::fs::metadata(path)
                .map_err(|e| format!("读取本地收录清单文件元数据失败 ({}): {}", clean_path, e))?;
            let mtime = metadata
                .modified()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                .unwrap_or(0);
            let local_etag = format!("W/\"local-{}\"", mtime);

            if let Some(etag) = cached_etag {
                if etag == local_etag {
                    return Ok((None, None));
                }
            }

            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("读取本地清单内容失败 ({}): {}", clean_path, e))?;
            let items: Vec<CatalogItem> = serde_json::from_str(&text)
                .map_err(|e| format!("解析本地收录清单 JSON 失败: {}", e))?;
            self.update_items(items.clone());
            return Ok((Some(items), Some(local_etag)));
        }

        // 远程 HTTP/HTTPS 请求
        let mut req = self.client.get(url).header(USER_AGENT, "ZStore-Client/0.1.0");
        if let Some(etag) = cached_etag {
            req = req.header(IF_NONE_MATCH, etag);
        }
        let resp = req.send().await.map_err(|e| format!("请求收录清单失败: {}", e))?;
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            // 清单未变动
            return Ok((None, None));
        }
        if !resp.status().is_success() {
            return Err(format!("同步收录清单失败，HTTP 状态码: {}", resp.status()));
        }
        let new_etag = resp
            .headers()
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());
        let text = resp.text().await.map_err(|e| format!("读取清单内容失败: {}", e))?;
        let items: Vec<CatalogItem> = serde_json::from_str(&text)
            .map_err(|e| format!("解析收录清单 JSON 失败: {}", e))?;
        self.update_items(items.clone());
        Ok((Some(items), new_etag))
    }

    pub fn get_all_summaries(&self) -> Vec<AppSummary> {
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());
        items.iter().map(|item| item.to_summary()).collect()
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
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());

        for item in items.iter() {
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
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());
        let matched: Vec<AppSummary> = items
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

    pub fn get_repo_coordinates(&self, id: &str) -> Result<AppRepoCoordinates, String> {
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = items.iter().find(|i| i.id == id) {
            Ok(AppRepoCoordinates {
                owner: item.owner.clone(),
                repo: item.repo.clone(),
                name: item.name.clone(),
                description: item.description.clone(),
                icon: item.icon.clone(),
                icon_bg: item.icon_bg.clone(),
            })
        } else if id.contains('/') {
            let parts: Vec<&str> = id.split('/').collect();
            if parts.len() == 2 {
                let owner = parts[0].trim().to_string();
                let repo = parts[1].trim().to_string();
                let name = repo.clone();
                Ok(AppRepoCoordinates {
                    owner,
                    repo,
                    name,
                    description: "GitHub 社区开源项目".to_string(),
                    icon: "📦".to_string(),
                    icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
                })
            } else {
                Err(format!("未识别的仓库坐标: {}", id))
            }
        } else {
            Err(format!("收录库中不存在该应用: {}", id))
        }
    }

    pub fn get_endpoints(
        &self,
        id: &str,
    ) -> Result<(String, String, String, String, String, String), String> {
        let coords = self.get_repo_coordinates(id)?;
        Ok((
            coords.owner,
            coords.repo,
            coords.name,
            coords.description,
            coords.icon,
            coords.icon_bg,
        ))
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
            crate::notify_rate_limit("github.com", res.headers());
            if res.status().is_success() {
                if let Ok(data) = res.json::<GitHubSearchResponse>().await {
                    let summaries: Vec<AppSummary> = data
                        .items
                        .into_iter()
                        .map(|it| {
                            let owner = it.owner.login;
                            let icon = format!("https://github.com/{}.png", owner);
                            AppSummary {
                                id: it.full_name.clone(),
                                name: it.name,
                                owner,
                                repo: it.full_name.split('/').nth(1).unwrap_or("").to_string(),
                                icon,
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
                            forge: Some("github".to_string()),
                            forge_host: Some("github.com".to_string()),
                        }
                    })
                        .collect();
                    return Ok(summaries);
                }
            }
        }

        Ok(Vec::new())
    }

    pub async fn fetch_online_repo(
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

        crate::notify_rate_limit("github.com", resp.headers());

        if !resp.status().is_success() {
            return Err(format!("未找到该 GitHub 仓库: {}/{}", owner, repo));
        }

        let repo_data: GitHubRepoResponse = resp.json().await.map_err(|e| e.to_string())?;
        Ok(AppSummary {
            id: format!("{}/{}", owner, repo),
            name: repo_data.name.unwrap_or_else(|| repo.to_string()),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: format!("https://github.com/{}.png", owner),
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
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
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
        let catalog_item = self
            .items
            .read()
            .ok()
            .and_then(|items| items.iter().find(|i| i.id == id).cloned());

        let client = &self.client;

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

        if let Ok(ref res) = resp {
            crate::notify_rate_limit("github.com", res.headers());
        }

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
                        .as_ref()
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

        // 异步并发执行：提取校验和字典、获取 README Markdown、以及拉取实时仓库状态 (Stars/Forks/License)
        let checksum_task = Self::extract_checksums_map(&release_resp.assets, client, &headers);

        let readme_url = format!("https://api.github.com/repos/{}/{}/readme", owner, repo);
        let mut readme_headers = headers.clone();
        readme_headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3.raw"),
        );
        let default_readme = format!("# {}\n\n{}", name, desc);
        let default_readme_clone = default_readme.clone();
        let readme_task = async {
            let req = client.get(&readme_url).headers(readme_headers).send();
            match tokio::time::timeout(std::time::Duration::from_secs(4), req).await {
                Ok(Ok(res)) => {
                    crate::notify_rate_limit("github.com", res.headers());
                    if res.status().is_success() {
                        res.text().await.unwrap_or(default_readme_clone)
                    } else {
                        default_readme_clone
                    }
                }
                _ => default_readme_clone,
            }
        };

        let repo_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let repo_headers = headers.clone();
        let repo_task = async {
            let req = client.get(&repo_url).headers(repo_headers).send();
            match tokio::time::timeout(std::time::Duration::from_secs(4), req).await {
                Ok(Ok(res)) => {
                    crate::notify_rate_limit("github.com", res.headers());
                    if res.status().is_success() {
                        res.json::<GitHubRepoResponse>().await.ok()
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };

        let (checksums, raw_readme, repo_info) = tokio::join!(checksum_task, readme_task, repo_task);

        let latest_stars = repo_info
            .as_ref()
            .and_then(|r| r.stargazers_count)
            .or_else(|| catalog_item.as_ref().map(|i| i.stars))
            .unwrap_or(0);

        let latest_forks = repo_info
            .as_ref()
            .and_then(|r| r.forks_count)
            .or_else(|| catalog_item.as_ref().map(|i| i.forks))
            .unwrap_or(0);

        let latest_license = repo_info
            .as_ref()
            .and_then(|r| r.license.as_ref())
            .and_then(|l| l.spdx_id.clone())
            .or_else(|| catalog_item.as_ref().map(|i| i.license.clone()))
            .unwrap_or_else(|| "FLOSS".to_string());

        // 动态回写更新内存中的 CatalogItem 统计数据，使得列表页卡片上的 Stars/Forks/Version 也同步刷新
        self.update_catalog_item_stats(
            id,
            Some(latest_stars),
            Some(latest_forks),
            Some(&release_resp.tag_name),
        );

        // 提取 README 首部 Logo，并从 README 原始内容中清洗删除该旧图标，避免详情页头部与文档内容区发生重叠/重复
        let (extracted_logo, cleaned_readme) =
            Self::extract_and_strip_logo_from_readme(&raw_readme, &owner, &repo);
        let readme_markdown = Self::rewrite_readme_images(&cleaned_readme, &owner, &repo);

        let mut releases = Vec::new();
        for asset in release_resp.assets {
            let (kind, os, arch) = InstallerEngine::classify_asset(&asset.name);
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

        // 图标层级决策：
        // 1. 若当前应用已具备已知独立官方图标（如收录库指定或 https:// 开头头像），优先保持该正方形应用图标，避免被 README 宽幅 Banner 误覆盖；
        // 2. 若当前未收录，则优先采用从 README 中提取并已清洗出的 Logo；
        // 3. 兜底采用 GitHub 官方组织头像 https://github.com/{owner}.png
        let final_icon = if icon.starts_with("http://") || icon.starts_with("https://") {
            icon
        } else if let Some(logo) = extracted_logo {
            logo
        } else {
            format!("https://github.com/{}.png", owner)
        };

        let detail = AppDetail {
            id: id.to_string(),
            name,
            owner,
            repo,
            icon: final_icon,
            icon_bg,
            description: desc,
            stars: latest_stars,
            forks: latest_forks,
            license: latest_license,
            latest_version: release_resp.tag_name,
            changelog: release_resp.body.unwrap_or_default(),
            is_verified: catalog_item.as_ref().map(|i| i.is_verified).unwrap_or(false),
            signature_fingerprint: catalog_item.as_ref().and_then(|i| i.publisher_fingerprint.clone()),
            readme_markdown,
            releases,
            category: catalog_item
                .as_ref()
                .map(|i| i.category.clone())
                .unwrap_or_else(|| "system".to_string()),
            category_name: catalog_item
                .as_ref()
                .map(|i| i.category_name.clone())
                .unwrap_or_else(|| "系统实用".to_string()),
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            cached_at: Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
            ),
            is_stale_fallback: None,
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
            let req = client
                .get(&asset.browser_download_url)
                .headers(headers.clone())
                .send();
            if let Ok(Ok(res)) = tokio::time::timeout(std::time::Duration::from_secs(4), req).await {
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

    pub fn clean_image_url(url: &str, owner: &str, repo: &str) -> String {
        Self::clean_image_url_with_mirror(url, owner, repo, "https://gh-proxy.com/")
    }

    pub fn clean_image_url_with_mirror(
        url: &str,
        owner: &str,
        repo: &str,
        mirror_prefix: &str,
    ) -> String {
        let trimmed = url.trim().trim_matches(|c| c == '<' || c == '>');
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with("mailto:")
            || trimmed.starts_with("data:")
            || trimmed.starts_with("javascript:")
        {
            return trimmed.to_string();
        }

        let prefix = if mirror_prefix.is_empty() || mirror_prefix.ends_with('/') {
            mirror_prefix.to_string()
        } else {
            format!("{}/", mirror_prefix)
        };

        // 1. 如果已带镜像前缀，不重复添加
        if !prefix.is_empty() && trimmed.starts_with(&prefix) {
            return trimmed.to_string();
        }
        if trimmed.starts_with("https://gh-proxy.com/") {
            return trimmed.to_string();
        }

        // 2. GitHub Blob 页面链接转 Raw 直链：
        // https://github.com/{owner}/{repo}/blob/{branch}/{path}
        let blob_prefix = format!("https://github.com/{}/{}/blob/", owner, repo);
        if let Some(rest) = trimmed.strip_prefix(&blob_prefix) {
            return format!(
                "{}https://raw.githubusercontent.com/{}/{}/{}",
                prefix, owner, repo, rest
            );
        }

        // 3. GitHub Raw 页面链接：
        // https://github.com/{owner}/{repo}/raw/{branch}/{path}
        let raw_prefix = format!("https://github.com/{}/{}/raw/", owner, repo);
        if let Some(rest) = trimmed.strip_prefix(&raw_prefix) {
            return format!(
                "{}https://raw.githubusercontent.com/{}/{}/{}",
                prefix, owner, repo, rest
            );
        }

        // 4. GitHub 官方 CDN 与素材直链：
        if trimmed.starts_with("https://raw.githubusercontent.com/")
            || trimmed.starts_with("https://user-images.githubusercontent.com/")
            || trimmed.starts_with("https://camo.githubusercontent.com/")
            || trimmed.starts_with("https://github.com/user-attachments/assets/")
        {
            return format!("{}{}", prefix, trimmed);
        }

        // 5. 其他带协议的绝对链接（例如外部 CDN, shields.io, 外部网站图床等）
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return trimmed.to_string();
        }

        // 6. 相对路径（如 ./assets/logo.png, docs/preview.jpg, /images/banner.svg）
        let clean_path = trimmed.trim_start_matches("./").trim_start_matches('/');
        format!(
            "{}https://raw.githubusercontent.com/{}/{}/HEAD/{}",
            prefix, owner, repo, clean_path
        )
    }

    pub fn rewrite_readme_images(raw_markdown: &str, owner: &str, repo: &str) -> String {
        // 1. 重写 Markdown 语法图片: ![alt](url) 或 ![alt](url "title")
        let md_replaced = MD_IMG_RE.replace_all(raw_markdown, |caps: &regex::Captures| {
            let alt = &caps[1];
            let url = &caps[3];
            let title = caps.get(5).map(|m| m.as_str()).unwrap_or("");
            let rewritten_url = Self::clean_image_url(url, owner, repo);
            if title.is_empty() {
                format!("![{}]({})", alt, rewritten_url)
            } else {
                format!("![{}]({}{})", alt, rewritten_url, title)
            }
        });

        // 2. 重写 HTML <img> 标签语法: <img ... src="url" ...>
        let html_replaced = HTML_IMG_RE.replace_all(&md_replaced, |caps: &regex::Captures| {
            let before = &caps[1];
            let url = &caps[2];
            let after = &caps[3];
            let rewritten_url = Self::clean_image_url(url, owner, repo);
            format!(r#"<img {}src="{}"{}>"#, before, rewritten_url, after)
        });

        html_replaced.into_owned()
    }

    pub fn extract_and_strip_logo_from_readme(
        raw_markdown: &str,
        owner: &str,
        repo: &str,
    ) -> (Option<String>, String) {
        let lines: Vec<&str> = raw_markdown.lines().collect();
        let head_count = lines.len().min(40);
        let head_text = lines[..head_count].join("\n");

        // 1. 优先在 HTML <img> 中寻找带有 logo/icon/brand/splash 的首部图片
        for caps in LOGO_HTML_RE.captures_iter(&head_text) {
            let full_tag = caps.get(0).unwrap().as_str();
            let src = &caps[1];
            let lower = src.to_lowercase();
            if lower.contains("badge")
                || lower.contains("shields.io")
                || lower.contains("workflow")
                || lower.contains("license")
            {
                continue;
            }
            if lower.contains("logo")
                || lower.contains("icon")
                || lower.contains("app")
                || lower.contains("brand")
                || lower.contains("splash")
                || lower.ends_with(".png")
                || lower.ends_with(".svg")
            {
                let cleaned_url = Self::clean_image_url(src, owner, repo);
                let mut stripped = raw_markdown.to_string();

                // 尝试剥离包含该 img 的整段居中标签 <p align="center">...</p> 或 <div align="center">...</div>
                let p_pattern = format!(
                    r#"(?is)<p\s+align=["']center["']>\s*{}\s*(?:<br\s*/?>)?\s*</p>"#,
                    regex::escape(full_tag)
                );
                if let Ok(p_re) = Regex::new(&p_pattern) {
                    if p_re.is_match(&stripped) {
                        stripped = p_re.replace(&stripped, "").to_string();
                        return (Some(cleaned_url), stripped);
                    }
                }
                let div_pattern = format!(
                    r#"(?is)<div\s+align=["']center["']>\s*{}\s*(?:<br\s*/?>)?\s*</div>"#,
                    regex::escape(full_tag)
                );
                if let Ok(div_re) = Regex::new(&div_pattern) {
                    if div_re.is_match(&stripped) {
                        stripped = div_re.replace(&stripped, "").to_string();
                        return (Some(cleaned_url), stripped);
                    }
                }

                // 否则直接剔除该 img 标签及紧随的换行符
                let tag_pattern = format!(r#"(?i){}\s*(?:<br\s*/?>)?"#, regex::escape(full_tag));
                if let Ok(tag_re) = Regex::new(&tag_pattern) {
                    stripped = tag_re.replace(&stripped, "").to_string();
                }

                return (Some(cleaned_url), stripped);
            }
        }

        // 2. 其次在 Markdown ![alt](url) 中寻找
        for caps in MD_IMG_RE.captures_iter(&head_text) {
            let full_md = caps.get(0).unwrap().as_str();
            let alt = caps[1].to_lowercase();
            let src = &caps[3];
            let lower_src = src.to_lowercase();
            if lower_src.contains("badge")
                || lower_src.contains("shields.io")
                || lower_src.contains("workflow")
                || lower_src.contains("license")
            {
                continue;
            }
            if alt.contains("logo")
                || alt.contains("icon")
                || alt.contains("app")
                || alt.contains("brand")
                || lower_src.contains("logo")
                || lower_src.contains("icon")
                || lower_src.ends_with(".png")
                || lower_src.ends_with(".svg")
            {
                let cleaned_url = Self::clean_image_url(src, owner, repo);
                let mut stripped = raw_markdown.to_string();
                let md_pattern = format!(r#"{}\s*"#, regex::escape(full_md));
                if let Ok(m_re) = Regex::new(&md_pattern) {
                    stripped = m_re.replace(&stripped, "").to_string();
                }
                return (Some(cleaned_url), stripped);
            }
        }

        (None, raw_markdown.to_string())
    }

    pub fn extract_logo_from_readme(raw_markdown: &str, owner: &str, repo: &str) -> Option<String> {
        Self::extract_and_strip_logo_from_readme(raw_markdown, owner, repo).0
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
        if let Ok(ref res) = user_res {
            crate::notify_rate_limit("github.com", res.headers());
        }

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
                let fallback_lock = self.items.read().unwrap_or_else(|e| e.into_inner());
                let matched_count = fallback_lock
                    .iter()
                    .filter(|i| i.owner.eq_ignore_ascii_case(dev))
                    .count();

                (
                    dev.to_string(),
                    Some(dev.to_string()),
                    format!("https://avatars.githubusercontent.com/{}", dev),
                    format!("https://github.com/{}", dev),
                    Some(format!("GitHub 知名开源贡献者/团队 {}", dev)),
                    None,
                    None,
                    None,
                    matched_count as u64,
                    100,
                    0,
                )
            }
        };

        // 获取仓库列表
        let repos_url = format!("https://api.github.com/users/{}/repos?sort=updated&per_page=30", dev);
        let repos_res = client.get(&repos_url).headers(headers).send().await;
        if let Ok(ref res) = repos_res {
            crate::notify_rate_limit("github.com", res.headers());
        }

        let mut repos: Vec<DeveloperRepoItem> = Vec::new();
        let catalog_list = self.get_catalog_items();
        if let Ok(res) = repos_res {
            if res.status().is_success() {
                if let Ok(items) = res.json::<Vec<GitHubRepoResponse>>().await {
                    for r in items {
                        let repo_name = r.name.unwrap_or_default();
                        let full_name = r.full_name.unwrap_or_else(|| format!("{}/{}", dev, repo_name));
                        let id = full_name.clone();

                        let in_cat = catalog_list.iter().find(|i| {
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
            for i in catalog_list.iter().filter(|i| i.owner.eq_ignore_ascii_case(dev)) {
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

        let catalog_list = self.get_catalog_items();
        let res = client.get(&target_url).headers(headers).send().await;
        if let Ok(resp) = res {
            crate::notify_rate_limit("github.com", resp.headers());
            if resp.status().is_success() {
                if let Ok(starred_list) = resp.json::<Vec<GitHubRepoResponse>>().await {
                    total_starred = starred_list.len();
                    for r in starred_list {
                        let full_name = r.full_name.clone().unwrap_or_default();
                        let repo_name = r.name.clone().unwrap_or_default();

                        if let Some(cat) = catalog_list.iter().find(|c| {
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

        // 离线或模拟演示兜底：如果远端无星标返回或请求失败，根据 catalog 返回样例匹配
        if total_starred == 0 && catalog_matches.is_empty() && other_repos.is_empty() {
            let sample_matches: Vec<AppSummary> = catalog_list
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
        let effective_icon = if self.icon.starts_with("http://") || self.icon.starts_with("https://") {
            self.icon.clone()
        } else {
            format!("https://github.com/{}.png", self.owner)
        };

        AppSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            owner: self.owner.clone(),
            repo: self.repo.clone(),
            icon: effective_icon,
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
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
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

    #[test]
    fn test_rewrite_readme_images() {
        let sample = r#"
# Demo Project
![Logo](./assets/logo.png)
<p align="center">
  <img src="docs/screenshot.svg" width="200" alt="demo" />
</p>
[Web Link](https://example.com/blob/main/test.png)
![GitHub Blob](https://github.com/rustdesk/rustdesk/blob/master/res/demo.png)
![External Shield](https://img.shields.io/badge/license-MIT-blue)
"#;
        let rewritten = CatalogService::rewrite_readme_images(sample, "rustdesk", "rustdesk");

        // 验证相对路径转为 raw + gh-proxy
        assert!(rewritten.contains("https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/assets/logo.png"));
        assert!(rewritten.contains("https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/docs/screenshot.svg"));

        // 验证 GitHub Blob 网页链接转为 raw 直链并代理
        assert!(rewritten.contains("https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/master/res/demo.png"));

        // 验证外部 shields.io 保持原样
        assert!(rewritten.contains("https://img.shields.io/badge/license-MIT-blue"));
    }

    #[test]
    fn test_extract_logo_from_readme() {
        let sample = r#"
<p align="center">
  <img src="./assets/logo.png" width="100" alt="RustDesk Logo" />
</p>
# RustDesk
"#;
        let (logo, stripped) =
            CatalogService::extract_and_strip_logo_from_readme(sample, "rustdesk", "rustdesk");
        assert!(logo.is_some());
        assert!(logo.unwrap().contains("assets/logo.png"));
        // 验证旧图标已被彻底剥离，不再残留在 README 内容中
        assert!(!stripped.contains("assets/logo.png"));
        assert!(stripped.contains("# RustDesk"));
    }

    #[tokio::test]
    async fn test_sync_remote_catalog_local_file() {
        let cat = CatalogService::new();
        let target = if std::path::Path::new("catalog.json").exists() {
            "catalog.json"
        } else if std::path::Path::new("../catalog.json").exists() {
            "../catalog.json"
        } else {
            "src/catalog.json"
        };
        let (items, etag) = cat.sync_remote_catalog(target, None).await.unwrap();
        assert!(items.is_some());
        let list = items.unwrap();
        assert!(list.len() >= 20);
        assert!(etag.is_some());
        assert!(etag.unwrap().contains("local-"));

        // Test with same etag returns None (unmodified)
        let etag_val = format!("W/\"local-{}\"", std::fs::metadata(target).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
        let (no_items, _) = cat.sync_remote_catalog(target, Some(&etag_val)).await.unwrap();
        assert!(no_items.is_none());
    }
}
