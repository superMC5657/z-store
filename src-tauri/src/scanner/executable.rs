use super::{AppScanner, ScanConfig};
use std::path::{Path, PathBuf};

/// 候选名通用停用词（`resolve_installed_app_path` token 过滤与 `linux_candidate_names`
/// 切分过滤同源共用；防 `app` / `tool` / `test` 等通用词误命中 `/usr/bin/test`、
/// `apport-gtk.desktop` 同类误配）。
const CANDIDATE_STOP_WORDS: &[&str] = &[
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
    "test",
    "tests",
];

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
                // 2b. Linux：可执行位文件直接认可（deb 落盘如 /usr/bin/motrix、/opt/Motrix/motrix
                // 均无 .exe 扩展名；Windows 行为不变）。
                #[cfg(target_os = "linux")]
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

        // 2c. Linux 系统级嗅探：PATH/which、/usr/bin/<token>、/opt/<Name>/*、
        // /usr/share/applications/*.desktop Exec 解析（Windows 包裹在 cfg 内，不受影响）。
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

        const STOP_WORDS: &[&str] = CANDIDATE_STOP_WORDS;

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
            // Linux：裸名并入（/usr/bin/<token>、desktop Exec 多为无扩展名；
            // Windows 编译时不执行此块，行为不变）。
            #[cfg(target_os = "linux")]
            {
                if !config.target_executables.contains(t) {
                    config.target_executables.push(t.clone());
                }
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

        // 4. 便携版默认解压目录回退探测（优先于系统级 PATH，避免通用词 token
        // 如 "test" 误命中 /usr/bin/test；系统 deb 包无便携目录，不受影响）
        let portable_dir = crate::installer::dirs_or_fallback_with_base(app_id, None);
        if portable_dir.is_dir() {
            if let Some(exe) = Self::find_exe_in_directory(&portable_dir, &config) {
                return Some(exe);
            }
        }

        // 4b. Linux 系统级嗅探：PATH/which、/usr/bin/<token>、/opt/<Name>/*、
        // /usr/share/applications/*.desktop Exec 解析 + dpkg -L 回退。
        // Windows 编译时整块消除，行为不变。
        #[cfg(target_os = "linux")]
        {
            if let Some(found) = Self::resolve_linux_system_binary(&config) {
                return Some(found);
            }
            if let Some(found) = Self::resolve_linux_via_dpkg(&tokens, &config) {
                return Some(found);
            }
        }

        // 5. 调用已有 resolve_executable_path
        Self::resolve_executable_path(None, None, config)
    }

    // ========================================================================
    // Linux 桌面文件 / PATH / dpkg 解析（纯函数跨平台可测，文件系统嗅探仅 linux 生效）
    // ========================================================================

    /// 解析 `.desktop` Exec 值为可执行二进制（去 `%U/%F` 等字段码、引号、`env VAR=..` 前缀）。
    /// 纯函数，跨平台可单测。返回裸命令或绝对路径字符串（不校验存在性）。
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
            while idx < tokens.len() && tokens[idx].contains('=') && !tokens[idx].contains('/')
            {
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

    /// 将二进制（绝对路径或裸命令）解析为磁盘真实路径：
    /// 绝对路径要求 `is_file` 且（Unix 上）有执行位；裸命令按 `PATH` 逐目录查找（含可执行位校验）。
    /// 无执行位一律返回 None（禁无条件放行，防误命中数据文件；赋权/提权由调用方显式处理）。
    /// 纯文件系统函数，Linux/Windows 均可调用（Windows 上退化为 is_file 检查）。
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

    /// 在 `PATH` 中查找裸命令。
    /// PATH 在 GUI/服务进程中可能稀疏，显式补齐标准绑定目录（FHS/XDG）：
    /// `/usr/local/bin`（本地编译）、`/usr/bin`、`/bin`（与 `/usr/bin` 符号链接兼容）、
    /// `~/.local/bin`（XDG 用户级）。
    /// 注：`/opt/bin` 非标准 FHS 路径，已删（`/opt/<Name>` 由 `resolve_linux_system_binary` 专管）。
    /// Unix 上必须有执行位才放行（无执行位返回 None；符号链接经 metadata 跟随目标判定）。
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
        for extra in ["/usr/local/bin", "/usr/bin", "/bin"] {
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

    /// 从包文件列表输出中挑选可执行文件（纯函数，可单测；`dpkg -L` / `rpm -ql` 共用）：
    /// 仅按候选裸名精准匹配（`/usr/bin/<cand>` 或以 `/<cand>` 结尾，大小写不敏感，`.exe` 退化裸名），
    /// 匹配不上返回 None（禁首个文件盲 fallback，防误命中无关二进制）。
    /// 目录项（如 `/opt/Motrix`，其后必有以 `该行 + "/"` 开头的内容行）一律跳过，
    /// 避免 basename 恰好等于候选名（如 Motrix 目录 vs motrix 二进制）时误命中目录。
    pub fn pick_executable_from_package_list(
        dpkg_output: &str,
        candidates: &[String],
    ) -> Option<String> {
        let lower_cands: Vec<String> =
            candidates.iter().map(|c| c.to_lowercase()).collect();
        // 先收集有效行，识别父目录项（任一其他行以 `line + "/"` 开头即为目录）。
        let lines: Vec<&str> = dpkg_output
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && *l != "/." && !l.ends_with('/'))
            .collect();
        let is_parent_dir = |line: &str| -> bool {
            let prefix = format!("{}/", line);
            lines.iter().any(|other| *other != line && other.starts_with(&prefix))
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

    /// Linux 候选名派生共享 helper（installer_install 包名/二进制回填、installer_query 4b 兜底、
    /// scanner `resolve_linux_via_dpkg` / `resolve_linux_system_binary` 四处复用，收敛重复派生）。
    /// 输入原生标识（catalog linux 标识或 `target_executables`）与名称部件（repo/id/name 或 tokens），
    /// 返回 `(pkg_names, bin_names)`：pkg 全小写去重（`dpkg -L` / `rpm -ql` 包名用，
    /// 含空格/路径分隔符的长名不入 pkg，防占位挤掉有效包名），
    /// bin 保留原大小写 + 小写（which/desktop 精准匹配用）。
    /// `.exe` 后缀自动退化出裸名（Linux 落盘多为无扩展名）。
    /// 纯函数，跨平台可单测。
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
            // 全名小写：bin 照收（含空格长名，调用方 which 时跳过含空格项）；
            // pkg 仅收无空格/无路径分隔符项（`dpkg -L` 包名语义）。
            // 全名同样过停用词（防单字通用名如 `App` 直驱 `apport-gtk.desktop` 误配；
            // catalog 原生标识不受此限，真实应用仍可经标识命中）。
            let full = p.to_lowercase();
            if full.len() >= 2 && !CANDIDATE_STOP_WORDS.contains(&full.as_str()) {
                if !bin.contains(&full) {
                    bin.push(full.clone());
                }
                if !full.contains(' ') && !full.contains('/') && !pkg.contains(&full) {
                    pkg.push(full);
                }
            }
            // 切分 token（按 `/ - _` 空格，`owner/repo` 末段天然覆盖，无需单列）：
            // 与 `resolve_installed_app_path` 同规则：len>=3、非纯数字、非停用词
            // （防切分复活通用词，如 `non-existent-app-999` → `app` 误命中 `apport-gtk.desktop`）。
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

    /// 包文件列表输出 → 精准挑选 → 落盘规范化（deb/rpm 回填与 scanner dpkg 嗅探三处复用，
    /// 收敛 `pick → is_file → canonicalize` 重复）。
    /// 挑选失败或落盘不存在返回 None（调用方继续走 which/desktop 嗅探）。
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

    /// Linux 系统级二进制嗅探：PATH/which → /usr/bin/<token> → /opt/<Name>/* → desktop Exec。
    /// 仅在 linux 编译，Windows 行为不受影响。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_system_binary(config: &ScanConfig) -> Option<String> {
        // 候选裸名共享派生（与 installer_install / installer_query / via_dpkg 共用 helper）：
        // `target_executables`（原生大小写 + 小写 + `.exe` 退化裸名）+ `install_dirs` 切分 token。
        let (_, bare) =
            Self::linux_candidate_names(&config.target_executables, &config.install_dirs);
        // 1. PATH / which（含 /usr/bin/motrix 符号链接链）
        for name in &bare {
            // 跳过明显非命令的 token（含空格/路径分隔符）
            if name.contains(' ') || name.contains('/') || name.contains('\\') {
                continue;
            }
            if let Some(found) = Self::which_binary(name) {
                // 跟随符号链接确认最终目标存在
                let p = Path::new(&found);
                let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
                if resolved.is_file() {
                    return Some(resolved.to_string_lossy().to_string());
                }
                return Some(found);
            }
        }
        // 2. /usr/bin/<token> 直接探测（PATH 缺失时的兜底）
        for name in &bare {
            if name.contains(' ') || name.contains('/') {
                continue;
            }
            let cand = PathBuf::from("/usr/bin").join(name);
            if cand.is_file() {
                let resolved =
                    std::fs::canonicalize(&cand).unwrap_or_else(|_| cand.clone());
                return Some(resolved.to_string_lossy().to_string());
            }
            let cand_local = PathBuf::from("/usr/local/bin").join(name);
            if cand_local.is_file() {
                return Some(cand_local.to_string_lossy().to_string());
            }
        }
        // 3. /opt/<Name>/* 目录嗅探（Motrix 落盘 /opt/Motrix/motrix）
        let mut opt_roots: Vec<PathBuf> = Vec::new();
        for d in &config.install_dirs {
            // install_dirs 可能含 Windows 风格 `VideoLAN\VLC`，取末段
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
        // 额外：/opt 下首字母大写变体（如 Motrix）
        for name in bare.clone() {
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
                // find 兜底：root 下直接按裸名查找
                for name in &bare {
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
        // 4. desktop Exec 解析（/usr/share/applications 系统级 + /usr/local/share 本地编译 +
        // ~/.local/share XDG 用户级，见 `resolve_linux_via_desktop` 注释）
        if let Some(found) = Self::resolve_linux_via_desktop(&bare) {
            return Some(found);
        }
        None
    }

    /// Linux desktop 文件嗅探：文件名/Name 与 token 匹配 → 解析 Exec → 落盘路径。
    /// 全仓唯一的 desktop walker（installer 回填与系统嗅探共用，收敛 executor 侧重复实现）。
    /// 桌面目录：`/usr/share/applications`（发行版包，如 motrix.deb 落盘处，commit 主语义）
    /// + `/usr/local/share/applications`（FHS 本地编译安装）+ `~/.local/share/applications`
    /// （XDG 用户级，如 `pip --user` / 手动安装）。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_via_desktop(bare_tokens: &[String]) -> Option<String> {
        let mut desktop_dirs: Vec<PathBuf> = vec![
            PathBuf::from("/usr/share/applications"),
            PathBuf::from("/usr/local/share/applications"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            desktop_dirs.push(PathBuf::from(home).join(".local/share/applications"));
        }
        // 收集候选 desktop 文件：文件名含 token 或 Name=/Exec 含 token
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
                if p.extension().is_none_or(|e| !e.eq_ignore_ascii_case("desktop")) {
                    continue;
                }
                let fname = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                let stem = fname.strip_suffix(".desktop").unwrap_or(&fname).to_string();
                let matched = bare_tokens.iter().any(|t| {
                    let tl = t.to_lowercase();
                    stem == tl || stem.contains(&tl) || tl.contains(&stem)
                });
                if matched {
                    candidate_files.push(p);
                    continue;
                }
                // 文件名未命中时读 Name= 再判定（避免全量解析开销过大，仅读首 4KB）
                if let Ok(content) = std::fs::read_to_string(&p) {
                    let name_line = content
                        .lines()
                        .find(|l| l.trim_start().starts_with("Name="))
                        .unwrap_or("")
                        .to_lowercase();
                    if bare_tokens.iter().any(|t| {
                        let tl = t.to_lowercase();
                        name_line.contains(&tl) || tl.contains(&stem)
                    }) {
                        candidate_files.push(p);
                    }
                }
            }
        }
        // 同步检查裸名对应的 desktop 名（如 vlc → vlc.desktop；原 config.target_executables
        // 派生已由 `linux_candidate_names` 并入 bare，此处直接按 bare 补齐精确文件名，避免漏检）
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

    /// Linux dpkg 回退：对候选包名执行 `dpkg -L` 并精准挑选可执行文件。
    /// 包名/候选名共享派生（`linux_candidate_names`），挑选 + 规范化共用
    /// `pick_and_canonicalize_package_path`（与 executor deb/rpm 回填同一函数）。
    #[cfg(target_os = "linux")]
    pub fn resolve_linux_via_dpkg(
        tokens: &[String],
        config: &ScanConfig,
    ) -> Option<String> {
        // 候选包名共享派生（包名最多 6 个，防进程放量；原语义保留）
        let (mut pkgs, cands) = Self::linux_candidate_names(&config.target_executables, tokens);
        pkgs.truncate(6);
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
                return Some(picked);
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
