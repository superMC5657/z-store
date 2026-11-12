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

/// 构造 `[trends]` 告警宽事件的公共骨架（带 host / dev path / started 耗时）。
fn trends_warn_event(
    action: &str,
    host: &str,
    path: &str,
    started: std::time::Instant,
) -> crate::z_log::WideEvent {
    let mut ev = crate::z_log::WideEvent::new("trends", action).with_started(started);
    ev.field("host", host).dev("path", path);
    ev
}

/// 趋势榜单 HTTP 直取（绕过 WebView CORS；Rust 侧无 CORS 概念）。
/// 10s 超时；成功返回 body 文本。错误串内含可机读标记供前端映射：
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
    // 复用共享 Client（避免每次新建连接池）；10s 语义由外层 timeout 保留。
    let client = crate::shared_http_client();
    let send_fut = client
        .get(parsed)
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .send();
    let resp = match tokio::time::timeout(std::time::Duration::from_secs(10), send_fut).await {
        Err(_) => {
            trends_warn_event("fetch timeout", &host, &path, start).warn();
            return Err("trends: request timeout: timeout".to_string());
        }
        Ok(Err(e)) => {
            let reason = crate::log_support::http_err_reason(&e);
            let action = if e.is_timeout() {
                "fetch timeout"
            } else {
                "fetch failed"
            };
            let mut ev = trends_warn_event(action, &host, &path, start);
            ev.field("reason", &reason);
            ev.warn();
            if e.is_timeout() {
                return Err(format!("trends: request timeout: {}", reason));
            }
            return Err(format!("trends: network error: {}", reason));
        }
        Ok(Ok(resp)) => resp,
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
            let mut ev = trends_warn_event("fetch rate-limited", &host, &path, start);
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
        let mut ev = trends_warn_event("fetch failed", &host, &path, start);
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
            let mut ev = trends_warn_event("read failed", &host, &path, start);
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
        let mut ev = trends_warn_event("body truncated", &host, &path, start);
        ev.field("bytes", buf.len());
        ev.warn();
    }
    let body = if truncated {
        decode_truncated_utf8(buf)
    } else {
        String::from_utf8(buf).map_err(|e| {
            let reason = crate::log_support::short_reason(&e.to_string());
            let mut ev = trends_warn_event("decode failed", &host, &path, start);
            ev.field("reason", &reason);
            ev.warn();
            format!("trends: read body failed: {}", reason)
        })?
    };
    Ok(body)
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
