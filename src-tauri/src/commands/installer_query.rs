use crate::models::InstalledApp;
use crate::AppState;
use super::resolve_uninstaller_command;
use tauri::State;

pub fn get_installed_apps(state: State<'_, AppState>) -> Result<Vec<InstalledApp>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut apps = db.get_installed_apps().map_err(|e| e.to_string())?;

    let mut needs_db_update = Vec::new();
    let mut ghost_app_ids = Vec::new();

    for app in &mut apps {
        if app.icon.is_none() {
            if let Some(item) = state.catalog.get_catalog_item(&app.app_id) {
                app.icon = Some(item.icon);
                app.icon_bg = Some(item.icon_bg);
            }
        }
        let is_empty = app.install_path.trim().is_empty();
        let not_exist = !is_empty && !std::path::Path::new(&app.install_path).exists();
        if is_empty || not_exist {
            if let Some(repaired_path) = crate::scanner::AppScanner::resolve_installed_app_path(
                &app.app_name,
                &app.app_id,
                None,
            ) {
                app.install_path = repaired_path.clone();
                if app.uninstall_command.is_none() {
                    app.uninstall_command = resolve_uninstaller_command(
                        &app.app_name,
                        &app.app_id,
                        &repaired_path,
                        None,
                    );
                }
                needs_db_update.push(app.clone());
            } else {
                // 如果不仅原路径失效，且全盘嗅探均已找不到真实主程序
                // 说明该应用已被用户通过系统/外部渠道彻底卸载，标记为幽灵应用进行自愈清理
                ghost_app_ids.push(app.app_id.clone());
            }
        }
    }

    for updated in needs_db_update {
        let _ = db.save_installed_app(&updated);
    }
    // 审查项 3.2-3：只读扫描契约 —— 可执行文件消失绝不能在此处直接删除数据库记录
    // （不得调用 remove_installed_app，也不得清除检测缓存）；
    // 数据库行予以保留，幽灵应用仅在返回视图中隐藏，并在日志中体现数量。
    if !ghost_app_ids.is_empty() {
        log::warn!(
            "installed scan hid {} ghost app(s); rows kept, delete only via uninstall/unmanage",
            ghost_app_ids.len()
        );
    }
    let apps = super::installer_uninstall::hide_ghost_apps(apps, &ghost_app_ids);

    Ok(apps)
}

pub fn launch_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    let installed_app_opt = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.app_id == app_id)
    };

    let (app_name, target_path, catalog_repo) = if let Some(ref app) = installed_app_opt {
        (
            app.app_name.clone(),
            app.install_path.trim().trim_matches('"').to_string(),
            None,
        )
    } else {
        let cat = state
            .catalog
            .get_catalog_items()
            .into_iter()
            .find(|c| c.id == app_id);
        if let Some(c) = cat {
            let p = crate::scanner::AppScanner::resolve_installed_app_path(&c.name, &c.id, Some(&c.repo))
                .unwrap_or_default();
            (c.name, p, Some(c.repo))
        } else {
            return Err(format!("未找到已安装或管理的应用: {}", app_id));
        }
    };

    let path_obj = std::path::Path::new(&target_path);

    // 检查是否为临时下载目录中的安装包（避免误重新调起安装向导）
    let is_temp_installer = target_path.to_lowercase().contains("zstore_downloads")
        || target_path.to_lowercase().contains(r"\temp\")
        || target_path.to_lowercase().contains(r"/temp/")
        || target_path.to_lowercase().ends_with("-setup.exe")
        || target_path.to_lowercase().ends_with("_setup.exe")
        || target_path.to_lowercase().ends_with("-installer.exe")
        || target_path.to_lowercase().ends_with(".msi")
        || target_path.to_lowercase().ends_with(".dmg")
        || target_path.to_lowercase().ends_with(".deb")
        || target_path.to_lowercase().ends_with(".rpm");

    // 1. 如果路径本身是存在的可执行文件或快捷方式/应用包，且并非临时下载安装包
    if !is_temp_installer {
        #[cfg(target_os = "macos")]
        if path_obj.exists() && ((path_obj.is_dir() && target_path.ends_with(".app")) || path_obj.is_file()) {
            std::process::Command::new("open")
                .arg(&target_path)
                .spawn()
                .map_err(|e| format!("启动 macOS 应用程序失败: {}", e))?;
            return Ok(true);
        }

        if path_obj.is_file() {
            let ext = path_obj
                .extension()
                .map_or("", |e| e.to_str().unwrap_or(""));
            if ext.eq_ignore_ascii_case("lnk") {
                #[cfg(target_os = "windows")]
                {
                    std::process::Command::new("explorer.exe")
                        .arg(&target_path)
                        .spawn()
                        .map_err(|e| format!("调起快捷方式失败: {}", e))?;
                    return Ok(true);
                }
            } else if ext.eq_ignore_ascii_case("exe") {
                let parent = path_obj
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new("."));
                std::process::Command::new(path_obj)
                    .current_dir(parent)
                    .spawn()
                    .map_err(|e| format!("启动应用程序失败: {}", e))?;
                return Ok(true);
            } else {
                #[cfg(target_os = "linux")]
                {
                    let _ = std::process::Command::new("chmod").arg("+x").arg(path_obj).status();
                    let parent = path_obj
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new("."));
                    std::process::Command::new(path_obj)
                        .current_dir(parent)
                        .spawn()
                        .map_err(|e| format!("启动 Linux 应用程序失败: {}", e))?;
                    return Ok(true);
                }
            }
        }
    }

    // 2. 检查安装路径是否为目录或无效，调用全源智能嗅探器寻找真正的 exe
    let candidate_exe = crate::scanner::AppScanner::resolve_installed_app_path(
        &app_name,
        &app_id,
        catalog_repo.as_deref(),
    )
    .or_else(|| {
        crate::scanner::AppScanner::resolve_executable_path(
            if target_path.is_empty() {
                None
            } else {
                Some(&target_path)
            },
            None,
            &app_name,
        )
    });

    if let Some(exe_str) = candidate_exe {
        let exe_path = std::path::Path::new(&exe_str);
        if exe_path.is_file() {
            let parent = exe_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            std::process::Command::new(exe_path)
                .current_dir(parent)
                .spawn()
                .map_err(|e| format!("启动应用程序失败: {}", e))?;

            // 如果该应用已被添加管理，自动将探测到的真实物理路径写回数据库，加速下次启动
            if let Some(mut updated) = installed_app_opt {
                if target_path != exe_str {
                    if let Ok(db) = state.db.lock() {
                        updated.install_path = exe_str;
                        let _ = db.save_installed_app(&updated);
                    }
                }
            }

            return Ok(true);
        }
    }

    // 3. 检查便携应用目录 ~/AppData/Local/Programs/z-store-apps/<app_id>/
    let portable_dir = crate::installer::dirs_or_fallback(&app_id);
    if portable_dir.is_dir() {
        if let Some(exe_str) = crate::scanner::AppScanner::resolve_executable_path(
            Some(&portable_dir.to_string_lossy()),
            None,
            &app_name,
        ) {
            let exe_path = std::path::Path::new(&exe_str);
            if exe_path.is_file() {
                let parent = exe_path
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new("."));
                std::process::Command::new(exe_path)
                    .current_dir(parent)
                    .spawn()
                    .map_err(|e| format!("启动便携版失败: {}", e))?;
                return Ok(true);
            }
        }
    }

    // 4. 在 Windows 桌面查找同名快捷方式
    #[cfg(target_os = "windows")]
    {
        let desktop = std::env::var("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join("Desktop"))
            .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Users\Public\Desktop"));

        let candidate_lnks = [
            desktop.join(format!("{}.lnk", app_name)),
            desktop.join(format!("{}.lnk", app_id)),
        ];

        for lnk in candidate_lnks {
            if lnk.is_file() {
                std::process::Command::new("explorer.exe")
                    .arg(lnk.to_string_lossy().to_string())
                    .spawn()
                    .map_err(|e| format!("通过快捷方式启动失败: {}", e))?;
                return Ok(true);
            }
        }
    }

    Err(format!(
        "未能定位到该软件的可执行程序。\n记录路径: {}\n建议检查软件是否已被重命名或迁移，或重新扫描添加。",
        if target_path.is_empty() { "无" } else { &target_path }
    ))
}
