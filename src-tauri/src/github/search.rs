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
    #[serde(default)]
    private: bool,
    #[serde(default)]
    visibility: Option<String>,
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

/// 仓库 JSON 私有标记：`private == true` 或 `visibility == "private"`。
fn is_private_flag(private: bool, visibility: Option<&str>) -> bool {
    private || visibility.is_some_and(|v| v.trim().eq_ignore_ascii_case("private"))
}

/// 从 GitHub 仓库 JSON 文本读取私有标记；无法解析返回 `None`。
pub(crate) fn repo_json_is_private(payload_json: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(payload_json).ok()?;
    let obj = v.as_object()?;
    let private = obj
        .get("private")
        .and_then(|p| p.as_bool())
        .unwrap_or(false);
    let visibility = obj.get("visibility").and_then(|p| p.as_str());
    Some(is_private_flag(private, visibility))
}

/// Search API 载荷 → 卡片与私有仓库规范 id 集（`probe=false` 置空图标，零 DB）。
async fn summaries_from_search(
    client: &reqwest::Client,
    data: OnlineSearchResponse,
    token: Option<&str>,
) -> (Vec<AppSummary>, Vec<String>) {
    let private_ids: Vec<String> = data
        .items
        .iter()
        .filter(|it| is_private_flag(it.private, it.visibility.as_deref()))
        .filter_map(|it| crate::forge::canonical_app_id(&it.full_name))
        .collect();
    let summaries = futures_util::future::join_all(data.items.into_iter().map(|it| async move {
        let owner = it.owner.login;
        let repo = it.full_name.split('/').nth(1).unwrap_or("").to_string();
        if let Some(ref b) = it.default_branch {
            crate::icons::remember_repo_default_branch(&owner, &repo, b);
        }
        let description_en = it.description.clone();
        let description = it.description.unwrap_or_else(|| "开源软件项目".to_string());
        let topics = it.topics.unwrap_or_default();
        let license =
            resolve_online_license(it.license.as_ref()).unwrap_or_else(|| "OpenSource".to_string());
        let homepage = it.homepage.filter(|h| !h.trim().is_empty());
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
    }))
    .await;
    (summaries, private_ids)
}

/// 关键词在线搜索的 GitHub Search API 端点（纯函数，亦作 `api_etag_cache` 键）。
/// 空查询，或 `owner/repo` 形态翻到第 2 页以后（直查只占第 1 页），返回 `None`。
pub(crate) fn online_search_endpoint(
    query: &str,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Option<String> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    let eff_page = crate::config::LimitsConfig::normalize_online_search_page(page);
    if q.contains('/') && !q.contains(' ') && eff_page > 1 {
        return None;
    }
    let per_page = crate::config::get_project_config()
        .limits
        .clamp_online_search_per_page(per_page);
    Some(format!(
        "https://api.github.com/search/repositories?q={}+in:name,description&sort=stars&order=desc&per_page={}&page={}",
        urlencoding::encode(q),
        per_page,
        eff_page
    ))
}

/// 关键词在线搜索结果：卡片 + 需落库的新 ETag `(url, etag, payload)` + 是否 304 命中（需 touch）+ 是否回退旧载荷。
#[derive(Debug)]
pub struct OnlineSearchFetch {
    pub summaries: Vec<AppSummary>,
    /// 本页私有仓库的规范 id（`private`/`visibility == "private"`）。
    pub private_ids: Vec<String>,
    pub etag_write: Option<(String, String, String)>,
    pub touched_url: Option<String>,
    pub is_stale: bool,
}

impl CatalogService {
    /// 关键词在线搜索（GitHub Search API，走 `api_etag_cache` 条件请求）。
    /// 本函数零 DB：调用方短锁预读 `cached_etag` / `cached_payload` 传入，返回后再统一落库或 touch。
    /// - `200`：解析新载荷，返回待落库 ETag；
    /// - `304`：解析缓存载荷，零配额；
    /// - 网络/限流失败：有可解析旧载荷则回退（`is_stale=true`），否则上浮错误（区分「空结果」与「失败」）。
    ///
    /// 卡片 `probe=false` 置空图标，确认图标与后台补探由调用方处理。
    #[allow(clippy::too_many_arguments)]
    pub async fn search_github_online(
        &self,
        query: &str,
        token: Option<&str>,
        page: Option<u32>,
        per_page: Option<u32>,
        cached_etag: Option<&str>,
        cached_payload: Option<&str>,
        api_base: Option<&str>,
    ) -> Result<OnlineSearchFetch, String> {
        let Some(url) = online_search_endpoint(query, page, per_page) else {
            return Ok(OnlineSearchFetch {
                summaries: Vec::new(),
                private_ids: Vec::new(),
                etag_write: None,
                touched_url: None,
                is_stale: false,
            });
        };
        let client = super::http::build_api_client()?;
        let headers = super::http::token_headers(token);
        let cached_ok =
            cached_payload.filter(|p| serde_json::from_str::<OnlineSearchResponse>(p).is_ok());
        // 没有可用旧载荷时不发 `If-None-Match`，避免 304 后无物可回。
        let send_etag = cached_ok.and(cached_etag);
        let (outcome, diag) =
            super::http::get_with_etag_diag(&client, &url, api_base, &headers, send_etag).await;
        use super::http::EtagGetOutcome;
        match outcome {
            EtagGetOutcome::Fresh { text, etag } => {
                let data: OnlineSearchResponse = serde_json::from_str(&text)
                    .map_err(|e| format!("解析 GitHub 搜索结果失败: {}", e))?;
                let (summaries, private_ids) = summaries_from_search(&client, data, token).await;
                Ok(OnlineSearchFetch {
                    summaries,
                    private_ids,
                    etag_write: etag.map(|e| (url, e, text)),
                    touched_url: None,
                    is_stale: false,
                })
            }
            EtagGetOutcome::NotModified => {
                let data: OnlineSearchResponse = cached_ok
                    .and_then(|p| serde_json::from_str(p).ok())
                    .ok_or_else(|| "GitHub 搜索缓存缺失".to_string())?;
                let (summaries, private_ids) = summaries_from_search(&client, data, token).await;
                Ok(OnlineSearchFetch {
                    summaries,
                    private_ids,
                    etag_write: None,
                    touched_url: Some(url),
                    is_stale: false,
                })
            }
            EtagGetOutcome::Unauthorized | EtagGetOutcome::Failed => {
                if matches!(outcome, EtagGetOutcome::Unauthorized) {
                    crate::check_auth_expired(401, "op=search_online");
                }
                if let Some(data) =
                    cached_ok.and_then(|p| serde_json::from_str::<OnlineSearchResponse>(p).ok())
                {
                    let (summaries, private_ids) =
                        summaries_from_search(&client, data, token).await;
                    return Ok(OnlineSearchFetch {
                        summaries,
                        private_ids,
                        etag_write: None,
                        touched_url: None,
                        is_stale: true,
                    });
                }
                Err(match diag.status {
                    Some(code) => format!("GitHub 搜索请求失败（HTTP {}）", code),
                    None => format!(
                        "GitHub 搜索网络失败: {}",
                        diag.err_reason.as_deref().unwrap_or("network")
                    ),
                })
            }
        }
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
    /// `probe_icons=false` 时不内联探图（图标置空或沿用 `pre_confirmed`），供批量快返后交给后台流式补图。
    #[allow(clippy::too_many_arguments)]
    pub async fn fetch_online_repo_with_etag(
        &self,
        owner: &str,
        repo: &str,
        token: Option<&str>,
        pre_confirmed: Option<String>,
        cached_etag: Option<String>,
        cached_payload: Option<String>,
        probe_icons: bool,
    ) -> Result<(AppSummary, Option<(String, String, String)>), String> {
        self.fetch_online_repo_with_etag_at(
            owner,
            repo,
            token,
            pre_confirmed,
            cached_etag,
            cached_payload,
            probe_icons,
            None,
        )
        .await
    }

    /// `fetch_online_repo_with_etag` 的可换 API 基址实现（`api_base` 仅测试指向本地 mock）。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn fetch_online_repo_with_etag_at(
        &self,
        owner: &str,
        repo: &str,
        token: Option<&str>,
        pre_confirmed: Option<String>,
        cached_etag: Option<String>,
        cached_payload: Option<String>,
        probe_icons: bool,
        api_base: Option<&str>,
    ) -> Result<(AppSummary, Option<(String, String, String)>), String> {
        let client = crate::shared_http_client();
        let headers = super::http::token_headers(token);

        let url = format!(
            "https://api.github.com/repos/{}/{}",
            urlencoding::encode(owner),
            urlencoding::encode(repo)
        );

        match super::http::get_with_etag(&client, &url, api_base, &headers, cached_etag.as_deref())
            .await
        {
            super::http::EtagGetOutcome::Fresh { text, etag } => {
                let item = Self::build_summary_from_repo_json(
                    &client,
                    owner,
                    repo,
                    &text,
                    pre_confirmed,
                    probe_icons,
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
                        probe_icons,
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
                        probe_icons,
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
        self.fetch_online_repo_with_etag(owner, repo, token, pre_confirmed, None, None, true)
            .await
            .map(|(item, _)| item)
    }
}

#[cfg(test)]
mod tests {
    use crate::github::developer_starred::test_support::*;
    use std::collections::HashMap;

    fn repo_body() -> String {
        serde_json::json!({
            "name": "tool",
            "description": "A tool",
            "stargazers_count": 12u64,
            "forks_count": 3u64,
            "default_branch": "main",
            "topics": []
        })
        .to_string()
    }

    #[tokio::test]
    async fn repo_fetch_without_probe_returns_blank_icon_and_single_request() {
        let mut routes = HashMap::new();
        routes.insert(
            "/repos/acme/tool".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"r1\"".to_string()),
                body: repo_body(),
                honor_inm: Some("\"r1\"".to_string()),
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let started = std::time::Instant::now();
        let (item, etag) = svc
            .fetch_online_repo_with_etag_at(
                "acme",
                "tool",
                None,
                None,
                None,
                None,
                false,
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(item.core.id, "acme/tool");
        assert_eq!(item.core.stars, 12);
        assert!(
            item.core.icon.is_empty(),
            "no inline probe: {}",
            item.core.icon
        );
        let (url, tag, text) = etag.expect("fresh etag to persist");
        assert_eq!(url, "https://api.github.com/repos/acme/tool");
        assert_eq!(tag, "\"r1\"");

        // 304 复用缓存载荷，同样不探图。
        let (again, none) = svc
            .fetch_online_repo_with_etag_at(
                "acme",
                "tool",
                None,
                None,
                Some(tag),
                Some(text),
                false,
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert!(none.is_none());
        assert!(again.core.icon.is_empty());
        assert_eq!(
            srv.seen_inm
                .lock()
                .unwrap()
                .get("/repos/acme/tool")
                .cloned()
                .flatten(),
            Some("\"r1\"".to_string())
        );
        assert_eq!(srv.request_counts.lock().unwrap().len(), 1);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[tokio::test]
    async fn repo_fetch_keeps_pre_confirmed_icon_without_probe() {
        let mut routes = HashMap::new();
        routes.insert(
            "/repos/acme/tool".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: repo_body(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let (item, _) = test_service()
            .fetch_online_repo_with_etag_at(
                "acme",
                "tool",
                None,
                Some("https://cdn.simpleicons.org/tool".to_string()),
                None,
                None,
                false,
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(item.core.icon, "https://cdn.simpleicons.org/tool");
    }

    #[tokio::test]
    async fn keyword_search_uses_etag_and_recovers_on_304() {
        let url = super::online_search_endpoint("tool", Some(1), Some(20)).unwrap();
        let path = url
            .strip_prefix("https://api.github.com")
            .unwrap()
            .to_string();
        let body = serde_json::json!({
            "items": [{
                "name": "tool",
                "full_name": "Acme/tool",
                "owner": {"login": "Acme"},
                "description": "A tool",
                "stargazers_count": 5u64,
                "forks_count": 1u64
            }]
        })
        .to_string();
        let mut routes = HashMap::new();
        routes.insert(
            path.clone(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"q1\"".to_string()),
                body,
                honor_inm: Some("\"q1\"".to_string()),
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let first = svc
            .search_github_online("tool", None, Some(1), Some(20), None, None, Some(&srv.base))
            .await
            .unwrap();
        assert_eq!(first.summaries.len(), 1);
        assert_eq!(first.summaries[0].core.id, "acme/tool");
        assert!(first.summaries[0].core.icon.is_empty());
        let (saved_url, etag, text) = first.etag_write.expect("etag");
        assert_eq!(saved_url, url);

        let second = svc
            .search_github_online(
                "tool",
                None,
                Some(1),
                Some(20),
                Some(&etag),
                Some(&text),
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(
            srv.seen_inm.lock().unwrap().get(&path).cloned().flatten(),
            Some("\"q1\"".to_string())
        );
        assert_eq!(second.touched_url.as_deref(), Some(url.as_str()));
        assert!(second.etag_write.is_none());
        assert!(!second.is_stale);
        assert_eq!(second.summaries[0].core.stars, 5);
    }

    #[tokio::test]
    async fn keyword_search_falls_back_to_cached_payload_or_errors() {
        // 无路由：mock 回 404，视为失败。
        let srv = spawn_mock(HashMap::new()).await;
        let cached = serde_json::json!({"items": []}).to_string();
        let out = test_service()
            .search_github_online(
                "tool",
                None,
                None,
                None,
                Some("\"q\""),
                Some(&cached),
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert!(out.is_stale);
        let err = test_service()
            .search_github_online("tool", None, None, None, None, None, Some(&srv.base))
            .await
            .err()
            .unwrap();
        assert!(err.contains("404"), "{}", err);
    }

    #[test]
    fn search_endpoint_skips_empty_and_direct_page_two() {
        assert!(super::online_search_endpoint("  ", None, None).is_none());
        assert!(super::online_search_endpoint("a/b", Some(2), None).is_none());
        let ep = super::online_search_endpoint("a/b", Some(1), Some(10)).unwrap();
        assert!(ep.contains("q=a%2Fb+in:name,description"), "{}", ep);
        assert!(ep.ends_with("per_page=10&page=1"), "{}", ep);
    }
}
