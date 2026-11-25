//! Windows 系统代理实时读取（解析 `HKCU\...\Internet Settings` 注册表配置）。

use super::ProxySnapshot;

/// 归一化 Windows 注册表 `socks=` / `socks5=` 条目：保留已带 `socks*://` 的地址，
/// 裸 `host:port` 映射为 `socks5h://{addr}`；非 SOCKS scheme 或无端口裸词拒绝。
fn normalize_windows_socks_addr(raw: &str) -> Option<String> {
    let addr = raw.trim();
    if addr.is_empty() {
        return None;
    }
    let lower = addr.to_ascii_lowercase();
    if lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
        || lower.starts_with("socks4://")
        || lower.starts_with("socks4a://")
    {
        Some(addr.to_string())
    } else if lower.contains("://") {
        None
    } else if addr.contains(':') {
        Some(format!("socks5h://{}", addr))
    } else {
        None
    }
}

/// 解析 `ProxyServer` 值；无法解析返回 `None`（视为未配置，保持直连）。
/// scheme 必须带 `://`（裸 `socks4` 前缀无 `://` 一律拒绝）；`socks=`/`socks5=` 映射为 `socks5h://`，忽略 `ftp=` 等非 HTTP/SOCKS 条目。
pub fn normalize_windows_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut https_pick: Option<&str> = None;
    let mut http_pick: Option<&str> = None;
    let mut socks_pick: Option<&str> = None;
    let mut plain_pick: Option<&str> = None;
    for part in raw.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((proto, addr)) = part.split_once('=') {
            let addr = addr.trim();
            if addr.is_empty() {
                continue;
            }
            match proto.trim().to_ascii_lowercase().as_str() {
                "https" => {
                    https_pick = Some(addr);
                    break;
                }
                "http" => {
                    if http_pick.is_none() {
                        http_pick = Some(addr);
                    }
                }
                "socks" | "socks5" if socks_pick.is_none() => {
                    socks_pick = Some(addr);
                }
                // 忽略 ftp= 等非 HTTP/SOCKS 协议，避免误用为 HTTPS 代理。
                _ => {}
            }
        } else if plain_pick.is_none() {
            plain_pick = Some(part);
        }
    }
    if let Some(addr) = https_pick.or(http_pick) {
        return super::normalize_single_proxy_addr(addr);
    }
    if let Some(addr) = socks_pick {
        return normalize_windows_socks_addr(addr);
    }
    plain_pick.and_then(super::normalize_single_proxy_addr)
}

/// 解析 `ProxyOverride`（`;` 分隔）：`<local>` 映射为 `localhost`/`127.0.0.1`/`::1`，
/// `*.domain` 归一为 `.domain`，`NoProxy` 无法解析的 IP 通配（`192.168.*`）跳过。
pub fn parse_windows_proxy_override(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !out.iter().any(|e| e.eq_ignore_ascii_case(&s)) {
            out.push(s);
        }
    };
    for part in raw.split(';') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if p.eq_ignore_ascii_case("<local>") {
            for h in ["localhost", "127.0.0.1", "::1"] {
                push(h.to_string());
            }
            continue;
        }
        if let Some(e) = super::normalize_bypass_entry(p) {
            push(e);
        }
    }
    out
}

/// 由注册表三项原值构造快照（纯函数）。
pub fn snapshot_from_registry(
    proxy_enable: u32,
    proxy_server: Option<&str>,
    proxy_override: Option<&str>,
) -> ProxySnapshot {
    if proxy_enable == 0 {
        return ProxySnapshot::direct();
    }
    let Some(full) = proxy_server.and_then(normalize_windows_proxy_server) else {
        return ProxySnapshot::direct();
    };
    ProxySnapshot {
        http: Some(full.clone()),
        https: Some(full),
        all: None,
        no_proxy_entries: proxy_override
            .map(parse_windows_proxy_override)
            .unwrap_or_default(),
        source: super::ProxySource::Windows,
    }
}

/// 实时读取当前用户的 Internet Settings 代理配置。
#[cfg(target_os = "windows")]
pub fn read_windows_proxy() -> ProxySnapshot {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(settings) =
        hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
    else {
        return ProxySnapshot::direct();
    };
    let enable: u32 = settings.get_value("ProxyEnable").unwrap_or(0);
    let server: Option<String> = settings.get_value("ProxyServer").ok();
    let overrides: Option<String> = settings.get_value("ProxyOverride").ok();
    snapshot_from_registry(enable, server.as_deref(), overrides.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_proxy_server_forms() {
        assert_eq!(
            normalize_windows_proxy_server("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_windows_proxy_server("http://127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_windows_proxy_server("socks5://127.0.0.1:7890"),
            Some("socks5://127.0.0.1:7890".to_string())
        );
        // 多协议形态优先 https
        assert_eq!(
            normalize_windows_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891"),
            Some("http://127.0.0.1:7891".to_string())
        );
        assert_eq!(normalize_windows_proxy_server(""), None);
        assert_eq!(normalize_windows_proxy_server("   "), None);
        assert_eq!(normalize_windows_proxy_server("notaproxy"), None);
        assert_eq!(normalize_windows_proxy_server("http=;https="), None);
        assert_eq!(normalize_windows_proxy_server("socks4"), None);
        assert_eq!(normalize_windows_proxy_server("socks4junk"), None);
        assert_eq!(normalize_windows_proxy_server("  socks4junk  "), None);
        assert_eq!(
            normalize_windows_proxy_server("socks4a://127.0.0.1:7890"),
            Some("socks4a://127.0.0.1:7890".to_string())
        );
        // F-11: socks=/socks5= 映射为 socks5h://，ftp= 忽略
        assert_eq!(
            normalize_windows_proxy_server("socks=127.0.0.1:1080"),
            Some("socks5h://127.0.0.1:1080".to_string())
        );
        assert_eq!(
            normalize_windows_proxy_server("socks5=127.0.0.1:1080"),
            Some("socks5h://127.0.0.1:1080".to_string())
        );
        assert_eq!(
            normalize_windows_proxy_server("SOCKS=socks5://127.0.0.1:1080"),
            Some("socks5://127.0.0.1:1080".to_string())
        );
        assert_eq!(normalize_windows_proxy_server("ftp=proxy.local:21"), None);
        assert_eq!(
            normalize_windows_proxy_server("ftp=proxy.local:21;socks=127.0.0.1:1080"),
            Some("socks5h://127.0.0.1:1080".to_string())
        );
        assert_eq!(
            normalize_windows_proxy_server("socks=127.0.0.1:1080;http=127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(normalize_windows_proxy_server("socks=notaport"), None);
    }

    #[test]
    fn test_parse_proxy_override() {
        assert_eq!(
            parse_windows_proxy_override("<local>"),
            vec!["localhost", "127.0.0.1", "::1"]
        );
        assert_eq!(
            parse_windows_proxy_override(
                "*.corp.local; intranet.example.com ;<LOCAL>;10.*;*.corp.local"
            ),
            vec![
                ".corp.local",
                "intranet.example.com",
                "localhost",
                "127.0.0.1",
                "::1"
            ]
        );
        assert!(parse_windows_proxy_override("").is_empty());
        assert!(parse_windows_proxy_override("  ;  ; ").is_empty());
    }

    #[test]
    fn test_snapshot_from_registry() {
        assert_eq!(
            snapshot_from_registry(0, Some("127.0.0.1:7890"), Some("<local>")),
            ProxySnapshot::direct()
        );
        assert_eq!(
            snapshot_from_registry(1, Some("notaproxy"), None),
            ProxySnapshot::direct()
        );
        let s = snapshot_from_registry(1, Some("127.0.0.1:7890"), Some("*.corp.local"));
        assert_eq!(s.source, crate::proxy::ProxySource::Windows);
        assert_eq!(s.http.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(s.https.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(s.no_proxy_entries, vec![".corp.local"]);
        assert_eq!(s.summary(), "win(127.0.0.1)");
    }
}
