//! Windows 系统代理实时读取（`HKCU\...\Internet Settings`）。
//!
//! - `ProxyEnable == 0` 即直连快照（关闭系统代理立即恢复直连）；
//! - `ProxyServer` 支持 `host:port`、`scheme://host:port` 与多协议
//!   `http=..;https=..;socks=..`（https 优先 → http → 其他 → 裸地址）；
//! - `ProxyOverride` 绕过列表合并进 `no_proxy`（`<local>` → 本地回环，`*.domain` → `.domain`）。
//!
//! 解析器为跨平台纯函数（可在任意平台单测），注册表读取仅 Windows 编译。

use super::ProxySnapshot;

/// 解析 `ProxyServer` 值；无法解析返回 `None`（视为未配置，保持直连）。
/// scheme 必须带 `://`（裸 `socks4` 前缀无 `://` 一律拒绝）。
pub fn normalize_windows_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut https_pick: Option<&str> = None;
    let mut http_pick: Option<&str> = None;
    let mut other_pick: Option<&str> = None;
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
                _ => {
                    if other_pick.is_none() {
                        other_pick = Some(addr);
                    }
                }
            }
        } else if plain_pick.is_none() {
            plain_pick = Some(part);
        }
    }
    let addr = https_pick
        .or(http_pick)
        .or(other_pick)
        .or(plain_pick)?
        .trim();
    super::normalize_single_proxy_addr(addr)
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
    }

    #[test]
    fn test_parse_proxy_override() {
        assert_eq!(
            parse_windows_proxy_override("<local>"),
            vec!["localhost", "127.0.0.1", "::1"]
        );
        assert_eq!(
            parse_windows_proxy_override("*.corp.local; intranet.example.com ;<LOCAL>;10.*;*.corp.local"),
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
