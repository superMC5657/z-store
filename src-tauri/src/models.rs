use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSummary {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub repo: String,
    pub icon: String,
    pub icon_bg: String,
    pub description: String,
    pub stars: u64,
    pub forks: u64,
    pub license: String,
    pub latest_version: String,
    pub category: String,
    pub category_name: String,
    pub is_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_installed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_update: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub download_url: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
    pub os: String,
    pub arch: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppDetail {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub repo: String,
    pub icon: String,
    pub icon_bg: String,
    pub description: String,
    pub stars: u64,
    pub forks: u64,
    pub license: String,
    pub latest_version: String,
    pub changelog: String,
    pub is_verified: bool,
    pub signature_fingerprint: Option<String>,
    pub readme_markdown: String,
    pub releases: Vec<ReleaseAsset>,
    pub category: String,
    pub category_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledApp {
    pub app_id: String,
    pub app_name: String,
    pub version: String,
    pub installed_at: i64,
    pub install_method: String,
    pub install_path: String,
    pub asset_name: String,
    pub asset_sha256: String,
    pub uninstall_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorNodeStatus {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub latency_ms: u32,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateItem {
    pub app_id: String,
    pub app_name: String,
    pub current_version: String,
    pub latest_version: String,
    pub changelog: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressPayload {
    pub task_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub state: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateRule {
    pub app_id: String,
    pub skipped_version: Option<String>,
    pub is_frozen: bool,
    pub is_hidden: bool,
    pub updated_at: i64,
}
