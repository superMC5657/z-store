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
pub async fn test_proxy(proxy_url: Option<String>) -> Result<ProxyTestResult, String> {
    let (success, latency_ms, message) =
        crate::mirror::MirrorManager::test_proxy_latency(proxy_url.as_deref()).await;
    // 结果由调用方记 info/warn：延迟毫秒可进消息，不记被测 URL 值。
    if success {
        log::info!("proxy test ok latency_ms={}", latency_ms);
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
pub fn get_mirror_status(state: State<'_, AppState>) -> Result<Vec<MirrorNodeStatus>, String> {
    let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    Ok(mirror.get_mirror_statuses())
}

#[tauri::command]
pub fn switch_mirror(state: State<'_, AppState>, mirror_id: String) -> Result<bool, String> {
    let mut mirror = state.mirror.lock().map_err(|e| e.to_string())?;
    let ok = mirror.set_active_mirror(&mirror_id);
    if ok {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let _ = db.set_setting("active_mirror", &mirror_id);
    }
    Ok(ok)
}

#[tauri::command]
pub async fn ping_mirrors(state: State<'_, AppState>) -> Result<Vec<MirrorNodeStatus>, String> {
    let proxy = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.get_proxy_url()
    };
    let (_success, latency, _msg) =
        crate::mirror::MirrorManager::test_proxy_latency(proxy.as_deref()).await;
    log::debug!("proxy ping done latency_ms={}", latency);
    let mut statuses = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.get_mirror_statuses()
    };
    for s in &mut statuses {
        if s.is_active {
            s.latency_ms = latency;
        }
    }
    Ok(statuses)
}
