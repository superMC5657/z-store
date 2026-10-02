use super::CatalogService;
use crate::models::AppSummary;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct OnlineSearchResponse {
    items: Vec<OnlineSearchItem>,
}

#[derive(Debug, Deserialize)]
struct OnlineSearchItem {
    name: String,
    full_name: String,
    owner: OnlineSearchOwner,
    description: Option<String>,
    stargazers_count: u64,
    forks_count: u64,
    #[serde(default)]
    topics: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct OnlineSearchOwner {
    login: String,
}

#[derive(Debug, Deserialize)]
struct OnlineRepoResponse {
    name: Option<String>,
    description: Option<String>,
    stargazers_count: Option<u64>,
    forks_count: Option<u64>,
    license: Option<OnlineRepoLicense>,
    homepage: Option<String>,
    #[serde(default)]
    topics: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct OnlineRepoLicense {
    spdx_id: Option<String>,
}

impl CatalogService {
    pub async fn search_github_online(
        &self,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<AppSummary>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
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
        let client = super::http::build_api_client()?;

        let headers = super::http::token_headers(token);

        let per_page = crate::config::get_project_config()
            .limits
            .online_search_page_size;
        let url = format!(
            "https://api.github.com/search/repositories?q={}+in:name,description&sort=stars&order=desc&per_page={}",
            urlencoding::encode(q),
            per_page
        );

        let safe_url = crate::log_support::sanitize_url(&url);
        let (req_id, sid) = super::http::new_log_ctx();
        let req_host = crate::log_support::host_of(&url);
        log::debug!(
            "http search start sid={} req={} url='{}'",
            sid,
            req_id,
            safe_url
        );
        let start_search = std::time::Instant::now();
        let resp = client.get(&url).headers(headers).send().await;
        let elapsed = start_search.elapsed().as_millis();
        if let Ok(ref res) = resp {
            log::debug!(
                "http search resp sid={} req={} url='{}' status={} elapsed_ms={}",
                sid,
                req_id,
                safe_url,
                res.status().as_u16(),
                elapsed
            );
            log::info!(
                "http resp search sid={} req={} host={} status={} elapsed_ms={}",
                sid,
                req_id,
                req_host,
                res.status().as_u16(),
                elapsed
            );
        } else if let Err(ref e) = resp {
            log::warn!(
                "http search failed sid={} req={} host={} reason={} elapsed_ms={}",
                sid,
                req_id,
                req_host,
                crate::log_support::short_reason(&e.to_string()),
                elapsed
            );
        }

        if let Ok(res) = resp {
            crate::notify_rate_limit("github.com", res.headers());
            if res.status().is_success() {
                if let Ok(data) = res.json::<OnlineSearchResponse>().await {
                    let db_opt = super::http::open_db_opt();
                    let summaries: Vec<AppSummary> = futures_util::future::join_all(
                        data.items.into_iter().map(|it| {
                            let client = &client;
                            let confirmed_icon = db_opt.as_ref().and_then(|db| {
                                super::http::resolve_confirmed_icon_from_db(
                                    db,
                                    &it.full_name,
                                    &it.owner.login,
                                    it.full_name.split('/').nth(1).unwrap_or(""),
                                )
                            });
                            async move {
                                let owner = it.owner.login;
                                let repo = it.full_name.split('/').nth(1).unwrap_or("").to_string();
                                let description_en = it.description.clone();
                                let description =
                                    it.description.unwrap_or_else(|| "开源软件项目".to_string());
                                let topics = it.topics.unwrap_or_default();
                                super::http::fallback_summary(
                                    client,
                                    it.full_name,
                                    it.name,
                                    owner,
                                    repo,
                                    description,
                                    description_en,
                                    it.stargazers_count,
                                    it.forks_count,
                                    "OpenSource".to_string(),
                                    &topics,
                                    None,
                                    false,
                                    confirmed_icon,
                                )
                                .await
                            }
                        }),
                    )
                    .await;
                    log::debug!(
                        "http search done sid={} req={} url='{}' hits={}",
                        sid,
                        req_id,
                        safe_url,
                        summaries.len()
                    );
                    // Wave2：`search done` 的 INFO 唯一归属 commands/catalog，此处结论降级为 debug，
                    // 单次搜索只产生一行 INFO `search done`（行为链），避免双 INFO。
                    log::debug!(
                        "http resp search done sid={} req={} host={} hits={} elapsed_ms={}",
                        sid,
                        req_id,
                        req_host,
                        summaries.len(),
                        start_search.elapsed().as_millis()
                    );
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
        let client = super::http::build_api_client()?;

        let headers = super::http::token_headers(token);

        let url = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let safe_url = crate::log_support::sanitize_url(&url);
        let (req_id, sid) = super::http::new_log_ctx();
        let req_host = crate::log_support::host_of(&url);
        log::debug!(
            "http get repo id={}/{} sid={} req={} url='{}'",
            owner,
            repo,
            sid,
            req_id,
            safe_url
        );
        let start_fetch = std::time::Instant::now();
        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| {
                log::warn!(
                    "http get repo failed id={}/{} sid={} req={} host={} reason={}",
                    owner,
                    repo,
                    sid,
                    req_id,
                    req_host,
                    crate::log_support::short_reason(&e.to_string())
                );
                e.to_string()
            })?;
        let elapsed = start_fetch.elapsed().as_millis();
        log::debug!(
            "http resp repo id={}/{} sid={} req={} url='{}' status={} elapsed_ms={}",
            owner,
            repo,
            sid,
            req_id,
            safe_url,
            resp.status().as_u16(),
            elapsed
        );
        log::info!(
            "http resp repo id={}/{} sid={} req={} host={} status={} elapsed_ms={}",
            owner,
            repo,
            sid,
            req_id,
            req_host,
            resp.status().as_u16(),
            elapsed
        );

        crate::notify_rate_limit("github.com", resp.headers());

        if !resp.status().is_success() {
            return Err(format!("未找到该 GitHub 仓库: {}/{}", owner, repo));
        }

        let repo_data: OnlineRepoResponse = resp.json().await.map_err(|e| e.to_string())?;
        let repo_desc = repo_data.description.clone();
        let license = repo_data
            .license
            .and_then(|l| l.spdx_id)
            .unwrap_or_else(|| "FLOSS".to_string());
        let topics = repo_data.topics.unwrap_or_default();
        let confirmed_icon = super::http::open_db_opt().and_then(|db| {
            super::http::resolve_confirmed_icon_from_db(&db, &format!("{}/{}", owner, repo), owner, repo)
        });
        Ok(super::http::fallback_summary(
            &client,
            format!("{}/{}", owner, repo),
            repo_data.name.unwrap_or_else(|| repo.to_string()),
            owner.to_string(),
            repo.to_string(),
            repo_desc.clone().unwrap_or_default(),
            repo_desc,
            repo_data.stargazers_count.unwrap_or(0),
            repo_data.forks_count.unwrap_or(0),
            license,
            &topics,
            repo_data.homepage,
            true,
            confirmed_icon,
        )
        .await)
    }
}
