use super::models::{GitHubRepoResponse, GitHubUserResponse};
use super::CatalogService;
use crate::models::{DeveloperProfile, DeveloperRepoItem, StarredSyncResult};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};

/// 开发者画像仓库列表单次拉取数量
pub const DEVELOPER_REPOS_PAGE_SIZE: usize = 30;
/// GitHub Starred 列表单页最大数量（GitHub 允许的最大上限，单次拉取最大化配额效益）
pub const GITHUB_STARRED_MAX_PAGE_SIZE: usize = 100;

impl CatalogService {
    pub async fn fetch_developer_profile(
        &self,
        developer: &str,
        token: Option<&str>,
    ) -> Result<DeveloperProfile, String> {
        let dev = developer.trim();
        if dev.is_empty() {
            return Err("开发者账号不能为空".to_string());
        }

        let api_timeout = std::time::Duration::from_secs(
            crate::config::get_project_config().network.api_timeout_seconds,
        );
        let client = reqwest::Client::builder()
            .timeout(api_timeout)
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3+json"),
        );
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

        let (
            login,
            name,
            avatar_url,
            html_url,
            bio,
            company,
            blog,
            location,
            public_repos,
            followers,
            following,
        ) = match user_res {
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
                    u.avatar_url
                        .unwrap_or_else(|| format!("https://avatars.githubusercontent.com/{}", dev)),
                    u.html_url
                        .unwrap_or_else(|| format!("https://github.com/{}", dev)),
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
        let repos_url = format!(
            "https://api.github.com/users/{}/repos?sort=updated&per_page={}",
            dev, DEVELOPER_REPOS_PAGE_SIZE
        );
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
                        let full_name = r
                            .full_name
                            .unwrap_or_else(|| format!("{}/{}", dev, repo_name));
                        let id = full_name.clone();

                        let in_cat = catalog_list.iter().find(|i| {
                            i.id.eq_ignore_ascii_case(&id)
                                || (i.owner.eq_ignore_ascii_case(dev)
                                    && i.repo.eq_ignore_ascii_case(&repo_name))
                        });

                        repos.push(DeveloperRepoItem {
                            id,
                            name: in_cat
                                .map(|c| c.name.clone())
                                .unwrap_or_else(|| repo_name.clone()),
                            full_name,
                            description: r.description,
                            html_url: r
                                .html_url
                                .unwrap_or_else(|| format!("https://github.com/{}/{}", dev, repo_name)),
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
            for i in catalog_list
                .iter()
                .filter(|i| i.owner.eq_ignore_ascii_case(dev))
            {
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
            public_repos: if public_repos == 0 {
                repos.len() as u64
            } else {
                public_repos
            },
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
        let api_timeout = std::time::Duration::from_secs(
            crate::config::get_project_config().network.api_timeout_seconds,
        );
        let client = reqwest::Client::builder()
            .timeout(api_timeout)
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3+json"),
        );

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
            format!(
                "https://api.github.com/user/starred?per_page={}",
                GITHUB_STARRED_MAX_PAGE_SIZE
            )
        } else if let Some(u) = username {
            let clean_u = u.trim();
            if clean_u.is_empty() {
                return Err(
                    "请提供 GitHub 用户名或在设置中配置个人访问令牌 (PAT)".to_string(),
                );
            }
            format!(
                "https://api.github.com/users/{}/starred?per_page={}",
                clean_u, GITHUB_STARRED_MAX_PAGE_SIZE
            )
        } else {
            return Err(
                "请提供 GitHub 用户名或在设置中配置个人访问令牌 (PAT)".to_string(),
            );
        };

        let mut catalog_matches = Vec::new();
        let mut other_repos = Vec::new();

        let catalog_list = self.get_catalog_items();
        let resp = match client.get(&target_url).headers(headers).send().await {
            Ok(r) => r,
            Err(e) => {
                return Err(format!(
                    "连接 GitHub API 失败: {}. 如遇国内网络阻断，请检查网络设置或配置下载加速代理。",
                    e
                ));
            }
        };

        crate::notify_rate_limit("github.com", resp.headers());
        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();
            if code == 401 {
                return Err("GitHub 认证失败 (401): 个人访问令牌 (Token) 无效或已过期，请在「设置」中重新配置。".to_string());
            } else if code == 403 {
                return Err("GitHub API 限额已耗尽 (403): 触发了未登录 API 每小时 60 次的速率限制。请在「设置」中填入个人 GitHub Token (PAT) 即可免费提升至 5000 次/小时配额。".to_string());
            } else if code == 404 {
                let user_hint = username.unwrap_or("当前用户");
                return Err(format!(
                    "未在 GitHub 上找到用户「{}」，请检查用户名拼写是否正确。",
                    user_hint
                ));
            } else {
                return Err(format!(
                    "GitHub API 响应异常 (HTTP {}): {}",
                    code,
                    status.canonical_reason().unwrap_or("未知错误")
                ));
            }
        }

        let starred_list = resp
            .json::<Vec<GitHubRepoResponse>>()
            .await
            .map_err(|e| format!("解析 GitHub Starred 列表数据失败: {}", e))?;

        let total_starred = starred_list.len();
        for r in starred_list {
            let full_name = r.full_name.clone().unwrap_or_default();
            let repo_name = r.name.clone().unwrap_or_default();

            // 精准匹配：要求与官方 Catalog 的完整 owner/repo 严格对齐，
            // 杜绝因用户 Star 了同名第三方 Fork（如 someone/rustdesk）而被错误误判为官方应用
            if let Some(cat) = catalog_list.iter().find(|c| {
                let canonical_slug = format!("{}/{}", c.owner, c.repo);
                c.id.eq_ignore_ascii_case(&full_name)
                    || canonical_slug.eq_ignore_ascii_case(&full_name)
            }) {
                catalog_matches.push(cat.to_summary());
            } else {
                other_repos.push(DeveloperRepoItem {
                    id: full_name.clone(),
                    name: repo_name.clone(),
                    full_name: full_name.clone(),
                    description: r.description,
                    html_url: r
                        .html_url
                        .unwrap_or_else(|| format!("https://github.com/{}", full_name)),
                    stars: r.stargazers_count.unwrap_or(0),
                    forks: r.forks_count.unwrap_or(0),
                    language: r.language,
                    has_releases: false,
                    in_catalog: false,
                    latest_release_tag: None,
                });
            }
        }

        Ok(StarredSyncResult {
            total_starred,
            catalog_matches,
            other_repos,
        })
    }
}
