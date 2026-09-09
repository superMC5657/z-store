use crate::models::DeepLinkAction;

#[tauri::command]
pub fn verify_file_signature(file_path: String) -> Result<crate::verifier::SignatureInfo, String> {
    let p = std::path::Path::new(&file_path);
    crate::verifier::AuthenticodeVerifier::extract_signature(p)
}

#[tauri::command]
pub fn register_deep_link_scheme() -> Result<bool, String> {
    crate::deeplink::register_windows_protocol()
}

#[tauri::command]
pub fn handle_deep_link(url: String) -> Result<DeepLinkAction, String> {
    crate::deeplink::DeepLinkParser::parse(&url)
        .ok_or_else(|| format!("无法识别的 Z-Store 深度链接: {}", url))
}

#[tauri::command]
pub fn get_cli_deep_link() -> Option<String> {
    for arg in std::env::args().skip(1) {
        let lower = arg.to_lowercase();
        if lower.starts_with("zstore://") {
            return Some(arg);
        }
    }
    None
}

#[tauri::command]
pub fn open_url(url: String) -> Result<bool, String> {
    let clean = url.trim();
    if !clean.starts_with("http://") && !clean.starts_with("https://") {
        return Err("仅支持打开 http/https 协议的安全链接".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", clean])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("无法调起系统默认浏览器: {}", e))?;
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(clean)
            .spawn()
            .map_err(|e| format!("无法调起系统默认浏览器: {}", e))?;
        Ok(true)
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(clean)
            .spawn()
            .map_err(|e| format!("无法调起系统默认浏览器: {}", e))?;
        Ok(true)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("当前操作系统不支持调起外部浏览器".to_string())
    }
}
