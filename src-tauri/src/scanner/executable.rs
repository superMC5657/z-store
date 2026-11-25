use super::{AppScanner, ScanConfig};
use std::path::{Path, PathBuf};

/// 单个快捷方式根目录内 `.lnk` 的枚举结果：(路径, 小写文件名)。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Default)]
struct LnkListing(Vec<(PathBuf, String)>);

/// 桌面与开始菜单快捷方式目录的一次性枚举缓存。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Default)]
struct ShortcutRoots {
    common_start_menu: LnkListing,
    user_start_menu: LnkListing,
    user_desktop: LnkListing,
    public_desktop: LnkListing,
}

#[cfg(target_os = "windows")]
impl ShortcutRoots {
    fn enumerate() -> Self {
        let start_menu = |base: PathBuf| base.join(r"Microsoft\Windows\Start Menu\Programs");
        let list = |p: Option<PathBuf>| p.map(|p| AppScanner::list_lnk_dir(&p)).unwrap_or_default();
        Self {
            common_start_menu: list(Some(start_menu(
                std::env::var("ProgramData")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| PathBuf::from(r"C:\ProgramData")),
            ))),
            user_start_menu: list(std::env::var("APPDATA").ok().map(|p| start_menu(p.into()))),
            user_desktop: list(
                std::env::var("USERPROFILE")
                    .ok()
                    .map(|p| PathBuf::from(p).join("Desktop")),
            ),
            public_desktop: list(Some(PathBuf::from(r"C:\Users\Public\Desktop"))),
        }
    }

    /// token 探测顺序：公共开始菜单 → 用户开始菜单 → 用户桌面 → 公共桌面。
    fn start_menu_first(&self) -> [&LnkListing; 4] {
        [
            &self.common_start_menu,
            &self.user_start_menu,
            &self.user_desktop,
            &self.public_desktop,
        ]
    }

    /// 可执行名兜底顺序：用户桌面 → 公共桌面 → 用户开始菜单 → 公共开始菜单。
    fn desktop_first(&self) -> [&LnkListing; 4] {
        [
            &self.user_desktop,
            &self.public_desktop,
            &self.user_start_menu,
            &self.common_start_menu,
        ]
    }
}

/// 候选名通用停用词，避免 `app` / `tool` / `test` 等通用词误命中系统命令。
pub(crate) const CANDIDATE_STOP_WORDS: &[&str] = &[
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
    "server",
    "test",
    "tests",
    "terminal",
    "code",
    "react",
    "native",
    "gui",
];

impl AppScanner {
    /// 判定搜索 token 是否有效（长度 >= 3、非纯数字且非停用词）。
    fn is_search_token(lower: &str) -> bool {
        lower.len() >= 3
            && !lower.chars().all(|c| c.is_ascii_digit())
            && !CANDIDATE_STOP_WORDS.contains(&lower)
    }

    /// UTF-8 安全的整词边界匹配：`needle` 在 `haystack` 中命中时前后不可紧邻字母或数字。
    #[cfg(any(target_os = "windows", test))]
    fn contains_word_boundary(haystack: &str, needle: &str) -> bool {
        if needle.is_empty() || haystack.len() < needle.len() {
            return false;
        }
        let mut start = 0;
        while start <= haystack.len() - needle.len() {
            let Some(pos) = haystack[start..].find(needle) else {
                break;
            };
            let s = start + pos;
            let e = s + needle.len();
            let before_ok = s == 0
                || !haystack[..s]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_alphanumeric);
            let after_ok = e == haystack.len()
                || !haystack[e..]
                    .chars()
                    .next()
                    .is_some_and(char::is_alphanumeric);
            if before_ok && after_ok {
                return true;
            }
            let step = haystack[s..].chars().next().map_or(1, char::len_utf8);
            start = s + step;
        }
        false
    }

    /// 注册表条目（DisplayName / 非 GUID 键名）与搜索 token 的严格匹配判定：
    /// 全等或正向整词边界（token 长度 >= 4 且非停用词），禁止裸子串 `.contains()` 与反向包含。
    #[cfg(any(target_os = "windows", test))]
    pub(crate) fn registry_entry_matches_tokens(
        display_name: &str,
        key_name: &str,
        tokens: &[String],
    ) -> bool {
        let d_lower = display_name.trim().to_lowercase();
        if d_lower.is_empty() {
            return false;
        }
        let k_lower = key_name.trim().to_lowercase();
        let is_guid = k_lower.starts_with('{') && k_lower.ends_with('}');
        tokens.iter().any(|t| {
            let t = t.trim();
            if t.is_empty() {
                return false;
            }
            let allow_word = t.chars().count() >= 4 && !CANDIDATE_STOP_WORDS.contains(&t);
            d_lower == t
                || (allow_word && Self::contains_word_boundary(&d_lower, t))
                || (!is_guid
                    && (k_lower == t || (allow_word && Self::contains_word_boundary(&k_lower, t))))
        })
    }

    /// 从名称/id/repo 构建搜索词元并扩展 `ScanConfig` 的目录与可执行名候选。
    /// 剥离 `app_id` / `repo_str` 的 `owner/` 前缀，避免 GitHub 组织名（如 `mozilla`）误命中无关软件。
    fn build_tokens(
        app_name: &str,
        app_id: &str,
        repo_str: &str,
        config: &mut ScanConfig,
    ) -> Vec<String> {
        let id_repo = app_id.rsplit('/').next().unwrap_or(app_id).trim();
        let repo_part = repo_str.rsplit('/').next().unwrap_or(repo_str).trim();

        let mut tokens = vec![
            app_name.trim().to_lowercase(),
            id_repo.to_lowercase(),
            repo_part.to_lowercase(),
        ];
        for part in app_name.split_whitespace() {
            let p_lower = part.trim().to_lowercase();
            if Self::is_search_token(&p_lower) {
                tokens.push(p_lower);
            }
        }
        for part in id_repo.split('-') {
            let p_lower = part.trim().to_lowercase();
            if Self::is_search_token(&p_lower) {
                tokens.push(p_lower);
            }
        }
        if let Some((first, _)) = app_name.rsplit_once(' ') {
            let f_lower = first.trim().to_lowercase();
            if Self::is_search_token(&f_lower) {
                tokens.push(f_lower);
            }
        }
        if let Some((first, _)) = id_repo.rsplit_once('-') {
            let f_lower = first.trim().to_lowercase();
            if Self::is_search_token(&f_lower) {
                tokens.push(f_lower);
            }
        }
        let mut deduped = Vec::new();
        for t in tokens {
            if !t.is_empty() && Self::is_search_token(&t) && !deduped.contains(&t) {
                deduped.push(t);
            }
        }
        let tokens = deduped;

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
            // Linux：裸名并入（/usr/bin/<token>、desktop Exec 多为无扩展名；
            // Windows 编译时不执行此块，行为不变）。
            #[cfg(target_os = "linux")]
            {
                if !config.target_executables.contains(t) {
                    config.target_executables.push(t.clone());
                }
            }
        }
        tokens
    }

    /// 单个快捷方式根目录的 `.lnk` 枚举：根 + 一级子目录，根优先，`read_dir` 原序。
    #[cfg(target_os = "windows")]
    fn list_lnk_dir(root: &Path) -> LnkListing {
        let mut out = Vec::new();
        if !root.is_dir() {
            return LnkListing(out);
        }
        let mut scan_dirs = vec![root.to_path_buf()];
        if let Ok(entries) = std::fs::read_dir(root) {
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
                    if p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
                        let fname = p
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase();
                        out.push((p, fname));
                    }
                }
            }
        }
        LnkListing(out)
    }

    /// 已枚举 `.lnk` 按 `matches` 谓词过滤文件名（已小写），命中即 `resolve_lnk_target`
    /// + 安装缓存排除 + 存在性校验后返回首个落盘路径。
    #[cfg(target_os = "windows")]
    fn first_lnk_match(listing: &LnkListing, matches: impl Fn(&str) -> bool) -> Option<String> {
        listing
            .0
            .iter()
            .filter(|(_, fname)| matches(fname))
            .find_map(|(p, _)| {
                Self::resolve_lnk_target(p)
                    .filter(|t| !Self::is_installer_or_cache_path(t) && t.is_file())
                    .map(|t| t.to_string_lossy().to_string())
            })
    }

    /// 单个快捷方式根目录扫描：枚举 + 首个命中解析。
    #[cfg(all(target_os = "windows", test))]
    fn scan_lnk_dir(root: &Path, matches: impl Fn(&str) -> bool) -> Option<String> {
        Self::first_lnk_match(&Self::list_lnk_dir(root), matches)
    }

    /// 1. Windows 注册表深度检索 (HKLM, Wow6432Node, HKCU)：DisplayName/key 名与
    ///    token 命中后依次试 DisplayIcon / InstallLocation / UninstallString 同目录。
    #[cfg(target_os = "windows")]
    fn registry_scan(tokens: &[String], config: &ScanConfig) -> Option<String> {
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
                    if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                        let disp_name: String = app_key
                            .get_value::<String, _>("DisplayName")
                            .unwrap_or_default()
                            .trim()
                            .to_string();

                        let is_match =
                            Self::registry_entry_matches_tokens(&disp_name, &key_name, tokens);

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
                                if !clean_loc.is_empty() && !Self::is_installer_or_cache_path(p) {
                                    if p.is_file()
                                        && p.extension()
                                            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                                    {
                                        return Some(p.to_string_lossy().to_string());
                                    }
                                    if p.is_dir() {
                                        if let Some(exe) = Self::find_exe_in_directory(p, config) {
                                            return Some(exe);
                                        }
                                    }
                                }
                            }

                            // C. 检查 UninstallString (若主程序同目录存在 uninstall.exe 等)
                            if let Ok(uninst) = app_key.get_value::<String, _>("UninstallString") {
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
                                                Self::find_exe_in_directory(parent, config)
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
        None
    }

    /// 2. 跨驱动器常用软件根目录广度检索 (C:, D:, E:, F:, G: + LOCALAPPDATA/APPDATA)。
    #[cfg(target_os = "windows")]
    fn drive_scan(tokens: &[String], config: &ScanConfig) -> Option<String> {
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
                    for t in tokens {
                        search_dirs.push(root_path.join(t));
                    }
                }
            }
        }

        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let local_path = PathBuf::from(local);
            for t in tokens {
                search_dirs.push(local_path.join("Programs").join(t));
                search_dirs.push(local_path.join(t));
            }
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            let appdata_path = PathBuf::from(appdata);
            for t in tokens {
                search_dirs.push(appdata_path.join(t));
            }
        }

        for dir in search_dirs {
            if dir.is_dir() && !Self::is_installer_or_cache_path(&dir) {
                if let Some(exe) = Self::find_exe_in_directory(&dir, config) {
                    return Some(exe);
                }
            }
        }
        None
    }

    /// 3. 开始菜单与桌面快捷方式探测与智能目标解构 (.lnk -> Target exe)。
    #[cfg(target_os = "windows")]
    fn shortcut_scan(tokens: &[String], roots: &ShortcutRoots) -> Option<String> {
        roots.start_menu_first().into_iter().find_map(|listing| {
            Self::first_lnk_match(listing, |fname| {
                let stem = fname.strip_suffix(".lnk").unwrap_or(fname);
                tokens
                    .iter()
                    .any(|t| stem == t || Self::contains_word_boundary(stem, t))
            })
        })
    }

    /// 智能探测应用程序的主可执行文件物理路径（确保返回的一定是磁盘上真实存在的文件）
    pub fn resolve_executable_path<C: Into<ScanConfig>>(
        install_location: Option<&str>,
        display_icon: Option<&str>,
        config_source: C,
    ) -> Option<String> {
        Self::resolve_executable_path_with(
            install_location,
            display_icon,
            config_source.into(),
            None,
        )
    }

    /// `resolve_executable_path` 本体；`shortcuts` 为调用方已枚举的快捷方式根（缺省时按需枚举）。
    fn resolve_executable_path_with(
        install_location: Option<&str>,
        display_icon: Option<&str>,
        config: ScanConfig,
        shortcuts: Option<&ShortcutRoots>,
    ) -> Option<String> {
        #[cfg(not(target_os = "windows"))]
        let _ = shortcuts;

        // 优先从 DisplayIcon 提取；指向 `.lnk` 时先解析目标主程序。
        if let Some(raw_icon) = display_icon {
            if let Some(icon_path) = Self::clean_display_icon(raw_icon) {
                let is_lnk = icon_path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("lnk"));
                if is_lnk && icon_path.is_file() {
                    if let Some(target) = Self::resolve_lnk_target(&icon_path) {
                        if target.is_file()
                            && Self::is_valid_app_executable(&target, &config.target_executables)
                        {
                            return Some(target.to_string_lossy().to_string());
                        }
                    }
                }
                if Self::is_valid_app_executable(&icon_path, &config.target_executables)
                    && icon_path.is_file()
                {
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
                // 2b. Linux / macOS：可执行位文件直接认可（无 .exe 扩展名；Windows 行为不变）。
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                {
                    if loc_path.is_file() && Self::has_exec_permission(loc_path) {
                        return Some(loc_path.to_string_lossy().to_string());
                    }
                }

                if loc_path.is_dir() {
                    if let Some(exe) = Self::find_exe_in_directory(loc_path, &config) {
                        return Some(exe);
                    }
                }
            }
        }

        // Linux 系统级嗅探（PATH、/usr/bin、/opt、desktop Exec）。
        #[cfg(target_os = "linux")]
        {
            if let Some(found) = Self::resolve_linux_system_binary(&config) {
                return Some(found);
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
            let owned;
            let roots = match shortcuts {
                Some(roots) => roots,
                None => {
                    owned = ShortcutRoots::enumerate();
                    &owned
                }
            };
            let base_names: Vec<String> = config
                .target_executables
                .iter()
                .map(|exe| exe.trim_end_matches(".exe").to_lowercase())
                .filter(|b| !b.is_empty())
                .chain(config.install_dirs.iter().map(|d| d.to_lowercase()))
                .collect();
            let matched = roots.desktop_first().into_iter().find_map(|listing| {
                Self::first_lnk_match(listing, |fname| {
                    base_names.iter().any(|b| fname.contains(b.as_str()))
                })
            });
            if matched.is_some() {
                return matched;
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
        // canonical id 形如 owner/repo，取 repo 段作为扫描候选基础
        let repo_base = repo_str.rsplit('/').next().unwrap_or(repo_str);
        let mut config = ScanConfig::from(repo_base);

        #[cfg_attr(
            not(any(target_os = "windows", target_os = "linux")),
            allow(unused_variables)
        )]
        let tokens = Self::build_tokens(app_name, app_id, repo_str, &mut config);

        // 1. Windows 注册表深度检索 (HKLM, Wow6432Node, HKCU)
        #[cfg(target_os = "windows")]
        {
            if let Some(found) = Self::registry_scan(&tokens, &config) {
                return Some(found);
            }
        }

        // 2. 跨驱动器常用软件根目录广度检索 (C:, D:, E:, F:, G:)
        #[cfg(target_os = "windows")]
        {
            if let Some(found) = Self::drive_scan(&tokens, &config) {
                return Some(found);
            }
        }

        // 3. 开始菜单与桌面快捷方式探测与智能目标解构 (.lnk -> Target exe)；
        // 枚举结果留给第 5 步复用，不重复遍历同一批快捷方式目录。
        #[cfg(target_os = "windows")]
        let shortcuts = ShortcutRoots::enumerate();
        #[cfg(not(target_os = "windows"))]
        let shortcuts = ShortcutRoots::default();
        #[cfg(target_os = "windows")]
        {
            if let Some(found) = Self::shortcut_scan(&tokens, &shortcuts) {
                return Some(found);
            }
        }

        // 4. 便携版默认解压目录回退探测（优先于系统级 PATH，避免通用词 token
        // 如 "test" 误命中 /usr/bin/test；系统 deb 包无便携目录，不受影响）
        let portable_dir = crate::installer::dirs_or_fallback_with_base(app_id, None);
        if portable_dir.is_dir() {
            if let Some(exe) = Self::find_exe_in_directory(&portable_dir, &config) {
                return Some(exe);
            }
        }

        // Linux 系统级嗅探与 dpkg -L 回退。
        #[cfg(target_os = "linux")]
        {
            if let Some(found) = Self::resolve_linux_system_binary(&config) {
                return Some(found);
            }
            if let Some(found) = Self::resolve_linux_via_dpkg(&tokens, &config) {
                return Some(found);
            }
        }

        // 5. 调用已有 resolve_executable_path（复用第 3 步的快捷方式枚举）
        Self::resolve_executable_path_with(None, None, config, Some(&shortcuts))
    }

    // Linux 桌面文件 / PATH / dpkg 解析

    /// 判断是否为 Flatpak shell 包装器（`flatpak run ...` 无本地二进制）。
    #[cfg(any(target_os = "linux", test))]
    pub fn is_flatpak_shell_wrapper(exec: &str) -> bool {
        let trimmed = exec.trim();
        if trimmed.is_empty() {
            return false;
        }
        let first = trimmed.split_whitespace().next().unwrap_or("");
        let first = first.trim_matches('"').trim_matches('\'');
        if first.is_empty() {
            return false;
        }
        let lower = first.to_lowercase();
        let base = lower.rsplit('/').next().unwrap_or(&lower);
        let base = base.rsplit('\\').next().unwrap_or(base);
        base == "flatpak"
    }

    /// 解析 `.desktop` Exec 值为可执行二进制（去 `%U/%F` 等字段码、引号、`env VAR=..` 前缀）。
    /// 纯函数，跨平台可单测。返回裸命令或绝对路径字符串（不校验存在性）。
    #[cfg(any(target_os = "linux", test))]
    pub fn parse_desktop_exec_binary(exec_line: &str) -> Option<String> {
        let line = exec_line.trim();
        if line.is_empty() {
            return None;
        }
        // 去掉 `Exec=` 前缀（若调用方传入整行）
        let mut rest = line.trim();
        if let Some(stripped) = rest.strip_prefix("Exec=") {
            rest = stripped.trim();
        }
        // `flatpak run <appid>` 包装器无本地二进制，禁解析为 `flatpak`
        //（否则 which 到 /usr/bin/flatpak 造成全量误报）。大小写不敏感。
        if Self::is_flatpak_shell_wrapper(rest) {
            return None;
        }
        // tokenize：尊重单双引号
        let mut tokens: Vec<String> = Vec::new();
        let mut cur = String::new();
        let mut quote: Option<char> = None;
        for ch in rest.chars() {
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                } else {
                    cur.push(ch);
                }
            } else if ch == '"' || ch == '\'' {
                quote = Some(ch);
            } else if ch.is_whitespace() {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            } else {
                cur.push(ch);
            }
        }
        if !cur.is_empty() {
            tokens.push(cur);
        }
        if tokens.is_empty() {
            return None;
        }
        // 跳过 `env` 及 `VAR=...` 前缀
        let mut idx = 0;
        if tokens[0] == "env" {
            idx = 1;
            while idx < tokens.len() && tokens[idx].contains('=') {
                idx += 1;
            }
        } else {
            while idx < tokens.len() && tokens[idx].contains('=') && !tokens[idx].contains('/') {
                // 形如 `FOO=bar` 的前导环境赋值（不含路径分隔符才跳过，避免误伤 `/opt/x`）
                // 若首个 token 本身就是绝对路径则不跳过
                if tokens[idx].starts_with('/') {
                    break;
                }
                idx += 1;
            }
        }
        // 跳过字段码独立 token（%U/%F/%f/%u/%i/%c/%k 等）直到遇到真正的二进制
        while idx < tokens.len() {
            let t = tokens[idx].trim();
            if t.is_empty() {
                idx += 1;
                continue;
            }
            // env 前缀后的 `flatpak run` 同样拒识（防 `env .. flatpak run` 绕过）。
            if Self::is_flatpak_shell_wrapper(t) {
                return None;
            }
            if t.starts_with('%') {
                idx += 1;
                continue;
            }
            // 形如 `%U` 粘连在引号残留中的情况已由分词处理；含 `%` 的参数跳过
            if t.contains('%') && (t.starts_with('-') || t.len() <= 3) {
                idx += 1;
                continue;
            }
            // 去掉行内残留字段码后缀（如 `motrix %U` 已分词，此处只取首个有效 token）
            let cleaned = t.trim_matches('"').trim_matches('\'').trim().to_string();
            if cleaned.is_empty() || cleaned.starts_with('%') {
                idx += 1;
                continue;
            }
            return Some(cleaned);
        }
        None
    }

    /// 将绝对路径或裸命令解析为磁盘上存在且可执行（Unix 校验执行位）的路径。
    #[cfg(any(target_os = "linux", test))]
    pub fn resolve_binary_via_path(bin: &str) -> Option<String> {
        let b = bin.trim().trim_matches('"').trim_matches('\'');
        if b.is_empty() {
            return None;
        }
        let p = Path::new(b);
        if b.starts_with('/') || b.contains('/') {
            if p.is_file() {
                #[cfg(unix)]
                {
                    // 必须有执行位才放行（无执行位返回 None，防误命中数据文件）
                    if Self::has_exec_permission(p) {
                        return Some(p.to_string_lossy().to_string());
                    }
                    return None;
                }
                #[cfg(not(unix))]
                {
                    return Some(p.to_string_lossy().to_string());
                }
            }
            return None;
        }
        // 裸命令：PATH 查找
        if let Some(found) = Self::which_binary(b) {
            return Some(found);
        }
        None
    }

    /// 在 `PATH` 及常见 FHS/XDG 二进制目录中查找具有执行位的裸命令。
    #[cfg(any(target_os = "linux", test))]
    pub fn which_binary(name: &str) -> Option<String> {
        let n = name.trim();
        if n.is_empty() || n.contains('/') || n.contains('\\') {
            return None;
        }
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Ok(path_var) = std::env::var("PATH") {
            #[cfg(target_os = "windows")]
            let sep = ';';
            #[cfg(not(target_os = "windows"))]
            let sep = ':';
            for d in path_var.split(sep) {
                let t = d.trim();
                if !t.is_empty() {
                    dirs.push(PathBuf::from(t));
                }
            }
        }
        for extra in ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"] {
            let p = PathBuf::from(extra);
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
        // HOME/.local/bin 兜底（用户级安装）
        if let Ok(home) = std::env::var("HOME") {
            let p = PathBuf::from(home).join(".local/bin");
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
        for d in dirs {
            let cand = d.join(n);
            if !cand.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                // 必须有执行位才放行（无执行位继续下一目录，防误命中数据文件；
                // 符号链接经 metadata 跟随目标判定）。
                if Self::has_exec_permission(&cand) {
                    return Some(cand.to_string_lossy().to_string());
                }
                continue;
            }
            #[cfg(not(unix))]
            {
                return Some(cand.to_string_lossy().to_string());
            }
        }
        None
    }

    /// 从包文件列表输出中按候选裸名精确挑选可执行文件，跳过目录项与资源文件。
    #[cfg(any(target_os = "linux", test))]
    pub fn pick_executable_from_package_list(
        dpkg_output: &str,
        candidates: &[String],
    ) -> Option<String> {
        let lower_cands: Vec<String> = candidates.iter().map(|c| c.to_lowercase()).collect();
        // 先收集有效行，识别父目录项（任一其他行以 `line + "/"` 开头即为目录）。
        let lines: Vec<&str> = dpkg_output
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && *l != "/." && !l.ends_with('/'))
            .collect();
        let is_parent_dir = |line: &str| -> bool {
            let prefix = format!("{}/", line);
            lines
                .iter()
                .any(|other| *other != line && other.starts_with(&prefix))
        };
        for line in &lines {
            if is_parent_dir(line) {
                continue;
            }
            // 仅考虑文件形态（过滤 locales/*.pak、.so、.desktop 等资源）
            let lower = line.to_lowercase();
            if lower.ends_with(".desktop")
                || lower.ends_with(".pak")
                || lower.ends_with(".so")
                || lower.ends_with(".so.1")
                || lower.ends_with(".png")
                || lower.ends_with(".svg")
                || lower.ends_with(".ico")
            {
                continue;
            }
            let base = line.rsplit('/').next().unwrap_or(line).to_lowercase();
            let base_no_exe = base.strip_suffix(".exe").unwrap_or(&base);
            let hit = lower_cands.iter().any(|c| {
                let cl = c.to_lowercase();
                let cl_stripped = cl.strip_suffix(".exe").unwrap_or(&cl);
                base == cl || base_no_exe == cl_stripped || *base_no_exe == *cl_stripped
            });
            if hit {
                return Some(line.to_string());
            }
        }
        // 精准匹配失败即返回 None（禁盲 fallback）
        None
    }

    /// 从原生标识与名称部件派生 Linux 候选包名（小写去重）与二进制名列表。
    #[cfg(any(target_os = "linux", test))]
    pub fn linux_candidate_names(
        native_ids: &[String],
        name_parts: &[String],
    ) -> (Vec<String>, Vec<String>) {
        let mut pkg: Vec<String> = Vec::new();
        let mut bin: Vec<String> = Vec::new();
        for id in native_ids {
            let t = id.trim();
            if t.is_empty() {
                continue;
            }
            let lower = t.to_lowercase();
            if !pkg.contains(&lower) {
                pkg.push(lower.clone());
            }
            if !bin.contains(&t.to_string()) {
                bin.push(t.to_string());
            }
            if !bin.contains(&lower) {
                bin.push(lower.clone());
            }
            // `.exe` → 裸名退化（如 `motrix.exe` → `motrix`）
            if let Some(bare) = lower.strip_suffix(".exe") {
                if bare.len() >= 2 && !pkg.iter().any(|s| s == bare) {
                    pkg.push(bare.to_string());
                }
                if !bare.is_empty() && !bin.iter().any(|s| s == bare) {
                    bin.push(bare.to_string());
                }
            }
        }
        for part in name_parts {
            let p = part.trim();
            if p.is_empty() {
                continue;
            }
            // 全名过停用词后加入 bin；仅无空格与路径分隔符的条目加入 pkg。
            let full = p.to_lowercase();
            if full.len() >= 2 && !CANDIDATE_STOP_WORDS.contains(&full.as_str()) {
                if !bin.contains(&full) {
                    bin.push(full.clone());
                }
                if !full.contains(' ') && !full.contains('/') && !pkg.contains(&full) {
                    pkg.push(full);
                }
            }
            // 按分隔符切分并过滤短词/纯数字/停用词。
            for tok in p.split(['/', '-', ' ', '_']) {
                let t = tok.trim().to_lowercase();
                if t.len() >= 3
                    && !t.chars().all(|c| c.is_ascii_digit())
                    && !CANDIDATE_STOP_WORDS.contains(&t.as_str())
                {
                    if !pkg.contains(&t) {
                        pkg.push(t.clone());
                    }
                    if !bin.contains(&t) {
                        bin.push(t);
                    }
                }
            }
        }
        (pkg, bin)
    }

    /// 从包文件列表挑选可执行文件并经 `canonicalize` 确认落盘存在。
    #[cfg(any(target_os = "linux", test))]
    pub fn pick_and_canonicalize_package_path(
        pkg_output: &str,
        candidates: &[String],
    ) -> Option<String> {
        let picked = Self::pick_executable_from_package_list(pkg_output, candidates)?;
        let p = Path::new(&picked);
        if !p.is_file() {
            return None;
        }
        // 跟随 alternatives 符号链接（如 motrix 经 /etc/alternatives 跳转）
        let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        if resolved.is_file() {
            return Some(resolved.to_string_lossy().to_string());
        }
        Some(picked)
    }

    /// 文件名/目录名归一化：小写去空格/`-`/`_`后比对（与 `/opt/Clash Verge`
    /// 带空格目录共用；纯函数，跨平台可单测）。
    pub fn normalize_fs_token(s: &str) -> String {
        s.to_lowercase()
            .chars()
            .filter(|c| *c != ' ' && *c != '-' && *c != '_')
            .collect()
    }

    /// 返回现存的 Linux `.desktop` 搜索目录（XDG 标准路径、Snap/Flatpak 与 `$XDG_DATA_DIRS`）。
    #[cfg(any(target_os = "linux", test))]
    pub fn linux_desktop_dirs() -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = vec![
            PathBuf::from("/usr/share/applications"),
            PathBuf::from("/usr/local/share/applications"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            let h = PathBuf::from(&home);
            dirs.push(h.join(".local/share/applications"));
            dirs.push(h.join(".local/share/flatpak/exports/share/applications"));
        }
        dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
        match std::env::var("XDG_DATA_DIRS") {
            Ok(xdg) => {
                for part in xdg.split(':') {
                    let t = part.trim().trim_end_matches('/');
                    if t.is_empty() {
                        continue;
                    }
                    // 若条目已以 /applications 结尾则直接采用，否则拼接后缀。
                    let p = if t.ends_with("applications") {
                        PathBuf::from(t)
                    } else {
                        PathBuf::from(t).join("applications")
                    };
                    if !dirs.contains(&p) {
                        dirs.push(p);
                    }
                }
            }
            Err(_) => {
                for d in ["/usr/local/share", "/usr/share"] {
                    let p = PathBuf::from(d).join("applications");
                    if !dirs.contains(&p) {
                        dirs.push(p);
                    }
                }
            }
        }
        let mut out: Vec<PathBuf> = Vec::new();
        for d in dirs {
            if out.contains(&d) {
                continue;
            }
            // 仅保留现存目录（过滤缺失 snap/flatpak 等路径，避免无效遍历；
            // 调用方 read_dir 失败仍会跳过，双层兜底）。
            if !d.is_dir() {
                continue;
            }
            out.push(d);
        }
        out
    }

    /// desktop stem 是否与任一 token 归一化精确相等（禁 `contains`，
    /// 防 `app` 误命中 `apport-gtk.desktop`；`len<5` 短 token 天然精确相等）。
    #[cfg(target_os = "linux")]
    fn desktop_stem_matches_exact(stem: &str, bare_tokens: &[String]) -> bool {
        let norm_stem = Self::normalize_fs_token(stem);
        if norm_stem.is_empty() {
            return false;
        }
        for t in bare_tokens {
            let tl = t.to_lowercase();
            let base = tl.strip_suffix(".exe").unwrap_or(&tl);
            if base.is_empty() || base.contains(' ') || base.contains('/') {
                continue;
            }
            // 裸名并入保持，但命中必须 basename 精确 == token（归一化后精确相等）。
            if Self::normalize_fs_token(base) == norm_stem {
                return true;
            }
        }
        false
    }

    /// Exec 二进制 basename 是否与任一 token 精确相等（小写精确，归一化兜底）。
    #[cfg(target_os = "linux")]
    fn exec_basename_matches_exact(bin: &str, bare_tokens: &[String]) -> bool {
        let base = bin.rsplit('/').next().unwrap_or(bin).to_lowercase();
        let base = base.trim().to_string();
        if base.is_empty() {
            return false;
        }
        let norm_base = Self::normalize_fs_token(&base);
        for t in bare_tokens {
            let tl = t.to_lowercase();
            let stripped = tl.strip_suffix(".exe").unwrap_or(&tl);
            if stripped.is_empty() || stripped.contains(' ') || stripped.contains('/') {
                continue;
            }
            if base == *stripped || norm_base == Self::normalize_fs_token(stripped) {
                return true;
            }
        }
        false
    }

    /// 检查 `/opt` 子目录名是否与 token 匹配（短 token 精确相等，长 token 允许目录包含或完整分段匹配）。
    #[cfg(target_os = "linux")]
    fn opt_dir_matches(norm_dir: &str, token: &str) -> bool {
        if norm_dir.is_empty() {
            return false;
        }
        let norm_tok = Self::normalize_fs_token(token);
        if norm_tok.is_empty() {
            return false;
        }
        if norm_dir == norm_tok {
            return true;
        }
        if token.len() < 5 {
            return false;
        }
        if norm_dir.contains(&norm_tok) {
            return true;
        }
        // 反向仅认完整分段相等（如 token `clash-verge-rev` 的分段 `verge` 可命中
        // 目录 `verge`，但目录 `go` 不得因 `golang` 含子串 `go` 而命中）。
        for seg in token.split(['/', '\\', '-', ' ', '_', '.']) {
            let norm_seg = Self::normalize_fs_token(seg);
            if !norm_seg.is_empty() && norm_seg == norm_dir {
                return true;
            }
        }
        false
    }

    /// Linux 系统级二进制嗅探：PATH/which → /usr/bin/<token> → /opt/<Name>/* → AppImage → desktop Exec。
    /// 仅在 linux 编译，Windows 行为不受影响。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_system_binary(config: &ScanConfig) -> Option<String> {
        Self::resolve_linux_system_binary_with_source(config).map(|(p, _)| p)
    }

    /// 同上，附命中源（`which` / `snap` / `opt` / `appimage` / `desktop`，供调试命令标记）。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_system_binary_with_source(
        config: &ScanConfig,
    ) -> Option<(String, &'static str)> {
        // 候选裸名共享派生（与 installer_install / installer_query / via_dpkg 共用 helper）：
        // `target_executables`（原生大小写 + 小写 + `.exe` 退化裸名）+ `install_dirs` 切分 token。
        let (_, bare) =
            Self::linux_candidate_names(&config.target_executables, &config.install_dirs);
        // 长 token 优先（防 `clash-verge-rev` 派生的短片段 `rev` 先命中
        // `/usr/bin/rev`，而正确二进制 `/usr/bin/clash-verge` 被淹没）。
        let mut ordered = bare.clone();
        ordered.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        // 1. PATH / which（含 /usr/bin/motrix 符号链接链；/snap/bin 已并入 which 搜索）。
        // 裸名并入保持，但 which 命中天然 basename 精确 == token（`which_binary` 按文件名
        // 精确 join，不做 contains）。
        for name in &ordered {
            // 跳过明显非命令的 token（含空格/路径分隔符）
            if name.contains(' ') || name.contains('/') || name.contains('\\') {
                continue;
            }
            if let Some(found) = Self::which_binary(name) {
                // 跟随符号链接确认最终目标存在
                let p = Path::new(&found);
                let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
                let out = if resolved.is_file() {
                    resolved.to_string_lossy().to_string()
                } else {
                    found.clone()
                };
                // snap 落盘（/snap/bin/*）单独标记来源。
                let src: &'static str = if out.starts_with("/snap/") || found.starts_with("/snap/")
                {
                    "snap"
                } else {
                    "which"
                };
                return Some((out, src));
            }
        }
        // 2. /usr/bin/<token> 直接探测（PATH 缺失时的兜底，精确 join，长优先）
        for name in &ordered {
            if name.contains(' ') || name.contains('/') {
                continue;
            }
            let cand = PathBuf::from("/usr/bin").join(name);
            if cand.is_file() {
                let resolved = std::fs::canonicalize(&cand).unwrap_or_else(|_| cand.clone());
                return Some((resolved.to_string_lossy().to_string(), "which"));
            }
            let cand_local = PathBuf::from("/usr/local/bin").join(name);
            if cand_local.is_file() {
                return Some((cand_local.to_string_lossy().to_string(), "which"));
            }
        }
        // 3. /opt 目录嗅探：read_dir 枚举 + 归一化比对（支持 `/opt/Clash Verge` 带空格），
        // 命中目录再 `find_exe_in_directory` 精准提取。
        if let Some(found) = Self::resolve_linux_via_opt(&bare, config) {
            return Some((found, "opt"));
        }
        // 3b. AppImage：~/Applications、~/AppImages、/opt/appimages/*.AppImage 按 basename==token。
        if let Some(found) = Self::resolve_linux_via_appimage(&bare) {
            return Some((found, "appimage"));
        }
        // 4. desktop Exec 解析（7 目录，见 `linux_desktop_dirs`）
        if let Some(found) = Self::resolve_linux_via_desktop(&bare) {
            return Some((found, "desktop"));
        }
        None
    }

    /// `/opt` read_dir 枚举 + 归一化比对（解决 `/opt/Clash Verge` 带空格问题）。
    /// 仅 linux 生效。先枚举匹配目录，再 `find_exe_in_directory`；直连路径作为回退保留。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_via_opt(bare_tokens: &[String], config: &ScanConfig) -> Option<String> {
        // 归一化 token 集合：bare + install_dirs 末段。
        let mut norm_tokens: Vec<(String, String)> = Vec::new();
        for t in bare_tokens.iter().chain(config.install_dirs.iter()) {
            let last = t.rsplit(['/', '\\']).next().unwrap_or(t);
            if last.trim().is_empty() {
                continue;
            }
            norm_tokens.push((t.clone(), Self::normalize_fs_token(last)));
        }
        // 枚举 /opt 一级子目录做归一化匹配。
        if let Ok(entries) = std::fs::read_dir("/opt") {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_dir() || Self::is_installer_or_cache_path(&p) {
                    continue;
                }
                let dirname = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let norm_dir = Self::normalize_fs_token(&dirname);
                let hit = norm_tokens
                    .iter()
                    .any(|(raw, _)| Self::opt_dir_matches(&norm_dir, raw));
                if !hit {
                    continue;
                }
                if let Some(found) = Self::find_exe_in_directory(&p, config) {
                    return Some(found);
                }
                // find 兜底：目录下直接按裸名查找（basename 精确 == token）。
                for name in bare_tokens {
                    if name.contains(' ') || name.contains('/') {
                        continue;
                    }
                    let cand = p.join(name);
                    if cand.is_file() {
                        return Some(cand.to_string_lossy().to_string());
                    }
                }
            }
        }
        // 回退：直连路径（/opt/<variant>）保留，防枚举权限失败时漏检。
        let mut opt_roots: Vec<PathBuf> = Vec::new();
        for d in &config.install_dirs {
            let last = d.rsplit(['/', '\\']).next().unwrap_or(d);
            for variant in [last.to_string(), last.to_lowercase(), d.clone()] {
                for root in [
                    PathBuf::from("/opt").join(&variant),
                    PathBuf::from("/opt").join(variant.to_lowercase()),
                ] {
                    if !opt_roots.contains(&root) {
                        opt_roots.push(root);
                    }
                }
            }
        }
        for name in bare_tokens {
            if name.len() < 3 {
                continue;
            }
            let mut cap = name.clone();
            if let Some(first) = cap.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            let root = PathBuf::from("/opt").join(&cap);
            if !opt_roots.contains(&root) {
                opt_roots.push(root);
            }
        }
        for root in opt_roots {
            if root.is_dir() && !Self::is_installer_or_cache_path(&root) {
                if let Some(found) = Self::find_exe_in_directory(&root, config) {
                    return Some(found);
                }
                for name in bare_tokens {
                    if name.contains(' ') || name.contains('/') {
                        continue;
                    }
                    let cand = root.join(name);
                    if cand.is_file() {
                        return Some(cand.to_string_lossy().to_string());
                    }
                }
            }
        }
        None
    }

    /// AppImage 嗅探（`~/Applications`、`~/AppImages`、`/opt/appimages/*.AppImage`
    /// 按 basename 精确 == token）。仅 linux 生效。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_via_appimage(bare_tokens: &[String]) -> Option<String> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Ok(home) = std::env::var("HOME") {
            let h = PathBuf::from(&home);
            dirs.push(h.join("Applications"));
            dirs.push(h.join("AppImages"));
        }
        dirs.push(PathBuf::from("/opt/appimages"));
        dirs.push(PathBuf::from("/opt/AppImages"));
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                let fname = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if !fname.to_lowercase().ends_with(".appimage") {
                    continue;
                }
                let stem = fname.rsplit_once('.').map(|(s, _)| s).unwrap_or(&fname);
                let stem_lower = stem.to_lowercase();
                let norm_stem = Self::normalize_fs_token(stem);
                let hit = bare_tokens.iter().any(|t| {
                    let tl = t.to_lowercase();
                    let base = tl.strip_suffix(".exe").unwrap_or(&tl);
                    if base.is_empty() || base.contains(' ') || base.contains('/') {
                        return false;
                    }
                    stem_lower == *base || norm_stem == Self::normalize_fs_token(base)
                });
                if hit {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
        None
    }

    /// 扫描 Linux `.desktop` 文件（仅精确匹配文件 stem 或 `Exec` 二进制名）并解析落盘路径。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_via_desktop(bare_tokens: &[String]) -> Option<String> {
        let desktop_dirs = Self::linux_desktop_dirs();
        // 收集候选 desktop 文件：stem 归一化精确 == token，或 Exec basename 精确 == token。
        let mut candidate_files: Vec<PathBuf> = Vec::new();
        for dir in &desktop_dirs {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                if p.extension()
                    .is_none_or(|e| !e.eq_ignore_ascii_case("desktop"))
                {
                    continue;
                }
                let fname = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                let stem = fname.strip_suffix(".desktop").unwrap_or(&fname).to_string();
                // ① filename stem 归一化 == token（精确，无 contains）。
                if Self::desktop_stem_matches_exact(&stem, bare_tokens) {
                    candidate_files.push(p);
                    continue;
                }
                // ② Exec 二进制 basename == token（需读文件解析 Exec；flatpak 包装器
                // 经 `parse_desktop_exec_binary` 返回 None 自动排除）。
                if let Ok(content) = std::fs::read_to_string(&p) {
                    let mut exec_hit = false;
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if !trimmed.starts_with("Exec=") {
                            continue;
                        }
                        if let Some(bin) = Self::parse_desktop_exec_binary(trimmed) {
                            if Self::exec_basename_matches_exact(&bin, bare_tokens) {
                                exec_hit = true;
                                break;
                            }
                        }
                    }
                    if exec_hit {
                        candidate_files.push(p);
                    }
                }
            }
        }
        // 同步检查裸名对应的 desktop 名（如 vlc → vlc.desktop，由 `linux_candidate_names` 并入 bare，此处按 bare 补齐精确文件名）
        for base in bare_tokens {
            let b = base.to_lowercase();
            let stem = b.strip_suffix(".exe").unwrap_or(&b);
            if stem.is_empty() || stem.contains(' ') || stem.contains('/') {
                continue;
            }
            for dir in &desktop_dirs {
                let p = dir.join(format!("{}.desktop", stem));
                if p.is_file() && !candidate_files.contains(&p) {
                    candidate_files.push(p);
                }
            }
        }
        for desktop in candidate_files {
            let Ok(content) = std::fs::read_to_string(&desktop) else {
                continue;
            };
            for line in content.lines() {
                let trimmed = line.trim();
                if !trimmed.starts_with("Exec=") {
                    continue;
                }
                if let Some(bin) = Self::parse_desktop_exec_binary(trimmed) {
                    if let Some(resolved) = Self::resolve_binary_via_path(&bin) {
                        return Some(resolved);
                    }
                }
            }
        }
        None
    }

    /// 通过 `dpkg -L` 查询候选包名并挑选落盘可执行文件。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_via_dpkg(tokens: &[String], config: &ScanConfig) -> Option<String> {
        Self::resolve_linux_via_dpkg_with_source(tokens, config).map(|(p, _)| p)
    }

    /// 同上，附命中源（恒为 `dpkg`）。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_via_dpkg_with_source(
        tokens: &[String],
        config: &ScanConfig,
    ) -> Option<(String, &'static str)> {
        let (pkgs, cands) = Self::linux_candidate_names(&config.target_executables, tokens);
        for pkg in pkgs {
            let out = std::process::Command::new("dpkg")
                .args(["-L", &pkg])
                .output();
            let Ok(output) = out else {
                continue;
            };
            if !output.status.success() {
                continue;
            }
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if let Some(picked) = Self::pick_and_canonicalize_package_path(&text, &cands) {
                return Some((picked, "dpkg"));
            }
        }
        None
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

    /// 解析应用的安装时间戳（依次尝试注册表 `InstallDate`、`LastWriteTime` 与文件系统时间）。
    pub fn resolve_app_installed_at(
        app_name: &str,
        app_id: &str,
        install_path: &str,
    ) -> Option<i64> {
        #[cfg(not(target_os = "windows"))]
        let _ = (app_name, app_id);
        #[cfg(target_os = "windows")]
        {
            use winreg::enums::*;
            use winreg::RegKey;

            let mut tokens = Vec::new();
            let name_clean = app_name.trim().to_lowercase();
            if !name_clean.is_empty() {
                tokens.push(name_clean.clone());
            }
            if let Some((_, repo)) = app_id.rsplit_once('/') {
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
                        if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                            let disp_name: String = app_key
                                .get_value::<String, _>("DisplayName")
                                .unwrap_or_default()
                                .trim()
                                .to_string();

                            let is_match =
                                Self::registry_entry_matches_tokens(&disp_name, &key_name, &tokens);

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

#[cfg(test)]
mod path_resolution_tests {
    use super::*;

    #[test]
    fn is_search_token_dedups_shape_condition() {
        // 停用词、短 token、纯数字一律过滤（唯一收敛点）。
        assert!(!AppScanner::is_search_token("app"));
        assert!(!AppScanner::is_search_token("tool"));
        assert!(!AppScanner::is_search_token("ab"));
        assert!(!AppScanner::is_search_token("12"));
        assert!(!AppScanner::is_search_token("999"));
        assert!(!AppScanner::is_search_token(""));
        // 正常 token 通过。
        assert!(AppScanner::is_search_token("vlc"));
        assert!(AppScanner::is_search_token("motrix"));
        assert!(AppScanner::is_search_token("clash-verge-rev"));
    }

    #[test]
    fn build_tokens_filters_stop_short_digit_and_extends_config() {
        let mut config = ScanConfig::from("motrix");
        let tokens = AppScanner::build_tokens(
            "Motrix App",
            "motrix-app-999",
            "agalwood/motrix",
            &mut config,
        );
        // 独立停用词 / 纯数字 / 短 token 不得作为独立 token 出现。
        assert!(!tokens.iter().any(|t| t == "app"));
        assert!(!tokens.iter().any(|t| t == "999"));
        assert!(tokens.iter().any(|t| t == "motrix"));
        // 首段回退分支同样受形状过滤（"motrix-app" 保留，"app" 不保留）。
        assert!(tokens.iter().any(|t| t == "motrix-app"));
        // 配置扩展与 token 同源：安装目录与可执行名按序并入。
        assert!(config.install_dirs.iter().any(|d| d == "motrix"));
        assert!(config.target_executables.iter().any(|e| e == "motrix.exe"));
        assert!(config
            .target_executables
            .iter()
            .any(|e| e == "motrix-gui.exe"));
    }

    #[test]
    fn lnk_dir_predicates_match_expected_filenames() {
        // shortcut_scan 风格：token 子串匹配（已小写）。
        let tokens = ["vlc".to_string()];
        let shortcut_pred = |fname: &str| tokens.iter().any(|t| fname.contains(t));
        assert!(shortcut_pred("vlc.lnk"));
        assert!(!shortcut_pred("other.lnk"));

        // resolve_executable_path 风格：exe 基名或安装目录名匹配。
        let config = ScanConfig {
            target_executables: vec!["vlc.exe".to_string()],
            install_dirs: vec!["vlc".to_string()],
            search_subdirs: vec![],
        };
        let exe_pred = |fname: &str| {
            config.target_executables.iter().any(|exe| {
                let base = exe.trim_end_matches(".exe").to_lowercase();
                !base.is_empty() && fname.contains(&base)
            }) || config
                .install_dirs
                .iter()
                .any(|d| fname.contains(&d.to_lowercase()))
        };
        assert!(exe_pred("vlc.lnk"));
        assert!(!exe_pred("other.lnk"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn scan_lnk_dir_traverses_temp_dirs_without_filesystem_side_effects() {
        // 仅使用临时目录，不依赖本机真实快捷方式目录。
        let dir = tempfile::tempdir().expect("tempdir");
        // 空目录：无论谓词真假均返回 None。
        assert!(AppScanner::scan_lnk_dir(dir.path(), |_| true).is_none());
        assert!(AppScanner::scan_lnk_dir(dir.path(), |_| false).is_none());
        // 非 .lnk 文件不触发解析。
        std::fs::write(dir.path().join("note.txt"), b"hello").unwrap();
        assert!(AppScanner::scan_lnk_dir(dir.path(), |_| true).is_none());
        // 损坏的 .lnk：谓词命中也不 panic，优雅返回 None。
        std::fs::write(dir.path().join("vlc.lnk"), b"invalid header data").unwrap();
        assert!(AppScanner::scan_lnk_dir(dir.path(), |fname| fname.contains("vlc")).is_none());
        // 一级子目录同样被遍历（损坏 .lnk 仍返回 None，不 panic）。
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("vlc.lnk"), b"invalid header data").unwrap();
        assert!(AppScanner::scan_lnk_dir(dir.path(), |fname| fname.contains("vlc")).is_none());
        // 谓词为假时不触及解析，直接返回 None。
        assert!(AppScanner::scan_lnk_dir(dir.path(), |_| false).is_none());
        // 不存在路径与文件路径均返回 None。
        assert!(AppScanner::scan_lnk_dir(&dir.path().join("missing"), |_| true).is_none());
        let file_root = dir.path().join("note.txt");
        assert!(AppScanner::scan_lnk_dir(&file_root, |_| true).is_none());
    }

    #[test]
    fn build_tokens_excludes_owner_prefix_and_generic_server_segment() {
        // 回归 F-16：mozilla/pdf.js 不得产出 mozilla；org/code-server 不得产出 org/code/server。
        let mut cfg1 = ScanConfig::from("pdf.js");
        let pdf_tokens = AppScanner::build_tokens("PDF.js", "mozilla/pdf.js", "pdf.js", &mut cfg1);
        assert!(
            !pdf_tokens.iter().any(|t| t == "mozilla" || t.contains('/')),
            "owner prefix must not enter tokens: {:?}",
            pdf_tokens
        );
        assert!(pdf_tokens.iter().any(|t| t == "pdf.js"));
        assert!(
            !AppScanner::registry_entry_matches_tokens(
                "Mozilla Firefox (x64 en-US)",
                "Mozilla Firefox 128.0",
                &pdf_tokens,
            ),
            "mozilla/pdf.js must not match Mozilla Firefox"
        );

        let mut cfg2 = ScanConfig::from("code-server");
        let cs_tokens =
            AppScanner::build_tokens("code-server", "org/code-server", "code-server", &mut cfg2);
        assert!(
            !cs_tokens
                .iter()
                .any(|t| matches!(t.as_str(), "org" | "code" | "server") || t.contains('/')),
            "owner and generic stop-word segments must not enter tokens: {:?}",
            cs_tokens
        );
        assert!(cs_tokens.iter().any(|t| t == "code-server"));
        assert!(
            !AppScanner::registry_entry_matches_tokens(
                "Microsoft SQL Server 2022",
                "SQLServer2022",
                &cs_tokens,
            ),
            "org/code-server must not match SQL Server"
        );
        assert!(
            AppScanner::registry_entry_matches_tokens(
                "code-server 4.90.0",
                "{1234-5678}",
                &cs_tokens,
            ),
            "legitimate word-boundary display name must still match"
        );
    }

    #[test]
    fn registry_entry_matching_enforces_word_boundaries_and_no_reverse_substring() {
        let picgo_tokens = vec!["picgo".to_string()];
        assert!(AppScanner::registry_entry_matches_tokens(
            "PicGo",
            "{GUID}",
            &picgo_tokens
        ));
        assert!(AppScanner::registry_entry_matches_tokens(
            "PicGo 2.4.0",
            "{GUID}",
            &picgo_tokens
        ));
        assert!(
            !AppScanner::registry_entry_matches_tokens(
                "SuperPicGoPro",
                "SuperPicGoPro",
                &picgo_tokens
            ),
            "mid-word substring must not match"
        );

        let vscode_tokens = vec!["visual studio code".to_string()];
        assert!(AppScanner::registry_entry_matches_tokens(
            "Microsoft Visual Studio Code (User)",
            "{GUID}",
            &vscode_tokens
        ));
        assert!(
            !AppScanner::registry_entry_matches_tokens("Code", "Code", &vscode_tokens),
            "short unrelated DisplayName must not reverse-match longer token"
        );
    }
}
