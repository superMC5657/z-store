use super::readme_parse::{ContentsEntry, GitTreeResponse, select_readme_candidates};
use crate::github::developer_endpoints::GITHUB_API_BASE;
use crate::github::models::GitHubRepoResponse;
use crate::github::CatalogService;
use crate::models::ReadmeVariant;
use reqwest::header::{HeaderValue, ACCEPT};
use std::sync::LazyLock;

/// README 变体复用缓存：`default_branch` 按 `owner/repo` 缓存，
/// 根目录列表按 `owner/repo@branch` 缓存，TTL 与详情缓存挡位一致。
/// 内存一次、无新表、无 schema 变更；失败静默降级（锁失败即视为未命中）。
static DEFAULT_BRANCH_CACHE: LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, (String, i64)>>,
> = LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
type RootPathsCache = std::collections::HashMap<String, (Vec<String>, i64)>;
static ROOT_PATHS_CACHE: LazyLock<std::sync::Mutex<RootPathsCache>> =
    LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn readme_list_ttl_secs() -> i64 {
    if let Some(db) = crate::github::http::open_db_opt() {
        let minutes = db.get_detail_cache_ttl_minutes();
        if minutes <= 0 {
            return 0;
        }
        return minutes * 60;
    }
    let d = crate::config::get_project_config()
        .cache
        .detail_ttl_minutes;
    if d <= 0 {
        return 0;
    }
    d * 60
}

fn branch_cache_key(owner: &str, repo: &str) -> String {
    format!(
        "{}/{}",
        owner.trim().to_lowercase(),
        repo.trim().to_lowercase()
    )
}

fn root_cache_key(owner: &str, repo: &str, branch: &str) -> String {
    format!(
        "{}/{}@{}",
        owner.trim().to_lowercase(),
        repo.trim().to_lowercase(),
        branch.trim()
    )
}

fn cached_default_branch(owner: &str, repo: &str, ttl_secs: i64) -> Option<String> {
    if ttl_secs <= 0 {
        return None;
    }
    let key = branch_cache_key(owner, repo);
    let guard = DEFAULT_BRANCH_CACHE.lock().ok()?;
    let (branch, at) = guard.get(&key)?.clone();
    if branch.trim().is_empty() {
        return None;
    }
    if crate::github::http::now_secs().saturating_sub(at) >= ttl_secs {
        return None;
    }
    Some(branch)
}

fn store_default_branch(owner: &str, repo: &str, branch: &str) {
    let branch = branch.trim();
    if branch.is_empty() {
        return;
    }
    let key = branch_cache_key(owner, repo);
    if let Ok(mut guard) = DEFAULT_BRANCH_CACHE.lock() {
        guard.insert(key, (branch.to_string(), crate::github::http::now_secs()));
    }
}

fn cached_root_paths(owner: &str, repo: &str, branch: &str, ttl_secs: i64) -> Option<Vec<String>> {
    if ttl_secs <= 0 {
        return None;
    }
    let key = root_cache_key(owner, repo, branch);
    let guard = ROOT_PATHS_CACHE.lock().ok()?;
    let (paths, at) = guard.get(&key)?.clone();
    if crate::github::http::now_secs().saturating_sub(at) >= ttl_secs {
        return None;
    }
    Some(paths)
}

fn store_root_paths(owner: &str, repo: &str, branch: &str, paths: &[String]) {
    let key = root_cache_key(owner, repo, branch);
    if let Ok(mut guard) = ROOT_PATHS_CACHE.lock() {
        guard.insert(key, (paths.to_vec(), crate::github::http::now_secs()));
    }
}

/// AppDetail 缓存快查：`detail_json.readme_variants` 非空且 TTL 内直接复用。
/// 测试覆写 `api_base` 时由调用方跳过，避免 mock 污染。
fn try_cached_readme_variants(
    app_id: &str,
    owner: &str,
    repo: &str,
    ttl_secs: i64,
) -> Option<Vec<ReadmeVariant>> {
    if ttl_secs <= 0 {
        return None;
    }
    let db = crate::github::http::open_db_opt()?;
    let key = crate::forge::canonical_app_id(app_id).unwrap_or_else(|| {
        format!(
            "{}/{}",
            owner.trim().to_lowercase(),
            repo.trim().to_lowercase()
        )
    });
    let detail = db.get_cached_app_detail(&key, Some(ttl_secs)).ok().flatten()?;
    let variants = detail.readme_variants?;
    if variants.is_empty() {
        return None;
    }
    Some(variants)
}

/// 变体回填 `detail_json`：有落库详情时原地补 `readme_variants`，无则跳过。
/// 全部静默降级（`ok()` 吞错），不改 API 形状、不改 ETag 语义。
fn persist_readme_variants_silent(
    app_id: &str,
    owner: &str,
    repo: &str,
    variants: &[ReadmeVariant],
) {
    if variants.is_empty() {
        return;
    }
    let Some(db) = crate::github::http::open_db_opt() else {
        return;
    };
    let key = crate::forge::canonical_app_id(app_id).unwrap_or_else(|| {
        format!(
            "{}/{}",
            owner.trim().to_lowercase(),
            repo.trim().to_lowercase()
        )
    });
    let Ok(Some(mut detail)) = db.get_cached_app_detail_fallback(&key) else {
        return;
    };
    detail.readme_variants = Some(variants.to_vec());
    let _ = db.save_cached_app_detail(&key, &detail);
}

async fn fetch_repo_default_branch(
    client: &reqwest::Client,
    headers: &reqwest::header::HeaderMap,
    owner: &str,
    repo: &str,
    api_base: Option<&str>,
    api_timeout: std::time::Duration,
) -> Option<String> {
    let canonical = format!("{GITHUB_API_BASE}/repos/{owner}/{repo}");
    let url = CatalogService::request_url(&canonical, api_base);
    let span = crate::forge::http::HttpSpan::start(&url);
    span.log_search_start("readme-repo");
    let req = client.get(&url).headers(headers.clone()).send();
    let resp = match tokio::time::timeout(api_timeout, req).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            span.log_search_fail("readme-repo", &e.to_string());
            return None;
        }
        Err(_) => {
            span.log_search_fail("readme-repo", "timeout");
            return None;
        }
    };
    span.notify(&resp, "github.com");
    crate::check_auth_expired(
        resp.status().as_u16(),
        &format!("op=readme-repo owner={owner} repo={repo}"),
    );
    let status = resp.status().as_u16();
    span.log_search_done("readme-repo", status);
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<GitHubRepoResponse>()
        .await
        .ok()
        .and_then(|r| r.default_branch)
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
}

/// 列根目录：`contents?ref=` 成功即返（含空即分支有效）；失败回退
/// `git/trees?recursive=1` 只收根文件。两路皆失败返回 `None`（换下个分支）。
async fn list_root_paths(
    client: &reqwest::Client,
    headers: &reqwest::header::HeaderMap,
    owner: &str,
    repo: &str,
    branch: &str,
    api_base: Option<&str>,
    api_timeout: std::time::Duration,
) -> Option<Vec<String>> {
    let canonical_contents = format!("{GITHUB_API_BASE}/repos/{owner}/{repo}/contents?ref={branch}");
    let contents_url = CatalogService::request_url(&canonical_contents, api_base);
    let span = crate::forge::http::HttpSpan::start(&contents_url);
    span.log_search_start("readme-contents");
    let req = client
        .get(&contents_url)
        .headers(headers.clone())
        .send();
    match tokio::time::timeout(api_timeout, req).await {
        Ok(Ok(resp)) => {
            span.notify(&resp, "github.com");
            crate::check_auth_expired(
                resp.status().as_u16(),
                &format!("op=readme-contents owner={owner} repo={repo}"),
            );
            let status = resp.status().as_u16();
            span.log_search_done("readme-contents", status);
            if resp.status().is_success() {
                if let Ok(entries) = resp.json::<Vec<ContentsEntry>>().await {
                    let mut paths = Vec::new();
                    for e in entries {
                        if e.entry_type.as_deref() == Some("dir") {
                            continue;
                        }
                        let p = e.path.or(e.name).unwrap_or_default();
                        let p = p.trim().to_string();
                        if !p.is_empty() && !p.contains('/') {
                            paths.push(p);
                        }
                    }
                    return Some(paths);
                }
                return Some(Vec::new());
            }
        }
        Ok(Err(e)) => span.log_search_fail("readme-contents", &e.to_string()),
        Err(_) => span.log_search_fail("readme-contents", "timeout"),
    }

    // 回退：git trees 全量，过滤根文件。
    let canonical_tree =
        format!("{GITHUB_API_BASE}/repos/{owner}/{repo}/git/trees/{branch}?recursive=1");
    let tree_url = CatalogService::request_url(&canonical_tree, api_base);
    let tree_span = crate::forge::http::HttpSpan::start(&tree_url);
    tree_span.log_search_start("readme-trees");
    let req = client.get(&tree_url).headers(headers.clone()).send();
    match tokio::time::timeout(api_timeout, req).await {
        Ok(Ok(resp)) => {
            tree_span.notify(&resp, "github.com");
            crate::check_auth_expired(
                resp.status().as_u16(),
                &format!("op=readme-trees owner={owner} repo={repo}"),
            );
            let status = resp.status().as_u16();
            tree_span.log_search_done("readme-trees", status);
            if !resp.status().is_success() {
                return None;
            }
            match resp.json::<GitTreeResponse>().await {
                Ok(tree) => {
                    let paths = tree
                        .tree
                        .into_iter()
                        .filter(|n| n.node_type.as_deref() == Some("blob"))
                        .filter_map(|n| n.path)
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty() && !p.contains('/'))
                        .collect::<Vec<_>>();
                    Some(paths)
                }
                Err(_) => Some(Vec::new()),
            }
        }
        Ok(Err(e)) => {
            tree_span.log_search_fail("readme-trees", &e.to_string());
            None
        }
        Err(_) => {
            tree_span.log_search_fail("readme-trees", "timeout");
            None
        }
    }
}

/// 取单个 README 文本：`contents/{path}?ref=` + raw Accept（与 `detail.rs` 一致），
/// 失败再试 `raw.githubusercontent.com`。测试覆写 `api_base` 时跳过直连回退。
#[allow(clippy::too_many_arguments)]
async fn fetch_readme_text(
    client: &reqwest::Client,
    headers: &reqwest::header::HeaderMap,
    owner: &str,
    repo: &str,
    branch: &str,
    path: &str,
    api_base: Option<&str>,
    api_timeout: std::time::Duration,
) -> Option<String> {
    let canonical = format!("{GITHUB_API_BASE}/repos/{owner}/{repo}/contents/{path}?ref={branch}");
    let url = CatalogService::request_url(&canonical, api_base);
    let mut raw_headers = headers.clone();
    raw_headers.remove(ACCEPT);
    raw_headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github.v3.raw"),
    );
    let span = crate::forge::http::HttpSpan::start(&url);
    span.log_search_start("readme-raw");
    let req = client.get(&url).headers(raw_headers).send();
    match tokio::time::timeout(api_timeout, req).await {
        Ok(Ok(resp)) => {
            span.notify(&resp, "github.com");
            crate::check_auth_expired(
                resp.status().as_u16(),
                &format!("op=readme-raw owner={owner} repo={repo}"),
            );
            let status = resp.status().as_u16();
            span.log_search_done("readme-raw", status);
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if !text.trim().is_empty() {
                        return Some(text);
                    }
                }
            }
        }
        Ok(Err(e)) => span.log_search_fail("readme-raw", &e.to_string()),
        Err(_) => span.log_search_fail("readme-raw", "timeout"),
    }

    // 测试模式（api_base 覆写）不打真实 raw 域，避免单测外网依赖。
    if api_base.is_some_and(|b| !b.trim().is_empty()) {
        return None;
    }
    let raw_url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}");
    let raw_span = crate::forge::http::HttpSpan::start(&raw_url);
    raw_span.log_search_start("readme-raw-direct");
    let req = client.get(&raw_url).header(
        reqwest::header::USER_AGENT,
        crate::forge::http::USER_AGENT_VALUE,
    );
    match tokio::time::timeout(api_timeout, req.send()).await {
        Ok(Ok(resp)) => {
            let status = resp.status().as_u16();
            raw_span.log_search_done("readme-raw-direct", status);
            if !resp.status().is_success() {
                return None;
            }
            resp.text()
                .await
                .ok()
                .filter(|t| !t.trim().is_empty())
        }
        Ok(Err(e)) => {
            raw_span.log_search_fail("readme-raw-direct", &e.to_string());
            None
        }
        Err(_) => {
            raw_span.log_search_fail("readme-raw-direct", "timeout");
            None
        }
    }
}

impl CatalogService {
    /// README 多语言变体：解析 `app_id` → 定分支 → 列根目录 → 取文本 → 清洗，
    /// 固定返回去重后最多 2 项（`zh-CN` 在前，`en-US` 在后），空 markdown 剔除。
    /// 全分支列目录失败 / 无命中时返回空数组（不断言错误，前端按空态展示）。
    pub async fn fetch_readme_variants(
        &self,
        app_id: &str,
        token: Option<&str>,
        api_base: Option<&str>,
    ) -> Result<Vec<ReadmeVariant>, String> {
        // canonical 归一 + 目录外坐标合成（external_synth），未知标识直接拒绝。
        let coords = self.get_repo_coordinates(app_id)?;
        let (owner, repo) = (coords.owner, coords.repo);

        // 测试覆写 api_base 时跳过全部复用缓存，保持 mock 确定性。
        let use_cache = !api_base.is_some_and(|b| !b.trim().is_empty());
        let list_ttl = if use_cache { readme_list_ttl_secs() } else { 0 };

        // 快查 AppDetail 缓存：detail_json.readme_variants 未过期直接返回。
        if use_cache && list_ttl > 0 {
            if let Some(cached) = try_cached_readme_variants(app_id, &owner, &repo, list_ttl) {
                return Ok(cached);
            }
        }

        let api_timeout = crate::github::http::api_timeout();
        let client = crate::forge::http::new_api_client(api_timeout.as_secs())
            .unwrap_or_else(|_| self.client.clone());
        let headers = crate::github::http::token_headers(token);

        // default_branch 在 TTL 内复用，key 按 repo（大小写收敛）。
        let default_branch = if use_cache {
            if let Some(cached) = cached_default_branch(&owner, &repo, list_ttl) {
                Some(cached)
            } else {
                let fetched = fetch_repo_default_branch(
                    &client, &headers, &owner, &repo, api_base, api_timeout,
                )
                .await;
                if let Some(ref b) = fetched {
                    store_default_branch(&owner, &repo, b);
                }
                fetched
            }
        } else {
            fetch_repo_default_branch(&client, &headers, &owner, &repo, api_base, api_timeout)
                .await
        };

        let mut branches: Vec<String> = Vec::with_capacity(4);
        if let Some(b) = default_branch {
            branches.push(b);
        }
        for fallback in ["main", "master", "HEAD"] {
            if !branches.iter().any(|b| b == fallback) {
                branches.push(fallback.to_string());
            }
        }

        let mut effective_branch: Option<String> = None;
        let mut selected: Vec<(String, String)> = Vec::new();
        for branch in &branches {
            // contents 列表结果在 TTL 内复用，key 按 repo+branch。
            let paths_opt = if use_cache {
                if let Some(cached) = cached_root_paths(&owner, &repo, branch, list_ttl) {
                    Some(cached)
                } else {
                    let fetched = list_root_paths(
                        &client,
                        &headers,
                        &owner,
                        &repo,
                        branch,
                        api_base,
                        api_timeout,
                    )
                    .await;
                    if let Some(ref paths) = fetched {
                        store_root_paths(&owner, &repo, branch, paths);
                    }
                    fetched
                }
            } else {
                list_root_paths(&client, &headers, &owner, &repo, branch, api_base, api_timeout)
                    .await
            };
            if let Some(paths) = paths_opt {
                effective_branch = Some(branch.clone());
                selected = select_readme_candidates(&paths);
                break;
            }
        }
        let Some(branch) = effective_branch else {
            return Ok(Vec::new());
        };
        if selected.is_empty() {
            return Ok(Vec::new());
        }

        // 2 路正文 join 并发：超时仍走 api_timeout，不硬编码；失败静默跳过。
        let items: Vec<(String, String)> = selected.into_iter().take(2).collect();
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let raws: Vec<((String, String), Option<String>)> = if items.len() == 1 {
            let single = items.into_iter().next().expect("len==1");
            let path = single.1.clone();
            let raw = fetch_readme_text(
                &client,
                &headers,
                &owner,
                &repo,
                &branch,
                &path,
                api_base,
                api_timeout,
            )
            .await;
            vec![(single, raw)]
        } else {
            let first = items[0].clone();
            let second = items[1].clone();
            let first_path = first.1.clone();
            let second_path = second.1.clone();
            let (raw_first, raw_second) = tokio::join!(
                fetch_readme_text(
                    &client,
                    &headers,
                    &owner,
                    &repo,
                    &branch,
                    &first_path,
                    api_base,
                    api_timeout,
                ),
                fetch_readme_text(
                    &client,
                    &headers,
                    &owner,
                    &repo,
                    &branch,
                    &second_path,
                    api_base,
                    api_timeout,
                )
            );
            vec![(first, raw_first), (second, raw_second)]
        };
        let mut out = Vec::with_capacity(raws.len());
        for ((lang, path), raw_opt) in raws {
            let Some(raw) = raw_opt else {
                continue;
            };
            // 清洗管线与 detail.rs 完全一致：先提 Logo 再重写图片。
            let (_, stripped) =
                Self::extract_and_strip_logo_from_readme(&raw, &owner, &repo);
            let markdown = Self::rewrite_readme_images(&stripped, &owner, &repo);
            if markdown.trim().is_empty() {
                continue;
            }
            out.push(ReadmeVariant {
                lang,
                path,
                markdown,
            });
        }
        // 回填 detail_json 供下次快查复用（无落库详情时跳过，吞错）。
        if use_cache && !out.is_empty() {
            persist_readme_variants_silent(app_id, &owner, &repo, &out);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn test_fetch_readme_variants_contents_happy_path() {
        use crate::github::developer_starred::test_support::{spawn_mock, MockResp};
        use std::collections::HashMap;

        let mut routes = HashMap::new();
        routes.insert(
            "/repos/o/r".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: serde_json::json!({"default_branch": "main"}).to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o/r/contents?ref=main".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: serde_json::json!([
                    {"name": "README.md", "path": "README.md", "type": "file"},
                    {"name": "README.zh-CN.md", "path": "README.zh-CN.md", "type": "file"},
                    {"name": "guide.md", "path": "docs/guide.md", "type": "file"}
                ])
                .to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o/r/contents/README.zh-CN.md?ref=main".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: "# 你好".to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o/r/contents/README.md?ref=main".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: "# Hello".to_string(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = crate::github::CatalogService {
            items: std::sync::RwLock::new(Vec::new()),
            client: reqwest::Client::new(),
        };
        let variants = svc
            .fetch_readme_variants("o/r", None, Some(&srv.base))
            .await
            .expect("mock fetch must succeed");
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].lang, "zh-CN");
        assert_eq!(variants[0].path, "README.zh-CN.md");
        assert!(variants[0].markdown.contains("你好"));
        assert_eq!(variants[1].lang, "en-US");
        assert_eq!(variants[1].path, "README.md");
        assert!(variants[1].markdown.contains("Hello"));
    }

    #[tokio::test]
    async fn test_fetch_readme_variants_trees_fallback_root_only() {
        use crate::github::developer_starred::test_support::{spawn_mock, MockResp};
        use std::collections::HashMap;

        let mut routes = HashMap::new();
        routes.insert(
            "/repos/o/r2".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: serde_json::json!({"default_branch": "main"}).to_string(),
                honor_inm: None,
            },
        );
        // contents 刻意不注册 → 404，触发 trees 回退。
        routes.insert(
            "/repos/o/r2/git/trees/main?recursive=1".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: serde_json::json!({
                    "tree": [
                        {"path": "README.md", "type": "blob"},
                        {"path": "README.zh.md", "type": "blob"},
                        {"path": "docs/README.md", "type": "blob"},
                        {"path": "src", "type": "tree"}
                    ]
                })
                .to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o/r2/contents/README.zh.md?ref=main".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: "# 中文".to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o/r2/contents/README.md?ref=main".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: "# EN".to_string(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = crate::github::CatalogService {
            items: std::sync::RwLock::new(Vec::new()),
            client: reqwest::Client::new(),
        };
        let variants = svc
            .fetch_readme_variants("o/r2", None, Some(&srv.base))
            .await
            .expect("trees fallback must succeed");
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].lang, "zh-CN");
        assert!(!variants.iter().any(|v| v.path.contains('/')));
    }
}
