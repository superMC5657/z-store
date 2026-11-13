use super::{CatalogService, GITHUB_API_BASE};
use reqwest::header::{AUTHORIZATION, LINK};

/// Star 列表单页上限（GitHub `per_page` 最大值）。
pub const STARRED_PAGE_MAX: u32 = 100;

/// 单页 Star 列表中的一项：仓库坐标 + 原始仓库 JSON。
/// `/users/{u}/starred` 每项与 `/repos/{o}/{r}` 同形，组卡时直接解析该 JSON，无需逐仓请求。
#[derive(Debug)]
pub struct StarredRepoPayload {
    pub coord: crate::icons::RepoCoord,
    pub payload: String,
}

/// GitHub 单页 Star 列表（按 Star 时间倒序）。
#[derive(Debug)]
pub struct StarredPage {
    pub repos: Vec<StarredRepoPayload>,
    pub has_more: bool,
}

/// Star 列表请求地址：用户名为空且已登录时查自己（`/user/starred`，含私有 Star），否则查指定用户。
pub fn starred_page_url(
    username: Option<&str>,
    has_token: bool,
    page: u32,
    per_page: u32,
) -> Result<String, String> {
    let user = username.map(str::trim).filter(|u| !u.is_empty());
    let page = page.max(1);
    let per_page = per_page.clamp(1, STARRED_PAGE_MAX);
    match user {
        Some(u) => Ok(format!(
            "{}/users/{}/starred?per_page={}&page={}",
            GITHUB_API_BASE,
            urlencoding::encode(u),
            per_page,
            page
        )),
        None if has_token => Ok(format!(
            "{}/user/starred?per_page={}&page={}",
            GITHUB_API_BASE, per_page, page
        )),
        None => Err("请提供 GitHub 用户名或先在「设置」中登录 GitHub 账号".to_string()),
    }
}

/// GitHub 分页 `Link` 头是否含下一页（`rel="next"`）；缺头即最后一页。
pub fn link_has_next(link: Option<&str>) -> bool {
    link.map(|l| {
        l.split(',')
            .any(|part| part.split(';').skip(1).any(|p| p.trim() == "rel=\"next\""))
    })
    .unwrap_or(false)
}

/// 原始 Star 列表 JSON → 逐项坐标与仓库 JSON（无 `full_name` 或非 `owner/repo` 形态的项跳过）。
pub fn parse_starred_payloads(body: &str) -> Result<Vec<StarredRepoPayload>, String> {
    let items: Vec<serde_json::Value> = serde_json::from_str(body)
        .map_err(|e| format!("解析 GitHub Starred 列表数据失败: {}", e))?;
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let full_name = item.get("full_name")?.as_str()?.trim().to_string();
            let (owner, repo) = full_name.split_once('/')?;
            if owner.is_empty() || repo.is_empty() || repo.contains('/') {
                return None;
            }
            let id = crate::forge::canonical_app_id(&full_name)?;
            Some(StarredRepoPayload {
                coord: crate::icons::RepoCoord {
                    id,
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                },
                payload: item.to_string(),
            })
        })
        .collect())
}

impl CatalogService {
    /// 拉取一页 Star 列表（一次请求；是否有下一页取自 `Link` 头）。
    pub async fn fetch_starred_page(
        &self,
        username: Option<&str>,
        token: Option<&str>,
        page: u32,
        per_page: u32,
        api_base: Option<&str>,
    ) -> Result<StarredPage, String> {
        let client = super::http::build_api_client()?;
        let headers = super::http::bearer_headers(token);
        let has_token = headers.contains_key(AUTHORIZATION);
        let target_url = starred_page_url(username, has_token, page, per_page)?;
        let resp = client
            .get(Self::request_url(&target_url, api_base))
            .headers(headers)
            .send()
            .await
            .map_err(|e| {
                format!(
                    "连接 GitHub API 失败: {}. 如遇国内网络阻断，请检查网络设置或配置下载加速代理。",
                    e
                )
            })?;

        crate::notify_rate_limit("github.com", resp.headers());
        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();
            return Err(match code {
                401 => "GitHub 认证失败 (401)：登录凭据无效或已过期，请在「设置」中重新登录 GitHub 账号。".to_string(),
                403 => "GitHub API 限额已耗尽 (403): 触发了未登录 API 每小时 60 次的速率限制。请在「设置」中填入个人 GitHub Token (PAT) 即可免费提升至 5000 次/小时配额。".to_string(),
                404 => format!(
                    "未在 GitHub 上找到用户「{}」，请检查用户名拼写是否正确。",
                    username.map(str::trim).filter(|u| !u.is_empty()).unwrap_or("当前用户")
                ),
                _ => format!(
                    "GitHub API 响应异常 (HTTP {}): {}",
                    code,
                    status.canonical_reason().unwrap_or("未知错误")
                ),
            });
        }
        let has_more = link_has_next(resp.headers().get(LINK).and_then(|v| v.to_str().ok()));
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取 GitHub Starred 列表失败: {}", e))?;
        Ok(StarredPage {
            repos: parse_starred_payloads(&body)?,
            has_more,
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
            collected: std::sync::RwLock::new(Vec::new()),
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

    pub(crate) struct MockRoute {
        pub(crate) resp: MockResp,
        pub(crate) link: Option<String>,
    }

    pub(crate) struct MockServer {
        pub(crate) base: String,
        pub(crate) seen_inm: Arc<Mutex<HashMap<String, Option<String>>>>,
        pub(crate) request_counts: Arc<Mutex<HashMap<String, usize>>>,
    }

    pub(crate) async fn spawn_mock(routes: HashMap<String, MockResp>) -> MockServer {
        let wrapped = routes
            .into_iter()
            .map(|(k, resp)| (k, MockRoute { resp, link: None }))
            .collect();
        spawn_mock_routes(wrapped).await
    }

    pub(crate) async fn spawn_mock_routes(routes: HashMap<String, MockRoute>) -> MockServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes = Arc::new(routes);
        let seen_inm: Arc<Mutex<HashMap<String, Option<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let request_counts: Arc<Mutex<HashMap<String, usize>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let seen_c = seen_inm.clone();
        let counts_c = request_counts.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let routes = routes.clone();
                let seen = seen_c.clone();
                let counts = counts_c.clone();
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
                    seen.lock().unwrap().insert(path.clone(), inm.clone());
                    *counts.lock().unwrap().entry(path.clone()).or_insert(0) += 1;
                    let (status, reason, etag, link, body) = match routes.get(&path) {
                        Some(route) => {
                            let r = &route.resp;
                            if let Some(ref want) = r.honor_inm {
                                if inm.as_deref() == Some(want.as_str()) {
                                    (304u16, "Not Modified", None, None, String::new())
                                } else {
                                    (
                                        r.status,
                                        r.reason,
                                        r.etag.clone(),
                                        route.link.clone(),
                                        r.body.clone(),
                                    )
                                }
                            } else {
                                (
                                    r.status,
                                    r.reason,
                                    r.etag.clone(),
                                    route.link.clone(),
                                    r.body.clone(),
                                )
                            }
                        }
                        None => (404u16, "Not Found", None, None, "{}".to_string()),
                    };
                    let mut resp = format!("HTTP/1.1 {} {}\r\n", status, reason);
                    resp.push_str("connection: close\r\n");
                    if let Some(e) = etag {
                        resp.push_str(&format!("etag: {}\r\n", e));
                    }
                    if let Some(l) = link {
                        resp.push_str(&format!("link: {}\r\n", l));
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
            seen_inm,
            request_counts,
        }
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
}
