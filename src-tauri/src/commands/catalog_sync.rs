use crate::models::SyncCatalogResult;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn sync_catalog(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> crate::AppResult<SyncCatalogResult> {
    let (url, cached_etag) = {
        let db = state.db()?;
        let url = db
            .get_setting("catalog_source_url")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                crate::config::get_project_config()
                    .catalog
                    .default_source_url
                    .clone()
            });
        let is_force = force.unwrap_or(false);
        let etag = if is_force {
            None
        } else {
            db.get_etag(&url).ok().flatten()
        };
        (url, etag)
    };

    let safe_url = crate::log_support::sanitize_url(&url);
    let is_force = force.unwrap_or(false);
    log::info!("sync catalog start url='{}' force={}", safe_url, is_force);

    let res = state
        .catalog
        .sync_remote_catalog(&url, cached_etag.as_deref())
        .await;

    let (new_items, new_etag) = match res {
        Ok(val) => val,
        Err(err) => {
            // 如果请求远程失败且为默认或远程链接，检测本地配置的 catalog.json 路径作为无缝备选
            let mut local_fallback = None;
            let cfg = crate::config::get_project_config();
            if let Some(resolved_path) = cfg.catalog.resolve_local_path() {
                let path_str = resolved_path.to_string_lossy().to_string();
                if let Ok((Some(items), _)) =
                    state.catalog.sync_remote_catalog(&path_str, None).await
                {
                    local_fallback = Some((items, path_str));
                }
            }

            if let Some((items, candidate)) = local_fallback {
                let count = items.len();
                log::warn!(
                    "sync catalog remote failed url='{}' reason={}, fallback to local path='{}' count={}",
                    safe_url,
                    crate::log_support::short_reason(&err),
                    candidate,
                    count
                );
                return Ok(SyncCatalogResult {
                    updated: true,
                    count,
                    message: format!(
                        "远程源未就绪，已自动从本地 {} 载入 {} 款应用（本地开发模式）",
                        candidate, count
                    ),
                });
            } else {
                log::error!(
                    "sync catalog failed url='{}' reason={}",
                    safe_url,
                    crate::log_support::short_reason(&err)
                );
                return Err(err.into());
            }
        }
    };

    if let Some(items) = new_items {
        let count = items.len();
        if let Some(etag) = new_etag {
            if let Ok(db) = state.db() {
                let now = crate::now_secs();
                let json_str = serde_json::to_string(&items).unwrap_or_default();
                let _ = db.save_etag(&url, &etag, &json_str, now);
            }
        }
        log::info!(
            "sync catalog done url='{}' updated=true count={}",
            safe_url,
            count
        );
        Ok(SyncCatalogResult {
            updated: true,
            count,
            message: format!("成功同步收录清单，当前共 {} 个精选应用", count),
        })
    } else {
        let count = state.catalog.get_catalog_count();
        log::info!(
            "sync catalog done url='{}' updated=false (up-to-date) count={}",
            safe_url,
            count
        );
        Ok(SyncCatalogResult {
            updated: false,
            count,
            message: format!("收录清单已是最新，共 {} 个应用", count),
        })
    }
}

#[tauri::command]
pub fn get_catalog_count(state: State<'_, AppState>) -> crate::AppResult<usize> {
    Ok(state.catalog.get_catalog_count())
}
