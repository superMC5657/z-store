use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyTestResult {
    pub success: bool,
    pub latency_ms: u32,
    pub message: String,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn test_proxy(proxy_url: Option<String>) -> crate::AppResult<ProxyTestResult> {
    let (success, latency_ms, message, status, tested_url) =
        crate::mirror::MirrorManager::test_proxy_latency(proxy_url.as_deref()).await;
    let mut ev = crate::z_log::WideEvent::new(
        "network",
        if success {
            "proxy test ok"
        } else {
            "proxy test failed"
        },
    );
    if !tested_url.is_empty() {
        ev.field("host", crate::log_support::host_of(&tested_url));
    }
    ev.field("latency_ms", latency_ms);
    if !success {
        ev.field("reason", crate::log_support::short_reason(&message));
    }
    ev.field_opt("status", status);
    if !tested_url.is_empty() {
        ev.dev_url("url", &tested_url);
    }
    if success {
        ev.info();
    } else {
        ev.warn();
    }
    Ok(ProxyTestResult {
        success,
        latency_ms,
        message,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn switch_mirror(state: State<'_, AppState>, mirror_id: String) -> crate::AppResult<bool> {
    // 自定义镜像准入校验前置（https 强制 + 域名校验）：拒绝理由直达前端；
    // set_active_mirror 内部再校验一次兜底其它调用方。
    crate::mirror::validate_custom_proxy(&mirror_id)?;
    let mut mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    let ok = mirror.set_active_mirror(&mirror_id);
    if ok {
        let db = state.db()?;
        let _ = db.set_setting("active_mirror", &mirror_id);
    }
    Ok(ok)
}

/// 趋势榜单 HTTP 直取白名单：仅允许受信任的 trends 三主源，防 SSRF。
const TRENDS_TEXT_HOSTS: [&str; 3] = ["github.com", "trend.doforce.dpdns.org", "api.github.com"];

fn check_trends_text_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "trends: bad url".to_string())?;
    if url.scheme() != "https" {
        return Err("trends: only https allowed".to_string());
    }
    let ok = url
        .host_str()
        .map(|h| TRENDS_TEXT_HOSTS.contains(&h.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    if !ok {
        return Err("trends: host not allowlisted".to_string());
    }
    Ok(url)
}

/// 截断体解码：首块截断点落在多字节字符中间时，回退到 `valid_up_to()` 边界，
/// 返回已完整的文本前缀；完整体的非法 UTF-8 不在此处理。
fn decode_truncated_utf8(buf: Vec<u8>) -> String {
    match String::from_utf8(buf) {
        Ok(text) => text,
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).unwrap_or_default()
        }
    }
}

/// 构造 `[trends]` 告警宽事件的公共骨架（带 host / dev path / started 耗时）；
/// 经系统代理回退的请求附 `via=proxy`，保证一次抓取只落一行。
fn trends_warn_event(
    action: &str,
    host: &str,
    path: &str,
    via: TrendVia,
    started: std::time::Instant,
) -> crate::z_log::WideEvent {
    let mut ev = crate::z_log::WideEvent::new("trends", action).with_started(started);
    ev.field("host", host).dev("path", path);
    if via == TrendVia::Proxy {
        ev.field("via", via);
    }
    ev
}

/// doforce 直连首跳超时（短超时，失败即交给系统代理重试）。
const TREND_DIRECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// doforce 经系统代理重试超时。
const TREND_PROXY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// doforce 直连 Client：`trend.doforce.dpdns.org` 入 per-client `no_proxy`，无任何认证头。
fn trend_direct_client() -> reqwest::Client {
    static SLOT: crate::proxy::ClientSlot = crate::proxy::ClientSlot::new();
    let snap = crate::proxy::current_proxy_snapshot();
    let extra = [crate::proxy::TREND_HOST.to_string()];
    SLOT.get_or_build(&snap.signature(&extra), || {
        let builder = reqwest::Client::builder()
            .connect_timeout(TREND_DIRECT_TIMEOUT)
            // 整体超时覆盖读 body：外层 tokio 超时只包 `send()`。
            .timeout(TREND_DIRECT_TIMEOUT)
            .user_agent(crate::forge::http::BROWSER_UA_VALUE);
        crate::proxy::apply_proxy_snapshot(builder, &snap, &extra)
            .build()
            .map_err(|e| e.to_string())
    })
    // 兜底同为显式直连 + 整体超时，不回落 reqwest 自行读取 OS 代理。
    .unwrap_or_else(|_| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(TREND_DIRECT_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}

/// 趋势抓取实际走的通道（日志 `via` 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrendVia {
    Direct,
    Proxy,
}

impl std::fmt::Display for TrendVia {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TrendVia::Direct => "direct",
            TrendVia::Proxy => "proxy",
        })
    }
}

enum TrendSend {
    Resp(reqwest::Response),
    Timeout,
    Failed(reqwest::Error),
}

impl TrendSend {
    /// 直连首跳是否应交给系统代理重试：超时、传输错误或 5xx；2xx 与 4xx（含 429）不重试。
    fn should_fallback(&self) -> bool {
        match self {
            TrendSend::Resp(r) => r.status().is_server_error(),
            TrendSend::Timeout | TrendSend::Failed(_) => true,
        }
    }
}

async fn send_trends_once(
    client: &reqwest::Client,
    url: &reqwest::Url,
    timeout: std::time::Duration,
) -> TrendSend {
    let send_fut = client
        .get(url.clone())
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .send();
    match tokio::time::timeout(timeout, send_fut).await {
        Err(_) => TrendSend::Timeout,
        Ok(Err(e)) => TrendSend::Failed(e),
        Ok(Ok(resp)) => TrendSend::Resp(resp),
    }
}

/// 直连优先、可选代理回退：`proxied` 为 `Some` 且首跳应回退时重试一次，返回 `(结果, via)`。
async fn send_direct_first(
    direct: &reqwest::Client,
    proxied: Option<&reqwest::Client>,
    url: &reqwest::Url,
    direct_timeout: std::time::Duration,
    proxy_timeout: std::time::Duration,
) -> (TrendSend, TrendVia) {
    let first = send_trends_once(direct, url, direct_timeout).await;
    match proxied {
        Some(client) if first.should_fallback() => {
            (send_trends_once(client, url, proxy_timeout).await, TrendVia::Proxy)
        }
        _ => (first, TrendVia::Direct),
    }
}

/// 趋势榜单 HTTP 直取（绕过 WebView CORS；Rust 侧无 CORS 概念）。
/// github.com / api.github.com 单跳 10s；doforce 直连 5s + 系统代理回退 6s。成功返回 body 文本。错误串内含可机读标记供前端映射：
/// `upstream status {code}`（HTTP 状态）、`request timeout`（超时）、
/// `network error`（连接/DNS 等）。完整 URL 永不回显（query 可能含参）。
#[tauri::command]
pub async fn fetch_trends_text(url: String) -> Result<String, String> {
    let start = std::time::Instant::now();
    let parsed = check_trends_text_url(&url).inspect_err(|e| {
        let mut ev = crate::z_log::WideEvent::new("trends", "fetch rejected").with_started(start);
        ev.field("reason", e);
        ev.warn();
    })?;
    let host = parsed.host_str().unwrap_or("?").to_string();
    let path = parsed.path().to_string();
    let (outcome, via) = if host.eq_ignore_ascii_case(crate::proxy::TREND_HOST) {
        // doforce：直连优先（不耗代理流量），失败且存在系统代理时经代理重试一次。
        let proxied = crate::proxy::current_proxy_snapshot()
            .has_proxy()
            .then(crate::shared_http_client);
        send_direct_first(
            &trend_direct_client(),
            proxied.as_ref(),
            &parsed,
            TREND_DIRECT_TIMEOUT,
            TREND_PROXY_TIMEOUT,
        )
        .await
    } else {
        // 共享 API 池（跟随系统代理）；10s 语义由外层 timeout 保留。
        let outcome = send_trends_once(
            &crate::shared_http_client(),
            &parsed,
            std::time::Duration::from_secs(10),
        )
        .await;
        (outcome, TrendVia::Direct)
    };
    let resp = match outcome {
        TrendSend::Timeout => {
            trends_warn_event("fetch timeout", &host, &path, via, start).warn();
            return Err("trends: request timeout: timeout".to_string());
        }
        TrendSend::Failed(e) => {
            let reason = crate::log_support::http_err_reason(&e);
            let action = if e.is_timeout() {
                "fetch timeout"
            } else {
                "fetch failed"
            };
            let mut ev = trends_warn_event(action, &host, &path, via, start);
            ev.field("reason", &reason);
            ev.warn();
            if e.is_timeout() {
                return Err(format!("trends: request timeout: {}", reason));
            }
            return Err(format!("trends: network error: {}", reason));
        }
        TrendSend::Resp(resp) => resp,
    };
    let status = resp.status();
    if !status.is_success() {
        // 429 透传 Retry-After（FE doforceRetryDelayMs 按秒/HTTP-date 或 retry_after_ms 毫秒兑现）。
        if status.as_u16() == 429 {
            let raw_retry_after = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .trim()
                .to_string();
            let retry_after_ms_opt: Option<u64> = raw_retry_after
                .parse::<u64>()
                .ok()
                .map(|s| s.saturating_mul(1000));
            let mut ev = trends_warn_event("fetch rate-limited", &host, &path, via, start);
            ev.field("status", 429)
                .field_opt("retry_after_ms", retry_after_ms_opt);
            if retry_after_ms_opt.is_none() && !raw_retry_after.is_empty() {
                ev.dev("retry_after", &raw_retry_after);
            }
            ev.warn();
            return match (raw_retry_after.is_empty(), retry_after_ms_opt) {
                (true, _) => Err("trends: upstream status 429".to_string()),
                (false, Some(ms)) => Err(format!(
                    "trends: upstream status 429 retry-after: {} retry_after_ms={}",
                    raw_retry_after, ms
                )),
                (false, None) => Err(format!(
                    "trends: upstream status 429 retry-after: {}",
                    raw_retry_after
                )),
            };
        }
        let mut ev = trends_warn_event("fetch failed", &host, &path, via, start);
        ev.field("status", status.as_u16());
        ev.warn();
        return Err(format!("trends: upstream status {}", status.as_u16()));
    }
    // 流式读取并截断至 2MB（D9 截断语义）：避免全量缓冲超大响应体，
    // 超限即停止读取并返回前 2MB（前端对截断 body 具备解析兜底）。
    use futures_util::StreamExt;
    const MAX_TRENDS_BYTES: usize = 2 * 1024 * 1024;
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut truncated = false;
    let mut stream = resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| {
            let reason = crate::log_support::short_reason(&e.to_string());
            let mut ev = trends_warn_event("read failed", &host, &path, via, start);
            ev.field("reason", &reason);
            ev.warn();
            format!("trends: read body failed: {}", reason)
        })?;
        let remaining = MAX_TRENDS_BYTES - buf.len();
        if chunk.len() > remaining {
            buf.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    if truncated {
        let mut ev = trends_warn_event("body truncated", &host, &path, via, start);
        ev.field("bytes", buf.len());
        ev.warn();
    }
    let body = if truncated {
        decode_truncated_utf8(buf)
    } else {
        String::from_utf8(buf).map_err(|e| {
            let reason = crate::log_support::short_reason(&e.to_string());
            let mut ev = trends_warn_event("decode failed", &host, &path, via, start);
            ev.field("reason", &reason);
            ev.warn();
            format!("trends: read body failed: {}", reason)
        })?
    };
    // 经系统代理救活的抓取记一行 info（失败/截断已由上方唯一告警行携带 `via`）。
    if via == TrendVia::Proxy && !truncated {
        let mut ev = crate::z_log::WideEvent::new("trends", "fetch ok").with_started(start);
        ev.field("host", &host)
            .field("via", via)
            .field("bytes", body.len())
            .dev("path", &path);
        ev.info();
    }
    Ok(body)
}

#[cfg(test)]
mod trends_fallback_tests {
    use super::{send_direct_first, TrendSend, TrendVia};
    use crate::test_support::{dead_addr, serve, Reply};
    use std::time::Duration;

    fn direct_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn proxy_client(proxy: &str) -> reqwest::Client {
        reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(proxy).unwrap())
            .build()
            .unwrap()
    }

    /// 直连目标回 `target_status`，代理恒回 200 `via-proxy`；返回 `(状态, body, via)`。
    async fn run_against(url: String, with_proxy: bool) -> (Option<u16>, String, TrendVia) {
        let proxy = serve(|_| Reply::ok("via-proxy")).await;
        let url = reqwest::Url::parse(&url).unwrap();
        let proxied = with_proxy.then(|| proxy_client(&proxy.base));
        let (outcome, via) = send_direct_first(
            &direct_client(),
            proxied.as_ref(),
            &url,
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .await;
        match outcome {
            TrendSend::Resp(r) => {
                let s = r.status().as_u16();
                (Some(s), r.text().await.unwrap_or_default(), via)
            }
            _ => (None, String::new(), via),
        }
    }

    async fn run(target_status: &'static str, with_proxy: bool) -> (Option<u16>, String, TrendVia) {
        let target = serve(move |_| Reply::status(target_status).body("direct")).await;
        run_against(format!("{}/repo", target.base), with_proxy).await
    }

    #[tokio::test]
    async fn retries_via_proxy_on_5xx_when_proxy_active() {
        let (status, body, via) = run("502 Bad Gateway", true).await;
        assert_eq!((status, body.as_str(), via), (Some(200), "via-proxy", TrendVia::Proxy));
    }

    #[tokio::test]
    async fn no_retry_on_success_or_429() {
        let (status, body, via) = run("200 OK", true).await;
        assert_eq!((status, body.as_str(), via), (Some(200), "direct", TrendVia::Direct));
        let (status, _, via) = run("429 Too Many Requests", true).await;
        assert_eq!((status, via), (Some(429), TrendVia::Direct));
    }

    #[tokio::test]
    async fn no_retry_without_system_proxy() {
        let (status, _, via) = run("503 Service Unavailable", false).await;
        assert_eq!((status, via), (Some(503), TrendVia::Direct));
    }

    #[tokio::test]
    async fn retries_via_proxy_on_transport_error() {
        // 直连首跳必然连接失败。
        let (status, body, via) = run_against(format!("http://{}/repo", dead_addr()), true).await;
        assert_eq!((status, body.as_str(), via), (Some(200), "via-proxy", TrendVia::Proxy));
    }
}

#[cfg(test)]
mod trends_text_tests {
    use super::{check_trends_text_url, decode_truncated_utf8};

    #[test]
    fn truncation_cut_inside_multibyte_char_returns_valid_prefix() {
        // "ab€cd"：€ 占 3 字节，截到第 4 字节即落在 € 中间。
        let full = "ab€cd".as_bytes();
        let cut = &full[..4];
        assert!(std::str::from_utf8(cut).is_err());
        assert_eq!(decode_truncated_utf8(cut.to_vec()), "ab");
    }

    #[test]
    fn truncation_on_char_boundary_keeps_whole_text() {
        let full = "ab€cd";
        assert_eq!(decode_truncated_utf8(full.as_bytes()[..5].to_vec()), "ab€");
    }

    #[test]
    fn allowlist_accepts_trends_origins() {
        assert!(check_trends_text_url("https://github.com/trending?since=daily").is_ok());
        assert!(check_trends_text_url("https://trend.doforce.dpdns.org/repo").is_ok());
        assert!(check_trends_text_url("https://api.github.com/search/repositories?q=x").is_ok());
    }

    #[test]
    fn allowlist_rejects_non_https_unknown_and_spoofed_hosts() {
        assert!(check_trends_text_url("http://github.com/trending").is_err());
        assert!(check_trends_text_url("https://evil.example.com/x").is_err());
        assert!(check_trends_text_url("https://github.com.evil.example.com/").is_err());
        assert!(check_trends_text_url("https://apigithub.com/").is_err());
        assert!(check_trends_text_url("https://gittrend.io/api/trending").is_err());
        assert!(check_trends_text_url("not a url").is_err());
    }
}
