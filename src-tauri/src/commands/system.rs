use crate::models::DeepLinkAction;

#[tauri::command]
pub fn register_deep_link_scheme() -> crate::AppResult<bool> {
    Ok(crate::deeplink::register_windows_protocol()?)
}

#[tauri::command]
pub fn handle_deep_link(url: String) -> crate::AppResult<DeepLinkAction> {
    crate::deeplink::DeepLinkParser::parse(&url).ok_or_else(|| {
        // 失败 warn：只记首行短原因，不记完整 query / token。
        log::warn!(
            "deeplink parse failed reason={}",
            crate::log_support::short_reason(&url)
        );
        crate::AppError::new(format!("无法识别的 Z-Store 深度链接: {}", url))
    })
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

/// 拉起外部默认浏览器打开安全链接（http/https）。
pub fn open_external_url(url: &str) -> Result<bool, String> {
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

/// 在系统文件管理器中打开路径或高亮文件。
pub fn open_desktop_path(path: &std::path::Path, select_file: bool) -> Result<bool, String> {
    if !path.exists() {
        return Err(format!("路径不存在: {}", path.to_string_lossy()));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if select_file && path.is_file() {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("无法打开文件所在目录: {}", e))?;
        } else {
            let dir = if path.is_file() {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            std::process::Command::new("explorer")
                .arg(dir)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("无法打开目录: {}", e))?;
        }
        Ok(true)
    }
    #[cfg(target_os = "macos")]
    {
        if select_file {
            std::process::Command::new("open")
                .args(["-R", &path.to_string_lossy().to_string()])
                .spawn()
                .map_err(|e| format!("无法在访达中定位文件: {}", e))?;
        } else {
            let dir = if path.is_file() {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            std::process::Command::new("open")
                .arg(dir)
                .spawn()
                .map_err(|e| format!("无法打开目录: {}", e))?;
        }
        return Ok(true);
    }
    #[cfg(target_os = "linux")]
    {
        let dir = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {}", e))?;
        return Ok(true);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (path, select_file);
        Err("当前操作系统不支持打开本地目录".to_string())
    }
}

#[tauri::command]
pub fn open_url(url: String) -> crate::AppResult<bool> {
    Ok(open_external_url(&url)?)
}
