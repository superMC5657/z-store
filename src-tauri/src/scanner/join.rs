//! 深 join 模块：存量应用管理〈External App Management〉启发式评分与纳管状态判定。
//!
//! - heuristic fuzzy：启发式评分唯一入口 adapter
//!   （[`join_fuzzy`]，mechanics 在 [`super::matcher`]）；
//! - exact 纳管比对：已安装应用 canonical id 集合匹配（[`is_managed_id`] 与 [`canonical_id_set`]）。
//!
//! 键比对统一经 `forge::canonical_lookup_id`，大小写漂移行经归一化治愈（ADR-0010）。

use super::{AppMatchResult, ScannedRawApp};
use crate::github::CatalogItem;
use std::collections::HashSet;

/// heuristic fuzzy 行为：存量应用管理启发式评分唯一入口 adapter
/// （mechanics 在 `matcher::AppScanner::match_apps`，语义与其一致；
/// 低分未命中属常态，调用方按 loading 处理）。
pub fn join_fuzzy(scanned: &[ScannedRawApp], catalog: &[CatalogItem]) -> Vec<AppMatchResult> {
    super::AppScanner::match_apps(scanned, catalog)
}

/// exact 规范键比对：已纳管判定。两侧经 `canonical_lookup_id` 归一后精确相等；
/// canonical 数据与旧裸比较零行为差异，存量大小写漂移行被治愈。
pub fn is_managed_id(catalog_id: &str, installed_ids: &HashSet<String>) -> bool {
    let key = crate::forge::canonical_lookup_id(catalog_id);
    installed_ids.contains(&key)
}

/// 入站已安装 id 集归一：逐项经 `canonical_lookup_id`（与 [`is_managed_id`] 配对，
/// 调用方建集一次、比对零散装归一）。
pub fn canonical_id_set(ids: impl IntoIterator<Item = String>) -> HashSet<String> {
    ids.into_iter()
        .map(|id| crate::forge::canonical_lookup_id(&id))
        .filter(|k| !k.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_item(id: &str, owner: &str, repo: &str) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            name: repo.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
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
            identifiers: std::collections::HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec![],
        }
    }

    #[test]
    fn test_is_managed_id_canonical_compare_heals_drift() {
        let installed: HashSet<String> = ["RustDesk/RustDesk".to_string()].into_iter().collect();
        let norm = canonical_id_set(installed);
        // 存量大小写漂移行被治愈：canonical 两侧精确相等。
        assert!(is_managed_id("rustdesk/rustdesk", &norm));
        assert!(!is_managed_id("videolan/vlc", &norm));
    }

    #[test]
    fn test_join_fuzzy_delegates_to_matcher_semantics() {
        // fuzzy 行为与 `match_apps` 同语义：确切命名命中 high，完全无关挂起（空）。
        let catalog = vec![mock_item("videolan/vlc", "videolan", "vlc")];
        let scanned = vec![
            ScannedRawApp {
                display_name: "VLC media player".to_string(),
                display_version: String::new(),
                publisher: Some("VideoLAN".to_string()),
                install_location: None,
                display_icon: None,
                uninstall_string: None,
                installed_at: None,
            },
            ScannedRawApp {
                display_name: " utterly-unrelated-thing ".to_string(),
                display_version: String::new(),
                publisher: None,
                install_location: None,
                display_icon: None,
                uninstall_string: None,
                installed_at: None,
            },
        ];
        let results = join_fuzzy(&scanned, &catalog);
        assert!(results.iter().any(|r| r.catalog_id == "videolan/vlc"));
        assert_eq!(
            results.len(),
            1,
            "fuzzy miss stays loading (no fabrication)"
        );
    }
}
