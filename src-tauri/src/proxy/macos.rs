//! macOS 系统代理实时读取（解析 `scutil --proxy` 输出，仅 macOS 触发系统调用）。

use super::ProxySnapshot;
use std::collections::HashMap;

fn host_port_url(scheme: &str, host: &str, port: &str) -> Option<String> {
    let host = host.trim();
    let port: u16 = port.trim().parse().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    // IPv6 裸地址补中括号，避免与端口冒号歧义。
    let host_part = if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host.to_string()
    };
    super::normalize_single_proxy_addr(&format!("{scheme}://{host_part}:{port}"))
}

/// 解析 `scutil --proxy` 文本输出（纯函数）。
pub fn parse_scutil_proxy_output(text: &str) -> ProxySnapshot {
    let mut kv: HashMap<String, String> = HashMap::new();
    let mut exceptions: Vec<String> = Vec::new();
    let mut in_exceptions = false;
    for line in text.lines() {
        let t = line.trim();
        if in_exceptions {
            if t.starts_with('}') {
                in_exceptions = false;
                continue;
            }
            // 数组元素形如 `0 : *.local`。
            if let Some((_, v)) = t.split_once(" : ") {
                if let Some(e) = super::normalize_bypass_entry(v) {
                    if !exceptions.iter().any(|x| x.eq_ignore_ascii_case(&e)) {
                        exceptions.push(e);
                    }
                }
            }
            continue;
        }
        let Some((k, v)) = t.split_once(" : ") else {
            continue;
        };
        let k = k.trim();
        let v = v.trim();
        if k == "ExceptionsList" && v.starts_with("<array>") {
            in_exceptions = !v.ends_with('}');
            continue;
        }
        kv.insert(k.to_string(), v.to_string());
    }
    let enabled = |key: &str| kv.get(key).map(|v| v == "1").unwrap_or(false);
    let pick = |enable: &str, host: &str, port: &str, scheme: &str| -> Option<String> {
        if !enabled(enable) {
            return None;
        }
        host_port_url(scheme, kv.get(host)?, kv.get(port)?)
    };
    let http = pick("HTTPEnable", "HTTPProxy", "HTTPPort", "http");
    // HTTPS 代理即 CONNECT 代理，对代理本身仍是 http:// 连接。
    let https = pick("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http");
    let all = pick("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5h");
    if http.is_none() && https.is_none() && all.is_none() {
        return ProxySnapshot::direct();
    }
    ProxySnapshot {
        http,
        https,
        all,
        no_proxy_entries: exceptions,
        source: super::ProxySource::MacOs,
    }
}

/// 实时读取 macOS 系统代理（`scutil` 失败即直连快照）。
#[cfg(target_os = "macos")]
pub fn read_macos_proxy() -> ProxySnapshot {
    match std::process::Command::new("scutil").arg("--proxy").output() {
        Ok(out) if out.status.success() => {
            parse_scutil_proxy_output(&String::from_utf8_lossy(&out.stdout))
        }
        _ => ProxySnapshot::direct(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = "<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : 10.*
    3 : intranet.example.com
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}
";

    #[test]
    fn test_parse_scutil_all_enabled() {
        let s = parse_scutil_proxy_output(FULL);
        assert_eq!(s.source, crate::proxy::ProxySource::MacOs);
        assert_eq!(s.http.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(s.https.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(s.all.as_deref(), Some("socks5h://127.0.0.1:7891"));
        assert_eq!(
            s.no_proxy_entries,
            vec![".local", "169.254/16", "intranet.example.com"]
        );
        assert_eq!(s.summary(), "macos(127.0.0.1)");
    }

    #[test]
    fn test_parse_scutil_disabled_is_direct() {
        let text = "<dictionary> {
  HTTPEnable : 0
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
  SOCKSEnable : 0
}
";
        assert_eq!(parse_scutil_proxy_output(text), ProxySnapshot::direct());
        assert_eq!(parse_scutil_proxy_output(""), ProxySnapshot::direct());
    }

    #[test]
    fn test_parse_scutil_socks_only_and_ipv6() {
        let text = "<dictionary> {
  ExceptionsList : <array> {
  }
  HTTPEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : ::1
}
";
        let s = parse_scutil_proxy_output(text);
        assert_eq!(s.http, None);
        assert_eq!(s.all.as_deref(), Some("socks5h://[::1]:1080"));
        assert_eq!(s.https_effective(), Some("socks5h://[::1]:1080"));
        assert!(s.no_proxy_entries.is_empty());
    }

    #[test]
    fn test_parse_scutil_enabled_but_bad_port_is_direct() {
        let text = "<dictionary> {
  HTTPEnable : 1
  HTTPPort : 0
  HTTPProxy : 127.0.0.1
}
";
        assert_eq!(parse_scutil_proxy_output(text), ProxySnapshot::direct());
    }
}
