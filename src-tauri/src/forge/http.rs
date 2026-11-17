use crate::proxy::{ClientSlot, ProxySnapshot};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};

/// forge 内复用的 UA / Accept 常量：避免 9 处 client+header 重复手写。
/// SSOT：所有 UA / Accept 字面量只在此一处定义，其余模块经别名或 `api_headers`/`preset_headers` 复用。
pub const USER_AGENT_VALUE: &str = concat!("ZStore-Client/", env!("CARGO_PKG_VERSION"));
pub const GITHUB_ACCEPT_VALUE: &str = "application/vnd.github.v3+json";
pub const JSON_ACCEPT_VALUE: &str = "application/json";
/// 图标/CDN 专用：浏览器 UA + image/* Accept，与 API client 严格隔离（见 `new_icon_client`）。
pub const BROWSER_UA_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
pub const ICON_ACCEPT_VALUE: &str =
    "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/// forge 内两种 Authorization 前缀：GitHub/GitLab 用 Bearer，Gitea/Forgejo 用 token。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScheme {
    Bearer,
    Token,
}

/// 表驱动 API 预设：Accept + UA 成对收敛，调用方只选预设不手写字面量。
/// - `GithubApi`：GitHub v3 Accept + ZStore UA（`token`/`Bearer` 经 `AuthScheme` 区分）；
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

/// 连接池种类（D5 物理隔离）：决定重定向策略与缺省 UA，同池参数之外语义不混用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PoolKind {
    /// GitHub/GitLab/Gitea API、OAuth、趋势：reqwest 缺省重定向 + ZStore 缺省 UA（请求级 header 覆盖）。
    Api,
    /// 图标/CDN：有限重定向 10 次，无鉴权，UA 由请求级 `icon_headers` 提供。
    Icon,
}

/// 单一 Client 构造点（本文件内唯一构造器），经 `new_api_client` / `new_icon_client` 分流。
fn build_client(
    timeout_secs: u64,
    kind: PoolKind,
    snap: &ProxySnapshot,
) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .connect_timeout(std::time::Duration::from_secs(5))
        .tcp_keepalive(std::time::Duration::from_secs(60))
        .pool_max_idle_per_host(20)
        .pool_idle_timeout(std::time::Duration::from_secs(90));
    let builder = match kind {
        PoolKind::Api => builder.user_agent(USER_AGENT_VALUE),
        PoolKind::Icon => builder.redirect(reqwest::redirect::Policy::limited(10)),
    };
    let builder = crate::proxy::apply_proxy_snapshot(builder, snap, &[]);
    builder.build().map_err(|e| e.to_string())
}

/// API 池（GitHub/GitLab/Gitea API、OAuth、趋势；`crate::shared_http_client` 同池）。
static SHARED_API: ClientSlot = ClientSlot::new();
/// 图标/CDN 池（无鉴权，与 API 池物理隔离）。
static SHARED_ICON: ClientSlot = ClientSlot::new();

fn pooled_client(
    slot: &ClientSlot,
    snap: &ProxySnapshot,
    timeout_secs: u64,
    kind: PoolKind,
) -> Result<reqwest::Client, String> {
    let key = format!("{}|{}", timeout_secs, snap.signature(&[]));
    slot.get_or_build(&key, || build_client(timeout_secs, kind, snap))
}

/// API 池 Client：调用方传入 `api_timeout_seconds`。代理签名与超时不变时复用同一连接池，
/// 系统代理开启/关闭/切换后下一次调用自动重建。
pub fn new_api_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    pooled_client(
        &SHARED_API,
        &crate::proxy::current_proxy_snapshot(),
        timeout_secs,
        PoolKind::Api,
    )
}

/// 图标/CDN 专用 Client：同 timeout 语义 + `redirect limited(10)`，绝不与 API client 混用。
pub fn new_icon_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    pooled_client(
        &SHARED_ICON,
        &crate::proxy::current_proxy_snapshot(),
        timeout_secs,
        PoolKind::Icon,
    )
}

/// API 池 Client（不可失败版）：构建失败时退为仍按快照挂代理的兜底 Client。
pub fn api_client(timeout_secs: u64) -> reqwest::Client {
    new_api_client(timeout_secs).unwrap_or_else(|_| {
        crate::proxy::fallback_client(&crate::proxy::current_proxy_snapshot(), &[])
    })
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
    headers_with_ua(
        preset.user_agent(),
        preset.accept(),
        effective_token,
        scheme,
    )
}

/// 图标请求头便捷：浏览器 UA + `image/*` Accept，无鉴权。
pub fn icon_headers() -> HeaderMap {
    preset_headers(ApiPreset::IconCdn, None, AuthScheme::Bearer)
}

/// 429 `Retry-After` 退避口径：秒值转毫秒并封顶 60s，缺失/非数字取 5s 缺省。
/// 只解析秒值形态；HTTP-date 形态无日期解析依赖，按缺省处理。
pub(crate) fn retry_after_delay_ms(headers: &HeaderMap) -> u64 {
    const RETRY_AFTER_MAX_MS: u64 = 60_000;
    const RETRY_AFTER_DEFAULT_MS: u64 = 5_000;
    headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|secs| secs.saturating_mul(1000).min(RETRY_AFTER_MAX_MS))
        .unwrap_or(RETRY_AFTER_DEFAULT_MS)
}

/// D7 有限重试的 5xx / 传输错误退避阶梯：最多重试 2 次（200ms → 800ms）。
pub(crate) const D7_RETRY_BACKOFF_MS: [u64; 2] = [200, 800];

/// D7 GET 结果：最终响应（或最后一次传输错误）与实际重试次数。
pub(crate) struct D7Get {
    pub result: Result<reqwest::Response, reqwest::Error>,
    pub retries: u8,
}

/// D7 共享 GET 重试执行器（GitHub / GitLab / Gitea 共用）：
/// - 仅重试传输错误（`is_timeout` / `is_connect`）、429 与 5xx，最多 [`D7_RETRY_BACKOFF_MS`] 次；
/// - 429 按 `Retry-After` 退避（见 [`retry_after_delay_ms`]），5xx / 传输错误按 200ms → 800ms 退避；
/// - 传输错误先重探系统代理，签名变化（用户刚开启/关闭代理）即改用重建后的 API 池重发；
/// - 其余状态（含 401 / 404 / 304）原样返回，交由调用方判定。
///
/// `on_response` 对每一轮响应调用一次（含被重试的轮次），供调用方上报限流头。
/// 调用方传入的均为 API 池 Client。
pub(crate) async fn get_with_d7_retry_observed<F>(
    client: &reqwest::Client,
    url: &str,
    headers: &HeaderMap,
    mut on_response: F,
) -> D7Get
where
    F: FnMut(&reqwest::Response),
{
    let mut attempt: usize = 0;
    let mut active = client.clone();
    loop {
        match active.get(url).headers(headers.clone()).send().await {
            Ok(resp) => {
                on_response(&resp);
                let status = resp.status();
                let retryable = status.as_u16() == 429 || status.is_server_error();
                if retryable && attempt < D7_RETRY_BACKOFF_MS.len() {
                    let delay_ms = if status.as_u16() == 429 {
                        retry_after_delay_ms(resp.headers())
                    } else {
                        D7_RETRY_BACKOFF_MS[attempt]
                    };
                    drop(resp);
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    attempt += 1;
                    continue;
                }
                return D7Get {
                    result: Ok(resp),
                    retries: attempt as u8,
                };
            }
            Err(e) => {
                if (e.is_timeout() || e.is_connect()) && attempt < D7_RETRY_BACKOFF_MS.len() {
                    if crate::proxy::refresh_after_transport_error().await {
                        if let Ok(fresh) = new_api_client(
                            crate::config::get_project_config()
                                .network
                                .api_timeout_seconds,
                        ) {
                            active = fresh;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(
                        D7_RETRY_BACKOFF_MS[attempt],
                    ))
                    .await;
                    attempt += 1;
                    continue;
                }
                crate::proxy::note_transport_error(&e);
                return D7Get {
                    result: Err(e),
                    retries: attempt as u8,
                };
            }
        }
    }
}

/// D7 GET 便捷入口（不观察中间响应）：GitLab / Gitea Provider 使用。
pub(crate) async fn get_with_d7_retry(
    client: &reqwest::Client,
    url: &str,
    headers: &HeaderMap,
) -> Result<reqwest::Response, reqwest::Error> {
    get_with_d7_retry_observed(client, url, headers, |_| {})
        .await
        .result
}

/// 有界响应体读取失败原因。
#[derive(Debug)]
pub(crate) enum BodyReadError {
    /// 声明长度或已累积字节超过上限。
    TooLarge,
    Transport(reqwest::Error),
}

impl std::fmt::Display for BodyReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BodyReadError::TooLarge => f.write_str("response body too large"),
            BodyReadError::Transport(e) => write!(f, "{e}"),
        }
    }
}

/// 有界流式读取响应体：`Content-Length` 声明超过 `cap` 直接拒绝；无长度声明的 chunked
/// 响应逐块累积，超过 `cap` 即中断，不全量缓冲异常超大响应。
pub(crate) async fn read_body_capped(
    resp: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, BodyReadError> {
    use futures_util::StreamExt;
    if resp.content_length().is_some_and(|len| len > cap as u64) {
        return Err(BodyReadError::TooLarge);
    }
    let initial = resp
        .content_length()
        .map(|len| len as usize)
        .unwrap_or(0)
        .min(cap);
    let mut buf = Vec::with_capacity(initial);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(BodyReadError::Transport)?;
        if buf.len().saturating_add(chunk.len()) > cap {
            return Err(BodyReadError::TooLarge);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// 统一 HTTP 限流上报跨度（只负责 `x-ratelimit` 上报，不直接刷屏打日志）。
pub struct HttpSpan;

impl HttpSpan {
    pub fn start() -> Self {
        Self
    }

    /// 统一 rate_limit 入口：透传给 `crate::notify_rate_limit`。
    pub fn notify(&self, resp: &reqwest::Response, rate_host: &str) {
        crate::notify_rate_limit(rate_host, resp.headers());
    }
}

#[cfg(test)]
mod tests {
    use super::{get_with_d7_retry_observed, pooled_client, retry_after_delay_ms, PoolKind};
    use crate::proxy::{ClientSlot, ProxySnapshot};
    use crate::test_support::proxied_snapshot;

    #[test]
    fn pools_rebuild_on_proxy_signature_change_and_reuse_otherwise() {
        let direct = ProxySnapshot::direct();
        let proxied = proxied_snapshot("http://127.0.0.1:7890");
        for kind in [PoolKind::Api, PoolKind::Icon] {
            let slot = ClientSlot::new();
            pooled_client(&slot, &direct, 10, kind).unwrap();
            pooled_client(&slot, &direct, 10, kind).unwrap();
            assert_eq!(slot.build_count(), 1, "identical signature must reuse");
            pooled_client(&slot, &proxied, 10, kind).unwrap();
            assert_eq!(slot.build_count(), 2, "proxy turned on must rebuild");
            pooled_client(&slot, &proxied, 10, kind).unwrap();
            assert_eq!(slot.build_count(), 2);
            pooled_client(&slot, &direct, 10, kind).unwrap();
            assert_eq!(slot.build_count(), 3, "proxy turned off must rebuild");
        }
    }

    #[test]
    fn retry_after_delay_ms_clamps_and_defaults() {
        let h = |v: &str| {
            let mut map = reqwest::header::HeaderMap::new();
            map.insert(
                "retry-after",
                reqwest::header::HeaderValue::from_str(v).unwrap(),
            );
            map
        };
        assert_eq!(retry_after_delay_ms(&h("2")), 2_000);
        assert_eq!(retry_after_delay_ms(&h("999")), 60_000);
        assert_eq!(
            retry_after_delay_ms(&reqwest::header::HeaderMap::new()),
            5_000
        );
        assert_eq!(retry_after_delay_ms(&h("abc")), 5_000);
        assert_eq!(retry_after_delay_ms(&h(" ")), 5_000);
    }

    /// 按序回放状态码的测试服务（超出序列恒回最后一个）。
    async fn serve_statuses(statuses: &'static [&'static str]) -> crate::test_support::TestServer {
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        crate::test_support::serve(move |_| {
            let i = n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            crate::test_support::Reply::status(statuses[i.min(statuses.len() - 1)]).body("{}")
        })
        .await
    }

    #[tokio::test]
    async fn d7_retries_5xx_twice_then_returns_success() {
        let srv = serve_statuses(&["503 Service Unavailable", "502 Bad Gateway", "200 OK"]).await;
        let client = reqwest::Client::new();
        let mut seen = 0;
        let got = get_with_d7_retry_observed(
            &client,
            &format!("{}/x", srv.base),
            &reqwest::header::HeaderMap::new(),
            |_| seen += 1,
        )
        .await;
        assert_eq!(got.result.unwrap().status().as_u16(), 200);
        assert_eq!(got.retries, 2);
        assert_eq!(seen, 3, "every round is observed for rate-limit reporting");
        assert_eq!(srv.hits(), 3);
    }

    #[tokio::test]
    async fn d7_gives_up_after_two_retries_and_never_retries_4xx() {
        let srv = serve_statuses(&["500 Internal Server Error"]).await;
        let client = reqwest::Client::new();
        let got = get_with_d7_retry_observed(
            &client,
            &format!("{}/x", srv.base),
            &reqwest::header::HeaderMap::new(),
            |_| {},
        )
        .await;
        assert_eq!(got.result.unwrap().status().as_u16(), 500);
        assert_eq!(got.retries, 2);
        assert_eq!(srv.hits(), 3);

        for status in ["404 Not Found", "401 Unauthorized", "304 Not Modified"] {
            let srv =
                crate::test_support::serve(move |_| crate::test_support::Reply::status(status))
                    .await;
            let got = get_with_d7_retry_observed(
                &client,
                &format!("{}/x", srv.base),
                &reqwest::header::HeaderMap::new(),
                |_| {},
            )
            .await;
            assert_eq!(got.retries, 0, "{status} must not be retried");
            assert_eq!(srv.hits(), 1);
        }
    }

    #[tokio::test]
    async fn read_body_capped_rejects_oversized_bodies() {
        let srv =
            crate::test_support::serve(|_| crate::test_support::Reply::ok(vec![7u8; 64])).await;
        let client = reqwest::Client::new();
        let get = || client.get(format!("{}/x", srv.base)).send();
        let ok = super::read_body_capped(get().await.unwrap(), 64)
            .await
            .unwrap();
        assert_eq!(ok.len(), 64);
        assert!(matches!(
            super::read_body_capped(get().await.unwrap(), 63).await,
            Err(super::BodyReadError::TooLarge)
        ));
    }
}
