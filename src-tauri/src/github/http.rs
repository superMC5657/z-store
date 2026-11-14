//! GitHub 内本地 HTTP/日志/兜底 helpers（github + commands 共用）。

use crate::forge::http::retry_after_delay_ms;
use crate::models::{AppCore, AppSummary};
use reqwest::header::{HeaderMap, HeaderValue, IF_NONE_MATCH};

#[derive(Debug, Clone)]
pub(crate) enum EtagGetOutcome {
    Fresh { text: String, etag: Option<String> },
    NotModified,
    Unauthorized,
    Failed,
}

/// 通用 ETag GET 请求通道：挂载 `If-None-Match`，处理 304 / 401 / 200 结果并上报限流；
/// 不直接打日志，交由上层宽事件统一汇总。
pub(crate) async fn get_with_etag(
    client: &reqwest::Client,
    canonical_url: &str,
    api_base: Option<&str>,
    base_headers: &HeaderMap,
    cached_etag: Option<&str>,
) -> EtagGetOutcome {
    get_with_etag_diag(client, canonical_url, api_base, base_headers, cached_etag)
        .await
        .0
}

/// 分页感知的 ETag GET 通道：除 `EtagGetOutcome` 外同时解析响应头 `Link` 中的 `rel="next"`。
pub(crate) async fn get_with_etag_with_link(
    client: &reqwest::Client,
    canonical_url: &str,
    api_base: Option<&str>,
    base_headers: &HeaderMap,
    cached_etag: Option<&str>,
) -> (EtagGetOutcome, bool) {
    let (outcome, _diag, has_next) =
        get_with_etag_diag_inner(client, canonical_url, api_base, base_headers, cached_etag).await;
    (outcome, has_next)
}

/// 带诊断摘要的 ETag GET 通道（返回 `(EtagGetOutcome, HttpDiag)` 供宽事件聚合作业使用）。
pub(crate) async fn get_with_etag_diag(
    client: &reqwest::Client,
    canonical_url: &str,
    api_base: Option<&str>,
    base_headers: &HeaderMap,
    cached_etag: Option<&str>,
) -> (EtagGetOutcome, crate::log_support::HttpDiag) {
    let (outcome, diag, _) =
        get_with_etag_diag_inner(client, canonical_url, api_base, base_headers, cached_etag).await;
    (outcome, diag)
}

async fn get_with_etag_diag_inner(
    client: &reqwest::Client,
    canonical_url: &str,
    api_base: Option<&str>,
    base_headers: &HeaderMap,
    cached_etag: Option<&str>,
) -> (EtagGetOutcome, crate::log_support::HttpDiag, bool) {
    let url = crate::github::CatalogService::request_url(canonical_url, api_base);
    let mut headers = base_headers.clone();
    if let Some(etag) = cached_etag {
        if !etag.trim().is_empty() {
            if let Ok(val) = HeaderValue::from_str(etag) {
                headers.insert(IF_NONE_MATCH, val);
            }
        }
    }
    let safe_url = crate::log_support::sanitize_url(&url);
    let host = crate::log_support::host_of(&url);
    let start = std::time::Instant::now();
    // 有限重试：仅传输错误(is_timeout/is_connect)+429/5xx，最多 2 次；
    // 429 消费 Retry-After（上限 60s 缺省 5s，对齐 D9），5xx/传输错误退避 200ms -> 800ms；
    // 401/404/304 直接返回；限流上报逻辑不变（每轮响应照常上报）。
    const RETRY_BACKOFF_MS: [u64; 2] = [200, 800];
    let mut attempt: usize = 0;
    let mut rate_summary: Option<String> = None;
    let mut active = client.clone();
    let res = loop {
        match active.get(&url).headers(headers.clone()).send().await {
            Ok(r) => {
                crate::notify_rate_limit("github.com", r.headers());
                if let Some(rs) = crate::log_support::rate_limit_summary(r.headers()) {
                    rate_summary = Some(rs);
                }
                let status = r.status();
                let retryable_status = status.as_u16() == 429 || status.is_server_error();
                if retryable_status && attempt < RETRY_BACKOFF_MS.len() {
                    let delay_ms = if status.as_u16() == 429 {
                        retry_after_delay_ms(r.headers())
                    } else {
                        RETRY_BACKOFF_MS[attempt]
                    };
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    attempt += 1;
                    continue;
                }
                break r;
            }
            Err(e) => {
                let retryable_err = e.is_timeout() || e.is_connect();
                if retryable_err && attempt < RETRY_BACKOFF_MS.len() {
                    // 立即重探系统代理：签名变化（用户刚开启/关闭代理）即改用重建后的 API 池重试
                    //（本通道调用方均为带 Token 的 GitHub API 请求，传入的即 API 池 Client）。
                    if crate::proxy::refresh_after_transport_error().await {
                        if let Ok(fresh) = build_api_client() {
                            active = fresh;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(RETRY_BACKOFF_MS[attempt]))
                        .await;
                    attempt += 1;
                    continue;
                }
                let diag = crate::log_support::HttpDiag {
                    status: None,
                    elapsed_ms: start.elapsed().as_millis(),
                    retries: attempt as u8,
                    bytes: 0,
                    host,
                    safe_url,
                    err_reason: Some(crate::log_support::http_err_reason(&e)),
                    rate_summary,
                };
                return (EtagGetOutcome::Failed, diag, false);
            }
        }
    };
    let status = res.status();
    let has_next = crate::github::developer_starred::link_has_next(
        res.headers()
            .get(reqwest::header::LINK)
            .and_then(|h| h.to_str().ok()),
    );
    let mut diag = crate::log_support::HttpDiag {
        status: Some(status.as_u16()),
        elapsed_ms: start.elapsed().as_millis(),
        retries: attempt as u8,
        bytes: 0,
        host,
        safe_url,
        err_reason: None,
        rate_summary,
    };
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return (EtagGetOutcome::NotModified, diag, has_next);
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        diag.err_reason = Some("http_401".to_string());
        return (EtagGetOutcome::Unauthorized, diag, false);
    }
    if !status.is_success() {
        diag.err_reason = Some(format!("http_{}", status.as_u16()));
        return (EtagGetOutcome::Failed, diag, false);
    }
    let etag = res
        .headers()
        .get("etag")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());
    match res.text().await {
        Ok(text) => {
            diag.bytes = text.len();
            diag.elapsed_ms = start.elapsed().as_millis();
            (EtagGetOutcome::Fresh { text, etag }, diag, has_next)
        }
        Err(e) => {
            diag.elapsed_ms = start.elapsed().as_millis();
            diag.err_reason = Some(crate::log_support::short_reason(&e.to_string()));
            (EtagGetOutcome::Failed, diag, false)
        }
    }
}

/// UA 常量统一在 `forge::http` SSOT；ACCEPT 由 `ApiPreset::GithubApi` 表驱动。
pub(crate) const GH_USER_AGENT: &str = crate::forge::http::USER_AGENT_VALUE;

/// github 内统一秒级时间戳（与 `db::now_secs` 同语义）。
pub(crate) fn now_secs() -> i64 {
    crate::now_secs()
}

/// 统一 API 超时（读取项目配置）。
pub(crate) fn api_timeout() -> std::time::Duration {
    std::time::Duration::from_secs(
        crate::config::get_project_config()
            .network
            .api_timeout_seconds,
    )
}

/// 统一 API 客户端构造（委托 `forge::http` SSOT）。
pub(crate) fn build_api_client() -> Result<reqwest::Client, String> {
    crate::forge::http::new_api_client(api_timeout().as_secs())
}

/// `token {}` 方案（含 ACCEPT）。
/// 薄包装：函数体委托 `forge::http` 表驱动预设（`Token` 小写前缀不可合错）。
pub(crate) fn token_headers(token: Option<&str>) -> HeaderMap {
    crate::forge::http::preset_headers(
        crate::forge::http::ApiPreset::GithubApi,
        token,
        crate::forge::http::AuthScheme::Token,
    )
}

/// `Bearer {}` 方案（含 ACCEPT）。
/// 薄包装：函数体委托 `forge::http` 表驱动预设。
pub(crate) fn bearer_headers(token: Option<&str>) -> HeaderMap {
    crate::forge::http::preset_headers(
        crate::forge::http::ApiPreset::GithubApi,
        token,
        crate::forge::http::AuthScheme::Bearer,
    )
}

/// 分类元信息结构体。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CategoryMeta {
    pub key: &'static str,
    pub name: &'static str,
    pub gradient: &'static str,
}

/// 应用缺省底色渐变（图标占位/未收录兜底的唯一来源）：
/// 与前端 styles token `DEFAULT_ICON_BG`（`src/styles/tokens.ts`）同值互指；
/// 新代码一律引用本常量，禁止手写字面渐变。
pub(crate) const DEFAULT_ICON_BG: &str = "linear-gradient(135deg, #475569, #334155)";

/// 移植 catalog guessCategory 关键词表（system/network/media/security/dev/graphics/office/reading/ops/games）。
/// 依据 description（含中文与英文）及 GitHub topics 标签推断最贴切的分类。
pub(crate) fn guess_category(
    desc: Option<&str>,
    desc_en: Option<&str>,
    topics: &[String],
) -> CategoryMeta {
    let mut text = String::new();
    if let Some(d) = desc {
        text.push_str(d);
        text.push(' ');
    }
    if let Some(d) = desc_en {
        text.push_str(d);
        text.push(' ');
    }
    for topic in topics {
        text.push_str(topic);
        text.push(' ');
    }
    let text = text.to_lowercase();

    if text.contains("remote")
        || text.contains("desktop")
        || text.contains("cleaner")
        || text.contains("launcher")
        || text.contains("file manager")
    {
        return CategoryMeta {
            key: "system",
            name: "系统实用",
            gradient: DEFAULT_ICON_BG,
        };
    }
    if text.contains("network")
        || text.contains("transfer")
        || text.contains("download")
        || text.contains("torrent")
        || text.contains("proxy")
        || text.contains("vpn")
    {
        return CategoryMeta {
            key: "network",
            name: "网络工具",
            gradient: "linear-gradient(135deg, #0284c7, #0369a1)",
        };
    }
    if text.contains("player")
        || text.contains("video")
        || text.contains("audio")
        || text.contains("music")
        || text.contains("stream")
        || text.contains("record")
    {
        return CategoryMeta {
            key: "media",
            name: "影音视听",
            gradient: "linear-gradient(135deg, #ec4899, #be185d)",
        };
    }
    if text.contains("password")
        || text.contains("security")
        || text.contains("crypto")
        || text.contains("2fa")
        || text.contains("otp")
        || text.contains("authenticator")
    {
        return CategoryMeta {
            key: "security",
            name: "安全隐私",
            gradient: "linear-gradient(135deg, #059669, #047857)",
        };
    }
    if text.contains("editor")
        || text.contains("terminal")
        || text.contains("git")
        || text.contains("code")
        || text.contains("developer")
        || text.contains("api")
    {
        return CategoryMeta {
            key: "dev",
            name: "开发工具",
            gradient: "linear-gradient(135deg, #2563eb, #1d4ed8)",
        };
    }
    if text.contains("image")
        || text.contains("paint")
        || text.contains("photo")
        || text.contains("screenshot")
        || text.contains("3d")
        || text.contains("svg")
    {
        return CategoryMeta {
            key: "graphics",
            name: "图形设计",
            gradient: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
        };
    }
    if text.contains("note")
        || text.contains("markdown")
        || text.contains("pdf")
        || text.contains("office")
        || text.contains("todo")
        || text.contains("calendar")
    {
        return CategoryMeta {
            key: "office",
            name: "效率办公",
            gradient: "linear-gradient(135deg, #d97706, #b45309)",
        };
    }
    if text.contains("book")
        || text.contains("reader")
        || text.contains("rss")
        || text.contains("epub")
        || text.contains("feed")
    {
        return CategoryMeta {
            key: "reading",
            name: "学习阅读",
            gradient: "linear-gradient(135deg, #0d9488, #0f766e)",
        };
    }
    if text.contains("docker")
        || text.contains("kubernetes")
        || text.contains("monitor")
        || text.contains("database")
        || text.contains("server")
    {
        return CategoryMeta {
            key: "ops",
            name: "极客运维",
            gradient: "linear-gradient(135deg, #4f46e5, #3730a3)",
        };
    }
    if text.contains("game") || text.contains("emulator") || text.contains("arcade") {
        return CategoryMeta {
            key: "games",
            name: "休闲游戏",
            gradient: "linear-gradient(135deg, #e11d48, #be123c)",
        };
    }

    CategoryMeta {
        key: "dev",
        name: "开发工具",
        gradient: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    }
}

/// 目录外仓库 `AppSummary` 兜底构造。
/// 图标：若 probe 为 true，经统一同步适配器 `icons::probe_single_live`（L2→L3，
/// 经 `resolve_probe_branches` 取默认分支，与流式核同源）；
/// 图标探测不调 users API、不拼用户画像 avatar_url（见 OAuth/Sidebar，与图标无关）；
/// 若 probe 为 false，图标置空（首屏快返，等后台 `fetch_icons_stream` emit）。
/// 分类：移植 catalog guessCategory 关键词表，按 topics+description 判定。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fallback_summary(
    client: &reqwest::Client,
    id: String,
    name: String,
    owner: String,
    repo: String,
    description: String,
    description_en: Option<String>,
    stars: u64,
    forks: u64,
    license: String,
    topics: &[String],
    homepage: Option<String>,
    probe: bool,
    confirmed_icon: Option<String>,
    token: Option<&str>,
) -> AppSummary {
    let cat = guess_category(Some(&description), description_en.as_deref(), topics);
    let confirmed = confirmed_icon;
    let icon = if let Some(ci) = confirmed {
        ci
    } else if probe {
        // 同步适配器唯一口：`probe_single_live`（L2→L3，仅默认分支，与流式核同源）。
        // 无 token 只探 L2（保护匿名配额），有 token 才含 Trees，不另起内联探。
        let hdrs_opt = token
            .filter(|t| !t.trim().is_empty())
            .map(|tok| token_headers(Some(tok)));
        let icon_client = crate::forge::http::new_icon_client(api_timeout().as_secs())
            .unwrap_or_default();
        crate::icons::probe_single_live(&icon_client, client, hdrs_opt.as_ref(), &owner, &repo)
            .await
            .map(|(url, _level)| url)
            .unwrap_or_default()
    } else {
        String::new()
    };

    AppSummary {
        core: AppCore {
            id,
            name,
            description_en,
            owner,
            repo,
            icon,
            icon_bg: cat.gradient.to_string(),
            description,
            stars,
            forks,
            license,
            latest_version: "latest".to_string(),
            category: cat.key.to_string(),
            category_name: cat.name.to_string(),
            is_verified: false,
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            homepage,
            platforms: Vec::new(),
            is_cataloged: None,
            source: None,
            status: None,
            added_at: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_guess_category_all_10_kinds() {
        assert_eq!(
            guess_category(Some("A remote desktop client"), None, &[]).key,
            "system"
        );
        assert_eq!(
            guess_category(Some("High performance proxy and vpn"), None, &[]).key,
            "network"
        );
        assert_eq!(
            guess_category(Some("Music and video stream player"), None, &[]).key,
            "media"
        );
        assert_eq!(
            guess_category(Some("Password manager and 2fa authenticator"), None, &[]).key,
            "security"
        );
        assert_eq!(
            guess_category(Some("Code editor and terminal"), None, &[]).key,
            "dev"
        );
        assert_eq!(
            guess_category(Some("3D image paint and photo screenshot"), None, &[]).key,
            "graphics"
        );
        assert_eq!(
            guess_category(Some("Markdown note and pdf office tool"), None, &[]).key,
            "office"
        );
        assert_eq!(
            guess_category(Some("RSS feed reader and book library"), None, &[]).key,
            "reading"
        );
        assert_eq!(
            guess_category(Some("Docker container and kubernetes server"), None, &[]).key,
            "ops"
        );
        assert_eq!(
            guess_category(Some("Retro arcade game emulator"), None, &[]).key,
            "games"
        );
    }

    #[test]
    fn test_guess_category_fallback_to_dev() {
        assert_eq!(
            guess_category(Some("Unmatched generic project"), None, &[]).key,
            "dev"
        );
        assert_eq!(guess_category(None, None, &[]).key, "dev");
    }

    #[test]
    fn test_guess_category_via_topics() {
        assert_eq!(
            guess_category(None, None, &["proxy".to_string(), "vpn".to_string()]).key,
            "network"
        );
        assert_eq!(
            guess_category(None, None, &["emulator".to_string()]).key,
            "games"
        );
    }

    #[tokio::test]
    async fn test_fallback_summary_confirmed_icon_semantics() {
        let client = reqwest::Client::new();

        // 当 confirmed_icon 为 None 且 probe 为 false 时，icon 必须置空
        let summary_none = fallback_summary(
            &client,
            "demo/app".to_string(),
            "app".to_string(),
            "demo".to_string(),
            "app".to_string(),
            "Demo description".to_string(),
            None,
            10,
            2,
            "MIT".to_string(),
            &[],
            None,
            false,
            None,
            None,
        )
        .await;
        assert_eq!(summary_none.core.icon, "");
        // 未知仓库返回 []，由前端 virtual-Other 接管。
        assert!(summary_none.core.platforms.is_empty());

        // 当 confirmed_icon 存在时，无论是 probe=true 还是 probe=false 均优先使用 confirmed_icon
        let custom_uri = "data:image/png;base64,testdata";
        let summary_confirmed = fallback_summary(
            &client,
            "demo/app".to_string(),
            "app".to_string(),
            "demo".to_string(),
            "app".to_string(),
            "Demo description".to_string(),
            None,
            10,
            2,
            "MIT".to_string(),
            &[],
            None,
            false,
            Some(custom_uri.to_string()),
            None,
        )
        .await;
        assert_eq!(summary_confirmed.core.icon, custom_uri);
        // platforms 未知仓库一律 []。
        assert!(summary_confirmed.core.platforms.is_empty());
    }

    #[tokio::test]
    async fn test_fallback_summary_platforms_empty_no_windows_stamp() {
        let client = reqwest::Client::new();
        let summary = fallback_summary(
            &client,
            "unknown/repo".to_string(),
            "repo".to_string(),
            "unknown".to_string(),
            "repo".to_string(),
            "Unknown repo".to_string(),
            None,
            0,
            0,
            "MIT".to_string(),
            &[],
            None,
            false,
            None,
            None,
        )
        .await;
        assert!(summary.core.platforms.is_empty());
        assert!(!summary.core.platforms.contains(&"windows".to_string()));
        assert!(!summary.core.platforms.contains(&"other".to_string()));
    }
}
