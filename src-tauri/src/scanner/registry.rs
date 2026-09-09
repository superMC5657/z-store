use super::{AppScanner, ScannedRawApp};

impl AppScanner {
    #[cfg(target_os = "windows")]
    pub(crate) fn scan_windows_registry() -> Vec<ScannedRawApp> {
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

        let mut component_locations: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        for (hive, subpath) in targets {
            let root = RegKey::predef(hive);
            if let Ok(uninstall_key) = root.open_subkey(subpath) {
                for key_name in uninstall_key.enum_keys().map_while(Result::ok) {
                    if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                        // 1. 系统组件或子更新：提取可能存在的实际安装路径（如 WiX MSI 载荷），然后忽略条目本身
                        if let Ok(sys_comp) = app_key.get_value::<u32, _>("SystemComponent") {
                            if sys_comp == 1 {
                                if let Ok(disp) = app_key.get_value::<String, _>("DisplayName") {
                                    if let Ok(loc) =
                                        app_key.get_value::<String, _>("InstallLocation")
                                    {
                                        let trimmed_loc =
                                            loc.trim().trim_matches('"').to_string();
                                        if !trimmed_loc.is_empty()
                                            && std::path::Path::new(&trimmed_loc).exists()
                                        {
                                            component_locations.insert(
                                                disp.trim().to_lowercase(),
                                                trimmed_loc,
                                            );
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
}
