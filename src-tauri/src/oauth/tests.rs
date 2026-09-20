use super::*;

#[test]
fn test_resolve_client_id_override() {
    let default_id = default_oauth_client_id();
    assert_eq!(
        resolve_oauth_client_id(Some("  abc123  ")),
        "abc123".to_string()
    );
    assert_eq!(
        resolve_oauth_client_id(Some("")),
        default_id
    );
    assert_eq!(
        resolve_oauth_client_id(None),
        default_id
    );
}

#[test]
fn test_classify_device_poll_state_machine() {
    // 等待中
    assert_eq!(
        classify_device_poll(r#"{"error":"authorization_pending","error_description":"pending"}"#),
        DevicePollOutcome::Pending {
            message: "等待用户在浏览器中完成授权".to_string()
        }
    );
    assert_eq!(
        classify_device_poll(r#"{"error":"slow_down","error_description":"slow"}"#),
        DevicePollOutcome::Pending {
            message: "轮询过于频繁，已自动放慢等待用户授权".to_string()
        }
    );
    // 已授权
    assert_eq!(
        classify_device_poll(
            r#"{"access_token":"gho_abc","token_type":"bearer","scope":"public_repo"}"#
        ),
        DevicePollOutcome::Authorized {
            access_token: "gho_abc".to_string()
        }
    );
    // 过期 / 拒绝（独立状态，前端可分别提示）
    assert!(matches!(
        classify_device_poll(r#"{"error":"expired_token"}"#),
        DevicePollOutcome::Expired { .. }
    ));
    assert_eq!(
        classify_device_poll(r#"{"error":"access_denied","error_description":"no"}"#),
        DevicePollOutcome::Denied {
            message: "用户拒绝了授权请求".to_string()
        }
    );
    // 未知错误透出描述
    assert_eq!(
        classify_device_poll(
            r#"{"error":"incorrect_device_code","error_description":"bad code"}"#
        ),
        DevicePollOutcome::Error {
            message: "bad code".to_string()
        }
    );
    // 非 JSON 体
    assert!(matches!(
        classify_device_poll("not json at all"),
        DevicePollOutcome::Error { .. }
    ));
    // 空令牌视为错误而非授权
    assert!(matches!(
        classify_device_poll(r#"{"access_token":"  "}"#),
        DevicePollOutcome::Error { .. }
    ));
}

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
    // 仅白名单设置项通过（P1-8：除 github_token 外全量通过），数值/布尔转字符串
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
    assert!(plan.settings.contains(&(
        "detail_cache_ttl_minutes".to_string(),
        "60".to_string()
    )));

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
    // P1-8：导出 → JSON → 导入往返：除 github_token 外的全部 14 项设置无损通过，
    // 混合 JSON 类型（字符串/数值/布尔）统一转字符串；version 保持为 1。
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
            "max_concurrent_downloads": 5,
            "close_to_tray": false,
            "launch_on_startup": true,
            "update_frequency": "daily",
            "detail_cache_ttl_minutes": 60,
            "catalog_source_url": "https://example.com/catalog.json",
            "watch_notify_frequency": "startup",
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
    assert_eq!(got.get("max_concurrent_downloads"), Some(&"5"));
    assert_eq!(got.get("close_to_tray"), Some(&"false"));
    assert_eq!(got.get("launch_on_startup"), Some(&"true"));
    assert_eq!(got.get("detail_cache_ttl_minutes"), Some(&"60"));
    // github_token 被刻意排除：永不经备份流转
    assert!(!got.contains_key("github_token"));
    assert!(!plan.settings.iter().any(|(_, v)| v.contains("gho_")));
}

#[test]
fn test_starred_api_url() {
    assert_eq!(
        starred_api_url("rustdesk", "rustdesk"),
        "https://api.github.com/user/starred/rustdesk/rustdesk"
    );
}

#[test]
fn test_oauth_user_requires_all_fields() {
    // 缺字段的旧持久化数据必须解析失败，调用方将其视为“需重新登录”。
    let legacy_json = r#"{"login":"superMC5657","avatar_url":"https://github.com/superMC5657.png","has_list_scope":true}"#;
    assert!(serde_json::from_str::<OAuthUser>(legacy_json).is_err());

    // 完整字段正常解析
    let full_json = r#"{"login":"superMC5657","avatar_url":"https://github.com/superMC5657.png","has_list_scope":true,"is_expired":true}"#;
    let user: OAuthUser = serde_json::from_str(full_json).expect("should deserialize full json");
    assert_eq!(user.login, "superMC5657");
    assert!(user.has_list_scope);
    assert!(user.is_expired);
}
