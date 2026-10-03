//! OAuth 请求段收敛（B2-G8）：Star/Device 共用发送与 401/403 映射。
//! 不碰 Header 常量（G2）与 ETag 日志（G4），仅收敛请求发送样板。

/// 带认证通用请求：Star 三函数共用（send + rate_limit 上报收敛于此）。
pub async fn authed_req(
    method: reqwest::Method,
    url: &str,
    token: &str,
    body: Option<serde_json::Value>,
    send_err: &str,
) -> Result<reqwest::Response, String> {
    let mut req = crate::shared_http_client()
        .request(method.clone(), url)
        .headers(super::star::auth_headers(token)?);
    if method == reqwest::Method::PUT && body.is_none() {
        req = req.header("Content-Length", "0");
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("{}: {}", send_err, e))?;
    crate::notify_rate_limit("github.com", resp.headers());
    Ok(resp)
}

/// 401/403 统一映射：文案由调用方传入，不可硬合并（各 op 的 403 语义不同）。
/// 命中返回 Err(文案)，未命中返回 Ok(()) 由调用方继续处理其他状态码。
pub fn map_auth_status(
    code: u16,
    op_ctx: &str,
    unauthorized_msg: &str,
    forbidden_msg: &str,
) -> Result<(), String> {
    if code == 401 {
        crate::check_auth_expired(code, op_ctx);
        return Err(unauthorized_msg.to_string());
    }
    if code == 403 {
        log::warn!("oauth forbidden status=403 {}", op_ctx);
        return Err(forbidden_msg.to_string());
    }
    Ok(())
}

/// Device Flow 共用 POST：JsonApi 预设 + json body 收敛于此，调用方自行映射 transport 错误以保留文案差异。
pub async fn post_oauth_json(
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, reqwest::Error> {
    crate::shared_http_client()
        .post(url)
        .headers(crate::forge::http::preset_headers(
            crate::forge::http::ApiPreset::JsonApi,
            None,
            crate::forge::http::AuthScheme::Bearer,
        ))
        .json(body)
        .send()
        .await
}
