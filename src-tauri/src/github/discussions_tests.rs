use super::*;
use crate::test_support::{dead_addr, serve, Reply};

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[test]
fn repo_coordinates_are_strictly_validated() {
    assert_eq!(
        validate_discussion_repo("superMC5657/z-store-launchpad").unwrap(),
        ("supermc5657".to_string(), "z-store-launchpad".to_string())
    );
    for bad in [
        "",
        "   ",
        "single",
        "a/b/c",
        "../etc",
        "a/..",
        "a/b?x=1",
        "a/b#frag",
        "codeberg:a/b",
        "https://github.com/a/b",
        "a/b\u{0}",
        "a /b",
        "/b",
        "a/",
    ] {
        assert!(validate_discussion_repo(bad).is_err(), "{bad:?} should be rejected");
    }
    assert!(validate_discussion_number(0).is_err());
    assert_eq!(validate_discussion_number(7).unwrap(), 7);
}

fn sample_graphql(can_upvote: bool, locked: bool) -> serde_json::Value {
    let raw = r#"{
      "repository": { "discussion": {
        "id": "D_1", "number": 7, "title": "HyperTerm", "body": "**hi**",
        "url": "https://github.com/o/r/discussions/7", "createdAt": "2027-01-01T00:00:00Z",
        "locked": "__LOCKED__", "closed": false,
        "category": { "name": "Launches" },
        "author": { "login": "acme", "avatarUrl": "https://avatars.githubusercontent.com/u/1", "url": "https://github.com/acme" },
        "upvoteCount": 12, "viewerCanUpvote": "__CAN__", "viewerHasUpvoted": true,
        "reactionGroups": [
          { "content": "HEART", "viewerHasReacted": true, "reactors": { "totalCount": 99 } },
          { "content": "THUMBS_UP", "viewerHasReacted": false, "reactors": { "totalCount": 5 } }
        ],
        "comments": {
          "totalCount": 31,
          "pageInfo": { "hasNextPage": true, "endCursor": "Y3Vyc29y" },
          "nodes": [{
            "id": "DC_1", "body": "nice", "createdAt": "2027-01-02T00:00:00Z",
            "authorAssociation": "NONE",
            "author": { "login": "bob", "avatarUrl": "data:image/png;base64,AA", "url": "https://github.com/bob" },
            "upvoteCount": 2, "viewerHasUpvoted": false,
            "replies": { "nodes": [{
              "id": "DC_2", "body": "thanks", "createdAt": "2027-01-03T00:00:00Z",
              "authorAssociation": "OWNER", "author": { "login": "acme", "avatarUrl": "", "url": "" },
              "upvoteCount": 0, "viewerHasUpvoted": false
            }]}
          }, {
            "id": "DC_3", "body": "ghost", "createdAt": "2027-01-04T00:00:00Z",
            "authorAssociation": "NONE", "author": null, "upvoteCount": 0, "viewerHasUpvoted": false,
            "replies": { "nodes": [] }
          }]
        }
      }}
    }"#;
    serde_json::from_str(
        &raw.replace("\"__CAN__\"", &can_upvote.to_string())
            .replace("\"__LOCKED__\"", &locked.to_string()),
    )
    .unwrap()
}

#[test]
fn graphql_discussion_with_nested_replies_parses() {
    let d = parse_graphql_discussion(&sample_graphql(true, false)).unwrap();
    assert_eq!(d.id, "D_1");
    assert_eq!(d.category_name, "Launches");
    assert_eq!((d.upvote_count, d.viewer_has_upvoted), (12, true));
    assert!(d.viewer_can_comment && !d.auth_required_for_write);
    assert_eq!(d.comments_total, 31);
    assert!(d.has_next_page);
    assert_eq!(d.end_cursor.as_deref(), Some("Y3Vyc29y"));
    assert_eq!(d.comments.len(), 2);
    assert_eq!(d.comments[0].replies.len(), 1);
    assert_eq!(d.comments[0].replies[0].author_association, "OWNER");
    assert_eq!(
        d.comments[0].author.as_ref().unwrap().avatar_url,
        "",
        "data: avatar stripped"
    );
    assert!(d.comments[1].author.is_none());
}

#[test]
fn locked_discussion_disables_commenting_and_reaction_count_used_without_upvote() {
    let d = parse_graphql_discussion(&sample_graphql(false, true)).unwrap();
    assert!(d.locked);
    assert!(!d.viewer_can_comment);
    assert_eq!((d.upvote_count, d.viewer_has_upvoted), (5, false));
}

#[test]
fn graphql_error_mapping() {
    let scopes = json!({ "errors": [{ "type": "INSUFFICIENT_SCOPES", "message": "x" }] });
    assert_eq!(map_graphql_response(&scopes).unwrap_err(), GqlError::InsufficientScopes);
    let forbidden = json!({ "errors": [{ "type": "FORBIDDEN", "message": "nope" }] });
    assert!(matches!(map_graphql_response(&forbidden), Err(GqlError::Forbidden(_))));
    let integ = json!({ "errors": [{ "message": "Resource not accessible by integration" }] });
    assert!(matches!(map_graphql_response(&integ), Err(GqlError::Forbidden(_))));
    let other = json!({ "errors": [{ "type": "NOT_FOUND", "message": "gone" }] });
    assert_eq!(
        map_graphql_response(&other).unwrap_err(),
        GqlError::Other("gone".to_string())
    );
    assert!(map_graphql_response(&json!({ "data": null })).is_err());
    assert!(GqlError::InsufficientScopes.into_message().contains("重新登录"));
}

#[test]
fn vote_results_parse_for_both_modes() {
    let up = json!({ "addUpvote": { "subject": { "id": "D_1", "upvoteCount": 13, "viewerHasUpvoted": true } } });
    let r = parse_vote_result(&up, "addUpvote", "upvote").unwrap();
    assert_eq!((r.upvote_count, r.viewer_has_upvoted, r.mode.as_str()), (13, true, "upvote"));
    let re = json!({ "addReaction": { "subject": { "id": "D_1", "reactionGroups": [
        { "content": "THUMBS_UP", "viewerHasReacted": true, "reactors": { "totalCount": 6 } }
    ] } } });
    let r = parse_vote_result(&re, "addReaction", "reaction").unwrap();
    assert_eq!((r.upvote_count, r.viewer_has_upvoted, r.mode.as_str()), (6, true, "reaction"));
}

#[test]
fn comment_body_limits() {
    assert!(validate_comment_body("   ").is_err());
    assert!(validate_comment_body(&"字".repeat(COMMENT_MAX_CHARS + 1)).is_err());
    assert_eq!(validate_comment_body("  hi  ").unwrap(), "hi");
    assert!(validate_comment_body(&"字".repeat(COMMENT_MAX_CHARS)).is_ok());
}

#[tokio::test]
async fn forbidden_upvote_falls_back_to_thumbs_up_reaction() {
    let server = serve(|req| {
        if req.contains("addUpvote") {
            Reply::ok(r#"{"errors":[{"type":"FORBIDDEN","message":"Upvoting disabled"}]}"#)
        } else if req.contains("addReaction") {
            Reply::ok(
                r#"{"data":{"addReaction":{"subject":{"id":"D_1","reactionGroups":[{"content":"THUMBS_UP","viewerHasReacted":true,"reactors":{"totalCount":4}}]}}}}"#,
            )
        } else {
            Reply::status("500 Internal Server Error")
        }
    })
    .await;
    let r = toggle_upvote(&client(), &server.base, "tok", "o", "r", 7, Some("D_1"), false)
        .await
        .unwrap();
    assert_eq!(r.mode, "reaction");
    assert_eq!((r.upvote_count, r.viewer_has_upvoted), (4, true));
    assert_eq!(server.hits(), 2);
    let first = &server.requests()[0];
    assert!(first.to_ascii_lowercase().contains("authorization: bearer tok"));
}

#[tokio::test]
async fn preflight_without_subject_uses_reaction_when_upvote_unavailable() {
    let server = serve(|req| {
        if req.contains("removeReaction") {
            Reply::ok(
                r#"{"data":{"removeReaction":{"subject":{"id":"D_9","reactionGroups":[{"content":"THUMBS_UP","viewerHasReacted":false,"reactors":{"totalCount":0}}]}}}}"#,
            )
        } else {
            Reply::ok(
                r#"{"data":{"repository":{"discussion":{"id":"D_9","locked":false,"viewerCanUpvote":false}}}}"#,
            )
        }
    })
    .await;
    let r = toggle_upvote(&client(), &server.base, "tok", "o", "r", 9, None, true)
        .await
        .unwrap();
    assert_eq!(r.subject_id, "D_9");
    assert_eq!(r.mode, "reaction");
    assert!(!r.viewer_has_upvoted);
}

#[tokio::test]
async fn add_comment_on_locked_discussion_is_refused() {
    let server = serve(|_| {
        Reply::ok(
            r#"{"data":{"repository":{"discussion":{"id":"D_1","locked":true,"viewerCanUpvote":true}}}}"#,
        )
    })
    .await;
    let err = add_comment(&client(), &server.base, "tok", "o", "r", 1, None, "hi", None)
        .await
        .unwrap_err();
    assert!(err.contains("锁定"));
    assert_eq!(server.hits(), 1);
}

#[test]
fn rest_discussion_parses_read_only() {
    let d = r#"{"node_id":"D_1","number":7,"title":"T","body":"b","html_url":"",
        "created_at":"2027-01-01T00:00:00Z","locked":false,"state":"open","comments":3,
        "user":{"login":"acme","avatar_url":"https://a/1","html_url":"https://github.com/acme"},
        "category":{"name":"Launches"},"reactions":{"+1":4,"total_count":5}}"#;
    let c = r#"[{"node_id":"DC_1","body":"c","created_at":"x","author_association":"NONE",
        "user":{"login":"bob","avatar_url":"https://a/2","html_url":""},"reactions":{"+1":1}}]"#;
    let detail = parse_rest_discussion("o", "r", 7, d, Some(c)).unwrap();
    assert!(detail.auth_required_for_write);
    assert!(!detail.viewer_can_comment && !detail.viewer_can_upvote);
    assert_eq!(detail.url, "https://github.com/o/r/discussions/7");
    assert_eq!(detail.upvote_count, 4);
    assert_eq!(detail.comments_total, 3);
    assert!(detail.has_next_page);
    assert_eq!(detail.comments[0].upvote_count, 1);
}

#[tokio::test]
async fn anonymous_rate_limited_without_cache_returns_shell() {
    let server = serve(|_| Reply::status("403 Forbidden")).await;
    let db = Mutex::new(Database::open_in_memory().unwrap());
    let d = fetch_discussion_anonymous(&db, &client(), Some(&server.base), "o", "r", 7, false).await;
    assert!(d.auth_required_for_write);
    assert!(d.is_stale);
    assert_eq!(d.url, "https://github.com/o/r/discussions/7");
    assert!(d.comments.is_empty());
}

#[tokio::test]
async fn anonymous_failure_reuses_cached_payload_as_stale() {
    let db = Mutex::new(Database::open_in_memory().unwrap());
    {
        let g = db.lock().unwrap();
        g.save_etag(
            &rest_discussion_url("o", "r", 7),
            "W/\"d\"",
            r#"{"node_id":"D_1","number":7,"title":"Cached","body":"","comments":0}"#,
            1,
        )
        .unwrap();
    }
    let base = format!("http://{}", dead_addr());
    let d = fetch_discussion_anonymous(&db, &client(), Some(&base), "o", "r", 7, false).await;
    assert_eq!(d.title, "Cached");
    assert!(d.is_stale);
    assert!(d.auth_required_for_write);
}
