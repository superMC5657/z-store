//! 下载加速代理：经用户配置镜像加速（仅安装包通道）。
//!
//! - 安装资产下载经 [`MirrorManager::rewrite_installer_asset_url`] 改写 URL，
//!   失败时经 `wrap_gh_proxy` 公共兜底重试。

use crate::models::MirrorNodeStatus;
use std::time::Instant;

pub const DEFAULT_GH_PROXY: &str = "https://gh-proxy.com";

/// 从 URL 提取小写 host（仅接受带 scheme 的完整 URL；剥 userinfo 与端口）。
/// 手写解析不引入 `url` 依赖：调用方传入的均为 Provider/镜像侧完整 URL。
fn url_host(raw_url: &str) -> Option<String> {
    let rest = raw_url
        .strip_prefix("https://")
        .or_else(|| raw_url.strip_prefix("http://"))?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host = authority.rsplit('@').next()?; // 剥 userinfo（user:pass@host）
    let host = host.split(':').next()?; // 剥端口
    let host = host.trim().to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// host 精确或子域匹配：`github.com` 命中 `api.github.com`，
/// 不命中 `notgithub.com` / `github.com.evil.com`。
fn host_is_or_subdomain_of(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

pub fn is_github_domain(raw_url: &str) -> bool {
    // 解析 host 后按精确/子域匹配：`notgithub.com`、`github.com.evil.com` 不是 GitHub 资产，
    // 不走镜像改写/兜底路径。
    let Some(host) = url_host(raw_url) else {
        return false;
    };
    ["github.com", "githubusercontent.com"]
        .iter()
        .any(|d| host_is_or_subdomain_of(&host, d))
}

/// 自定义镜像准入校验（D3 供应链防线）：仅接受 `https://` 且 host 为合法域名。
/// 明文 http 镜像可被中间人整体替换下载载荷；裸 IP、userinfo、畸形 host 同拒。
/// `direct` / `ghproxy` / 空串为内置档位，直通。
pub fn validate_custom_proxy(id_or_url: &str) -> Result<(), String> {
    let trimmed = id_or_url.trim();
    if trimmed.is_empty() || trimmed == "direct" || trimmed == "ghproxy" {
        return Ok(());
    }
    if !trimmed.starts_with("https://") {
        return Err("加速镜像必须使用 https://（明文 http 镜像可篡改下载载荷，已拒绝）".to_string());
    }
    // userinfo（user:pass@host）显式拒绝：镜像地址不应携带凭据。
    let rest = trimmed.strip_prefix("https://").unwrap_or(trimmed);
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if rest[..authority_end].contains('@') {
        return Err("镜像地址不应携带用户凭据（user:pass@host 形态）".to_string());
    }
    let host = url_host(trimmed).ok_or_else(|| "无法解析镜像地址的主机名".to_string())?;
    if host.len() > 253 {
        return Err("镜像主机名过长".to_string());
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty() || l.len() > 63) {
        return Err(format!("镜像地址必须是合法域名（如 gh-proxy.com）：{host}"));
    }
    for label in &labels {
        if !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
            || label.starts_with('-')
            || label.ends_with('-')
        {
            return Err(format!("镜像域名含非法字符：{host}"));
        }
    }
    // TLD 必须含字母：拒绝裸 IP 形态的“镜像”（常见钓鱼面）。
    if !labels[labels.len() - 1].chars().any(|c| c.is_ascii_alphabetic()) {
        return Err(format!("镜像地址必须是域名（不接受裸 IP）：{host}"));
    }
    Ok(())
}

/// 底层前缀原语（唯一）：`base` 去尾斜杠后当前缀拼接；已套前缀返回原值。
fn prefix_with_base(base: &str, raw_url: &str) -> String {
    let base = base.trim_end_matches('/');
    if raw_url.starts_with(base) {
        return raw_url.to_string();
    }
    format!("{base}/{raw_url}")
}

pub fn wrap_gh_proxy(raw_url: &str) -> String {
    if !is_github_domain(raw_url) {
        return raw_url.to_string();
    }
    prefix_with_base(DEFAULT_GH_PROXY, raw_url)
}

pub struct MirrorManager {
    // 默认为 None，表示官方直连；用户可指定加速代理前缀。
    custom_proxy: Option<String>,
}

impl Default for MirrorManager {
    fn default() -> Self {
        Self::new()
    }
}

impl MirrorManager {
    pub fn new() -> Self {
        Self {
            custom_proxy: None, // 默认 GitHub 官方直连
        }
    }

    pub fn get_mirror_statuses(&self) -> Vec<MirrorNodeStatus> {
        let is_custom = self.custom_proxy.is_some();
        let proxy_url = self.custom_proxy.clone().unwrap_or_default();
        vec![
            MirrorNodeStatus {
                id: "direct".to_string(),
                name: "GitHub 官方直连".to_string(),
                base_url: "https://github.com".to_string(),
                latency_ms: 0,
                is_active: !is_custom,
            },
            MirrorNodeStatus {
                id: "custom".to_string(),
                name: if is_custom {
                    format!(
                        "自定义代理 ({})",
                        proxy_url
                            .trim_start_matches("https://")
                            .trim_start_matches("http://")
                    )
                } else {
                    "自定义加速代理".to_string()
                },
                base_url: proxy_url,
                latency_ms: 0,
                is_active: is_custom,
            },
        ]
    }

    pub fn set_active_mirror(&mut self, id_or_url: &str) -> bool {
        let trimmed = id_or_url.trim();
        let (new_proxy, id) = if trimmed.is_empty() || trimmed == "direct" {
            (None, "direct")
        } else if trimmed == "ghproxy" {
            (Some(DEFAULT_GH_PROXY.to_string()), "custom")
        } else if let Err(reason) = validate_custom_proxy(trimmed) {
            // 自定义镜像准入失败（非 https / 非法域名）：拒绝切换保持现状（fail-closed），
            // 含启动时回读历史存量值；拒绝理由由 switch_mirror 命令层前置透出。
            log::warn!(
                "mirror rejected id_or_url reason={}",
                crate::log_support::short_reason(&reason)
            );
            return false;
        } else {
            (Some(trimmed.to_string()), "custom")
        };

        if self.custom_proxy == new_proxy {
            return true; // 状态未改变，幂等跳过，避免重复刷日志
        }
        self.custom_proxy = new_proxy;
        // 代理 host 豁免：仅 per-client `no_proxy` 透传，不写进程全局变量；
        // 加速代理仅改写安装包下载 URL，API 端点始终直连（见 proxy 默认豁免）。
        let proxy_display = self.custom_proxy.as_deref().unwrap_or("direct");
        log::info!("mirror switch id={} proxy='{}'", id, proxy_display);
        true
    }

    /// 安装资产 URL 改写：经用户配置镜像加速（仅安装包通道）。
    pub fn rewrite_installer_asset_url(&self, raw_url: &str) -> String {
        let proxy = match &self.custom_proxy {
            Some(p) if !p.trim().is_empty() && p.trim() != "direct" => p.trim(),
            _ => return raw_url.to_string(),
        };

        // 仅 GitHub 链接及 Releases 资产走镜像代理，其它平台跳过。
        let is_github_url = is_github_domain(raw_url);

        if !is_github_url {
            return raw_url.to_string();
        }

        prefix_with_base(proxy, raw_url)
    }

    /// 测速专用 HTTP 客户端（短超时 + 浏览器 UA）。
    /// `extra_hosts` 追加进 `no_proxy`（被测镜像 host 直连，不另起 Client）。
    fn ping_client(timeout_ms: u64, extra_hosts: &[String]) -> reqwest::Client {
        let builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
        let builder = crate::proxy::apply_proxy(builder, extra_hosts);
        builder.build().unwrap_or_default()
    }

    /// 单击测速：快速探测指定代理地址（或官方直连）的网络握手时延
    pub async fn test_proxy_latency(proxy_url: Option<&str>) -> (bool, u32, String) {
        let timeout_ms = crate::config::get_project_config().network.ping_timeout_ms;

        let clean_url = proxy_url
            .map(|s| s.trim())
            .filter(|s| !s.is_empty() && *s != "direct");

        let test_url = match clean_url {
            Some(p) => {
                // 测速与保存同一准入口径（https 强制 + 域名校验）：
                // 允许测 http 却存不进去只会制造困惑。
                if let Err(reason) = validate_custom_proxy(p) {
                    return (false, 9999, reason);
                }
                p.trim_end_matches('/').to_string()
            }
            None => "https://github.com".to_string(),
        };

        // 被测镜像 host 直连豁免：靠 per-client no_proxy 覆盖，不另起 Client。
        let extra_hosts = crate::proxy::proxy_hosts_for(&test_url);
        let client = Self::ping_client(timeout_ms, &extra_hosts);

        let safe_test_url = crate::log_support::sanitize_url(&test_url);
        let req_id = crate::z_log::new_req_id();
        let sid = crate::z_log::new_session_id();
        let req_host = crate::log_support::host_of(&test_url);
        log::debug!(
            "test mirror ping start sid={} req={} url='{}'",
            sid,
            req_id,
            safe_test_url
        );

        let start = Instant::now();
        let mut resp = client.head(&test_url).send().await;
        if resp.is_err()
            || resp
                .as_ref()
                .map(|r| r.status().as_u16() == 405)
                .unwrap_or(false)
        {
            resp = client.get(&test_url).send().await;
        }
        let elapsed = start.elapsed().as_millis() as u32;

        match resp {
            Ok(res) => {
                let status = res.status().as_u16();
                if status < 500 {
                    log::debug!(
                        "test mirror ping resp sid={} req={} url='{}' status={} latency_ms={}",
                        sid,
                        req_id,
                        safe_test_url,
                        status,
                        elapsed
                    );
                    log::info!(
                        "http resp mirror ping sid={} req={} host={} status={} latency_ms={}",
                        sid,
                        req_id,
                        req_host,
                        status,
                        elapsed
                    );
                    (
                        true,
                        elapsed.clamp(1, 4000),
                        format!("{} ms (连接正常)", elapsed),
                    )
                } else {
                    log::warn!(
                        "test mirror ping resp sid={} req={} host={} status={} latency_ms={}",
                        sid,
                        req_id,
                        req_host,
                        status,
                        elapsed
                    );
                    (false, 9999, format!("HTTP 状态码异常: {}", status))
                }
            }
            Err(e) => {
                let reason = crate::log_support::short_reason(&e.to_string());
                log::warn!(
                    "test mirror ping failed sid={} req={} host={} reason={}",
                    sid,
                    req_id,
                    req_host,
                    reason
                );
                (false, 9999, format!("连接失败或超时: {}", e))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rewrite_url() {
        let mut mm = MirrorManager::new();
        let raw = "https://github.com/rustdesk/rustdesk/releases/download/1.2.6/rustdesk.msi";

        // 默认状态下是官方直连
        let direct = mm.rewrite_installer_asset_url(raw);
        assert_eq!(direct, raw);

        // 设置自定义代理
        mm.set_active_mirror("https://gh-proxy.com");
        let rewritten = mm.rewrite_installer_asset_url(raw);
        assert!(rewritten.starts_with("https://gh-proxy.com/https://github.com"));

        // 切换回直连
        mm.set_active_mirror("direct");
        let direct2 = mm.rewrite_installer_asset_url(raw);
        assert_eq!(direct2, raw);

        // 非 GitHub 域名直连验证
        let cb_url = "https://codeberg.org/attachments/a1b2c3d4-installer.exe";
        mm.set_active_mirror("https://gh-proxy.com");
        assert_eq!(mm.rewrite_installer_asset_url(cb_url), cb_url);
    }

    #[test]
    fn test_switch_mirror() {
        let mut mm = MirrorManager::new();
        assert!(mm.set_active_mirror("https://gh-proxy.com"));
        let nodes = mm.get_mirror_statuses();
        let custom = nodes.iter().find(|n| n.id == "custom").unwrap();
        assert!(custom.is_active);
    }

    #[test]
    fn github_domain_matches_host_not_substring() {
        assert!(is_github_domain(
            "https://github.com/owner/repo/releases/download/v1/a.zip"
        ));
        assert!(is_github_domain("https://api.github.com/repos/o/r"));
        assert!(is_github_domain(
            "https://raw.githubusercontent.com/o/r/main/x"
        ));
        assert!(is_github_domain(
            "https://github-releases.githubusercontent.com/x"
        ));
        // 子串误命中形态必须拒绝
        assert!(!is_github_domain("https://notgithub.com/a.zip"));
        assert!(!is_github_domain("https://github.com.evil.com/a.zip"));
        assert!(!is_github_domain("https://mygithubusercontent.com/a"));
        // 无 scheme 不再盲配（调用方传入的均为完整 URL）
        assert!(!is_github_domain("github.com/owner/repo"));
        assert!(!is_github_domain("https://codeberg.org/attachments/a.exe"));
    }

    #[test]
    fn custom_proxy_validation_enforces_https_and_domain() {
        // 内置档位直通
        assert!(validate_custom_proxy("").is_ok());
        assert!(validate_custom_proxy("direct").is_ok());
        assert!(validate_custom_proxy("ghproxy").is_ok());
        assert!(validate_custom_proxy("https://gh-proxy.com").is_ok());
        assert!(validate_custom_proxy("https://mirror.example.com:8443/prefix").is_ok());
        // 明文 http / 缺 scheme 拒绝
        assert!(validate_custom_proxy("http://gh-proxy.com").is_err());
        assert!(validate_custom_proxy("gh-proxy.com").is_err());
        // 裸 IP / 无点单标签 / userinfo / 畸形 host 拒绝
        assert!(validate_custom_proxy("https://127.0.0.1").is_err());
        assert!(validate_custom_proxy("https://localhost").is_err());
        assert!(validate_custom_proxy("https://user:pass@gh-proxy.com").is_err());
        assert!(validate_custom_proxy("https://bad host.com").is_err());
        assert!(validate_custom_proxy("https://-leading-dot.example.com").is_err());
    }

    #[test]
    fn set_active_mirror_rejects_non_https_and_bad_hosts() {
        let mut mm = MirrorManager::new();
        assert!(mm.set_active_mirror("https://gh-proxy.com"));
        // 明文 http 与非法 host 拒绝切换，保持上一状态
        assert!(!mm.set_active_mirror("http://gh-proxy.com"));
        assert!(!mm.set_active_mirror("https://127.0.0.1"));
        let nodes = mm.get_mirror_statuses();
        let custom = nodes.iter().find(|n| n.id == "custom").unwrap();
        assert!(custom.is_active);
        assert_eq!(custom.base_url, "https://gh-proxy.com");
    }

    #[tokio::test]
    async fn test_proxy_ping() {
        let (ok, latency, msg) = MirrorManager::test_proxy_latency(None).await;
        log::debug!("PING DIRECT: ok={}, lat={}, msg={}", ok, latency, msg);
    }
}
