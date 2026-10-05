use crate::models::MirrorNodeStatus;
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyTestResult {
    pub success: bool,
    pub latency_ms: u32,
    pub message: String,
}

#[tauri::command]
pub async fn test_proxy(proxy_url: Option<String>) -> crate::AppResult<ProxyTestResult> {
    let (success, latency_ms, message) =
        crate::mirror::MirrorManager::test_proxy_latency(proxy_url.as_deref()).await;
    // 结果由调用方记 info/warn：延迟毫秒可进消息，不记被测 URL 值。
    if success {
        log::info!(
            "proxy test ok sid={} latency_ms={}",
            crate::z_log::new_session_id(),
            latency_ms
        );
    } else {
        log::warn!(
            "proxy test failed latency_ms={} reason={}",
            latency_ms,
            crate::log_support::short_reason(&message)
        );
    }
    Ok(ProxyTestResult {
        success,
        latency_ms,
        message,
    })
}

#[tauri::command]
pub fn get_mirror_status(state: State<'_, AppState>) -> crate::AppResult<Vec<MirrorNodeStatus>> {
    let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    Ok(mirror.get_mirror_statuses())
}

#[tauri::command]
pub fn switch_mirror(state: State<'_, AppState>, mirror_id: String) -> crate::AppResult<bool> {
    let mut mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    let ok = mirror.set_active_mirror(&mirror_id);
    if ok {
        let db = state.db()?;
        let _ = db.set_setting("active_mirror", &mirror_id);
    }
    Ok(ok)
}

/// 趋势榜单 HTTP 直取白名单：仅 trends 三主源，防 SSRF。
/// gittrend.io 已摘除（个人实例持续 429，对用户已死）；rising/healthy 改走 doforce。
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

/// 趋势榜单 HTTP 直取（绕过 WebView CORS；Rust 侧无 CORS 概念）。
/// 10s 超时；成功返回 body 文本。错误串内含可机读标记供前端映射：
/// `upstream status {code}`（HTTP 状态）、`request timeout`（超时）、
/// `network error`（连接/DNS 等）。完整 URL 永不回显（query 可能含参）。
#[tauri::command]
pub async fn fetch_trends_text(url: String) -> Result<String, String> {
    let sid = crate::z_log::new_session_id();
    let req = crate::z_log::new_req_id();
    let parsed = check_trends_text_url(&url).map_err(|e| {
        log::warn!("trends text rejected sid={} req={} reason={}", sid, req, e);
        e
    })?;
    // 最小记录：host + path，不记 query（调用方当前无秘密参数，仍保持最小）。
    let host = parsed.host_str().unwrap_or("?").to_string();
    let path = parsed.path().to_string();
    log::debug!("trends text fetch start sid={} req={} host='{}' path='{}'", sid, req, host, path);
    let start = std::time::Instant::now();
    // 复用共享 Client（避免每次新建连接池）；10s 语义由外层 timeout 保留。
    let client = crate::shared_http_client();
    let send_fut = client
        .get(parsed)
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .send();
    let resp = match tokio::time::timeout(std::time::Duration::from_secs(10), send_fut).await {
        Err(_) => {
            let elapsed_ms = start.elapsed().as_millis();
            log::warn!(
                "trends text timeout sid={} req={} host='{}' elapsed_ms={} reason=timeout",
                sid,
                req,
                host,
                elapsed_ms
            );
            return Err("trends: request timeout: timeout".to_string());
        }
        Ok(Err(e)) => {
            let elapsed_ms = start.elapsed().as_millis();
            if e.is_timeout() {
                log::warn!(
                    "trends text timeout sid={} req={} host='{}' elapsed_ms={} reason={}",
                    sid,
                    req,
                    host,
                    elapsed_ms,
                    crate::log_support::http_err_reason(&e)
                );
                return Err(format!(
                    "trends: request timeout: {}",
                    crate::log_support::http_err_reason(&e)
                ));
            }
            log::warn!(
                "trends text network fail sid={} req={} host='{}' elapsed_ms={} reason={}",
                sid,
                req,
                host,
                elapsed_ms,
                crate::log_support::http_err_reason(&e)
            );
            return Err(format!(
                "trends: network error: {}",
                crate::log_support::http_err_reason(&e)
            ));
        }
        Ok(Ok(resp)) => resp,
    };
    let status = resp.status();
    if !status.is_success() {
        log::warn!(
            "trends text upstream sid={} req={} host='{}' status={} elapsed_ms={}",
            sid,
            req,
            host,
            status.as_u16(),
            start.elapsed().as_millis()
        );
        return Err(format!("trends: upstream status {}", status.as_u16()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| {
            log::warn!(
                "trends text read fail sid={} req={} host='{}' elapsed_ms={} reason={}",
                sid,
                req,
                host,
                start.elapsed().as_millis(),
                crate::log_support::short_reason(&e.to_string())
            );
            format!("trends: read body failed: {}", crate::log_support::short_reason(&e.to_string()))
        })?;
    // 限长 2MB：防超大 body 撑内存；超长按上游异常回错误标记（不回显 URL）。
    const MAX_TRENDS_BYTES: usize = 2 * 1024 * 1024;
    if bytes.len() > MAX_TRENDS_BYTES {
        log::warn!(
            "trends text upstream too large sid={} req={} host='{}' bytes={} elapsed_ms={}",
            sid,
            req,
            host,
            bytes.len(),
            start.elapsed().as_millis()
        );
        return Err("trends: upstream too large".to_string());
    }
    let body = String::from_utf8(bytes.to_vec()).map_err(|e| {
        log::warn!(
            "trends text decode fail sid={} req={} host='{}' elapsed_ms={} reason={}",
            sid,
            req,
            host,
            start.elapsed().as_millis(),
            crate::log_support::short_reason(&e.to_string())
        );
        format!("trends: read body failed: {}", crate::log_support::short_reason(&e.to_string()))
    })?;
    log::debug!(
        "trends text ok sid={} req={} host='{}' bytes={} elapsed_ms={}",
        sid,
        req,
        host,
        body.len(),
        start.elapsed().as_millis()
    );
    Ok(body)
}

#[cfg(test)]
mod trends_text_tests {
    use super::check_trends_text_url;

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
