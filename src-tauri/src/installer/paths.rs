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

/// 启动兜底用的桌面同名快捷方式（按应用名、应用 id 依次匹配，仅返回存在的文件）。
#[cfg(target_os = "windows")]
pub fn find_desktop_shortcut(app_name: &str, app_id: &str) -> Option<PathBuf> {
    let desktop = user_desktop_dir();
    [app_name, app_id]
        .iter()
        .map(|n| desktop.join(format!("{}.lnk", n)))
        .find(|lnk| lnk.is_file())
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

/// 卸载注册表条目 DisplayName 与应用的匹配口径（纯函数）：名称/id 全等、互相包含，
/// 或去 `-_.` 后的 id 被 DisplayName 包含。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn uninstall_display_name_matches(display_name: &str, app_name: &str, app_id: &str) -> bool {
    let disp_lower = display_name.trim().to_lowercase();
    if disp_lower.is_empty() {
        return false;
    }
    let name_lower = app_name.to_lowercase();
    let id_lower = app_id.to_lowercase();
    let clean_id = id_lower.replace(['-', '_', '.'], "");
    disp_lower == name_lower
        || disp_lower == id_lower
        || disp_lower.contains(&name_lower)
        || name_lower.contains(&disp_lower)
        || (!clean_id.is_empty() && disp_lower.replace(['-', '_', '.'], "").contains(&clean_id))
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

    // 2. Windows 平台：动态查询注册表中的 UninstallString
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

        let registry_hit: Option<String> = match registry {
            Some(entries) => entries
                .iter()
                .filter(|e| uninstall_display_name_matches(&e.display_name, app_name, app_id))
                .find_map(|e| {
                    e.uninstall_string
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                }),
            None => targets.into_iter().find_map(|(hive, subpath)| {
                let uninstall_key = RegKey::predef(hive).open_subkey(subpath).ok()?;
                uninstall_key
                    .enum_keys()
                    .map_while(Result::ok)
                    .find_map(|key_name| {
                        let app_key = uninstall_key.open_subkey(&key_name).ok()?;
                        let display_name: String = app_key
                            .get_value::<String, _>("DisplayName")
                            .unwrap_or_default();
                        if !uninstall_display_name_matches(&display_name, app_name, app_id) {
                            return None;
                        }
                        app_key
                            .get_value::<String, _>("UninstallString")
                            .ok()
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                    })
            }),
        };
        if registry_hit.is_some() {
            return registry_hit;
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
        assert!(m("PicGo 2.4.0", "PicGo", "x/y"), "DisplayName 含应用名");
        assert!(
            m("Code", "Visual Studio Code", "x/y"),
            "应用名含 DisplayName"
        );
        assert!(m("my-tool.app", "Other", "mytoolapp"), "去分隔符后 id 命中");
        assert!(!m("   ", "PicGo", "x/y"), "空 DisplayName 不匹配");
        assert!(!m("Firefox", "PicGo", "molunerfinn/picgo"));
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
