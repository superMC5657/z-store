//! Linux GNOME 系统代理读取（仅 `manual` 静态代理）。
//!
//! - 读 `gsettings org.gnome.system.proxy`（`mode` + `http/https/ftp/socks`
//!   的 `host/port` + `ignore-hosts`），`env HTTP(S)_PROXY/ALL_PROXY` 兜底；
//! - 归一化复用 Windows `normalize_windows_proxy_server` 思想：补 `http://`、
//!   保留 `socks5(h)://`、鉴权保留；
//! - 只做 `manual` 静态代理，`auto/pac` 记 warn 后跳过（保持直连）。

use super::{ensure_no_proxy_env, host_of_url};

/// 归一化代理 URL（纯函数，可单元测试）。
/// 接受 `host:port`（含 `user:pass@host:port` 鉴权形态）或自带 scheme；
/// 仅 `http://`、`https://`、`socks5://`、`socks5h://`、`socks4://`、`socks4a://`
/// （大小写不敏感，必须带 `://`）保留原值，其余含 `:` 的补 `http://`；
/// 无 scheme、无 `:` 的裸词（含 `socks4` 前缀但缺 `://` 的垃圾输入）一律拒绝，
/// 返回 `None`（调用方不设置，保持直连，避免 junk 字符串污染代理环境）。
pub fn normalize_proxy_url(raw: &str) -> Option<String> {
    let addr = raw.trim();
    if addr.is_empty() {
        return None;
    }
    let lower = addr.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
        || lower.starts_with("socks4://")
        || lower.starts_with("socks4a://")
    {
        Some(addr.to_string())
    } else if addr.contains(':') {
        Some(format!("http://{}", addr))
    } else {
        None
    }
}

fn gsettings_get(schema: &str, key: &str) -> Option<String> {
    let out = std::process::Command::new("gsettings")
        .arg("get")
        .arg(schema)
        .arg(key)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    // 字符串值带单引号（`'manual'`），空串为 `''`；数组为 `[...]` 保持原样。
    if s == "''" {
        return None;
    }
    if s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2 {
        let inner = s[1..s.len() - 1].trim().to_string();
        if inner.is_empty() {
            None
        } else {
            Some(inner)
        }
    } else {
        Some(s)
    }
}

fn gsettings_port(schema: &str) -> Option<u16> {
    let raw = gsettings_get(schema, "port")?;
    // 输出形如 `8080`（uint32），容忍首尾空白。
    let digits: String = raw.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let port: u16 = digits.parse().ok()?;
    if port == 0 {
        None
    } else {
        Some(port)
    }
}

fn gnome_host_port(schema: &str) -> Option<String> {
    let host = gsettings_get(schema, "host")?;
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let port = gsettings_port(schema)?;
    // IPv6 裸地址补中括号，避免与端口冒号歧义。
    let host_part = if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host.to_string()
    };
    normalize_proxy_url(&format!("{}:{}", host_part, port))
}

fn gnome_socks_url() -> Option<String> {
    let host = gsettings_get("org.gnome.system.proxy.socks", "host")?;
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let port = gsettings_port("org.gnome.system.proxy.socks")?;
    let host_part = if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host.to_string()
    };
    // GNOME socks 无版本字段，默认 `socks5h://`（远端解析，防 DNS 泄漏）；
    // 已带 scheme 的输入仍走归一化保留路径。
    let candidate = format!("socks5h://{}:{}", host_part, port);
    normalize_proxy_url(&candidate)
}

fn gnome_ignore_hosts() -> Vec<String> {
    let raw = match gsettings_get("org.gnome.system.proxy", "ignore-hosts") {
        Some(v) => v,
        None => return Vec::new(),
    };
    // 形如 `['localhost', '127.0.0.0/8', '::1']`；`gsettings_get` 已去外层逻辑，
    // 此处容忍带/不带中括号两种形态。
    let t = raw.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    t.split(',')
        .map(|s| s.trim().trim_matches('\'').trim_matches('"').trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// GNOME 代理读取结果（`manual` 且至少一项有效时 `Some`）。
pub struct GnomeProxy {
    pub http: Option<String>,
    pub https: Option<String>,
    pub socks_all: Option<String>,
    pub ignore_hosts: Vec<String>,
}

/// 只做 `manual` 静态代理；`auto/pac` 记 warn 后返回 `None`（保持直连）。
pub fn read_gnome_proxy() -> Option<GnomeProxy> {
    let mode_raw = gsettings_get("org.gnome.system.proxy", "mode")?;
    let mode = mode_raw.trim().to_ascii_lowercase();
    if mode != "manual" {
        if mode.contains("auto") || mode.contains("pac") {
            log::warn!("proxy gnome mode={} skip (auto/pac unsupported, keep direct)", mode);
        }
        return None;
    }
    let http = gnome_host_port("org.gnome.system.proxy.http");
    let mut https = gnome_host_port("org.gnome.system.proxy.https");
    let socks_all = gnome_socks_url();
    // GNOME 常见只配 http：https 缺失时回退 http（与系统设置“对所有协议使用同一代理”一致）。
    if https.is_none() {
        https = http.clone();
    }
    let ignore_hosts = gnome_ignore_hosts();
    if http.is_none() && https.is_none() && socks_all.is_none() {
        return None;
    }
    Some(GnomeProxy {
        http,
        https,
        socks_all,
        ignore_hosts,
    })
}

fn has_any_proxy_env() -> bool {
    for k in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(v) = std::env::var(k) {
            if !v.trim().is_empty() {
                return true;
            }
        }
    }
    false
}

fn first_proxy_env_host() -> Option<String> {
    for k in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(v) = std::env::var(k) {
            let t = v.trim();
            if !t.is_empty() {
                if let Some(h) = host_of_url(t) {
                    return Some(h);
                }
                return Some("unknown".to_string());
            }
        }
    }
    None
}

/// Linux 启动期代理初始化（对标 Windows：env 为空才写，不覆盖终端 export）。
///
/// - env 已有任一 `HTTP(S)_PROXY/ALL_PROXY`：不写代理变量，仅补 `no_proxy`
///   默认豁免，记 `source=env`；
/// - env 为空且 GNOME `manual` 有效：写小写 `http_proxy/https_proxy`
///  （+ 大写镜像，兼容仅读大写的工具）与 `all_proxy`（仅 socks 有效时），
///   `no_proxy/NO_PROXY` 合并 GNOME `ignore-hosts` + 默认豁免，记 `source=gnome`；
/// - 其余：仅补 `no_proxy` 默认豁免，记 `source=none`。
/// - 日志只记 host（脱敏），永不记 query/凭证。
pub fn init_linux_system_proxy() {
    if has_any_proxy_env() {
        ensure_no_proxy_env(&[]);
        let host = first_proxy_env_host().unwrap_or_else(|| "unknown".to_string());
        log::info!("proxy init source=env host={}", host);
        return;
    }
    match read_gnome_proxy() {
        Some(g) => {
            let mut host_log = "unknown".to_string();
            if let Some(ref http) = g.http {
                std::env::set_var("http_proxy", http);
                std::env::set_var("HTTP_PROXY", http);
                if let Some(h) = host_of_url(http) {
                    host_log = h;
                }
            }
            if let Some(ref https) = g.https {
                std::env::set_var("https_proxy", https);
                std::env::set_var("HTTPS_PROXY", https);
                if host_log == "unknown" {
                    if let Some(h) = host_of_url(https) {
                        host_log = h;
                    }
                }
            }
            if let Some(ref all) = g.socks_all {
                std::env::set_var("all_proxy", all);
                std::env::set_var("ALL_PROXY", all);
                if host_log == "unknown" {
                    if let Some(h) = host_of_url(all) {
                        host_log = h;
                    }
                }
            }
            ensure_no_proxy_env(&g.ignore_hosts);
            log::info!("proxy init source=gnome host={}", host_log);
        }
        None => {
            ensure_no_proxy_env(&[]);
            log::info!("proxy init source=none host=direct");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_proxy_url;

    #[test]
    fn test_normalize_proxy_url_forms() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_proxy_url("http://127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_proxy_url("socks5://127.0.0.1:7890"),
            Some("socks5://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_proxy_url("socks5h://127.0.0.1:7890"),
            Some("socks5h://127.0.0.1:7890".to_string())
        );
        // 鉴权保留。
        assert_eq!(
            normalize_proxy_url("user:pass@127.0.0.1:7890"),
            Some("http://user:pass@127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_proxy_url("http://user:pass@127.0.0.1:7890"),
            Some("http://user:pass@127.0.0.1:7890".to_string())
        );
        // 垃圾输入不污染环境。
        assert_eq!(normalize_proxy_url(""), None);
        assert_eq!(normalize_proxy_url("   "), None);
        assert_eq!(normalize_proxy_url("notaproxy"), None);
        // `socks4` 裸前缀无 `://` 一律拒绝（曾误判为合法 scheme 导致 junk 进代理 env）。
        assert_eq!(normalize_proxy_url("socks4"), None);
        assert_eq!(normalize_proxy_url("socks4junk"), None);
        assert_eq!(normalize_proxy_url("socks4proxy"), None);
        assert_eq!(normalize_proxy_url("  socks4junk  "), None);
        // 带 `://` 的合法 socks4(a) 仍保留原值。
        assert_eq!(
            normalize_proxy_url("socks4://127.0.0.1:7890"),
            Some("socks4://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_proxy_url("socks4a://127.0.0.1:7890"),
            Some("socks4a://127.0.0.1:7890".to_string())
        );
    }
}
