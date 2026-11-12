use crate::models::SyncCatalogResult;
use crate::AppState;
use tauri::State;

/// 收录清单同步：网络默认允许（ETag 条件请求，未变更即 304 零消耗复用内存目录）。
/// `force` 为手动同步按钮透传位，`Some(true)` 时跳过 ETag 复用、强制拉取远端。
#[tauri::command]
pub async fn sync_catalog(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> crate::AppResult<SyncCatalogResult> {
    // 串行化清单同步：避免启动静默同步与设置页手动同步并发交叉写库或乱序覆盖 ETag。
    let _sync_guard = state.sync_lock.lock().await;
    let start = std::time::Instant::now();
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

    let is_force = force.unwrap_or(false);
    let is_default_src = crate::github::catalog_service::is_default_catalog_source(&url);
    let source_kind = if is_default_src { "default" } else { "custom" };

    let res = state
        .catalog
        .fetch_remote_catalog(&url, cached_etag.as_deref())
        .await;

    let (new_items, new_etag) = match res {
        Ok(val) => val,
        Err(err) => {
            let (strict_errors, catalog_has_rows) = state
                .db()
                .map(|db| {
                    (
                        db.is_strict_errors(),
                        db.count_catalog_apps().map(|c| c > 0).unwrap_or(false),
                    )
                })
                .unwrap_or_else(|_| (crate::config::is_strict_errors(), false));
            if !should_use_local_fallback(strict_errors, catalog_has_rows) {
                let mut ev =
                    crate::z_log::WideEvent::new("catalog", "sync failed").with_started(start);
                ev.field("source", source_kind)
                    .field("strict", strict_errors)
                    .field("reason", crate::log_support::short_reason(&err))
                    .dev("force", is_force)
                    .dev("has_rows", catalog_has_rows)
                    .dev_url("url", &url);
                ev.error();
                return Err(err.into());
            }
            let mut local_fallback = None;
            let cfg = crate::config::get_project_config();
            if let Some(resolved_path) = cfg.catalog.resolve_local_path() {
                let path_str = resolved_path.to_string_lossy().to_string();
                if let Ok((Some(items), _)) =
                    state.catalog.fetch_remote_catalog(&path_str, None).await
                {
                    local_fallback = Some((items, path_str));
                }
            }

            if let Some((items, candidate)) = local_fallback {
                let count = items.len();
                let graduated = apply_manifest_to_db(&state, &items, None)?;
                let mut ev =
                    crate::z_log::WideEvent::new("catalog", "sync fallback").with_started(start);
                ev.field("source", "local")
                    .field("count", count)
                    .field("reason", crate::log_support::short_reason(&err))
                    .dev("graduated", graduated.len())
                    .dev("local_file", crate::log_support::file_base(&candidate))
                    .dev_url("url", &url);
                ev.warn();
                return Ok(SyncCatalogResult {
                    updated: true,
                    count,
                    message: with_graduation_hint(
                        &format!(
                            "远程源未就绪，已自动从本地 {} 载入 {} 款应用（本地开发模式）",
                            candidate, count
                        ),
                        &graduated,
                    ),
                });
            } else {
                let mut ev =
                    crate::z_log::WideEvent::new("catalog", "sync failed").with_started(start);
                ev.field("source", source_kind)
                    .field("reason", crate::log_support::short_reason(&err))
                    .dev("force", is_force)
                    .dev_url("url", &url);
                ev.error();
                return Err(err.into());
            }
        }
    };

    if let Some(items) = new_items {
        let count = items.len();
        let now = crate::now_secs();
        let etag_entry = new_etag.as_deref().map(|et| (url.as_str(), et, now));
        // ETag 与目录写入同一事务提交：只有 catalog_apps 成功落库后才保存新 ETag 并刷新内存索引。
        let graduated = apply_manifest_to_db(&state, &items, etag_entry)?;
        let mut ev = crate::z_log::WideEvent::new("catalog", "sync ok").with_started(start);
        ev.field("source", source_kind)
            .field("updated", true)
            .field("count", count)
            .dev("force", is_force)
            .dev("graduated", graduated.len())
            .dev_url("url", &url);
        if is_default_src {
            ev.info();
        } else {
            ev.warn();
        }
        Ok(SyncCatalogResult {
            updated: true,
            count,
            message: with_graduation_hint(
                &format!("成功同步收录清单，当前共 {} 个精选应用", count),
                &graduated,
            ),
        })
    } else {
        let count = state.catalog.get_catalog_count();
        let mut ev =
            crate::z_log::WideEvent::new("catalog", "sync unchanged").with_started(start);
        ev.field("source", source_kind)
            .field("updated", false)
            .field("count", count)
            .dev("via", "304")
            .dev_url("url", &url);
        if is_default_src {
            ev.info();
        } else {
            ev.warn();
        }
        Ok(SyncCatalogResult {
            updated: false,
            count,
            message: format!("收录清单已是最新，共 {} 个应用", count),
        })
    }
}

/// 远端失败是否允许本地种子降级：严格模式或数据库已有目录行时禁止用静态种子覆盖。
pub(crate) fn should_use_local_fallback(strict_errors: bool, catalog_has_rows: bool) -> bool {
    !strict_errors && !catalog_has_rows
}

/// 清单同步落库（Repository 收口）：单事务内权威覆盖 `catalog_apps` + 转正归档 `custom_apps` +
/// 回填收藏/关注收录标记（+ 可选同事务落盘新 ETag）；提交成功后同步刷新 `CatalogService` 内存热读索引。
fn apply_manifest_to_db(
    state: &tauri::State<'_, AppState>,
    items: &[crate::github::models::CatalogItem],
    etag_entry: Option<(&str, &str, i64)>,
) -> Result<Vec<String>, String> {
    let db = state.db()?;
    let graduated =
        crate::repositories::CatalogRepository::apply_remote_manifest_with_etag(
            &db,
            items,
            etag_entry,
        )
        .map_err(|e| format!("保存收录清单到数据库失败: {}", e))?;
    state.catalog.sync_from_db(&db);
    Ok(graduated)
}

/// 转正提示拼接到同步消息尾部（无转正原样返回）。
fn with_graduation_hint(base: &str, graduated: &[String]) -> String {
    if graduated.is_empty() {
        base.to_string()
    } else {
        format!(
            "{}；{} 款自维护草稿已转正并自动归档（{}）",
            base,
            graduated.len(),
            graduated.join("、")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::should_use_local_fallback;

    #[test]
    fn strict_mode_skips_local_fallback() {
        assert!(!should_use_local_fallback(true, false));
        assert!(!should_use_local_fallback(true, true));
    }

    #[test]
    fn graceful_mode_uses_local_fallback_only_when_catalog_empty() {
        assert!(should_use_local_fallback(false, false));
        assert!(!should_use_local_fallback(false, true));
    }

    #[test]
    fn graduation_hint_appends_only_on_hits() {
        assert_eq!(super::with_graduation_hint("ok", &[]), "ok".to_string());
        assert_eq!(
            super::with_graduation_hint("ok", &["o/r".to_string()]),
            "ok；1 款自维护草稿已转正并自动归档（o/r）".to_string()
        );
    }
}
