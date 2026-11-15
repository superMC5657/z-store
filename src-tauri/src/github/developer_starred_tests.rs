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
            .fetch_starred_page(Some("testuser"), None, 2, 20, None, None, Some(&srv.base))
            .await
            .unwrap()
            .page;
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
            .fetch_starred_page(Some("ghost"), None, 1, 20, None, None, Some(&srv.base))
            .await
            .err()
            .unwrap();
        assert!(err.contains("ghost"), "{}", err);
    }

    fn starred_body(n: usize) -> String {
        let items: Vec<serde_json::Value> = (0..n)
            .map(|i| {
                serde_json::json!({
                    "name": format!("r{}", i),
                    "full_name": format!("o/r{}", i),
                    "description": "d"
                })
            })
            .collect();
        serde_json::Value::Array(items).to_string()
    }

    #[tokio::test]
    async fn fetch_page_etag_roundtrip_and_full_page_304_keeps_has_more() {
        let path = "/users/alice/starred?per_page=2&page=1".to_string();
        let mut routes = HashMap::new();
        routes.insert(
            path.clone(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"s1\"".to_string()),
                body: starred_body(2),
                honor_inm: Some("\"s1\"".to_string()),
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let first = svc
            .fetch_starred_page(Some("alice"), None, 1, 2, None, None, Some(&srv.base))
            .await
            .unwrap();
        let (url, etag, text) = first.etag_write.expect("etag to persist");
        assert_eq!(
            url,
            "https://api.github.com/users/alice/starred?per_page=2&page=1"
        );
        assert_eq!(etag, "\"s1\"");
        assert!(first.touched_url.is_none());
        assert_eq!(first.page.repos.len(), 2);
        // mock 不发 Link：200 时按最后一页处理。
        assert!(!first.page.has_more);

        let second = svc
            .fetch_starred_page(
                Some("alice"),
                None,
                1,
                2,
                Some(&etag),
                Some(&text),
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(
            srv.seen_inm.lock().unwrap().get(&path).cloned().flatten(),
            Some("\"s1\"".to_string())
        );
        assert!(second.etag_write.is_none());
        assert_eq!(second.touched_url.as_deref(), Some(url.as_str()));
        assert_eq!(second.is_stale, None);
        assert_eq!(second.page.repos.len(), 2);
        // 304 省略 Link 时满页视为还有下一页。
        assert!(second.page.has_more);
    }

    #[tokio::test]
    async fn fetch_page_skips_etag_without_usable_payload() {
        let path = "/users/alice/starred?per_page=20&page=1".to_string();
        let mut routes = HashMap::new();
        routes.insert(
            path.clone(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"s1\"".to_string()),
                body: starred_body(1),
                honor_inm: Some("\"s1\"".to_string()),
            },
        );
        let srv = spawn_mock(routes).await;
        let out = test_service()
            .fetch_starred_page(
                Some("alice"),
                None,
                1,
                20,
                Some("\"s1\""),
                Some("corrupt"),
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(
            srv.seen_inm.lock().unwrap().get(&path).cloned().flatten(),
            None
        );
        assert!(out.etag_write.is_some());
        assert_eq!(out.page.repos.len(), 1);
    }

    #[tokio::test]
    async fn fetch_page_falls_back_to_cached_payload_on_5xx() {
        let path = "/users/alice/starred?per_page=20&page=1".to_string();
        let mut routes = HashMap::new();
        routes.insert(
            path.clone(),
            MockResp {
                status: 500,
                reason: "Internal Server Error",
                etag: None,
                body: "{}".to_string(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let cached = starred_body(3);
        let out = test_service()
            .fetch_starred_page(
                Some("alice"),
                None,
                1,
                20,
                Some("\"old\""),
                Some(&cached),
                Some(&srv.base),
            )
            .await
            .unwrap();
        assert_eq!(out.is_stale, Some(true));
        assert_eq!(out.page.repos.len(), 3);
        assert!(!out.page.has_more);
        assert!(out.etag_write.is_none() && out.touched_url.is_none());

        // 无旧载荷时上浮错误。
        let err = test_service()
            .fetch_starred_page(Some("alice"), None, 1, 20, None, None, Some(&srv.base))
            .await
            .err()
            .unwrap();
        assert!(err.contains("500"), "{}", err);
    }

    #[tokio::test]
    async fn fetch_page_404_never_falls_back() {
        let srv = spawn_mock(HashMap::new()).await;
        let cached = starred_body(1);
        let err = test_service()
            .fetch_starred_page(
                Some("ghost"),
                None,
                1,
                20,
                Some("\"old\""),
                Some(&cached),
                Some(&srv.base),
            )
            .await
            .err()
            .unwrap();
        assert!(err.contains("ghost"), "{}", err);
    }
}
