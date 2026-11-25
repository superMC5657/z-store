use crate::models::InstalledApp;
use crate::AppState;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn scan_and_match_local_apps(
    app_handle: AppHandle,
) -> crate::AppResult<Vec<crate::scanner::AppMatchResult>> {
    // 注册表枚举 + 逐应用文件系统探测是慢 IO（冷盘秒级）：命令体卸到 blocking
    // 线程池，避免同步命令冻结主线程（对照 settings.rs select_folder 同姿势）。
    let unmanaged = tokio::task::spawn_blocking(
        move || -> crate::AppResult<Vec<crate::scanner::AppMatchResult>> {
            let state = app_handle.state::<AppState>();
            let scan_start = std::time::Instant::now();
            let catalog_items = state.catalog.get_catalog_items();
            let installed_ids: Vec<String> = {
                let db = state.db()?;
                db.get_installed_apps()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|a| a.app_id)
                    .collect()
            };

            let outcome = crate::scanner::AppScanner::scan_unmanaged(&catalog_items, installed_ids);

            // 汇总一行 info：只记数量，不记路径/名称原文。
            let mut ev =
                crate::z_log::WideEvent::new("scanner", "scan done").with_started(scan_start);
            ev.field("scanned", outcome.scanned_count)
                .field("unmanaged", outcome.unmanaged.len());
            ev.info();

            Ok(outcome.unmanaged)
        },
    )
    .await
    .map_err(|e| crate::AppError::new(e.to_string()))??;
    Ok(unmanaged)
}

/// 预校验全部入站 `app_id` 并在未持有 SQLite 锁的前提下完成目录元数据查询与
/// 文件系统/注册表 `installed_at` 探测；任意 ID 非法立即中止，不产生部分写入。
fn prepare_import_records(
    apps: Vec<crate::scanner::ImportAppRequest>,
    now: i64,
    mut lookup_icon: impl FnMut(&str) -> (Option<String>, Option<String>),
    mut resolve_installed_at: impl FnMut(&str, &str, &str) -> Option<i64>,
) -> Result<Vec<InstalledApp>, String> {
    // 1. 全量前置校验：任一 ID 非法直接拒绝整批，避免慢 IO 探测与部分落库。
    let mut validated: Vec<(String, crate::scanner::ImportAppRequest)> =
        Vec::with_capacity(apps.len());
    for req in apps {
        let app_id = super::require_app_id(&req.app_id)?;
        validated.push((app_id, req));
    }

    // 2. 锁外构造待写入记录（含慢 IO 的 installed_at 回溯）。
    let mut records = Vec::with_capacity(validated.len());
    for (app_id, req) in validated {
        let (icon, icon_bg) = lookup_icon(&app_id);
        let install_path = req.install_path.unwrap_or_default();
        let installed_at = req
            .installed_at
            .or_else(|| resolve_installed_at(&req.app_name, &app_id, &install_path))
            .unwrap_or(now);

        records.push(InstalledApp {
            app_id,
            app_name: req.app_name,
            version: req.version,
            installed_at,
            install_method: "system_import".to_string(),
            install_path,
            asset_name: "system_detected".to_string(),
            asset_sha256: "system_verified".to_string(),
            uninstall_command: req.uninstall_command,
            icon,
            icon_bg,
        });
    }

    Ok(records)
}

/// 在单一 `IMMEDIATE` 事务内原子提交全部导入记录。
fn commit_imported_apps(
    db: &crate::db::Database,
    records: &[InstalledApp],
) -> rusqlite::Result<usize> {
    if records.is_empty() {
        return Ok(0);
    }
    db.with_immediate_transaction(|| {
        let mut count = 0usize;
        for installed in records {
            crate::installer::managed::record_installed(db, installed)?;
            count += 1;
        }
        Ok(count)
    })
}

#[tauri::command]
pub async fn import_matched_apps(
    app_handle: AppHandle,
    apps: Vec<crate::scanner::ImportAppRequest>,
) -> crate::AppResult<usize> {
    // 逐应用文件系统探测（installed_at 回溯）是慢 IO：与扫描同姿势卸 blocking 线程池，
    // 并在获取全局 SQLite 锁之前完成全部校验与探测，最后在单事务内原子落库。
    let imported_count = tokio::task::spawn_blocking(move || -> crate::AppResult<usize> {
        let state = app_handle.state::<AppState>();
        let now = crate::now_secs();

        let records = prepare_import_records(
            apps,
            now,
            |app_id| {
                state
                    .catalog
                    .get_catalog_item(app_id)
                    .map(|cat| (Some(cat.icon), Some(cat.icon_bg)))
                    .unwrap_or((None, None))
            },
            crate::scanner::AppScanner::resolve_app_installed_at,
        )?;

        let db = state.db()?;
        let imported_count = commit_imported_apps(&db, &records).map_err(|e| e.to_string())?;
        Ok(imported_count)
    })
    .await
    .map_err(|e| crate::AppError::new(e.to_string()))??;
    Ok(imported_count)
}

#[cfg(test)]
mod import_matched_apps_tests {
    use super::{commit_imported_apps, prepare_import_records};
    use crate::db::Database;
    use crate::scanner::ImportAppRequest;

    fn sample_req(app_id: &str, app_name: &str, installed_at: Option<i64>) -> ImportAppRequest {
        ImportAppRequest {
            app_id: app_id.to_string(),
            app_name: app_name.to_string(),
            version: "1.0.0".to_string(),
            install_path: Some(r"C:\Apps\Sample\app.exe".to_string()),
            uninstall_command: None,
            installed_at,
        }
    }

    #[test]
    fn invalid_id_in_batch_fails_before_probing_and_leaves_db_untouched() {
        let db = Database::open_in_memory().unwrap();
        let mut probed = 0usize;
        let apps = vec![
            sample_req("Owner/ValidApp", "ValidApp", None),
            sample_req("not valid !!!", "BadApp", None),
        ];

        let err = prepare_import_records(
            apps,
            1_700_000_000,
            |_| (None, None),
            |_, _, _| {
                probed += 1;
                Some(1_600_000_000)
            },
        )
        .expect_err("invalid app_id must fail entire batch");

        assert!(!err.is_empty());
        assert_eq!(
            probed, 0,
            "ID validation must run before any filesystem/registry probing"
        );
        assert!(db.get_installed_apps().unwrap().is_empty());
    }

    #[test]
    fn commit_imported_apps_writes_all_rows_atomically() {
        let db = Database::open_in_memory().unwrap();
        let apps = vec![
            sample_req("Owner/AppOne", "AppOne", Some(1_650_000_000)),
            sample_req("Owner/AppTwo", "AppTwo", None),
        ];

        let mut probe_calls = Vec::new();
        let records = prepare_import_records(
            apps,
            1_700_000_000,
            |id| (Some(format!("icon:{id}")), Some("#111".to_string())),
            |name, id, path| {
                probe_calls.push((name.to_string(), id.to_string(), path.to_string()));
                Some(1_660_000_000)
            },
        )
        .unwrap();

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].app_id, "owner/appone");
        assert_eq!(records[0].installed_at, 1_650_000_000);
        assert_eq!(records[1].app_id, "owner/apptwo");
        assert_eq!(records[1].installed_at, 1_660_000_000);
        assert_eq!(
            probe_calls.len(),
            1,
            "only apps missing installed_at should trigger probing"
        );

        let count = commit_imported_apps(&db, &records).unwrap();
        assert_eq!(count, 2);
        let stored = db.get_installed_apps().unwrap();
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().any(|a| a.app_id == "owner/appone"));
        assert!(stored.iter().any(|a| a.app_id == "owner/apptwo"));
    }
}
