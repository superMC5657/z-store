//! 开源广场（Launchpad）远端清单信封与前端出站模型（字段一律 snake_case）。

use crate::models::{AppCore, AppSummary};
use serde::{Deserialize, Serialize};

/// `launchpad.json` 远端信封（`version: 1`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RawLaunchpadManifest {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discussions_repo: Option<String>,
    #[serde(default)]
    pub pinned: Vec<RawLaunchpadPin>,
    #[serde(default)]
    pub items: Vec<RawLaunchpadItem>,
}

/// 置顶槽位：`id` 引用 `items` 中的规范标识。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RawLaunchpadPin {
    pub id: String,
    pub pin_until: String,
    #[serde(default)]
    pub pin_tier: String,
    #[serde(default)]
    pub pin_order: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchpadMaker {
    #[serde(default)]
    pub login: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: String,
    #[serde(default)]
    pub html_url: String,
}

/// 远端单条新品元数据；缺省字段宽松回落，单条脏数据不拖垮整页。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RawLaunchpadItem {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub forge: String,
    #[serde(default)]
    pub forge_host: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub icon_bg: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_en: Option<String>,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub category_name: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub latest_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_release_at: Option<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default)]
    pub maker_note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maker_note_en: Option<String>,
    #[serde(default)]
    pub maker: LaunchpadMaker,
    #[serde(default)]
    pub launched_at: String,
    #[serde(default)]
    pub stars: u64,
    #[serde(default)]
    pub stars_7d_delta: i64,
    #[serde(default)]
    pub forks: u64,
    #[serde(default)]
    pub discussion_repo: String,
    #[serde(default)]
    pub discussion_number: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discussion_node_id: Option<String>,
    #[serde(default)]
    pub discussion_url: String,
    #[serde(default)]
    pub discussion_comments_count: u64,
    #[serde(default)]
    pub discussion_upvotes: u64,
}

/// 前端出站：广场卡片（内嵌全站通用 `AppSummary`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchpadEntry {
    pub summary: AppSummary,
    pub maker_note: String,
    #[serde(default)]
    pub maker_note_en: Option<String>,
    pub maker: LaunchpadMaker,
    pub launched_at: String,
    #[serde(default)]
    pub latest_release_at: Option<String>,
    pub stars_7d_delta: i64,
    pub discussion_repo: String,
    pub discussion_number: u64,
    #[serde(default)]
    pub discussion_node_id: Option<String>,
    pub discussion_url: String,
    pub discussion_comments_count: u64,
    pub discussion_upvotes: u64,
    pub is_pinned: bool,
    #[serde(default)]
    pub pin_until: Option<String>,
    #[serde(default)]
    pub pin_tier: Option<String>,
    pub viewer_has_starred: bool,
}

/// `get_launchpad_feed` 响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchpadFeedResponse {
    pub spotlight: Vec<LaunchpadEntry>,
    pub items: Vec<LaunchpadEntry>,
    pub discussions_repo: String,
    pub submit_issue_url: String,
    pub submit_web_url: String,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub cached_at: Option<i64>,
    pub is_stale: bool,
}

pub(crate) fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

impl RawLaunchpadItem {
    /// 投影为全站卡片摘要（`canonical_id` 须为已归一的规范标识；图标剥离 `data:`）。
    pub(crate) fn to_summary(&self, canonical_id: &str) -> AppSummary {
        let forge = self.forge.trim().to_lowercase();
        let forge = if forge.is_empty() {
            "github".to_string()
        } else {
            forge
        };
        let host = self.forge_host.trim();
        let version = self.latest_version.trim();
        let name = self.name.trim();
        AppSummary {
            core: AppCore {
                id: canonical_id.to_string(),
                name: if name.is_empty() {
                    self.repo.trim().to_string()
                } else {
                    name.to_string()
                },
                description_en: non_empty(&self.description_en),
                owner: self.owner.trim().to_string(),
                repo: self.repo.trim().to_string(),
                icon: super::sanitize_icon(&self.icon),
                icon_bg: self.icon_bg.trim().to_string(),
                description: self.description.trim().to_string(),
                stars: self.stars,
                forks: self.forks,
                license: self.license.trim().to_string(),
                latest_version: if version.is_empty() {
                    "latest".to_string()
                } else {
                    version.to_string()
                },
                category: self.category.trim().to_string(),
                category_name: self.category_name.trim().to_string(),
                is_verified: false,
                forge: Some(forge),
                forge_host: (!host.is_empty()).then(|| host.to_string()),
                homepage: non_empty(&self.homepage),
                platforms: super::normalize_platforms(&self.platforms),
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
            },
        }
    }
}
