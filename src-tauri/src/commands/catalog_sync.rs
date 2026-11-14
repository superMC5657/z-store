use crate::models::SyncCatalogResult;
use crate::AppState;
use tauri::State;

/// 每日自动同步边界小时（UTC）：06:00 UTC，对应北京时间（UTC+8）每天下午 14:00。
/// 上游 `Refresh Catalog Baseline` Action 于 `00:00 UTC`（北京时间 08:00）触发，
/// 即使遇 GitHub 整点队列延迟到中午 12 点后完成，14:00 切日仍可稳定拉到当日新清单。
pub const CATALOG_SYNC_RESET_UTC_HOUR: u8 = 6;
/// 设置项键：最近一次成功核验/同步远端收录清单的同步日标识（`YYYY-MM-DD`，按北京时间 14:00 / 06:00 UTC 切日）。
pub const SETTING_CATALOG_LAST_SYNCED_DAY: &str = "catalog_last_synced_day";
/// 设置项键：最近一次成功核验/同步的清单源 URL（切换源后立即允许新源首次同步）。
pub const SETTING_CATALOG_LAST_SYNCED_URL: &str = "catalog_last_synced_url";

fn utc_now() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

/// 计算指定时间所属的同步周期日（`YYYY-MM-DD`，以 06:00 UTC / 北京时间下午 14:00 切日）。
pub(crate) fn catalog_sync_cycle_day(now: time::OffsetDateTime) -> String {
    let utc = now.to_offset(time::UtcOffset::UTC);
    let date = if utc.hour() < CATALOG_SYNC_RESET_UTC_HOUR {
        utc.date().previous_day().unwrap_or_else(|| utc.date())
    } else {
        utc.date()
    };
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// 判断是否应执行启动后台自动同步：
/// 首次未同步、周期标识无效、清单源变更或已跨过北京时间下午 14:00（06:00 UTC）进入新周期日均放行。
pub(crate) fn should_auto_sync_catalog(
    last_synced_day: Option<&str>,
    last_synced_url: Option<&str>,
    current_url: &str,
    current_cycle_day: &str,
) -> bool {
    if last_synced_url.map(str::trim) != Some(current_url.trim()) {
        return true;
    }
    match last_synced_day.map(str::trim).filter(|s| !s.is_empty()) {
        None => true,
        Some(prev) => prev != current_cycle_day,
    }
}

fn should_skip_daily_auto_sync(
    db: &crate::db::Database,
    url: &str,
    current_cycle_day: &str,
) -> bool {
    // 若目录主表异常为空，不跳过自动同步，确保能尽快恢复远端清单。
    if db.count_catalog_apps().map(|c| c == 0).unwrap_or(true) {
        return false;
    }
    let last_day = db
        .get_setting(SETTING_CATALOG_LAST_SYNCED_DAY)
        .ok()
        .flatten();
    let last_url = db
        .get_setting(SETTING_CATALOG_LAST_SYNCED_URL)
        .ok()
        .flatten();
    !should_auto_sync_catalog(
        last_day.as_deref(),
        last_url.as_deref(),
        url,
        current_cycle_day,
    )
}

fn record_catalog_sync_cycle(db: &crate::db::Database, url: &str, cycle_day: &str) {
    let _ = db.set_setting(SETTING_CATALOG_LAST_SYNCED_DAY, cycle_day);
    let _ = db.set_setting(SETTING_CATALOG_LAST_SYNCED_URL, url.trim());
}

/// 收录清单同步：
/// - `force=Some(true)`（设置页手动同步）：跳过冷却与 ETag 复用，立即强制拉取远端；
/// - `force=None/Some(false)`（启动后台同步）：按北京时间下午 14:00（06:00 UTC）为界“每天一次”检查，本周期已同步直接跳过网络，跨边界后走 ETag 304 条件请求。
#[tauri::command]
pub async fn sync_catalog(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> crate::AppResult<SyncCatalogResult> {
    // 串行化清单同步：避免启动静默同步与设置页手动同步并发交叉写库或乱序覆盖 ETag。
    let _sync_guard = state.sync_lock.lock().await;
    let start = std::time::Instant::now();
    let is_force = force.unwrap_or(false);
    let cycle_day = catalog_sync_cycle_day(utc_now());
    let (url, cached_etag, skip_daily) = {
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
        let skip = !is_force && should_skip_daily_auto_sync(&db, &url, &cycle_day);
        let etag = if is_force || skip {
            None
        } else {
            db.get_etag(&url).ok().flatten()
        };
        (url, etag, skip)
    };

    let is_default_src = crate::github::catalog_service::is_default_catalog_source(&url);
    let source_kind = if is_default_src { "default" } else { "custom" };

    if skip_daily {
        let count = state.catalog.get_catalog_count();
        let mut ev = crate::z_log::WideEvent::new("catalog", "sync skipped").with_started(start);
        ev.field("source", source_kind)
            .field("updated", false)
            .field("count", count)
            .field("reason", "daily_cooldown")
            .dev_url("url", &url);
        ev.info();
        return Ok(SyncCatalogResult {
            updated: false,
            count,
            message: format!("收录清单今日已同步，共 {} 个应用", count),
        });
    }

    // 官方默认源首跳失败时的镜像回退前缀：用户自定义镜像优先，否则公共 gh-proxy。
    let mirror_prefix = is_default_src.then(|| {
        state
            .mirror
            .lock()
            .ok()
            .and_then(|m| m.active_mirror_prefix())
            .unwrap_or_else(|| crate::mirror::DEFAULT_GH_PROXY.to_string())
    });
    let res = state
        .catalog
        .fetch_remote_catalog_with_fallback(&url, cached_etag.as_deref(), mirror_prefix.as_deref())
        .await;

    let (new_items, new_etag, via) = match res {
        Ok(f) => (f.items, f.etag, f.via),
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
        let sync_ts = crate::now_secs();
        let etag_entry = new_etag.as_deref().map(|et| (url.as_str(), et, sync_ts));
        // ETag 与目录写入同一事务提交：只有 catalog_apps 成功落库后才保存新 ETag 并刷新内存索引。
        let graduated = apply_manifest_to_db(&state, &items, etag_entry)?;
        if let Ok(db) = state.db() {
            record_catalog_sync_cycle(&db, &url, &cycle_day);
        }
        let mut ev = crate::z_log::WideEvent::new("catalog", "sync ok").with_started(start);
        ev.field("source", source_kind)
            .field("via", via)
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
        if let Ok(db) = state.db() {
            record_catalog_sync_cycle(&db, &url, &cycle_day);
        }
        let count = state.catalog.get_catalog_count();
        let mut ev =
            crate::z_log::WideEvent::new("catalog", "sync unchanged").with_started(start);
        ev.field("source", source_kind)
            .field("updated", false)
            .field("count", count)
            .field("via", via)
            .dev("status", 304)
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
    // 新转正的仓库改由精选目录承接，清除其单仓富卡旧行。
    let _ = db.purge_cataloged_repo_cards();
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

    #[test]
    fn catalog_sync_cycle_day_splits_at_14_00_beijing_time() {
        use time::macros::datetime;

        // 北京时间 13:59:59（05:59:59 UTC）仍归属前一日周期
        let before_1400 = datetime!(2026-11-13 13:59:59 +08:00);
        assert_eq!(super::catalog_sync_cycle_day(before_1400), "2026-11-12");

        // 北京时间 14:00:00（06:00:00 UTC）切入当日新周期
        let at_1400 = datetime!(2026-11-13 14:00:00 +08:00);
        assert_eq!(super::catalog_sync_cycle_day(at_1400), "2026-11-13");

        // 北京时间凌晨 01:30（前一日 17:30 UTC）仍归属前一日（2026-11-12）周期
        let night_after_midnight = datetime!(2026-11-13 01:30:00 +08:00);
        assert_eq!(
            super::catalog_sync_cycle_day(night_after_midnight),
            "2026-11-12"
        );

        // 跨年边界：北京时间 2027-01-01 09:00（01:00 UTC < 06:00 UTC）归属 2026-12-31
        let new_year_morning = datetime!(2027-01-01 09:00:00 +08:00);
        assert_eq!(super::catalog_sync_cycle_day(new_year_morning), "2026-12-31");
    }

    #[test]
    fn daily_cycle_predicate_covers_first_same_cycle_post_reset_and_source_switch() {
        let url = "https://example.com/catalog.json";

        // 首次从未同步 → 放行
        assert!(super::should_auto_sync_catalog(
            None,
            None,
            url,
            "2026-11-12"
        ));
        // 空周期字符串 → 放行
        assert!(super::should_auto_sync_catalog(
            Some(""),
            Some(url),
            url,
            "2026-11-12"
        ));
        // 同源同同步周期（如昨天 15:00 与今天 10:00 同为 2026-11-12）→ 跳过
        assert!(!super::should_auto_sync_catalog(
            Some("2026-11-12"),
            Some(url),
            url,
            "2026-11-12"
        ));
        // 跨过北京时间 14:00 进入新周期（2026-11-13）→ 放行
        assert!(super::should_auto_sync_catalog(
            Some("2026-11-12"),
            Some(url),
            url,
            "2026-11-13"
        ));
        // 切换清单源即使在同一周期内 → 放行
        assert!(super::should_auto_sync_catalog(
            Some("2026-11-12"),
            Some(url),
            "https://mirror.example.com/catalog.json",
            "2026-11-12"
        ));
    }

    #[test]
    fn db_daily_sync_cycle_roundtrip_blocks_same_cycle_allows_next_day_and_empty_db() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let url = "https://example.com/catalog.json";

        // 未播种且未同步 → 不跳过
        assert!(!super::should_skip_daily_auto_sync(&db, url, "2026-11-12"));

        // 即便记录了本周期日，若 catalog_apps 异常为空仍应放行同步兜底
        super::record_catalog_sync_cycle(&db, url, "2026-11-12");
        assert!(!super::should_skip_daily_auto_sync(&db, url, "2026-11-12"));

        // 有目录数据时，同周期日跳过，进入下一周期或切源均放行
        let sample = crate::github::CatalogItem {
            id: "o/r".to_string(),
            name: "r".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: "desc".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 1,
            forks: 0,
            is_verified: true,
            homepage: None,
            platforms: vec![],
            identifiers: std::collections::HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        };
        db.seed_catalog_apps_if_empty(&[sample]).unwrap();
        assert!(super::should_skip_daily_auto_sync(&db, url, "2026-11-12"));
        assert!(!super::should_skip_daily_auto_sync(&db, url, "2026-11-13"));
        assert!(!super::should_skip_daily_auto_sync(
            &db,
            "https://other.example.com/catalog.json",
            "2026-11-12"
        ));
    }
}
