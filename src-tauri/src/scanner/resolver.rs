use super::{AppScanner, ScanConfig};
use std::path::{Path, PathBuf};

impl AppScanner {
    /// 清理 DisplayIcon 字符串（去掉 ,0、,-1 以及多余引号）
    pub fn clean_display_icon(raw: &str) -> Option<PathBuf> {
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

        let path = PathBuf::from(unquoted.trim());
        if path.extension().is_some_and(|ext| {
            ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("lnk")
        }) {
            Some(path)
        } else {
            None
        }
    }

    /// 解析 Windows 快捷方式 (.lnk) 的真实目标程序物理路径
    pub fn resolve_lnk_target(lnk_path: &Path) -> Option<PathBuf> {
        let data = std::fs::read(lnk_path).ok()?;
        if data.len() < 76 {
            return None;
        }

        // 1. 标准 MS-SHLLINK 结构体解析
        let flags = u32::from_le_bytes(data[0x14..0x18].try_into().ok()?);
        if (flags & 0x02) != 0 {
            // ShellLinkHeader 固定 76 字节；HasLinkTargetIDList (0x01) 置位时，
            // 头部之后是 LinkTargetIDList（u16 IDListSize + 变长 IDList），
            // LinkInfo 从 IDList 之后开始，而非固定偏移 76。
            let mut link_info_offset = 76usize;
            if (flags & 0x01) != 0 {
                if data.len() < link_info_offset + 2 {
                    // IDList 长度字段被截断：放弃结构化解析，走启发式分支
                    link_info_offset = data.len();
                } else {
                    let id_list_size = u16::from_le_bytes(
                        data[link_info_offset..link_info_offset + 2]
                            .try_into()
                            .ok()?,
                    ) as usize;
                    link_info_offset = link_info_offset.saturating_add(2 + id_list_size);
                }
            }
            if data.len() > link_info_offset + 28 {
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
                        if let Ok(path_str) =
                            std::str::from_utf8(&data[abs_offset..abs_offset + null_pos])
                        {
                            let pb = PathBuf::from(path_str);
                            if pb.is_file() {
                                return Some(pb);
                            }
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
                while end < data.len()
                    && data[end] >= 32
                    && data[end] < 127
                    && data[end] != b'"'
                    && data[end] != b'<'
                    && data[end] != b'>'
                {
                    end += 1;
                }
                if end > start + 7 {
                    if let Ok(candidate) = std::str::from_utf8(&data[start..end]) {
                        if candidate.to_lowercase().ends_with(".exe") {
                            let p = PathBuf::from(candidate);
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

    pub fn is_installer_or_cache_path(p: &Path) -> bool {
        let lower = p.to_string_lossy().to_lowercase();
        lower.contains("package cache")
            || lower.contains("temp")
            || lower.contains("windows\\installer")
            || lower.contains("unins")
            || lower.contains("installer")
            || lower.contains("bundle")
            || lower.contains("setup")
    }

    pub fn find_exe_in_directory(dir: &Path, config: &ScanConfig) -> Option<String> {
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
                    .map(|p| {
                        PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs")
                    })
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
                                        let base_name =
                                            exe.trim_end_matches(".exe").to_lowercase();
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
                    .map(|p| {
                        PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs")
                    })
                    .ok(),
                std::env::var("APPDATA")
                    .map(|p| {
                        PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs")
                    })
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
}

#[cfg(test)]
mod resolver_lnk_tests {
    use super::*;

    /// 构造 MS-SHLLINK 合成夹具：flags = 0x01|0x02（IDList + LinkInfo 共存），
    /// LinkInfo 起始于 76 + 2 + id_list_size（u16 IDListSize + 变长 IDList 之后）。
    /// IDList 填充 0xFF，使旧代码在固定偏移 76 处误读出的 link_info_size /
    /// local_base_path_offset 非法；目标路径使用 Unix 绝对路径，启发式分支
    ///（仅匹配 `X:\` 盘符模式）必然扫不到，从而把"结构化路径"与"启发式兜底"区分开：
    /// 旧代码返回 None，新代码应返回 Some。
    fn build_lnk_with_idlist_and_linkinfo(target: &str, id_list_size: usize) -> Vec<u8> {
        let mut data = vec![0u8; 76];
        // ShellLinkHeader: HeaderSize + LinkCLSID + LinkFlags
        data[0x00..0x04].copy_from_slice(&76u32.to_le_bytes());
        let clsid: [u8; 16] = [
            0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x46,
        ];
        data[0x04..0x14].copy_from_slice(&clsid);
        // HasLinkTargetIDList (0x01) | HasLinkInfo (0x02)
        data[0x14..0x18].copy_from_slice(&0x03u32.to_le_bytes());

        // LinkTargetIDList：u16 长度 + 变长 IDList（0xFF 填充，破坏固定偏移误读）
        data.extend_from_slice(&(id_list_size as u16).to_le_bytes());
        data.extend(std::iter::repeat(0xFFu8).take(id_list_size));

        // LinkInfo（含最小 VolumeID + LocalBasePath ANSI 字符串）
        let path_bytes = target.as_bytes();
        let mut volume_id = [0u8; 16];
        volume_id[0x00..0x04].copy_from_slice(&16u32.to_le_bytes());
        volume_id[0x04..0x08].copy_from_slice(&1u32.to_le_bytes());
        volume_id[0x08..0x0C].copy_from_slice(&0x12345678u32.to_le_bytes());
        volume_id[0x0C..0x10].copy_from_slice(&16u32.to_le_bytes());
        let local_base_path_offset = 28 + volume_id.len();
        let link_info_size = (28 + volume_id.len() + path_bytes.len() + 1) as u32;
        let mut link_info = Vec::new();
        link_info.extend_from_slice(&link_info_size.to_le_bytes());
        link_info.extend_from_slice(&28u32.to_le_bytes());
        link_info.extend_from_slice(&0x01u32.to_le_bytes());
        link_info.extend_from_slice(&28u32.to_le_bytes());
        link_info.extend_from_slice(&(local_base_path_offset as u32).to_le_bytes());
        link_info.extend_from_slice(&0u32.to_le_bytes());
        link_info.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(link_info.len(), 28);
        link_info.extend_from_slice(&volume_id);
        link_info.extend_from_slice(path_bytes);
        link_info.push(0);
        assert_eq!(link_info.len(), link_info_size as usize);
        data.extend_from_slice(&link_info);
        data
    }

    #[test]
    fn lnk_with_idlist_resolves_through_structured_path() {
        let dir = std::env::temp_dir().join(format!("zstore-lnk-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("fixture-target.exe");
        std::fs::write(&target, b"fake exe").unwrap();
        // 刻意使用正斜杠分隔符：Windows 上 is_file 照常通过，但启发式分支
        // 仅匹配 `X:\`（反斜杠）盘符模式，必然扫不到 —— 旧代码返回 None，
        // 新代码走结构化路径返回 Some，二者得以区分。
        let target_str = target.to_string_lossy().replace('\\', "/");

        let lnk_bytes = build_lnk_with_idlist_and_linkinfo(&target_str, 16);
        let lnk_path = dir.join("fixture-both-flags.lnk");
        std::fs::write(&lnk_path, &lnk_bytes).unwrap();

        let resolved = AppScanner::resolve_lnk_target(&lnk_path);
        assert_eq!(resolved, Some(PathBuf::from(&target_str)));

        std::fs::remove_file(&lnk_path).ok();
        std::fs::remove_file(&target).ok();
        std::fs::remove_dir(&dir).ok();
    }
}
