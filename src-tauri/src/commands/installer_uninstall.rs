use crate::models::InstalledApp;
use crate::AppState;
use super::resolve_uninstaller_command;
use tauri::State;

/// ADR-0010 entry guard (same pattern as `launch_app`): normalize the inbound
/// id to canonical form; reject unparseable ids instead of passing raw ids through.
pub(crate) fn resolve_managed_app_id(raw: &str) -> Result<String, String> {
    crate::forge::canonical_app_id(raw)
        .ok_or_else(|| format!("无法识别的应用标识: {}", raw))
}

/// Finding 3.2-3 no-schema-change marking: `InstalledApp` carries no missing
/// flag without a DB migration (models.rs intentionally untouched), so ghosts
/// are hidden from the returned view while their DB rows are kept. Pure
/// filter — performs zero DB/cache deletes; the count is surfaced via log in
/// `get_installed_apps`. Actual deletion only via explicit uninstall/unmanage paths.
pub(crate) fn hide_ghost_apps(
    apps: Vec<InstalledApp>,
    ghost_ids: &[String],
) -> Vec<InstalledApp> {
    apps
        .into_iter()
        .filter(|a| !ghost_ids.iter().any(|g| g == &a.app_id))
        .collect()
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

pub fn unmanage_app(state: State<'_, AppState>, app_id: String) -> Result<bool, String> {
    // ADR-0010: same entry guard as `launch_app` — normalize then use canonical id throughout.
    let app_id = resolve_managed_app_id(&app_id)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let res = db.remove_installed_app(&app_id).map_err(|e| e.to_string());
    // 从列表移除管理后，本机依然存在该软件，因此保持/添加到已探测缓存中
    crate::commands::scanner::add_to_detected_cache(&app_id);
    res
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
        // Finding 2.1-1 part B: unparseable ids must be rejected, never pass through raw.
        assert!(super::resolve_managed_app_id("").is_err());
        assert!(super::resolve_managed_app_id("   ").is_err());
        assert!(super::resolve_managed_app_id("not a valid id !!!").is_err());
    }

    #[test]
    fn unmanage_normalizes_to_canonical_id() {
        // Same ADR-0010 pattern as launch_app: entry guard normalizes, canonical used downstream.
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
        // Finding 3.2-3: vanished executable -> hidden from returned view;
        // DB row retention is structural (pure filter performs zero DB deletes;
        // get_installed_apps must not call remove_installed_app on ghosts).
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
