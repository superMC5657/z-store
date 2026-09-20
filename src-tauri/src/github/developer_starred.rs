use super::CatalogService;
use super::developer_profile::EtagGetOutcome;
use super::developer_endpoints::{
    GITHUB_API_BASE, GITHUB_STARRED_MAX_PAGE_SIZE, STARRED_RELEASE_ENRICH_LIMIT,
};
use super::models::GitHubRepoResponse;
use crate::models::{DeveloperRepoItem, StarredSyncResult};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use std::collections::HashMap;

impl CatalogService {
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
pub(crate) mod test_support {
    use super::CatalogService;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    pub(crate) fn test_service() -> CatalogService {
        CatalogService {
            items: std::sync::RwLock::new(Vec::new()),
            client: reqwest::Client::new(),
        }
    }

    pub(crate) struct MockResp {
        pub(crate) status: u16,
        pub(crate) reason: &'static str,
        pub(crate) etag: Option<String>,
        pub(crate) body: String,
        /// 若设置，当请求中的 If-None-Match 等于该值时响应 304。
        pub(crate) honor_inm: Option<String>,
    }

    pub(crate) struct MockServer {
        pub(crate) base: String,
        pub(crate) hits: Arc<Mutex<HashMap<String, usize>>>,
        pub(crate) seen_inm: Arc<Mutex<HashMap<String, Option<String>>>>,
    }

    pub(crate) async fn spawn_mock(routes: HashMap<String, MockResp>) -> MockServer {
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

    pub(crate) fn hits_of(srv: &MockServer, path: &str) -> usize {
        srv.hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    pub(crate) fn user_json(login: &str) -> String {
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

    pub(crate) fn repos_json() -> String {
        serde_json::json!([
            {"name": "r1", "full_name": "someone/r1", "html_url": "https://github.com/someone/r1",
             "description": "d1", "stargazers_count": 5u64, "forks_count": 1u64, "language": "Rust"}
        ])
        .to_string()
    }
    // 当仅运行部分单测时，抑制共享 mock 辅助函数的 dead-code 告警。
    #[allow(dead_code)]
    fn _mock_helper_used() {
        let _ = hits_of;
    }
}
