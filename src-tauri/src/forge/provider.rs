use futures_util::future::BoxFuture;

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

/// 三家 `classify_asset + as_str` 共用映射的唯一落点。
/// 调用方保留合法差异：GitLab permalink/latest 回退与 `direct_asset_url` 回退、
/// Gitea `assets: Option` 的 `unwrap_or_default`，此处只做 `(name, url, size)` -> `ReleaseAsset` 纯映射。
pub(crate) fn parse_assets(
    items: impl IntoIterator<Item = (String, String, u64)>,
) -> Vec<ReleaseAsset> {
    items
        .into_iter()
        .map(|(name, download_url, size_bytes)| {
            let (kind, os, arch) = classify_asset_fields(&name);
            ReleaseAsset {
                name,
                download_url,
                size_bytes,
                sha256: None,
                os,
                arch,
                kind,
            }
        })
        .collect()
}

/// 单资产分类唯一落点（msix/setup_exe 双轨合一）：`InstallerEngine::classify_asset`
/// 基础上，`.msix` 特判保留 `setup_exe` kind（classify 归 Other）、`os=all` 归 `windows`。
/// forge `parse_assets` 与 GitHub 详情 `build_release_assets` 共用，forge 资产自此同样享受。
/// 返回 `(kind_str, os, arch)`，均已 String 化供 `ReleaseAsset` 直填。
pub(crate) fn classify_asset_fields(name: &str) -> (String, String, String) {
    let is_msix = name.to_lowercase().ends_with(".msix");
    let (kind, os, arch) = InstallerEngine::classify_asset(name);
    let kind_str = match &kind {
        crate::installer::AssetKind::Other if is_msix => "setup_exe",
        _ => kind.as_str(),
    };
    let os_str = if os == "all" && is_msix {
        "windows"
    } else {
        os
    };
    (kind_str.to_string(), os_str.to_string(), arch.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeReleaseInfo {
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub assets: Vec<ReleaseAsset>,
}

/// Forge provider 抽象（ADR-0006）。async 方法以 boxed future 返回（`BoxFuture`），
/// 使 trait 对象安全：Registry 持 `Box<dyn ForgeProvider>` 唯一注册表分发，
/// 不再按 ForgeType 三段 match 复制。
pub trait ForgeProvider: Send + Sync {
    fn forge_type(&self) -> ForgeType;

    fn fetch_repo<'a>(
        &'a self,
        host: &'a str,
        owner: &'a str,
        repo: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ForgeRepoInfo, String>>;

    fn fetch_latest_release<'a>(
        &'a self,
        host: &'a str,
        owner: &'a str,
        repo: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ForgeReleaseInfo, String>>;

    fn search_repos<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        token: Option<&'a str>,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> BoxFuture<'a, Result<Vec<ForgeRepoInfo>, String>>;
}

// forge 本地 `AssetKind -> &str` 由 `installer::AssetKind::as_str()` 表驱动
// （见 `installer/mod.rs`）。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_asset_fields_msix_special_case() {
        // .msix：classify 归 Other（末分支硬编码 os=all/arch=universal）→
        // kind 保留 setup_exe、os 归 windows；arch 保持 classify 原值。
        let (kind, os, arch) = classify_asset_fields("App.Package_1.2.3_x64.msix");
        assert_eq!(kind, "setup_exe");
        assert_eq!(os, "windows");
        assert_eq!(arch, "universal");

        // 常规 exe（SetupExe）：不受特判影响。
        let (kind, os, _) = classify_asset_fields("setup-x64.exe");
        assert_eq!(kind, "setup_exe");
        assert_eq!(os, "windows");

        // 非 msix 的 Other（未知扩展）：保持 Other + 原始 os/arch。
        let (kind, os, arch) = classify_asset_fields("app.unknown-ext");
        assert_eq!(kind, "other");
        assert_eq!(os, "all");
        assert_eq!(arch, "universal");
    }
}
