use super::coord::ForgeType;
use crate::installer::InstallerEngine;
use crate::models::ReleaseAsset;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeRepoInfo {
    pub name: String,
    pub description: Option<String>,
    pub stars: u64,
    pub forks: u64,
    pub language: Option<String>,
    pub default_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
}

impl ForgeRepoInfo {
    /// 各 forge `*_count` 可选计数的统一收敛点：`None` 归零、
    /// `default_branch` 缺省为 `main`、空 `homepage` 归一为 `None`。
    pub fn from_counts(
        name: String,
        description: Option<String>,
        stars: Option<u64>,
        forks: Option<u64>,
        language: Option<String>,
        default_branch: Option<String>,
        homepage: Option<String>,
    ) -> Self {
        Self {
            name,
            description,
            stars: stars.unwrap_or(0),
            forks: forks.unwrap_or(0),
            language,
            default_branch: default_branch.unwrap_or_else(|| "main".to_string()),
            homepage: homepage.filter(|h| !h.trim().is_empty()),
        }
    }
}

/// 三家 `classify_asset + as_str` 闭包逐字相同段的唯一收敛点。
/// 调用方保留合法差异：GitLab permalink/latest 回退与 `direct_asset_url` 回退、
/// Gitea `assets: Option` 的 `unwrap_or_default`，此处只做 `(name, url, size)` -> `ReleaseAsset` 纯映射。
pub(crate) fn parse_assets(
    items: impl IntoIterator<Item = (String, String, u64)>,
) -> Vec<ReleaseAsset> {
    items
        .into_iter()
        .map(|(name, download_url, size_bytes)| {
            let (kind, os, arch) = InstallerEngine::classify_asset(&name);
            let kind_str = kind.as_str();
            ReleaseAsset {
                name,
                download_url,
                size_bytes,
                sha256: None,
                os: os.to_string(),
                arch: arch.to_string(),
                kind: kind_str.to_string(),
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeReleaseInfo {
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub assets: Vec<ReleaseAsset>,
}

#[allow(async_fn_in_trait)]
pub trait ForgeProvider: Send + Sync {
    fn forge_type(&self) -> ForgeType;

    async fn fetch_repo(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String>;

    async fn fetch_latest_release(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String>;

    async fn search_repos(
        &self,
        host: &str,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<ForgeRepoInfo>, String>;
}

// 注：forge 本地 `AssetKind -> &str` 已收敛至 `installer::AssetKind::as_str()`
// （见 `installer/mod.rs`），此处不再保留重复映射。
