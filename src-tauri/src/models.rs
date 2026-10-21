use serde::{Deserialize, Serialize};

/// `AppSummary` / `AppDetail` 公共子结构（22 字段单一来源，新增公共字段只改此处）。
/// 两结构经 `#[serde(flatten)]` 内嵌，序列化仍为平面 JSON（字段名与 serde attrs
/// 逐字沿用拆分前），IPC 与缓存契约不变；Rust 侧访问经 `x.core.<field>`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppCore {
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
    pub forge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forge_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub platforms: Vec<String>,
    /// 收录态（后端目录投影时盖章）：`Some(true)` 表示远端精选或本地收录命中。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_cataloged: Option<bool>,
    /// 目录来源：`remote`（远端精选）/ `local`（本地收录补位），未收录即缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 本地收录行状态（`collected` 系），仅供徽标判定，远端行为缺席。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSummary {
    #[serde(flatten)]
    pub core: AppCore,
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
    #[serde(flatten)]
    pub core: AppCore,
    pub changelog: String,
    pub readme_markdown: String,
    /// README 多语言变体：`get_readme_variants` 按需回填，缺失即 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme_variants: Option<Vec<ReadmeVariant>>,
    pub releases: Vec<ReleaseAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_at: Option<i64>,
    /// stale 契约：`Some(true)` = 瞬时失败降级（401/限流/离线复用旧行，或无缓存合成空）。
    /// 前端 backfill 必须将 `stale + releases/platforms 双空` 视为 loading/失败待重试，
    /// 永不确认 Other；`Ok(stale)` 为 IPC 形状约定。成功 deduce 空（真实零发布）
    /// 保持 `None`，与失败空可区分。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_stale: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadmeVariant {
    pub lang: String,
    pub path: String,
    pub markdown: String,
}

#[cfg(test)]
mod app_core_tests {
    use super::*;

    /// 平面 JSON 契约回归：`AppCore` 经 `#[serde(flatten)]` 内嵌后，
    /// 序列化不得出现 `core` 包装键，旧平面载荷必须原样可反序列化（IPC/缓存两用）。
    #[test]
    fn app_summary_detail_serialize_flat_and_deserialize_legacy_payload() {
        let detail = AppDetail {
            core: AppCore {
                id: "o/r".to_string(),
                name: "n".to_string(),
                description_en: Some("en".to_string()),
                owner: "o".to_string(),
                repo: "r".to_string(),
                icon: "i".to_string(),
                icon_bg: "g".to_string(),
                description: "d".to_string(),
                stars: 1,
                forks: 2,
                license: "MIT".to_string(),
                latest_version: "v1".to_string(),
                category: "dev".to_string(),
                category_name: "dev".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: vec!["windows".to_string()],
                is_cataloged: Some(true),
                source: Some("local".to_string()),
                status: Some("collected".to_string()),
            },
            changelog: "c".to_string(),
            readme_markdown: "m".to_string(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        };
        let summary = AppSummary {
            core: detail.core.clone(),
        };

        let sv: serde_json::Value = serde_json::to_value(&summary).unwrap();
        let dv: serde_json::Value = serde_json::to_value(&detail).unwrap();
        assert!(sv.get("core").is_none(), "AppSummary 序列化出现 core 包装键");
        assert!(dv.get("core").is_none(), "AppDetail 序列化出现 core 包装键");
        assert_eq!(sv["id"], "o/r");
        assert_eq!(sv["status"], "collected");
        assert_eq!(sv["is_cataloged"], true);
        assert_eq!(dv["changelog"], "c");

        // 平面载荷（无 core 键、缺 Option 字段）经同一反序列化入口原样可读。
        let legacy_summary: AppSummary = serde_json::from_str(
            r#"{"id":"o/r","name":"n","owner":"o","repo":"r","icon":"i","icon_bg":"g",
                "description":"d","stars":1,"forks":2,"license":"MIT","latest_version":"v1",
                "category":"dev","category_name":"dev","is_verified":false,"platforms":["windows"]}"#,
        )
        .unwrap();
        assert_eq!(legacy_summary.core.id, "o/r");
        assert_eq!(legacy_summary.core.is_cataloged, None);
        assert_eq!(legacy_summary.core.source, None);
        let legacy_detail: AppDetail = serde_json::from_str(
            r#"{"id":"o/r","name":"n","owner":"o","repo":"r","icon":"i","icon_bg":"g",
                "description":"d","stars":1,"forks":2,"license":"MIT","latest_version":"v1",
                "category":"dev","category_name":"dev","is_verified":false,"platforms":["windows"],
                "changelog":"c","readme_markdown":"m","releases":[]}"#,
        )
        .unwrap();
        assert_eq!(legacy_detail.core.latest_version, "v1");
        assert_eq!(legacy_detail.is_stale, None);
    }
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
///   前端必须视为 loading/待 backfill-loading，永不确认 Other；成功空（真实零发布）保持 `None`。
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
    /// 列表截断标记：仓库列表单次拉取 `DEVELOPER_REPOS_PAGE_SIZE` 条无翻页，
    /// `public_repos` 大于实际返回行数即 `true`——前端据此标注截断，不伪装全量。
    #[serde(default)]
    pub repos_truncated: bool,
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

/// `refresh_host_rate_limit` 的 IPC 响应：host + 配额三元组 + 时间戳。
/// 令牌字段结构性缺席——凭据只经 oauth 专用命令读写，不随配额刷新面回传 webview。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostRateLimitRefresh {
    pub host: String,
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
    /// 收录标记：写入时按内存目录判定一次并持久化，存量行由启动回填校准；
    /// 前端据此决定走收录库还是 `app_details_cache` 读卡（`default` 兼容旧快照）。
    #[serde(default)]
    pub is_cataloged: bool,
}

/// 收藏条目（含收录标记）：`get_favorite_entries` 返回形状；
/// `get_favorites` 返回 `Vec<String>`（不含收录标记的轻量形状）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FavoriteEntry {
    pub app_id: String,
    /// 收录标记：语义与 `WatchedApp::is_cataloged` 一致。
    #[serde(default)]
    pub is_cataloged: bool,
    pub favorited_at: i64,
}

/// 应用内关注更新通知事件（`zstore://watch-updated`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WatchUpdatedPayload {
    pub app_id: String,
    pub version: String,
}

/// OAuth Device 轮询结果：`pending` | `authorized` | `expired` | `denied` | `error`。
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
}

pub use crate::deeplink::DeepLinkAction;
