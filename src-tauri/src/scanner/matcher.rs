use super::{AppMatchResult, AppScanner, ScannedRawApp};
use crate::github::CatalogItem;

/// 启发式匹配打分权重常量
pub const SCORE_EXACT_NAME_MATCH: f32 = 0.55;
pub const SCORE_PREFIX_NAME_MATCH: f32 = 0.42;
pub const SCORE_CONTAINS_NAME_MATCH: f32 = 0.32;
pub const SCORE_CHINESE_NAME_MATCH: f32 = 0.38;
pub const SCORE_ALIAS_MATCH: f32 = 0.35;
pub const SCORE_PUBLISHER_MATCH: f32 = 0.25;
pub const SCORE_LOCATION_OR_ICON_MATCH: f32 = 0.20;
pub const SCORE_VERSION_MATCH: f32 = 0.10;

/// 置信度分级阈值常量
pub const MIN_QUALIFIED_SCORE: f32 = 0.45;
pub const TIER_HIGH_CONFIDENCE_THRESHOLD: f32 = 0.70;
pub const TIER_MEDIUM_CONFIDENCE_THRESHOLD: f32 = 0.55;

impl AppScanner {
    /// 将已扫描的应用与 Catalog 进行启发式匹配打分
    pub fn match_apps(
        scanned_apps: &[ScannedRawApp],
        catalog: &[CatalogItem],
    ) -> Vec<AppMatchResult> {
        let mut results = Vec::new();

        for scanned in scanned_apps {
            let s_name = scanned.display_name.trim().to_lowercase();
            let s_pub = scanned.publisher.as_deref().unwrap_or("").to_lowercase();
            let s_loc = scanned
                .install_location
                .as_deref()
                .unwrap_or("")
                .to_lowercase();
            let s_icon = scanned.display_icon.as_deref().unwrap_or("").to_lowercase();

            let mut best_match: Option<(f32, &CatalogItem)> = None;

            for cat in catalog {
                let c_name = cat.name.to_lowercase();
                let c_repo = cat.repo.to_lowercase();
                let c_id = cat.id.to_lowercase();
                let c_zh = cat.chinese_name.as_deref().unwrap_or("").to_lowercase();
                let c_owner = cat.owner.to_lowercase();

                let mut score: f32 = 0.0;

                // 1. 软件名称与仓库名称匹配
                if s_name == c_name || s_name == c_repo || s_name == c_id {
                    score += SCORE_EXACT_NAME_MATCH;
                } else if s_name.starts_with(&c_name)
                    || s_name.starts_with(&c_repo)
                    || c_name.starts_with(&s_name)
                {
                    score += SCORE_PREFIX_NAME_MATCH;
                } else if s_name.contains(&c_name)
                    || c_name.contains(&s_name)
                    || s_name.contains(&c_repo)
                {
                    score += SCORE_CONTAINS_NAME_MATCH;
                } else if !c_zh.is_empty() && (s_name.contains(&c_zh) || c_zh.contains(&s_name)) {
                    score += SCORE_CHINESE_NAME_MATCH;
                } else if cat
                    .aliases
                    .iter()
                    .any(|a| s_name.contains(&a.to_lowercase()))
                {
                    score += SCORE_ALIAS_MATCH;
                }

                // 2. 发布者 / 组织匹配（支持 catalog 中配置的 publishers）
                if !s_pub.is_empty()
                    && (s_pub.contains(&c_owner)
                        || c_owner.contains(&s_pub)
                        || cat
                            .publishers
                            .iter()
                            .any(|p| s_pub.contains(&p.to_lowercase()) || p.to_lowercase().contains(&s_pub)))
                {
                    score += SCORE_PUBLISHER_MATCH;
                }

                // 3. 安装路径或图标主程序匹配（基于 catalog 配置的 executables 与 install_dirs）
                if !s_loc.is_empty() || !s_icon.is_empty() {
                    let mut path_matched = s_loc.contains(&c_repo) || s_icon.contains(&c_repo);
                    if !path_matched {
                        for exe in &cat.get_windows_executables() {
                            let exe_lower = exe.to_lowercase();
                            if s_icon.contains(&exe_lower) || s_loc.contains(&exe_lower) {
                                path_matched = true;
                                break;
                            }
                        }
                    }
                    if !path_matched {
                        for dir_name in &cat.install_dirs {
                            let dir_lower = dir_name.to_lowercase();
                            if s_loc.contains(&dir_lower) {
                                path_matched = true;
                                break;
                            }
                        }
                    }
                    if path_matched {
                        score += SCORE_LOCATION_OR_ICON_MATCH;
                    }
                }

                // 4. 版本号匹配加分（若扫描出的版本号不为空）
                if !scanned.display_version.is_empty() {
                    let s_ver = scanned.display_version.trim_start_matches('v');
                    let c_ver = cat.default_version.trim_start_matches('v');
                    if s_ver == c_ver {
                        score += SCORE_VERSION_MATCH;
                    }
                }

                let clamped = score.min(1.0);
                if clamped >= MIN_QUALIFIED_SCORE {
                    if let Some((best_score, _)) = best_match {
                        if clamped > best_score {
                            best_match = Some((clamped, cat));
                        }
                    } else {
                        best_match = Some((clamped, cat));
                    }
                }
            }

            if let Some((confidence, matched_cat)) = best_match {
                let tier = if confidence >= TIER_HIGH_CONFIDENCE_THRESHOLD {
                    "high".to_string()
                } else if confidence >= TIER_MEDIUM_CONFIDENCE_THRESHOLD {
                    "medium".to_string()
                } else {
                    "low".to_string()
                };

                let local_ver = if scanned.display_version.is_empty() {
                    matched_cat.default_version.clone()
                } else {
                    scanned.display_version.clone()
                };

                let resolved_exe = Self::resolve_executable_path(
                    scanned.install_location.as_deref(),
                    scanned.display_icon.as_deref(),
                    matched_cat,
                );

                results.push(AppMatchResult {
                    scanned: scanned.clone(),
                    catalog_id: matched_cat.id.clone(),
                    name: matched_cat.name.clone(),
                    chinese_name: matched_cat.chinese_name.clone(),
                    owner: matched_cat.owner.clone(),
                    repo: matched_cat.repo.clone(),
                    icon: matched_cat.icon.clone(),
                    icon_bg: matched_cat.icon_bg.clone(),
                    description: matched_cat.description.clone(),
                    local_version: local_ver,
                    catalog_version: matched_cat.default_version.clone(),
                    confidence,
                    confidence_tier: tier,
                    resolved_executable_path: resolved_exe,
                });
            }
        }

        // 去重：同一 catalog_id 仅保留置信度最高且已解析出可执行路径的最佳条目
        let mut dedup_map: std::collections::HashMap<String, AppMatchResult> =
            std::collections::HashMap::new();
        for result in results {
            match dedup_map.get_mut(&result.catalog_id) {
                Some(existing) => {
                    let should_replace = result.confidence > existing.confidence
                        || (result.confidence == existing.confidence
                            && result.resolved_executable_path.is_some()
                            && existing.resolved_executable_path.is_none());
                    if should_replace {
                        *existing = result;
                    }
                }
                None => {
                    dedup_map.insert(result.catalog_id.clone(), result);
                }
            }
        }

        let mut final_results: Vec<AppMatchResult> = dedup_map.into_values().collect();
        final_results.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        final_results
    }
}
