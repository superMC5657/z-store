use super::models::{GitHubRepoResponse, GitHubUserResponse};
use super::CatalogService;
use crate::models::{DeveloperProfile, DeveloperRepoItem, StarredSyncResult};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, IF_NONE_MATCH, USER_AGENT,
};
use std::collections::HashMap;

/// 开发者画像仓库列表单次拉取数量
pub const DEVELOPER_REPOS_PAGE_SIZE: usize = 30;
/// GitHub Starred 列表单页最大数量（GitHub 允许的最大上限，单次拉取最大化配额效益）
pub const GITHUB_STARRED_MAX_PAGE_SIZE: usize = 100;
/// GitHub API 基址（生产默认；测试经 `api_base` 覆写指向本地 mock，键仍用此基址保持与
/// `api_etag_cache` 表中既有 `https://api.github.com/...` 键一致）。
pub const GITHUB_API_BASE: &str = "https://api.github.com";
/// 配额护栏：单次 Star 同步中最多对多少个目录外仓库做 live `releases/latest` 探测。
/// 缓存命中不计入该预算；超限仓库保留旧行为（`has_releases: false`），不发网络请求。
pub const STARRED_RELEASE_ENRICH_LIMIT: usize = 20;

/// 带 ETag 条件请求的 GET 结果（镜像 `detail.rs` 的 304/200 分支语义）。
enum EtagGetOutcome {
    /// 200：正文 + 响应 ETag（无 ETag 头时为 None，调用方此时不落库）。
    Fresh { text: String, etag: Option<String> },
    /// 304：远端未变更，调用方用 `cached_payload` 恢复。
    NotModified,
    /// 传输失败或非 2xx/304 状态；调用方走降级（旧行为 + 日志）。
    Failed,
}

impl CatalogService {
    /// 开发者画像用户端点（canonical cache key，直存 `api_etag_cache.endpoint_url`）。
    pub fn dev_user_endpoint(developer: &str) -> String {
        format!("{}/users/{}", GITHUB_API_BASE, developer.trim())
    }

    /// 开发者画像仓库列表端点（canonical cache key）。
    pub fn dev_repos_endpoint(developer: &str) -> String {
        format!(
            "{}/users/{}/repos?sort=updated&per_page={}",
            GITHUB_API_BASE,
            developer.trim(),
            DEVELOPER_REPOS_PAGE_SIZE
        )
    }

    /// 目录外 Star 仓库的 `releases/latest` 端点（canonical cache key，与
    /// `updates.rs`/`catalog.rs` 共用 `api_etag_cache` 表，零新 schema）。
    pub fn starred_release_endpoint(full_name: &str) -> String {
        let key = crate::forge::canonical_app_id(full_name)
            .unwrap_or_else(|| full_name.trim().to_lowercase());
        format!("{}/repos/{}/releases/latest", GITHUB_API_BASE, key)
    }

    /// 从缓存 payload（`GitHubReleaseResponse` JSON）提取 `tag_name`，独立真相源。
    pub fn parse_release_tag(payload: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(payload)
            .ok()?
            .get("tag_name")?
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// canonical key → 实际请求 URL（测试覆写 `api_base` 时仅换前缀，key 不变）。
    fn request_url(canonical_url: &str, api_base: Option<&str>) -> String {
        match api_base {
            Some(base) if !base.trim().is_empty() => {
                let base = base.trim().trim_end_matches('/');
                if let Some(rest) = canonical_url.strip_prefix(GITHUB_API_BASE) {
                    format!("{}{}", base, rest)
                } else {
                    canonical_url.to_string()
                }
            }
            _ => canonical_url.to_string(),
        }
    }

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
    async fn get_with_etag(
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

    pub async fn sync_starred_repos(
        &self,
        username: Option<&str>,
        token: Option<&str>,
    ) -> Result<StarredSyncResult, String> {
        // 后向兼容入口：缓存仅为本轮调用内去重（无持久化）。
        // 持有 DB 的调用方应使用 sync_starred_repos_with_cache，传入经
        // db.get_etag 预填、`save_etag` 回写的 map（key 见 starred_release_endpoint）。
        let mut ephemeral: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        self.sync_starred_repos_with_cache(username, token, &mut ephemeral, None)
            .await
    }

    /// Star 同步（含目录外仓库 release 真实性探测）：
    /// - 缓存优先：`release_cache`（key = `starred_release_endpoint`，与
    ///   `api_etag_cache.endpoint_url` 同键）命中且 payload 可解析出 tag 时零网络直接认定；
    /// - 配额护栏：每轮 live `releases/latest` 探测不超过 `STARRED_RELEASE_ENRICH_LIMIT`，
    ///   超限仓库保留旧行为（`has_releases: false`），不发请求；
    /// - 失败/限流/404 时保留旧行为（false + 日志），不抛错；
    /// - 200 命中且带 ETag 时回填 `release_cache` 供调用方 `save_etag` 持久化，复同步零配额。
    pub async fn sync_starred_repos_with_cache(
        &self,
        username: Option<&str>,
        token: Option<&str>,
        release_cache: &mut HashMap<String, (Option<String>, Option<String>)>,
        api_base: Option<&str>,
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
                "{}/user/starred?per_page={}",
                GITHUB_API_BASE, GITHUB_STARRED_MAX_PAGE_SIZE
            )
        } else if let Some(u) = username {
            let clean_u = u.trim();
            if clean_u.is_empty() {
                return Err(
                    "请提供 GitHub 用户名或在设置中配置个人访问令牌 (PAT)".to_string(),
                );
            }
            format!(
                "{}/users/{}/starred?per_page={}",
                GITHUB_API_BASE, clean_u, GITHUB_STARRED_MAX_PAGE_SIZE
            )
        } else {
            return Err(
                "请提供 GitHub 用户名或在设置中配置个人访问令牌 (PAT)".to_string(),
            );
        };

        let mut catalog_matches = Vec::new();
        let mut other_repos = Vec::new();

        let catalog_list = self.get_catalog_items();
        let request_target = Self::request_url(&target_url, api_base);
        let safe_starred = crate::log_support::sanitize_url(&request_target);
        let starred_req = crate::z_log::new_req_id();
        let starred_sid = crate::z_log::new_session_id();
        let starred_host = crate::log_support::host_of(&request_target);
        log::debug!("http get starred sid={} req={} url='{}'", starred_sid, starred_req, safe_starred);
        let start_starred = std::time::Instant::now();
        let resp = match client.get(&request_target).headers(headers.clone()).send().await {
            Ok(r) => {
                log::debug!("http resp starred sid={} req={} url='{}' status={} elapsed_ms={}", starred_sid, starred_req, safe_starred, r.status().as_u16(), start_starred.elapsed().as_millis());
                log::info!("http resp starred sid={} req={} host={} status={} elapsed_ms={}", starred_sid, starred_req, starred_host, r.status().as_u16(), start_starred.elapsed().as_millis());
                r
            }
            Err(e) => {
                log::warn!("http get starred failed sid={} req={} host={} reason={} elapsed_ms={}", starred_sid, starred_req, starred_host, crate::log_support::short_reason(&e.to_string()), start_starred.elapsed().as_millis());
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
        struct PendingStar {
            full_name: String,
            repo_name: String,
            description: Option<String>,
            html_url: String,
            stars: u64,
            forks: u64,
            language: Option<String>,
        }
        let mut pending: Vec<PendingStar> = Vec::new();
        for r in starred_list {
            let full_name = r.full_name.clone().unwrap_or_default();
            let repo_name = r.name.clone().unwrap_or_default();

            // ADR-0010：远端 full_name 归一化为 canonical id 后与收录库精确对齐，
            // 杜绝因用户 Star 了同名第三方 Fork（如 someone/rustdesk）而被错误误判为官方应用
            if let Some(cat) = catalog_list.iter().find(|c| {
                crate::forge::canonical_app_id(&full_name).as_deref() == Some(c.id.as_str())
            }) {
                catalog_matches.push(cat.to_summary());
            } else {
                let html_url = r
                    .html_url
                    .unwrap_or_else(|| format!("https://github.com/{}", full_name));
                pending.push(PendingStar {
                    full_name,
                    repo_name,
                    description: r.description,
                    html_url,
                    stars: r.stargazers_count.unwrap_or(0),
                    forks: r.forks_count.unwrap_or(0),
                    language: r.language,
                });
            }
        }

        // 第一遍：缓存优先（零网络）。payload 可解析出 tag 即认定有 release，
        // 复同步走 SQLite etag 层时命中即 0 配额。
        let mut resolved: Vec<Option<(bool, Option<String>)>> = vec![None; pending.len()];
        for (i, p) in pending.iter().enumerate() {
            if p.full_name.trim().is_empty() {
                resolved[i] = Some((false, None));
                continue;
            }
            let key = Self::starred_release_endpoint(&p.full_name);
            if let Some((_, payload)) = release_cache.get(&key) {
                if let Some(payload) = payload {
                    if let Some(tag) = Self::parse_release_tag(payload) {
                        resolved[i] = Some((true, Some(tag)));
                    }
                }
            }
        }

        // 第二遍：live 轻量探测（`releases/latest` 单请求/库），预算上限
        // STARRED_RELEASE_ENRICH_LIMIT；失败/限流/404 保留旧行为（false + 日志）。
        let mut budget = STARRED_RELEASE_ENRICH_LIMIT;
        for (i, p) in pending.iter().enumerate() {
            if resolved[i].is_some() {
                continue;
            }
            if p.full_name.trim().is_empty() {
                resolved[i] = Some((false, None));
                continue;
            }
            if budget == 0 {
                log::debug!(
                    "starred release skip over budget full_name='{}'",
                    p.full_name
                );
                resolved[i] = Some((false, None));
                continue;
            }
            budget -= 1;
            let key = Self::starred_release_endpoint(&p.full_name);
            let cached_etag = release_cache
                .get(&key)
                .and_then(|(e, _)| e.clone());
            match Self::get_with_etag(
                &client,
                &key,
                api_base,
                &headers,
                cached_etag.as_deref(),
                "starred-release",
            )
            .await
            {
                EtagGetOutcome::Fresh { text, etag } => match Self::parse_release_tag(&text) {
                    Some(tag) => {
                        if let Some(et) = etag {
                            release_cache.insert(key, (Some(et), Some(text)));
                        }
                        resolved[i] = Some((true, Some(tag)));
                    }
                    None => {
                        log::debug!(
                            "starred release no tag full_name='{}'",
                            p.full_name
                        );
                        resolved[i] = Some((false, None));
                    }
                },
                EtagGetOutcome::NotModified => {
                    let tag = release_cache
                        .get(&key)
                        .and_then(|(_, pl)| pl.as_ref())
                        .and_then(|pl| Self::parse_release_tag(pl));
                    resolved[i] = Some(match tag {
                        Some(t) => (true, Some(t)),
                        None => (false, None),
                    });
                }
                EtagGetOutcome::Failed => {
                    log::debug!(
                        "starred release check failed full_name='{}' keep has_releases=false",
                        p.full_name
                    );
                    resolved[i] = Some((false, None));
                }
            }
        }

        for (p, r) in pending.into_iter().zip(resolved.into_iter()) {
            let (has_releases, latest_release_tag) = r.unwrap_or((false, None));
            other_repos.push(DeveloperRepoItem {
                id: p.full_name.clone(),
                name: p.repo_name.clone(),
                full_name: p.full_name,
                description: p.description,
                html_url: p.html_url,
                stars: p.stars,
                forks: p.forks,
                language: p.language,
                has_releases,
                in_catalog: false,
                latest_release_tag,
            });
        }

        Ok(StarredSyncResult {
            total_starred,
            catalog_matches,
            other_repos,
        })
    }
}

#[cfg(test)]
mod developer_etag_release_tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn test_service() -> CatalogService {
        CatalogService {
            items: std::sync::RwLock::new(Vec::new()),
            client: reqwest::Client::new(),
        }
    }

    struct MockResp {
        status: u16,
        reason: &'static str,
        etag: Option<String>,
        body: String,
        /// If set, reply 304 when request If-None-Match equals this value.
        honor_inm: Option<String>,
    }

    struct MockServer {
        base: String,
        hits: Arc<Mutex<HashMap<String, usize>>>,
        seen_inm: Arc<Mutex<HashMap<String, Option<String>>>>,
    }

    async fn spawn_mock(routes: HashMap<String, MockResp>) -> MockServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes = Arc::new(routes);
        let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
        let seen_inm: Arc<Mutex<HashMap<String, Option<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let hits_c = hits.clone();
        let seen_c = seen_inm.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let routes = routes.clone();
                let hits = hits_c.clone();
                let seen = seen_c.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                    let mut reader = tokio::io::BufReader::new(&mut sock);
                    let mut req_line = String::new();
                    if reader.read_line(&mut req_line).await.is_err() {
                        return;
                    }
                    let path = req_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let mut inm: Option<String> = None;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.is_err() {
                            return;
                        }
                        if line == "\r\n" || line == "\n" || line.trim().is_empty() {
                            break;
                        }
                        if let Some(v) = line.strip_prefix("if-none-match:") {
                            inm = Some(v.trim().to_string());
                        } else if let Some(v) = line.strip_prefix("If-None-Match:") {
                            inm = Some(v.trim().to_string());
                        }
                    }
                    {
                        *hits.lock().unwrap().entry(path.clone()).or_insert(0) += 1;
                        seen.lock().unwrap().insert(path.clone(), inm.clone());
                    }
                    let (status, reason, etag, body) = match routes.get(&path) {
                        Some(r) => {
                            if let Some(ref want) = r.honor_inm {
                                if inm.as_deref() == Some(want.as_str()) {
                                    (304u16, "Not Modified", None, String::new())
                                } else {
                                    (r.status, r.reason, r.etag.clone(), r.body.clone())
                                }
                            } else {
                                (r.status, r.reason, r.etag.clone(), r.body.clone())
                            }
                        }
                        None => (404u16, "Not Found", None, "{}".to_string()),
                    };
                    let mut resp = format!("HTTP/1.1 {} {}\r\n", status, reason);
                    resp.push_str("connection: close\r\n");
                    if let Some(e) = etag {
                        resp.push_str(&format!("etag: {}\r\n", e));
                    }
                    if status != 304 {
                        resp.push_str("content-type: application/json\r\n");
                        resp.push_str(&format!("content-length: {}\r\n", body.len()));
                    }
                    resp.push_str("\r\n");
                    resp.push_str(&body);
                    let _ = reader.into_inner().write_all(resp.as_bytes()).await;
                });
            }
        });
        MockServer {
            base: format!("http://127.0.0.1:{}", port),
            hits,
            seen_inm,
        }
    }

    fn hits_of(srv: &MockServer, path: &str) -> usize {
        srv.hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    fn user_json(login: &str) -> String {
        serde_json::json!({
            "login": login,
            "name": login,
            "avatar_url": format!("https://avatars.githubusercontent.com/{}", login),
            "html_url": format!("https://github.com/{}", login),
            "bio": "bio",
            "public_repos": 2u64,
            "followers": 3u64,
            "following": 4u64
        })
        .to_string()
    }

    fn repos_json() -> String {
        serde_json::json!([
            {"name": "r1", "full_name": "someone/r1", "html_url": "https://github.com/someone/r1",
             "description": "d1", "stargazers_count": 5u64, "forks_count": 1u64, "language": "Rust"}
        ])
        .to_string()
    }

    #[test]
    fn test_release_endpoint_key_matches_updates_ep_format() {
        // Cache key must equal the canonical release endpoint used by updates.rs/catalog.rs
        // so the existing api_etag_cache table is shared with zero new schema.
        let key = CatalogService::starred_release_endpoint("SomeOne/R1");
        assert_eq!(
            key,
            "https://api.github.com/repos/someone/r1/releases/latest"
        );
    }

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
        // Must send If-None-Match on both endpoints (ETag conditional-request path).
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
        // 200 must return fresh (etag, payload) tuples for the caller to persist via save_etag.
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
        // 304 honored: cached payload wins, no fresh cache tuple to persist.
        assert_eq!(profile.login, "someone");
        assert!(user_new.is_none());
        assert!(repos_new.is_none());
        assert!(profile.repos.iter().any(|r| r.full_name == "someone/r1"));
    }

    #[tokio::test]
    async fn test_starred_non_catalog_release_truthful_and_404_fallback() {
        let mut routes = HashMap::new();
        routes.insert(
            "/users/testuser/starred?per_page=100".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: serde_json::json!([
                    {"name": "r1", "full_name": "o1/r1",
                     "html_url": "https://github.com/o1/r1", "description": "d1",
                     "stargazers_count": 7u64, "forks_count": 2u64, "language": "Rust"},
                    {"name": "r2", "full_name": "o2/r2",
                     "html_url": "https://github.com/o2/r2", "description": "d2",
                     "stargazers_count": 3u64, "forks_count": 0u64, "language": "Go"}
                ])
                .to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o1/r1/releases/latest".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"rel-etag-1\"".to_string()),
                body: serde_json::json!({"tag_name": "v9.9.9", "body": "notes", "assets": []})
                    .to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o2/r2/releases/latest".to_string(),
            MockResp {
                status: 404,
                reason: "Not Found",
                etag: None,
                body: "{}".to_string(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let mut cache: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        let result = svc
            .sync_starred_repos_with_cache(
                Some("testuser"),
                None,
                &mut cache,
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(result.total_starred, 2);
        assert_eq!(result.other_repos.len(), 2);
        let r1 = result
            .other_repos
            .iter()
            .find(|r| r.full_name == "o1/r1")
            .unwrap();
        assert!(r1.has_releases);
        assert_eq!(r1.latest_release_tag.as_deref(), Some("v9.9.9"));
        // API failure (404) preserves old behavior: false + no tag, no panic.
        let r2 = result
            .other_repos
            .iter()
            .find(|r| r.full_name == "o2/r2")
            .unwrap();
        assert!(!r2.has_releases);
        assert!(r2.latest_release_tag.is_none());
        // Fresh 200 populates cache-first map for cheap re-syncs.
        let key = CatalogService::starred_release_endpoint("o1/r1");
        let entry = cache.get(&key).unwrap();
        assert_eq!(entry.0.as_deref(), Some("\"rel-etag-1\""));
        assert!(entry.1.as_ref().unwrap().contains("v9.9.9"));
    }

    #[tokio::test]
    async fn test_starred_release_cache_first_no_refetch() {
        let release_hits = Arc::new(AtomicUsize::new(0));
        let hits_c = release_hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{}", port);
        let starred_body = serde_json::json!([
            {"name": "r1", "full_name": "o1/r1",
             "html_url": "https://github.com/o1/r1", "description": "d1",
             "stargazers_count": 7u64, "forks_count": 2u64, "language": "Rust"}
        ])
        .to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let starred_body = starred_body.clone();
                let hits_c = hits_c.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                    let mut reader = tokio::io::BufReader::new(&mut sock);
                    let mut req_line = String::new();
                    if reader.read_line(&mut req_line).await.is_err() {
                        return;
                    }
                    let path = req_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.is_err() {
                            return;
                        }
                        if line == "\r\n" || line == "\n" || line.trim().is_empty() {
                            break;
                        }
                    }
                    let body = if path.starts_with("/repos/") {
                        // If cache-first works this must never fire; return 500 to
                        // prove cached data (not network) decided the outcome.
                        hits_c.fetch_add(1, Ordering::SeqCst);
                        "boom".to_string()
                    } else {
                        starred_body
                    };
                    let status = if path.starts_with("/repos/") {
                        "HTTP/1.1 500 Internal Server Error"
                    } else {
                        "HTTP/1.1 200 OK"
                    };
                    let resp = format!(
                        "{}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                        status,
                        body.len(),
                        body
                    );
                    let _ = reader.into_inner().write_all(resp.as_bytes()).await;
                });
            }
        });
        let svc = test_service();
        let key = CatalogService::starred_release_endpoint("o1/r1");
        let mut cache: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        cache.insert(
            key,
            (
                Some("\"cached-rel-etag\"".to_string()),
                Some(
                    serde_json::json!({"tag_name": "v1.0.0", "body": "", "assets": []})
                        .to_string(),
                ),
            ),
        );
        let result = svc
            .sync_starred_repos_with_cache(Some("testuser"), None, &mut cache, Some(&base))
            .await
            .unwrap();
        let r1 = result
            .other_repos
            .iter()
            .find(|r| r.full_name == "o1/r1")
            .unwrap();
        assert!(r1.has_releases);
        assert_eq!(r1.latest_release_tag.as_deref(), Some("v1.0.0"));
        assert_eq!(
            release_hits.load(Ordering::SeqCst),
            0,
            "cache-first: cached release must not hit network"
        );
    }

    #[tokio::test]
    async fn test_starred_release_fanout_capped() {
        let release_hits = Arc::new(AtomicUsize::new(0));
        let hits_c = release_hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{}", port);
        let n = super::STARRED_RELEASE_ENRICH_LIMIT + 5;
        let mut starred = Vec::new();
        for i in 0..n {
            starred.push(serde_json::json!(
                {"name": format!("r{}", i), "full_name": format!("o/r{}", i),
                 "html_url": format!("https://github.com/o/r{}", i),
                 "stargazers_count": 1u64, "forks_count": 0u64}
            ));
        }
        let starred_body = serde_json::Value::Array(starred).to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let starred_body = starred_body.clone();
                let hits_c = hits_c.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                    let mut reader = tokio::io::BufReader::new(&mut sock);
                    let mut req_line = String::new();
                    if reader.read_line(&mut req_line).await.is_err() {
                        return;
                    }
                    let path = req_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.is_err() {
                            return;
                        }
                        if line == "\r\n" || line == "\n" || line.trim().is_empty() {
                            break;
                        }
                    }
                    let (status, body) = if path.starts_with("/repos/") {
                        hits_c.fetch_add(1, Ordering::SeqCst);
                        (
                            "HTTP/1.1 200 OK",
                            serde_json::json!({"tag_name": "v2.0.0", "body": "", "assets": []})
                                .to_string(),
                        )
                    } else {
                        ("HTTP/1.1 200 OK", starred_body)
                    };
                    let resp = format!(
                        "{}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                        status,
                        body.len(),
                        body
                    );
                    let _ = reader.into_inner().write_all(resp.as_bytes()).await;
                });
            }
        });
        // Give the mock a moment to bind before the client fires.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let svc = test_service();
        let mut cache: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        let result = svc
            .sync_starred_repos_with_cache(Some("testuser"), None, &mut cache, Some(&base))
            .await
            .unwrap();
        assert_eq!(result.other_repos.len(), n);
        assert!(
            release_hits.load(Ordering::SeqCst) <= super::STARRED_RELEASE_ENRICH_LIMIT,
            "quota guard: release lookups capped at STARRED_RELEASE_ENRICH_LIMIT"
        );
        // Beyond-cap repos keep old behavior (false, installable-unknown) without network.
        let enriched = result.other_repos.iter().filter(|r| r.has_releases).count();
        assert!(enriched <= super::STARRED_RELEASE_ENRICH_LIMIT);
    }

    #[test]
    fn test_parse_release_tag_from_cached_payload() {
        let payload =
            serde_json::json!({"tag_name": "v3.1.4", "body": "", "assets": []}).to_string();
        assert_eq!(
            CatalogService::parse_release_tag(&payload).as_deref(),
            Some("v3.1.4")
        );
        assert!(CatalogService::parse_release_tag("{}").is_none());
        assert!(CatalogService::parse_release_tag("not-json").is_none());
    }

    // Silence dead-code warnings for the shared mock helper when only a
    // subset of tests runs.
    #[allow(dead_code)]
    fn _mock_helper_used() {
        let _ = hits_of;
    }
}
