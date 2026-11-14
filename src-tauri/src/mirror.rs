//! 下载加速代理：经用户配置镜像加速（仅安装包通道）。
//!
//! - 安装资产下载经 [`MirrorManager::rewrite_installer_asset_url_resolved`] 改写 URL 并给出
//!   需直连豁免的镜像 host，失败时经 [`wrap_gh_proxy_resolved`] 公共兜底重试。

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
        return Err(
            "加速镜像必须使用 https://（明文 http 镜像可篡改下载载荷，已拒绝）".to_string(),
        );
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
        if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || label.starts_with('-')
            || label.ends_with('-')
        {
            return Err(format!("镜像域名含非法字符：{host}"));
        }
    }
    // TLD 必须含字母：拒绝裸 IP 形态的“镜像”（常见钓鱼面）。
    if !labels[labels.len() - 1]
        .chars()
        .any(|c| c.is_ascii_alphabetic())
    {
        return Err(format!("镜像地址必须是域名（不接受裸 IP）：{host}"));
    }
    Ok(())
}

/// 底层前缀原语（唯一）：`base` 去尾斜杠后当前缀拼接；已套前缀返回原值。
/// 安装包镜像与官方默认清单镜像回退共用。
pub(crate) fn prefix_with_base(base: &str, raw_url: &str) -> String {
    let base = base.trim_end_matches('/');
    if raw_url.starts_with(base) {
        return raw_url.to_string();
    }
    format!("{base}/{raw_url}")
}

/// 下载 URL 解析结果：`bypass_proxy_host` 仅在 URL 经镜像前缀改写时为 `Some(镜像 host)`，
/// 下载器只把该 host 加入 per-client `no_proxy`；官方直连（`None`）完整继承系统代理。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDownloadUrl {
    pub url: String,
    pub bypass_proxy_host: Option<String>,
}

impl ResolvedDownloadUrl {
    fn direct(raw_url: &str) -> Self {
        Self {
            url: raw_url.to_string(),
            bypass_proxy_host: None,
        }
    }

    fn mirrored(prefix: &str, raw_url: &str) -> Self {
        Self {
            url: prefix_with_base(prefix, raw_url),
            bypass_proxy_host: crate::proxy::host_of_url(prefix),
        }
    }

    /// 下载 Client 的 `extra_hosts`：仅实际生效的镜像 host。
    pub fn bypass_hosts(&self) -> Vec<String> {
        self.bypass_proxy_host.iter().cloned().collect()
    }
}

/// 公共镜像兜底（`gh-proxy.com`）：非 GitHub 资产原样返回且不豁免任何 host。
pub fn wrap_gh_proxy_resolved(raw_url: &str) -> ResolvedDownloadUrl {
    if !is_github_domain(raw_url) {
        return ResolvedDownloadUrl::direct(raw_url);
    }
    ResolvedDownloadUrl::mirrored(DEFAULT_GH_PROXY, raw_url)
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

    pub fn active_summary(&self) -> String {
        match &self.custom_proxy {
            Some(p) if !p.trim().is_empty() && p.trim() != "direct" => {
                crate::log_support::host_of(p)
            }
            _ => "direct".to_string(),
        }
    }

    pub(crate) fn apply_initial_mirror(&mut self, id_or_url: &str) -> bool {
        self.set_active_mirror_inner(id_or_url, false)
    }

    pub fn set_active_mirror(&mut self, id_or_url: &str) -> bool {
        self.set_active_mirror_inner(id_or_url, true)
    }

    fn set_active_mirror_inner(&mut self, id_or_url: &str, emit_switch_info: bool) -> bool {
        let trimmed = id_or_url.trim();
        let (new_proxy, id) = if trimmed.is_empty() || trimmed == "direct" {
            (None, "direct")
        } else if trimmed == "ghproxy" {
            (Some(DEFAULT_GH_PROXY.to_string()), "custom")
        } else if let Err(reason) = validate_custom_proxy(trimmed) {
            // 自定义镜像准入失败（非 https / 非法域名）：拒绝切换保持现状并记录 WRN
            let mut ev = crate::z_log::WideEvent::new("network", "mirror rejected");
            ev.field("reason", crate::log_support::short_reason(&reason));
            ev.warn();
            return false;
        } else {
            (Some(trimmed.to_string()), "custom")
        };

        if self.custom_proxy == new_proxy {
            return true; // 状态未改变，幂等跳过，避免重复刷日志
        }
        self.custom_proxy = new_proxy;
        if emit_switch_info {
            let proxy_display = self.custom_proxy.as_deref().unwrap_or("direct");
            let mut ev = crate::z_log::WideEvent::new("network", "mirror switch");
            ev.field("id", id)
                .field("proxy", self.active_summary())
                .dev("endpoint", proxy_display);
            ev.info();
        }
        true
    }

    /// 当前生效的镜像前缀（`https://...`）；`direct` 返回 `None`。
    pub fn active_mirror_prefix(&self) -> Option<String> {
        self.custom_proxy
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty() && *p != "direct")
            .map(str::to_string)
    }

    /// 安装资产 URL 改写（仅安装包通道），同时给出需直连豁免的镜像 host。
    /// 仅 GitHub 链接走镜像；官方直连与非 GitHub 资产不豁免任何 host（继承系统代理）。
    pub fn rewrite_installer_asset_url_resolved(&self, raw_url: &str) -> ResolvedDownloadUrl {
        match self.active_mirror_prefix() {
            Some(prefix) if is_github_domain(raw_url) => {
                ResolvedDownloadUrl::mirrored(&prefix, raw_url)
            }
            _ => ResolvedDownloadUrl::direct(raw_url),
        }
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

    /// 测速豁免口径：测镜像节点时该镜像 host 直连（与下载器一致）；测「官方直连」时不豁免，
    /// 真实反映当前系统网络（含系统代理）到达 `github.com` 的延迟。
    fn latency_test_bypass_hosts(testing_mirror: bool, test_url: &str) -> Vec<String> {
        if testing_mirror {
            crate::proxy::proxy_hosts_for(test_url)
        } else {
            Vec::new()
        }
    }

    /// 单击测速：快速探测指定代理地址（或官方直连）的网络握手时延，并附带 HTTP 状态与实际测速 URL。
    pub async fn test_proxy_latency(
        proxy_url: Option<&str>,
    ) -> (bool, u32, String, Option<u16>, String) {
        let timeout_ms = crate::config::get_project_config().network.ping_timeout_ms;

        let clean_url = proxy_url
            .map(|s| s.trim())
            .filter(|s| !s.is_empty() && *s != "direct");

        let test_url = match clean_url {
            Some(p) => {
                // 测速与保存同一准入口径（https 强制 + 域名校验）：
                // 允许测 http 却存不进去只会制造困惑。
                if let Err(reason) = validate_custom_proxy(p) {
                    return (false, 9999, reason, None, String::new());
                }
                p.trim_end_matches('/').to_string()
            }
            None => "https://github.com".to_string(),
        };

        let extra_hosts = Self::latency_test_bypass_hosts(clean_url.is_some(), &test_url);
        let client = Self::ping_client(timeout_ms, &extra_hosts);

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
                    (
                        true,
                        elapsed.clamp(1, 4000),
                        format!("{} ms (连接正常)", elapsed),
                        Some(status),
                        test_url,
                    )
                } else {
                    (
                        false,
                        9999,
                        format!("HTTP 状态码异常: {}", status),
                        Some(status),
                        test_url,
                    )
                }
            }
            Err(e) => (
                false,
                9999,
                format!("连接失败或超时: {}", e),
                None,
                test_url,
            ),
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
        let direct = mm.rewrite_installer_asset_url_resolved(raw).url;
        assert_eq!(direct, raw);

        // 设置自定义代理
        mm.set_active_mirror("https://gh-proxy.com");
        let rewritten = mm.rewrite_installer_asset_url_resolved(raw).url;
        assert!(rewritten.starts_with("https://gh-proxy.com/https://github.com"));

        // 切换回直连
        mm.set_active_mirror("direct");
        let direct2 = mm.rewrite_installer_asset_url_resolved(raw).url;
        assert_eq!(direct2, raw);

        // 非 GitHub 域名直连验证
        let cb_url = "https://codeberg.org/attachments/a1b2c3d4-installer.exe";
        mm.set_active_mirror("https://gh-proxy.com");
        assert_eq!(mm.rewrite_installer_asset_url_resolved(cb_url).url, cb_url);
    }

    #[test]
    fn direct_mode_never_bypasses_upstream_forge_hosts() {
        let gh = "https://github.com/o/r/releases/download/v1/a.msi";
        let cb = "https://codeberg.org/o/r/releases/download/v1/a.AppImage";
        let mut mm = MirrorManager::new();

        // direct：不改写、不豁免，github.com 不进入 no_proxy（继承系统代理）。
        let r = mm.rewrite_installer_asset_url_resolved(gh);
        assert_eq!(r.url, gh);
        assert_eq!(r.bypass_proxy_host, None);
        assert!(r.bypass_hosts().is_empty());
        let snap = crate::test_support::proxied_snapshot("http://127.0.0.1:7890");
        let merged = crate::proxy::merged_no_proxy_for(&snap, &r.bypass_hosts());
        assert!(!merged.to_ascii_lowercase().contains("github.com"), "{merged}");
        assert_eq!(mm.active_mirror_prefix(), None);

        // 非 GitHub 资产：direct / ghproxy 两档均不豁免 codeberg.org。
        assert_eq!(mm.rewrite_installer_asset_url_resolved(cb).bypass_proxy_host, None);
        mm.set_active_mirror("ghproxy");
        let r_cb = mm.rewrite_installer_asset_url_resolved(cb);
        assert_eq!(r_cb.url, cb);
        assert_eq!(r_cb.bypass_proxy_host, None);
        assert_eq!(wrap_gh_proxy_resolved(cb).bypass_proxy_host, None);

        // 镜像改写：仅豁免镜像 host。
        let r2 = mm.rewrite_installer_asset_url_resolved(gh);
        assert!(r2.url.starts_with("https://gh-proxy.com/https://github.com/"));
        assert_eq!(r2.bypass_proxy_host.as_deref(), Some("gh-proxy.com"));
        assert_eq!(mm.active_mirror_prefix().as_deref(), Some(DEFAULT_GH_PROXY));
        mm.set_active_mirror("https://mirror.example.com/");
        assert_eq!(
            mm.rewrite_installer_asset_url_resolved(gh)
                .bypass_proxy_host
                .as_deref(),
            Some("mirror.example.com")
        );

        let w = wrap_gh_proxy_resolved(gh);
        assert_eq!(w.url, format!("{DEFAULT_GH_PROXY}/{gh}"));
        assert_eq!(w.bypass_proxy_host.as_deref(), Some("gh-proxy.com"));
    }

    #[test]
    fn latency_test_only_bypasses_tested_mirror() {
        assert!(MirrorManager::latency_test_bypass_hosts(false, "https://github.com").is_empty());
        assert_eq!(
            MirrorManager::latency_test_bypass_hosts(true, "https://gh-proxy.com"),
            vec!["gh-proxy.com".to_string()]
        );
    }

    #[test]
    fn test_switch_mirror() {
        let mut mm = MirrorManager::new();
        assert!(mm.set_active_mirror("https://gh-proxy.com"));
        assert_eq!(mm.custom_proxy.as_deref(), Some("https://gh-proxy.com"));
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
        // 缺 scheme 的字符串按拒绝处理（调用方传入完整 URL）
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
        assert_eq!(mm.custom_proxy.as_deref(), Some("https://gh-proxy.com"));
    }

    #[tokio::test]
    async fn test_proxy_ping() {
        let (ok, latency, msg, _, _) = MirrorManager::test_proxy_latency(None).await;
        log::debug!("PING DIRECT: ok={}, lat={}, msg={}", ok, latency, msg);
    }
}
