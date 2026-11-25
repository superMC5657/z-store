use super::*;

#[test]
fn test_validate_app_id() {
    assert!(validate_app_id("rustdesk/rustdesk"));
    assert!(validate_app_id("rustdesk"));
    assert!(validate_app_id("gh:rustdesk/rustdesk"));
    assert!(validate_app_id("cb:owner/repo"));
    assert!(!validate_app_id(""));
    assert!(!validate_app_id("   "));
    assert!(!validate_app_id("owner/repo with space"));
    assert!(!validate_app_id("a\nb"));
    assert!(!validate_app_id("///"));
    assert!(!validate_app_id("rm -rf /"));
}

#[test]
fn test_parse_import_payload_merge_rules() {
    let json = r#"{
        "version": 1,
        "favorites": ["RustDesk/RustDesk", " videolan/vlc ", "bareword", "bad id!", 123, "rustdesk/rustdesk"],
        "watched": ["localsend/localsend", "foo", ""],
        "settings": {
            "theme": "dark",
            "language": "en",
            "detail_cache_ttl_minutes": 60,
            "watch_notify_frequency": "daily",
            "evil_key": "rm -rf",
            "github_token": "should-be-ignored"
        }
    }"#;
    let plan = parse_import_payload(json).expect("合法导入 JSON 应当解析成功");
    assert_eq!(
        plan.favorites,
        vec![
            "rustdesk/rustdesk".to_string(),
            "videolan/vlc".to_string()
        ]
    );
    assert_eq!(plan.watched, vec!["localsend/localsend".to_string()]);
    // 仅白名单设置项通过（除 github_token 外全量通过），数值/布尔转字符串
    let mut keys: Vec<&str> = plan.settings.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "detail_cache_ttl_minutes",
            "language",
            "theme",
            "watch_notify_frequency"
        ]
    );
    assert!(plan
        .settings
        .contains(&("detail_cache_ttl_minutes".to_string(), "60".to_string())));

    // 非法版本拒绝
    assert!(parse_import_payload(r#"{"version": 2}"#).is_err());
    // 非 JSON 拒绝
    assert!(parse_import_payload("not json").is_err());
    // 缺省字段视为空
    let minimal = parse_import_payload(r#"{"version": 1}"#).unwrap();
    assert!(minimal.favorites.is_empty());
    assert!(minimal.watched.is_empty());
    assert!(minimal.settings.is_empty());
}

#[test]
fn test_backup_settings_full_round_trip() {
    // 导出 → JSON → 导入往返：除 github_token 外的全部设置无损通过，
    // 混合 JSON 类型（字符串/数值/布尔）统一转字符串；version 保持为 1。
    // show_custom/showCustom 开关随备份往返（默认开；缺席即默认开，不污染旧备份）。
    let json = r#"{
        "version": 1,
        "favorites": ["rustdesk/rustdesk"],
        "watched": ["localsend/localsend"],
        "settings": {
            "theme": "dark",
            "language": "zh-CN",
            "ui_scale": "110",
            "font_size": "16",
            "portable_dir": "D:\\apps",
            "download_dir": "D:\\dl",
            "active_mirror": "direct",
            "launch_on_startup": true,
            "update_frequency": "daily",
            "detail_cache_ttl_minutes": 60,
            "catalog_source_url": "https://example.com/catalog.json",
            "watch_notify_frequency": "startup",
            "show_custom": "true",
            "showCustom": "true",
            "github_token": "gho_should-never-leak"
        }
    }"#;
    let plan = parse_import_payload(json).expect("全量设置导入 JSON 应当解析成功");
    let got: std::collections::HashMap<&str, &str> = plan
        .settings
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    for key in IMPORT_SETTINGS_ALLOWLIST {
        assert!(got.contains_key(key), "白名单键缺失: {}", key);
    }
    assert_eq!(got.get("theme"), Some(&"dark"));
    assert_eq!(got.get("language"), Some(&"zh-CN"));
    assert_eq!(got.get("ui_scale"), Some(&"110"));
    assert_eq!(got.get("launch_on_startup"), Some(&"true"));
    assert_eq!(got.get("detail_cache_ttl_minutes"), Some(&"60"));
    // github_token 被刻意排除：永不经备份流转
    assert!(!got.contains_key("github_token"));
    assert!(!plan.settings.iter().any(|(_, v)| v.contains("gho_")));
}

#[test]
fn test_import_backup_merges_favorites_watch_and_settings_against_in_memory_db() {
    use crate::db::Database;
    use crate::models::InstalledApp;

    let db = Database::open_in_memory().expect("内存数据库应当可用");
    db.save_installed_app(&InstalledApp {
        app_id: "rustdesk/rustdesk".to_string(),
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
    })
    .expect("预置已安装应用应当成功");

    let json = r#"{
        "version": 1,
        "favorites": ["RustDesk/RustDesk", "https://github.com/videolan/vlc"],
        "watched": ["rustdesk/rustdesk"],
        "settings": {
            "theme": "light",
            "detail_cache_ttl_minutes": 999,
            "show_custom": "false",
            "github_token": "gho_secret_must_be_ignored"
        }
    }"#;

    let result = import_backup(&db, |id| id == "rustdesk/rustdesk", json).expect("导入应当成功");
    assert_eq!(result.favorites_added, 2);
    assert_eq!(result.watched_added, 1);
    assert_eq!(result.settings_applied, 3);

    let favs = db.get_favorites().unwrap();
    assert!(favs.contains(&"rustdesk/rustdesk".to_string()));
    assert!(favs.contains(&"videolan/vlc".to_string()));
    assert!(db
        .get_watched_apps()
        .unwrap()
        .iter()
        .any(|w| w.app_id == "rustdesk/rustdesk"));
    assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("light"));
    // 非法 TTL 挡位经 normalize_setting_value 归一为 60
    assert_eq!(
        db.get_setting("detail_cache_ttl_minutes")
            .unwrap()
            .as_deref(),
        Some("60")
    );
    assert_eq!(
        db.get_setting("show_custom").unwrap().as_deref(),
        Some("false")
    );
    assert!(db.get_setting("github_token").unwrap().is_none());
}

#[test]
fn test_import_backup_skips_malformed_ids_and_validates_settings_atomically() {
    use crate::db::Database;

    let db = Database::open_in_memory().expect("内存数据库应当可用");
    // 1. 缺斜杠等畸形 ID（如 "bareword"）优雅跳过，不中断其余合法条目与设置导入
    let mixed_json = r#"{
        "version": 1,
        "favorites": ["rustdesk/rustdesk", "bareword", "foo"],
        "watched": ["slashless"],
        "settings": {
            "theme": "light",
            "active_mirror": "direct",
            "launch_on_startup": true
        }
    }"#;
    let (res, effects) =
        import_backup_with_effects(&db, |_| false, mixed_json).expect("畸形 ID 应当被优雅跳过");
    assert_eq!(res.favorites_added, 1);
    assert_eq!(res.watched_added, 0);
    assert_eq!(res.settings_applied, 3);
    assert_eq!(db.get_favorites().unwrap(), vec!["rustdesk/rustdesk"]);
    assert_eq!(effects.active_mirror.as_deref(), Some("direct"));
    assert_eq!(effects.launch_on_startup, Some(true));

    // 2. 不安全设置项（非 HTTPS/环回镜像、UNC/危险协议清单源）必须 fail-fast 拒绝且零写入
    for bad_settings_json in [
        r#"{"version":1,"favorites":["a/b"],"settings":{"active_mirror":"http://evil.local"}}"#,
        r#"{"version":1,"favorites":["a/b"],"settings":{"active_mirror":"https://127.0.0.1"}}"#,
        r#"{"version":1,"favorites":["a/b"],"settings":{"catalog_source_url":"\\\\attacker\\share\\c.json"}}"#,
        r#"{"version":1,"favorites":["a/b"],"settings":{"catalog_source_url":"smb://attacker/share"}}"#,
        r#"{"version":1,"favorites":["a/b"],"settings":{"catalog_source_url":"https://user:pw@example.com/c.json"}}"#,
    ] {
        let fresh_db = Database::open_in_memory().unwrap();
        assert!(
            import_backup(&fresh_db, |_| false, bad_settings_json).is_err(),
            "unsafe backup must be rejected: {bad_settings_json}"
        );
        assert!(fresh_db.get_favorites().unwrap().is_empty());
        assert!(fresh_db.get_setting("active_mirror").unwrap().is_none());
        assert!(fresh_db.get_setting("catalog_source_url").unwrap().is_none());
    }

    // 3. 事务性锁值：合入中途失败整体回滚
    let fresh_db = Database::open_in_memory().unwrap();
    let err = fresh_db
        .with_immediate_transaction(|| -> rusqlite::Result<()> {
            fresh_db.add_favorite("rustdesk/rustdesk", true)?;
            Err(rusqlite::Error::InvalidParameterName(
                "注入的写入失败".to_string(),
            ))
        })
        .expect_err("注入的写入失败应当上浮");
    assert!(err.to_string().contains("注入的写入失败"));
    assert!(fresh_db.get_favorites().unwrap().is_empty());
    assert!(fresh_db.get_watched_apps().unwrap().is_empty());
}
