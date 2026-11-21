use crate::models::{
    AppSummary, FavoriteEntry, ImportUserDataResult, WatchDismissedEntry, WatchUpdatedPayload,
    WatchedApp,
};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_favorites(state: State<'_, AppState>) -> crate::AppResult<Vec<String>> {
    let db = state.db()?;
    Ok(db.get_favorites()?)
}

/// 收藏条目列表（含收录标记），与 `get_favorites` 同序。
#[tauri::command]
pub fn get_favorite_entries(state: State<'_, AppState>) -> crate::AppResult<Vec<FavoriteEntry>> {
    let db = state.db()?;
    Ok(db.get_favorite_entries()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn toggle_favorite(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let app_id = super::require_app_id(&app_id)?;
    let flag = state.catalog.is_cataloged(&app_id);
    let db = state.db()?;
    Ok(db.toggle_favorite(&app_id, flag)?)
}

#[tauri::command]
pub fn record_search_query(state: State<'_, AppState>, query: String) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.record_search_query(&query)?)
}

#[tauri::command]
pub fn get_search_history(state: State<'_, AppState>) -> crate::AppResult<Vec<String>> {
    let db = state.db()?;
    Ok(db.get_search_history()?)
}

#[tauri::command]
pub fn clear_search_history(state: State<'_, AppState>) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.clear_search_history()?)
}

#[tauri::command]
pub fn remove_search_query(state: State<'_, AppState>, query: String) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.remove_search_query(&query)?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn record_app_view(state: State<'_, AppState>, app_id: String) -> crate::AppResult<()> {
    let app_id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.record_app_view(&app_id)?)
}

/// 前端「最近浏览」展示条的去重上限（给平台筛选留出余量）。
const RECENT_VIEW_DISPLAY_LIMIT: usize = 30;

/// 最近浏览响应条目：在 `AppSummary` 基础上透出最近一次浏览时间戳（供前端展示遮罩比较）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecentlyViewedApp {
    #[serde(flatten)]
    pub summary: AppSummary,
    pub viewed_at: i64,
}

/// 最近浏览：短锁内读浏览记录与本地详情并规划确认图标，释放锁后在阻塞线程池读图标文件并编码。
#[tauri::command]
pub async fn get_recently_viewed_apps(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<RecentlyViewedApp>> {
    let (mut result, jobs) = {
        let db = state.db()?;
        recently_viewed_deferred(&db, &state.catalog)?
    };
    crate::icons::resolve_and_patch_icons(
        &state,
        jobs,
        result.iter_mut().map(|r| Some(&mut r.summary.core)),
    )
    .await;
    Ok(result)
}

/// 最近浏览 DB 阶段：读取浏览记录并规划确认图标覆盖任务。
fn recently_viewed_deferred(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
) -> crate::AppResult<(Vec<RecentlyViewedApp>, Vec<crate::icons::DeferredIcon>)> {
    let entries = db.get_recently_viewed_entries(RECENT_VIEW_DISPLAY_LIMIT)?;
    let mut result = Vec::with_capacity(entries.len());
    let mut pendings = Vec::with_capacity(entries.len());
    for (id, viewed_at) in entries {
        let summary = if let Some(item) = catalog.get_catalog_item(&id) {
            let mut summary = catalog.item_to_stamped_summary(&item);
            // 对占位简介回填 ETag 真值或置空；人工简介保留。
            heal_recent_summary(db, &mut summary);
            summary
        } else if let Some(mut summary) = cached_detail_summary_without_icon(db, &id) {
            // 未收录行回退 DB 详情缓存并盖章；无缓存记录则跳过，避免合成占位。
            catalog.stamp_summary(&mut summary);
            summary
        } else {
            continue;
        };
        pendings.push(crate::icons::PendingIcon::confirmed(
            &summary.core.id,
            &summary.core.owner,
            &summary.core.repo,
        ));
        result.push(RecentlyViewedApp { summary, viewed_at });
    }
    Ok((result, crate::icons::plan_pending_icons(db, &pendings)))
}

/// 未收录近期行的 DB 详情回退（叠加确认图标，测试入口）。
#[cfg(test)]
fn cached_detail_summary(db: &crate::db::Database, id: &str) -> Option<AppSummary> {
    let mut summary = cached_detail_summary_without_icon(db, id)?;
    let jobs = crate::icons::plan_pending_icons(
        db,
        &[crate::icons::PendingIcon::confirmed(
            &summary.core.id,
            &summary.core.owner,
            &summary.core.repo,
        )],
    );
    let icons_dir = crate::get_app_data_dir().join("icons");
    let icons = crate::icons::materialize_icons_inline(db, &icons_dir, &jobs);
    crate::icons::patch_core_icons(std::iter::once(Some(&mut summary.core)), icons);
    Some(summary)
}

/// 未收录行的 DB 详情回退：按多种 id 形态顺序查缓存（离线仍可读）。
fn cached_detail_summary_without_icon(db: &crate::db::Database, id: &str) -> Option<AppSummary> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut keys: Vec<String> = Vec::new();
    let mut push_unique = |k: String| {
        if !k.trim().is_empty() && !keys.contains(&k) {
            keys.push(k);
        }
    };
    push_unique(trimmed.to_string());
    if let Some(canon) = crate::forge::canonical_app_id(trimmed) {
        push_unique(canon);
    }
    push_unique(trimmed.to_lowercase());
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(trimmed) {
        if !coord.owner.is_empty() && !coord.repo.is_empty() {
            let bare = format!("{}/{}", coord.owner, coord.repo);
            push_unique(bare.clone());
            push_unique(bare.to_lowercase());
            push_unique(format!("github.com/{}", bare));
            push_unique(format!("github.com/{}", bare.to_lowercase()));
        }
    }
    for key in keys {
        if let Ok(Some(detail)) = db.get_app_detail(&key, None) {
            let mut summary = detail_to_summary(&detail);
            heal_recent_summary(db, &mut summary);
            return Some(summary);
        }
    }
    // 无详情行：回退单仓富卡（列表里直接收藏/浏览过的未收录应用）。
    let clean_id = crate::forge::canonical_app_id(trimmed)?;
    crate::repositories::DetailRepository::repo_card_summary_without_icon(db, &clean_id)
}

/// AppDetail → AppSummary（字段与前端 AppSummary 对齐；`data:` 置空兜底）。
fn detail_to_summary(detail: &crate::models::AppDetail) -> AppSummary {
    let icon_trimmed = detail.core.icon.trim();
    let icon = if icon_trimmed.is_empty() || icon_trimmed.starts_with("data:") {
        String::new()
    } else {
        detail.core.icon.clone()
    };
    AppSummary {
        core: crate::models::AppCore {
            icon,
            ..detail.core.clone()
        },
    }
}

/// 将占位简介回填为 ETag 中的仓库真实简介；无真值时置空，非占位人工简介保留。
fn heal_recent_summary(db: &crate::db::Database, summary: &mut AppSummary) {
    let need_desc = crate::github::models::is_placeholder_description(&summary.core.description);
    let need_en = summary
        .core
        .description_en
        .as_deref()
        .map(crate::github::models::is_placeholder_description)
        .unwrap_or(false);
    if !need_desc && !need_en {
        return;
    }
    let real = crate::github::detail_fetch::repo_real_description_from_etag(
        db,
        &summary.core.owner,
        &summary.core.repo,
    );
    if need_desc {
        match real.clone() {
            Some(r) => summary.core.description = r,
            None => summary.core.description = String::new(),
        }
    }
    if need_en {
        match real {
            Some(r) => summary.core.description_en = Some(r),
            None => summary.core.description_en = Some(String::new()),
        }
    }
}

// ---------- 关注订阅 ----------

#[tauri::command(rename_all = "camelCase")]
pub fn watch_app(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let flag = state.catalog.is_cataloged(&id);
    let db = state.db()?;
    Ok(db.watch_app(&id, flag)?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn unwatch_app(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.unwatch_app(&id)?)
}

#[tauri::command]
pub fn get_watched_apps(state: State<'_, AppState>) -> crate::AppResult<Vec<WatchedApp>> {
    let db = state.db()?;
    Ok(db.get_watched_apps()?)
}

/// 待处理的关注提醒（持久化，重启后可读回）；实时提醒仍经 `zstore://watch-updated` 推送。
#[tauri::command]
pub fn get_watch_notifications(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<WatchUpdatedPayload>> {
    let db = state.db()?;
    Ok(db.get_pending_watch_notifications()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn dismiss_watch_notification(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.dismiss_watch_notification(&id)?)
}

/// 已确认的关注提醒，供规则管理列出与恢复。
#[tauri::command]
pub fn get_dismissed_watch_notifications(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<WatchDismissedEntry>> {
    let db = state.db()?;
    Ok(db.get_dismissed_watch_notifications()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_watch_notification(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.restore_watch_notification(&id)?)
}

/// 校验导出预设文件名（纯函数）：仅允许单层 `.json` 文件名，拒绝路径分隔符、父目录引用与空值。
fn validate_export_file_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err("导出文件名无效".to_string());
    }
    if !trimmed.ends_with(".json") {
        return Err("仅支持导出 .json 文件".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("导出文件名包含非法字符".to_string());
    }
    if trimmed.starts_with('.') || trimmed.contains("..") {
        return Err("导出文件名不能包含相对路径段".to_string());
    }
    Ok(trimmed.to_string())
}

fn write_export_json(out_path: &std::path::Path, content: &str) -> Result<String, String> {
    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(out_path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(out_path.to_string_lossy().to_string())
}

/// 弹出系统保存文件对话框（默认目录指向 `app_log_dir`，预填 `file_name`），
/// 用户确认后写入导出的 JSON（已安装应用列表 / 用户数据备份）并返回落盘绝对路径；取消时返回 `None`。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_backup_file(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
) -> crate::AppResult<Option<String>> {
    use tauri::Manager;
    let safe_name = validate_export_file_name(&file_name).map_err(crate::AppError::new)?;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| crate::AppError::new(e.to_string()))?;
    std::fs::create_dir_all(&log_dir).map_err(|e| crate::AppError::new(e.to_string()))?;

    let saved = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let picked = rfd::FileDialog::new()
            .set_directory(&log_dir)
            .set_file_name(&safe_name)
            .add_filter("JSON", &["json"])
            .save_file();
        let Some(out_path) = picked else {
            return Ok(None);
        };
        write_export_json(&out_path, &content).map(Some)
    })
    .await
    .map_err(|e| crate::AppError::new(e.to_string()))?
    .map_err(crate::AppError::new)?;

    Ok(saved)
}

// ---------- 手动跨设备同步（导入侧；导出由前端经 getters 组装） ----------

/// 合并式导入用户数据：只增不删；
/// 设置项仅接受白名单（主题/语言/缓存保鲜期/关注频率）。
#[tauri::command]
pub fn import_user_data(
    state: State<'_, AppState>,
    json: String,
) -> crate::AppResult<ImportUserDataResult> {
    let db = state.db()?;
    let result = crate::userdata::import_backup(&db, |id| state.catalog.is_cataloged(id), &json)?;
    if result.favorites_added > 0 || result.watched_added > 0 {
        crate::notify_affinity_updated();
    }
    let mut ev = crate::z_log::WideEvent::new("app", "userdata import ok");
    ev.field("favorites", result.favorites_added)
        .field("watched", result.watched_added)
        .field("settings", result.settings_applied);
    ev.info();
    Ok(result)
}

#[cfg(test)]
mod recent_uncataloged_tests {
    use crate::db::Database;
    use crate::models::{AppCore, AppDetail};

    fn uncataloged_detail(id: &str, icon: &str) -> AppDetail {
        AppDetail {
            core: AppCore {
                id: id.to_string(),
                name: "Oh My Pi".to_string(),
                description_en: Some("Raspberry Pi tool".to_string()),
                owner: "oh-my-pi".to_string(),
                repo: "oh-my-pi".to_string(),
                icon: icon.to_string(),
                icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                description: "树莓派工具".to_string(),
                stars: 123,
                forks: 45,
                license: "MIT".to_string(),
                latest_version: "v2.0.0".to_string(),
                is_verified: false,
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://example.com".to_string()),
                platforms: vec!["windows".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        }
    }

    #[test]
    fn test_uncataloged_detail_falls_back_to_summary() {
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail(
            "oh-my-pi/oh-my-pi",
            &uncataloged_detail("oh-my-pi/oh-my-pi", "https://example.com/icon.png"),
        )
        .unwrap();
        db.record_app_view("oh-my-pi/oh-my-pi").unwrap();
        let ids = db.get_recently_viewed_app_ids().unwrap();
        assert!(ids.contains(&"oh-my-pi/oh-my-pi".to_string()));
        let summary =
            super::cached_detail_summary(&db, "oh-my-pi/oh-my-pi").expect("未收录详情应当回退命中");
        assert_eq!(summary.core.id, "oh-my-pi/oh-my-pi");
        assert_eq!(summary.core.name, "Oh My Pi");
        assert_eq!(summary.core.icon, "https://example.com/icon.png");
        assert_eq!(summary.core.platforms, vec!["windows".to_string()]);
        assert_eq!(
            summary.core.homepage.as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn test_uncataloged_icon_and_case_alias_hit() {
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail(
            "oh-my-pi/oh-my-pi",
            &uncataloged_detail(
                "oh-my-pi/oh-my-pi",
                "https://avatars.githubusercontent.com/u/123?v=4",
            ),
        )
        .unwrap();
        // 大小写变体经回退键命中同一行
        let summary =
            super::cached_detail_summary(&db, "Oh-My-Pi/Oh-My-Pi").expect("大小写变体应当回退命中");
        assert_eq!(
            summary.core.icon,
            "https://avatars.githubusercontent.com/u/123?v=4",
        );
        assert_eq!(summary.core.owner, "oh-my-pi");
        // 无任何缓存的 id 直接跳过（不合成占位）
        assert!(super::cached_detail_summary(&db, "ghost/nobody").is_none());
    }

    fn placeholder_detail(id: &str) -> AppDetail {
        let mut d = uncataloged_detail(id, "https://example.com/icon.png");
        d.core.description = "GitHub 社区开源项目".to_string();
        d.core.description_en = Some("GitHub 社区开源项目".to_string());
        d
    }

    #[test]
    fn test_placeholder_summary_blanked_when_no_repo_real() {
        // 无 ETag repo 真值时，占位必须转空（前端走“暂无简介”而不显示占位文案）。
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail("demo/placeholder", &placeholder_detail("demo/placeholder"))
            .unwrap();
        let summary =
            super::cached_detail_summary(&db, "demo/placeholder").expect("占位详情应当回退命中");
        assert_eq!(summary.core.description, "", "占位中文简介应当置空");
        assert_eq!(
            summary.core.description_en.as_deref(),
            Some(""),
            "占位英文简介应当置空为 Some(\"\")（保留前端 enrich 治愈机会）"
        );
    }

    #[test]
    fn test_placeholder_summary_backfilled_from_etag_repo_real() {
        // ETag 有 repo 真值时，占位应当回填真值而非置空。
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail("demo/placeholder", &placeholder_detail("demo/placeholder"))
            .unwrap();
        db.save_etag(
            "https://api.github.com/repos/oh-my-pi/oh-my-pi",
            "etag-demo",
            r#"{"description": "Real repo description"}"#,
            crate::now_secs(),
        )
        .unwrap();
        // detail 行 owner/repo 为 oh-my-pi/oh-my-pi（见 uncataloged_detail），
        // id 键 demo/placeholder 经 fallback 命中同一行后按 owner/repo 查 ETag。
        let summary =
            super::cached_detail_summary(&db, "demo/placeholder").expect("占位详情应当回退命中");
        assert_eq!(summary.core.description, "Real repo description");
        assert_eq!(
            summary.core.description_en.as_deref(),
            Some("Real repo description")
        );
    }

    #[test]
    fn test_non_placeholder_description_preserved() {
        // 非占位人工简介不得被覆盖。
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail(
            "oh-my-pi/oh-my-pi",
            &uncataloged_detail("oh-my-pi/oh-my-pi", "https://example.com/icon.png"),
        )
        .unwrap();
        db.save_etag(
            "https://api.github.com/repos/oh-my-pi/oh-my-pi",
            "etag-demo",
            r#"{"description": "Real repo description"}"#,
            crate::now_secs(),
        )
        .unwrap();
        let summary =
            super::cached_detail_summary(&db, "oh-my-pi/oh-my-pi").expect("非占位详情应当回退命中");
        assert_eq!(
            summary.core.description, "树莓派工具",
            "人工简介优先，不覆盖"
        );
        assert_eq!(
            summary.core.description_en.as_deref(),
            Some("Raspberry Pi tool")
        );
    }
}

#[cfg(test)]
mod export_file_tests {
    use super::{validate_export_file_name, write_export_json};

    #[test]
    fn accepts_valid_json_file_names() {
        assert_eq!(
            validate_export_file_name("z-store-backup-20261113-120000.json").unwrap(),
            "z-store-backup-20261113-120000.json"
        );
        assert_eq!(
            validate_export_file_name("zstore-installed-backup-20261113-120000.json").unwrap(),
            "zstore-installed-backup-20261113-120000.json"
        );
    }

    #[test]
    fn write_export_json_creates_parent_and_writes_payload() {
        let dir = std::env::temp_dir().join(format!(
            "zstore-export-test-{}-{}",
            std::process::id(),
            crate::now_secs()
        ));
        let target = dir.join("nested").join("backup.json");
        let saved = write_export_json(&target, "{\"version\":1}").unwrap();
        assert_eq!(saved, target.to_string_lossy());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"version\":1}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_traversal_separators_and_non_json() {
        for bad in [
            "",
            "   ",
            "../secret.json",
            "sub/file.json",
            "sub\\file.json",
            ".hidden.json",
            "a..b.json",
            "backup.txt",
            "backup.json.exe",
        ] {
            assert!(
                validate_export_file_name(bad).is_err(),
                "should reject invalid export filename: {:?}",
                bad
            );
        }
    }
}
