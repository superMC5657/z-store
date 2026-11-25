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

    let fallback = revoke_oauth_session(
        &db,
        &std::sync::Mutex::new(None),
        RevokeReason::ManualLogout,
    )
    .expect("clear session");
    assert!(fallback.is_none());
    let (loaded_after, has_token_after) = load_oauth_user_snapshot(&db);
    assert!(loaded_after.is_none());
    assert!(!has_token_after);
}

#[test]
fn manual_logout_purges_private_starred_snapshots_only() {
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
    revoke_oauth_session(
        &db,
        &std::sync::Mutex::new(None),
        RevokeReason::ManualLogout,
    )
    .expect("clear session");
    assert!(db.get_starred_feed_cache("@me:alice").unwrap().is_none());
    assert!(db.get_starred_feed_cache("torvalds").unwrap().is_some());
    assert!(db
        .get_etag("https://api.github.com/user/starred?per_page=20&page=1")
        .unwrap()
        .is_none());
}

#[test]
fn manual_logout_purges_private_repo_cards_and_search_lists_only() {
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

    revoke_oauth_session(
        &db,
        &std::sync::Mutex::new(None),
        RevokeReason::ManualLogout,
    )
    .expect("clear session");

    assert!(db.get_repo_card("me/secret").unwrap().is_none());
    assert!(db.get_repo_card("pub/tool").unwrap().is_some());
    assert!(db.get_search_list_cache("mine|1|20").unwrap().is_none());
    assert!(db.get_search_list_cache("rust|1|20").unwrap().is_some());
}

fn seed_session_fixture(db: &crate::db::Database, host_token: Option<&str>) {
    let user = OAuthUser {
        login: "alice".to_string(),
        avatar_url: "https://github.com/alice.png".to_string(),
        has_list_scope: true,
        is_expired: false,
    };
    save_oauth_session(db, "gho_live", Some(&user));
    if let Some(tok) = host_token {
        db.exec_write(
            "INSERT INTO host_tokens (host, token, updated_at) VALUES ('github.com', ?1, 1)",
            rusqlite::params![tok],
        )
        .unwrap();
    }
    db.save_etag(
        "https://api.github.com/user/starred?per_page=20&page=1",
        "\"e\"",
        "[]",
        crate::now_secs(),
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/repos/o/r",
        "\"p\"",
        "{}",
        crate::now_secs(),
    )
    .unwrap();
    db.save_starred_feed_cache("@me:alice", "@me:alice", "{\"v\":1}")
        .unwrap();
    db.exec_write(
        "INSERT INTO launchpad_discussion_cache (discussion_repo, discussion_number, upvote_count, viewer_has_upvoted, synced_at) VALUES ('o/lp', 7, 3, 1, 1)",
        [],
    )
    .unwrap();
    db.set_starred("o", "r", true).unwrap();
}

fn viewer_upvoted(db: &crate::db::Database) -> Option<i64> {
    db.query_scalar_opt::<Option<i64>, _>(
        "SELECT viewer_has_upvoted FROM launchpad_discussion_cache WHERE discussion_repo = 'o/lp'",
        [],
    )
    .unwrap()
    .flatten()
}

#[test]
fn auth_expired_401_shares_cleanup_kernel_and_marks_user_expired() {
    let db = crate::db::Database::open_in_memory().unwrap();
    seed_session_fixture(&db, None);
    let cache = std::sync::Mutex::new(Some("gho_live".to_string()));

    let fallback = revoke_oauth_session(&db, &cache, RevokeReason::AuthExpired401).unwrap();

    assert!(fallback.is_none());
    assert!(cache.lock().unwrap().is_none());
    let (user, has_token) = load_oauth_user_snapshot(&db);
    assert!(!has_token);
    assert!(user.expect("snapshot kept").is_expired);
    assert!(db
        .get_etag("https://api.github.com/user/starred?per_page=20&page=1")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/o/r")
        .unwrap()
        .is_some());
    assert_eq!(viewer_upvoted(&db), None);
    assert!(db.get_starred_feed_cache("@me:alice").unwrap().is_none());
    // 画像信号保留待重登续用。
    assert!(db.is_starred("o", "r").unwrap());
}

#[test]
fn auth_expired_401_with_host_token_keeps_fallback_and_private_caches() {
    let db = crate::db::Database::open_in_memory().unwrap();
    seed_session_fixture(&db, Some("  ghp_pat  "));
    let cache = std::sync::Mutex::new(Some("gho_live".to_string()));

    let fallback = revoke_oauth_session(&db, &cache, RevokeReason::AuthExpired401).unwrap();

    assert_eq!(fallback.as_deref(), Some("ghp_pat"));
    assert_eq!(cache.lock().unwrap().as_deref(), Some("ghp_pat"));
    assert_eq!(
        resolve_github_token(&db, &cache).as_deref(),
        Some("ghp_pat")
    );
    assert!(db.get_starred_feed_cache("@me:alice").unwrap().is_some());
    assert!(db
        .get_etag("https://api.github.com/user/starred?per_page=20&page=1")
        .unwrap()
        .is_none());
    assert_eq!(viewer_upvoted(&db), None);
}

#[test]
fn auth_expired_401_clears_corrupt_user_snapshot() {
    let db = crate::db::Database::open_in_memory().unwrap();
    db.set_setting(SETTING_OAUTH_TOKEN, "gho_live").unwrap();
    db.set_setting(SETTING_OAUTH_USER, "{not json").unwrap();
    let cache = std::sync::Mutex::new(None);

    revoke_oauth_session(&db, &cache, RevokeReason::AuthExpired401).unwrap();

    assert!(db.get_setting(SETTING_OAUTH_USER).unwrap().is_none());
}

#[test]
fn manual_logout_removes_user_and_account_signals() {
    let db = crate::db::Database::open_in_memory().unwrap();
    seed_session_fixture(&db, Some("ghp_pat"));
    let cache = std::sync::Mutex::new(Some("gho_live".to_string()));

    let fallback = revoke_oauth_session(&db, &cache, RevokeReason::ManualLogout).unwrap();

    assert_eq!(fallback.as_deref(), Some("ghp_pat"));
    assert_eq!(cache.lock().unwrap().as_deref(), Some("ghp_pat"));
    let (user, has_token) = load_oauth_user_snapshot(&db);
    assert!(user.is_none());
    assert!(!has_token);
    assert!(!db.is_starred("o", "r").unwrap());
    assert_eq!(viewer_upvoted(&db), None);
    assert!(db.get_starred_feed_cache("@me:alice").unwrap().is_none());
}

#[test]
fn resolve_tokens_prefer_cache_then_oauth_then_host() {
    let db = crate::db::Database::open_in_memory().unwrap();
    let cache = std::sync::Mutex::new(None);
    assert!(resolve_github_token(&db, &cache).is_none());

    db.exec_write(
        "INSERT INTO host_tokens (host, token, updated_at) VALUES ('github.com', 'ghp_pat', 1), ('codeberg.org', '  cb_tok  ', 1), ('gitlab.com', '   ', 1)",
        [],
    )
    .unwrap();
    assert_eq!(
        resolve_github_token(&db, &cache).as_deref(),
        Some("ghp_pat")
    );
    assert!(cache.lock().unwrap().is_none());

    db.set_setting(SETTING_OAUTH_TOKEN, " gho_live ").unwrap();
    assert_eq!(
        resolve_github_token(&db, &cache).as_deref(),
        Some("gho_live")
    );
    assert_eq!(cache.lock().unwrap().as_deref(), Some("gho_live"));

    use crate::forge::ForgeType;
    assert_eq!(
        resolve_host_token(&db, ForgeType::GitHub, "github.com", &cache).as_deref(),
        Some("gho_live")
    );
    assert_eq!(
        resolve_host_token(&db, ForgeType::Gitea, "codeberg.org", &cache).as_deref(),
        Some("cb_tok")
    );
    assert!(resolve_host_token(&db, ForgeType::GitLab, "gitlab.com", &cache).is_none());
}

#[test]
fn apply_star_mutation_adjusts_launchpad_only_on_flip() {
    use crate::db::LaunchpadDiscussionUpsert;

    let db = crate::db::Database::open_in_memory().unwrap();
    // 真实播种 launchpad_feed_cache 与 launchpad_discussion_cache，验证星标翻转的 ±1 增量。
    db.save_launchpad_feed_cache(
        "https://x/launchpad.json",
        r#"{"version":1,"items":[{"id":"o/r","owner":"o","repo":"r","forge":"github",
            "discussion_repo":"o/lp","discussion_number":7,
            "discussion_node_id":"D_7","discussion_comments_count":1,"discussion_upvotes":2,"stars":10}]}"#,
    )
    .unwrap();
    db.upsert_launchpad_discussion_state(&LaunchpadDiscussionUpsert {
        discussion_repo: "o/lp".to_string(),
        discussion_number: 7,
        node_id: Some("D_7".to_string()),
        upvote_count: 2,
        authoritative_upvotes: true,
        comments_count: Some(1),
        viewer_has_upvoted: None,
        stars: Some(25),
        forks: Some(3),
        latest_version: Some("v1.0.0".to_string()),
        synced_at: 100,
    })
    .unwrap();

    let lp_stars = || {
        db.get_launchpad_discussion_state("o/lp", 7)
            .unwrap()
            .and_then(|s| s.stars)
    };
    assert_eq!(lp_stars(), Some(25));

    // false -> true 且 adjust_launchpad_delta=true：星数 +1
    apply_star_mutation(&db, "o", "r", true, true);
    assert!(db.is_starred("o", "r").unwrap());
    assert_eq!(lp_stars(), Some(26));

    // 重复 true -> true（无翻转）：星数不变
    apply_star_mutation(&db, "o", "r", true, true);
    assert!(db.is_starred("o", "r").unwrap());
    assert_eq!(lp_stars(), Some(26));

    // true -> false 且 adjust_launchpad_delta=true：星数 -1
    apply_star_mutation(&db, "o", "r", false, true);
    assert!(!db.is_starred("o", "r").unwrap());
    assert_eq!(lp_stars(), Some(25));

    // 重复 false -> false（无翻转）：星数不变
    apply_star_mutation(&db, "o", "r", false, true);
    assert!(!db.is_starred("o", "r").unwrap());
    assert_eq!(lp_stars(), Some(25));

    // false -> true 但 adjust_launchpad_delta=false：只写 user_stars，不改动广场星数
    apply_star_mutation(&db, "o", "r", true, false);
    assert!(db.is_starred("o", "r").unwrap());
    assert_eq!(lp_stars(), Some(25));
}

#[tokio::test]
async fn star_endpoints_reject_traversal_and_control_segments() {
    // F-07：split_github_repo_id 与 Star 接口拒绝 `.`/`..`/控制字符/路径注入
    for bad in ["../..", "./r", "o/..", "o/.", "o\x00/r", "o/r\n"] {
        assert!(
            split_github_repo_id(bad).is_err(),
            "split_github_repo_id must reject {bad:?}"
        );
    }
    assert!(check_starred("gho_tok", "..", "emails").await.is_err());
    assert!(star_repo("gho_tok", ".", "repo").await.is_err());
    assert!(unstar_repo("gho_tok", "owner", "..").await.is_err());
    assert!(
        star::add_repo_to_star_list_with_base("gho_tok", "..", "r", "http://127.0.0.1:9")
            .await
            .is_err()
    );
    // starred_api_url 兜底编码特殊字符
    assert_eq!(
        starred_api_url("o/x", "r?y=1"),
        "https://api.github.com/user/starred/o%2Fx/r%3Fy%3D1"
    );
}

async fn spawn_graphql_mock<F>(
    handler: F,
) -> (String, std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>)
where
    F: Fn(&serde_json::Value) -> (u16, serde_json::Value) + Send + Sync + 'static,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen_clone = seen.clone();
    let handler = std::sync::Arc::new(handler);
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let mut raw = Vec::new();
            let mut tmp = [0u8; 4096];
            let mut header_end = None;
            let mut content_len: usize = 0;
            loop {
                let n = match sock.read(&mut tmp).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                raw.extend_from_slice(&tmp[..n]);
                if header_end.is_none() {
                    if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        let head = String::from_utf8_lossy(&raw[..pos]);
                        for line in head.lines() {
                            if let Some((k, v)) = line.split_once(':') {
                                if k.trim().eq_ignore_ascii_case("content-length") {
                                    content_len = v.trim().parse().unwrap_or(0);
                                }
                            }
                        }
                    }
                }
                if let Some(he) = header_end {
                    if raw.len() >= he + content_len {
                        break;
                    }
                }
            }
            let body_bytes = header_end
                .map(|he| &raw[he..(he + content_len).min(raw.len())])
                .unwrap_or(&[]);
            let req_json: serde_json::Value =
                serde_json::from_slice(body_bytes).unwrap_or(serde_json::Value::Null);
            seen_clone.lock().unwrap().push(req_json.clone());
            let (status, resp_json) = handler(&req_json);
            let status_line = match status {
                200 => "200 OK",
                500 => "500 Internal Server Error",
                _ => "400 Bad Request",
            };
            let body = resp_json.to_string();
            let resp = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        }
    });
    (format!("http://{addr}"), seen)
}

#[tokio::test]
async fn add_repo_to_star_list_paginates_lists_and_items_preserving_all_memberships() {
    // 场景：第 1 页 lists 含 z-store-list（无目标仓）与 BigList（items 有下一页，目标仓在第 2 页）；
    // 第 2 页 lists 含 Page2List（首屏即含目标仓）。最终 updateUserListsForItem 必须保留 BigList + Page2List + z-store-list。
    let (base, seen) = spawn_graphql_mock(|req| {
        let q = req.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let vars = req.get("variables");
        if q.contains("updateUserListsForItem") {
            return (
                200,
                serde_json::json!({ "data": { "updateUserListsForItem": { "clientMutationId": null } } }),
            );
        }
        if q.contains("node(id: $listId)") {
            let list_id = vars
                .and_then(|v| v.get("listId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let after = vars
                .and_then(|v| v.get("after"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if list_id == "L_BIG" && after == "ITEM_CUR_1" {
                return (
                    200,
                    serde_json::json!({
                        "data": {
                            "node": {
                                "items": {
                                    "nodes": [{ "__typename": "Repository", "id": "R_TARGET" }],
                                    "pageInfo": { "hasNextPage": false, "endCursor": null }
                                }
                            }
                        }
                    }),
                );
            }
        }
        let lists_after = vars
            .and_then(|v| v.get("listsAfter"))
            .and_then(|v| v.as_str());
        if lists_after.is_none() {
            return (
                200,
                serde_json::json!({
                    "data": {
                        "repository": { "id": "R_TARGET" },
                        "viewer": {
                            "lists": {
                                "nodes": [
                                    {
                                        "id": "L_ZSTORE",
                                        "name": "z-store-list",
                                        "items": {
                                            "nodes": [{ "__typename": "Repository", "id": "R_OTHER" }],
                                            "pageInfo": { "hasNextPage": false, "endCursor": null }
                                        }
                                    },
                                    {
                                        "id": "L_BIG",
                                        "name": "BigList",
                                        "items": {
                                            "nodes": [{ "__typename": "Repository", "id": "R_OTHER2" }],
                                            "pageInfo": { "hasNextPage": true, "endCursor": "ITEM_CUR_1" }
                                        }
                                    }
                                ],
                                "pageInfo": { "hasNextPage": true, "endCursor": "LIST_CUR_1" }
                            }
                        }
                    }
                }),
            );
        }
        if lists_after == Some("LIST_CUR_1") {
            return (
                200,
                serde_json::json!({
                    "data": {
                        "viewer": {
                            "lists": {
                                "nodes": [
                                    {
                                        "id": "L_PAGE2",
                                        "name": "Page2List",
                                        "items": {
                                            "nodes": [{ "__typename": "Repository", "id": "R_TARGET" }],
                                            "pageInfo": { "hasNextPage": false, "endCursor": null }
                                        }
                                    }
                                ],
                                "pageInfo": { "hasNextPage": false, "endCursor": null }
                            }
                        }
                    }
                }),
            );
        }
        (500, serde_json::json!({}))
    })
    .await;

    let outcome = star::add_repo_to_star_list_with_base("gho_tok", "acme", "app", &base)
        .await
        .unwrap();
    assert_eq!(outcome, AddToListOutcome::Success);

    let reqs = seen.lock().unwrap();
    let mutation = reqs
        .iter()
        .find(|r| {
            r.get("query")
                .and_then(|q| q.as_str())
                .is_some_and(|q| q.contains("updateUserListsForItem"))
        })
        .expect("must invoke updateUserListsForItem once pagination completes");
    let list_ids: Vec<&str> = mutation
        .pointer("/variables/listIds")
        .and_then(|v| v.as_array())
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(list_ids.contains(&"L_BIG"), "{list_ids:?}");
    assert!(list_ids.contains(&"L_PAGE2"), "{list_ids:?}");
    assert!(list_ids.contains(&"L_ZSTORE"), "{list_ids:?}");
}

#[tokio::test]
async fn add_repo_to_star_list_aborts_without_overwrite_on_incomplete_pagination() {
    // 场景 1：hasNextPage=true 但后续项分页 HTTP 500 → 安全中止，绝不调用 updateUserListsForItem
    let (base, seen) = spawn_graphql_mock(|req| {
        let q = req.get("query").and_then(|v| v.as_str()).unwrap_or("");
        if q.contains("node(id: $listId)") {
            return (500, serde_json::json!({}));
        }
        (
            200,
            serde_json::json!({
                "data": {
                    "repository": { "id": "R_TARGET" },
                    "viewer": {
                        "lists": {
                            "nodes": [
                                {
                                    "id": "L_ZSTORE",
                                    "name": "z-store-list",
                                    "items": {
                                        "nodes": [],
                                        "pageInfo": { "hasNextPage": false, "endCursor": null }
                                    }
                                },
                                {
                                    "id": "L_BIG",
                                    "name": "BigList",
                                    "items": {
                                        "nodes": [],
                                        "pageInfo": { "hasNextPage": true, "endCursor": "CUR_1" }
                                    }
                                }
                            ],
                            "pageInfo": { "hasNextPage": false, "endCursor": null }
                        }
                    }
                }
            }),
        )
    })
    .await;

    let outcome = star::add_repo_to_star_list_with_base("gho_tok", "acme", "app", &base)
        .await
        .unwrap();
    assert!(matches!(outcome, AddToListOutcome::Failed(_)), "{outcome:?}");
    {
        let reqs = seen.lock().unwrap();
        assert!(
            !reqs.iter().any(|r| r
                .get("query")
                .and_then(|q| q.as_str())
                .is_some_and(|q| q.contains("updateUserListsForItem"))),
            "must NEVER overwrite listIds when pagination fails"
        );
    }

    // 场景 2：lists hasNextPage=true 但缺失 endCursor → 安全中止
    let (base2, seen2) = spawn_graphql_mock(|_| {
        (
            200,
            serde_json::json!({
                "data": {
                    "repository": { "id": "R_TARGET" },
                    "viewer": {
                        "lists": {
                            "nodes": [],
                            "pageInfo": { "hasNextPage": true, "endCursor": null }
                        }
                    }
                }
            }),
        )
    })
    .await;
    let outcome2 = star::add_repo_to_star_list_with_base("gho_tok", "acme", "app", &base2)
        .await
        .unwrap();
    assert!(
        matches!(outcome2, AddToListOutcome::Failed(_)),
        "{outcome2:?}"
    );
    assert_eq!(seen2.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn add_repo_to_star_list_skips_mutation_when_already_in_target_list() {
    let (base, seen) = spawn_graphql_mock(|_| {
        (
            200,
            serde_json::json!({
                "data": {
                    "repository": { "id": "R_TARGET" },
                    "viewer": {
                        "lists": {
                            "nodes": [
                                {
                                    "id": "L_ZSTORE",
                                    "name": "z-store-list",
                                    "items": {
                                        "nodes": [{ "__typename": "Repository", "id": "R_TARGET" }],
                                        "pageInfo": { "hasNextPage": false, "endCursor": null }
                                    }
                                },
                                {
                                    "id": "L_BIG",
                                    "name": "BigList",
                                    "items": {
                                        "nodes": [],
                                        "pageInfo": { "hasNextPage": true, "endCursor": "CUR_1" }
                                    }
                                }
                            ],
                            "pageInfo": { "hasNextPage": false, "endCursor": null }
                        }
                    }
                }
            }),
        )
    })
    .await;

    let outcome = star::add_repo_to_star_list_with_base("gho_tok", "acme", "app", &base)
        .await
        .unwrap();
    assert_eq!(outcome, AddToListOutcome::Success);
    assert_eq!(seen.lock().unwrap().len(), 1);
}
