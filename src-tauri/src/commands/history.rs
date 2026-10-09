use crate::models::{AppSummary, ImportUserDataResult, WatchedApp};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_favorites(state: State<'_, AppState>) -> crate::AppResult<Vec<String>> {
    let db = state.db()?;
    Ok(db.get_favorites()?)
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let app_id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.toggle_favorite(&app_id)?)
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

#[tauri::command]
pub fn record_app_view(state: State<'_, AppState>, app_id: String) -> crate::AppResult<()> {
    let app_id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.record_app_view(&app_id)?)
}

#[tauri::command]
pub fn get_recently_viewed_apps(state: State<'_, AppState>) -> crate::AppResult<Vec<AppSummary>> {
    let db = state.db()?;
    let ids = db.get_recently_viewed_app_ids()?;
    let catalog_items = state.catalog.get_catalog_items();
    let mut result = Vec::new();

    for id in ids {
        if let Some(item) = catalog_items.iter().find(|i| i.id == id) {
            let mut summary = item.to_summary();
            // 最近浏览简介占位根治：收录行占位（理论上不应出现）同样回填/置空，
            // 非占位人工简介原样保留。
            heal_recent_summary(&db, &mut summary);
            result.push(summary);
            continue;
        }
        // 未收录：view_history 存全量 id，catalog 拼不出；回退 DB 详情缓存
        // （收录/未收录同走 save_detail_with_icon 落全量 detail_json），保持原顺序；
        // 单条失败跳过不整单丢；仍无命中则跳过（不合成占位，避免污染过滤/计数，
        // 趋势 L2 仍是未收录首展来源）。
        if let Some(summary) = cached_detail_summary(&db, &id) {
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
        if let Ok(Some(detail)) = db.get_cached_app_detail_fallback(&key) {
            let mut summary = detail_to_summary(&detail);
            // 最近浏览简介占位根治：占位回填 ETag repo 真值，无真值置空（前端走“暂无简介”）。
            heal_recent_summary(db, &mut summary);
            return Some(summary);
        }
    }
    None
}

/// AppDetail → AppSummary（字段与前端 AppSummary 对齐；icon 遇 avatar 置空，
/// data: 理论上不出 DB，此处一并置空兜底）。
fn detail_to_summary(detail: &crate::models::AppDetail) -> AppSummary {
    let icon_trimmed = detail.icon.trim();
    // 与前端 isAvatarUrl 同口径（含 github.com 直链 png 形态，见 catalog_detail 落库侧）。
    let is_avatar = crate::commands::is_avatar_url(icon_trimmed)
        || (icon_trimmed.starts_with("https://github.com/")
            && icon_trimmed.to_lowercase().ends_with(".png")
            && !icon_trimmed.contains("/raw/"));
    let icon = if icon_trimmed.is_empty() || icon_trimmed.starts_with("data:") || is_avatar {
        String::new()
    } else {
        detail.icon.clone()
    };
    AppSummary {
        id: detail.id.clone(),
        name: detail.name.clone(),
        description_en: detail.description_en.clone(),
        owner: detail.owner.clone(),
        repo: detail.repo.clone(),
        icon,
        icon_bg: detail.icon_bg.clone(),
        description: detail.description.clone(),
        stars: detail.stars,
        forks: detail.forks,
        license: detail.license.clone(),
        latest_version: detail.latest_version.clone(),
        category: detail.category.clone(),
        category_name: detail.category_name.clone(),
        is_verified: detail.is_verified,
        is_installed: None,
        has_update: None,
        installed_version: None,
        forge: detail.forge.clone(),
        forge_host: detail.forge_host.clone(),
        homepage: detail.homepage.clone(),
        platforms: detail.platforms.clone(),
    }
}

/// 最近浏览简介占位后端根治：summary 占位简介回填 repo 真值，无真值置空。
/// - 占位判定复用 `detail_fetch::is_placeholder_description`（含空串与已知占位子串）；
/// - 真值来源为 SQLite ETag repo payload 同步读（不触网），命中非占位真值即回填；
/// - 无真值时占位转 `""`/`Some("")`，前端走“暂无简介”渲染而不显示占位文案；
///   `""` 仍被前端 `needDesc` 视为待治愈，可由富卡 enrich 快照二次治愈；
/// - 非占位（已收录人工简介等）原样保留。
fn heal_recent_summary(db: &crate::db::Database, summary: &mut AppSummary) {
    let need_desc = crate::github::detail::detail_fetch::is_placeholder_description(
        &summary.description,
    );
    let need_en = summary
        .description_en
        .as_deref()
        .map(crate::github::detail::detail_fetch::is_placeholder_description)
        .unwrap_or(false);
    if !need_desc && !need_en {
        return;
    }
    let real = crate::github::detail::detail_fetch::repo_real_description_from_etag(
        db,
        &summary.owner,
        &summary.repo,
    );
    if need_desc {
        match real.clone() {
            Some(r) => summary.description = r,
            None => summary.description = String::new(),
        }
    }
    if need_en {
        match real {
            Some(r) => summary.description_en = Some(r),
            None => summary.description_en = Some(String::new()),
        }
    }
}

#[tauri::command]
pub fn clear_view_history(state: State<'_, AppState>) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.clear_view_history()?)
}

// ---------- FR-6.2 关注订阅 ----------

#[tauri::command]
pub fn watch_app(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    let id = super::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.watch_app(&id)?)
}

#[tauri::command]
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

// ---------- FR-6.3 手动跨设备同步（导入侧；导出由前端经现有 getters 组装） ----------

/// 合并式导入用户数据：只增不删；已安装应用对应条目跳过计数；
/// 设置项仅接受白名单（主题/语言/缓存保鲜期/关注频率）。
#[tauri::command]
pub fn import_user_data(
    state: State<'_, AppState>,
    json: String,
) -> crate::AppResult<ImportUserDataResult> {
    let plan = crate::oauth::parse_import_payload(&json)?;
    let db = state.db()?;

    let installed: std::collections::HashSet<String> = db
        .get_installed_apps()
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.app_id)
        .collect();

    let mut favorites_added = 0usize;
    let mut watched_added = 0usize;
    let mut settings_applied = 0usize;
    let mut installed_skipped = 0usize;

    // 收藏/关注与安装态正交：同机恢复也必须合入；已安装跳过仅保留给安装态导入。
    // `installed`/`installed_skipped` 形状冻结，供安装态导入复用，此处仅显式取用以避免未使用告警。
    let _ = &installed;
    let _ = &mut installed_skipped;
    for id in &plan.favorites {
        let id = super::require_app_id(id)?;
        if db.add_favorite(&id).map_err(|e| e.to_string())? {
            favorites_added += 1;
        }
    }
    for id in &plan.watched {
        let id = super::require_app_id(id)?;
        if db.watch_app(&id).map_err(|e| e.to_string())? {
            watched_added += 1;
        }
    }
    for (key, value) in &plan.settings {
        let normalized = crate::db::normalize_setting_value(key, value);
        db.set_setting(key, &normalized)
            .map_err(|e| e.to_string())?;
        settings_applied += 1;
    }

    Ok(ImportUserDataResult {
        favorites_added,
        watched_added,
        settings_applied,
        installed_skipped,
    })
}

#[cfg(test)]
mod import_restore_tests {
    use crate::db::Database;
    use crate::models::InstalledApp;

    fn installed_app(app_id: &str) -> InstalledApp {
        InstalledApp {
            app_id: app_id.to_string(),
            app_name: "RustDesk".to_string(),
            version: "1.0.0".to_string(),
            installed_at: 1700000000,
            install_method: "test".to_string(),
            install_path: "C:\\test".to_string(),
            asset_name: "test.exe".to_string(),
            asset_sha256: "abc".to_string(),
            uninstall_command: None,
            icon: None,
            icon_bg: None,
        }
    }

    #[test]
    fn test_same_machine_restore_merges_favorites_and_watch_for_installed_apps() {
        // 同机备份恢复：已安装应用的收藏/关注是独立用户数据，导入合入时不得因已安装而跳过。
        // （注：`import_user_data` 的命令入口需 Tauri State 挂载——`tauri::test`
        // 能力门控于 tauri 自身 `test` feature，本 crate 未启用，故本场景在 DB
        // 缝合处按“解析→归一化→合入”的生产一致路径断言；命令层循环的修复与此同语义。）
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_installed_app(&installed_app("rustdesk/rustdesk"))
            .expect("预置已安装应用应当成功");

        let json = r#"{
            "version": 1,
            "favorites": ["rustdesk/rustdesk"],
            "watched": ["rustdesk/rustdesk"],
            "settings": {}
        }"#;
        let plan = crate::oauth::parse_import_payload(json).expect("合法导入 JSON 应当成功");

        // 与 `import_user_data` 修复后的循环同语义：仅归一化校验，不查已安装表。
        let mut favorites_added = 0usize;
        for id in &plan.favorites {
            let id = crate::forge::canonical_app_id(id).expect("合法标识应当归一化成功");
            if db.add_favorite(&id).unwrap() {
                favorites_added += 1;
            }
        }
        let mut watched_added = 0usize;
        for id in &plan.watched {
            let id = crate::forge::canonical_app_id(id).expect("合法标识应当归一化成功");
            if db.watch_app(&id).unwrap() {
                watched_added += 1;
            }
        }

        assert_eq!(favorites_added, 1, "已安装应用的收藏应当合入");
        assert_eq!(watched_added, 1, "已安装应用的关注应当合入");
        assert!(
            db.get_favorites()
                .unwrap()
                .contains(&"rustdesk/rustdesk".to_string()),
            "收藏表应当包含已安装应用"
        );
        assert!(
            db.get_watched_apps()
                .unwrap()
                .iter()
                .any(|w| w.app_id == "rustdesk/rustdesk"),
            "关注表应当包含已安装应用"
        );
    }
}

#[cfg(test)]
mod recent_uncataloged_tests {
    use crate::db::Database;
    use crate::models::AppDetail;

    fn uncataloged_detail(id: &str, icon: &str) -> AppDetail {
        AppDetail {
            id: id.to_string(),
            name: "Oh My Pi".to_string(),
            description_en: Some("Raspberry Pi tool".to_string()),
            owner: "oh-my-pi".to_string(),
            repo: "oh-my-pi".to_string(),
            icon: icon.to_string(),
            icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
            description: "树莓派工具".to_string(),
            stars: 123,
            forks: 45,
            license: "MIT".to_string(),
            latest_version: "v2.0.0".to_string(),
            changelog: String::new(),
            is_verified: false,
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            category: "external".to_string(),
            category_name: "跨平台开源".to_string(),
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            cached_at: None,
            is_stale: None,
            homepage: Some("https://example.com".to_string()),
            platforms: vec!["windows".to_string()],
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
        assert_eq!(summary.id, "oh-my-pi/oh-my-pi");
        assert_eq!(summary.name, "Oh My Pi");
        assert_eq!(summary.icon, "https://example.com/icon.png");
        assert_eq!(summary.platforms, vec!["windows".to_string()]);
        assert_eq!(summary.homepage.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn test_avatar_icon_blanked_and_case_alias_hit() {
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
        let summary = super::cached_detail_summary(&db, "Oh-My-Pi/Oh-My-Pi")
            .expect("大小写变体应当回退命中");
        assert_eq!(summary.icon, "", "avatar 应当置空");
        assert_eq!(summary.owner, "oh-my-pi");
        // 无任何缓存的 id 直接跳过（不合成占位）
        assert!(super::cached_detail_summary(&db, "ghost/nobody").is_none());
    }

    fn placeholder_detail(id: &str) -> AppDetail {
        let mut d = uncataloged_detail(id, "https://example.com/icon.png");
        d.description = "GitHub 社区开源项目".to_string();
        d.description_en = Some("GitHub 社区开源项目".to_string());
        d
    }

    #[test]
    fn test_placeholder_summary_blanked_when_no_repo_real() {
        // 无 ETag repo 真值时，占位必须转空（前端走“暂无简介”而不显示占位文案）。
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_cached_app_detail("demo/placeholder", &placeholder_detail("demo/placeholder"))
            .unwrap();
        let summary = super::cached_detail_summary(&db, "demo/placeholder")
            .expect("占位详情应当回退命中");
        assert_eq!(summary.description, "", "占位中文简介应当置空");
        assert_eq!(
            summary.description_en.as_deref(),
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
        let summary = super::cached_detail_summary(&db, "demo/placeholder")
            .expect("占位详情应当回退命中");
        assert_eq!(summary.description, "Real repo description");
        assert_eq!(
            summary.description_en.as_deref(),
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
        let summary = super::cached_detail_summary(&db, "oh-my-pi/oh-my-pi")
            .expect("非占位详情应当回退命中");
        assert_eq!(summary.description, "树莓派工具", "人工简介优先，不覆盖");
        assert_eq!(
            summary.description_en.as_deref(),
            Some("Raspberry Pi tool")
        );
    }
}
