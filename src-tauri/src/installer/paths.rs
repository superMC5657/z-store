use std::path::{Path, PathBuf};

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
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
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

pub fn dirs_or_fallback_with_base(app_id: &str, custom_base: Option<&str>) -> PathBuf {
    let safe_id: String = app_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    let clean_id = if safe_id.is_empty() || safe_id.starts_with('.') {
        "app".to_string()
    } else {
        safe_id
    };

    if let Some(base) = custom_base {
        let trimmed = base.trim();
        if !trimmed.is_empty() {
            let expanded_base = expand_env_path(trimmed);
            return expanded_base.join(clean_id);
        }
    }

    dirs_or_fallback(app_id)
}

pub fn dirs_or_fallback(app_id: &str) -> PathBuf {
    // 消毒 app_id，防御路径逃逸
    let safe_id: String = app_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    let clean_id = if safe_id.is_empty() || safe_id.starts_with('.') {
        "app".to_string()
    } else {
        safe_id
    };

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

#[cfg(target_os = "windows")]
pub fn create_desktop_shortcut(app_name: &str, exe_path: &Path) {
    // 清洗快捷方式文件名，过滤 Windows 非法文件名字符: \ / : * ? " < > |
    let clean_name: String = app_name
        .chars()
        .filter(|c| !['\\', '/', ':', '*', '?', '"', '<', '>', '|'].contains(c))
        .collect();
    let safe_name = clean_name.trim();
    let final_name = if safe_name.is_empty() { "App" } else { safe_name };

    let working_dir = exe_path.parent().unwrap_or(exe_path);
    let script = format!(
        "$s=(New-Object -COM WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\{}.lnk');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Save()",
        final_name.replace('\'', "''"),
        exe_path.to_string_lossy().replace('\'', "''"),
        working_dir.to_string_lossy().replace('\'', "''")
    );
    let _ = std::process::Command::new("powershell")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(&script)
        .output();
}

/// 自动嗅探或构造已安装应用的系统卸载命令行
pub fn resolve_uninstaller_command(
    app_name: &str,
    app_id: &str,
    install_path: &str,
    existing_command: Option<&str>,
) -> Option<String> {
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

        let name_lower = app_name.to_lowercase();
        let id_lower = app_id.to_lowercase();
        let clean_id = id_lower.replace(['-', '_', '.'], "");

        for (hive, subpath) in targets {
            let root = RegKey::predef(hive);
            if let Ok(uninstall_key) = root.open_subkey(subpath) {
                for key_name in uninstall_key.enum_keys().map_while(Result::ok) {
                    if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                        let display_name: String = app_key
                            .get_value::<String, _>("DisplayName")
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                        let disp_lower = display_name.to_lowercase();

                        let matched = !disp_lower.is_empty()
                            && (disp_lower == name_lower
                                || disp_lower == id_lower
                                || disp_lower.contains(&name_lower)
                                || name_lower.contains(&disp_lower)
                                || (!clean_id.is_empty()
                                    && disp_lower.replace(['-', '_', '.'], "").contains(&clean_id)));

                        if matched {
                            if let Ok(uninst) = app_key.get_value::<String, _>("UninstallString") {
                                let trimmed_uninst = uninst.trim().to_string();
                                if !trimmed_uninst.is_empty() {
                                    return Some(trimmed_uninst);
                                }
                            }
                        }
                    }
                }
            }
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
        let start_menu_candidates = [
            std::env::var("APPDATA")
                .ok()
                .map(|p| std::path::PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs").join(app_name)),
            Some(
                std::path::PathBuf::from(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs")
                    .join(app_name),
            ),
        ];

        for sdir_opt in start_menu_candidates.into_iter().flatten() {
            if sdir_opt.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&sdir_opt) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let fname = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                        if fname.contains("uninstall") && fname.ends_with(".lnk") {
                            return Some(format!("\"{}\"", path.to_string_lossy()));
                        }
                    }
                }
            }
        }
    }

    None
}
