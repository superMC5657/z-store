use super::resolve_uninstaller_command;
use crate::models::InstalledApp;
use crate::{AppResult, AppState};
use tauri::State;

/// 归一化并校验入站 `app_id`。
pub(crate) fn resolve_managed_app_id(raw: &str) -> Result<String, String> {
    super::require_app_id(raw)
}

/// 从返回视图中过滤幽灵应用，同时保留数据库记录。
pub(crate) fn hide_ghost_apps(apps: Vec<InstalledApp>, ghost_ids: &[String]) -> Vec<InstalledApp> {
    apps.into_iter()
        .filter(|a| !ghost_ids.iter().any(|g| g == &a.app_id))
        .collect()
}

/// 校验候选目录是否位于 ZStore 自建的隔离便携目录内（规范化后逐级路径比较）。
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
    // 针对 Windows 平台不区分大小写且兼顾路径分隔符的前缀比对回退方案。
    // 用 `cfg!` 而非 `#[cfg]` 块做尾表达式，避免 `needless_return` 与块值丢弃冲突。
    if cfg!(target_os = "windows") {
        let cand = canon_candidate.to_string_lossy().to_lowercase();
        let mut owned = canon_owned.to_string_lossy().to_lowercase();
        while owned.ends_with('\\') || owned.ends_with('/') {
            owned.pop();
        }
        if cand == owned {
            return true;
        }
        cand.starts_with(&owned) && cand[owned.len()..].starts_with(['\\', '/'])
    } else {
        false
    }
}

/// 清理便携应用路径：自有隔离目录整目录删除，共享目录仅删除对应文件；失败返回 Err 以保留记录。
pub(crate) fn cleanup_portable_path(
    install_path: &std::path::Path,
    owned_dir: &std::path::Path,
) -> Result<(), String> {
    let dir = if install_path.is_file() {
        install_path.parent()
    } else if install_path.is_dir() {
        Some(install_path)
    } else {
        None
    };
    if let Some(d) = dir {
        if d.exists() {
            if is_owned_portable_dir(d, owned_dir) {
                std::fs::remove_dir_all(d)
                    .map_err(|e| format!("清理便携目录失败 ({}): {}", d.display(), e))?;
            } else if install_path.is_file() && install_path.exists() {
                std::fs::remove_file(install_path).map_err(|e| {
                    format!("删除清单记录文件失败 ({}): {}", install_path.display(), e)
                })?;
            }
        }
    }
    Ok(())
}

/// 解析并校验位于 Desktop 目录内的快捷方式路径，防止路径穿越误删外部文件。
#[cfg(target_os = "windows")]
fn deletable_desktop_lnk(desktop: &std::path::Path, app_name: &str) -> Option<std::path::PathBuf> {
    let name = crate::installer::sanitize_shortcut_name(app_name);
    let lnk = desktop.join(format!("{}.lnk", name));
    if !lnk.exists() {
        return None;
    }
    let canon_lnk = lnk.canonicalize().ok()?;
    let canon_desktop = desktop.canonicalize().ok()?;
    canon_lnk.starts_with(canon_desktop).then_some(lnk)
}

#[cfg(target_os = "windows")]
fn cleanup_desktop_shortcut(app_name: &str) {
    let desktop = std::env::var("USERPROFILE")
        .map(|p| std::path::PathBuf::from(p).join("Desktop"))
        .unwrap_or_else(|_| std::path::PathBuf::from("C:\\Users\\Public\\Desktop"));
    if let Some(lnk) = deletable_desktop_lnk(&desktop, app_name) {
        if let Err(e) = std::fs::remove_file(&lnk) {
            let mut ev = crate::z_log::WideEvent::new("installer", "shortcut cleanup failed");
            ev.field("reason", crate::log_support::short_reason(&e.to_string()))
                .dev(
                    "file",
                    crate::log_support::file_base(&lnk.to_string_lossy()),
                );
            ev.warn();
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn uninstall_app(state: State<'_, AppState>, app_id: String) -> AppResult<bool> {
    let app_id = super::require_app_id(&app_id)?;
    let started = std::time::Instant::now();
    let trace = crate::z_log::new_trace_id();
    let mut start_ev = crate::z_log::WideEvent::new("installer", "uninstall start");
    start_ev.field("id", &app_id).field("t", &trace);
    start_ev.info();
    let installed_app = {
        let db = state.db()?;
        db.get_installed_app(&app_id).map_err(|e| e.to_string())?
    };

    let app = match installed_app {
        Some(a) => a,
        None => {
            let cat = state
                .catalog
                .get_catalog_item(&app_id)
                .ok_or_else(|| format!("未找到 ID 为 {} 的应用安装记录", app_id))?;
            let resolved_path = {
                let (name, id, repo) = (cat.name.clone(), cat.id.clone(), cat.repo.clone());
                super::installer_query::run_blocking(move || {
                    crate::scanner::AppScanner::resolve_installed_app_path(&name, &id, Some(&repo))
                })
                .await?
            };
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

    // 便携版清理：仅在自有隔离目录内整目录删除，失败则中止以保留记录。
    if app.install_method == "portable_zip" {
        let (path, owned) = (
            std::path::PathBuf::from(&app.install_path),
            crate::installer::dirs_or_fallback(&app.app_id),
        );
        super::installer_query::run_blocking(move || cleanup_portable_path(&path, &owned))
            .await??;
    } else {
        // 安装版与系统导入版：定位并执行官方卸载程序
        let resolved_uninst = {
            let (name, id, path, cmd) = (
                app.app_name.clone(),
                app.app_id.clone(),
                app.install_path.clone(),
                app.uninstall_command.clone(),
            );
            super::installer_query::run_blocking(move || {
                resolve_uninstaller_command(&name, &id, &path, cmd.as_deref())
            })
            .await?
        };

        if let Some(cmd_str) = resolved_uninst {
            crate::installer::executor::execute_uninstallation(
                &cmd_str,
                &app.install_path,
                &app.app_name,
            )
            .await?;
        } else {
            return Err(format!(
                "未在系统中检测到 {} 的官方卸载程序。如需从 ZStore 中移除管理记录，请在卡片更多操作中选择「从列表移除」",
                app.app_name
            ).into());
        }
    }

    // 清理默认便携缓存目录（失败上浮以保留记录）
    let app_dir = crate::installer::dirs_or_fallback(&app.app_id);
    super::installer_query::run_blocking(move || -> Result<(), String> {
        if app_dir.exists() {
            std::fs::remove_dir_all(&app_dir)
                .map_err(|e| format!("清理默认便携缓存目录失败 ({}): {}", app_dir.display(), e))?;
        }
        Ok(())
    })
    .await??;

    // 清理桌面快捷方式
    #[cfg(target_os = "windows")]
    cleanup_desktop_shortcut(&app.app_name);

    // 卸载核验通过后再移除数据库记录
    let db = state.db()?;
    let res = db.remove_installed_app(&app_id).map_err(|e| e.to_string());
    // 卸载失效：已卸载应用的更新判定行同步清理，best-effort 不影响卸载结果。
    if res.as_ref().is_ok_and(|v| *v) {
        let _ = db.remove_update_result(&app_id);
    }

    match &res {
        Ok(_) => {
            let mut ev =
                crate::z_log::WideEvent::new("installer", "uninstall done").with_started(started);
            ev.field("id", &app_id)
                .field("t", &trace)
                .dev("method", &app.install_method);
            ev.info();
        }
        Err(e) => {
            let mut ev =
                crate::z_log::WideEvent::new("installer", "uninstall failed").with_started(started);
            ev.field("id", &app_id)
                .field("reason", crate::log_support::short_reason(e))
                .field("t", &trace);
            ev.error();
        }
    }

    Ok(res?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn unmanage_app(state: State<'_, AppState>, app_id: String) -> AppResult<bool> {
    // 归一化入站 app_id
    let app_id = resolve_managed_app_id(&app_id)?;
    let db = state.db()?;
    let res = db.remove_installed_app(&app_id).map_err(|e| e.to_string());
    // 取消管理同步失效更新判定行（同卸载语义，best-effort）。
    if res.as_ref().is_ok_and(|v| *v) {
        let _ = db.remove_update_result(&app_id);
    }
    Ok(res?)
}

#[cfg(test)]
mod portable_uninstall_safety_tests {
    use std::fs;

    #[test]
    fn uninstall_shared_dir_survives() {
        // 安全用例：解压到共享目录（如 Downloads 或 D:\Tools）的应用
        // 绝不能对共享目录触发 remove_dir_all 递归删除。
        let base = std::env::temp_dir().join(format!("zstore-red-shared-{}", std::process::id()));
        let shared = base.join("shared");
        let owned = base.join("owned").join("owner-repo");
        fs::create_dir_all(&shared).unwrap();
        fs::create_dir_all(&owned).unwrap();
        let exe = shared.join("app.exe");
        let precious = shared.join("precious.txt");
        fs::write(&exe, b"fake-exe").unwrap();
        fs::write(&precious, b"user data must survive").unwrap();

        super::cleanup_portable_path(&exe, &owned).unwrap();

        assert!(
            precious.exists(),
            "shared dir sibling file was wiped (data loss)"
        );
        assert!(shared.exists(), "shared dir itself was wiped (data loss)");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn uninstall_owned_dir_is_cleaned() {
        // 自有专属隔离目录（dirs_or_fallback 形态）必须被完整清理删除。
        let base = std::env::temp_dir().join(format!("zstore-green-owned-{}", std::process::id()));
        let owned = base.join("owned").join("owner-repo");
        fs::create_dir_all(&owned).unwrap();
        let exe = owned.join("app.exe");
        fs::write(&exe, b"fake-exe").unwrap();

        super::cleanup_portable_path(&exe, &owned).unwrap();

        assert!(
            !owned.exists(),
            "owned isolated dir should be fully cleaned"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn uninstall_owned_prefix_sibling_is_not_owned() {
        // 前缀边界：<base>/app2 绝不能被判定在 <base>/app 内部。
        let base = std::env::temp_dir().join(format!("zstore-prefix-{}", std::process::id()));
        let owned = base.join("app");
        let sibling = base.join("app2");
        fs::create_dir_all(&owned).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        assert!(!super::is_owned_portable_dir(&sibling, &owned));
        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod ghost_and_id_guard_tests {
    use crate::models::InstalledApp;

    fn sample_app(id: &str, path: &str) -> InstalledApp {
        InstalledApp {
            app_id: id.to_string(),
            app_name: format!("{}-name", id),
            version: "1.0.0".to_string(),
            installed_at: 0,
            install_method: "portable_zip".to_string(),
            install_path: path.to_string(),
            asset_name: "a.zip".to_string(),
            asset_sha256: "x".to_string(),
            uninstall_command: None,
            icon: None,
            icon_bg: None,
        }
    }

    #[test]
    fn unmanage_rejects_unparseable_id() {
        // 无法解析的 id 必须直接报错拒绝，绝不可透传原始字符串。
        assert!(super::resolve_managed_app_id("").is_err());
        assert!(super::resolve_managed_app_id("   ").is_err());
        assert!(super::resolve_managed_app_id("not a valid id !!!").is_err());
    }

    #[test]
    fn unmanage_normalizes_to_canonical_id() {
        // 入口校验归一化，下游统一使用规范化 id。
        assert_eq!(
            super::resolve_managed_app_id("Owner/Repo").unwrap(),
            "owner/repo"
        );
        assert_eq!(
            super::resolve_managed_app_id("https://github.com/Owner/Repo").unwrap(),
            "owner/repo"
        );
    }

    #[test]
    fn scan_hides_ghost_from_view_but_signals_retention() {
        // 幽灵应用仅从返回视图中隐藏，不在此删除数据库记录。
        let apps = vec![
            sample_app("owner/healthy", "C:\\exists\\a.exe"),
            sample_app("owner/ghost", "C:\\vanished\\g.exe"),
        ];
        let out = super::hide_ghost_apps(apps, &["owner/ghost".to_string()]);
        assert_eq!(out.len(), 1, "ghost must be hidden from returned view");
        assert_eq!(out[0].app_id, "owner/healthy");
        assert!(
            !out.iter().any(|a| a.app_id == "owner/ghost"),
            "ghost id must not leak into view"
        );
    }

    #[test]
    fn scan_without_ghosts_returns_all() {
        let apps = vec![
            sample_app("owner/a", "C:\\exists\\a.exe"),
            sample_app("owner/b", "C:\\exists\\b.exe"),
        ];
        let out = super::hide_ghost_apps(apps, &[]);
        assert_eq!(out.len(), 2);
    }
}

#[cfg(all(test, target_os = "windows"))]
mod desktop_shortcut_guard_tests {
    use std::fs;

    fn temp_dir_with(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zstore-lnk-{}-{}", tag, std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn existing_sanitized_shortcut_is_deletable() {
        let desktop = temp_dir_with("del");
        fs::write(desktop.join("My App.lnk"), b"lnk").unwrap();
        assert!(super::deletable_desktop_lnk(&desktop, "My App").is_some());
        fs::remove_dir_all(&desktop).unwrap();
    }

    #[test]
    fn traversal_name_resolves_inside_desktop_only() {
        // app_name 含 `..\` 时消毒把分隔符剥掉，解析结果必须仍落在 Desktop 内，
        // Desktop 之外的同名文件绝不可见。
        let desktop = temp_dir_with("traverse");
        let outside = temp_dir_with("outside");
        let outside_lnk = outside.join("....evil.lnk");
        fs::write(&outside_lnk, b"lnk").unwrap();
        fs::write(desktop.join("....evil.lnk"), b"lnk").unwrap();

        let resolved = super::deletable_desktop_lnk(&desktop, "..\\..\\evil");
        assert!(resolved.is_some());
        assert_eq!(resolved.unwrap().parent().unwrap(), desktop.as_path());
        assert!(outside_lnk.exists(), "file outside desktop must survive");

        fs::remove_dir_all(&desktop).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn missing_shortcut_resolves_none() {
        let desktop = temp_dir_with("missing");
        assert!(super::deletable_desktop_lnk(&desktop, "ghost app").is_none());
        fs::remove_dir_all(&desktop).unwrap();
    }
}
