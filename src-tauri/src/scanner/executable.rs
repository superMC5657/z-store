use super::{AppScanner, ScanConfig};
use std::path::{Path, PathBuf};

impl AppScanner {
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
            let loc_path = Path::new(clean_loc);
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
            let common_roots: Vec<PathBuf> = [
                std::env::var("LOCALAPPDATA").ok().map(PathBuf::from),
                std::env::var("LOCALAPPDATA")
                    .ok()
                    .map(|p| PathBuf::from(p).join("Programs")),
                std::env::var("ProgramFiles").ok().map(PathBuf::from),
                std::env::var("ProgramFiles(x86)").ok().map(PathBuf::from),
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
                    .map(|p| PathBuf::from(p).join("Desktop"))
                    .ok(),
                Some(PathBuf::from(r"C:\Users\Public\Desktop")),
                std::env::var("APPDATA")
                    .map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs"))
                    .ok(),
                Some(PathBuf::from(
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
                                                if !Self::is_installer_or_cache_path(&target_exe)
                                                    && target_exe.is_file()
                                                {
                                                    return Some(
                                                        target_exe.to_string_lossy().to_string(),
                                                    );
                                                }
                                            }
                                        }
                                    }
                                    for dir_name in &config.install_dirs {
                                        if fname.contains(&dir_name.to_lowercase()) {
                                            if let Some(target_exe) = Self::resolve_lnk_target(&p) {
                                                if !Self::is_installer_or_cache_path(&target_exe)
                                                    && target_exe.is_file()
                                                {
                                                    return Some(
                                                        target_exe.to_string_lossy().to_string(),
                                                    );
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
        // ADR-0010：canonical id 形如 owner/repo，取 repo 段作为扫描候选基础
        let repo_base = repo_str.rsplit('/').next().unwrap_or(repo_str);
        let mut config = ScanConfig::from(repo_base);

        const STOP_WORDS: &[&str] = &[
            "microsoft",
            "google",
            "apple",
            "the",
            "for",
            "windows",
            "desktop",
            "community",
            "edition",
            "open",
            "source",
            "client",
            "official",
            "project",
            "player",
            "editor",
            "launcher",
            "viewer",
            "manager",
            "tool",
            "tools",
            "app",
            "studio",
            "suite",
            "media",
            "system",
            "helper",
            "service",
        ];

        let mut tokens = vec![
            app_name.trim().to_lowercase(),
            app_id.trim().to_lowercase(),
            repo_str.trim().to_lowercase(),
        ];
        for part in app_name.split_whitespace() {
            let p_lower = part.trim().to_lowercase();
            if p_lower.len() >= 3
                && !p_lower.chars().all(|c| c.is_ascii_digit())
                && !STOP_WORDS.contains(&p_lower.as_str())
            {
                tokens.push(p_lower);
            }
        }
        for part in app_id.split(['-', '/']) {
            let p_lower = part.trim().to_lowercase();
            if p_lower.len() >= 3
                && !p_lower.chars().all(|c| c.is_ascii_digit())
                && !STOP_WORDS.contains(&p_lower.as_str())
            {
                tokens.push(p_lower);
            }
        }
        if let Some((first, _)) = app_name.rsplit_once(' ') {
            let f_lower = first.trim().to_lowercase();
            if f_lower.len() >= 3
                && !f_lower.chars().all(|c| c.is_ascii_digit())
                && !STOP_WORDS.contains(&f_lower.as_str())
            {
                tokens.push(f_lower);
            }
        }
        if let Some((first, _)) = app_id.rsplit_once('-') {
            let f_lower = first.trim().to_lowercase();
            if f_lower.len() >= 3
                && !f_lower.chars().all(|c| c.is_ascii_digit())
                && !STOP_WORDS.contains(&f_lower.as_str())
            {
                tokens.push(f_lower);
            }
        }
        tokens.retain(|t| {
            !t.is_empty()
                && t.len() >= 3
                && !t.chars().all(|c| c.is_ascii_digit())
                && !STOP_WORDS.contains(&t.as_str())
        });

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
                                        || (!is_guid
                                            && (k_lower == *t
                                                || (t.len() >= 4 && k_lower.contains(t))))
                                });

                            if is_match {
                                // A. 检查 DisplayIcon
                                if let Ok(icon) = app_key.get_value::<String, _>("DisplayIcon") {
                                    if let Some(icon_path) = Self::clean_display_icon(&icon) {
                                        if !Self::is_installer_or_cache_path(&icon_path)
                                            && icon_path.is_file()
                                        {
                                            return Some(icon_path.to_string_lossy().to_string());
                                        }
                                    }
                                }

                                // B. 检查 InstallLocation
                                if let Ok(loc) = app_key.get_value::<String, _>("InstallLocation") {
                                    let clean_loc = loc.trim().trim_matches('"');
                                    let p = Path::new(clean_loc);
                                    if !clean_loc.is_empty() && !Self::is_installer_or_cache_path(p)
                                    {
                                        if p.is_file()
                                            && p.extension()
                                                .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                                        {
                                            return Some(p.to_string_lossy().to_string());
                                        }
                                        if p.is_dir() {
                                            if let Some(exe) =
                                                Self::find_exe_in_directory(p, &config)
                                            {
                                                return Some(exe);
                                            }
                                        }
                                    }
                                }

                                // C. 检查 UninstallString (若主程序同目录存在 uninstall.exe 等)
                                if let Ok(uninst) =
                                    app_key.get_value::<String, _>("UninstallString")
                                {
                                    let clean_un = uninst.trim().trim_matches('"');
                                    if let Some(first_arg) = clean_un
                                        .split(" -")
                                        .next()
                                        .and_then(|s| s.split(" /").next())
                                    {
                                        let p = Path::new(first_arg.trim_matches('"'));
                                        if let Some(parent) = p.parent() {
                                            if parent.is_dir()
                                                && !Self::is_installer_or_cache_path(parent)
                                            {
                                                if let Some(exe) =
                                                    Self::find_exe_in_directory(parent, &config)
                                                {
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
                    let root_path = PathBuf::from(root_str);
                    if root_path.is_dir() {
                        for t in &tokens {
                            search_dirs.push(root_path.join(t));
                        }
                    }
                }
            }

            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let local_path = PathBuf::from(local);
                for t in &tokens {
                    search_dirs.push(local_path.join("Programs").join(t));
                    search_dirs.push(local_path.join(t));
                }
            }
            if let Ok(appdata) = std::env::var("APPDATA") {
                let appdata_path = PathBuf::from(appdata);
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
                    .map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs"))
                    .ok(),
                std::env::var("APPDATA")
                    .map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs"))
                    .ok(),
                std::env::var("USERPROFILE")
                    .map(|p| PathBuf::from(p).join("Desktop"))
                    .ok(),
                Some(PathBuf::from(r"C:\Users\Public\Desktop")),
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
                                if p.is_file()
                                    && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
                                {
                                    let fname = p
                                        .file_name()
                                        .unwrap_or_default()
                                        .to_string_lossy()
                                        .to_lowercase();
                                    let f_matched = tokens.iter().any(|t| fname.contains(t));

                                    if f_matched {
                                        if let Some(target_exe) = Self::resolve_lnk_target(&p) {
                                            if !Self::is_installer_or_cache_path(&target_exe)
                                                && target_exe.is_file()
                                            {
                                                return Some(
                                                    target_exe.to_string_lossy().to_string(),
                                                );
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

    /// 检测本地文件路径对应的主程序或安装目录的文件系统创建/修改时间戳
    pub fn detect_path_installed_at(path_str: &str) -> Option<i64> {
        let clean = path_str.trim().trim_matches('"');
        if clean.is_empty() {
            return None;
        }
        let p = Path::new(clean);
        if !p.exists() {
            return None;
        }

        let meta = std::fs::metadata(p).ok()?;
        let now = super::types::now_secs();

        // 优先读取文件/目录自身的创建时间 (NTFS birthtime)
        if let Ok(created) = meta.created() {
            if let Ok(dur) = created.duration_since(std::time::UNIX_EPOCH) {
                let ts = dur.as_secs() as i64;
                if ts > 631_152_000 && ts <= now + 86_400 {
                    return Some(ts);
                }
            }
        }

        // 回退读取文件/目录自身的最后修改时间
        if let Ok(modified) = meta.modified() {
            if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                let ts = dur.as_secs() as i64;
                if ts > 631_152_000 && ts <= now + 86_400 {
                    return Some(ts);
                }
            }
        }

        None
    }

    /// 解析应用的真实系统安装时间戳
    /// 优先级：
    /// 1. 注册表匹配项的 InstallDate
    /// 2. 注册表匹配项对应键的 LastWriteTime
    /// 3. 本地安装路径 / 可执行文件 / 安装目录创建时间
    pub fn resolve_app_installed_at(
        app_name: &str,
        app_id: &str,
        install_path: &str,
    ) -> Option<i64> {
        #[cfg(target_os = "windows")]
        {
            use winreg::enums::*;
            use winreg::RegKey;

            let mut tokens = Vec::new();
            let name_clean = app_name.trim().to_lowercase();
            if !name_clean.is_empty() {
                tokens.push(name_clean.clone());
            }
            if let Some((_, repo)) = app_id.split_once('/') {
                let r_lower = repo.trim().to_lowercase();
                if !r_lower.is_empty() && !tokens.contains(&r_lower) {
                    tokens.push(r_lower);
                }
            }

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

            let mut candidate_reg_time: Option<i64> = None;

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
                                        || (!is_guid
                                            && (k_lower == *t
                                                || (t.len() >= 4 && k_lower.contains(t))))
                                });

                            if is_match {
                                // 1. 优先读取 InstallDate 字符串
                                if let Ok(date_str) = app_key.get_value::<String, _>("InstallDate")
                                {
                                    if let Some(parsed) =
                                        super::registry::parse_install_date_to_unix(&date_str)
                                    {
                                        return Some(parsed);
                                    }
                                }
                                // 2. 备选注册表项本身的 LastWriteTime
                                if candidate_reg_time.is_none() {
                                    candidate_reg_time =
                                        super::registry::get_reg_key_last_write_time(&app_key);
                                }
                            }
                        }
                    }
                }
            }

            if let Some(reg_ts) = candidate_reg_time {
                return Some(reg_ts);
            }
        }

        // 3. 回退尝试从物理路径/可执行文件元数据获取创建时间
        Self::detect_path_installed_at(install_path)
    }
}
