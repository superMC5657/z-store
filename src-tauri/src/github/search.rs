use super::models::{GitHubRepoResponse, GitHubSearchResponse};
use super::CatalogService;
use crate::models::AppSummary;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};

impl CatalogService {
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
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let per_page = crate::config::get_project_config()
            .limits
            .online_search_page_size;
        let url = format!(
            "https://api.github.com/search/repositories?q={}+in:name,description&sort=stars&order=desc&per_page={}",
            urlencoding::encode(q),
            per_page
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
                                homepage: None,
                                platforms: vec!["windows".to_string()],
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
        let api_timeout = std::time::Duration::from_secs(
            crate::config::get_project_config().network.api_timeout_seconds,
        );
        let client = reqwest::Client::builder()
            .timeout(api_timeout)
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
            homepage: repo_data.homepage,
            platforms: vec!["windows".to_string()],
        })
    }
}
