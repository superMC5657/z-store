use super::models::{GitHubRepoResponse, GitHubUserResponse};
use super::CatalogService;
use crate::models::{DeveloperProfile, DeveloperRepoItem};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, IF_NONE_MATCH, USER_AGENT,
};

pub(crate) enum EtagGetOutcome {
    /// 200：正文 + 响应 ETag（无 ETag 头时为 None，调用方此时不落库）。
    Fresh { text: String, etag: Option<String> },
    /// 304：远端未变更，调用方用 `cached_payload` 恢复。
    NotModified,
    /// 传输失败或非 2xx/304 状态；调用方走降级（旧行为 + 日志）。
    Failed,
}

impl CatalogService {
    fn dev_auth_headers(token: Option<&str>) -> HeaderMap {
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
        headers
    }

    /// 通用 ETag GET（镜像 `detail.rs`：挂 `If-None-Match` → 304 复用 / 200 捕获新 ETag）。
    pub(crate) async fn get_with_etag(
        client: &reqwest::Client,
        canonical_url: &str,
        api_base: Option<&str>,
        base_headers: &HeaderMap,
        cached_etag: Option<&str>,
        log_tag: &str,
    ) -> EtagGetOutcome {
        let url = Self::request_url(canonical_url, api_base);
        let mut headers = base_headers.clone();
        if let Some(etag) = cached_etag {
            if !etag.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(etag) {
                    headers.insert(IF_NONE_MATCH, val);
                }
            }
        }
        let safe_url = crate::log_support::sanitize_url(&url);
        let req_id = crate::z_log::new_req_id();
        let sid = crate::z_log::new_session_id();
        let host = crate::log_support::host_of(&url);
        log::debug!(
            "http get dev etag tag={} sid={} req={} url='{}'",
            log_tag,
            sid,
            req_id,
            safe_url
        );
        let start = std::time::Instant::now();
        let res = match client.get(&url).headers(headers).send().await {
            Ok(r) => r,
            Err(e) => {
                log::warn!(
                    "http get dev etag failed tag={} sid={} req={} host={} reason={} elapsed_ms={}",
                    log_tag,
                    sid,
                    req_id,
                    host,
                    crate::log_support::short_reason(&e.to_string()),
                    start.elapsed().as_millis()
                );
                return EtagGetOutcome::Failed;
            }
        };
        crate::notify_rate_limit("github.com", res.headers());
        let status = res.status();
        log::debug!(
            "http resp dev etag tag={} sid={} req={} url='{}' status={} elapsed_ms={}",
            log_tag,
            sid,
            req_id,
            safe_url,
            status.as_u16(),
            start.elapsed().as_millis()
        );
        log::info!(
            "http resp dev etag tag={} sid={} req={} host={} status={} elapsed_ms={}",
            log_tag,
            sid,
            req_id,
            host,
            status.as_u16(),
            start.elapsed().as_millis()
        );
        if status == reqwest::StatusCode::NOT_MODIFIED {
            return EtagGetOutcome::NotModified;
        }
        if !status.is_success() {
            return EtagGetOutcome::Failed;
        }
        let etag = res
            .headers()
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());
        match res.text().await {
            Ok(text) => EtagGetOutcome::Fresh { text, etag },
            Err(e) => {
                log::warn!(
                    "http read dev etag body failed tag={} sid={} req={} host={} reason={}",
                    log_tag,
                    sid,
                    req_id,
                    host,
                    crate::log_support::short_reason(&e.to_string())
                );
                EtagGetOutcome::Failed
            }
        }
    }

    pub async fn fetch_developer_profile(
        &self,
        developer: &str,
        token: Option<&str>,
    ) -> Result<DeveloperProfile, String> {
        // 后向兼容入口：无缓存上下文时走条件请求新路径（etag 为 None 即普通 GET）。
        // 持有 DB 的调用方应使用 fetch_developer_profile_with_cache，并经
        // db.get_etag/save_etag 持久化（镜像 commands/catalog.rs 的 ETag 调用模式）。
        let (profile, _, _) = self
            .fetch_developer_profile_with_cache(
                developer,
                token,
                (None, None),
                (None, None),
                None,
            )
            .await?;
        Ok(profile)
    }

    /// ETag 感知的开发者画像拉取（镜像 `fetch_app_detail` 的调用模式）：
    /// 调用方经 SQLite `api_etag_cache` 取出 `(etag, payload)` 传入 → 本函数发送
    /// `If-None-Match` → 304 时用 payload 恢复 → 200 时返回新 `(etag, payload)`
    /// 供调用方 `save_etag` 持久化。失败/限流时沿用旧降级（catalog 兜底 + 日志）。
    pub async fn fetch_developer_profile_with_cache(
        &self,
        developer: &str,
        token: Option<&str>,
        user_cache: (Option<String>, Option<String>),
        repos_cache: (Option<String>, Option<String>),
        api_base: Option<&str>,
    ) -> Result<
        (
            DeveloperProfile,
            Option<(String, String)>,
            Option<(String, String)>,
        ),
        String,
    > {
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

        let headers = Self::dev_auth_headers(token);

        let user_key = Self::dev_user_endpoint(dev);
        let (user_etag, user_payload) = user_cache;
        let (parsed_user, user_new_cache): (Option<GitHubUserResponse>, Option<(String, String)>) =
            match Self::get_with_etag(
                &client,
                &user_key,
                api_base,
                &headers,
                user_etag.as_deref(),
                "dev-user",
            )
            .await
            {
                EtagGetOutcome::Fresh { text, etag } => {
                    let user: GitHubUserResponse = serde_json::from_str(&text)
                        .map_err(|e| format!("解析 GitHub 用户数据失败: {}", e))?;
                    (Some(user), etag.map(|et| (et, text)))
                }
                EtagGetOutcome::NotModified => {
                    if let Some(payload) = user_payload {
                        let user: GitHubUserResponse = serde_json::from_str(&payload)
                            .map_err(|e| format!("解析本地 ETag 缓存失败: {}", e))?;
                        (Some(user), None)
                    } else {
                        log::warn!("dev user 304 but no cached payload id={}", dev);
                        (None, None)
                    }
                }
                EtagGetOutcome::Failed => (None, None),
            };

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
        ) = if let Some(u) = parsed_user {
            (
                u.login,
                u.name,
                u.avatar_url
                    .unwrap_or_else(|| format!("https://avatars.githubusercontent.com/{}", dev)),
                u.html_url.unwrap_or_else(|| format!("https://github.com/{}", dev)),
                u.bio,
                u.company,
                u.blog,
                u.location,
                u.public_repos.unwrap_or(0),
                u.followers.unwrap_or(0),
                u.following.unwrap_or(0),
            )
        } else {
            // 离线/限流降级：仅以收录库归属计数作画像提示，不伪造远端数据
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
        };

        // 获取仓库列表（ETag 条件请求：304 时用缓存 payload 恢复，失败时走 catalog 兜底）
        let repos_key = Self::dev_repos_endpoint(dev);
        let (repos_etag, repos_payload) = repos_cache;
        let (repo_items, repos_new_cache): (Vec<GitHubRepoResponse>, Option<(String, String)>) =
            match Self::get_with_etag(
                &client,
                &repos_key,
                api_base,
                &headers,
                repos_etag.as_deref(),
                "dev-repos",
            )
            .await
            {
                EtagGetOutcome::Fresh { text, etag } => {
                    let items: Vec<GitHubRepoResponse> =
                        serde_json::from_str(&text).unwrap_or_default();
                    (items, etag.map(|et| (et, text)))
                }
                EtagGetOutcome::NotModified => {
                    if let Some(payload) = repos_payload {
                        let items: Vec<GitHubRepoResponse> =
                            serde_json::from_str(&payload).unwrap_or_default();
                        (items, None)
                    } else {
                        log::warn!("dev repos 304 but no cached payload id={}", dev);
                        (Vec::new(), None)
                    }
                }
                EtagGetOutcome::Failed => (Vec::new(), None),
            };

        let mut repos: Vec<DeveloperRepoItem> = Vec::new();
        let catalog_list = self.get_catalog_items();
        if !repo_items.is_empty() {
            for r in repo_items {
                        let repo_name = r.name.unwrap_or_default();
                        let full_name = r
                            .full_name
                            .unwrap_or_else(|| format!("{}/{}", dev, repo_name));
                        let id = full_name.clone();

                        let in_cat = catalog_list.iter().find(|i| {
                            crate::forge::canonical_app_id(&full_name).as_deref() == Some(i.id.as_str())
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
                    language: None,
                    has_releases: true,
                    in_catalog: true,
                    latest_release_tag: Some(i.default_version.clone()),
                });
            }
        }

        Ok((
            DeveloperProfile {
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
            },
            user_new_cache,
            repos_new_cache,
        ))
    }

}

#[cfg(test)]
mod developer_profile_tests {
    use crate::github::developer_starred::test_support::*;
    use std::collections::HashMap;
    #[tokio::test]
    async fn test_profile_fetch_sends_if_none_match() {
        let mut routes = HashMap::new();
        routes.insert(
            "/users/someone".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"user-etag-1\"".to_string()),
                body: user_json("someone"),
                honor_inm: None,
            },
        );
        routes.insert(
            "/users/someone/repos?sort=updated&per_page=30".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"repos-etag-1\"".to_string()),
                body: repos_json(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let user_cache = (Some("\"cached-user-etag\"".to_string()), None);
        let repos_cache = (Some("\"cached-repos-etag\"".to_string()), None);
        let (profile, user_new, repos_new) = svc
            .fetch_developer_profile_with_cache(
                "someone",
                None,
                user_cache,
                repos_cache,
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(profile.login, "someone");
        // 必须在两个接口上均发送 If-None-Match 请求头（ETag 条件请求路径）。
        let seen = srv.seen_inm.lock().unwrap();
        assert_eq!(
            seen.get("/users/someone").cloned().flatten().as_deref(),
            Some("\"cached-user-etag\"")
        );
        assert_eq!(
            seen
                .get("/users/someone/repos?sort=updated&per_page=30")
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"cached-repos-etag\"")
        );
        // 200 响应必须返回全新的 (etag, payload) 元组，供调用方通过 save_etag 进行持久化。
        assert_eq!(user_new.unwrap().0, "\"user-etag-1\"");
        assert_eq!(repos_new.unwrap().0, "\"repos-etag-1\"");
    }

    #[tokio::test]
    async fn test_profile_fetch_honors_304_from_cache() {
        let mut routes = HashMap::new();
        routes.insert(
            "/users/someone".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"user-etag-2\"".to_string()),
                body: user_json("WRONG"),
                honor_inm: Some("\"user-etag-1\"".to_string()),
            },
        );
        routes.insert(
            "/users/someone/repos?sort=updated&per_page=30".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"repos-etag-2\"".to_string()),
                body: "[]".to_string(),
                honor_inm: Some("\"repos-etag-1\"".to_string()),
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let user_cache = (
            Some("\"user-etag-1\"".to_string()),
            Some(user_json("someone")),
        );
        let repos_cache = (Some("\"repos-etag-1\"".to_string()), Some(repos_json()));
        let (profile, user_new, repos_new) = svc
            .fetch_developer_profile_with_cache(
                "someone",
                None,
                user_cache,
                repos_cache,
                Some(&srv.base),
            )
            .await
            .unwrap();
        // 响应 304 时：沿用缓存载荷，无需持久化新的缓存元组。
        assert_eq!(profile.login, "someone");
        assert!(user_new.is_none());
        assert!(repos_new.is_none());
        assert!(profile.repos.iter().any(|r| r.full_name == "someone/r1"));
    }
}
