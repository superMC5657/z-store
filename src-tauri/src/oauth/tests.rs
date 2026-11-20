use super::*;

#[test]
fn test_resolve_client_id_override() {
    let default_id = default_oauth_client_id();
    assert_eq!(
        resolve_oauth_client_id(Some("  abc123  ")),
        "abc123".to_string()
    );
    assert_eq!(resolve_oauth_client_id(Some("")), default_id);
    assert_eq!(resolve_oauth_client_id(None), default_id);
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
        classify_device_poll(r#"{"error":"incorrect_device_code","error_description":"bad code"}"#),
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
fn test_starred_api_url() {
    assert_eq!(
        starred_api_url("rustdesk", "rustdesk"),
        "https://api.github.com/user/starred/rustdesk/rustdesk"
    );
}

#[test]
fn test_oauth_user_requires_all_fields() {
    // 缺字段的持久化数据必须解析失败，调用方将其视为“需重新登录”。
    let rejected_json = r#"{"login":"superMC5657","avatar_url":"https://github.com/superMC5657.png","has_list_scope":true}"#;
    assert!(serde_json::from_str::<OAuthUser>(rejected_json).is_err());

    // 完整字段正常解析
    let full_json = r#"{"login":"superMC5657","avatar_url":"https://github.com/superMC5657.png","has_list_scope":true,"is_expired":true}"#;
    let user: OAuthUser = serde_json::from_str(full_json).expect("should deserialize full json");
    assert_eq!(user.login, "superMC5657");
    assert!(user.has_list_scope);
    assert!(user.is_expired);
}

#[test]
fn test_should_refetch_oauth_user_predicate() {
    fn user(has_list_scope: bool, is_expired: bool) -> OAuthUser {
        OAuthUser {
            login: "u".to_string(),
            avatar_url: "https://github.com/u.png".to_string(),
            has_list_scope,
            is_expired,
        }
    }
    // 快照缺失 → 有令牌时补拉
    assert!(should_refetch_oauth_user(None));
    // 未标记 scope 的快照 → 补拉
    assert!(should_refetch_oauth_user(Some(&user(false, false))));
    // 过期快照原样返回 → 不补拉
    assert!(!should_refetch_oauth_user(Some(&user(true, true))));
    assert!(!should_refetch_oauth_user(Some(&user(false, true))));
    // 已标记 scope 的有效快照 → 不补拉
    assert!(!should_refetch_oauth_user(Some(&user(true, false))));
}

#[test]
fn test_split_github_repo_id_and_session_roundtrip() {
    assert_eq!(
        split_github_repo_id("https://github.com/RustDesk/RustDesk").unwrap(),
        ("rustdesk".to_string(), "rustdesk".to_string())
    );
    assert!(split_github_repo_id("codeberg:owner/repo").is_err());

    let db = crate::db::Database::open_in_memory().expect("in-memory db");
    let user = OAuthUser {
        login: "alice".to_string(),
        avatar_url: "https://github.com/alice.png".to_string(),
        has_list_scope: true,
        is_expired: false,
    };
    save_oauth_session(&db, "gho_test_token", Some(&user));
    let (loaded, has_token) = load_oauth_user_snapshot(&db);
    assert_eq!(loaded, Some(user));
    assert!(has_token);

    let fallback = clear_oauth_session(&db).expect("clear session");
    assert!(fallback.is_none());
    let (loaded_after, has_token_after) = load_oauth_user_snapshot(&db);
    assert!(loaded_after.is_none());
    assert!(!has_token_after);
}

#[test]
fn clear_oauth_session_purges_private_starred_snapshots_only() {
    let db = crate::db::Database::open_in_memory().expect("in-memory db");
    db.save_starred_feed_cache("@me:alice", "@me:alice", "{\"v\":1}")
        .unwrap();
    db.save_starred_feed_cache("torvalds", "torvalds", "{\"v\":1}")
        .unwrap();
    db.save_etag(
        "https://api.github.com/user/starred?per_page=20&page=1",
        "\"e\"",
        "[]",
        crate::now_secs(),
    )
    .unwrap();
    clear_oauth_session(&db).expect("clear session");
    assert!(db.get_starred_feed_cache("@me:alice").unwrap().is_none());
    assert!(db.get_starred_feed_cache("torvalds").unwrap().is_some());
    assert!(db
        .get_etag("https://api.github.com/user/starred?per_page=20&page=1")
        .unwrap()
        .is_none());
}

#[test]
fn clear_oauth_session_purges_private_repo_cards_and_search_lists_only() {
    use crate::db::RepoCardUpsert;
    use crate::models::{AppCore, AppSummary};
    let db = crate::db::Database::open_in_memory().expect("in-memory db");
    let card = |id: &str, is_private: bool| {
        let (owner, repo) = id.split_once('/').unwrap();
        RepoCardUpsert {
            summary: AppSummary {
                core: AppCore {
                    id: id.to_string(),
                    name: repo.to_string(),
                    description_en: None,
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    icon: String::new(),
                    icon_bg: String::new(),
                    description: "real".to_string(),
                    stars: 1,
                    forks: 0,
                    license: "MIT".to_string(),
                    latest_version: "v1".to_string(),
                    category: "external".to_string(),
                    category_name: "跨平台开源".to_string(),
                    is_verified: false,
                    forge: None,
                    forge_host: None,
                    homepage: None,
                    platforms: vec![],
                    is_cataloged: None,
                    source: None,
                    status: None,
                    added_at: None,
                    alternatives: Vec::new(),
                },
            },
            confirmed_other: false,
            is_private: Some(is_private),
        }
    };
    db.upsert_repo_cards_batch(&[card("me/secret", true), card("pub/tool", false)])
        .unwrap();
    db.save_search_list_cache("mine|1|20", "mine", "{}", true)
        .unwrap();
    db.save_search_list_cache("rust|1|20", "rust", "{}", false)
        .unwrap();

    clear_oauth_session(&db).expect("clear session");

    assert!(db.get_repo_card("me/secret").unwrap().is_none());
    assert!(db.get_repo_card("pub/tool").unwrap().is_some());
    assert!(db.get_search_list_cache("mine|1|20").unwrap().is_none());
    assert!(db.get_search_list_cache("rust|1|20").unwrap().is_some());
}
