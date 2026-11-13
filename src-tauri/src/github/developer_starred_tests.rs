#[cfg(test)]
mod tests {
    use crate::github::developer_starred::test_support::*;
    use crate::github::developer_starred::{
        link_has_next, parse_starred_payloads, starred_page_url, STARRED_PAGE_MAX,
    };
    use std::collections::HashMap;

    #[test]
    fn page_url_targets_self_or_named_user() {
        assert_eq!(
            starred_page_url(None, true, 2, 20).unwrap(),
            "https://api.github.com/user/starred?per_page=20&page=2"
        );
        assert_eq!(
            starred_page_url(Some("  "), true, 1, 20).unwrap(),
            "https://api.github.com/user/starred?per_page=20&page=1"
        );
        assert_eq!(
            starred_page_url(Some(" octocat "), true, 3, 20).unwrap(),
            "https://api.github.com/users/octocat/starred?per_page=20&page=3"
        );
        assert!(starred_page_url(None, false, 1, 20).is_err());
    }

    #[test]
    fn page_url_clamps_page_and_size() {
        assert_eq!(
            starred_page_url(Some("u"), false, 0, 0).unwrap(),
            "https://api.github.com/users/u/starred?per_page=1&page=1"
        );
        assert_eq!(
            starred_page_url(Some("u"), false, 1, 500).unwrap(),
            format!(
                "https://api.github.com/users/u/starred?per_page={}&page=1",
                STARRED_PAGE_MAX
            )
        );
    }

    #[test]
    fn link_header_next_detection() {
        let mid = r#"<https://api.github.com/user/starred?page=3>; rel="next", <https://api.github.com/user/starred?page=9>; rel="last""#;
        let last = r#"<https://api.github.com/user/starred?page=1>; rel="first", <https://api.github.com/user/starred?page=8>; rel="prev""#;
        assert!(link_has_next(Some(mid)));
        assert!(!link_has_next(Some(last)));
        assert!(!link_has_next(None));
    }

    #[test]
    fn payloads_keep_order_and_skip_malformed() {
        let body = serde_json::json!([
            {"name": "B", "full_name": "Acme/B", "description": "b"},
            {"name": "x"},
            {"name": "c", "full_name": "acme/c"}
        ])
        .to_string();
        let items = parse_starred_payloads(&body).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].coord.id, "acme/b");
        assert_eq!(items[0].coord.owner, "Acme");
        assert_eq!(items[0].coord.repo, "B");
        assert!(items[0].payload.contains("\"description\":\"b\""));
        assert_eq!(items[1].coord.id, "acme/c");
        assert!(parse_starred_payloads("not-json").is_err());
    }

    #[tokio::test]
    async fn fetch_page_single_request_for_named_user() {
        let mut routes = HashMap::new();
        routes.insert(
            "/users/testuser/starred?per_page=20&page=2".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: serde_json::json!([
                    {"name": "r1", "full_name": "o1/r1", "description": "d1",
                     "stargazers_count": 7u64, "language": "Rust"},
                    {"name": "r2", "full_name": "o2/r2", "description": "d2"}
                ])
                .to_string(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let page = test_service()
            .fetch_starred_page(Some("testuser"), None, 2, 20, Some(&srv.base))
            .await
            .unwrap();
        let ids: Vec<&str> = page.repos.iter().map(|r| r.coord.id.as_str()).collect();
        assert_eq!(ids, vec!["o1/r1", "o2/r2"]);
        // mock 不发 Link 头：视为最后一页。
        assert!(!page.has_more);
        // 只请求了列表本身，未逐仓探测 release。
        let seen = srv.seen_inm.lock().unwrap();
        assert_eq!(seen.len(), 1);
    }

    #[tokio::test]
    async fn fetch_page_maps_404_to_user_hint() {
        let srv = spawn_mock(HashMap::new()).await;
        let err = test_service()
            .fetch_starred_page(Some("ghost"), None, 1, 20, Some(&srv.base))
            .await
            .err()
            .unwrap();
        assert!(err.contains("ghost"), "{}", err);
    }
}
