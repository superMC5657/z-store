//! Linux GNOME 系统代理读取（仅 `manual` 静态代理）。
//!
//! - 读 `gsettings org.gnome.system.proxy`（`mode` + `http/https/socks`
//!   的 `host/port` + `ignore-hosts`），每次探测实时读取，不写进程 env；
//! - 单地址归一委托 `proxy::normalize_single_proxy_addr`：补 `http://`、
//!   保留 `socks5(h)://`、鉴权保留；
//! - 只做 `manual` 静态代理，`auto/pac` 记 warn 后视为直连。

use super::ProxySnapshot;

/// 归一化代理 URL（纯函数，可单元测试）：单地址形态委托共享
/// [`super::normalize_single_proxy_addr`]，`host:port` 补 `http://`、非法裸词拒绝。
pub fn normalize_proxy_url(raw: &str) -> Option<String> {
    super::normalize_single_proxy_addr(raw)
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
    let digits: String = raw
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
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
    let t = raw
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    t.split(',')
        .map(|s| {
            s.trim()
                .trim_matches('\'')
                .trim_matches('"')
                .trim()
                .to_string()
        })
        .filter_map(|s| super::normalize_bypass_entry(&s))
        .collect()
}

/// GNOME 代理读取结果（`manual` 且至少一项有效时 `Some`）。
pub struct GnomeProxy {
    pub http: Option<String>,
    pub https: Option<String>,
    pub socks_all: Option<String>,
    pub ignore_hosts: Vec<String>,
}

/// 仅支持 `manual` 静态代理；若为 `auto`/`pac` 等非 `manual` 非 `none` 模式，
/// 额外返回被跳过的模式名供启动期告警记录。
fn read_gnome_proxy_with_mode() -> (Option<GnomeProxy>, Option<String>) {
    let Some(mode_raw) = gsettings_get("org.gnome.system.proxy", "mode") else {
        return (None, None);
    };
    let mode = mode_raw.trim().to_ascii_lowercase();
    if mode != "manual" {
        let skipped = (!mode.is_empty() && mode != "none").then_some(mode);
        return (None, skipped);
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
        return (None, None);
    }
    (
        Some(GnomeProxy {
            http,
            https,
            socks_all,
            ignore_hosts,
        }),
        None,
    )
}

/// 上次告警过的不支持模式（`auto`/`pac`）：同一模式只告警一次，模式变化后再告警。
static LAST_SKIPPED_MODE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 实时读取 GNOME 系统代理为快照（不写进程 env）：`manual` 才有代理，
/// `none` / `auto` / 无 gsettings 均为直连快照。
pub fn read_linux_proxy() -> ProxySnapshot {
    let (gnome, skipped_mode) = read_gnome_proxy_with_mode();
    if let Ok(mut last) = LAST_SKIPPED_MODE.lock() {
        if skipped_mode != *last {
            if let Some(ref mode) = skipped_mode {
                let mut ev = crate::z_log::WideEvent::new("network", "proxy skipped");
                ev.field("mode", mode)
                    .field("reason", "unsupported_gnome_mode");
                ev.warn();
            }
            *last = skipped_mode;
        }
    }
    match gnome {
        Some(g) => ProxySnapshot {
            http: g.http,
            https: g.https,
            all: g.socks_all,
            no_proxy_entries: g.ignore_hosts,
            source: super::ProxySource::Gnome,
        },
        None => ProxySnapshot::direct(),
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
        // `socks4` 裸前缀无 `://` 一律拒绝（避免 junk scheme 进代理 env）。
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
