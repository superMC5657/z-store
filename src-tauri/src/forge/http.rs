use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};

/// forge 内复用的 UA / Accept 常量：避免 9 处 client+header 重复手写。
pub const USER_AGENT_VALUE: &str = "ZStore-Client/0.1.0";
pub const GITHUB_ACCEPT_VALUE: &str = "application/vnd.github.v3+json";
pub const JSON_ACCEPT_VALUE: &str = "application/json";

/// forge 内两种 Authorization 前缀：GitHub/GitLab 用 Bearer，Gitea/Forgejo 用 token。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScheme {
    Bearer,
    Token,
}

/// 复用 timeout 取参的 Client 构造：调用方传入 `api_timeout_seconds` 即可。
pub fn new_api_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

/// 统一 header 组装：UA + Accept + 可选 token。
pub fn api_headers(accept: &str, token: Option<&str>, scheme: AuthScheme) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
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
