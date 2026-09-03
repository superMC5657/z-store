use crate::github::CatalogItem;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannedRawApp {
    pub display_name: String,
    pub display_version: String,
    pub publisher: Option<String>,
    pub install_location: Option<String>,
    pub display_icon: Option<String>,
    pub uninstall_string: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppMatchResult {
    pub scanned: ScannedRawApp,
    pub catalog_id: String,
    pub name: String,
    pub chinese_name: Option<String>,
    pub owner: String,
    pub repo: String,
    pub icon: String,
    pub icon_bg: String,
    pub description: String,
    pub local_version: String,
    pub catalog_version: String,
    pub confidence: f32,
    pub confidence_tier: String, // "high", "medium", "low"
    pub resolved_executable_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportAppRequest {
    pub app_id: String,
    pub app_name: String,
    pub version: String,
    pub install_path: Option<String>,
    pub uninstall_command: Option<String>,
}

pub struct AppScanner;

impl AppScanner {
    /// 扫描系统已安装应用列表
    pub fn scan_system_apps() -> Vec<ScannedRawApp> {
        #[cfg(target_os = "windows")]
        {
            Self::scan_windows_registry()
        }
        #[cfg(not(target_os = "windows"))]
        {
            // 非 Windows 平台（预留 Linux/macOS）
            Vec::new()
        }
    }

    #[cfg(target_os = "windows")]
    fn scan_windows_registry() -> Vec<ScannedRawApp> {
        use std::collections::HashSet;
        use winreg::enums::*;
        use winreg::RegKey;

        let mut scanned_list = Vec::new();
        let mut seen_names = HashSet::new();

        let targets = [
            (
                HKEY_LOCAL_MACHINE,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
        ];

        for (hive, subpath) in targets {
            let root = RegKey::predef(hive);
            if let Ok(uninstall_key) = root.open_subkey(subpath) {
                for key_name in uninstall_key.enum_keys().map_while(Result::ok) {
                    if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                        // 1. 系统组件或子更新直接忽略
                        if let Ok(sys_comp) = app_key.get_value::<u32, _>("SystemComponent") {
                            if sys_comp == 1 {
                                continue;
                            }
                        }
                        if let Ok(parent) = app_key.get_value::<String, _>("ParentKeyName") {
                            if !parent.trim().is_empty() {
                                continue;
                            }
                        }

                        // 2. 提取 DisplayName
                        let display_name: String =
                            match app_key.get_value::<String, _>("DisplayName") {
                                Ok(name) => {
                                    let trimmed = name.trim().to_string();
                                    if trimmed.is_empty() {
                                        continue;
                                    }
                                    trimmed
                                }
                                Err(_) => continue,
                            };

                        // 3. 过滤系统更新、补丁与 VC++ 依赖噪声
                        let lower_name = display_name.to_lowercase();
                        if lower_name.starts_with("kb")
                            && lower_name[2..].chars().all(|c| c.is_ascii_digit())
                        {
                            continue;
                        }
                        if lower_name.contains("security update")
                            || lower_name.contains("update for windows")
                            || lower_name.contains("update for microsoft")
                            || lower_name.contains("redistributable")
                        {
                            continue;
                        }

                        // 4. 提取其他字段
                        let display_version: String = app_key
                            .get_value::<String, _>("DisplayVersion")
                            .unwrap_or_default()
                            .trim()
                            .to_string();

                        // 去重检查
                        let dedup_key = format!("{}::{}", lower_name, display_version);
                        if seen_names.contains(&dedup_key) {
                            continue;
                        }
                        seen_names.insert(dedup_key);

                        let publisher: Option<String> = app_key
                            .get_value("Publisher")
                            .ok()
                            .map(|s: String| s.trim().to_string())
                            .filter(|s| !s.is_empty());

                        let install_location: Option<String> = app_key
                            .get_value("InstallLocation")
                            .ok()
                            .map(|s: String| s.trim().to_string())
                            .filter(|s| !s.is_empty());

                        let display_icon: Option<String> = app_key
                            .get_value("DisplayIcon")
                            .ok()
                            .map(|s: String| s.trim().to_string())
                            .filter(|s| !s.is_empty());

                        let uninstall_string: Option<String> = app_key
                            .get_value("UninstallString")
                            .ok()
                            .map(|s: String| s.trim().to_string())
                            .filter(|s| !s.is_empty());

                        scanned_list.push(ScannedRawApp {
                            display_name,
                            display_version,
                            publisher,
                            install_location,
                            display_icon,
                            uninstall_string,
                        });
                    }
                }
            }
        }

        scanned_list
    }

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
                    score += 0.55;
                } else if s_name.starts_with(&c_name)
                    || s_name.starts_with(&c_repo)
                    || c_name.starts_with(&s_name)
                {
                    score += 0.42;
                } else if s_name.contains(&c_name)
                    || c_name.contains(&s_name)
                    || s_name.contains(&c_repo)
                {
                    score += 0.32;
                } else if !c_zh.is_empty() && (s_name.contains(&c_zh) || c_zh.contains(&s_name)) {
                    score += 0.38;
                } else if cat
                    .aliases
                    .iter()
                    .any(|a| s_name.contains(&a.to_lowercase()))
                {
                    score += 0.35;
                }

                // 2. 发布者 / 组织匹配
                if !s_pub.is_empty() {
                    if s_pub.contains(&c_owner) || c_owner.contains(&s_pub) {
                        score += 0.25;
                    }
                }

                // 3. 安装路径或图标主程序匹配
                if !s_loc.is_empty() || !s_icon.is_empty() {
                    let exe_target = format!("{}.exe", c_repo);
                    if s_loc.contains(&c_repo)
                        || s_icon.contains(&c_repo)
                        || s_icon.contains(&exe_target)
                    {
                        score += 0.20;
                    }
                }

                // 4. 版本号匹配加分（若扫描出的版本号不为空）
                if !scanned.display_version.is_empty() {
                    let s_ver = scanned.display_version.trim_start_matches('v');
                    let c_ver = cat.default_version.trim_start_matches('v');
                    if s_ver == c_ver {
                        score += 0.10;
                    }
                }

                let clamped = score.min(1.0);
                if clamped >= 0.45 {
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
                let tier = if confidence >= 0.70 {
                    "high".to_string()
                } else if confidence >= 0.55 {
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
                    &matched_cat.repo,
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

    /// 清理 DisplayIcon 字符串（去掉 ,0、,-1 以及多余引号）
    pub fn clean_display_icon(raw: &str) -> Option<std::path::PathBuf> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let unquoted = if trimmed.starts_with('"') {
            if let Some(second_quote) = trimmed[1..].find('"') {
                &trimmed[1..=second_quote]
            } else {
                trimmed.trim_matches('"')
            }
        } else if let Some(comma_pos) = trimmed.rfind(',') {
            let after_comma = &trimmed[comma_pos + 1..];
            if after_comma.chars().all(|c| c.is_ascii_digit() || c == '-') {
                &trimmed[..comma_pos]
            } else {
                trimmed
            }
        } else {
            trimmed
        };

        let path = std::path::PathBuf::from(unquoted.trim());
        if path.extension().map_or(false, |ext| {
            ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("lnk")
        }) {
            Some(path)
        } else {
            None
        }
    }

    /// 智能探测应用程序的主可执行文件物理路径
    pub fn resolve_executable_path(
        install_location: Option<&str>,
        display_icon: Option<&str>,
        repo_name: &str,
    ) -> Option<String> {
        // 1. 优先尝试从 DisplayIcon 提取并验证物理文件存在
        if let Some(raw_icon) = display_icon {
            if let Some(icon_path) = Self::clean_display_icon(raw_icon) {
                if icon_path.is_file() {
                    return Some(icon_path.to_string_lossy().to_string());
                }
            }
        }

        // 2. 检查安装目录中的可执行文件
        if let Some(loc) = install_location {
            let loc_path = std::path::Path::new(loc.trim_matches('"'));
            if loc_path.is_file()
                && loc_path
                    .extension()
                    .map_or(false, |e| e.eq_ignore_ascii_case("exe"))
            {
                return Some(loc_path.to_string_lossy().to_string());
            }

            if loc_path.is_dir() {
                let clean_repo = repo_name.to_lowercase().replace('.', "").replace('-', "");
                let target_names = [
                    format!("{}.exe", repo_name.to_lowercase()),
                    format!("{}.exe", repo_name),
                    format!("{}.exe", clean_repo),
                    format!("{}64.exe", repo_name.to_lowercase()),
                    format!("{}-x64.exe", repo_name.to_lowercase()),
                ];

                // 2.1 根目录下检查
                for name in &target_names {
                    let candidate = loc_path.join(name);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }

                // 2.2 常见子目录下检查（如 bin/、bin/64bit/、app/ 等，例如 OBS Studio 的 bin/64bit/obs64.exe）
                let subdirs = [
                    "bin",
                    "bin\\64bit",
                    "bin/64bit",
                    "bin\\x64",
                    "bin/x64",
                    "app",
                    "App",
                    "Core",
                ];
                for sub in &subdirs {
                    let sub_dir = loc_path.join(sub);
                    if sub_dir.is_dir() {
                        for name in &target_names {
                            let candidate = sub_dir.join(name);
                            if candidate.is_file() {
                                return Some(candidate.to_string_lossy().to_string());
                            }
                        }
                    }
                }

                // 2.3 递归检索安装目录下的第一个非卸载/安装器类的 exe
                if let Ok(entries) = std::fs::read_dir(loc_path) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file()
                            && p.extension()
                                .map_or(false, |e| e.eq_ignore_ascii_case("exe"))
                        {
                            let fname = p
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_lowercase();
                            if !fname.contains("unins")
                                && !fname.contains("setup")
                                && !fname.contains("installer")
                                && !fname.contains("crash")
                                && !fname.contains("helper")
                                && !fname.contains("update")
                            {
                                return Some(p.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }

        // 3. 检查桌面或开始菜单中的快捷方式 (.lnk)
        #[cfg(target_os = "windows")]
        {
            let shortcut_dirs = [
                std::env::var("USERPROFILE")
                    .map(|p| std::path::PathBuf::from(p).join("Desktop"))
                    .ok(),
                Some(std::path::PathBuf::from(r"C:\Users\Public\Desktop")),
                std::env::var("APPDATA")
                    .map(|p| {
                        std::path::PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs")
                    })
                    .ok(),
                Some(std::path::PathBuf::from(
                    r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs",
                )),
            ];

            for dir_opt in shortcut_dirs.into_iter().flatten() {
                if dir_opt.is_dir() {
                    if let Ok(entries) = std::fs::read_dir(&dir_opt) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.extension()
                                .map_or(false, |e| e.eq_ignore_ascii_case("lnk"))
                            {
                                let name = p
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_lowercase();
                                if name.contains(&repo_name.to_lowercase()) {
                                    return Some(p.to_string_lossy().to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // 4. 若无法确认物理文件存在，回退到清洗后的 DisplayIcon 或原始路径
        if let Some(raw_icon) = display_icon {
            if let Some(icon_path) = Self::clean_display_icon(raw_icon) {
                return Some(icon_path.to_string_lossy().to_string());
            }
        }

        install_location.map(|s| s.trim_matches('"').to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_mock_catalog() -> Vec<CatalogItem> {
        vec![
            CatalogItem {
                id: "videolan/vlc".to_string(),
                name: "VLC Media Player".to_string(),
                chinese_name: Some("VLC 播放器".to_string()),
                owner: "videolan".to_string(),
                repo: "vlc".to_string(),
                icon: "vlc.svg".to_string(),
                icon_bg: "#ff8800".to_string(),
                description: "开源全能媒体播放器".to_string(),
                category: "multimedia".to_string(),
                category_name: "影音视听".to_string(),
                aliases: vec!["vlc".to_string(), "videolan".to_string()],
                default_version: "v3.0.21".to_string(),
                license: "GPL-2.0".to_string(),
                stars: 45000,
                forks: 7000,
                is_verified: true,
            },
            CatalogItem {
                id: "obsproject/obs-studio".to_string(),
                name: "OBS Studio".to_string(),
                chinese_name: Some("OBS 直播录屏".to_string()),
                owner: "obsproject".to_string(),
                repo: "obs-studio".to_string(),
                icon: "obs.svg".to_string(),
                icon_bg: "#302e31".to_string(),
                description: "开源直播与录屏工具".to_string(),
                category: "multimedia".to_string(),
                category_name: "影音视听".to_string(),
                aliases: vec!["obs".to_string(), "bilibili".to_string()],
                default_version: "v31.0.1".to_string(),
                license: "GPL-2.0".to_string(),
                stars: 62000,
                forks: 11000,
                is_verified: true,
            },
        ]
    }

    #[test]
    fn test_match_apps_high_confidence() {
        let catalog = create_mock_catalog();
        let scanned = vec![
            ScannedRawApp {
                display_name: "VLC media player 3.0.21".to_string(),
                display_version: "3.0.21".to_string(),
                publisher: Some("VideoLAN".to_string()),
                install_location: Some(r"C:\Program Files\VideoLAN\VLC".to_string()),
                display_icon: Some(r"C:\Program Files\VideoLAN\VLC\vlc.exe,0".to_string()),
                uninstall_string: Some(r"C:\Program Files\VideoLAN\VLC\uninstall.exe".to_string()),
            },
            ScannedRawApp {
                display_name: "OBS Studio".to_string(),
                display_version: "31.0.1".to_string(),
                publisher: Some("OBS Project".to_string()),
                install_location: Some(r"C:\Program Files\obs-studio".to_string()),
                display_icon: None,
                uninstall_string: None,
            },
        ];

        let results = AppScanner::match_apps(&scanned, &catalog);
        assert_eq!(results.len(), 2);

        let vlc_match = results
            .iter()
            .find(|r| r.catalog_id == "videolan/vlc")
            .unwrap();
        assert!(vlc_match.confidence >= 0.70);
        assert_eq!(vlc_match.confidence_tier, "high");

        let obs_match = results
            .iter()
            .find(|r| r.catalog_id == "obsproject/obs-studio")
            .unwrap();
        assert!(obs_match.confidence >= 0.70);
        assert_eq!(obs_match.confidence_tier, "high");
    }

    #[test]
    fn test_match_apps_unrelated_filtered() {
        let catalog = create_mock_catalog();
        let scanned = vec![ScannedRawApp {
            display_name: "Some Proprietary Tool 1.0".to_string(),
            display_version: "1.0.0".to_string(),
            publisher: Some("Unknown Corp".to_string()),
            install_location: None,
            display_icon: None,
            uninstall_string: None,
        }];

        let results = AppScanner::match_apps(&scanned, &catalog);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_clean_display_icon() {
        let p1 = AppScanner::clean_display_icon(r#""C:\Program Files\VideoLAN\VLC\vlc.exe",0"#);
        assert_eq!(
            p1,
            Some(std::path::PathBuf::from(
                r#"C:\Program Files\VideoLAN\VLC\vlc.exe"#
            ))
        );

        let p2 = AppScanner::clean_display_icon(r#"C:\Program Files\App\app.exe,-1"#);
        assert_eq!(
            p2,
            Some(std::path::PathBuf::from(r#"C:\Program Files\App\app.exe"#))
        );

        let p3 = AppScanner::clean_display_icon(r#""C:\App\app.exe""#);
        assert_eq!(p3, Some(std::path::PathBuf::from(r#"C:\App\app.exe"#)));

        let p4 = AppScanner::clean_display_icon(r#"C:\App\not_an_exe.dll"#);
        assert_eq!(p4, None);
    }
}
