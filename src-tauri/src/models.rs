use serde::{Deserialize, Serialize};

pub use crate::store_meta::StoreMeta;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
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
    #[serde(alias = "assets")]
    pub releases: Vec<ReleaseAsset>,
    pub category: String,
    pub category_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_stale_fallback: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    /// `z-store.toml` 解析产物（FR-8.1）；缺失文件时为 None，前端用仓库数据兜底。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_meta: Option<StoreMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCatalogResult {
    pub updated: bool,
    pub count: usize,
    pub message: String,
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
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_bg: Option<String>,
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
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_bg: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeveloperProfile {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
    pub html_url: String,
    pub bio: Option<String>,
    pub company: Option<String>,
    pub blog: Option<String>,
    pub location: Option<String>,
    pub public_repos: u64,
    pub followers: u64,
    pub following: u64,
    pub repos: Vec<DeveloperRepoItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeveloperRepoItem {
    pub id: String,
    pub name: String,
    pub full_name: String,
    pub description: Option<String>,
    pub html_url: String,
    pub stars: u64,
    pub forks: u64,
    pub language: Option<String>,
    pub has_releases: bool,
    pub in_catalog: bool,
    pub latest_release_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StarredSyncResult {
    pub total_starred: usize,
    pub catalog_matches: Vec<AppSummary>,
    pub other_repos: Vec<DeveloperRepoItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostTokenEntry {
    pub host: String,
    pub token: String,
    pub rate_limit_remaining: Option<u32>,
    pub rate_limit_limit: Option<u32>,
    pub rate_limit_reset: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostRateLimitStatus {
    pub host: String,
    pub is_connected: bool,
    pub rate_limit_remaining: Option<u32>,
    pub rate_limit_limit: Option<u32>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostQuotaEvent {
    pub host: String,
    pub rate_limit_remaining: Option<u32>,
    pub rate_limit_limit: Option<u32>,
    pub rate_limit_reset: Option<i64>,
}

/// 关注的应用（FR-6.2）：应用内更新通知订阅。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WatchedApp {
    pub app_id: String,
    pub added_at: i64,
    pub last_notified_version: Option<String>,
}

/// 应用内关注更新通知事件（`zstore://watch-updated`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WatchUpdatedPayload {
    pub app_id: String,
    pub version: String,
}

/// OAuth Device 轮询结果：`pending` | `authorized` | `error`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevicePollResult {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 用户数据导入结果（合并式，仅计数）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportUserDataResult {
    pub favorites_added: usize,
    pub watched_added: usize,
    pub settings_applied: usize,
    pub installed_skipped: usize,
}

pub use crate::deeplink::DeepLinkAction;


