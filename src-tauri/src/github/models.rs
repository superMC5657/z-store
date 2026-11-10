use crate::models::{AppCore, AppSummary};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub repo: String,
    pub icon: String,
    pub icon_bg: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_en: Option<String>,
    pub category: String,
    pub category_name: String,
    pub aliases: Vec<String>,
    pub default_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
    pub license: String,
    pub stars: u64,
    pub forks: u64,
    pub is_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    // 字段顺序与 catalog.json 磁盘顺序对齐：homepage, install_dirs?,
    // search_subdirs?, publishers?, platforms, identifiers（identifiers 恒尾；
    // 空向量/None 经 skip_serializing_if 省略，与 catalog.json 省略空一致）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub install_dirs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub search_subdirs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub publishers: Vec<String>,
    pub platforms: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub identifiers: HashMap<String, Vec<String>>,
}

impl CatalogItem {
    /// 当前编译目标对应的平台键（与 catalog.json identifiers 的键对齐）。
    pub fn current_platform_key() -> &'static str {
        #[cfg(target_os = "windows")]
        {
            "windows"
        }
        #[cfg(target_os = "linux")]
        {
            "linux"
        }
        #[cfg(target_os = "macos")]
        {
            "macos"
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        {
            "windows"
        }
    }

    /// 获取指定平台原生标识符列表（如 windows / linux / macos / android / ios）
    pub fn get_identifiers(&self, platform: &str) -> Vec<String> {
        self.identifiers
            .get(platform)
            .filter(|list| !list.is_empty())
            .cloned()
            .unwrap_or_default()
    }

    /// 获取当前平台原生标识符列表（Windows 行为与 `get_identifiers("windows")` 完全一致；
    /// Linux 下优先取 `linux`，为空时把 `windows` 的 `.exe` 退化为裸名，避免 deb 应用嗅探恒空）。
    pub fn get_native_identifiers(&self) -> Vec<String> {
        let key = Self::current_platform_key();
        let native = self.get_identifiers(key);
        if !native.is_empty() {
            return native;
        }
        // 非 Windows 回退：windows 标识去扩展名后仍可用于 PATH/desktop 匹配。
        // Windows 自身直接返回空（exe_candidates(repo) 兜底语义）。
        if cfg!(target_os = "linux") {
            let win = self.get_identifiers("windows");
            if !win.is_empty() {
                return win
                    .into_iter()
                    .map(|s| {
                        let t = s.trim().to_string();
                        if t.to_lowercase().ends_with(".exe") {
                            t[..t.len() - 4].to_string()
                        } else {
                            t
                        }
                    })
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
        Vec::new()
    }

    pub fn to_summary(&self) -> AppSummary {
        let effective_icon =
            if self.icon.starts_with("http://") || self.icon.starts_with("https://") {
                self.icon.clone()
            } else {
                String::new()
            };

        let effective_platforms = self.platforms.clone();

        AppSummary {
            core: AppCore {
                id: self.id.clone(),
                name: self.name.clone(),
                description_en: self.description_en.clone(),
                owner: self.owner.clone(),
                repo: self.repo.clone(),
                icon: effective_icon,
                icon_bg: self.icon_bg.clone(),
                description: self.description.clone(),
                stars: self.stars,
                forks: self.forks,
                license: self.license.clone(),
                latest_version: self.default_version.clone(),
                category: self.category.clone(),
                category_name: self.category_name.clone(),
                is_verified: self.is_verified,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: self.homepage.clone(),
                platforms: effective_platforms,
                is_cataloged: None,
                source: None,
                status: None,
                added_at: self.added_at.clone(),
            },
        }
    }

    /// 用收录项最新精校元数据覆写详情核心字段（图标、分类、名称、摘要、收录时间）。
    pub fn overlay_detail_core(&self, core: &mut AppCore) {
        if self.description_en.is_some() {
            core.description_en = self.description_en.clone();
        }
        if !self.description.trim().is_empty() {
            core.description = self.description.clone();
        }
        if !self.icon.trim().is_empty() {
            core.icon = self.icon.clone();
        }
        if !self.icon_bg.trim().is_empty() {
            core.icon_bg = self.icon_bg.clone();
        }
        core.category = self.category.clone();
        core.category_name = self.category_name.clone();
        core.name = self.name.clone();
        if self.added_at.is_some() {
            core.added_at = self.added_at.clone();
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitHubUserResponse {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub html_url: Option<String>,
    pub bio: Option<String>,
    pub company: Option<String>,
    pub blog: Option<String>,
    pub location: Option<String>,
    pub public_repos: Option<u64>,
    pub followers: Option<u64>,
    pub following: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GitHubRepoResponse {
    pub name: Option<String>,
    pub full_name: Option<String>,
    pub html_url: Option<String>,
    pub description: Option<String>,
    pub stargazers_count: Option<u64>,
    pub forks_count: Option<u64>,
    pub language: Option<String>,
    pub license: Option<GitHubLicense>,
    pub homepage: Option<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub fork: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GitHubLicense {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub name: Option<String>,
    pub spdx_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct GitHubReleaseResponse {
    pub tag_name: String,
    pub body: Option<String>,
    pub assets: Vec<GitHubAssetResponse>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct GitHubAssetResponse {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRepoCoordinates {
    pub owner: String,
    pub repo: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub icon_bg: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn dummy_item(platforms: Vec<String>) -> CatalogItem {
        // 构造字段顺序与 CatalogItem 定义（catalog.json 磁盘顺序）对齐，行为不变。
        CatalogItem {
            id: "unknown/repo".to_string(),
            name: "repo".to_string(),
            owner: "unknown".to_string(),
            repo: "repo".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 0,
            forks: 0,
            is_verified: false,
            homepage: None,
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms,
            identifiers: HashMap::new(),
        }
    }

    #[test]
    fn test_to_summary_empty_platforms_passthrough_no_fallback() {
        // 空 platforms 直接透传 []；"other" 永不进 IPC。
        let item = dummy_item(Vec::new());
        let summary = item.to_summary();
        assert!(summary.core.platforms.is_empty());
        assert!(!summary.core.platforms.contains(&"windows".to_string()));
        assert!(!summary.core.platforms.contains(&"other".to_string()));
    }

    #[test]
    fn test_to_summary_nonempty_platforms_preserved() {
        let item = dummy_item(vec!["linux".to_string()]);
        let summary = item.to_summary();
        assert_eq!(summary.core.platforms, vec!["linux".to_string()]);
    }

    #[test]
    fn test_overlay_detail_core() {
        let mut item = dummy_item(vec![]);
        item.name = "New Name".to_string();
        item.icon = "https://example.com/icon.png".to_string();
        item.icon_bg = "#ff0000".to_string();
        item.description = "New Desc".to_string();
        item.description_en = Some("New Desc En".to_string());
        item.category = "tools".to_string();
        item.category_name = "开发工具".to_string();
        item.added_at = Some("2026-11-10".to_string());

        let mut core = AppCore {
            id: "unknown/repo".to_string(),
            name: "repo".to_string(),
            owner: "unknown".to_string(),
            repo: "repo".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: "Old Desc".to_string(),
            description_en: None,
            stars: 0,
            forks: 0,
            license: "MIT".to_string(),
            latest_version: "v1.0.0".to_string(),
            category: "system".to_string(),
            category_name: "系统实用".to_string(),
            is_verified: false,
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            homepage: None,
            platforms: vec![],
            added_at: None,
            is_cataloged: None,
            source: None,
            status: None,
        };

        item.overlay_detail_core(&mut core);

        assert_eq!(core.name, "New Name");
        assert_eq!(core.icon, "https://example.com/icon.png");
        assert_eq!(core.icon_bg, "#ff0000");
        assert_eq!(core.description, "New Desc");
        assert_eq!(core.description_en.as_deref(), Some("New Desc En"));
        assert_eq!(core.category, "tools");
        assert_eq!(core.category_name, "开发工具");
        assert_eq!(core.added_at.as_deref(), Some("2026-11-10"));
    }
}
