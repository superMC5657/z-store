use crate::models::InstalledApp;
use crate::{AppResult, AppState};
use tauri::{AppHandle, Manager, State};

/// 同步阻塞闭包卸到 Tokio 阻塞线程池（注册表枚举、文件系统探测、解压、进程启动等）。
pub(crate) async fn run_blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| crate::AppError::new(e.to_string()))
}

/// 已安装应用列表（含路径自愈、导入版本更正与幽灵隐藏）。
/// 短锁读库 → 阻塞线程池做注册表枚举与文件系统探测 → 有变更时再取短锁回写。
#[tauri::command]
pub async fn get_installed_apps(state: State<'_, AppState>) -> AppResult<Vec<InstalledApp>> {
    load_installed_apps(&state).await
}

/// `get_installed_apps` 与更新检查共用的异步实现。
pub(crate) async fn load_installed_apps(state: &AppState) -> AppResult<Vec<InstalledApp>> {
    let mut apps = {
        let db = state.db()?;
        db.get_installed_apps().map_err(|e| e.to_string())?
    };
    fill_installed_icons(state, &mut apps);

    let refresh = run_blocking(move || refresh_installed_apps(apps)).await?;

    if !refresh.updated.is_empty() || !refresh.corrected_versions.is_empty() {
        let db = state.db()?;
        for updated in &refresh.updated {
            let _ = db.save_installed_app(updated);
        }
        for (app_id, version) in &refresh.corrected_versions {
            rebase_cached_update(&db, app_id, version);
        }
    }
    // 只读扫描不删除数据库记录，幽灵应用仅在返回视图中隐藏。
    if !refresh.ghost_app_ids.is_empty() {
        let mut ev = crate::z_log::WideEvent::new("scanner", "ghosts hidden");
        ev.field("count", refresh.ghost_app_ids.len());
        ev.warn();
    }
    Ok(super::installer_uninstall::hide_ghost_apps(
        refresh.apps,
        &refresh.ghost_app_ids,
    ))
}

/// 图标补全：收录项取目录官方图标，其余取 `app_details` 摘要（单次分片查询，不读 README 等大字段）。
fn fill_installed_icons(state: &AppState, apps: &mut [InstalledApp]) {
    let mut detail_ids: Vec<String> = Vec::new();
    for app in apps.iter_mut().filter(|a| a.icon.is_none()) {
        if let Some(item) = state.catalog.get_catalog_item(&app.app_id) {
            app.icon = Some(item.icon);
            app.icon_bg = Some(item.icon_bg);
        } else {
            detail_ids.push(app.app_id.clone());
        }
    }
    if detail_ids.is_empty() {
        return;
    }
    let details = match state.db() {
        Ok(db) => db
            .get_app_detail_summaries_batch(&detail_ids, false)
            .unwrap_or_default(),
        Err(_) => return,
    };
    for app in apps.iter_mut().filter(|a| a.icon.is_none()) {
        let Some(detail) = details.get(app.app_id.trim()) else {
            continue;
        };
        if !detail.core.icon.trim().is_empty() {
            app.icon = Some(detail.core.icon.clone());
        }
        if !detail.core.icon_bg.trim().is_empty() {
            app.icon_bg = Some(detail.core.icon_bg.clone());
        }
    }
}

/// 阻塞阶段产物：刷新后的列表、需回写的行、版本被更正的应用与幽灵应用。
struct InstalledRefresh {
    apps: Vec<InstalledApp>,
    updated: Vec<InstalledApp>,
    /// 本地版本被更正的应用：(app_id, 新版本)，其更新判定行按新版本重算
    corrected_versions: Vec<(String, String)>,
    ghost_app_ids: Vec<String>,
}

/// 路径自愈、导入版本与安装时间更正（零 DB；注册表只在有导入应用时枚举一次）。
fn refresh_installed_apps(mut apps: Vec<InstalledApp>) -> InstalledRefresh {
    let mut updated = Vec::new();
    let mut corrected_versions: Vec<(String, String)> = Vec::new();
    let mut ghost_app_ids = Vec::new();
    // 系统导入的应用会自行升级：按导入同口径重读本地版本。注册表只在有导入应用时枚举一次。
    let mut registry_entries: Option<Vec<crate::scanner::ScannedRawApp>> = None;

    for app in &mut apps {
        let mut app_changed = false;
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
                    // 本轮已枚举过注册表（存在系统导入应用）时复用，不再逐个应用重扫卸载表。
                    app.uninstall_command = crate::installer::paths::resolve_uninstaller_command_in(
                        &app.app_name,
                        &app.app_id,
                        &repaired_path,
                        None,
                        registry_entries.as_deref(),
                    );
                }
                app_changed = true;
            } else {
                // 如果不仅原路径失效，且全盘嗅探均已找不到真实主程序
                // 说明该应用已被用户通过系统/外部渠道彻底卸载，标记为幽灵应用进行自愈清理
                ghost_app_ids.push(app.app_id.clone());
            }
        }

        // 版本来源是 Windows 注册表；其他平台的导入版本不在此刷新
        if cfg!(target_os = "windows") && app.install_method == "system_import" {
            let entries =
                registry_entries.get_or_insert_with(crate::scanner::AppScanner::scan_system_apps);
            if let Some(detected) = crate::scanner::AppScanner::detect_installed_version(
                entries,
                &app.install_path,
                crate::scanner::AppScanner::read_exe_version,
            ) {
                if !crate::scanner::version::same_version(&detected, &app.version) {
                    corrected_versions.push((app.app_id.clone(), detected.clone()));
                    app.version = detected;
                    app_changed = true;
                }
            }
        }

        // 自愈已导入本地应用的真实安装时间（导入路径只盖当前时刻，此处按可执行文件反查纠正）
        // Windows 复用本轮已枚举的注册表条目，不按应用逐个重扫注册表
        if app.install_method == "system_import" {
            let detected = if cfg!(target_os = "windows") {
                let entries = registry_entries
                    .get_or_insert_with(crate::scanner::AppScanner::scan_system_apps);
                crate::scanner::AppScanner::detect_installed_at_from_entries(
                    entries,
                    &app.install_path,
                )
            } else {
                crate::scanner::AppScanner::detect_path_installed_at(&app.install_path)
            };
            if let Some(real_time) = detected {
                if real_time != app.installed_at && real_time > 0 {
                    app.installed_at = real_time;
                    app_changed = true;
                }
            }
        }

        if app_changed {
            updated.push(app.clone());
        }
    }

    InstalledRefresh {
        apps,
        updated,
        corrected_versions,
        ghost_app_ids,
    }
}

/// 用上次查到的远端版本按新的本地版本重算更新判定；没有判定行或版本未知时删行，等下次检查。
fn rebase_cached_update(db: &crate::db::Database, app_id: &str, version: &str) {
    let latest = db
        .get_cached_update_version(app_id)
        .ok()
        .flatten()
        .map(|(latest, _)| latest);
    match latest {
        Some(latest) if !version.trim().is_empty() => {
            let rule = db.get_rule(app_id).ok().flatten();
            let has_update = crate::commands::updates_check::should_include_update(
                version,
                &latest,
                rule.as_ref(),
            );
            let _ = db.rebase_update_result(app_id, version, has_update);
        }
        _ => {
            let _ = db.remove_update_result(app_id);
        }
    }
}

/// Linux 候选路径启动并同步回填数据库安装路径；文件不存在返回 `Ok(false)`。
#[cfg(target_os = "linux")]
fn spawn_and_backfill(
    state: &AppState,
    installed: &Option<InstalledApp>,
    target_path: &str,
    found: &str,
    origin: &str,
) -> Result<bool, String> {
    let exe_path = std::path::PathBuf::from(found);
    if !exe_path.is_file() {
        return Ok(false);
    }
    let parent = exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    std::process::Command::new(&exe_path)
        .current_dir(&parent)
        .spawn()
        .map_err(|e| format!("通过 {} 启动失败 ({}): {}", origin, found, e))?;
    // 记录路径为空或过期时同步回填，加速下次启动
    if let Some(mut updated) = installed.clone() {
        if target_path != found {
            if let Ok(db) = state.db() {
                updated.install_path = found.to_string();
                let _ = db.save_installed_app(&updated);
            }
        }
    }
    Ok(true)
}

/// 启动应用：在阻塞线程池中解析可执行路径并启动进程。
#[tauri::command(rename_all = "camelCase")]
pub async fn launch_app(app_handle: AppHandle, app_id: String) -> AppResult<bool> {
    let app_id = super::require_app_id(&app_id)?;
    run_blocking(move || launch_app_blocking(&app_handle.state::<AppState>(), app_id)).await?
}

fn launch_app_blocking(state: &AppState, app_id: String) -> AppResult<bool> {
    let installed_app_opt = {
        let db = state.db()?;
        db.get_installed_app(&app_id).map_err(|e| e.to_string())?
    };

    let (app_name, target_path, catalog_repo) = if let Some(ref app) = installed_app_opt {
        (
            app.app_name.clone(),
            app.install_path.trim().trim_matches('"').to_string(),
            None,
        )
    } else {
        let cat = state.catalog.get_catalog_item(&app_id);
        if let Some(c) = cat {
            let p = crate::scanner::AppScanner::resolve_installed_app_path(
                &c.name,
                &c.id,
                Some(&c.repo),
            )
            .unwrap_or_default();
            (c.name, p, Some(c.repo))
        } else {
            return Err(format!("未找到已安装或管理的应用: {}", app_id).into());
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

    // 直接启动有效的可执行文件或快捷方式
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

    // 探测真实可执行路径
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

            // 写回探测到的真实路径以加速下次启动。
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

    // 检查便携应用目录
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

    // 在 Windows 桌面查找同名快捷方式
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

    // Linux 兜底：通过 desktop Exec 或 PATH 查找并启动。
    #[cfg(target_os = "linux")]
    {
        let catalog_ids = state
            .catalog
            .get_catalog_item(&app_id)
            .map(|cat| cat.get_native_identifiers())
            .unwrap_or_default();
        let (_, bare_names) = crate::scanner::AppScanner::linux_candidate_names(
            &catalog_ids,
            &[app_name.clone(), app_id.clone()],
        );
        // desktop Exec 解析
        if let Some(found) = crate::scanner::AppScanner::resolve_linux_via_desktop(&bare_names) {
            if spawn_and_backfill(state, &installed_app_opt, &target_path, &found, "桌面文件")?
            {
                return Ok(true);
            }
        }
        // PATH/which 直启
        for name in &bare_names {
            if name.contains(' ') || name.contains('/') {
                continue;
            }
            if let Some(found) = crate::scanner::AppScanner::which_binary(name) {
                if spawn_and_backfill(state, &installed_app_opt, &target_path, &found, "PATH")? {
                    return Ok(true);
                }
            }
        }
    }

    // 诊断增强：Linux 下记录路径为空时给出可排查的候选路径（which/desktop）。
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
                "未能定位到该软件的可执行程序。\n记录路径: 无 {}\n应用: {} ({})\n建议检查软件是否已被重命名或移动位置，或重新扫描添加。",
                hint_text, app_name, app_id
            ).into());
        }
    }

    Err(format!(
        "未能定位到该软件的可执行程序。\n记录路径: {}\n建议检查软件是否已被重命名或移动位置，或重新扫描添加。",
        if target_path.is_empty() { "无" } else { &target_path }
    ).into())
}
