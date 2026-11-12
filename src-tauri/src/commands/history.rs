use crate::models::{AppSummary, FavoriteEntry, ImportUserDataResult, WatchedApp};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_favorites(state: State<'_, AppState>) -> crate::AppResult<Vec<String>> {
    let db = state.db()?;
    Ok(db.get_favorites()?)
}

/// 收藏条目（含收录标记）：与 `get_favorites` 同序，形状见 `FavoriteEntry`；
/// `get_favorites` 形状保持 `Vec<String>`（前端依赖此契约）。
#[tauri::command]
pub fn get_favorite_entries(state: State<'_, AppState>) -> crate::AppResult<Vec<FavoriteEntry>> {
    let db = state.db()?;
    Ok(db.get_favorite_entries()?)
}

/// 回填失败单行 warn：只记操作、行 id 与首行原因。
fn log_backfill_warn(op: &str, id: Option<&str>, reason: impl std::fmt::Display) {
    let reason = crate::log_support::short_reason(&reason.to_string());
    match id {
        Some(id) => log::warn!("{} id={} reason={}", op, id, reason),
        None => log::warn!("{} reason={}", op, reason),
    }
}

/// 收录标记全量回填（启动 + 清单同步完成后）：收藏/关注逐行按内存目录校准，零网络；
/// 最佳努力，不阻塞调用方（行级失败记 warn 日志，由下次启动/同步重试）。
pub(crate) fn backfill_cataloged_flags(state: &AppState) {
    let db = match state.db() {
        Ok(db) => db,
        Err(e) => {
            log_backfill_warn("backfill cataloged flags skipped", None, &e);
            return;
        }
    };
    match db.get_favorites() {
        Ok(ids) => {
            for id in &ids {
                if let Err(e) = db.set_favorite_cataloged(id, state.catalog.is_cataloged(id)) {
                    log_backfill_warn("backfill favorite flag failed", Some(id.as_str()), &e);
                }
            }
        }
        Err(e) => {
            log_backfill_warn("backfill favorites skipped", None, &e);
        }
    }
    match db.get_watched_apps() {
        Ok(watched) => {
            for w in &watched {
                if let Err(e) =
                    db.set_watched_cataloged(&w.app_id, state.catalog.is_cataloged(&w.app_id))
                {
                    log_backfill_warn("backfill watched flag failed", Some(w.app_id.as_str()), &e);
                }
            }
        }
        Err(e) => {
            log_backfill_warn("backfill watched skipped", None, &e);
        }
    }
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

#[tauri::command]
pub fn get_recently_viewed_apps(state: State<'_, AppState>) -> crate::AppResult<Vec<AppSummary>> {
    let db = state.db()?;
    let ids = db.get_recently_viewed_app_ids()?;
    let mut result = Vec::new();

    for id in ids {
        if let Some(item) = state.catalog.get_catalog_item(&id) {
            // 目录命中（远端精选或本地收录）：统一经目录盖章投影。
            let mut summary = state.catalog.item_to_stamped_summary(&item);
            // 最近浏览简介占位根治：收录行占位（理论上不应出现）同样回填/置空，
            // 非占位人工简介原样保留。
            heal_recent_summary(&db, &mut summary);
            // 详情换图标持久：收录分支同样 join app_icon_cycles 确认图标覆盖，
            // 与 catalog_search backfill 同语义（Some 才覆盖，None 保持静态）。
            apply_confirmed_icon(&db, &mut summary);
            result.push(summary);
            continue;
        }
        // 未收录：view_history 存全量 id，catalog 拼不出；回退 DB 详情缓存
        // （收录/未收录同走 save_detail_with_cycle_row 落全量 detail_json）；
        // 单条失败跳过不整单丢；仍无命中则跳过（不合成占位，避免污染过滤/计数，
        // 趋势 L2 仍是未收录首展来源）。
        if let Some(mut summary) = cached_detail_summary(&db, &id) {
            state.catalog.stamp_summary(&mut summary);
            result.push(summary);
        }
    }
    Ok(result)
}

/// 未收录近期行的 DB 详情回退：fallback 版查询（TTL 外/离线仍可显，stale 由前端离线徽标呈现），
/// 多键按序试：id 原值 → canonical → 小写 → 去 forge 前缀的 owner/repo（原值/小写）→
/// github.com/ 前缀（原值/小写）；db 层签名不动，此处只做键展开。
fn cached_detail_summary(db: &crate::db::Database, id: &str) -> Option<AppSummary> {
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
        if let Ok(Some(detail)) = db.get_cached_app_detail(&key, None) {
            let mut summary = detail_to_summary(&detail);
            // 最近浏览简介占位根治：占位回填 ETag repo 真值，无真值置空（前端走“暂无简介”）。
            heal_recent_summary(db, &mut summary);
            // 详情换图标持久：未收录分支 join app_icon_cycles 确认图标覆盖，
            // 与 catalog_search backfill 同语义（Some 才覆盖，None 保持 detail.icon）。
            apply_confirmed_icon(db, &mut summary);
            return Some(summary);
        }
    }
    None
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

/// 详情换图标在最近浏览持久（读侧 join）：`app_icon_cycles.selected_url` 确认图标覆盖
/// summary.icon，与 `catalog_search::backfill_uncataloged_card` 同语义（Some 才覆盖，
/// None 保持调用方原值，此处不二次判定）。
/// 收录/未收录双分支共用（catalog 静态 / detail.icon 均为旧值，需同等覆盖）。
fn apply_confirmed_icon(db: &crate::db::Database, summary: &mut AppSummary) {
    if let Some(ci) = crate::icons::resolve_confirmed_icon_from_db(
        db,
        &summary.core.id,
        &summary.core.owner,
        &summary.core.repo,
    ) {
        summary.core.icon = ci;
    }
}

/// 最近浏览简介占位后端根治：summary 占位简介回填 repo 真值，无真值置空。
/// - 占位判定复用 `detail_fetch::is_placeholder_description`（含空串与已知占位子串）；
/// - 真值来源为 SQLite ETag repo payload 同步读（不触网），命中非占位真值即回填；
/// - 无真值时占位转 `""`/`Some("")`，前端走“暂无简介”渲染而不显示占位文案；
///   `""` 仍被前端 `needDesc` 视为待治愈，可由富卡 enrich 快照二次治愈；
/// - 非占位（已收录人工简介等）原样保留。
fn heal_recent_summary(db: &crate::db::Database, summary: &mut AppSummary) {
    let need_desc =
        crate::github::detail_fetch::is_placeholder_description(&summary.core.description);
    let need_en = summary
        .core
        .description_en
        .as_deref()
        .map(crate::github::detail_fetch::is_placeholder_description)
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

#[tauri::command]
pub fn clear_view_history(state: State<'_, AppState>) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.clear_view_history()?)
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
    log::info!(
        "userdata import ok favorites={} watched={} settings={}",
        result.favorites_added,
        result.watched_added,
        result.settings_applied
    );
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
        db.save_cached_app_detail(
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
        db.save_cached_app_detail(
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
        db.save_cached_app_detail("demo/placeholder", &placeholder_detail("demo/placeholder"))
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
        db.save_cached_app_detail("demo/placeholder", &placeholder_detail("demo/placeholder"))
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
        db.save_cached_app_detail(
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
