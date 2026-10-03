//! README 多语言变体拉取（`get_readme_variants` 后端实现）。
//!
//! 约定（前端按此对接）：
//! - 入参 `app_id` 经 `get_repo_coordinates`（内含 `canonical_app_id` 归一）解析为
//!   `owner/repo`，未知标识直接拒绝；大小写容错收敛于 `forge::coord` + canonical 单点，
//!   本模块不再手写 `to_lowercase` 多段回退。
//! - 分支优先 `repo_info.default_branch`，依次回退 `main` / `master` / `HEAD`
//!  （兼容 `detail.rs` 的 `default_branch … or HEAD` 语义）。
//! - 根目录优先 `GET /repos/{o}/{r}/contents?ref={branch}`（轻量），失败再回退
//!   `git/trees?recursive=1` 并只收 `path` 不含 `/` 的根文件。
//! - 超时统一 `github::http::api_timeout`，鉴权头统一 `token_headers`，client 统一
//!   `forge::http::new_api_client`；不新增硬编码超时，不向前端泄露 token。
//! - 首版不做新表、不做 migration；`AppDetail::readme_variants` 仅 `#[serde(default)]`
//!   扩展 `detail_json`，旧缓存反序列化不炸。

use super::developer_endpoints::GITHUB_API_BASE;
use super::models::GitHubRepoResponse;
use super::CatalogService;
use crate::models::ReadmeVariant;
use reqwest::header::{HeaderValue, ACCEPT};
use std::sync::LazyLock;

static README_FILE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^readme(?:[._-](zh-cn|zh_cn|zh|cn|en-us|en_us|en|us))?\.(md|markdown)$")
        .expect("invalid README_FILE_RE regex")
});

static README_BARE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^readme\.(md|markdown)$").expect("invalid README_BARE_RE regex")
});

#[derive(Debug, serde::Deserialize)]
struct ContentsEntry {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default, rename = "type")]
    entry_type: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GitTreeResponse {
    #[serde(default)]
    tree: Vec<GitTreeNode>,
}

#[derive(Debug, serde::Deserialize)]
struct GitTreeNode {
    #[serde(default)]
    path: Option<String>,
    #[serde(default, rename = "type")]
    node_type: Option<String>,
}

/// 文件名归一化为 `zh-CN` / `en-US`；非 README 根文件返回 `None`。
/// 无语言后缀默认归为 `en-US`，除非文件名明确含 zh 系标记。
pub(crate) fn classify_readme_lang(file_name: &str) -> Option<&'static str> {
    let base = file_name.rsplit('/').next().unwrap_or(file_name).trim();
    if base.is_empty() || base.contains('/') {
        return None;
    }
    let caps = README_FILE_RE.captures(base)?;
    let token = caps
        .get(1)
        .map(|m| m.as_str().to_ascii_lowercase());
    match token.as_deref() {
        None => Some("en-US"),
        Some("zh-cn") | Some("zh_cn") | Some("zh") | Some("cn") => Some("zh-CN"),
        Some("en-us") | Some("en_us") | Some("en") | Some("us") => Some("en-US"),
        // 正则已收敛后缀集合，兜底仍归 en-US，避免新增语言时炸流程。
        _ => Some("en-US"),
    }
}

/// 根目录路径列表过滤 → 去重（每语言最多 1 个）→ 固定 `zh-CN` 在前、`en-US` 在后，
/// 最多 2 项。含 `/` 的非根路径直接丢弃。
pub(crate) fn select_readme_candidates(paths: &[String]) -> Vec<(String, String)> {
    let mut zh_cands: Vec<String> = Vec::new();
    let mut en_cands: Vec<String> = Vec::new();
    for p in paths {
        let trimmed = p.trim();
        if trimmed.is_empty() || trimmed.contains('/') {
            continue;
        }
        match classify_readme_lang(trimmed) {
            Some("zh-CN") => {
                if !zh_cands.iter().any(|x| x == trimmed) {
                    zh_cands.push(trimmed.to_string());
                }
            }
            Some("en-US") => {
                if !en_cands.iter().any(|x| x == trimmed) {
                    en_cands.push(trimmed.to_string());
                }
            }
            _ => {}
        }
    }
    // en-US 优先裸 README（README.md / README.markdown），再按短路径、字典序稳定选择。
    en_cands.sort_by(|a, b| {
        let bare_a = README_BARE_RE.is_match(a);
        let bare_b = README_BARE_RE.is_match(b);
        (!bare_a)
            .cmp(&(!bare_b))
            .then_with(|| a.len().cmp(&b.len()))
            .then_with(|| a.cmp(b))
    });
    zh_cands.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));

    let mut out = Vec::with_capacity(2);
    if let Some(first) = zh_cands.into_iter().next() {
        out.push(("zh-CN".to_string(), first));
    }
    if let Some(first) = en_cands.into_iter().next() {
        out.push(("en-US".to_string(), first));
    }
    out
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

        let api_timeout = super::http::api_timeout();
        let client = crate::forge::http::new_api_client(api_timeout.as_secs())
            .unwrap_or_else(|_| self.client.clone());
        let headers = super::http::token_headers(token);

        let default_branch =
            fetch_repo_default_branch(&client, &headers, &owner, &repo, api_base, api_timeout)
                .await;

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
            if let Some(paths) =
                list_root_paths(&client, &headers, &owner, &repo, branch, api_base, api_timeout)
                    .await
            {
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

        let mut out = Vec::with_capacity(selected.len().min(2));
        for (lang, path) in selected.into_iter().take(2) {
            let Some(raw) = fetch_readme_text(
                &client,
                &headers,
                &owner,
                &repo,
                &branch,
                &path,
                api_base,
                api_timeout,
            )
            .await
            else {
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
        Ok(out)
    }
}

#[cfg(test)]
mod readme_variants_tests {
    use super::{classify_readme_lang, select_readme_candidates};

    #[test]
    fn test_classify_readme_lang_mapping() {
        // 裸 README 兜底 en-US。
        assert_eq!(classify_readme_lang("README.md"), Some("en-US"));
        assert_eq!(classify_readme_lang("readme.markdown"), Some("en-US"));
        assert_eq!(classify_readme_lang("ReadMe.MD"), Some("en-US"));
        // en 系后缀。
        assert_eq!(classify_readme_lang("README.en.md"), Some("en-US"));
        assert_eq!(classify_readme_lang("README_en-US.markdown"), Some("en-US"));
        assert_eq!(classify_readme_lang("readme-us.md"), Some("en-US"));
        assert_eq!(classify_readme_lang("README.en_us.md"), Some("en-US"));
        // zh 系后缀。
        assert_eq!(classify_readme_lang("README.zh-CN.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README_zh_cn.markdown"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("readme-zh.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README.CN.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("readme_cn.markdown"), Some("zh-CN"));
        // 非 README / 非法后缀一律 None。
        assert_eq!(classify_readme_lang("CONTRIBUTING.md"), None);
        assert_eq!(classify_readme_lang("README.txt"), None);
        assert_eq!(classify_readme_lang("README.zh-CN.txt"), None);
        assert_eq!(classify_readme_lang("docs.md"), None);
    }

    #[test]
    fn test_select_readme_candidates_root_only_dedup_sorted() {
        let paths = vec![
            "README.en.md".to_string(),
            "README.md".to_string(),
            "README.zh-CN.md".to_string(),
            "README.zh.md".to_string(),
            "docs/README.md".to_string(),
            "CONTRIBUTING.md".to_string(),
        ];
        let selected = select_readme_candidates(&paths);
        // 去重后最多 2 项，zh-CN 在前。
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].0, "zh-CN");
        assert_eq!(selected[1].0, "en-US");
        // en-US 优先裸 README。
        assert_eq!(selected[1].1, "README.md");
        // 嵌套目录一律不收。
        assert!(!selected.iter().any(|(_, p)| p.contains('/')));
    }

    #[test]
    fn test_select_readme_candidates_empty_and_single() {
        let empty: Vec<String> = Vec::new();
        assert!(select_readme_candidates(&empty).is_empty());
        let nested = vec!["docs/README.md".to_string(), "src/readme.zh.md".to_string()];
        assert!(select_readme_candidates(&nested).is_empty());
        let single = vec!["README.md".to_string()];
        let out = select_readme_candidates(&single);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], ("en-US".to_string(), "README.md".to_string()));
    }

    #[test]
    fn test_app_detail_readme_variants_serde_backward_compat() {
        // 旧 detail_json（无 readme_variants 字段）必须可解析为 None，不炸 304/缓存命中路径。
        let legacy = serde_json::json!({
            "id": "o/r", "name": "r", "owner": "o", "repo": "r",
            "icon": "", "icon_bg": "", "description": "", "stars": 0u64,
            "forks": 0u64, "license": "MIT", "latest_version": "v1",
            "changelog": "", "is_verified": false, "readme_markdown": "# r",
            "releases": [], "category": "dev", "category_name": "开发工具",
            "platforms": []
        });
        let detail: crate::models::AppDetail =
            serde_json::from_value(legacy).expect("legacy detail must parse");
        assert!(detail.readme_variants.is_none());
    }

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
