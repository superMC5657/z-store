use super::coord::ForgeType;
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

/// forge 本地 `AssetKind -> &str` 收敛点（不碰 `installer/mod.rs`）。
/// 语义与各 provider 内旧 `match kind { ... }` 完全一致。
pub trait AssetKindExt {
    fn as_str(&self) -> &'static str;
}

impl AssetKindExt for crate::installer::AssetKind {
    fn as_str(&self) -> &'static str {
        match self {
            crate::installer::AssetKind::Msi => "msi",
            crate::installer::AssetKind::SetupExe => "setup_exe",
            crate::installer::AssetKind::PortableZip => "portable_zip",
            crate::installer::AssetKind::Deb => "deb",
            crate::installer::AssetKind::Rpm => "rpm",
            crate::installer::AssetKind::AppImage => "appimage",
            crate::installer::AssetKind::Dmg => "dmg",
            crate::installer::AssetKind::Pkg => "pkg",
            crate::installer::AssetKind::Apk => "apk",
            crate::installer::AssetKind::Other => "other",
        }
    }
}
