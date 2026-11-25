#[cfg(any(target_os = "windows", test))]
use std::path::Path;
use std::path::PathBuf;

/// 获取当前系统用户的主目录（跨平台：Windows: USERPROFILE / HOMEDRIVE+HOMEPATH；Unix: HOME）
pub fn user_home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let p = PathBuf::from(profile);
            if p.exists() {
                return Some(p);
            }
        }
        if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
            let p = PathBuf::from(format!("{}{}", drive, path));
            if p.exists() {
                return Some(p);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 默认下载安装包位置：统一为各操作系统的用户下载文件夹 `~/Downloads`
/// （Windows: %USERPROFILE%\Downloads；macOS/Linux: $HOME/Downloads）
pub fn default_download_dir() -> PathBuf {
    if let Some(home) = user_home_dir() {
        return home.join("Downloads");
    }
    std::env::temp_dir().join("Downloads")
}

pub fn expand_env_path(path_str: &str) -> PathBuf {
    let trimmed = path_str.trim();
    if trimmed.is_empty() {
        return default_download_dir();
    }

    // 跨平台识别波浪号 ~ 前缀（~/Downloads 或 ~\Downloads 或 单独 ~）
    if trimmed == "~" {
        return user_home_dir().unwrap_or_else(default_download_dir);
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = user_home_dir() {
            let sub_path: PathBuf = rest.split(['/', '\\']).collect();
            return home.join(sub_path);
        }
    }

    let mut expanded = trimmed.to_string();
    #[cfg(target_os = "windows")]
    {
        if expanded.contains('%') {
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                expanded = expanded.replace("%LOCALAPPDATA%", &local_app_data);
            }
            if let Ok(user_profile) = std::env::var("USERPROFILE") {
                expanded = expanded.replace("%USERPROFILE%", &user_profile);
            }
            if let Ok(temp) = std::env::var("TEMP") {
                expanded = expanded.replace("%TEMP%", &temp);
            }
            if let Ok(appdata) = std::env::var("APPDATA") {
                expanded = expanded.replace("%APPDATA%", &appdata);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if expanded.starts_with("$HOME") {
            if let Ok(home) = std::env::var("HOME") {
                expanded = expanded.replacen("$HOME", &home, 1);
            }
        }
    }

    PathBuf::from(expanded)
}

/// 将 canonical id 中的 `/` 折叠为 `-` 并过滤危险字符，生成安全的安装目录名。
fn sanitize_dir_name(app_id: &str) -> String {
    let safe_id: String = app_id
        .chars()
        .map(|c| if c == '/' { '-' } else { c })
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if safe_id.is_empty() || safe_id.starts_with('.') {
        "app".to_string()
    } else {
        safe_id
    }
}

pub fn dirs_or_fallback_with_base(app_id: &str, custom_base: Option<&str>) -> PathBuf {
    let clean_id = sanitize_dir_name(app_id);

    if let Some(base) = custom_base {
        let trimmed = base.trim();
        if !trimmed.is_empty() {
            let expanded_base = expand_env_path(trimmed);
            return expanded_base.join(&clean_id);
        }
    }

    dirs_or_fallback(app_id)
}

pub fn dirs_or_fallback(app_id: &str) -> PathBuf {
    let clean_id = sanitize_dir_name(app_id);

    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(app_data)
                .join("Programs")
                .join("z-store-apps")
                .join(clean_id);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Applications")
                .join("z-store-apps")
                .join(clean_id);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("bin")
                .join("z-store-apps")
                .join(clean_id);
        }
    }

    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        PathBuf::from(home).join(".z-store-apps").join(clean_id)
    } else {
        std::env::temp_dir().join("z-store-apps").join(clean_id)
    }
}

/// 当前用户桌面目录（`%USERPROFILE%\Desktop`，缺失时回退公共桌面）。
#[cfg(target_os = "windows")]
pub fn user_desktop_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(|p| PathBuf::from(p).join("Desktop"))
        .unwrap_or_else(|_| PathBuf::from(r"C:\Users\Public\Desktop"))
}

/// 在指定桌面目录内查找安全消毒后的同名快捷方式（按应用名、应用 id 依次匹配）。
/// 先经 `sanitize_shortcut_name` 剥离分隔符，再经 canonicalize 校验严格位于桌面目录内，
/// 杜绝 `..` 路径穿越或指向桌面外的符号链接。
#[cfg(target_os = "windows")]
pub(crate) fn find_desktop_shortcut_in(
    desktop: &Path,
    app_name: &str,
    app_id: &str,
) -> Option<PathBuf> {
    let canon_desktop = desktop.canonicalize().ok()?;
    let mut seen: Vec<String> = Vec::new();
    for raw in [app_name, app_id] {
        if raw.trim().is_empty() {
            continue;
        }
        let clean = sanitize_shortcut_name(raw);
        let key = clean.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let lnk = desktop.join(format!("{}.lnk", clean));
        if !lnk.is_file() {
            continue;
        }
        let Ok(canon_lnk) = lnk.canonicalize() else {
            continue;
        };
        if canon_lnk.starts_with(&canon_desktop)
            && canon_lnk.parent() == Some(canon_desktop.as_path())
        {
            return Some(canon_lnk);
        }
    }
    None
}

/// 启动兜底用的桌面同名快捷方式（按应用名、应用 id 依次匹配，仅返回桌面目录内的真实文件）。
#[cfg(target_os = "windows")]
pub fn find_desktop_shortcut(app_name: &str, app_id: &str) -> Option<PathBuf> {
    let desktop = user_desktop_dir();
    find_desktop_shortcut_in(&desktop, app_name, app_id)
}

/// Linux 主程序候选（按优先级）：`*.desktop` 的 Exec 解析结果在前，其后为 PATH/which 命中；
/// 含空格或路径分隔符的名称不参与 PATH 查找。
#[cfg(target_os = "linux")]
pub fn linux_binary_candidates(bare_names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(found) = crate::scanner::AppScanner::resolve_linux_via_desktop(bare_names) {
        out.push(found);
    }
    for name in bare_names {
        if name.contains(' ') || name.contains('/') || name.contains('\\') {
            continue;
        }
        if let Some(found) = crate::scanner::AppScanner::which_binary(name) {
            if !out.contains(&found) {
                out.push(found);
            }
        }
    }
    out
}

/// 快捷方式文件名消毒：过滤 Windows 非法文件名字符 `\ / : * ? " < > |`，去首尾空白，
/// 清洗后为空则回退 "App"。创建侧与卸载侧（desktop .lnk 清理）共用此唯一口径，
/// 保证「能创建的快捷方式名」与「会删除的名字」字符集一致，特殊名不会被删到 Desktop 之外。
pub fn sanitize_shortcut_name(app_name: &str) -> String {
    let clean_name: String = app_name
        .chars()
        .filter(|c| !['\\', '/', ':', '*', '?', '"', '<', '>', '|'].contains(c))
        .collect();
    let safe_name = clean_name.trim();
    if safe_name.is_empty() {
        "App".to_string()
    } else {
        safe_name.to_string()
    }
}

/// 创建桌面快捷方式的固定 PowerShell 脚本：名称、目标与工作目录只经进程环境变量读入，
/// 脚本文本永不拼接任何外部字符串（归档内 `.exe` 文件名可含 `'`、Unicode 智能引号 `‘’‚‛`
/// 等 PowerShell 字符串定界符，拼接即注入）。
#[cfg(any(target_os = "windows", test))]
const SHORTCUT_PS_SCRIPT: &str = "$ErrorActionPreference='Stop';\
$d=[Environment]::GetFolderPath('Desktop');\
$s=(New-Object -COM WScript.Shell).CreateShortcut([IO.Path]::Combine($d, $env:ZSTORE_LNK_NAME + '.lnk'));\
$s.TargetPath=$env:ZSTORE_LNK_TARGET;\
$s.WorkingDirectory=$env:ZSTORE_LNK_WORKDIR;\
$s.Save()";

/// 快捷方式 PowerShell 调用参数（纯函数）：固定 argv + 承载全部外部输入的环境变量。
#[cfg(any(target_os = "windows", test))]
fn shortcut_powershell_invocation(
    app_name: &str,
    exe_path: &Path,
) -> (Vec<&'static str>, Vec<(&'static str, std::ffi::OsString)>) {
    let working_dir = exe_path.parent().unwrap_or(exe_path);
    let argv = vec![
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        SHORTCUT_PS_SCRIPT,
    ];
    let envs = vec![
        ("ZSTORE_LNK_NAME", sanitize_shortcut_name(app_name).into()),
        ("ZSTORE_LNK_TARGET", exe_path.as_os_str().to_os_string()),
        ("ZSTORE_LNK_WORKDIR", working_dir.as_os_str().to_os_string()),
    ];
    (argv, envs)
}

#[cfg(target_os = "windows")]
pub fn create_desktop_shortcut(app_name: &str, exe_path: &Path) {
    // 单元测试期间禁止在真实桌面创建任何快捷方式
    if cfg!(test) {
        return;
    }
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let (argv, envs) = shortcut_powershell_invocation(app_name, exe_path);
    let _ = std::process::Command::new("powershell")
        .args(argv)
        .envs(envs)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// 开始菜单程序组内的卸载快捷方式：包名先经 `sanitize_shortcut_name` 剥离分隔符，
/// 拼接结果必然落在 `base` 之下（绝对路径的盘符/根分隔符与 `..` 均随之失效）；
/// 命中的 `.lnk` 再经 canonicalize + 前缀断言确认仍在程序组目录内才返回。
#[cfg(target_os = "windows")]
fn start_menu_uninstall_lnk(base: &Path, app_name: &str) -> Option<PathBuf> {
    let sdir = base.join(sanitize_shortcut_name(app_name));
    let canon_sdir = sdir.canonicalize().ok()?;
    let entries = std::fs::read_dir(&canon_sdir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if fname.contains("uninstall") && fname.ends_with(".lnk") && path.is_file() {
            let canon = path.canonicalize().ok()?;
            if canon.starts_with(&canon_sdir) {
                return Some(canon);
            }
        }
    }
    None
}

/// UTF-8 安全的整词边界匹配：`needle` 在 `haystack` 中出现时，前后不能紧邻字母或数字。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
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

/// 去除 `-` / `_` / `.` / 空白后的紧凑小写形式，用于 `my-tool.app` 与 `mytoolapp` 的全等校验。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn normalize_compact(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '-' | '_' | '.' | ' '))
        .collect()
}

/// 非全等词边界匹配时的最小安全长度（字符数），防止 `Go`/`Git`/`fd` 等短名误伤无关软件。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const UNINSTALL_WORD_MATCH_MIN_CHARS: usize = 4;

/// 禁止用于非全等回退匹配的泛用词（全等匹配不受此限）。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_generic_uninstall_word(lower: &str) -> bool {
    matches!(
        lower,
        "app"
            | "apps"
            | "code"
            | "client"
            | "server"
            | "service"
            | "tool"
            | "tools"
            | "studio"
            | "desktop"
            | "windows"
            | "installer"
            | "setup"
            | "helper"
            | "manager"
            | "launcher"
            | "editor"
            | "viewer"
            | "player"
            | "suite"
            | "system"
            | "microsoft"
            | "google"
            | "apple"
    )
}

/// 卸载注册表条目 DisplayName 与应用的匹配口径（纯函数）：
/// 仅允许全等、紧凑全等（长度 >= 4）或正向严格词边界匹配（长度 >= 4 且非泛用词）；
/// 禁用双向裸子串 `.contains()`，并剥离 `app_id` 的 `owner/` 前缀，避免短名或组织名误调无关卸载器。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn uninstall_display_name_matches(display_name: &str, app_name: &str, app_id: &str) -> bool {
    let disp_lower = display_name.trim().to_lowercase();
    if disp_lower.is_empty() {
        return false;
    }
    let name_lower = app_name.trim().to_lowercase();
    let id_lower = app_id.trim().to_lowercase();
    let repo_lower = id_lower
        .rsplit('/')
        .next()
        .unwrap_or(&id_lower)
        .trim()
        .to_string();

    // 1. 精确全等（支持任意长度，包括 "Go" / "Git" / "fd"）
    if (!name_lower.is_empty() && disp_lower == name_lower)
        || (!id_lower.is_empty() && disp_lower == id_lower)
        || (!repo_lower.is_empty() && disp_lower == repo_lower)
    {
        return true;
    }

    // 2. 去分隔符紧凑全等（长度 >= 4，不退化为子串包含）
    let disp_compact = normalize_compact(&disp_lower);
    if disp_compact.chars().count() >= UNINSTALL_WORD_MATCH_MIN_CHARS {
        for cand in [name_lower.as_str(), repo_lower.as_str()] {
            let cand_compact = normalize_compact(cand);
            if cand_compact.chars().count() >= UNINSTALL_WORD_MATCH_MIN_CHARS
                && disp_compact == cand_compact
            {
                return true;
            }
        }
    }

    // 3. 正向严格词边界匹配（仅 DisplayName 含应用名/仓库名，不反向包含）
    for cand in [name_lower.as_str(), repo_lower.as_str()] {
        if cand.chars().count() >= UNINSTALL_WORD_MATCH_MIN_CHARS
            && !is_generic_uninstall_word(cand)
            && contains_word_boundary(&disp_lower, cand)
        {
            return true;
        }
    }

    false
}

/// 精确全等判定（用于在多个 DisplayName 回退候选中优先挑选全等条目）。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn uninstall_display_name_is_exact(display_name: &str, app_name: &str, app_id: &str) -> bool {
    let disp_lower = display_name.trim().to_lowercase();
    if disp_lower.is_empty() {
        return false;
    }
    let name_lower = app_name.trim().to_lowercase();
    let id_lower = app_id.trim().to_lowercase();
    let repo_lower = id_lower.rsplit('/').next().unwrap_or(&id_lower).trim();
    (!name_lower.is_empty() && disp_lower == name_lower)
        || (!id_lower.is_empty() && disp_lower == id_lower)
        || (!repo_lower.is_empty() && disp_lower == repo_lower)
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone)]
struct RegUninstallCandidate {
    display_name: String,
    install_location: Option<String>,
    display_icon: Option<String>,
    uninstall_string: String,
}

/// 归一化 Windows 路径以便比较：去首尾引号与 `\\?\` 前缀、统一 `\`、小写、去尾部 `\`。
#[cfg(any(target_os = "windows", test))]
fn normalize_win_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix("//?/"))
        .unwrap_or(trimmed);
    let mut norm = stripped.replace('/', "\\").to_lowercase();
    while norm.ends_with('\\') && !norm.ends_with(":\\") {
        norm.pop();
    }
    if norm.is_empty() {
        None
    } else {
        Some(norm)
    }
}

/// 提取路径的父目录（纯字符串操作，兼容单元测试中未落盘的虚拟路径）。
#[cfg(any(target_os = "windows", test))]
fn parent_dir_of_norm(norm: &str) -> Option<String> {
    let idx = norm.rfind('\\')?;
    if idx == 0 {
        return None;
    }
    let parent = &norm[..idx];
    if parent.ends_with(':') {
        None
    } else {
        Some(parent.to_string())
    }
}

/// 判断路径是否像文件（实盘为文件，或以常见可执行/图标扩展名结尾）。
#[cfg(any(target_os = "windows", test))]
fn looks_like_file_path(norm: &str) -> bool {
    if Path::new(norm).is_file() {
        return true;
    }
    const FILE_EXTS: &[&str] = &[
        ".exe", ".ico", ".lnk", ".bat", ".cmd", ".com", ".msi", ".dll",
    ];
    FILE_EXTS.iter().any(|ext| norm.ends_with(ext))
}

/// 剥离 `DisplayIcon` 末尾 `,N` 索引并归一化路径。
#[cfg(any(target_os = "windows", test))]
fn normalize_display_icon_path(raw: &str) -> Option<String> {
    fn strip_idx(s: &str) -> &str {
        match s.rsplit_once(',') {
            Some((pre, suf))
                if !suf.trim().is_empty()
                    && suf.trim().chars().all(|c| c.is_ascii_digit() || c == '-') =>
            {
                pre.trim_end()
            }
            _ => s,
        }
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let outer = strip_idx(trimmed);
    let unquoted = match outer.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(rest),
        None => outer,
    };
    normalize_win_path(strip_idx(unquoted.trim()))
}

/// 判断归一化后的目录是否为过宽的系统公共根目录（不可用于路径归属匹配）。
#[cfg(any(target_os = "windows", test))]
fn is_generic_root_dir(norm_dir: &str) -> bool {
    // 驱动器根（如 `c:` 或 `c:\`）或相对单段路径均过宽。
    let Some(rest) = norm_dir.get(2..).and_then(|s| s.strip_prefix('\\')) else {
        return true;
    };
    if rest.is_empty() {
        return true;
    }
    matches!(
        rest,
        "windows"
            | "windows\\system32"
            | "windows\\syswow64"
            | "program files"
            | "program files (x86)"
            | "programdata"
            | "users"
    ) || (rest.starts_with("users\\") && rest.matches('\\').count() <= 1)
        || rest.ends_with("\\appdata\\local")
        || rest.ends_with("\\appdata\\roaming")
        || rest.ends_with("\\appdata\\local\\programs")
}

/// 两个具体目录相同或互为直接/嵌套子目录（严格按 `\` 路径段边界判定）。
#[cfg(any(target_os = "windows", test))]
fn dirs_overlap_strictly(a: &str, b: &str) -> bool {
    if is_generic_root_dir(a) || is_generic_root_dir(b) {
        return false;
    }
    if a == b {
        return true;
    }
    let is_child = |child: &str, parent: &str| {
        child.len() > parent.len()
            && child.starts_with(parent)
            && child.as_bytes().get(parent.len()) == Some(&b'\\')
    };
    is_child(a, b) || is_child(b, a)
}

/// 判断注册表候选条目是否与已知 `install_path` 匹配：依次核对 `InstallLocation`、
/// `DisplayIcon`（文件或其父目录）与 `UninstallString` 可执行程序父目录。
#[cfg(any(target_os = "windows", test))]
fn candidate_matches_install_path(cand: &RegUninstallCandidate, install_path: &str) -> bool {
    let Some(norm_install) = normalize_win_path(install_path) else {
        return false;
    };
    let install_dir = if looks_like_file_path(&norm_install) {
        parent_dir_of_norm(&norm_install)
    } else {
        Some(norm_install.clone())
    };
    let Some(install_dir) = install_dir else {
        return false;
    };
    if is_generic_root_dir(&install_dir) {
        return false;
    }

    // 1. InstallLocation
    if let Some(ref loc) = cand.install_location {
        if let Some(norm_loc) = normalize_win_path(loc) {
            let loc_dir = if looks_like_file_path(&norm_loc) {
                parent_dir_of_norm(&norm_loc)
            } else {
                Some(norm_loc)
            };
            if let Some(d) = loc_dir {
                if dirs_overlap_strictly(&install_dir, &d) {
                    return true;
                }
            }
        }
    }

    // 2. DisplayIcon（精确文件命中或父目录重合）
    if let Some(ref icon) = cand.display_icon {
        if let Some(norm_icon) = normalize_display_icon_path(icon) {
            if norm_icon == norm_install {
                return true;
            }
            if let Some(icon_dir) = parent_dir_of_norm(&norm_icon) {
                if dirs_overlap_strictly(&install_dir, &icon_dir) {
                    return true;
                }
            }
        }
    }

    // 3. UninstallString 主可执行文件父目录
    let (uninst_exe, _) = super::executor::parse_uninstaller_command(&cand.uninstall_string);
    if let Some(norm_exe) = normalize_win_path(&uninst_exe) {
        if let Some(uninst_dir) = parent_dir_of_norm(&norm_exe) {
            if dirs_overlap_strictly(&install_dir, &uninst_dir) {
                return true;
            }
        }
    }

    false
}

/// 从已收集的注册表候选中选择卸载命令：
/// 1) 优先按 `install_path` 匹配 `InstallLocation`/`DisplayIcon`/`UninstallString` 父目录；
/// 2) 退化为 `DisplayName` 安全匹配（全等优先于词边界）。
#[cfg(any(target_os = "windows", test))]
fn select_uninstaller_from_candidates(
    candidates: &[RegUninstallCandidate],
    app_name: &str,
    app_id: &str,
    install_path: &str,
) -> Option<String> {
    let valid: Vec<&RegUninstallCandidate> = candidates
        .iter()
        .filter(|c| !c.uninstall_string.trim().is_empty())
        .collect();

    // Pass 1: 路径锚定匹配（最可靠，免疫同名/短名冲突）
    let path_hits: Vec<&RegUninstallCandidate> = valid
        .iter()
        .copied()
        .filter(|c| candidate_matches_install_path(c, install_path))
        .collect();
    if !path_hits.is_empty() {
        let best = path_hits
            .iter()
            .copied()
            .find(|c| uninstall_display_name_matches(&c.display_name, app_name, app_id))
            .unwrap_or(path_hits[0]);
        return Some(best.uninstall_string.trim().to_string());
    }

    // Pass 2: DisplayName 安全回退（全等优先于词边界）
    let name_hits: Vec<&RegUninstallCandidate> = valid
        .iter()
        .copied()
        .filter(|c| uninstall_display_name_matches(&c.display_name, app_name, app_id))
        .collect();
    if let Some(exact) = name_hits
        .iter()
        .copied()
        .find(|c| uninstall_display_name_is_exact(&c.display_name, app_name, app_id))
    {
        return Some(exact.uninstall_string.trim().to_string());
    }
    name_hits
        .first()
        .map(|c| c.uninstall_string.trim().to_string())
}

/// 自动嗅探或构造已安装应用的系统卸载命令行
pub fn resolve_uninstaller_command(
    app_name: &str,
    app_id: &str,
    install_path: &str,
    existing_command: Option<&str>,
) -> Option<String> {
    resolve_uninstaller_command_in(app_name, app_id, install_path, existing_command, None)
}

/// 同 [`resolve_uninstaller_command`]；`registry` 为调用方已枚举的系统应用条目
/// （`AppScanner::scan_system_apps` 结果），批量场景传入以复用，免去逐个应用重复遍历
/// 三棵卸载注册表根；`None` 时现场枚举注册表。
pub fn resolve_uninstaller_command_in(
    app_name: &str,
    app_id: &str,
    install_path: &str,
    existing_command: Option<&str>,
    registry: Option<&[crate::scanner::ScannedRawApp]>,
) -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    let _ = (app_name, app_id, install_path, registry);
    // 1. 如果已有明确且有效的卸载指令（非向导提示文案）
    if let Some(cmd) = existing_command {
        let trimmed = cmd.trim();
        if !trimmed.is_empty()
            && !trimmed.contains("已调起")
            && !trimmed.contains("跳过")
            && !trimmed.contains("非 Windows")
            && !trimmed.contains("已解压至")
        {
            return Some(trimmed.to_string());
        }
    }

    // 2. Windows 平台：动态查询注册表中的 UninstallString（优先 install_path 锚定，再安全 DisplayName 回退）
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

        let candidates: Vec<RegUninstallCandidate> = match registry {
            Some(entries) => entries
                .iter()
                .filter_map(|e| {
                    let uninst = e.uninstall_string.as_deref()?.trim();
                    if uninst.is_empty() {
                        return None;
                    }
                    Some(RegUninstallCandidate {
                        display_name: e.display_name.clone(),
                        install_location: e.install_location.clone(),
                        display_icon: e.display_icon.clone(),
                        uninstall_string: uninst.to_string(),
                    })
                })
                .collect(),
            None => {
                let mut collected = Vec::new();
                for (hive, subpath) in targets {
                    let Ok(uninstall_key) = RegKey::predef(hive).open_subkey(subpath) else {
                        continue;
                    };
                    for key_name in uninstall_key.enum_keys().map_while(Result::ok) {
                        let Ok(app_key) = uninstall_key.open_subkey(&key_name) else {
                            continue;
                        };
                        let Ok(uninst) = app_key.get_value::<String, _>("UninstallString") else {
                            continue;
                        };
                        let uninst = uninst.trim().to_string();
                        if uninst.is_empty() {
                            continue;
                        }
                        collected.push(RegUninstallCandidate {
                            display_name: app_key
                                .get_value::<String, _>("DisplayName")
                                .unwrap_or_default(),
                            install_location: app_key
                                .get_value::<String, _>("InstallLocation")
                                .ok(),
                            display_icon: app_key.get_value::<String, _>("DisplayIcon").ok(),
                            uninstall_string: uninst,
                        });
                    }
                }
                collected
            }
        };

        if let Some(hit) =
            select_uninstaller_from_candidates(&candidates, app_name, app_id, install_path)
        {
            return Some(hit);
        }

        // 3. 检查安装目录中的标准卸载程序
        let p = std::path::Path::new(install_path);
        let base_dir = if p.is_file() {
            p.parent()
        } else if p.is_dir() {
            Some(p)
        } else {
            None
        };

        if let Some(dir) = base_dir {
            // 3.1 优先扫描目录中所有以 uninstall 或 unins 开头的程序 (如 "Uninstall PicGo.exe")
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let fname = path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase();
                        if (fname.starts_with("uninstall") || fname.starts_with("unins"))
                            && fname.ends_with(".exe")
                        {
                            return Some(format!("\"{}\"", path.to_string_lossy()));
                        }
                    }
                }
            }

            let candidates = [
                "uninstall.exe",
                "Uninstall.exe",
                "unins000.exe",
                "unins001.exe",
                "uninst.exe",
            ];
            for c in candidates {
                let candidate_path = dir.join(c);
                if candidate_path.is_file() {
                    return Some(format!("\"{}\"", candidate_path.to_string_lossy()));
                }
            }
        }

        // 4. 检查开始菜单程序组中的卸载快捷方式
        let start_menu_bases = [
            std::env::var("APPDATA")
                .ok()
                .map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs")),
            Some(PathBuf::from(
                r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs",
            )),
        ];

        for base in start_menu_bases.into_iter().flatten() {
            if let Some(lnk) = start_menu_uninstall_lnk(&base, app_name) {
                return Some(format!("\"{}\"", lnk.to_string_lossy()));
            }
        }
    }

    None
}

#[cfg(test)]
mod shortcut_name_tests {
    use super::sanitize_shortcut_name;
    use std::path::PathBuf;

    #[test]
    fn uninstall_display_name_matching_rules() {
        use super::uninstall_display_name_matches as m;
        assert!(m("PicGo", "picgo", "molunerfinn/picgo"));
        assert!(m("PicGo 2.4.0", "PicGo", "x/y"), "DisplayName 整词含应用名");
        assert!(
            m(
                "Microsoft Visual Studio Code (User)",
                "Visual Studio Code",
                "microsoft/vscode"
            ),
            "正向整词边界匹配"
        );
        assert!(m("my-tool.app", "Other", "mytoolapp"), "去分隔符紧凑全等命中");
        assert!(m("Go", "Go", "golang/go"), "短名精确全等允许");
        assert!(m("Git", "Git", "git-for-windows/git"), "短名精确全等允许");
        assert!(!m("   ", "PicGo", "x/y"), "空 DisplayName 不匹配");
        assert!(!m("Firefox", "PicGo", "molunerfinn/picgo"));
        // 回归 F-06：禁止短名或反向子串误匹配无关软件卸载器
        assert!(
            !m("Google Chrome", "Go", "golang/go"),
            "Go 不得子串命中 Google Chrome"
        );
        assert!(
            !m("Logitech G HUB", "Git", "git-for-windows/git"),
            "Git 不得子串命中 Logitech G HUB"
        );
        assert!(
            !m("Git Extensions", "Git", "git-for-windows/git"),
            "短名 Git 不得模糊匹配 Git Extensions"
        );
        assert!(
            !m("PDF Editor", "fd", "sharkdp/fd"),
            "fd 不得匹配 PDF Editor"
        );
        assert!(
            !m("Code", "Visual Studio Code", "microsoft/vscode"),
            "禁止反向子串匹配"
        );
        assert!(
            !m("Mozilla Firefox", "pdf.js", "mozilla/pdf.js"),
            "app_id 的 owner/ 前缀不得参与匹配"
        );
        assert!(
            !m("SuperPicGoPro", "PicGo", "molunerfinn/picgo"),
            "非词边界子串不得匹配"
        );
    }

    #[test]
    fn uninstaller_prefers_install_path_over_display_name() {
        let candidates = vec![
            super::RegUninstallCandidate {
                display_name: "Google Chrome".to_string(),
                install_location: Some(r"C:\Program Files\Google\Chrome\Application".to_string()),
                display_icon: None,
                uninstall_string: r#""C:\Program Files\Google\Chrome\setup.exe" --uninstall"#
                    .to_string(),
            },
            super::RegUninstallCandidate {
                display_name: "Go Programming Language amd64 go1.22".to_string(),
                install_location: Some(r"C:\Program Files\Go".to_string()),
                display_icon: None,
                uninstall_string: r#"MsiExec.exe /X{GO-GUID}"#.to_string(),
            },
        ];
        // 短名 Go 即使 DisplayName 带版本号，也能通过 install_path 精准锚定，绝不误选 Chrome
        assert_eq!(
            super::select_uninstaller_from_candidates(
                &candidates,
                "Go",
                "golang/go",
                r"C:\Program Files\Go\bin\go.exe",
            )
            .as_deref(),
            Some("MsiExec.exe /X{GO-GUID}")
        );
    }

    #[test]
    fn uninstaller_matches_display_icon_and_uninstall_string_parent_but_ignores_system_roots() {
        let candidates = vec![
            super::RegUninstallCandidate {
                display_name: "Unrelated MSI App".to_string(),
                install_location: Some(r"C:\Program Files".to_string()),
                display_icon: Some(r"C:\Windows\System32\msiexec.exe,0".to_string()),
                uninstall_string: r#"C:\Windows\System32\msiexec.exe /X{BAD}"#.to_string(),
            },
            super::RegUninstallCandidate {
                display_name: "Git version 2.45.0".to_string(),
                install_location: None,
                display_icon: Some(r#""C:\Program Files\Git\mingw64\share\git\git.ico",0"#.to_string()),
                uninstall_string: r#""C:\Program Files\Git\unins000.exe" /SILENT"#.to_string(),
            },
        ];
        assert_eq!(
            super::select_uninstaller_from_candidates(
                &candidates,
                "Git",
                "git-for-windows/git",
                r"C:\Program Files\Git\cmd\git.exe",
            )
            .as_deref(),
            Some(r#""C:\Program Files\Git\unins000.exe" /SILENT"#)
        );
        // 未知路径不得命中 C:\Program Files 或 C:\Windows\System32 这类公共根目录
        assert_eq!(
            super::select_uninstaller_from_candidates(
                &candidates,
                "Other",
                "org/other",
                r"C:\Program Files\OtherApp\other.exe",
            ),
            None
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn find_desktop_shortcut_sanitizes_and_blocks_traversal() {
        let base = tempfile::tempdir().unwrap();
        let desktop = base.path().join("Desktop");
        std::fs::create_dir_all(&desktop).unwrap();
        // 桌面外存在一个目标文件，绝不能通过 `..` 路径穿越命中
        let outside = base.path().join("secret.lnk");
        std::fs::write(&outside, b"outside").unwrap();
        assert_eq!(
            super::find_desktop_shortcut_in(&desktop, r"..\secret", "owner/secret"),
            None
        );

        // 便携版旧命名 sanitize_shortcut_name(app_id)（剥离 `/`）应可被安全找到
        let portable_lnk = desktop.join("molunerfinnpicgo.lnk");
        std::fs::write(&portable_lnk, b"lnk").unwrap();
        let found = super::find_desktop_shortcut_in(&desktop, "PicGo", "molunerfinn/picgo")
            .expect("should find sanitized app_id shortcut");
        assert_eq!(found, portable_lnk.canonicalize().unwrap());

        // 若同时存在 app_name 快捷方式则优先命中 app_name
        let named_lnk = desktop.join("PicGo.lnk");
        std::fs::write(&named_lnk, b"lnk").unwrap();
        let found2 = super::find_desktop_shortcut_in(&desktop, "PicGo", "molunerfinn/picgo")
            .expect("should prefer sanitized app_name shortcut");
        assert_eq!(found2, named_lnk.canonicalize().unwrap());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn uninstaller_lookup_reuses_pre_enumerated_registry() {
        use crate::scanner::ScannedRawApp;
        let entries = vec![
            ScannedRawApp {
                display_name: "PicGo 2.4.0".to_string(),
                uninstall_string: Some("  ".to_string()),
                ..Default::default()
            },
            ScannedRawApp {
                display_name: "PicGo".to_string(),
                uninstall_string: Some(r#" "C:\Apps\PicGo\Uninstall PicGo.exe" /S "#.to_string()),
                ..Default::default()
            },
        ];
        assert_eq!(
            super::resolve_uninstaller_command_in(
                "PicGo",
                "molunerfinn/picgo",
                r"Z:\definitely\missing",
                None,
                Some(&entries),
            )
            .as_deref(),
            Some(r#""C:\Apps\PicGo\Uninstall PicGo.exe" /S"#)
        );
    }

    #[test]
    fn shortcut_script_never_embeds_external_strings() {
        let exe = PathBuf::from("C:\\Apps\\evil\u{2019};calc;\u{2018}'x\\a.exe");
        let name = "Name\u{2019});Remove-Item C:\\ -Recurse;(\u{2018}";
        let (argv, envs) = super::shortcut_powershell_invocation(name, &exe);
        assert_eq!(argv.last().copied(), Some(super::SHORTCUT_PS_SCRIPT));
        for arg in &argv {
            assert!(!arg.contains("evil") && !arg.contains("Remove-Item"));
        }
        let get = |k: &str| envs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(
            get("ZSTORE_LNK_TARGET"),
            Some(exe.as_os_str().to_os_string())
        );
        assert_eq!(
            get("ZSTORE_LNK_WORKDIR"),
            Some(exe.parent().unwrap().as_os_str().to_os_string())
        );
        assert_eq!(
            get("ZSTORE_LNK_NAME"),
            Some(sanitize_shortcut_name(name).into())
        );
    }

    #[test]
    fn strips_windows_reserved_filename_chars() {
        // 创建/删除两侧共用字符集：分隔符与 Windows 非法文件名字符全部剥离，
        // `..\` 形态的穿越名随之退化为 Desktop 内的普通文件名。
        assert_eq!(sanitize_shortcut_name(r"foo\..\..\bar"), "foo....bar");
        assert_eq!(sanitize_shortcut_name("a/b:c*d?e\"f<g>h|i"), "abcdefghi");
        assert_eq!(
            sanitize_shortcut_name("  Visual Studio Code  "),
            "Visual Studio Code"
        );
    }

    #[test]
    fn empty_after_sanitize_falls_back_to_app() {
        assert_eq!(sanitize_shortcut_name(""), "App");
        assert_eq!(sanitize_shortcut_name("\\\\/:*?"), "App");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn start_menu_lookup_rejects_traversal_and_absolute_app_names() {
        let base = PathBuf::from(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs");
        for app_name in [r"..\..\Windows\System32", r"C:\Windows\System32"] {
            let sdir = base.join(super::sanitize_shortcut_name(app_name));
            assert!(
                sdir.starts_with(&base),
                "{app_name} 不得逃出程序组目录: {:?}",
                sdir
            );
            assert_eq!(sdir.parent(), Some(base.as_path()));
            assert_eq!(super::start_menu_uninstall_lnk(&base, app_name), None);
        }
    }
}
