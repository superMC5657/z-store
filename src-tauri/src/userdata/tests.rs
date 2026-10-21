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
        "favorites": ["rustdesk", " vlc ", "bad id!", 123, "rustdesk"],
        "watched": ["localsend", ""],
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
        vec!["rustdesk".to_string(), "vlc".to_string()]
    );
    assert_eq!(plan.watched, vec!["localsend".to_string()]);
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
