use super::constants::{ACCESS_TOKEN_URL, DEVICE_CODE_URL, OAUTH_SCOPE};
use super::types::{classify_device_poll, DeviceCodeResponse, DevicePollOutcome, DeviceStartResult};

/// 发起 Device Flow：向 GitHub 申请 `device_code` 与用户验证码。
pub async fn request_device_code(client_id: &str) -> Result<DeviceStartResult, String> {
    let timeout_sec = crate::config::get_project_config().network.api_timeout_seconds;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_sec))
        .build()
        .map_err(|e| format!("创建网络请求失败: {}", e))?;
    let resp = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "ZStore-Client/0.1.0")
        .json(&serde_json::json!({
            "client_id": client_id,
            "scope": OAUTH_SCOPE,
        }))
        .send()
        .await
        .map_err(|e| {
            format!(
                "连接 GitHub 授权服务失败: {}。如遇国内网络阻断，请检查网络设置。",
                e
            )
        })?;
    if !resp.status().is_success() {
        return Err(format!(
            "申请设备验证码失败，HTTP 状态码: {}",
            resp.status()
        ));
    }
    let body: DeviceCodeResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析设备验证码响应失败: {}", e))?;
    Ok(body.into())
}

/// 单次轮询授权结果；调用方按返回的 `interval` 节流。
pub async fn poll_device_once(
    client_id: &str,
    device_code: &str,
) -> Result<DevicePollOutcome, String> {
    let timeout_sec = crate::config::get_project_config().network.api_timeout_seconds;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_sec))
        .build()
        .map_err(|e| format!("创建网络请求失败: {}", e))?;
    let resp = client
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "ZStore-Client/0.1.0")
        .json(&serde_json::json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()
        .await
        .map_err(|e| format!("连接 GitHub 授权服务失败: {}", e))?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取授权响应失败: {}", e))?;
    Ok(classify_device_poll(&text))
}
