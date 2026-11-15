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

    /// 用收录项最新精校元数据覆写详情核心字段（收录库公共配置与平台优先；
    /// 动态指标 stars/forks/latest_version 保持实时远端值，仅 latest_version 在缺失或占位时回退收录库，
    /// platforms 在收录库非空时覆盖，收录库为空时保留 Release 推导值）。
    pub fn overlay_detail_core(&self, core: &mut AppCore) {
        if !self.name.trim().is_empty() {
            core.name = self.name.clone();
        }
        if self
            .description_en
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
        {
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
        if !self.category.trim().is_empty() {
            core.category = self.category.clone();
        }
        if !self.category_name.trim().is_empty() {
            core.category_name = self.category_name.clone();
        }
        core.is_verified = self.is_verified;
        if self.added_at.is_some() {
            core.added_at = self.added_at.clone();
        }
        if Self::is_concrete_license(&self.license) {
            core.license = self.license.trim().to_string();
        }
        core.homepage = crate::github::detail_fetch::resolve_homepage(
            core.homepage.as_deref(),
            self.homepage.as_deref(),
            core.forge_host.as_deref().unwrap_or(""),
            &core.owner,
            &core.repo,
        );
        if let Some(clean) = crate::github::detail_assets::clean_catalog_platforms(&self.platforms)
        {
            core.platforms = clean;
        }
        if !Self::is_concrete_version(&core.latest_version)
            && Self::is_concrete_version(&self.default_version)
        {
            core.latest_version = self.default_version.trim().to_string();
        }
    }

    /// 判定版本号是否为非空且非 `"latest"` 占位的真实版本号。
    pub(crate) fn is_concrete_version(v: &str) -> bool {
        let t = v.trim();
        !t.is_empty() && !t.eq_ignore_ascii_case("latest")
    }

    /// 判定开源协议是否为非空且非 `"unknown"` / `"opensource"` 占位的真实协议。
    pub(crate) fn is_concrete_license(l: &str) -> bool {
        let t = l.trim();
        !t.is_empty() && !t.eq_ignore_ascii_case("unknown") && !t.eq_ignore_ascii_case("opensource")
    }

    /// 判定图标是否为远端 `http(s)://` URL（排除空串与 `data:`）。
    pub(crate) fn is_remote_http_icon(ic: &str) -> bool {
        let t = ic.trim();
        t.starts_with("http://") || t.starts_with("https://")
    }

    /// 将应用详情中的保鲜字段合并回目录项（`stars`/`forks`/`default_version` 实时更新，
    /// `platforms`/`license`/`homepage`/`icon` 仅在目录缺省或为占位/自链时补齐，不覆盖目录已有精校值）。
    /// stale 详情或未发生任何变化时返回 `false`。
    pub(crate) fn merge_from_detail(&mut self, detail: &crate::models::AppDetail) -> bool {
        if detail.is_stale == Some(true) {
            return false;
        }
        let mut changed = false;
        if detail.core.stars > 0 && self.stars != detail.core.stars {
            self.stars = detail.core.stars;
            changed = true;
        }
        if detail.core.forks > 0 && self.forks != detail.core.forks {
            self.forks = detail.core.forks;
            changed = true;
        }
        if Self::is_concrete_version(&detail.core.latest_version) {
            let trimmed = detail.core.latest_version.trim();
            if self.default_version != trimmed {
                self.default_version = trimmed.to_string();
                changed = true;
            }
        }
        if self.platforms.is_empty() && !detail.core.platforms.is_empty() {
            self.platforms = detail.core.platforms.clone();
            changed = true;
        }
        if !Self::is_concrete_license(&self.license)
            && Self::is_concrete_license(&detail.core.license)
        {
            self.license = detail.core.license.trim().to_string();
            changed = true;
        }
        let forge_host = detail.core.forge_host.as_deref().unwrap_or("");
        let is_self = |u: &str| {
            crate::github::detail_fetch::is_same_repo_homepage(
                u,
                forge_host,
                &detail.core.owner,
                &detail.core.repo,
            )
        };
        let curated_valid = self
            .homepage
            .as_deref()
            .and_then(crate::github::detail_fetch::normalize_http_homepage);
        let detail_valid = detail
            .core
            .homepage
            .as_deref()
            .and_then(crate::github::detail_fetch::normalize_http_homepage);
        if let Some(hp) = detail_valid {
            // 目录无主页，或目录仅为仓库自链而详情带独立官网时补齐；不覆盖目录已精校的独立官网
            let should_fill = match curated_valid {
                None => true,
                Some(ref c) => is_self(c) && !is_self(&hp),
            };
            if should_fill && self.homepage.as_deref() != Some(hp.as_str()) {
                self.homepage = Some(hp);
                changed = true;
            }
        }
        // 目录原为空且详情探出合法 http(s) 时补齐，不覆盖目录已有官方图标
        if self.icon.trim().is_empty() && Self::is_remote_http_icon(&detail.core.icon) {
            self.icon = detail.core.icon.trim().to_string();
            changed = true;
        }
        changed
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
    #[serde(default)]
    pub pushed_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GitHubLicense {
    #[serde(default)]
    pub key: Option<String>,
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
        assert_eq!(core.homepage, None);
    }

    fn homepage_core(homepage: Option<&str>) -> AppCore {
        AppCore {
            id: "OpenMW/openmw".to_string(),
            name: "OpenMW".to_string(),
            owner: "OpenMW".to_string(),
            repo: "openmw".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            stars: 10,
            forks: 0,
            license: "GPL-3.0".to_string(),
            latest_version: "v1.0.0".to_string(),
            category: "game".to_string(),
            category_name: "游戏".to_string(),
            is_verified: false,
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            homepage: homepage.map(str::to_string),
            platforms: vec![],
            added_at: None,
            is_cataloged: None,
            source: None,
            status: None,
        }
    }

    fn curated_openmw() -> CatalogItem {
        let mut item = dummy_item(vec![]);
        item.id = "OpenMW/openmw".to_string();
        item.owner = "OpenMW".to_string();
        item.repo = "openmw".to_string();
        item.homepage = Some("https://gitlab.com/OpenMW/openmw".to_string());
        item
    }

    #[test]
    fn test_overlay_detail_core_heals_missing_or_self_link_homepage() {
        let item = curated_openmw();
        let curated = Some("https://gitlab.com/OpenMW/openmw".to_string());

        let mut core = homepage_core(None);
        item.overlay_detail_core(&mut core);
        assert_eq!(core.homepage, curated);

        let mut core = homepage_core(Some("   "));
        item.overlay_detail_core(&mut core);
        assert_eq!(core.homepage, curated);

        let mut core = homepage_core(Some("https://github.com/openmw/openmw/"));
        item.overlay_detail_core(&mut core);
        assert_eq!(core.homepage, curated);

        // 收录库已有独立官网时，覆盖缓存独立官网（收录库优先）
        let mut core = homepage_core(Some("https://openmw.org"));
        item.overlay_detail_core(&mut core);
        assert_eq!(core.homepage, curated);

        // 收录库仅填仓库自链时，保留缓存中的独立官网
        let mut self_item = curated_openmw();
        self_item.homepage = Some("https://github.com/openmw/openmw".to_string());
        let mut core = homepage_core(Some("https://openmw.org"));
        self_item.overlay_detail_core(&mut core);
        assert_eq!(core.homepage.as_deref(), Some("https://openmw.org"));
    }

    #[test]
    fn test_overlay_detail_core_prefers_catalog_platforms_license_and_verified() {
        let mut item = dummy_item(vec!["windows".to_string(), "ios".to_string()]);
        item.license = "GPL-3.0".to_string();
        item.is_verified = true;

        let mut core = homepage_core(None);
        core.platforms = vec!["linux".to_string()];
        core.license = "MIT".to_string();
        core.is_verified = false;
        core.stars = 999;
        core.forks = 88;
        core.latest_version = "v2.0.0".to_string();

        item.overlay_detail_core(&mut core);

        assert_eq!(
            core.platforms,
            vec!["windows".to_string(), "ios".to_string()]
        );
        assert_eq!(core.license, "GPL-3.0");
        assert!(core.is_verified);
        // 动态指标保持实时远端值
        assert_eq!(core.stars, 999);
        assert_eq!(core.forks, 88);
        assert_eq!(core.latest_version, "v2.0.0");

        // 实时为 0 星 / 0 Fork 时不被收录库旧值覆盖
        let mut zero_item = dummy_item(vec![]);
        zero_item.stars = 42;
        zero_item.forks = 7;
        let mut zero_core = homepage_core(None);
        zero_core.stars = 0;
        zero_core.forks = 0;
        zero_item.overlay_detail_core(&mut zero_core);
        assert_eq!(zero_core.stars, 0);
        assert_eq!(zero_core.forks, 0);

        // 收录库 platforms 为空 [] 时保留 Release 推导值
        let empty_plat_item = dummy_item(vec![]);
        let mut core2 = homepage_core(None);
        core2.platforms = vec!["linux".to_string()];
        empty_plat_item.overlay_detail_core(&mut core2);
        assert_eq!(core2.platforms, vec!["linux".to_string()]);
    }

    #[test]
    fn test_merge_from_detail_keeps_curated_fields_and_backfills_only_empty() {
        let detail_with = |hp: &str| crate::models::AppDetail {
            core: homepage_core(Some(hp)),
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        };

        let mut item = curated_openmw();
        item.platforms = vec!["windows".to_string()];
        item.license = "GPL-3.0".to_string();

        // 目录已有非空独立官网、平台与协议时，不被详情覆写
        let mut d = detail_with("https://openmw.org");
        d.core.platforms = vec!["linux".to_string()];
        d.core.license = "MIT".to_string();
        d.core.stars = 500;
        d.core.latest_version = "v2.0.0".to_string();
        assert!(item.merge_from_detail(&d));
        assert_eq!(
            item.homepage.as_deref(),
            Some("https://gitlab.com/OpenMW/openmw")
        );
        assert_eq!(item.platforms, vec!["windows".to_string()]);
        assert_eq!(item.license, "GPL-3.0");
        assert_eq!(item.stars, 500);
        assert_eq!(item.default_version, "v2.0.0");

        // 目录无主页时自链照常写入；目录仅为自链时独立官网可补齐
        let mut bare = curated_openmw();
        bare.homepage = None;
        assert!(bare.merge_from_detail(&detail_with("https://github.com/OpenMW/openmw")));
        assert_eq!(
            bare.homepage.as_deref(),
            Some("https://github.com/OpenMW/openmw")
        );
        assert!(bare.merge_from_detail(&detail_with("https://openmw.org")));
        assert_eq!(bare.homepage.as_deref(), Some("https://openmw.org"));
    }
}
