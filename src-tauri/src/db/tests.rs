use super::*;
use crate::models::AppDetail;

pub mod fixtures {
    use crate::db::Database;
    use crate::models::InstalledApp;

    pub fn test_db() -> Database {
        Database::open_in_memory().unwrap()
    }

    pub fn sample_app() -> InstalledApp {
        InstalledApp {
            app_id: "rustdesk".to_string(),
            app_name: "RustDesk".to_string(),
            version: "v1.2.6".to_string(),
            installed_at: 1700000000,
            install_method: "msi".to_string(),
            install_path: "C:\\Program Files\\RustDesk".to_string(),
            asset_name: "rustdesk-1.2.6.msi".to_string(),
            asset_sha256: "abcdef1234567890".to_string(),
            uninstall_command: Some("msiexec /x".to_string()),
            icon: None,
            icon_bg: None,
        }
    }
}

#[test]
fn test_installed_apps_crud() {
    let db = fixtures::test_db();
    let app = fixtures::sample_app();

    db.save_installed_app(&app).unwrap();
    let apps = db.get_installed_apps().unwrap();
    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0].app_id, "rustdesk");

    let removed = db.remove_installed_app("rustdesk").unwrap();
    assert!(removed);
    let apps_after = db.get_installed_apps().unwrap();
    assert_eq!(apps_after.len(), 0);
}

#[test]
fn test_etag_cache() {
    let db = fixtures::test_db();
    let ep = "https://api.github.com/repos/rustdesk/rustdesk/releases/latest";
    db.save_etag(ep, "W/\"123456\"", "{\"tag_name\":\"v1.2.6\"}", 1700000000)
        .unwrap();

    let etag = db.get_etag(ep).unwrap();
    assert_eq!(etag, Some("W/\"123456\"".to_string()));

    let payload = db.get_cached_payload(ep).unwrap();
    assert!(payload.is_some());

    // 测试更新 ETag
    db.save_etag(ep, "W/\"654321\"", "{\"tag_name\":\"v1.2.7\"}", 1700000100)
        .unwrap();
    assert_eq!(db.get_etag(ep).unwrap(), Some("W/\"654321\"".to_string()));
}

#[test]
fn test_settings_and_favorites() {
    let db = fixtures::test_db();
    db.set_setting("theme", "dark").unwrap();
    assert_eq!(db.get_setting("theme").unwrap(), Some("dark".to_string()));

    let fav_added = db.toggle_favorite("rustdesk", true).unwrap();
    assert!(fav_added);
    assert_eq!(db.get_favorites().unwrap(), vec!["rustdesk".to_string()]);
    let entries = db.get_favorite_entries().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].app_id, "rustdesk");
    assert!(entries[0].is_cataloged);

    // 回填写点仅更新标记，不碰时间戳/行身份
    db.set_favorite_cataloged("rustdesk", false).unwrap();
    let entries = db.get_favorite_entries().unwrap();
    assert!(!entries[0].is_cataloged);
    assert_eq!(db.get_favorites().unwrap(), vec!["rustdesk".to_string()]);

    let fav_removed = db.toggle_favorite("rustdesk", true).unwrap();
    assert!(!fav_removed);
    assert_eq!(db.get_favorites().unwrap().len(), 0);
}

#[test]
fn test_update_rules_crud() {
    let db = fixtures::test_db();

    // 1. 初始状态：无规则
    assert!(db.get_rule("rustdesk").unwrap().is_none());
    assert_eq!(db.get_all_rules().unwrap().len(), 0);

    // 2. 设置跳过版本
    db.set_skip_version("rustdesk", Some("v1.3.0")).unwrap();
    let rule = db.get_rule("rustdesk").unwrap().expect("rule exists");
    assert_eq!(rule.app_id, "rustdesk");
    assert_eq!(rule.skipped_version.as_deref(), Some("v1.3.0"));
    assert!(!rule.is_frozen);
    assert!(!rule.is_hidden);

    // 3. 锁定版本
    db.set_frozen_status("rustdesk", true).unwrap();
    let rule = db.get_rule("rustdesk").unwrap().unwrap();
    assert!(rule.is_frozen);
    assert_eq!(rule.skipped_version.as_deref(), Some("v1.3.0"));

    // 4. 隐藏状态
    db.set_hidden_status("rustdesk", true).unwrap();
    let rule = db.get_rule("rustdesk").unwrap().unwrap();
    assert!(rule.is_hidden);

    // 5. 添加第二款应用的规则
    db.set_skip_version("localsend", Some("v1.14.1")).unwrap();
    let all = db.get_all_rules().unwrap();
    assert_eq!(all.len(), 2);

    // 6. 解锁与取消隐藏
    db.set_frozen_status("rustdesk", false).unwrap();
    db.set_hidden_status("rustdesk", false).unwrap();
    let rule = db.get_rule("rustdesk").unwrap().unwrap();
    assert!(!rule.is_frozen);
    assert!(!rule.is_hidden);

    // 7. 移除规则
    let removed = db.remove_rule("rustdesk").unwrap();
    assert!(removed);
    assert!(db.get_rule("rustdesk").unwrap().is_none());
    assert_eq!(db.get_all_rules().unwrap().len(), 1);
}

#[test]
fn test_search_and_view_history_crud() {
    let db = fixtures::test_db();

    // 1. 搜索历史
    db.record_search_query("rustdesk").unwrap();
    db.record_search_query("localsend").unwrap();
    db.record_search_query("rustdesk").unwrap(); // 插入或更新（应当移至顶部）

    let queries = db.get_search_history().unwrap();
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[0], "rustdesk");
    assert_eq!(queries[1], "localsend");

    db.remove_search_query("localsend").unwrap();
    let queries_after = db.get_search_history().unwrap();
    assert_eq!(queries_after.len(), 1);
    assert_eq!(queries_after[0], "rustdesk");

    db.clear_search_history().unwrap();
    assert!(db.get_search_history().unwrap().is_empty());

    // 2. 浏览历史
    db.record_app_view("rustdesk").unwrap();
    db.record_app_view("vlc").unwrap();
    db.record_app_view("rustdesk").unwrap(); // 插入或更新至顶部

    let app_ids = db.get_recently_viewed_app_ids().unwrap();
    assert_eq!(app_ids.len(), 2);
    assert_eq!(app_ids[0], "rustdesk");
    assert_eq!(app_ids[1], "vlc");

    db.clear_view_history().unwrap();
    assert!(db.get_recently_viewed_app_ids().unwrap().is_empty());
}

#[test]
fn test_host_tokens_crud() {
    let db = fixtures::test_db();

    // 1. 初始状态为空
    let tokens = db.get_host_tokens().unwrap();
    assert!(tokens.is_empty());

    // 2. 设置令牌
    db.set_host_token("codeberg.org", "cb_token_123").unwrap();
    db.set_host_token("github.com", "gh_token_456").unwrap();

    let tokens = db.get_host_tokens().unwrap();
    assert_eq!(tokens.len(), 2);
    assert_eq!(
        db.get_host_token("codeberg.org").unwrap().as_deref(),
        Some("cb_token_123")
    );
    assert_eq!(
        db.get_host_token("github.com").unwrap().as_deref(),
        Some("gh_token_456")
    );

    // 3. 更新速率限制
    db.update_host_rate_limit("codeberg.org", Some(2990), Some(3000), Some(1700000000))
        .unwrap();
    let tokens_after = db.get_host_tokens().unwrap();
    let cb = tokens_after
        .iter()
        .find(|t| t.host == "codeberg.org")
        .unwrap();
    assert_eq!(cb.rate_limit_remaining, Some(2990));

    // 4. 移除令牌
    let removed = db.remove_host_token("codeberg.org").unwrap();
    assert!(removed);
    assert!(db.get_host_token("codeberg.org").unwrap().is_none());
    assert_eq!(db.get_host_tokens().unwrap().len(), 1);

    // 5. 在未配置前置令牌的情况下更新速率限制（匿名/公开主机记录）
    db.update_host_rate_limit("gitea.com", Some(55), Some(60), Some(1700000100))
        .unwrap();
    let tokens_new = db.get_host_tokens().unwrap();
    assert_eq!(tokens_new.len(), 2);
    let gitea = tokens_new.iter().find(|t| t.host == "gitea.com").unwrap();
    assert_eq!(gitea.rate_limit_remaining, Some(55));
    assert_eq!(gitea.rate_limit_limit, Some(60));
    assert!(db.get_host_token("gitea.com").unwrap().is_none());
}

#[test]
fn test_app_details_cache_crud() {
    let db = fixtures::test_db();
    db.clear_app_details_cache().unwrap();

    // 1. 初始状态：为空
    assert!(db
        .get_cached_app_detail("rustdesk", None)
        .unwrap()
        .is_none());
    assert!(db
        .get_cached_app_detail("github.com/rustdesk/rustdesk", None)
        .unwrap()
        .is_none());

    // 2. 保存详情缓存
    let detail = AppDetail {
        id: "rustdesk".to_string(),
        name: "RustDesk".to_string(),
        description_en: Some("Remote desktop software".to_string()),
        owner: "rustdesk".to_string(),
        repo: "rustdesk".to_string(),
        icon: "https://github.com/rustdesk.png".to_string(),
        icon_bg: "linear-gradient(135deg, #f97316, #ea580c)".to_string(),
        description: "远程桌面软件".to_string(),
        stars: 70000,
        forks: 9000,
        license: "AGPL-3.0".to_string(),
        latest_version: "v1.3.1".to_string(),
        changelog: "修复已知问题".to_string(),
        is_verified: true,
        readme_markdown: "# RustDesk".to_string(),
        readme_variants: None,
        releases: vec![],
        category: "system".to_string(),
        category_name: "系统实用".to_string(),
        forge: Some("github".to_string()),
        forge_host: Some("github.com".to_string()),
        cached_at: None,
        is_stale: None,
        homepage: None,
        platforms: vec!["windows".to_string()],
        is_cataloged: None,
        source: None,
        status: None,
    };

    db.save_cached_app_detail("rustdesk/rustdesk", &detail)
        .unwrap();

    // 3. 在 TTL 有效期内通过规范化 ID 命中缓存
    let cached_by_id = db
        .get_cached_app_detail("rustdesk/rustdesk", Some(1800))
        .unwrap()
        .expect("hit by id");
    assert_eq!(cached_by_id.name, "RustDesk");
    assert_eq!(
        cached_by_id.description_en.as_deref(),
        Some("Remote desktop software")
    );
    assert_eq!(cached_by_id.latest_version, "v1.3.1");
    assert!(cached_by_id.cached_at.is_some());

    // 4. 缓存键精确匹配：非 canonical 形态（裸名 /  host 前缀变体）一律不命中（ADR-0010 单键语义）
    assert!(db
        .get_cached_app_detail("rustdesk", Some(1800))
        .unwrap()
        .is_none());
    assert!(db
        .get_cached_app_detail("github.com/rustdesk/rustdesk", Some(1800))
        .unwrap()
        .is_none());

    // 5. 测试 TTL 过期机制
    // 使用 ttl = 0 表示已过期 / 必须重新验证
    assert!(db
        .get_cached_app_detail("rustdesk/rustdesk", Some(0))
        .unwrap()
        .is_none());
    // 不传 TTL 时返回已存储副本
    let fallback = db
        .get_cached_app_detail("rustdesk/rustdesk", None)
        .unwrap()
        .expect("fallback hit");
    assert_eq!(fallback.name, "RustDesk");

    // 6. 测试 touch_cached_app_detail 刷新缓存时间
    let fresh_now = now_secs() + 100;
    db.touch_cached_app_detail("rustdesk/rustdesk", fresh_now)
        .unwrap();
    let touched = db
        .get_cached_app_detail("rustdesk/rustdesk", Some(1800))
        .unwrap()
        .expect("touched hit");
    assert_eq!(touched.cached_at, Some(fresh_now));

    // 7. 更新缓存
    let mut updated_detail = detail.clone();
    updated_detail.latest_version = "v1.3.2".to_string();
    db.save_cached_app_detail("rustdesk/rustdesk", &updated_detail)
        .unwrap();
    let cached_updated = db
        .get_cached_app_detail("rustdesk/rustdesk", Some(1800))
        .unwrap()
        .unwrap();
    assert_eq!(cached_updated.latest_version, "v1.3.2");

    // 8. 清除缓存
    db.clear_app_details_cache().unwrap();
    assert!(db
        .get_cached_app_detail("rustdesk/rustdesk", None)
        .unwrap()
        .is_none());
}

#[test]
fn test_detail_cache_ttl_config_baseline() {
    let db = fixtures::test_db();
    // 1. 未设置数据库配置时，返回 config.toml 基线配置
    assert_eq!(
        db.get_detail_cache_ttl_minutes(),
        crate::config::get_project_config().cache.detail_ttl_minutes
    );

    // 2. 存在数据库配置时，返回规范化后的设置值
    db.set_setting("detail_cache_ttl_minutes", "60").unwrap();
    assert_eq!(db.get_detail_cache_ttl_minutes(), 60);
}

#[test]
fn test_strict_errors_defaults_to_config_baseline() {
    let db = fixtures::test_db();
    assert_eq!(
        db.is_strict_errors(),
        crate::config::get_project_config().runtime.strict_errors
    );
}

#[test]
fn test_strict_errors_strict_mode_fails_fast() {
    let db = fixtures::test_db();
    db.set_setting("strict_errors", "true").unwrap();
    assert!(db.is_strict_errors());
    assert_eq!(crate::db::normalize_setting_value("strict_errors", "true"), "true");
}

#[test]
fn test_strict_errors_graceful_mode_falls_back() {
    let db = fixtures::test_db();
    db.set_setting("strict_errors", "false").unwrap();
    assert!(!db.is_strict_errors());
    assert_eq!(
        crate::db::normalize_setting_value("strict_errors", "false"),
        "false"
    );
    db.set_setting("strict_errors", "bogus").unwrap();
    assert_eq!(
        db.is_strict_errors(),
        crate::config::get_project_config().runtime.strict_errors
    );
}

#[test]
fn test_watch_notify_frequency_normalize() {
    assert_eq!(normalize_watch_notify_frequency("daily"), "daily");
    assert_eq!(normalize_watch_notify_frequency("startup"), "startup");
    assert_eq!(normalize_watch_notify_frequency("  DAILY  "), "daily");
    assert_eq!(normalize_watch_notify_frequency("hourly"), "daily");
    assert_eq!(normalize_watch_notify_frequency(""), "daily");

    let db = fixtures::test_db();
    assert_eq!(db.get_watch_notify_frequency(), "daily");
    db.set_setting("watch_notify_frequency", "startup").unwrap();
    assert_eq!(db.get_watch_notify_frequency(), "startup");
    db.set_setting("watch_notify_frequency", "bogus").unwrap();
    assert_eq!(db.get_watch_notify_frequency(), "daily");
}

#[test]
fn test_watched_apps_crud() {
    let db = fixtures::test_db();
    assert!(db.get_watched_apps().unwrap().is_empty());

    assert!(db.watch_app("rustdesk/rustdesk", false).unwrap());
    // 重复关注幂等：返回 false，不产生重复行
    assert!(!db.watch_app("rustdesk/rustdesk", false).unwrap());
    assert!(!db.watch_app("   ", false).unwrap());

    let watched = db.get_watched_apps().unwrap();
    assert_eq!(watched.len(), 1);
    assert_eq!(watched[0].app_id, "rustdesk/rustdesk");
    assert!(!watched[0].is_cataloged);
    assert!(watched[0].last_notified_version.is_none());

    // 回填写点仅更新标记，不碰通知基线
    db.set_watched_cataloged("rustdesk/rustdesk", true).unwrap();
    assert!(db.get_watched_apps().unwrap()[0].is_cataloged);

    // 基线初始化仅在 NULL 时写入
    db.init_watch_baseline("rustdesk/rustdesk", "v1.0.0")
        .unwrap();
    assert_eq!(
        db.get_watched_apps().unwrap()[0]
            .last_notified_version
            .as_deref(),
        Some("v1.0.0")
    );
    db.init_watch_baseline("rustdesk/rustdesk", "v9.9.9")
        .unwrap();
    assert_eq!(
        db.get_watched_apps().unwrap()[0]
            .last_notified_version
            .as_deref(),
        Some("v1.0.0")
    );

    // 通知更新
    db.set_watch_notified("rustdesk/rustdesk", "v1.1.0", 1700000000)
        .unwrap();
    let w = db.get_watched_apps().unwrap()[0].clone();
    assert_eq!(w.last_notified_version.as_deref(), Some("v1.1.0"));
    assert_eq!(
        db.get_watch_last_notified_at("rustdesk/rustdesk").unwrap(),
        Some(1700000000)
    );

    assert!(db.unwatch_app("rustdesk/rustdesk").unwrap());
    assert!(!db.unwatch_app("rustdesk/rustdesk").unwrap());
    assert!(db.get_watched_apps().unwrap().is_empty());
}

#[test]
fn test_cataloged_flags_fail_closed_default_and_backfill() {
    // 新库 fail-closed：缺省不带标记建行读出为 false，回填置 true 校准。
    let db = fixtures::test_db();
    for table in ["user_favorites", "watched_apps"] {
        let dflt: Option<String> = db
            .conn
            .query_row(
                "SELECT dflt_value FROM pragma_table_info(?1) WHERE name = 'is_cataloged'",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dflt.as_deref(), Some("0"), "{table} default must fail closed");
    }
    db.conn
        .execute(
            "INSERT INTO user_favorites (app_id, favorited_at) VALUES ('fail/closed', 1700000000)",
            [],
        )
        .unwrap();
    let entries = db.get_favorite_entries().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(
        !entries[0].is_cataloged,
        "fresh favorite without flag must fail closed"
    );
    db.conn
        .execute(
            "INSERT INTO watched_apps (app_id, added_at) VALUES ('fail/closed', 1700000000)",
            [],
        )
        .unwrap();
    let watched = db.get_watched_apps().unwrap();
    assert_eq!(watched.len(), 1);
    assert!(
        !watched[0].is_cataloged,
        "fresh watched without flag must fail closed"
    );
    // 启动回填语义：目录命中即置 true。
    db.set_favorite_cataloged("fail/closed", true).unwrap();
    assert!(db.get_favorite_entries().unwrap()[0].is_cataloged);
    db.set_watched_cataloged("fail/closed", true).unwrap();
    assert!(db.get_watched_apps().unwrap()[0].is_cataloged);
}

#[test]
fn test_icon_cache_meta_crud() {
    let db = fixtures::test_db();
    assert_eq!(db.get_icon_cache_url("agalwood_Motrix.png").unwrap(), None);

    db.save_icon_cache_url("agalwood_Motrix.png", "https://github.com/agalwood.png")
        .unwrap();
    assert_eq!(
        db.get_icon_cache_url("agalwood_Motrix.png")
            .unwrap()
            .as_deref(),
        Some("https://github.com/agalwood.png")
    );

    // 覆盖更新为官方新图标 URL
    db.save_icon_cache_url(
        "agalwood_Motrix.png",
        "https://raw.githubusercontent.com/agalwood/Motrix/HEAD/public/app-icon.png",
    )
    .unwrap();
    assert_eq!(
        db.get_icon_cache_url("agalwood_Motrix.png")
            .unwrap()
            .as_deref(),
        Some("https://raw.githubusercontent.com/agalwood/Motrix/HEAD/public/app-icon.png")
    );

    // 删除单条缓存记录
    db.delete_icon_cache_url("agalwood_Motrix.png").unwrap();
    assert_eq!(db.get_icon_cache_url("agalwood_Motrix.png").unwrap(), None);
}

#[test]
fn test_icon_cycle_crud() {
    let db = fixtures::test_db();
    let app_id = "rustdesk/rustdesk";

    // 1. 初始状态：无记录
    assert!(db.get_icon_cycle(app_id).unwrap().is_none());
    assert!(db.get_icon_cycle_by_repo("rustdesk", "rustdesk").unwrap().is_none());

    // 2. 插入新记录
    let cycle = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "rustdesk".to_string(),
        repo: "rustdesk".to_string(),
        is_cataloged: true,
        level: 1,
        l1_url: "https://example.com/l1.png".to_string(),
        l2_url: "https://example.com/l2.png".to_string(),
        l3_url: "https://example.com/l3.svg".to_string(),
        l4_url: "https://example.com/l4.png".to_string(),
        selected_url: "https://example.com/l1.png".to_string(),
        cache_file: "rustdesk_rustdesk_l1.png".to_string(),
        updated_at: 1700000000,
        pinned: false,
    };
    db.upsert_icon_cycle(&cycle).unwrap();

    // 3. 按 app_id 查询
    let fetched = db.get_icon_cycle(app_id).unwrap().expect("cycle exists");
    assert_eq!(fetched.app_id, app_id);
    assert_eq!(fetched.owner, "rustdesk");
    assert_eq!(fetched.repo, "rustdesk");
    assert!(fetched.is_cataloged);
    assert_eq!(fetched.level, 1);
    assert_eq!(fetched.l1_url, "https://example.com/l1.png");
    assert_eq!(fetched.l2_url, "https://example.com/l2.png");
    assert_eq!(fetched.l3_url, "https://example.com/l3.svg");
    assert_eq!(fetched.l4_url, "https://example.com/l4.png");
    assert_eq!(fetched.selected_url, "https://example.com/l1.png");
    assert_eq!(fetched.cache_file, "rustdesk_rustdesk_l1.png");
    assert_eq!(fetched.updated_at, 1700000000);

    // 4. 按 (owner, repo) 索引查询
    let fetched_by_repo = db
        .get_icon_cycle_by_repo("rustdesk", "rustdesk")
        .unwrap()
        .expect("cycle exists by repo");
    assert_eq!(fetched_by_repo.app_id, app_id);

    // 5. 模块别名方法 (get / upsert)
    let alias_fetched = db.get(app_id).unwrap().expect("alias get exists");
    assert_eq!(alias_fetched.app_id, app_id);

    let module_fetched = icon_cycle::get(&db, app_id).unwrap().expect("module get exists");
    assert_eq!(module_fetched.app_id, app_id);

    // 6. 删除记录
    assert!(db.delete_icon_cycle(app_id).unwrap());
    assert!(!db.delete_icon_cycle(app_id).unwrap());
    assert!(db.get_icon_cycle(app_id).unwrap().is_none());
}

#[test]
fn test_icon_cycle_upsert_on_conflict() {
    let db = fixtures::test_db();
    let app_id = "agalwood/Motrix";

    let initial = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "agalwood".to_string(),
        repo: "Motrix".to_string(),
        is_cataloged: false,
        level: 1,
        l1_url: "https://example.com/motrix_l1.png".to_string(),
        l2_url: "".to_string(),
        l3_url: "".to_string(),
        l4_url: "https://avatars.githubusercontent.com/u/123".to_string(),
        selected_url: "https://example.com/motrix_l1.png".to_string(),
        cache_file: "motrix_1.png".to_string(),
        updated_at: 1000,
        pinned: false,
    };
    db.upsert_icon_cycle(&initial).unwrap();

    let fetched1 = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert_eq!(fetched1.level, 1);
    assert!(!fetched1.is_cataloged);
    assert_eq!(fetched1.l2_url, "");

    // 冲突更新：同 app_id 覆盖写入升级后的完整字段
    let updated = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "agalwood".to_string(),
        repo: "Motrix".to_string(),
        is_cataloged: true,
        level: 2,
        l1_url: "https://example.com/motrix_l1.png".to_string(),
        l2_url: "https://example.com/motrix_l2.png".to_string(),
        l3_url: "https://cdn.simpleicons.org/motrix".to_string(),
        l4_url: "https://avatars.githubusercontent.com/u/123".to_string(),
        selected_url: "https://example.com/motrix_l2.png".to_string(),
        cache_file: "motrix_2.png".to_string(),
        updated_at: 2000,
        pinned: false,
    };
    db.upsert_icon_cycle(&updated).unwrap();

    let fetched2 = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert_eq!(fetched2.level, 2);
    assert!(fetched2.is_cataloged);
    assert_eq!(fetched2.l2_url, "https://example.com/motrix_l2.png");
    assert_eq!(fetched2.l3_url, "https://cdn.simpleicons.org/motrix");
    assert_eq!(fetched2.selected_url, "https://example.com/motrix_l2.png");
    assert_eq!(fetched2.cache_file, "motrix_2.png");
    assert_eq!(fetched2.updated_at, 2000);

    // 确认表中只有 1 条记录，无重复
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM app_icon_cycles WHERE app_id = ?1",
            [app_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn test_icon_cycle_set_level() {
    let db = fixtures::test_db();
    let app_id = "localsend/localsend";

    let item = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "localsend".to_string(),
        repo: "localsend".to_string(),
        is_cataloged: true,
        level: 1,
        l1_url: "https://example.com/ls_l1.png".to_string(),
        l2_url: "https://example.com/ls_l2.png".to_string(),
        l3_url: "https://example.com/ls_l3.png".to_string(),
        l4_url: "https://example.com/ls_l4.png".to_string(),
        selected_url: "https://example.com/ls_l1.png".to_string(),
        cache_file: "ls_1.png".to_string(),
        updated_at: 1000,
        pinned: false,
    };
    db.upsert_icon_cycle(&item).unwrap();

    // 1. 使用 set_icon_cycle_level 切换到 level 2
    db.set_icon_cycle_level(app_id, 2).unwrap();
    let after_l2 = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert_eq!(after_l2.level, 2);
    assert_eq!(after_l2.selected_url, "https://example.com/ls_l2.png");
    assert!(after_l2.updated_at >= 1000);

    // 2. 使用别名 set_level 切换到 level 3
    db.set_level(app_id, 3).unwrap();
    let after_l3 = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert_eq!(after_l3.level, 3);
    assert_eq!(after_l3.selected_url, "https://example.com/ls_l3.png");

    // 3. 使用模块方法 icon_cycle::set_level 切换到 level 4
    icon_cycle::set_level(&db, app_id, 4).unwrap();
    let after_l4 = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert_eq!(after_l4.level, 4);
    assert_eq!(after_l4.selected_url, "https://example.com/ls_l4.png");

    // 4. set_icon_cycle_selected 显式覆盖 selected_url 和 cache_file
    db.set_icon_cycle_selected(app_id, 2, "https://custom.com/icon.png", "custom.png")
        .unwrap();
    let custom = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert_eq!(custom.level, 2);
    assert_eq!(custom.selected_url, "https://custom.com/icon.png");
    assert_eq!(custom.cache_file, "custom.png");

    // 5. 辅助方法 url_for_level 验证
    assert_eq!(item.url_for_level(1), Some("https://example.com/ls_l1.png"));
    assert_eq!(item.url_for_level(2), Some("https://example.com/ls_l2.png"));
    assert_eq!(item.url_for_level(3), Some("https://example.com/ls_l3.png"));
    assert_eq!(item.url_for_level(4), Some("https://example.com/ls_l4.png"));
    assert_eq!(item.url_for_level(5), None);
}

#[test]
fn test_history_prune_limit_n_plus_one() {
    let db = fixtures::test_db();
    // 裁剪唯一落点 prune_history_table，插入 LIMIT+1 条断言仍为 LIMIT
    let search_limit = crate::config::get_project_config()
        .limits
        .search_history_limit;
    assert!(search_limit > 0);
    for i in 0..(search_limit + 1) {
        db.record_search_query(&format!("prune-q-{i}")).unwrap();
    }
    let queries = db.get_search_history().unwrap();
    assert_eq!(queries.len(), search_limit);

    let view_limit = crate::config::get_project_config()
        .limits
        .view_history_limit;
    assert!(view_limit > 0);
    for i in 0..(view_limit + 1) {
        db.record_app_view(&format!("prune-app-{i}")).unwrap();
    }
    let viewed = db.get_recently_viewed_app_ids().unwrap();
    assert_eq!(viewed.len(), view_limit);

    // 直接调用白名单裁剪：limit=1 时仅保留最新 1 条
    db.prune_history_table(ValidatedTable::SearchHistory, 1)
        .unwrap();
    assert_eq!(db.get_search_history().unwrap().len(), 1);
    db.prune_history_table(ValidatedTable::ViewHistory, 1)
        .unwrap();
    assert_eq!(db.get_recently_viewed_app_ids().unwrap().len(), 1);
}

#[test]
fn test_trend_board_cache_roundtrip_passthrough() {
    let db = fixtures::test_db();
    // 空 key 拒绝：不触库，直接 None
    assert!(db.get_trend_board_cache("   ").unwrap().is_none());
    assert!(db
        .get_trend_board_cache("trends:daily:v1")
        .unwrap()
        .is_none());

    // 透存往返：原样写入、原样读出（后端不判 TTL，落库即命中）
    let payload = r#"{"board":"daily","items":[{"id":"rustdesk/rustdesk"}]}"#;
    db.save_trend_board_cache("  trends:daily:v1  ", "daily", payload)
        .unwrap();
    let (got, cached_at) = db
        .get_trend_board_cache("trends:daily:v1")
        .unwrap()
        .expect("saved payload hits without TTL check");
    assert_eq!(got, payload);
    assert!(cached_at > 0 && cached_at <= now_secs());
    let stored_bytes: i64 = db
        .conn
        .query_row(
            "SELECT payload_bytes FROM trend_board_cache WHERE cache_key = ?1",
            ["trends:daily:v1"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored_bytes, payload.len() as i64);

    // key 不做大小写归一：不同大小写视为不同 key
    assert!(db
        .get_trend_board_cache("TRENDS:DAILY:V1")
        .unwrap()
        .is_none());

    // 全列 UPSERT 覆盖
    let v2 = r#"{"board":"weekly","items":[]}"#;
    db.save_trend_board_cache("trends:daily:v1", "weekly", v2)
        .unwrap();
    let (got2, _) = db
        .get_trend_board_cache("trends:daily:v1")
        .unwrap()
        .unwrap();
    assert_eq!(got2, v2);

    // 空 payload 拒绝：不覆盖已有行
    db.save_trend_board_cache("trends:daily:v1", "daily", "")
        .unwrap();
    let (got3, _) = db
        .get_trend_board_cache("trends:daily:v1")
        .unwrap()
        .unwrap();
    assert_eq!(got3, v2);

    // 空 key/board 静默跳过
    db.save_trend_board_cache("   ", "daily", payload).unwrap();
    db.save_trend_board_cache("trends:empty-board", "  ", payload)
        .unwrap();
    assert!(db.get_trend_board_cache("   ").unwrap().is_none());
    assert!(db
        .get_trend_board_cache("trends:empty-board")
        .unwrap()
        .is_none());
}

#[test]
fn test_trend_board_cache_payload_too_large_rejected() {
    let db = fixtures::test_db();
    let big = "x".repeat(cache::TREND_BOARD_CACHE_MAX_BYTES + 1);
    let err = db
        .save_trend_board_cache("trends:oversize", "daily", &big)
        .unwrap_err();
    match err {
        rusqlite::Error::ToSqlConversionFailure(inner) => {
            assert!(
                inner.to_string().contains("trend_board_payload_too_large"),
                "oversize error must carry marker, got: {inner}"
            );
        }
        other => panic!("oversize save must fail with ToSqlConversionFailure, got: {other}"),
    }
    // 超限拒绝不落库
    assert!(db
        .get_trend_board_cache("trends:oversize")
        .unwrap()
        .is_none());

    // 边界：恰为上限字节数允许落库
    let edge = "y".repeat(cache::TREND_BOARD_CACHE_MAX_BYTES);
    db.save_trend_board_cache("trends:edge", "daily", &edge)
        .unwrap();
    assert_eq!(
        db.get_trend_board_cache("trends:edge")
            .unwrap()
            .unwrap()
            .0
            .len(),
        cache::TREND_BOARD_CACHE_MAX_BYTES
    );
}

#[test]
fn test_trend_board_cache_prune_two_tiers_and_idempotent_schema() {
    let db = fixtures::test_db();
    let now = now_secs();
    let seed = |key: &str, board: &str, cached_at: i64| {
        db.conn
            .execute(
                "INSERT INTO trend_board_cache (cache_key, board, payload_json, payload_bytes, cached_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![key, board, "{\"items\":[]}", 12i64, cached_at],
            )
            .unwrap();
    };
    // daily 挡：过期线 3600s
    seed("t:daily-stale", "daily", now - 3700);
    seed("t:daily-fresh", "daily", now - 100);
    seed("t:daily-future", "daily", now + 3600);
    // 其余挡：过期线 43200s
    seed("t:weekly-stale", "weekly", now - 43300);
    seed("t:weekly-fresh", "weekly", now - 100);
    seed("t:weekly-future", "rising", now + 100_000);

    let deleted = db.prune_expired_trend_board_cache(now).unwrap();
    assert_eq!(deleted, 2);
    assert!(db.get_trend_board_cache("t:daily-stale").unwrap().is_none());
    assert!(db
        .get_trend_board_cache("t:weekly-stale")
        .unwrap()
        .is_none());
    for key in [
        "t:daily-fresh",
        "t:daily-future",
        "t:weekly-fresh",
        "t:weekly-future",
    ] {
        assert!(
            db.get_trend_board_cache(key).unwrap().is_some(),
            "{key} must survive prune"
        );
    }

    // 幂等建表：重复执行 schema 不报错、不丢已保留行
    db.init_schema().unwrap();
    db.init_schema().unwrap();
    for key in [
        "t:daily-fresh",
        "t:daily-future",
        "t:weekly-fresh",
        "t:weekly-future",
    ] {
        assert!(
            db.get_trend_board_cache(key).unwrap().is_some(),
            "{key} must survive re-init"
        );
    }
}

#[test]
fn test_icon_cycle_pinned_roundtrip() {
    // pinned 标记落库往返：手动选择后置 true，读回保持。
    let db = fixtures::test_db();
    let app_id = "pinned/roundtrip";
    let mut cycle = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "pinned".to_string(),
        repo: "roundtrip".to_string(),
        is_cataloged: false,
        level: 2,
        l1_url: String::new(),
        l2_url: "https://cdn.simpleicons.org/pinned".to_string(),
        l3_url: String::new(),
        l4_url: String::new(),
        selected_url: "https://cdn.simpleicons.org/pinned".to_string(),
        cache_file: "pinned_l2.png".to_string(),
        updated_at: 1000,
        pinned: true,
    };
    db.upsert_icon_cycle(&cycle).unwrap();
    let fetched = db.get_icon_cycle(app_id).unwrap().expect("cycle exists");
    assert!(fetched.pinned);
    assert_eq!(fetched.level, 2);
    assert_eq!(fetched.selected_url, "https://cdn.simpleicons.org/pinned");

    // 非 pinned 行默认 false（未手动选择）。
    cycle.app_id = "pinned/unpinned".to_string();
    cycle.pinned = false;
    db.upsert_icon_cycle(&cycle).unwrap();
    let fetched2 = db
        .get_icon_cycle("pinned/unpinned")
        .unwrap()
        .expect("cycle exists");
    assert!(!fetched2.pinned);
}

#[test]
fn fresh_schema_has_pinned_default_zero() {
    // 基线 schema：新建库 `app_icon_cycles` 即含 `pinned` 列，缺省为 0。
    let db = fixtures::test_db();
    let mut stmt = db.conn.prepare("PRAGMA table_info(app_icon_cycles)").unwrap();
    let cols: Vec<(String, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, Option<String>>(4)?))
        })
        .unwrap()
        .map(|c| c.unwrap())
        .collect();
    let pinned = cols.iter().find(|(name, _)| name == "pinned");
    assert!(pinned.is_some(), "fresh schema must contain pinned column");
    assert_eq!(pinned.unwrap().1.as_deref(), Some("0"));
    // 缺省写入即 false。
    let cycle = AppIconCycle {
        app_id: "pinned/fresh".to_string(),
        owner: "pinned".to_string(),
        repo: "fresh".to_string(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&cycle).unwrap();
    assert!(!db.get_icon_cycle("pinned/fresh").unwrap().unwrap().pinned);
}

#[test]
fn test_detail_refresh_keeps_pinned_selection_and_fills_slot() {
    // 02 验收①：pinned 行（用户手动选 L2）遇详情最强探测（L4 README）时，
    // 保持 level/selected_url/updated_at，仅补齐 l4 备选槽。
    let db = fixtures::test_db();
    let app_id = "pinned/keep";
    let l2 = "https://cdn.simpleicons.org/keep";
    let l4 = "https://raw.githubusercontent.com/pinned/keep/main/logo.png";
    let before = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "pinned".to_string(),
        repo: "keep".to_string(),
        is_cataloged: false,
        level: 2,
        l1_url: String::new(),
        l2_url: l2.to_string(),
        l3_url: String::new(),
        l4_url: String::new(),
        selected_url: l2.to_string(),
        cache_file: "keep_l2.png".to_string(),
        updated_at: 1000,
        pinned: true,
    };
    db.upsert_icon_cycle(&before).unwrap();

    let mut loaded = db.get_icon_cycle(app_id).unwrap().unwrap();
    let was_pinned =
        icon_cycle::merge_detail_icon(&mut loaded, 4, l4, false, 2000);
    assert!(was_pinned, "pinned row must report pinned");
    assert_eq!(loaded.level, 2);
    assert_eq!(loaded.selected_url, l2);
    assert_eq!(loaded.l4_url, l4);
    assert_eq!(loaded.updated_at, 1000, "pinned merge must not bump updated_at");
    db.upsert_icon_cycle(&loaded).unwrap();
    let re = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert!(re.pinned);
    assert_eq!(re.level, 2);
    assert_eq!(re.selected_url, l2);
    assert_eq!(re.l4_url, l4);

    // pinned 补槽不覆盖已有备选值。
    let mut loaded2 = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert!(icon_cycle::merge_detail_icon(
        &mut loaded2,
        2,
        "https://cdn.simpleicons.org/other",
        false,
        3000
    ));
    assert_eq!(loaded2.l2_url, l2);
    assert_eq!(loaded2.selected_url, l2);
}

#[test]
fn test_detail_refresh_updates_unpinned_selection() {
    // 02 验收②：未 pinned 行仍按最强探测更新选中图（level/selected/对应槽/updated_at 推进）。
    let db = fixtures::test_db();
    let app_id = "pinned/unpinned-update";
    let l2 = "https://cdn.simpleicons.org/update";
    let l4 = "https://raw.githubusercontent.com/pinned/update/main/logo.png";
    let before = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "pinned".to_string(),
        repo: "update".to_string(),
        is_cataloged: false,
        level: 2,
        l1_url: String::new(),
        l2_url: l2.to_string(),
        l3_url: String::new(),
        l4_url: String::new(),
        selected_url: l2.to_string(),
        cache_file: "update_l2.png".to_string(),
        updated_at: 1000,
        pinned: false,
    };
    db.upsert_icon_cycle(&before).unwrap();

    let mut loaded = db.get_icon_cycle(app_id).unwrap().unwrap();
    let was_pinned = icon_cycle::merge_detail_icon(&mut loaded, 4, l4, false, 2000);
    assert!(!was_pinned);
    assert_eq!(loaded.level, 4);
    assert_eq!(loaded.selected_url, l4);
    assert_eq!(loaded.l4_url, l4);
    assert_eq!(loaded.updated_at, 2000);
    assert!(!loaded.pinned);
}

#[test]
fn test_detail_refresh_keeps_pinned_l5_badge() {
    // pinned L5（用户手动选空徽章）：详情刷新不复活图标，保持 level=5 与双空选中态，
    // 备选槽仍可补齐供重选。
    let db = fixtures::test_db();
    let app_id = "pinned/l5";
    let l2 = "https://cdn.simpleicons.org/l5keep";
    let l4 = "https://raw.githubusercontent.com/pinned/l5/main/logo.png";
    let mut before = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "pinned".to_string(),
        repo: "l5".to_string(),
        is_cataloged: false,
        level: 2,
        l1_url: String::new(),
        l2_url: l2.to_string(),
        l3_url: String::new(),
        l4_url: String::new(),
        selected_url: l2.to_string(),
        cache_file: "l5_l2.png".to_string(),
        updated_at: 1000,
        pinned: true,
    };
    icon_cycle::seal_empty_selection(&mut before);
    before.pinned = true;
    db.upsert_icon_cycle(&before).unwrap();

    let mut loaded = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert_eq!(loaded.level, 5);
    assert!(icon_cycle::merge_detail_icon(&mut loaded, 4, l4, false, 2000));
    assert_eq!(loaded.level, 5);
    assert!(loaded.selected_url.is_empty());
    assert!(loaded.cache_file.is_empty());
    assert_eq!(loaded.l4_url, l4);
    // l1..l4 备选保留供重选。
    assert_eq!(loaded.l2_url, l2);
}

#[test]
fn test_cycle_recovery_paths_preserve_pinned() {
    // 恢复路径（set_icon_cycle_level / set_icon_cycle_selected）不改变 pinned：
    // 文件缺失重下等自动恢复永不丢失用户手动选择状态。
    let db = fixtures::test_db();
    let app_id = "pinned/recovery";
    let cycle = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "pinned".to_string(),
        repo: "recovery".to_string(),
        is_cataloged: false,
        level: 2,
        l1_url: String::new(),
        l2_url: "https://cdn.simpleicons.org/recovery".to_string(),
        l3_url: String::new(),
        l4_url: String::new(),
        selected_url: "https://cdn.simpleicons.org/recovery".to_string(),
        cache_file: "recovery_l2.png".to_string(),
        updated_at: 1000,
        pinned: true,
    };
    db.upsert_icon_cycle(&cycle).unwrap();

    db.set_icon_cycle_selected(app_id, 2, "https://cdn.simpleicons.org/recovery", "re.png")
        .unwrap();
    assert!(db.get_icon_cycle(app_id).unwrap().unwrap().pinned);
    db.set_icon_cycle_level(app_id, 2).unwrap();
    assert!(db.get_icon_cycle(app_id).unwrap().unwrap().pinned);
}

#[test]
fn test_cycle_restore_fresh_requires_row_and_file() {
    // 03 过期刷新：恢复路径与请求路径同口径判鲜（行 7 天有效 + 文件 7 天新鲜双检），
    // 任一过期即走下载分支；pinned 选择不受判鲜影响（落库经 set_icon_cycle_selected 保持）。
    let now = crate::now_secs();
    let fresh_row = AppIconCycle {
        app_id: "o/r".to_string(),
        owner: "o".to_string(),
        repo: "r".to_string(),
        is_cataloged: false,
        level: 2,
        l1_url: String::new(),
        l2_url: "https://example.com/2.png".to_string(),
        l3_url: String::new(),
        l4_url: String::new(),
        selected_url: "https://example.com/2.png".to_string(),
        cache_file: "abc123.png".to_string(),
        updated_at: now,
        pinned: true,
    };
    // 双新鲜即命中（pinned 行同样命中直接返回，刷新只走下载分支，不丢选择）。
    assert!(icon_cycle::is_cycle_restore_fresh(&fresh_row, true, now));
    // 行过期（缓存生存时效外）即走下载分支。
    let mut stale_row = fresh_row.clone();
    stale_row.updated_at = now - icon_cycle::ICON_TTL_SECS - 1;
    assert!(!icon_cycle::is_cycle_restore_fresh(&stale_row, true, now));
    // 文件过期即走下载分支。
    assert!(!icon_cycle::is_cycle_restore_fresh(&fresh_row, false, now));
    // 空 cache_file 永不命中。
    let mut empty_file = fresh_row.clone();
    empty_file.cache_file = String::new();
    assert!(!icon_cycle::is_cycle_restore_fresh(&empty_file, true, now));
    // 行零时间戳视为过期。
    let mut zero_row = fresh_row.clone();
    zero_row.updated_at = 0;
    assert!(!icon_cycle::is_cycle_restore_fresh(&zero_row, true, now));
}

#[test]
fn test_stream_merge_keeps_existing_slots_for_unpinned() {
    // 05 多槽合并：流式命中（L2品牌库）落库先读旧行合并——已有 l3/l4 槽保留，
    // 本次命中进对应来源槽并收编选中图；pinned 标记保持 false。
    let db = fixtures::test_db();
    let app_id = "merge/stream";
    let l2 = "https://cdn.simpleicons.org/stream";
    let l3 = "https://raw.githubusercontent.com/merge/stream/main/icon.png";
    let l4 = "https://raw.githubusercontent.com/merge/stream/main/blob/logo.png";
    let before = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "merge".to_string(),
        repo: "stream".to_string(),
        is_cataloged: false,
        level: 3,
        l1_url: String::new(),
        l2_url: String::new(),
        l3_url: l3.to_string(),
        l4_url: l4.to_string(),
        selected_url: l3.to_string(),
        cache_file: "stream_l3.png".to_string(),
        updated_at: 1000,
        pinned: false,
    };
    db.upsert_icon_cycle(&before).unwrap();

    // 与 `save_and_emit` 同口径：读旧行 → `merge_detail_icon` → 落库。
    let mut loaded = db.get_icon_cycle(app_id).unwrap().unwrap();
    let keep_cataloged = loaded.is_cataloged;
    let was_pinned = icon_cycle::merge_detail_icon(&mut loaded, 2, l2, keep_cataloged, 2000);
    assert!(!was_pinned);
    db.upsert_icon_cycle(&loaded).unwrap();

    let re = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert!(!re.pinned);
    assert_eq!(re.level, 2);
    assert_eq!(re.l2_url, l2);
    assert_eq!(re.l3_url, l3, "existing L3 slot must be kept");
    assert_eq!(re.l4_url, l4, "existing L4 slot must be kept");
    assert_eq!(re.selected_url, l2);
    assert_eq!(re.updated_at, 2000);
}

#[test]
fn test_stream_merge_on_pinned_row_only_fills_slot() {
    // 05 + 02：流式命中落到已 pinned 行时只补对应空槽，
    // level/selected_url/updated_at 保持手动选择，不丢 pinned。
    let db = fixtures::test_db();
    let app_id = "merge/pinned";
    let l3 = "https://raw.githubusercontent.com/merge/pinned/main/icon.png";
    let l2 = "https://cdn.simpleicons.org/pinned";
    let before = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "merge".to_string(),
        repo: "pinned".to_string(),
        is_cataloged: false,
        level: 3,
        l1_url: String::new(),
        l2_url: String::new(),
        l3_url: l3.to_string(),
        l4_url: String::new(),
        selected_url: l3.to_string(),
        cache_file: "pinned_l3.png".to_string(),
        updated_at: 1000,
        pinned: true,
    };
    db.upsert_icon_cycle(&before).unwrap();

    let mut loaded = db.get_icon_cycle(app_id).unwrap().unwrap();
    let keep_cataloged = loaded.is_cataloged;
    assert!(icon_cycle::merge_detail_icon(&mut loaded, 2, l2, keep_cataloged, 2000));
    db.upsert_icon_cycle(&loaded).unwrap();

    let re = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert!(re.pinned);
    assert_eq!(re.level, 3);
    assert_eq!(re.selected_url, l3);
    assert_eq!(re.l2_url, l2, "empty L2 slot is filled");
    assert_eq!(re.updated_at, 1000, "pinned merge must not bump updated_at");
}

#[test]
fn test_probe_cache_file_adopt_only_when_selected_matches() {
    // 05 槽满不錯配选中图：仅选中即真地址才认领新文件，否则保持原配对。
    let mut adopted = AppIconCycle {
        app_id: "probe/adopt".to_string(),
        selected_url: "https://cdn.simpleicons.org/a".to_string(),
        cache_file: "old.png".to_string(),
        ..Default::default()
    };
    assert!(icon_cycle::adopt_probe_cache_file(
        &mut adopted,
        "https://cdn.simpleicons.org/a",
        "new.png".to_string()
    ));
    assert_eq!(adopted.cache_file, "new.png");

    // 选中是旧图（pinned/槽满未收编）：不认领，保持原配对。
    let mut kept = AppIconCycle {
        app_id: "probe/keep".to_string(),
        selected_url: "https://example.com/old.png".to_string(),
        cache_file: "old.png".to_string(),
        ..Default::default()
    };
    assert!(!icon_cycle::adopt_probe_cache_file(
        &mut kept,
        "https://cdn.simpleicons.org/new",
        "new.png".to_string()
    ));
    assert_eq!(kept.cache_file, "old.png");
    assert_eq!(kept.selected_url, "https://example.com/old.png");

    // 空文件名永不认领（写盘失败不破坏原配对）。
    let mut empty = AppIconCycle {
        app_id: "probe/empty".to_string(),
        selected_url: "https://cdn.simpleicons.org/a".to_string(),
        cache_file: "old.png".to_string(),
        ..Default::default()
    };
    assert!(!icon_cycle::adopt_probe_cache_file(
        &mut empty,
        "https://cdn.simpleicons.org/a",
        String::new()
    ));
    assert_eq!(empty.cache_file, "old.png");
}

