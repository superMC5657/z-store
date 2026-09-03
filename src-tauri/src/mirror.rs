use crate::models::MirrorNodeStatus;
use std::time::Instant;

pub struct MirrorManager {
    nodes: Vec<MirrorNodeStatus>,
    active_id: String,
}

impl Default for MirrorManager {
    fn default() -> Self {
        Self::new()
    }
}

impl MirrorManager {
    pub fn new() -> Self {
        let nodes = vec![
            MirrorNodeStatus {
                id: "ghproxy".to_string(),
                name: "GH-Proxy 加速线路 (华东/华南优质)".to_string(),
                base_url: "https://gh-proxy.com".to_string(),
                latency_ms: 38,
                is_active: true,
            },
            MirrorNodeStatus {
                id: "gitmirror".to_string(),
                name: "GitMirror 备用线路 (华北/西北推荐)".to_string(),
                base_url: "https://hub.gitmirror.com".to_string(),
                latency_ms: 72,
                is_active: false,
            },
            MirrorNodeStatus {
                id: "direct".to_string(),
                name: "GitHub 官方直连线路 (海外/科学上网)".to_string(),
                base_url: "https://github.com".to_string(),
                latency_ms: 240,
                is_active: false,
            },
        ];

        Self {
            nodes,
            active_id: "ghproxy".to_string(),
        }
    }

    pub fn get_mirror_statuses(&self) -> Vec<MirrorNodeStatus> {
        self.nodes.clone()
    }

    pub fn set_active_mirror(&mut self, id: &str) -> bool {
        let mut found = false;
        for node in &mut self.nodes {
            if node.id == id {
                node.is_active = true;
                self.active_id = id.to_string();
                found = true;
            } else {
                node.is_active = false;
            }
        }
        found
    }

    pub fn rewrite_download_url(&self, raw_url: &str) -> String {
        if self.active_id == "direct" {
            return raw_url.to_string();
        }

        // 仅针对 GitHub 官方域名及其 CDN 启用 GitHub 镜像代理；
        // Codeberg、Gitea、GitLab 及自建实例保持官方直连，避免被 GitHub 代理返回 400/404 错误
        let is_github_url = raw_url.contains("github.com")
            || raw_url.contains("githubusercontent.com")
            || raw_url.contains("github-releases");

        if !is_github_url {
            return raw_url.to_string();
        }

        if let Some(active_node) = self.nodes.iter().find(|n| n.id == self.active_id) {
            let base = active_node.base_url.trim_end_matches('/');
            if raw_url.starts_with(base) {
                return raw_url.to_string();
            }
            format!("{}/{}", base, raw_url)
        } else {
            raw_url.to_string()
        }
    }

    pub async fn ping_nodes(mut nodes: Vec<MirrorNodeStatus>) -> Vec<MirrorNodeStatus> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(3000))
            .user_agent("ZStore-Ping/0.1.0")
            .build()
            .unwrap_or_default();

        for node in &mut nodes {
            let start = Instant::now();
            let test_url = if node.id == "direct" {
                "https://api.github.com".to_string()
            } else {
                format!(
                    "{}/https://raw.githubusercontent.com",
                    node.base_url.trim_end_matches('/')
                )
            };

            let resp = client.head(&test_url).send().await;
            let elapsed = start.elapsed().as_millis() as u32;

            if resp.is_ok() {
                node.latency_ms = elapsed.clamp(10, 999);
            } else {
                node.latency_ms = 999;
            }
        }

        nodes
    }

    pub fn update_latencies(&mut self, latencies: &[(String, u32)]) {
        for (id, lat) in latencies {
            if let Some(node) = self.nodes.iter_mut().find(|n| &n.id == id) {
                node.latency_ms = *lat;
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

        let rewritten = mm.rewrite_download_url(raw);
        assert!(rewritten.starts_with("https://gh-proxy.com/https://github.com"));

        mm.set_active_mirror("direct");
        let direct = mm.rewrite_download_url(raw);
        assert_eq!(direct, raw);

        // Codeberg / Gitea 非 GitHub 域名直连验证
        let cb_url = "https://codeberg.org/attachments/a1b2c3d4-installer.exe";
        mm.set_active_mirror("ghproxy");
        assert_eq!(mm.rewrite_download_url(cb_url), cb_url);
    }

    #[test]
    fn test_switch_mirror() {
        let mut mm = MirrorManager::new();
        assert!(mm.set_active_mirror("gitmirror"));
        let nodes = mm.get_mirror_statuses();
        let gm = nodes.iter().find(|n| n.id == "gitmirror").unwrap();
        assert!(gm.is_active);
    }
}
