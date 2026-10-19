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
        .fetch_remote_catalog(&url, cached_etag.as_deref())
        .await;

    let (new_items, new_etag) = match res {
        Ok(val) => val,
        Err(err) => {
            let strict_errors = state
                .db()
                .map(|db| db.is_strict_errors())
                .unwrap_or_else(|_| crate::config::is_strict_errors());
            if !should_use_local_fallback(strict_errors) {
                log::error!(
                    "sync catalog failed strict abort url='{}' reason={}",
                    safe_url,
                    crate::log_support::short_reason(&err)
                );
                return Err(err.into());
            }
            // 如果请求远程失败且为默认或远程链接，检测本地配置的 catalog.json 路径作为无缝备选
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
                let graduated = retire_graduated_drafts(&state, &items);
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
                    message: with_graduation_hint(
                        &format!(
                            "远程源未就绪，已自动从本地 {} 载入 {} 款应用（本地开发模式）",
                            candidate, count
                        ),
                        &graduated,
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
        let graduated = retire_graduated_drafts(&state, &items);
        // 目录已更新：收藏/关注收录标记就地回填，新收录行无需重启即纠正（最佳努力，不阻塞同步返回）。
        crate::commands::history::backfill_cataloged_flags(&state);
        log::info!(
            "sync catalog done url='{}' updated=true count={}",
            safe_url,
            count
        );
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

/// 远端失败是否允许本地降级：严格模式直接抛错。
pub(crate) fn should_use_local_fallback(strict_errors: bool) -> bool {
    !strict_errors
}

/// 转正退役（ADR-0017）：同步成功后以远端 id 集合命中未归档草稿，
/// 命中即 `archived=1`；失败吞错（best-effort，不阻塞同步主路径）。
/// 退役后重读本地收录 overlay，归档行即刻退出合并视图与收藏/关注收录态。
fn retire_graduated_drafts(
    state: &tauri::State<'_, AppState>,
    items: &[crate::github::models::CatalogItem],
) -> Vec<String> {
    let Ok(db) = state.db() else {
        return Vec::new();
    };
    let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let graduated: Vec<String> = db
        .retire_custom_apps_on_sync(&ids)
        .map(|notices| notices.into_iter().map(|n| n.id).collect())
        .unwrap_or_default();
    state.catalog.sync_collected_from_db(&db);
    graduated
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
        assert!(!should_use_local_fallback(true));
    }

    #[test]
    fn graceful_mode_uses_local_fallback() {
        assert!(should_use_local_fallback(false));
    }

    #[test]
    fn graduation_hint_appends_only_on_hits() {
        assert_eq!(
            super::with_graduation_hint("ok", &[]),
            "ok".to_string()
        );
        assert_eq!(
            super::with_graduation_hint("ok", &["o/r".to_string()]),
            "ok；1 款自维护草稿已转正并自动归档（o/r）".to_string()
        );
    }
}
