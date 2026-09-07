use crate::models::MirrorNodeStatus;
use std::time::Instant;

pub struct MirrorManager {
    // 默认为 None，表示 GitHub 官方直连；
    // 用户可指定加速代理前缀（例如 "https://gh-proxy.com"）
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

    pub fn get_proxy_url(&self) -> Option<String> {
        self.custom_proxy.clone()
    }

    pub fn set_proxy_url(&mut self, url: Option<String>) {
        self.custom_proxy = url
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "direct");
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
                    format!("自定义代理 ({})", proxy_url.trim_start_matches("https://").trim_start_matches("http://"))
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
        if trimmed.is_empty() || trimmed == "direct" {
            self.custom_proxy = None;
            true
        } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            self.custom_proxy = Some(trimmed.to_string());
            true
        } else if trimmed == "ghproxy" {
            self.custom_proxy = Some("https://gh-proxy.com".to_string());
            true
        } else {
            self.custom_proxy = None;
            true
        }
    }

    pub fn rewrite_download_url(&self, raw_url: &str) -> String {
        let proxy = match &self.custom_proxy {
            Some(p) if !p.trim().is_empty() && p.trim() != "direct" => p.trim(),
            _ => return raw_url.to_string(), // 默认为官方直连，无需任何重写
        };

        // 仅对 GitHub 官方链接及 Releases 资产应用镜像代理；
        // Codeberg、Gitea、GitLab 等其它平台保持官方直连
        let is_github_url = raw_url.contains("github.com")
            || raw_url.contains("githubusercontent.com")
            || raw_url.contains("github-releases");

        if !is_github_url {
            return raw_url.to_string();
        }

        let base = proxy.trim_end_matches('/');
        if raw_url.starts_with(base) {
            return raw_url.to_string();
        }
        format!("{}/{}", base, raw_url)
    }

    /// 单击测速：快速探测指定代理地址（或官方直连）的网络握手时延
    pub async fn test_proxy_latency(proxy_url: Option<&str>) -> (bool, u32, String) {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(4000))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_default();

        let clean_url = proxy_url
            .map(|s| s.trim())
            .filter(|s| !s.is_empty() && *s != "direct");

        let test_url = match clean_url {
            Some(p) => {
                if !p.starts_with("http://") && !p.starts_with("https://") {
                    return (false, 9999, "代理地址格式需以 http:// 或 https:// 开头".to_string());
                }
                p.trim_end_matches('/').to_string()
            }
            None => "https://github.com".to_string(),
        };

        let start = Instant::now();
        let mut resp = client.head(&test_url).send().await;
        if resp.is_err() || resp.as_ref().map(|r| r.status().as_u16() == 405).unwrap_or(false) {
            resp = client.get(&test_url).send().await;
        }
        let elapsed = start.elapsed().as_millis() as u32;

        match resp {
            Ok(res) => {
                let status = res.status().as_u16();
                if status < 500 {
                    (true, elapsed.clamp(1, 4000), format!("{} ms (连接正常)", elapsed))
                } else {
                    (false, 9999, format!("HTTP 状态码异常: {}", status))
                }
            }
            Err(e) => (false, 9999, format!("连接失败或超时: {}", e)),
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
        let direct = mm.rewrite_download_url(raw);
        assert_eq!(direct, raw);

        // 设置自定义代理
        mm.set_active_mirror("https://gh-proxy.com");
        let rewritten = mm.rewrite_download_url(raw);
        assert!(rewritten.starts_with("https://gh-proxy.com/https://github.com"));

        // 切换回直连
        mm.set_active_mirror("direct");
        let direct2 = mm.rewrite_download_url(raw);
        assert_eq!(direct2, raw);

        // 非 GitHub 域名直连验证
        let cb_url = "https://codeberg.org/attachments/a1b2c3d4-installer.exe";
        mm.set_active_mirror("https://gh-proxy.com");
        assert_eq!(mm.rewrite_download_url(cb_url), cb_url);
    }

    #[test]
    fn test_switch_mirror() {
        let mut mm = MirrorManager::new();
        assert!(mm.set_active_mirror("https://gh-proxy.com"));
        let nodes = mm.get_mirror_statuses();
        let custom = nodes.iter().find(|n| n.id == "custom").unwrap();
        assert!(custom.is_active);
    }

    #[tokio::test]
    async fn test_proxy_ping() {
        let (ok, latency, msg) = MirrorManager::test_proxy_latency(None).await;
        println!("PING DIRECT: ok={}, lat={}, msg={}", ok, latency, msg);
    }
}
