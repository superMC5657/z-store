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
    license: Option<OnlineRepoLicense>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    default_branch: Option<String>,
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
    default_branch: Option<String>,
    #[serde(default)]
    topics: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct OnlineRepoLicense {
    #[serde(default)]
    key: Option<String>,
    spdx_id: Option<String>,
}

fn resolve_online_license(lic: Option<&OnlineRepoLicense>) -> Option<String> {
    let l = lic?;
    if let Some(ref spdx) = l.spdx_id {
        let trimmed = spdx.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("NOASSERTION") {
            return Some(trimmed.to_string());
        }
    }
    if let Some(ref key) = l.key {
        let trimmed = key.trim();
        if let Some(&matched) = crate::config::DEFAULT_LICENSE_ALLOWLIST
            .iter()
            .find(|&&allowed| allowed.eq_ignore_ascii_case(trimmed))
        {
            return Some(matched.to_string());
        }
    }
    None
}

impl CatalogService {
    /// Top1 灭 N+1（`Send` 安全）：本函数零 DB（零直连零查询，`Send` 无借用），首屏 `probe=false` 置空图标；
    /// 确认图标由调用方 `commands::catalog_search` 经 `state.db()` 单锁批量 enrich 统一回填（`ok()` 吞错不 panic）。
    /// 单仓直查透传调用方预解析的 owned 确认图标（`Send`），免二次查询/直连。
    pub async fn search_github_online(
        &self,
        query: &str,
        token: Option<&str>,
        pre_confirmed_for_direct: Option<String>,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<Vec<AppSummary>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }

        // 检查是否直接输入了 owner/repo 格式（直查单条只回第 1 页，page>1 回空，与 mock 同语义）
        if q.contains('/') && !q.contains(' ') {
            if crate::config::LimitsConfig::normalize_online_search_page(page) > 1 {
                return Ok(Vec::new());
            }
            let parts: Vec<&str> = q.split('/').collect();
            if parts.len() == 2 {
                let owner = parts[0];
                let repo = parts[1];
                if let Ok(item) = self
                    .fetch_online_repo(owner, repo, token, pre_confirmed_for_direct)
                    .await
                {
                    return Ok(vec![item]);
                }
            }
        }

        // 在线 GitHub Search API 回退
        let client = super::http::build_api_client()?;

        let headers = super::http::token_headers(token);

        let per_page = crate::config::get_project_config()
            .limits
            .clamp_online_search_per_page(per_page);
        let eff_page = crate::config::LimitsConfig::normalize_online_search_page(page);
        let url = format!(
            "https://api.github.com/search/repositories?q={}+in:name,description&sort=stars&order=desc&per_page={}&page={}",
            urlencoding::encode(q),
            per_page,
            eff_page
        );

        let resp = client.get(&url).headers(headers).send().await;

        // 失败上浮错误态（区分 空结果 / 网络失败）：网络错误、非 2xx、
        // JSON 解析失败一律返回 Err，不返回空结果冒充"无命中"；前端 `useSearchState`
        // 已有 error 车道（`search.online_failed`），直查回退搜索的既有分流不变。
        let res = match resp {
            Ok(res) => res,
            Err(e) => {
                return Err(format!(
                    "GitHub 搜索网络失败: {}",
                    crate::log_support::short_reason(&e.to_string())
                ));
            }
        };

        crate::notify_rate_limit("github.com", res.headers());
        if !res.status().is_success() {
            return Err(format!(
                "GitHub 搜索请求失败（HTTP {}）",
                res.status().as_u16()
            ));
        }
        let data: OnlineSearchResponse = res
            .json()
            .await
            .map_err(|e| format!("解析 GitHub 搜索结果失败: {}", e))?;
        // Top1：零 DB（零直连零查询，`Send` 安全），每条直接 `None`；
        // `fallback_summary`（`probe=false` + `None`）直接置空零直连，确认图标由调用方单锁批量回填。
        let summaries: Vec<AppSummary> =
            futures_util::future::join_all(data.items.into_iter().map(|it| {
                let client = &client;
                async move {
                    let owner = it.owner.login;
                    let repo = it.full_name.split('/').nth(1).unwrap_or("").to_string();
                    if let Some(ref b) = it.default_branch {
                        crate::icons::remember_repo_default_branch(&owner, &repo, b);
                    }
                    let description_en = it.description.clone();
                    let description = it.description.unwrap_or_else(|| "开源软件项目".to_string());
                    let topics = it.topics.unwrap_or_default();
                    let license = resolve_online_license(it.license.as_ref())
                        .unwrap_or_else(|| "OpenSource".to_string());
                    let homepage = it.homepage.filter(|h| !h.trim().is_empty());
                    // 首屏快返：probe=false 置空图标，等后台快慢分离补探 emit。
                    super::http::fallback_summary(
                        client,
                        it.full_name.to_lowercase(),
                        it.name,
                        owner,
                        repo,
                        description,
                        description_en,
                        it.stargazers_count,
                        it.forks_count,
                        license,
                        &topics,
                        homepage,
                        false,
                        None,
                        token,
                    )
                    .await
                }
            }))
            .await;
        Ok(summaries)
    }

    /// 纯同步从 GitHub `/repos/{owner}/{repo}` JSON 文本构建 `AppSummary`（零网络、零 DB 直连）。
    pub(crate) fn parse_summary_from_repo_json(
        owner: &str,
        repo: &str,
        payload_json: &str,
        confirmed_icon: Option<String>,
    ) -> Result<AppSummary, String> {
        let repo_data: OnlineRepoResponse =
            serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
        if let Some(ref b) = repo_data.default_branch {
            crate::icons::remember_repo_default_branch(owner, repo, b);
        }
        let repo_desc = repo_data.description.clone();
        let description = repo_desc.clone().unwrap_or_default();
        let license = resolve_online_license(repo_data.license.as_ref())
            .unwrap_or_else(|| "unknown".to_string());
        let topics = repo_data.topics.unwrap_or_default();
        let cat = super::http::guess_category(Some(&description), repo_desc.as_deref(), &topics);
        Ok(AppSummary {
            core: crate::models::AppCore {
                id: crate::forge::canonical_app_id_from_parts(owner, repo),
                name: repo_data.name.unwrap_or_else(|| repo.to_string()),
                description_en: repo_desc,
                owner: owner.to_string(),
                repo: repo.to_string(),
                icon: confirmed_icon.unwrap_or_default(),
                icon_bg: cat.gradient.to_string(),
                description,
                stars: repo_data.stargazers_count.unwrap_or(0),
                forks: repo_data.forks_count.unwrap_or(0),
                license,
                latest_version: "latest".to_string(),
                category: cat.key.to_string(),
                category_name: cat.name.to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: repo_data.homepage.filter(|h| !h.trim().is_empty()),
                platforms: Vec::new(),
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
            },
        })
    }

    /// 从 GitHub `/repos/{owner}/{repo}` JSON 文本构建 `AppSummary`（`probe` 控制是否内联探测图标）。
    pub(crate) async fn build_summary_from_repo_json(
        client: &reqwest::Client,
        owner: &str,
        repo: &str,
        payload_json: &str,
        pre_confirmed: Option<String>,
        probe: bool,
        token: Option<&str>,
    ) -> Result<AppSummary, String> {
        let repo_data: OnlineRepoResponse =
            serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
        if let Some(ref b) = repo_data.default_branch {
            crate::icons::remember_repo_default_branch(owner, repo, b);
        }
        let repo_desc = repo_data.description.clone();
        let license = resolve_online_license(repo_data.license.as_ref())
            .unwrap_or_else(|| "unknown".to_string());
        let topics = repo_data.topics.unwrap_or_default();
        let item = super::http::fallback_summary(
            client,
            crate::forge::canonical_app_id_from_parts(owner, repo),
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
            probe,
            pre_confirmed,
            token,
        )
        .await;
        Ok(item)
    }

    /// 带预读 ETag 与缓存载荷的单仓拉取（fetch 内零 DB 查询、零 DB 直连，遵 ADR-0015）：
    /// 调用方在单次短锁内预读 `cached_etag` / `cached_payload` 传入，并在批量完成后统一落库返回的 `(endpoint_url, etag, payload_json)`。
    pub async fn fetch_online_repo_with_etag(
        &self,
        owner: &str,
        repo: &str,
        token: Option<&str>,
        pre_confirmed: Option<String>,
        cached_etag: Option<String>,
        cached_payload: Option<String>,
    ) -> Result<(AppSummary, Option<(String, String, String)>), String> {
        let client = crate::shared_http_client();
        let headers = super::http::token_headers(token);

        let url = format!(
            "https://api.github.com/repos/{}/{}",
            urlencoding::encode(owner),
            urlencoding::encode(repo)
        );

        match super::http::get_with_etag(&client, &url, None, &headers, cached_etag.as_deref())
            .await
        {
            super::http::EtagGetOutcome::Fresh { text, etag } => {
                let item = Self::build_summary_from_repo_json(
                    &client,
                    owner,
                    repo,
                    &text,
                    pre_confirmed,
                    true,
                    token,
                )
                .await?;
                let etag_to_save = etag.map(|e| (url, e, text));
                Ok((item, etag_to_save))
            }
            super::http::EtagGetOutcome::NotModified => {
                if let Some(ref cached_text) = cached_payload {
                    let item = Self::build_summary_from_repo_json(
                        &client,
                        owner,
                        repo,
                        cached_text,
                        pre_confirmed,
                        true,
                        token,
                    )
                    .await?;
                    return Ok((item, None));
                }
                Err(format!("未找到该 GitHub 仓库: {}/{}", owner, repo))
            }
            super::http::EtagGetOutcome::Unauthorized | super::http::EtagGetOutcome::Failed => {
                if let Some(ref cached_text) = cached_payload {
                    if let Ok(item) = Self::build_summary_from_repo_json(
                        &client,
                        owner,
                        repo,
                        cached_text,
                        pre_confirmed,
                        true,
                        token,
                    )
                    .await
                    {
                        return Ok((item, None));
                    }
                }
                Err(format!("未找到该 GitHub 仓库: {}/{}", owner, repo))
            }
        }
    }

    /// Top1+`Send` 安全：`pre_confirmed` 为调用方短锁预解析的 owned 确认图标，
    /// 传不进（`None`）时回退兜底不 panic，单条非 N+1；落库收敛至调用方批量 enrich，此处零写。
    pub async fn fetch_online_repo(
        &self,
        owner: &str,
        repo: &str,
        token: Option<&str>,
        pre_confirmed: Option<String>,
    ) -> Result<AppSummary, String> {
        self.fetch_online_repo_with_etag(owner, repo, token, pre_confirmed, None, None)
            .await
            .map(|(item, _)| item)
    }
}
