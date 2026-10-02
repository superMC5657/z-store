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

    let fav_added = db.toggle_favorite("rustdesk").unwrap();
    assert!(fav_added);
    assert_eq!(db.get_favorites().unwrap(), vec!["rustdesk".to_string()]);

    let fav_removed = db.toggle_favorite("rustdesk").unwrap();
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
        releases: vec![],
        category: "system".to_string(),
        category_name: "系统实用".to_string(),
        forge: Some("github".to_string()),
        forge_host: Some("github.com".to_string()),
        cached_at: None,
        is_stale: None,
        homepage: None,
        platforms: vec!["windows".to_string()],
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
    // 即使过期，兜底回退查询依然能获取到缓存副本
    let fallback = db
        .get_cached_app_detail_fallback("rustdesk/rustdesk")
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

    assert!(db.watch_app("rustdesk/rustdesk").unwrap());
    // 重复关注幂等：返回 false，不产生重复行
    assert!(!db.watch_app("rustdesk/rustdesk").unwrap());
    assert!(!db.watch_app("   ").unwrap());

    let watched = db.get_watched_apps().unwrap();
    assert_eq!(watched.len(), 1);
    assert_eq!(watched[0].app_id, "rustdesk/rustdesk");
    assert!(watched[0].last_notified_version.is_none());

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
fn test_verified_apps() {
    let db = fixtures::test_db();
    assert!(!db.is_verified_app("rustdesk").unwrap());
    db.mark_verified_app("rustdesk").unwrap();
    assert!(db.is_verified_app("rustdesk").unwrap());
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

