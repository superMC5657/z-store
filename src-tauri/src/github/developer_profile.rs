use super::models::{GitHubRepoResponse, GitHubUserResponse};
use super::CatalogService;
use crate::models::{DeveloperProfile, DeveloperRepoItem};
use crate::repositories::EtagWrite;
use reqwest::header::HeaderMap;

pub(crate) use super::http::EtagGetOutcome;

/// 调用方传入的单端点条件请求缓存（`etag` 与对应可恢复载荷）。
#[derive(Debug, Default, Clone)]
pub struct CachedEtagPayload {
    pub etag: Option<String>,
    pub payload: Option<String>,
}

/// ETag 感知的开发者画像拉取结果。
#[derive(Debug)]
pub struct DeveloperProfileFetch {
    pub profile: DeveloperProfile,
    /// `200` 响应的 ETag 写入记录：调用方经 `save_etag` 落库。
    pub etag_writes: Vec<EtagWrite>,
    /// `304` 且以缓存载荷恢复的端点：调用方经 `touch_etag` 刷新检查时间。
    pub touched: Vec<String>,
}

enum EtagJsonSource {
    Fresh,
    Cached,
}

/// 解析 `EtagGetOutcome` 并记录 `etag_writes`（200 带 ETag）或 `touched`（304 命中缓存）。
fn resolve_etag_json<T: serde::de::DeserializeOwned>(
    outcome: EtagGetOutcome,
    endpoint: &str,
    cached_payload: Option<String>,
    now: i64,
    etag_writes: &mut Vec<EtagWrite>,
    touched: &mut Vec<String>,
) -> Result<Option<T>, (EtagJsonSource, serde_json::Error)> {
    match outcome {
        EtagGetOutcome::Fresh { text, etag } => {
            let parsed: T = serde_json::from_str(&text).map_err(|e| (EtagJsonSource::Fresh, e))?;
            if let Some(et) = etag {
                etag_writes.push(EtagWrite {
                    url: endpoint.to_string(),
                    etag: et,
                    payload: text,
                    timestamp: now,
                });
            }
            Ok(Some(parsed))
        }
        EtagGetOutcome::NotModified => match cached_payload {
            Some(payload) => {
                let parsed: T =
                    serde_json::from_str(&payload).map_err(|e| (EtagJsonSource::Cached, e))?;
                touched.push(endpoint.to_string());
                Ok(Some(parsed))
            }
            None => Ok(None),
        },
        EtagGetOutcome::Failed | EtagGetOutcome::Unauthorized => Ok(None),
    }
}

impl CatalogService {
    /// 合并目录中归属 `owner`（大小写不敏感）的条目投影为开发者仓库行（离线兜底，读锁内过滤）。
    pub fn collect_by_owner(&self, owner: &str) -> Vec<DeveloperRepoItem> {
        self.read_store()
            .merged()
            .filter(|(i, _)| i.owner.eq_ignore_ascii_case(owner))
            .map(|(i, _)| DeveloperRepoItem {
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
            })
            .collect()
    }

    /// 通用 ETag GET（委托到 `super::http::get_with_etag`）。
    pub(crate) async fn get_with_etag(
        client: &reqwest::Client,
        canonical_url: &str,
        api_base: Option<&str>,
        base_headers: &HeaderMap,
        cached_etag: Option<&str>,
    ) -> EtagGetOutcome {
        super::http::get_with_etag(client, canonical_url, api_base, base_headers, cached_etag).await
    }

    pub async fn fetch_developer_profile(
        &self,
        developer: &str,
        token: Option<&str>,
    ) -> Result<DeveloperProfile, String> {
        // 无缓存上下文的入口：etag 为 None 即普通 GET。
        // 持有 DB 的调用方使用 fetch_developer_profile_with_cache，并经
        // db.get_etag/save_etag 持久化（见 `commands::forge::get_developer_profile`）。
        Ok(self
            .fetch_developer_profile_with_cache(
                developer,
                token,
                CachedEtagPayload::default(),
                CachedEtagPayload::default(),
                None,
            )
            .await?
            .profile)
    }

    /// ETag 感知的开发者画像拉取：并发请求 `/users/{dev}` 与 `/users/{dev}/repos`，
    /// 304 从缓存载荷恢复，401 上报登录过期，失败或限流时降级本地目录兜底。
    pub async fn fetch_developer_profile_with_cache(
        &self,
        developer: &str,
        token: Option<&str>,
        user_cache: CachedEtagPayload,
        repos_cache: CachedEtagPayload,
        api_base: Option<&str>,
    ) -> Result<DeveloperProfileFetch, String> {
        let dev = super::validate_github_username(developer)?;

        let client = super::http::build_api_client()?;

        let headers = super::http::bearer_headers(token);

        let user_key = Self::dev_user_endpoint(dev);
        let repos_key = Self::dev_repos_endpoint(dev);
        let (user_outcome, repos_outcome) = tokio::join!(
            Self::get_with_etag(
                &client,
                &user_key,
                api_base,
                &headers,
                user_cache.etag.as_deref(),
            ),
            Self::get_with_etag(
                &client,
                &repos_key,
                api_base,
                &headers,
                repos_cache.etag.as_deref(),
            ),
        );
        let has_token = token.is_some_and(|t| !t.trim().is_empty());
        if has_token
            && (matches!(user_outcome, EtagGetOutcome::Unauthorized)
                || matches!(repos_outcome, EtagGetOutcome::Unauthorized))
        {
            crate::check_auth_expired(401, "developer_profile");
        }
        let now = crate::now_secs();
        let mut etag_writes: Vec<EtagWrite> = Vec::new();
        let mut touched: Vec<String> = Vec::new();

        let parsed_user: Option<GitHubUserResponse> = resolve_etag_json(
            user_outcome,
            &user_key,
            user_cache.payload,
            now,
            &mut etag_writes,
            &mut touched,
        )
        .map_err(|(src, e)| match src {
            EtagJsonSource::Fresh => format!("解析 GitHub 用户数据失败: {}", e),
            EtagJsonSource::Cached => format!("解析本地 ETag 缓存失败: {}", e),
        })?;

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
        } else {
            // 离线/限流降级：仅以收录库归属计数作画像提示，不伪造远端数据
            let matched_count = self.count_remote_by_owner(dev);

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

        // 仓库列表（ETag 条件请求：304 时用缓存 payload 恢复，失败时走 catalog 兜底）
        let repo_items: Vec<GitHubRepoResponse> = resolve_etag_json(
            repos_outcome,
            &repos_key,
            repos_cache.payload,
            now,
            &mut etag_writes,
            &mut touched,
        )
        .unwrap_or(None)
        .unwrap_or_default();

        let mut repos: Vec<DeveloperRepoItem> = Vec::new();
        if !repo_items.is_empty() {
            for r in repo_items {
                let repo_name = r.name.unwrap_or_default();
                let full_name = r
                    .full_name
                    .unwrap_or_else(|| format!("{}/{}", dev, repo_name));
                let id = full_name.clone();

                let in_cat = self
                    .with_catalog_item(&full_name, |c| (c.name.clone(), c.default_version.clone()));
                let in_catalog = in_cat.is_some();
                let (name, latest_release_tag) = match in_cat {
                    Some((name, version)) => (name, Some(version)),
                    None => (repo_name.clone(), None),
                };

                repos.push(DeveloperRepoItem {
                    id,
                    name,
                    full_name,
                    description: r.description,
                    html_url: r
                        .html_url
                        .unwrap_or_else(|| format!("https://github.com/{}/{}", dev, repo_name)),
                    stars: r.stargazers_count.unwrap_or(0),
                    forks: r.forks_count.unwrap_or(0),
                    language: r.language,
                    has_releases: in_catalog,
                    in_catalog,
                    latest_release_tag,
                });
            }
        }

        // 如果未抓取到远程仓库（如离线或限流），从 catalog 补充
        if repos.is_empty() {
            repos = self.collect_by_owner(dev);
        }

        // 截断标注：单页拉取无翻页，`public_repos` 大于实际行数即标注截断，
        // 前端明示"仅展示最近更新的前 N 个"，不伪装全量（离线兜底分支 public_repos
        // 归一为 catalog 命中数，与 repos 行数一致，天然不误标）。
        let effective_public_repos = if public_repos == 0 {
            repos.len() as u64
        } else {
            public_repos
        };
        let repos_truncated = effective_public_repos > repos.len() as u64;

        Ok(DeveloperProfileFetch {
            profile: DeveloperProfile {
                login,
                name,
                avatar_url,
                html_url,
                bio,
                company,
                blog,
                location,
                public_repos: effective_public_repos,
                followers,
                following,
                repos,
                repos_truncated,
            },
            etag_writes,
            touched,
        })
    }
}

#[cfg(test)]
mod developer_profile_tests {
    use super::CachedEtagPayload;
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
        let user_cache = CachedEtagPayload {
            etag: Some("\"cached-user-etag\"".to_string()),
            payload: None,
        };
        let repos_cache = CachedEtagPayload {
            etag: Some("\"cached-repos-etag\"".to_string()),
            payload: None,
        };
        let fetched = svc
            .fetch_developer_profile_with_cache(
                "someone",
                None,
                user_cache,
                repos_cache,
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(fetched.profile.login, "someone");
        // 必须在两个接口上均发送 If-None-Match 请求头（ETag 条件请求路径）。
        let seen = srv.seen_inm.lock().unwrap();
        assert_eq!(
            seen.get("/users/someone").cloned().flatten().as_deref(),
            Some("\"cached-user-etag\"")
        );
        assert_eq!(
            seen.get("/users/someone/repos?sort=updated&per_page=30")
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"cached-repos-etag\"")
        );
        // 200 响应必须返回全新的 ETag 写入记录，供调用方通过 save_etag 进行持久化。
        let etag_of = |suffix: &str| {
            fetched
                .etag_writes
                .iter()
                .find(|w| w.url.ends_with(suffix))
                .map(|w| w.etag.clone())
        };
        assert_eq!(
            etag_of("/users/someone").as_deref(),
            Some("\"user-etag-1\"")
        );
        assert_eq!(
            etag_of("/repos?sort=updated&per_page=30").as_deref(),
            Some("\"repos-etag-1\"")
        );
        assert!(fetched.touched.is_empty());
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
        let user_cache = CachedEtagPayload {
            etag: Some("\"user-etag-1\"".to_string()),
            payload: Some(user_json("someone")),
        };
        let repos_cache = CachedEtagPayload {
            etag: Some("\"repos-etag-1\"".to_string()),
            payload: Some(repos_json()),
        };
        let fetched = svc
            .fetch_developer_profile_with_cache(
                "someone",
                None,
                user_cache,
                repos_cache,
                Some(&srv.base),
            )
            .await
            .unwrap();
        // 响应 304 时：沿用缓存载荷，无需持久化新的缓存条目，两个端点均需刷新检查时间。
        let profile = &fetched.profile;
        assert_eq!(profile.login, "someone");
        assert!(fetched.etag_writes.is_empty());
        assert_eq!(fetched.touched.len(), 2);
        assert!(profile.repos.iter().any(|r| r.full_name == "someone/r1"));
    }

    #[tokio::test]
    async fn test_profile_marks_repos_truncated_against_public_repos() {
        // 截断标注：public_repos > 实际行数即 repos_truncated=true（单页 30 条
        // 无翻页，前端据此明示截断）；计数一致（或 user 端点缺席归一为行数）不误标。
        let repos_body = repos_json();
        let user = |public_repos: u64| {
            serde_json::json!({
                "login": "someone",
                "name": "someone",
                "html_url": "https://github.com/someone",
                "public_repos": public_repos,
                "followers": 0u64,
                "following": 0u64
            })
            .to_string()
        };

        let mut routes = HashMap::new();
        routes.insert(
            "/users/someone".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: user(5),
                honor_inm: None,
            },
        );
        routes.insert(
            "/users/someone/repos?sort=updated&per_page=30".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: repos_body.clone(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let profile = svc
            .fetch_developer_profile_with_cache(
                "someone",
                None,
                CachedEtagPayload::default(),
                CachedEtagPayload::default(),
                Some(&srv.base),
            )
            .await
            .unwrap()
            .profile;
        assert_eq!(profile.repos.len(), 1);
        assert!(profile.repos_truncated, "public_repos=5 > 1 行必须标注截断");
        assert_eq!(profile.public_repos, 5);

        let mut routes = HashMap::new();
        routes.insert(
            "/users/someone".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: user(1),
                honor_inm: None,
            },
        );
        routes.insert(
            "/users/someone/repos?sort=updated&per_page=30".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: repos_body,
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let profile = svc
            .fetch_developer_profile_with_cache(
                "someone",
                None,
                CachedEtagPayload::default(),
                CachedEtagPayload::default(),
                Some(&srv.base),
            )
            .await
            .unwrap()
            .profile;
        assert!(!profile.repos_truncated, "计数一致不误标");
        assert_eq!(profile.public_repos, 1);
    }

    #[tokio::test]
    async fn test_profile_fetch_rejects_invalid_developer_handles_without_network() {
        let routes = HashMap::new();
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let over_39 = "a".repeat(40);
        for bad in [
            "",
            "   ",
            "../user/emails",
            "..%2Fuser%2Femails",
            "foo/bar",
            "foo\\bar",
            "..",
            ".",
            "foo?per_page=1#",
            "foo#bar",
            "foo%20bar",
            "foo bar",
            "-foo",
            "foo-",
            "foo--bar",
            over_39.as_str(),
        ] {
            let err = svc
                .fetch_developer_profile_with_cache(
                    bad,
                    Some("gho_secret_token"),
                    CachedEtagPayload::default(),
                    CachedEtagPayload::default(),
                    Some(&srv.base),
                )
                .await
                .expect_err(&format!("invalid handle {bad:?} must be rejected"));
            assert!(!err.is_empty());
        }
        assert!(
            srv.seen_inm.lock().unwrap().is_empty(),
            "rejected developer handles must never trigger HTTP requests"
        );
        // 合法账号通过校验函数
        for ok in ["a", "foo-bar", "foo123", &"a".repeat(39)] {
            assert_eq!(crate::github::validate_github_username(ok).unwrap(), ok);
        }
    }
}
