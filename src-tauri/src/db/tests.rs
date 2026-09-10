use super::*;
use crate::models::{AppDetail, InstalledApp};

#[test]
fn test_installed_apps_crud() {
    let db = Database::open_in_memory().unwrap();
    let app = InstalledApp {
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
    };

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
    let db = Database::open_in_memory().unwrap();
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
    let db = Database::open_in_memory().unwrap();
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
    let db = Database::open_in_memory().unwrap();

    // 1. Initial state: no rules
    assert!(db.get_rule("rustdesk").unwrap().is_none());
    assert_eq!(db.get_all_rules().unwrap().len(), 0);

    // 2. Set skip version
    db.set_skip_version("rustdesk", Some("v1.3.0")).unwrap();
    let rule = db.get_rule("rustdesk").unwrap().expect("rule exists");
    assert_eq!(rule.app_id, "rustdesk");
    assert_eq!(rule.skipped_version.as_deref(), Some("v1.3.0"));
    assert!(!rule.is_frozen);
    assert!(!rule.is_hidden);

    // 3. Freeze version
    db.set_frozen_status("rustdesk", true).unwrap();
    let rule = db.get_rule("rustdesk").unwrap().unwrap();
    assert!(rule.is_frozen);
    assert_eq!(rule.skipped_version.as_deref(), Some("v1.3.0"));

    // 4. Hide status
    db.set_hidden_status("rustdesk", true).unwrap();
    let rule = db.get_rule("rustdesk").unwrap().unwrap();
    assert!(rule.is_hidden);

    // 5. Add second app rule
    db.set_skip_version("localsend", Some("v1.14.1")).unwrap();
    let all = db.get_all_rules().unwrap();
    assert_eq!(all.len(), 2);

    // 6. Unfreeze and unhide
    db.set_frozen_status("rustdesk", false).unwrap();
    db.set_hidden_status("rustdesk", false).unwrap();
    let rule = db.get_rule("rustdesk").unwrap().unwrap();
    assert!(!rule.is_frozen);
    assert!(!rule.is_hidden);

    // 7. Remove rule
    let removed = db.remove_rule("rustdesk").unwrap();
    assert!(removed);
    assert!(db.get_rule("rustdesk").unwrap().is_none());
    assert_eq!(db.get_all_rules().unwrap().len(), 1);
}

#[test]
fn test_search_and_view_history_crud() {
    let db = Database::open_in_memory().unwrap();

    // 1. Search history
    db.record_search_query("rustdesk").unwrap();
    db.record_search_query("localsend").unwrap();
    db.record_search_query("rustdesk").unwrap(); // upsert (should move to top)

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

    // 2. View history
    db.record_app_view("rustdesk").unwrap();
    db.record_app_view("vlc").unwrap();
    db.record_app_view("rustdesk").unwrap(); // upsert to top

    let app_ids = db.get_recently_viewed_app_ids().unwrap();
    assert_eq!(app_ids.len(), 2);
    assert_eq!(app_ids[0], "rustdesk");
    assert_eq!(app_ids[1], "vlc");

    db.clear_view_history().unwrap();
    assert!(db.get_recently_viewed_app_ids().unwrap().is_empty());
}

#[test]
fn test_host_tokens_crud() {
    let db = Database::open_in_memory().unwrap();

    // 1. Initially empty
    let tokens = db.get_host_tokens().unwrap();
    assert!(tokens.is_empty());

    // 2. Set token
    db.set_host_token("codeberg.org", "cb_token_123").unwrap();
    db.set_host_token("github.com", "gh_token_456").unwrap();

    let tokens = db.get_host_tokens().unwrap();
    assert_eq!(tokens.len(), 2);
    assert_eq!(db.get_host_token("codeberg.org").unwrap().as_deref(), Some("cb_token_123"));
    assert_eq!(db.get_host_token("github.com").unwrap().as_deref(), Some("gh_token_456"));

    // 3. Update rate limit
    db.update_host_rate_limit("codeberg.org", Some(2990), Some(3000), Some(1700000000)).unwrap();
    let tokens_after = db.get_host_tokens().unwrap();
    let cb = tokens_after.iter().find(|t| t.host == "codeberg.org").unwrap();
    assert_eq!(cb.rate_limit_remaining, Some(2990));

    // 4. Remove token
    let removed = db.remove_host_token("codeberg.org").unwrap();
    assert!(removed);
    assert!(db.get_host_token("codeberg.org").unwrap().is_none());
    assert_eq!(db.get_host_tokens().unwrap().len(), 1);

    // 5. Update rate limit without prior token (Anonymous/Public host entry)
    db.update_host_rate_limit("gitea.com", Some(55), Some(60), Some(1700000100)).unwrap();
    let tokens_new = db.get_host_tokens().unwrap();
    assert_eq!(tokens_new.len(), 2);
    let gitea = tokens_new.iter().find(|t| t.host == "gitea.com").unwrap();
    assert_eq!(gitea.rate_limit_remaining, Some(55));
    assert_eq!(gitea.rate_limit_limit, Some(60));
    assert!(db.get_host_token("gitea.com").unwrap().is_none());
}

#[test]
fn test_app_details_cache_crud() {
    let db = Database::open_in_memory().unwrap();
    db.clear_app_details_cache().unwrap();

    // 1. Initial: empty
    assert!(db.get_cached_app_detail("rustdesk", None).unwrap().is_none());
    assert!(db.get_cached_app_detail("github.com/rustdesk/rustdesk", None).unwrap().is_none());

    // 2. Save detail
    let detail = AppDetail {
        id: "rustdesk".to_string(),
        name: "RustDesk".to_string(),
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
        signature_fingerprint: None,
        readme_markdown: "# RustDesk".to_string(),
        releases: vec![],
        category: "system".to_string(),
        category_name: "系统实用".to_string(),
        forge: Some("github".to_string()),
        forge_host: Some("github.com".to_string()),
        cached_at: None,
        is_stale_fallback: None,
        homepage: None,
        platforms: vec!["windows".to_string()],
        store_meta: None,
    };

    db.save_cached_app_detail("rustdesk", "github.com/rustdesk/rustdesk", &detail).unwrap();

    // 3. Hit via app_id with TTL
    let cached_by_id = db.get_cached_app_detail("rustdesk", Some(1800)).unwrap().expect("hit by id");
    assert_eq!(cached_by_id.name, "RustDesk");
    assert_eq!(cached_by_id.latest_version, "v1.3.1");
    assert!(cached_by_id.cached_at.is_some());

    // 4. Hit via repo_key
    let cached_by_repo = db.get_cached_app_detail("github.com/rustdesk/rustdesk", Some(1800)).unwrap().expect("hit by repo_key");
    assert_eq!(cached_by_repo.id, "rustdesk");

    // 5. Hit with different casing
    let cached_casing = db.get_cached_app_detail("RustDesk", Some(1800)).unwrap().expect("hit with uppercase");
    assert_eq!(cached_casing.name, "RustDesk");
    let cached_repo_casing = db.get_cached_app_detail("GitHub.com/RustDesk/RustDesk", Some(1800)).unwrap().expect("hit with uppercase repo");
    assert_eq!(cached_repo_casing.name, "RustDesk");

    // 6. Test TTL expiration
    // Using ttl = 0 means expired / must revalidate
    assert!(db.get_cached_app_detail("rustdesk", Some(0)).unwrap().is_none());
    // Even if expired, fallback retrieves the cached copy
    let fallback = db.get_cached_app_detail_fallback("rustdesk").unwrap().expect("fallback hit");
    assert_eq!(fallback.name, "RustDesk");

    // 7. Test touch_cached_app_detail
    let fresh_now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64 + 100;
    db.touch_cached_app_detail("rustdesk", fresh_now).unwrap();
    let touched = db.get_cached_app_detail("rustdesk", Some(1800)).unwrap().expect("touched hit");
    assert_eq!(touched.cached_at, Some(fresh_now));

    // 8. Update
    let mut updated_detail = detail.clone();
    updated_detail.latest_version = "v1.3.2".to_string();
    db.save_cached_app_detail("rustdesk", "github.com/rustdesk/rustdesk", &updated_detail).unwrap();
    let cached_updated = db.get_cached_app_detail("rustdesk", Some(1800)).unwrap().unwrap();
    assert_eq!(cached_updated.latest_version, "v1.3.2");

    // 9. Clear cache
    db.clear_app_details_cache().unwrap();
    assert!(db.get_cached_app_detail("rustdesk", None).unwrap().is_none());
}

#[test]
fn test_detail_cache_ttl_config_baseline() {
    let db = Database::open_in_memory().unwrap();
    // 1. Without DB setting, returns config.toml baseline (30)
    assert_eq!(db.get_detail_cache_ttl_minutes(), 30);

    // 2. With DB setting, returns normalized setting
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

    let db = Database::open_in_memory().unwrap();
    assert_eq!(db.get_watch_notify_frequency(), "daily");
    db.set_setting("watch_notify_frequency", "startup").unwrap();
    assert_eq!(db.get_watch_notify_frequency(), "startup");
    db.set_setting("watch_notify_frequency", "bogus").unwrap();
    assert_eq!(db.get_watch_notify_frequency(), "daily");
}

#[test]
fn test_watched_apps_crud() {
    let db = Database::open_in_memory().unwrap();
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
    db.init_watch_baseline("rustdesk/rustdesk", "v1.0.0").unwrap();
    assert_eq!(
        db.get_watched_apps().unwrap()[0]
            .last_notified_version
            .as_deref(),
        Some("v1.0.0")
    );
    db.init_watch_baseline("rustdesk/rustdesk", "v9.9.9").unwrap();
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
    assert_eq!(db.get_watch_last_notified_at("rustdesk/rustdesk").unwrap(), Some(1700000000));

    assert!(db.unwatch_app("rustdesk/rustdesk").unwrap());
    assert!(!db.unwatch_app("rustdesk/rustdesk").unwrap());
    assert!(db.get_watched_apps().unwrap().is_empty());
}

#[test]
fn test_verified_apps_and_store_meta_cache() {
    let db = Database::open_in_memory().unwrap();
    assert!(!db.is_verified_app("rustdesk").unwrap());
    db.mark_verified_app("rustdesk").unwrap();
    assert!(db.is_verified_app("rustdesk").unwrap());

    // store_meta 缓存：TTL 命中 / ttl=0 强制失效 / 无 TTL 常命中
    assert!(db.get_cached_store_meta_raw("rustdesk", Some(1800)).unwrap().is_none());
    db.save_cached_store_meta_raw("rustdesk", "[app]\ndisplay-name = \"X\"\n")
        .unwrap();
    let raw = db
        .get_cached_store_meta_raw("RustDesk", Some(1800))
        .unwrap()
        .expect("大小写不敏感命中");
    assert!(raw.contains("display-name"));
    assert!(db.get_cached_store_meta_raw("rustdesk", Some(0)).unwrap().is_none());
    let fallback = db.get_cached_store_meta_raw("rustdesk", None).unwrap().unwrap();
    assert!(fallback.contains("display-name"));
}
