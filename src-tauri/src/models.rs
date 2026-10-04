use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSummary {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_en: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forge_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_en: Option<String>,
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
    pub readme_markdown: String,
    /// README 多语言变体（`get_readme_variants` 按需拉取后可回填）。
    /// `#[serde(default)]` 保证旧 `detail_json`（无此字段）反序列化不炸，零 migration。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme_variants: Option<Vec<ReadmeVariant>>,
    pub releases: Vec<ReleaseAsset>,
    pub category: String,
    pub category_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forge_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_at: Option<i64>,
    /// P0 stale 契约：`Some(true)` = 瞬时失败降级（401/限流/离线复用旧行，或无缓存合成空）。
    /// 前端 backfill 必须将 `stale + releases/platforms 双空` 视为 pending/失败待重试，
    /// 永不确认 Other；`Ok(stale)` 形状为 IPC 兼容保留。成功 deduce 空（真实零发布）
    /// 保持 `None`，与失败空可区分。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_stale: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub platforms: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadmeVariant {
    pub lang: String,
    pub path: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadmeVariantsResponse {
    pub variants: Vec<ReadmeVariant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCatalogResult {
    pub updated: bool,
    pub count: usize,
    pub message: String,
}

/// 平台轻量回填结果（`get_platforms_lite`）：仅 `releases/latest` 单次条件请求推导，
/// 无 README/图标探测/checksum 开销。
/// - `platforms` 为空表示未知（unknown），永不 stamp `["other"]`/`["windows"]`，
///   `other` 仍为纯前端虚拟概念，永不过 IPC；
/// - `is_stale == Some(true)` 为瞬时失败降级（401/限流/离线复用旧行，或无缓存合成空），
///   前端必须视为 pending/待 backfill，永不确认 Other；成功空（真实零发布）保持 `None`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformsLiteResult {
    pub id: String,
    pub platforms: Vec<String>,
    pub from_cache: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_stale: Option<bool>,
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

impl DownloadProgressPayload {
    pub const EVENT_NAME: &str = "zstore://download-progress";

    pub fn emit(&self, app_handle: &tauri::AppHandle) {
        use tauri::Emitter;
        let _ = app_handle.emit(Self::EVENT_NAME, self);
    }

    pub fn emit_event(
        app_handle: &tauri::AppHandle,
        task_id: &str,
        downloaded_bytes: u64,
        total_bytes: u64,
        speed_bytes_per_sec: u64,
        state: &str,
        message: Option<String>,
    ) {
        Self {
            task_id: task_id.to_string(),
            downloaded_bytes,
            total_bytes,
            speed_bytes_per_sec,
            state: state.to_string(),
            message,
        }
        .emit(app_handle);
    }
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
