use crate::models::DeepLinkAction;

#[tauri::command]
pub fn register_deep_link_scheme() -> crate::AppResult<bool> {
    Ok(crate::deeplink::register_windows_protocol()?)
}

#[tauri::command]
pub fn handle_deep_link(url: String) -> crate::AppResult<DeepLinkAction> {
    crate::deeplink::DeepLinkParser::parse(&url).ok_or_else(|| {
        // 失败 warn：只记首行短原因，不记完整 query / token。
        let mut ev = crate::z_log::WideEvent::new("app", "deeplink parse failed");
        ev.field("reason", crate::log_support::short_reason(&url));
        ev.warn();
        crate::AppError::new(format!("无法识别的 ZStore 深度链接: {}", url))
    })
}

fn find_cli_deep_link_in_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().skip(1).find_map(|arg| {
        let s = arg.as_ref();
        s.get(..9)
            .is_some_and(|p| p.eq_ignore_ascii_case("zstore://"))
            .then(|| s.to_string())
    })
}

/// 进程级 CLI 深链槽：启动参数只消费一次（`take()` 后置空），防止前端 StrictMode/重渲染/刷新重复触发。
static CLI_DEEP_LINK_SLOT: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

#[tauri::command]
pub fn get_cli_deep_link() -> Option<String> {
    let slot = CLI_DEEP_LINK_SLOT
        .get_or_init(|| std::sync::Mutex::new(find_cli_deep_link_in_args(std::env::args())));
    slot.lock().ok().and_then(|mut guard| guard.take())
}

/// 外链安全校验：协议头大小写不敏感（与前端 `openUrl` 的 `/^https?:\/\//i` 对齐），
/// 归一为小写 `http://` / `https://`；拒绝空串、内部空白、非网页协议、内嵌凭据与空主机。
pub(crate) fn validate_external_http_url(url: &str) -> Result<String, String> {
    const REJECT: &str = "仅支持打开 http/https 协议的安全链接";
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return Err(REJECT.to_string());
    }
    let clean = crate::github::detail_fetch::lowercase_http_scheme(trimmed)
        .ok_or_else(|| REJECT.to_string())?;
    let parsed = reqwest::Url::parse(&clean).map_err(|_| REJECT.to_string())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.host_str().is_none_or(str::is_empty)
    {
        return Err(REJECT.to_string());
    }
    Ok(clean)
}

/// 拉起外部默认浏览器打开安全链接（http/https）。
pub fn open_external_url(url: &str) -> Result<bool, String> {
    let clean = validate_external_http_url(url)?;
    let clean = clean.as_str();

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

/// Windows 网络路径判定（纯函数，`/` 与 `\` 等价）：`\\server\share`、`//server/share`、
/// `\\?\UNC\...` 及 `\\.\` 设备命名空间均视为网络/非本地盘路径；
/// 仅放行 `\\?\C:\...` 形态的本地盘 verbatim 路径（`canonicalize` 产物）。
/// 访问 UNC 路径会触发 SMB 连接并可能外泄 NTLM 凭据。
pub(crate) fn is_windows_network_path(raw: &str) -> bool {
    let s = raw.trim().replace('/', "\\");
    if !s.starts_with(r"\\") {
        return false;
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) => {
            let b = rest.as_bytes();
            !(b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
        }
        None => true,
    }
}

/// 在系统文件管理器中打开路径或高亮文件。
pub fn open_desktop_path(path: &std::path::Path, select_file: bool) -> Result<bool, String> {
    // 网络路径必须先于 `exists()` 拒绝：探测本身即会发起 SMB 连接。
    #[cfg(target_os = "windows")]
    if is_windows_network_path(&path.to_string_lossy()) {
        return Err(format!("拒绝打开网络路径: {}", path.to_string_lossy()));
    }
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
                .arg("-R")
                .arg(path)
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
        Ok(true)
    }
    #[cfg(target_os = "linux")]
    {
        let _ = select_file;
        let dir = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {}", e))?;
        Ok(true)
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

#[cfg(test)]
mod tests {
    use super::validate_external_http_url as validate;

    #[test]
    fn network_paths_are_detected() {
        use super::is_windows_network_path as net;
        for p in [
            r"\\server\share\file.txt",
            "//server/share",
            r"\\?\UNC\server\share",
            r"\\.\pipe\x",
            r"\\?\GLOBALROOT\Device",
        ] {
            assert!(net(p), "{p:?} must be treated as network path");
        }
        for p in [
            r"C:\Users\me\Downloads",
            r"\\?\C:\Users\me",
            r"relative\dir",
            "/usr/local",
            "",
        ] {
            assert!(!net(p), "{p:?} is a local path");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn open_desktop_path_rejects_unc_before_probing() {
        let err =
            super::open_desktop_path(std::path::Path::new(r"\\127.0.0.1\c$"), false).unwrap_err();
        assert!(err.contains("网络路径"), "{err}");
    }

    #[test]
    fn test_validate_external_http_url_accepts_case_variant_http_schemes() {
        assert_eq!(
            validate("HTTPS://example.com/path").as_deref(),
            Ok("https://example.com/path")
        );
        assert_eq!(
            validate("  http://example.com ").as_deref(),
            Ok("http://example.com")
        );
    }

    #[test]
    fn test_validate_external_http_url_rejects_non_web_inputs() {
        for bad in [
            "",
            "   ",
            "ftp://files.example.com",
            "javascript:alert(1)",
            "file:///C:/test",
            "zstore://app/o/r",
            "https://user:pass@example.com",
            "https://example.com/a b",
            "https://",
        ] {
            assert!(validate(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn cli_deep_link_parses_case_insensitively_and_consumes_once() {
        let found =
            super::find_cli_deep_link_in_args(["z-store.exe", "--flag", "ZSTORE://app/o/r"]);
        assert_eq!(found.as_deref(), Some("ZSTORE://app/o/r"));
        assert_eq!(
            super::find_cli_deep_link_in_args(["z-store.exe", "https://example.com"]),
            None
        );

        let slot = std::sync::Mutex::new(found);
        assert_eq!(
            slot.lock().unwrap().take().as_deref(),
            Some("ZSTORE://app/o/r")
        );
        assert_eq!(slot.lock().unwrap().take(), None);
    }
}
