use crate::models::InstalledApp;
use crate::AppState;
use super::catalog::get_app_details;
use super::{resolve_uninstaller_command, select_best_asset, InstallerEngine};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
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
    for ghost_id in &ghost_app_ids {
        let _ = db.remove_installed_app(ghost_id);
        crate::commands::scanner::remove_from_detected_cache(ghost_id);
    }
    apps.retain(|a| !ghost_app_ids.iter().any(|g| g == &a.app_id));

    Ok(apps)
}

#[tauri::command]
pub async fn install_app(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    asset_name: Option<String>,
    custom_install_dir: Option<String>,
) -> Result<InstalledApp, String> {
    // ADR-0010：深链安装可能传入 URL/前缀形态，入站归一化后全程使用 canonical id；未知标识直接拒绝
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    // 读取用户配置（自定义下载路径、绿色便携根路径）
    let (custom_download_dir, custom_portable_dir) = {
        if let Ok(db) = state.db.lock() {
            let dl = db.get_setting("download_dir").ok().flatten().and_then(|s| {
                let t = s.trim();
                if !t.is_empty() && !t.contains("zstore_downloads") {
                    Some(crate::installer::expand_env_path(t))
                } else {
                    None
                }
            });
            let port = db.get_setting("portable_dir").ok().flatten().and_then(|s| {
                let t = s.trim().to_string();
                if !t.is_empty() {
                    Some(t)
                } else {
                    None
                }
            });
            (dl, port)
        } else {
            (None, None)
        }
    };

    // 1. 获取应用详情与择取匹配资产（支持前端主动指定 asset_name，若未指定则按当前架构自适应择优）
    let detail = get_app_details(state.clone(), app_id.clone(), None).await?;

    let selected_asset = if let Some(ref target_name) = asset_name {
        detail.releases.iter().find(|r| &r.name == target_name)
    } else {
        None
    };

    let asset = selected_asset
        .or_else(|| select_best_asset(&detail.releases))
        .ok_or_else(|| "该 Release 未提供匹配当前操作系统的安装包资产".to_string())?;

    // 2. 获取加速下载重写地址
    let (rewritten_url, is_mirror) = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        let rewritten = mirror.rewrite_download_url(&asset.download_url);
        let is_mirror = rewritten != asset.download_url;
        (rewritten, is_mirror)
    };

    log::info!(
        "download init sid={} id={} file='{}' raw_url='{}' effective_url='{}' mirror={}",
        crate::z_log::new_session_id(),
        app_id,
        asset.name,
        crate::log_support::sanitize_url(&asset.download_url),
        crate::log_support::sanitize_url(&rewritten_url),
        is_mirror
    );

    // 3. 执行流式下载与 SHA-256 完整性防篡改强校验
    let download_res = InstallerEngine::download_with_progress(
        &app_handle,
        &app_id,
        &rewritten_url,
        &asset.name,
        asset.sha256.as_deref(),
        custom_download_dir.as_deref(),
    )
    .await;

    // 若直连下载失败且当前为 GitHub 官方链接，尝试自动切换备用加速镜像进行重试
    let (dest_path, actual_sha256) = match download_res {
        Ok(ok) => ok,
        Err(e) => {
            let is_github = asset.download_url.contains("github.com");
            let is_direct = rewritten_url == asset.download_url;
            if is_github && is_direct {
                let fallback_url = format!("https://gh-proxy.com/{}", asset.download_url);
                log::warn!(
                    "download direct failed, retrying via fallback mirror url='{}'",
                    crate::log_support::sanitize_url(&fallback_url)
                );
                let _ = app_handle.emit(
                    "zstore://download-progress",
                    crate::models::DownloadProgressPayload {
                        task_id: app_id.clone(),
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        speed_bytes_per_sec: 0,
                        state: "downloading".to_string(),
                        message: Some("直连通道不稳定，正在切换公共加速镜像自动重试...".to_string()),
                    },
                );
                InstallerEngine::download_with_progress(
                    &app_handle,
                    &app_id,
                    &fallback_url,
                    &asset.name,
                    asset.sha256.as_deref(),
                    custom_download_dir.as_deref(),
                )
                .await
                .map_err(|fallback_err| {
                    format!("下载失败（直连: {}；镜像重试: {}）", e, fallback_err)
                })?
            } else {
                return Err(e);
            }
        }
    };

    // 4. 调用原生安装器或解压便携版（优先使用用户在前端主动选择的目录）
    let (kind, _, _) = InstallerEngine::classify_asset(&asset.name);
    let effective_portable_dir = custom_install_dir.or(custom_portable_dir);
    let _install_note = InstallerEngine::execute_installation(
        &dest_path,
        &kind,
        &detail.id,
        effective_portable_dir.as_deref(),
    )
    .await?;

    // 智能解析真实安装路径，避免存入临时安装包路径
    let mut real_install_path = match kind {
        crate::installer::AssetKind::PortableZip => {
            let app_dir = crate::installer::dirs_or_fallback_with_base(
                &detail.id,
                effective_portable_dir.as_deref(),
            );
            crate::scanner::AppScanner::resolve_executable_path(
                Some(&app_dir.to_string_lossy()),
                None,
                &detail.repo,
            )
            .unwrap_or_else(|| app_dir.to_string_lossy().to_string())
        }
        _ => crate::scanner::AppScanner::resolve_installed_app_path(
            &detail.name,
            &detail.id,
            Some(&detail.repo),
        )
        .unwrap_or_default(),
    };

    // 针对外部向导安装，若未立即捕获路径，进行短暂重试嗅探 (最多 5 次，每次 500ms)
    if real_install_path.is_empty() && kind != crate::installer::AssetKind::PortableZip {
        for _ in 0..5 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Some(p) = crate::scanner::AppScanner::resolve_installed_app_path(
                &detail.name,
                &detail.id,
                Some(&detail.repo),
            ) {
                real_install_path = p;
                break;
            }
        }
    }

    let resolved_uninst = resolve_uninstaller_command(
        &detail.name,
        &detail.id,
        &real_install_path,
        None,
    );

    // 5. 写入本地 SQLite 持久化
    let installed_app = InstalledApp {
        app_id: detail.id.clone(),
        app_name: detail.name.clone(),
        version: detail.latest_version.clone(),
        installed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        install_method: asset.kind.clone(),
        install_path: real_install_path,
        asset_name: asset.name.clone(),
        asset_sha256: actual_sha256,
        uninstall_command: resolved_uninst,
        icon: Some(detail.icon.clone()),
        icon_bg: Some(detail.icon_bg.clone()),
    };

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.save_installed_app(&installed_app)
            .map_err(|e| e.to_string())?;
    }

    // 精准将新安装的应用增量写入常驻缓存，避免全盘重新扫描
    crate::commands::scanner::add_to_detected_cache(&detail.id);

    // 仅便携版 (PortableZip) 在此处同步清理临时安装包；MSI 与 SetupExe 已由后台守护线程在安装进程退出后安全移除
    if kind == crate::installer::AssetKind::PortableZip && dest_path.is_file() {
        let _ = std::fs::remove_file(&dest_path);
    }

    Ok(installed_app)
}

/// P0-2 portable-uninstall guard: `remove_dir_all` is allowed ONLY inside
/// Z-Store's own self-created isolated dir (`dirs_or_fallback(app_id)`).
/// Both paths are canonicalized first (symlink/case/prefix edges); the
/// component-wise `starts_with` prevents sibling-prefix confusion (`app` vs `app2`).
pub(crate) fn is_owned_portable_dir(
    candidate: &std::path::Path,
    owned_dir: &std::path::Path,
) -> bool {
    let canon_candidate =
        std::fs::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf());
    let canon_owned = std::fs::canonicalize(owned_dir).unwrap_or_else(|_| owned_dir.to_path_buf());
    if canon_candidate.starts_with(&canon_owned) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        // Case-insensitive fallback with separator-aware prefix compare.
        let cand = canon_candidate.to_string_lossy().to_lowercase();
        let mut owned = canon_owned.to_string_lossy().to_lowercase();
        while owned.ends_with('\\') || owned.ends_with('/') {
            owned.pop();
        }
        if cand == owned {
            return true;
        }
        return cand.starts_with(&owned)
            && cand[owned.len()..].starts_with(['\\', '/']);
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// P0-2 safe cleanup: owned dir -> `remove_dir_all`; shared dir (Downloads /
/// D:\Tools style) -> remove only the manifest-recorded single file, or refuse.
pub(crate) fn cleanup_portable_path(
    install_path: &std::path::Path,
    owned_dir: &std::path::Path,
) {
    let dir = if install_path.is_file() {
        install_path.parent()
    } else if install_path.is_dir() {
        Some(install_path)
    } else {
        None
    };
    if let Some(d) = dir {
        if d.exists() && is_owned_portable_dir(d, owned_dir) {
            let _ = std::fs::remove_dir_all(d);
        } else if install_path.is_file() && install_path.exists() {
            let _ = std::fs::remove_file(install_path);
        }
    }
}

#[tauri::command]
pub async fn uninstall_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    log::info!("uninstall start sid={} id={}", crate::z_log::new_session_id(), app_id);
    let installed_app = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_installed_apps()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.app_id == app_id)
    };

    let app = match installed_app {
        Some(a) => a,
        None => {
            let cat = state
                .catalog
                .get_catalog_items()
                .into_iter()
                .find(|c| c.id == app_id)
                .ok_or_else(|| format!("未找到 ID 为 {} 的应用安装记录", app_id))?;
            let resolved_path = crate::scanner::AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo));
            InstalledApp {
                app_id: cat.id.clone(),
                app_name: cat.name.clone(),
                version: cat.default_version.clone(),
                installed_at: 0,
                install_method: "system_import".to_string(),
                install_path: resolved_path.unwrap_or_default(),
                asset_name: "system_detected".to_string(),
                asset_sha256: "system_verified".to_string(),
                uninstall_command: None,
                icon: Some(cat.icon),
                icon_bg: Some(cat.icon_bg),
            }
        }
    };

    // 1. 便携版清理：remove_dir_all 仅允许在 Z-Store 自建隔离目录内 (P0-2)
    if app.install_method == "portable_zip" {
        cleanup_portable_path(
            std::path::Path::new(&app.install_path),
            &crate::installer::dirs_or_fallback(&app.app_id),
        );
    } else {
        // 2. 安装版 / 系统导入版：动态定位并调起官方卸载向导 EXE，挂起等待用户操作完成并核验
        let resolved_uninst = resolve_uninstaller_command(
            &app.app_name,
            &app.app_id,
            &app.install_path,
            app.uninstall_command.as_deref(),
        );

        if let Some(cmd_str) = resolved_uninst {
            crate::installer::executor::execute_uninstallation(
                &cmd_str,
                &app.install_path,
                &app.app_name,
            )
            .await?;
        } else {
            return Err(format!(
                "未在系统中检测到 {} 的官方卸载程序。如需从 Z-Store 中移除管理记录，请在卡片更多操作中选择「从列表移除」",
                app.app_name
            ));
        }
    }

    // 3. 默认便携缓存目录清理
    let app_dir = crate::installer::dirs_or_fallback(&app.app_id);
    if app_dir.exists() {
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    // 4. 快捷方式清理
    #[cfg(target_os = "windows")]
    {
        let desktop = std::env::var("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join("Desktop"))
            .unwrap_or_else(|_| std::path::PathBuf::from("C:\\Users\\Public\\Desktop"));
        let lnk = desktop.join(format!("{}.lnk", app.app_name));
        if lnk.exists() {
            let _ = std::fs::remove_file(lnk);
        }
    }

    // 5. 卸载向导操作或目录清理核验通过后，才正式从 SQLite 数据库移除条例
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let res = db.remove_installed_app(&app_id).map_err(|e| e.to_string());

    // 6. 精准从缓存中移除该应用，避免产生全量扫描开销
    crate::commands::scanner::remove_from_detected_cache(&app_id);

    match &res {
        Ok(_) => log::info!("uninstall done sid={} id={}", crate::z_log::new_session_id(), app_id),
        Err(e) => log::warn!(
            "uninstall failed id={} reason={}",
            app_id,
            crate::log_support::short_reason(e)
        ),
    }

    res
}

#[tauri::command]
pub fn unmanage_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let res = db.remove_installed_app(&app_id).map_err(|e| e.to_string());
    // 从列表移除管理后，本机依然存在该软件，因此保持/添加到已探测缓存中
    crate::commands::scanner::add_to_detected_cache(&app_id);
    res
}

#[tauri::command]
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

#[cfg(test)]
mod portable_uninstall_safety_tests {
    use std::fs;

    #[test]
    fn uninstall_shared_dir_survives() {
        // P0-2 RED: app unpacked into a shared dir (Downloads / D:\Tools style)
        // must NEVER trigger remove_dir_all on the shared dir.
        let base = std::env::temp_dir().join(format!("zstore-red-shared-{}", std::process::id()));
        let shared = base.join("shared");
        let owned = base.join("owned").join("owner-repo");
        fs::create_dir_all(&shared).unwrap();
        fs::create_dir_all(&owned).unwrap();
        let exe = shared.join("app.exe");
        let precious = shared.join("precious.txt");
        fs::write(&exe, b"fake-exe").unwrap();
        fs::write(&precious, b"user data must survive").unwrap();

        super::cleanup_portable_path(&exe, &owned);

        assert!(precious.exists(), "shared dir sibling file was wiped (data loss)");
        assert!(shared.exists(), "shared dir itself was wiped (data loss)");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn uninstall_owned_dir_is_cleaned() {
        // Owned isolated dir (dirs_or_fallback shape) must still be fully cleaned.
        let base = std::env::temp_dir().join(format!("zstore-green-owned-{}", std::process::id()));
        let owned = base.join("owned").join("owner-repo");
        fs::create_dir_all(&owned).unwrap();
        let exe = owned.join("app.exe");
        fs::write(&exe, b"fake-exe").unwrap();

        super::cleanup_portable_path(&exe, &owned);

        assert!(!owned.exists(), "owned isolated dir should be fully cleaned");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn uninstall_owned_prefix_sibling_is_not_owned() {
        // Prefix edge: <base>/app2 must not count as inside <base>/app.
        let base = std::env::temp_dir().join(format!("zstore-prefix-{}", std::process::id()));
        let owned = base.join("app");
        let sibling = base.join("app2");
        fs::create_dir_all(&owned).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        assert!(!super::is_owned_portable_dir(&sibling, &owned));
        let _ = fs::remove_dir_all(&base);
    }
}
