use super::resolve_uninstaller_command;
use crate::models::InstalledApp;
use crate::AppState;
use tauri::State;

pub fn get_installed_apps(state: State<'_, AppState>) -> Result<Vec<InstalledApp>, String> {
    let db = state.db()?;
    let mut apps = db.get_installed_apps().map_err(|e| e.to_string())?;

    let mut needs_db_update = Vec::new();
    let mut ghost_app_ids = Vec::new();

    for app in &mut apps {
        let mut app_changed = false;
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
                app_changed = true;
            } else {
                // 如果不仅原路径失效，且全盘嗅探均已找不到真实主程序
                // 说明该应用已被用户通过系统/外部渠道彻底卸载，标记为幽灵应用进行自愈清理
                ghost_app_ids.push(app.app_id.clone());
            }
        }

        // 自愈已导入本地应用的真实安装时间（解决此前导入时全量盖章当前时刻的问题）
        if app.install_method == "system_import" {
            if let Some(real_time) = crate::scanner::AppScanner::resolve_app_installed_at(
                &app.app_name,
                &app.app_id,
                &app.install_path,
            ) {
                if real_time != app.installed_at && real_time > 0 {
                    app.installed_at = real_time;
                    app_changed = true;
                }
            }
        }

        if app_changed {
            needs_db_update.push(app.clone());
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
    let app_id = super::require_app_id(&app_id)?;
    let installed_app_opt = {
        let db = state.db()?;
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
            let p = crate::scanner::AppScanner::resolve_installed_app_path(
                &c.name,
                &c.id,
                Some(&c.repo),
            )
            .unwrap_or_default();
            (c.name, p, Some(c.repo))
        } else {
            return Err(format!("未找到已安装或管理的应用: {}", app_id));
        }
    };

    let path_obj = std::path::Path::new(&target_path);

    // 检查是否为临时下载目录中的安装包（避免误重新调起安装向导）
    let is_temp_installer = target_path.to_lowercase().contains(r"\temp\")
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
        if path_obj.exists()
            && ((path_obj.is_dir() && target_path.ends_with(".app")) || path_obj.is_file())
        {
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
                    // .desktop 交给 4b 的 Exec 解析直启，此处不直接 chmod/spawn（避免把桌面文件当二进制执行）。
                    let is_desktop = ext.eq_ignore_ascii_case("desktop");
                    if !is_desktop {
                        let _ = std::process::Command::new("chmod")
                            .arg("+x")
                            .arg(path_obj)
                            .status();
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
            // clone 保留所有权，供后续 Linux 4b 兜底继续回填（Windows 行为不变）。
            if let Some(mut updated) = installed_app_opt.clone() {
                if target_path != exe_str {
                    if let Ok(db) = state.db() {
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

    // 4b. Linux：desktop Exec / PATH 兜底（deb 应用记录路径为空或符号链接失效时，
    // 如 Motrix `/usr/bin/motrix -> /etc/alternatives/motrix`）。Windows 编译时消除。
    #[cfg(target_os = "linux")]
    {
        // 候选裸名：catalog linux 标识优先，其次 app 名/id 派生
        let mut bare_names: Vec<String> = Vec::new();
        if let Some(cat) = state.catalog.get_catalog_item(&app_id) {
            for id in cat.get_native_identifiers() {
                let t = id.trim().to_string();
                if !t.is_empty() && !bare_names.contains(&t) {
                    bare_names.push(t.clone());
                }
                let lower = t.to_lowercase();
                if !lower.is_empty() && !bare_names.contains(&lower) {
                    bare_names.push(lower);
                }
            }
        }
        for cand in [&app_name, &app_id] {
            for part in cand.split(['/', '-', ' ', '_']) {
                let t = part.trim().to_lowercase();
                if t.len() >= 3 && !bare_names.contains(&t) {
                    bare_names.push(t);
                }
            }
            let full = cand.trim().to_lowercase();
            if !full.is_empty() && !bare_names.contains(&full) {
                bare_names.push(full);
            }
        }
        // 4b-1. desktop Exec 解析
        if let Some(found) =
            crate::installer::executor::linux::resolve_desktop_installed_path(&bare_names)
        {
            let exe_path = std::path::PathBuf::from(&found);
            if exe_path.is_file() {
                let parent = exe_path
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                std::process::Command::new(&exe_path)
                    .current_dir(&parent)
                    .spawn()
                    .map_err(|e| format!("通过桌面文件启动失败 ({}): {}", found, e))?;
                // 记录路径为空时同步回填，加速下次启动
                if let Some(mut updated) = installed_app_opt.clone() {
                    if target_path != found {
                        if let Ok(db) = state.db() {
                            updated.install_path = found;
                            let _ = db.save_installed_app(&updated);
                        }
                    }
                }
                return Ok(true);
            }
        }
        // 4b-2. PATH/which 直启（桌面文件缺失但二进制在 PATH 中时）
        for name in &bare_names {
            if name.contains(' ') || name.contains('/') {
                continue;
            }
            if let Some(found) = crate::scanner::AppScanner::which_binary(name) {
                let exe_path = std::path::PathBuf::from(&found);
                if exe_path.is_file() {
                    let parent = exe_path
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_else(|| std::path::PathBuf::from("."));
                    std::process::Command::new(&exe_path)
                        .current_dir(&parent)
                        .spawn()
                        .map_err(|e| format!("通过 PATH 启动失败 ({}): {}", found, e))?;
                    if let Some(mut updated) = installed_app_opt.clone() {
                        if target_path != found {
                            if let Ok(db) = state.db() {
                                updated.install_path = found;
                                let _ = db.save_installed_app(&updated);
                            }
                        }
                    }
                    return Ok(true);
                }
            }
        }
    }

    // 诊断增强：Linux 下记录路径为空时给出可排查的候选路径（which/desktop），
    // 替代原来的单一“无”字，避免 Motrix 类已安装应用无从下手。
    #[cfg(target_os = "linux")]
    {
        if target_path.is_empty() {
            let mut hints: Vec<String> = Vec::new();
            for cand in [&app_name, &app_id] {
                let base = cand
                    .rsplit('/')
                    .next()
                    .unwrap_or(cand)
                    .trim()
                    .to_lowercase();
                if base.len() >= 2 {
                    let p = std::path::PathBuf::from("/usr/bin").join(&base);
                    if p.is_file() {
                        hints.push(p.to_string_lossy().to_string());
                    }
                }
            }
            let hint_text = if hints.is_empty() {
                "（已尝试 PATH/which、/usr/bin/<名称>、/opt/<名称>/* 与 *.desktop Exec，均未命中）"
                    .to_string()
            } else {
                format!("（发现候选: {}，但嗅探未通过校验）", hints.join(", "))
            };
            return Err(format!(
                "未能定位到该软件的可执行程序。\n记录路径: 无 {}\n应用: {} ({})\n建议检查软件是否已被重命名或迁移，或重新扫描添加。",
                hint_text, app_name, app_id
            ));
        }
    }

    Err(format!(
        "未能定位到该软件的可执行程序。\n记录路径: {}\n建议检查软件是否已被重命名或迁移，或重新扫描添加。",
        if target_path.is_empty() { "无" } else { &target_path }
    ))
}
