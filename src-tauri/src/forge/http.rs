use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};

/// forge 内复用的 UA / Accept 常量：避免 9 处 client+header 重复手写。
/// SSOT：所有 UA / Accept 字面量只在此一处定义，其余模块经别名或 `api_headers`/`preset_headers` 复用。
pub const USER_AGENT_VALUE: &str = "ZStore-Client/0.1.0";
pub const GITHUB_ACCEPT_VALUE: &str = "application/vnd.github.v3+json";
pub const JSON_ACCEPT_VALUE: &str = "application/json";
/// 图标/CDN 专用：浏览器 UA + image/* Accept，与 API client 严格隔离（见 `new_icon_client`）。
pub const BROWSER_UA_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
pub const ICON_ACCEPT_VALUE: &str = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/// forge 内两种 Authorization 前缀：GitHub/GitLab 用 Bearer，Gitea/Forgejo 用 token。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScheme {
    Bearer,
    Token,
}

/// 表驱动 API 预设：Accept + UA 成对收敛，调用方只选预设不手写字面量。
/// - `GithubApi`：GitHub v3 Accept + ZStore UA（`detail`/`search` 旧行为经 `AuthScheme` 区分 `token`/`Bearer`）；
/// - `JsonApi`：通用 `application/json` + ZStore UA（`device_flow` / Gitea / GitLab）；
/// - `IconCdn`：`image/*` Accept + 浏览器 UA（SimpleIcons/CDN/raw 图标，绝不携带 token，与 API client 隔离）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiPreset {
    GithubApi,
    JsonApi,
    IconCdn,
}

impl ApiPreset {
    pub fn accept(&self) -> &'static str {
        match self {
            ApiPreset::GithubApi => GITHUB_ACCEPT_VALUE,
            ApiPreset::JsonApi => JSON_ACCEPT_VALUE,
            ApiPreset::IconCdn => ICON_ACCEPT_VALUE,
        }
    }

    pub fn user_agent(&self) -> &'static str {
        match self {
            ApiPreset::GithubApi | ApiPreset::JsonApi => USER_AGENT_VALUE,
            ApiPreset::IconCdn => BROWSER_UA_VALUE,
        }
    }
}

/// 单一 Client 构造点（本文件内唯一构造器）：`redirect_limit` 为 `None` 即 API 语义，
/// `Some(10)` 即图标/CDN 语义（有限重定向），调用方经 `new_api_client` / `new_icon_client` 分流，语义不混用。
fn build_client(
    timeout_secs: u64,
    redirect_limit: Option<usize>,
) -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(timeout_secs));
    if let Some(limit) = redirect_limit {
        builder = builder.redirect(reqwest::redirect::Policy::limited(limit));
    }
    builder.build().map_err(|e| e.to_string())
}

/// 复用 timeout 取参的 Client 构造：调用方传入 `api_timeout_seconds` 即可。
pub fn new_api_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    build_client(timeout_secs, None)
}

/// 图标/CDN 专用 Client：同 timeout 语义 + `redirect limited(10)`，绝不与 API client 混用。
pub fn new_icon_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    build_client(timeout_secs, Some(10))
}

fn headers_with_ua(ua: &str, accept: &str, token: Option<&str>, scheme: AuthScheme) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(ua) {
        headers.insert(USER_AGENT, v);
    }
    if let Ok(v) = HeaderValue::from_str(accept) {
        headers.insert(ACCEPT, v);
    }
    if let Some(tok) = token {
        let trimmed = tok.trim();
        if !trimmed.is_empty() {
            let prefix = match scheme {
                AuthScheme::Bearer => "Bearer",
                AuthScheme::Token => "token",
            };
            if let Ok(v) = HeaderValue::from_str(&format!("{prefix} {trimmed}")) {
                headers.insert(AUTHORIZATION, v);
            }
        }
    }
    headers
}

/// 统一 header 组装：UA + Accept + 可选 token。
pub fn api_headers(accept: &str, token: Option<&str>, scheme: AuthScheme) -> HeaderMap {
    headers_with_ua(USER_AGENT_VALUE, accept, token, scheme)
}

/// 表驱动 header 组装：预设决定 Accept + UA，`scheme` 决定 Authorization 前缀。
/// `IconCdn` 预设恒忽略 `token`（避免鉴权头泄漏到 CDN/图标域）。
pub fn preset_headers(preset: ApiPreset, token: Option<&str>, scheme: AuthScheme) -> HeaderMap {
    let effective_token = match preset {
        ApiPreset::IconCdn => None,
        ApiPreset::GithubApi | ApiPreset::JsonApi => token,
    };
    headers_with_ua(preset.user_agent(), preset.accept(), effective_token, scheme)
}

/// 图标请求头便捷：浏览器 UA + `image/*` Accept，无鉴权。
pub fn icon_headers() -> HeaderMap {
    preset_headers(ApiPreset::IconCdn, None, AuthScheme::Bearer)
}

/// 统一 HTTP 跨度：req_id/sid/host/safe_url/start + 统一日志/rate_limit 入口。
/// 行为保持不变：只收敛 id 生成与日志字段组装，不改变请求语义；
/// rate_limit 由调用方显式触发（GitHub 传 "github.com"，其余 forge 保持原样不触发）。
pub struct HttpSpan {
    pub req_id: String,
    pub sid: String,
    pub host: String,
    pub safe_url: String,
    pub start: std::time::Instant,
}

impl HttpSpan {
    pub fn start(url: &str) -> Self {
        Self {
            req_id: crate::z_log::new_req_id(),
            sid: crate::z_log::new_session_id(),
            host: crate::log_support::host_of(url),
            safe_url: crate::log_support::sanitize_url(url),
            start: std::time::Instant::now(),
        }
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.start.elapsed().as_millis()
    }

    pub fn log_start(&self, op: &str, id: &str) {
        log::debug!(
            "forge http {} id={} sid={} req={} url='{}'",
            op,
            id,
            self.sid,
            self.req_id,
            self.safe_url
        );
    }

    pub fn log_search_start(&self, op: &str) {
        log::debug!(
            "forge http {} sid={} req={} url='{}'",
            op,
            self.sid,
            self.req_id,
            self.safe_url
        );
    }

    pub fn log_fail(&self, op: &str, id: &str, reason: &str) {
        log::warn!(
            "forge http {} failed id={} sid={} req={} host={} reason={}",
            op,
            id,
            self.sid,
            self.req_id,
            self.host,
            crate::log_support::short_reason(reason)
        );
    }

    pub fn log_search_fail(&self, op: &str, reason: &str) {
        log::warn!(
            "forge http {} failed sid={} req={} host={} reason={}",
            op,
            self.sid,
            self.req_id,
            self.host,
            crate::log_support::short_reason(reason)
        );
    }

    pub fn log_done(&self, op: &str, id: &str, status: u16) {
        let ms = self.elapsed_ms();
        log::debug!(
            "forge http {} done id={} sid={} req={} url='{}' status={} elapsed_ms={}",
            op,
            id,
            self.sid,
            self.req_id,
            self.safe_url,
            status,
            ms
        );
        log::info!(
            "http resp forge {} id={} sid={} req={} host={} status={} elapsed_ms={}",
            op,
            id,
            self.sid,
            self.req_id,
            self.host,
            status,
            ms
        );
    }

    pub fn log_search_done(&self, op: &str, status: u16) {
        let ms = self.elapsed_ms();
        log::debug!(
            "forge http {} done sid={} req={} status={} elapsed_ms={}",
            op,
            self.sid,
            self.req_id,
            status,
            ms
        );
        log::info!(
            "http resp forge {} sid={} req={} host={} status={} elapsed_ms={}",
            op,
            self.sid,
            self.req_id,
            self.host,
            status,
            ms
        );
    }

    /// 统一 rate_limit 入口：透传给 `crate::notify_rate_limit`。
    pub fn notify(&self, resp: &reqwest::Response, rate_host: &str) {
        crate::notify_rate_limit(rate_host, resp.headers());
    }
}
