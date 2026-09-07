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

#[derive(Debug, Clone)]
pub struct ScanConfig {
    pub target_executables: Vec<String>,
    pub install_dirs: Vec<String>,
    pub search_subdirs: Vec<String>,
}

impl From<&CatalogItem> for ScanConfig {
    fn from(cat: &CatalogItem) -> Self {
        let mut target_executables = cat.executables.clone();
        if target_executables.is_empty() {
            let clean_repo = cat.repo.to_lowercase().replace(['.', '-'], "");
            target_executables = vec![
                format!("{}.exe", cat.repo.to_lowercase()),
                format!("{}.exe", cat.repo),
                format!("{}.exe", clean_repo),
                format!("{}64.exe", cat.repo.to_lowercase()),
                format!("{}-x64.exe", cat.repo.to_lowercase()),
                format!("{}.exe", cat.id.to_lowercase()),
            ];
        }

        let mut install_dirs = cat.install_dirs.clone();
        if install_dirs.is_empty() {
            install_dirs = vec![
                cat.repo.clone(),
                cat.repo.to_lowercase(),
                cat.name.clone(),
                cat.id.clone(),
            ];
        }

        let mut search_subdirs = cat.search_subdirs.clone();
        if search_subdirs.is_empty() {
            search_subdirs = vec![
                "bin".to_string(),
                "bin\\64bit".to_string(),
                "bin/64bit".to_string(),
                "bin\\x64".to_string(),
                "bin/x64".to_string(),
                "app".to_string(),
                "App".to_string(),
                "Core".to_string(),
            ];
        }

        Self {
            target_executables,
            install_dirs,
            search_subdirs,
        }
    }
}

impl From<&str> for ScanConfig {
    fn from(name: &str) -> Self {
        let clean = name.to_lowercase().replace(['.', '-'], "");
        Self {
            target_executables: vec![
                format!("{}.exe", name.to_lowercase()),
                format!("{}.exe", name),
                format!("{}.exe", clean),
                format!("{}64.exe", name.to_lowercase()),
                format!("{}-x64.exe", name.to_lowercase()),
            ],
            install_dirs: vec![name.to_string(), name.to_lowercase()],
            search_subdirs: vec![
                "bin".to_string(),
                "bin\\64bit".to_string(),
                "bin/64bit".to_string(),
                "bin\\x64".to_string(),
                "bin/x64".to_string(),
                "app".to_string(),
                "App".to_string(),
                "Core".to_string(),
            ],
        }
    }
}

impl From<&String> for ScanConfig {
    fn from(name: &String) -> Self {
        Self::from(name.as_str())
    }
}

impl From<String> for ScanConfig {
    fn from(name: String) -> Self {
        Self::from(name.as_str())
    }
}

impl From<&ScanConfig> for ScanConfig {
    fn from(config: &ScanConfig) -> Self {
        config.clone()
    }
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

        let mut component_locations: std::collections::HashMap<String, String> = std::collections::HashMap::new();

        for (hive, subpath) in targets {
            let root = RegKey::predef(hive);
            if let Ok(uninstall_key) = root.open_subkey(subpath) {
                for key_name in uninstall_key.enum_keys().map_while(Result::ok) {
                    if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                        // 1. 系统组件或子更新：提取可能存在的实际安装路径（如 WiX MSI 载荷），然后忽略条目本身
                        if let Ok(sys_comp) = app_key.get_value::<u32, _>("SystemComponent") {
                            if sys_comp == 1 {
                                if let Ok(disp) = app_key.get_value::<String, _>("DisplayName") {
                                    if let Ok(loc) = app_key.get_value::<String, _>("InstallLocation") {
                                        let trimmed_loc = loc.trim().trim_matches('"').to_string();
                                        if !trimmed_loc.is_empty() && std::path::Path::new(&trimmed_loc).exists() {
                                            component_locations.insert(disp.trim().to_lowercase(), trimmed_loc);
                                        }
                                    }
                                }
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

        // 5. 针对部分如 WiX Burn 引导包（InstallLocation 记录在 MSI 子组件中）回填安装路径
        for app in &mut scanned_list {
            if app.install_location.is_none() {
                let app_lower = app.display_name.to_lowercase();
                for (comp_name, loc) in &component_locations {
                    if app_lower.contains(comp_name) || comp_name.contains(&app_lower) {
                        app.install_location = Some(loc.clone());
                        break;
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

                // 2. 发布者 / 组织匹配（支持 catalog 中配置的 publishers）
                if !s_pub.is_empty()
                    && (s_pub.contains(&c_owner)
                        || c_owner.contains(&s_pub)
                        || cat
                            .publishers
                            .iter()
                            .any(|p| s_pub.contains(&p.to_lowercase()) || p.to_lowercase().contains(&s_pub)))
                {
                    score += 0.25;
                }

                // 3. 安装路径或图标主程序匹配（基于 catalog 配置的 executables 与 install_dirs）
                if !s_loc.is_empty() || !s_icon.is_empty() {
                    let mut path_matched = s_loc.contains(&c_repo) || s_icon.contains(&c_repo);
                    if !path_matched {
                        for exe in &cat.executables {
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

    /// 清理 DisplayIcon 字符串（去掉 ,0、,-1 以及多余引号）
    pub fn clean_display_icon(raw: &str) -> Option<std::path::PathBuf> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let unquoted = if let Some(stripped) = trimmed.strip_prefix('"') {
            if let Some(second_quote) = stripped.find('"') {
                &stripped[..second_quote]
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
        if path.extension().is_some_and(|ext| {
            ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("lnk")
        }) {
            Some(path)
        } else {
            None
        }
    }

    /// 解析 Windows 快捷方式 (.lnk) 的真实目标程序物理路径
    pub fn resolve_lnk_target(lnk_path: &std::path::Path) -> Option<std::path::PathBuf> {
        let data = std::fs::read(lnk_path).ok()?;
        if data.len() < 76 {
            return None;
        }

        // 1. 标准 MS-SHLLINK 结构体解析
        let flags = u32::from_le_bytes(data[0x14..0x18].try_into().ok()?);
        if (flags & 0x01) != 0 && data.len() > 76 + 28 {
            let link_info_offset = 76;
            let link_info_size = u32::from_le_bytes(
                data[link_info_offset..link_info_offset + 4]
                    .try_into()
                    .ok()?,
            ) as usize;
            let local_base_path_offset = u32::from_le_bytes(
                data[link_info_offset + 16..link_info_offset + 20]
                    .try_into()
                    .ok()?,
            ) as usize;
            if local_base_path_offset > 0 && local_base_path_offset < link_info_size {
                let abs_offset = link_info_offset + local_base_path_offset;
                if abs_offset < data.len() {
                    let null_pos = data[abs_offset..]
                        .iter()
                        .position(|&b| b == 0)
                        .unwrap_or(data.len() - abs_offset);
                    if let Ok(path_str) = std::str::from_utf8(&data[abs_offset..abs_offset + null_pos]) {
                        let pb = std::path::PathBuf::from(path_str);
                        if pb.is_file() {
                            return Some(pb);
                        }
                    }
                }
            }
        }

        // 2. 启发式字节串扫描备选（匹配 ?:\...\*.exe）
        let mut i = 0;
        while i + 3 < data.len() {
            if data[i].is_ascii_alphabetic() && data[i + 1] == b':' && data[i + 2] == b'\\' {
                let start = i;
                let mut end = start + 3;
                while end < data.len() && data[end] >= 32 && data[end] < 127 && data[end] != b'"' && data[end] != b'<' && data[end] != b'>' {
                    end += 1;
                }
                if end > start + 7 {
                    if let Ok(candidate) = std::str::from_utf8(&data[start..end]) {
                        if candidate.to_lowercase().ends_with(".exe") {
                            let p = std::path::PathBuf::from(candidate);
                            if p.is_file() {
                                return Some(p);
                            }
                        }
                    }
                }
                i = end;
            } else {
                i += 1;
            }
        }

        None
    }

    pub fn is_installer_or_cache_path(p: &std::path::Path) -> bool {
        let lower = p.to_string_lossy().to_lowercase();
        lower.contains("package cache")
            || lower.contains("temp")
            || lower.contains("windows\\installer")
            || lower.contains("unins")
            || lower.contains("installer")
            || lower.contains("bundle")
            || lower.contains("setup")
    }

    pub fn find_exe_in_directory(dir: &std::path::Path, config: &ScanConfig) -> Option<String> {
        if !dir.is_dir() {
            return None;
        }

        // 1. 根目录精准匹配配置中的可执行文件名
        for name in &config.target_executables {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }

        // 2. 常见子目录匹配（基于配置中配置的 search_subdirs 或标准子目录）
        for sub in &config.search_subdirs {
            let sub_dir = dir.join(sub);
            if sub_dir.is_dir() {
                for name in &config.target_executables {
                    let candidate = sub_dir.join(name);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
        }

        // 3. 遍历一级子目录查找配置中的可执行程序（例如 WinGet 解压包目录）
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() && !Self::is_installer_or_cache_path(&p) {
                    for name in &config.target_executables {
                        let candidate = p.join(name);
                        if candidate.is_file() {
                            return Some(candidate.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }

        // 4. 根目录内搜索首个非卸载/安装器类的可执行文件
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file()
                    && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                    && !Self::is_installer_or_cache_path(&p)
                {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }

        None
    }

    /// 智能探测应用程序的主可执行文件物理路径（确保返回的一定是磁盘上真实存在的文件）
    pub fn resolve_executable_path<C: Into<ScanConfig>>(
        install_location: Option<&str>,
        display_icon: Option<&str>,
        config_source: C,
    ) -> Option<String> {
        let config: ScanConfig = config_source.into();

        // 1. 优先尝试从 DisplayIcon 提取，必须经过物理存在校验且排除安装缓存/安装向导
        if let Some(raw_icon) = display_icon {
            if let Some(icon_path) = Self::clean_display_icon(raw_icon) {
                if !Self::is_installer_or_cache_path(&icon_path) && icon_path.is_file() {
                    return Some(icon_path.to_string_lossy().to_string());
                }
            }
        }

        // 2. 检查安装目录中的可执行文件
        if let Some(loc) = install_location {
            let clean_loc = loc.trim_matches('"');
            let loc_path = std::path::Path::new(clean_loc);
            if !Self::is_installer_or_cache_path(loc_path) {
                if loc_path.is_file()
                    && loc_path
                        .extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                {
                    return Some(loc_path.to_string_lossy().to_string());
                }

                if loc_path.is_dir() {
                    if let Some(exe) = Self::find_exe_in_directory(loc_path, &config) {
                        return Some(exe);
                    }
                }
            }
        }

        // 3. 常见系统及用户安装根目录探测（基于配置的 install_dirs）
        #[cfg(target_os = "windows")]
        {
            let common_roots: Vec<std::path::PathBuf> = [
                std::env::var("LOCALAPPDATA").ok().map(std::path::PathBuf::from),
                std::env::var("LOCALAPPDATA")
                    .ok()
                    .map(|p| std::path::PathBuf::from(p).join("Programs")),
                std::env::var("ProgramFiles").ok().map(std::path::PathBuf::from),
                std::env::var("ProgramFiles(x86)").ok().map(std::path::PathBuf::from),
            ]
            .into_iter()
            .flatten()
            .collect();

            for root in &common_roots {
                for sub in &config.install_dirs {
                    let candidate_dir = root.join(sub);
                    if let Some(exe) = Self::find_exe_in_directory(&candidate_dir, &config) {
                        return Some(exe);
                    }
                }
            }
        }

        // 4. 检查桌面或开始菜单中的快捷方式 (.lnk)（支持深入子目录）
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
                    let mut scan_dirs = vec![dir_opt.clone()];
                    if let Ok(entries) = std::fs::read_dir(&dir_opt) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.is_dir() {
                                scan_dirs.push(p);
                            }
                        }
                    }

                    for sdir in scan_dirs {
                        if let Ok(entries) = std::fs::read_dir(&sdir) {
                            for entry in entries.flatten() {
                                let p = entry.path();
                                if p.is_file()
                                    && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
                                {
                                    let fname = p
                                        .file_name()
                                        .unwrap_or_default()
                                        .to_string_lossy()
                                        .to_lowercase();
                                    for exe in &config.target_executables {
                                        let base_name = exe.trim_end_matches(".exe").to_lowercase();
                                        if !base_name.is_empty() && fname.contains(&base_name) {
                                            if let Some(target_exe) = Self::resolve_lnk_target(&p) {
                                                if !Self::is_installer_or_cache_path(&target_exe) && target_exe.is_file() {
                                                    return Some(target_exe.to_string_lossy().to_string());
                                                }
                                            }
                                            return Some(p.to_string_lossy().to_string());
                                        }
                                    }
                                    for dir_name in &config.install_dirs {
                                        if fname.contains(&dir_name.to_lowercase()) {
                                            if let Some(target_exe) = Self::resolve_lnk_target(&p) {
                                                if !Self::is_installer_or_cache_path(&target_exe) && target_exe.is_file() {
                                                    return Some(target_exe.to_string_lossy().to_string());
                                                }
                                            }
                                            return Some(p.to_string_lossy().to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 5. 若无法物理验证文件存在，绝不返回虚拟/缓存或不存在的假路径
        None
    }

    /// 全方位探测应用程序在系统中的真实安装路径（融合注册表、全驱动器常用目录、快捷方式智能解构）
    pub fn resolve_installed_app_path(
        app_name: &str,
        app_id: &str,
        repo: Option<&str>,
    ) -> Option<String> {
        let repo_str = repo.unwrap_or(app_id);
        let mut config = ScanConfig::from(app_id);

        const STOP_WORDS: &[&str] = &[
            "microsoft", "google", "apple", "the", "for", "windows", "desktop",
            "community", "edition", "open", "source", "client", "official", "project",
            "player", "editor", "launcher", "viewer", "manager", "tool", "tools",
            "app", "studio", "suite", "media", "system", "helper", "service",
        ];

        let mut tokens = vec![
            app_name.trim().to_lowercase(),
            app_id.trim().to_lowercase(),
            repo_str.trim().to_lowercase(),
        ];
        for part in app_name.split_whitespace() {
            let p_lower = part.trim().to_lowercase();
            if p_lower.len() >= 3 && !p_lower.chars().all(|c| c.is_ascii_digit()) && !STOP_WORDS.contains(&p_lower.as_str()) {
                tokens.push(p_lower);
            }
        }
        for part in app_id.split('-') {
            let p_lower = part.trim().to_lowercase();
            if p_lower.len() >= 3 && !p_lower.chars().all(|c| c.is_ascii_digit()) && !STOP_WORDS.contains(&p_lower.as_str()) {
                tokens.push(p_lower);
            }
        }
        if let Some((first, _)) = app_name.rsplit_once(' ') {
            let f_lower = first.trim().to_lowercase();
            if f_lower.len() >= 3 && !f_lower.chars().all(|c| c.is_ascii_digit()) && !STOP_WORDS.contains(&f_lower.as_str()) {
                tokens.push(f_lower);
            }
        }
        if let Some((first, _)) = app_id.rsplit_once('-') {
            let f_lower = first.trim().to_lowercase();
            if f_lower.len() >= 3 && !f_lower.chars().all(|c| c.is_ascii_digit()) && !STOP_WORDS.contains(&f_lower.as_str()) {
                tokens.push(f_lower);
            }
        }
        tokens.retain(|t| !t.is_empty() && t.len() >= 3 && !t.chars().all(|c| c.is_ascii_digit()) && !STOP_WORDS.contains(&t.as_str()));

        for t in &tokens {
            if !config.install_dirs.contains(t) {
                config.install_dirs.push(t.clone());
            }
            let exe_name = format!("{}.exe", t);
            if !config.target_executables.contains(&exe_name) {
                config.target_executables.push(exe_name);
            }
            let exe_gui = format!("{}-gui.exe", t);
            if !config.target_executables.contains(&exe_gui) {
                config.target_executables.push(exe_gui);
            }
        }

        // 1. Windows 注册表深度检索 (HKLM, Wow6432Node, HKCU)
        #[cfg(target_os = "windows")]
        {
            use winreg::enums::*;
            use winreg::RegKey;

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
                        let k_lower = key_name.to_lowercase();
                        let is_guid = k_lower.starts_with('{') && k_lower.ends_with('}');
                        if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                            let disp_name: String = app_key
                                .get_value::<String, _>("DisplayName")
                                .unwrap_or_default()
                                .trim()
                                .to_string();
                            let d_lower = disp_name.to_lowercase();

                            let is_match = !d_lower.is_empty()
                                && tokens.iter().any(|t| {
                                    d_lower == *t
                                        || (t.len() >= 4 && d_lower.contains(t))
                                        || (d_lower.len() >= 4 && t.contains(&d_lower))
                                        || (!is_guid && (k_lower == *t || (t.len() >= 4 && k_lower.contains(t))))
                                });

                            if is_match {
                                // A. 检查 DisplayIcon
                                if let Ok(icon) = app_key.get_value::<String, _>("DisplayIcon") {
                                    if let Some(icon_path) = Self::clean_display_icon(&icon) {
                                        if !Self::is_installer_or_cache_path(&icon_path) && icon_path.is_file() {
                                            return Some(icon_path.to_string_lossy().to_string());
                                        }
                                    }
                                }

                                // B. 检查 InstallLocation
                                if let Ok(loc) = app_key.get_value::<String, _>("InstallLocation") {
                                    let clean_loc = loc.trim().trim_matches('"');
                                    let p = std::path::Path::new(clean_loc);
                                    if !clean_loc.is_empty() && !Self::is_installer_or_cache_path(p) {
                                        if p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
                                            return Some(p.to_string_lossy().to_string());
                                        }
                                        if p.is_dir() {
                                            if let Some(exe) = Self::find_exe_in_directory(p, &config) {
                                                return Some(exe);
                                            }
                                        }
                                    }
                                }

                                // C. 检查 UninstallString (若主程序同目录存在 uninstall.exe 等)
                                if let Ok(uninst) = app_key.get_value::<String, _>("UninstallString") {
                                    let clean_un = uninst.trim().trim_matches('"');
                                    if let Some(first_arg) = clean_un.split(" -").next().and_then(|s| s.split(" /").next()) {
                                        let p = std::path::Path::new(first_arg.trim_matches('"'));
                                        if let Some(parent) = p.parent() {
                                            if parent.is_dir() && !Self::is_installer_or_cache_path(parent) {
                                                if let Some(exe) = Self::find_exe_in_directory(parent, &config) {
                                                    return Some(exe);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 2. 跨驱动器常用软件根目录广度检索 (C:, D:, E:, F:, G:)
        #[cfg(target_os = "windows")]
        {
            let mut search_dirs = Vec::new();
            let drive_letters = ['C', 'D', 'E', 'F', 'G'];
            for drive in drive_letters {
                let p1 = format!("{}:\\Program Files", drive);
                let p2 = format!("{}:\\Program Files (x86)", drive);
                let p3 = format!("{}:\\Programs", drive);
                let p4 = format!("{}:\\tools", drive);
                let p5 = format!("{}:\\", drive);

                for root_str in [p1, p2, p3, p4, p5] {
                    let root_path = std::path::PathBuf::from(root_str);
                    if root_path.is_dir() {
                        for t in &tokens {
                            search_dirs.push(root_path.join(t));
                        }
                    }
                }
            }

            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let local_path = std::path::PathBuf::from(local);
                for t in &tokens {
                    search_dirs.push(local_path.join("Programs").join(t));
                    search_dirs.push(local_path.join(t));
                }
            }
            if let Ok(appdata) = std::env::var("APPDATA") {
                let appdata_path = std::path::PathBuf::from(appdata);
                for t in &tokens {
                    search_dirs.push(appdata_path.join(t));
                }
            }

            for dir in search_dirs {
                if dir.is_dir() && !Self::is_installer_or_cache_path(&dir) {
                    if let Some(exe) = Self::find_exe_in_directory(&dir, &config) {
                        return Some(exe);
                    }
                }
            }
        }

        // 3. 开始菜单与桌面快捷方式探测与智能目标解构 (.lnk -> Target exe)
        #[cfg(target_os = "windows")]
        {
            let shortcut_roots = [
                std::env::var("ProgramData")
                    .map(|p| std::path::PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs"))
                    .ok(),
                std::env::var("APPDATA")
                    .map(|p| std::path::PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs"))
                    .ok(),
                std::env::var("USERPROFILE")
                    .map(|p| std::path::PathBuf::from(p).join("Desktop"))
                    .ok(),
                Some(std::path::PathBuf::from(r"C:\Users\Public\Desktop")),
            ];

            for root_opt in shortcut_roots.into_iter().flatten() {
                if root_opt.is_dir() {
                    let mut scan_folders = vec![root_opt.clone()];
                    if let Ok(entries) = std::fs::read_dir(&root_opt) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.is_dir() {
                                scan_folders.push(p);
                            }
                        }
                    }

                    for folder in scan_folders {
                        if let Ok(entries) = std::fs::read_dir(&folder) {
                            for entry in entries.flatten() {
                                let p = entry.path();
                                if p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
                                    let fname = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                                    let f_matched = tokens.iter().any(|t| fname.contains(t));

                                    if f_matched {
                                        if let Some(target_exe) = Self::resolve_lnk_target(&p) {
                                            if !Self::is_installer_or_cache_path(&target_exe) && target_exe.is_file() {
                                                return Some(target_exe.to_string_lossy().to_string());
                                            }
                                        }
                                        return Some(p.to_string_lossy().to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 4. 便携版默认解压目录回退探测
        let portable_dir = crate::installer::dirs_or_fallback_with_base(app_id, None);
        if portable_dir.is_dir() {
            if let Some(exe) = Self::find_exe_in_directory(&portable_dir, &config) {
                return Some(exe);
            }
        }

        // 5. 调用已有 resolve_executable_path
        Self::resolve_executable_path(None, None, config)
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
                publisher_fingerprint: None,
                homepage: None,
                executables: vec!["vlc.exe".to_string()],
                install_dirs: vec!["VideoLAN\\VLC".to_string(), "VLC".to_string()],
                search_subdirs: vec![],
                publishers: vec!["VideoLAN".to_string()],
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
                publisher_fingerprint: None,
                homepage: None,
                executables: vec!["obs64.exe".to_string(), "obs.exe".to_string()],
                install_dirs: vec!["obs-studio".to_string()],
                search_subdirs: vec!["bin/64bit".to_string(), "bin".to_string()],
                publishers: vec!["OBS Project".to_string()],
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

    #[test]
    fn test_match_expanded_apps_from_catalog() {
        let catalog: Vec<CatalogItem> = serde_json::from_str(include_str!("catalog.json")).unwrap();
        let scanned = vec![
            ScannedRawApp {
                display_name: "qBittorrent".to_string(),
                display_version: "5.0.3.10".to_string(),
                publisher: Some("The qBittorrent project".to_string()),
                install_location: None,
                display_icon: Some(r#""E:\Program Files\qBittorrent\qbittorrent.exe",0"#.to_string()),
                uninstall_string: None,
            },
            ScannedRawApp {
                display_name: "Motrix 1.8.19".to_string(),
                display_version: "1.8.19".to_string(),
                publisher: Some("Dr_rOot".to_string()),
                install_location: None,
                display_icon: Some(r#"E:\Program Files\Motrix\Motrix.exe,0"#.to_string()),
                uninstall_string: None,
            },
            ScannedRawApp {
                display_name: "Playnite".to_string(),
                display_version: "10.37".to_string(),
                publisher: Some("Josef Nemec".to_string()),
                install_location: Some(r#"C:\Users\user\AppData\Local\Playnite\"#.to_string()),
                display_icon: Some(r#"C:\Users\user\AppData\Local\Playnite\Playnite.DesktopApp.exe"#.to_string()),
                uninstall_string: None,
            },
            ScannedRawApp {
                display_name: "Telegram Desktop".to_string(),
                display_version: "6.9.3".to_string(),
                publisher: Some("Telegram FZ-LLC".to_string()),
                install_location: Some(r#"E:\Program Files\Telegram Desktop\"#.to_string()),
                display_icon: Some(r#"E:\Program Files\Telegram Desktop\Telegram.exe"#.to_string()),
                uninstall_string: None,
            },
        ];

        let results = AppScanner::match_apps(&scanned, &catalog);
        assert_eq!(results.len(), 4);
        assert!(results.iter().any(|r| r.catalog_id == "qbittorrent"));
        assert!(results.iter().any(|r| r.catalog_id == "motrix"));
        assert!(results.iter().any(|r| r.catalog_id == "playnite"));
        assert!(results.iter().any(|r| r.catalog_id == "telegram-desktop"));
    }

    #[test]
    fn test_resolve_lnk_target() {
        let lnk = std::path::Path::new(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Clash Verge.lnk");
        if lnk.exists() {
            let target = AppScanner::resolve_lnk_target(lnk);
            println!("RESOLVED LNK TARGET for Clash Verge: {:?}", target);
            assert!(target.is_some());
        }
    }

    #[test]
    fn test_resolve_installed_app_path_real() {
        // 测试真实系统环境中存量软件的多源嗅探能力（注册表/多磁盘/快捷方式解构）
        let path1 = AppScanner::resolve_installed_app_path("Clash Verge Rev", "clash-verge-rev", Some("clash-verge-rev"));
        println!("Clash Verge resolved path: {:?}", path1);

        let path2 = AppScanner::resolve_installed_app_path("WezTerm", "wezterm", Some("wezterm"));
        println!("WezTerm resolved path: {:?}", path2);

        let path3 = AppScanner::resolve_installed_app_path("qBittorrent", "qbittorrent", Some("qBittorrent"));
        println!("qBittorrent resolved path: {:?}", path3);

        let path4 = AppScanner::resolve_installed_app_path("Oh My Posh", "oh-my-posh", Some("oh-my-posh"));
        println!("Oh My Posh resolved path: {:?}", path4);

        assert!(path1.is_some() || path2.is_some() || path3.is_some());

        // 测试不存在的应用返回 None，绝不产生假路径或 Panic
        let non_existent = AppScanner::resolve_installed_app_path("NonExistentApp999", "non-existent-app-999", None);
        println!("NonExistent resolved path: {:?}", non_existent);
        assert!(non_existent.is_none());
    }

    #[test]
    fn test_batch_detect_catalog_apps() {
        let catalog: Vec<CatalogItem> = serde_json::from_str(include_str!("catalog.json")).unwrap();
        let start = std::time::Instant::now();
        let mut detected = Vec::new();
        for cat in &catalog {
            if let Some(path) = AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo)) {
                detected.push((cat.id.clone(), cat.name.clone(), path));
            }
        }
        let elapsed = start.elapsed();
        println!("Batch detected {} apps in {:?}", detected.len(), elapsed);
        for (id, name, path) in &detected {
            println!("  [DETECTED] {} ({}): {}", name, id, path);
        }
    }
}
