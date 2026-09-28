#[cfg(test)]
use super::developer_endpoints::STARRED_RELEASE_ENRICH_LIMIT;

#[cfg(test)]
mod tests {
    use super::super::CatalogService;
    use crate::github::developer_starred::test_support::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    #[tokio::test]
    async fn test_starred_non_catalog_release_truthful_and_404_fallback() {
        let mut routes = HashMap::new();
        routes.insert(
            "/users/testuser/starred?per_page=100".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: None,
                body: serde_json::json!([
                    {"name": "r1", "full_name": "o1/r1",
                     "html_url": "https://github.com/o1/r1", "description": "d1",
                     "stargazers_count": 7u64, "forks_count": 2u64, "language": "Rust"},
                    {"name": "r2", "full_name": "o2/r2",
                     "html_url": "https://github.com/o2/r2", "description": "d2",
                     "stargazers_count": 3u64, "forks_count": 0u64, "language": "Go"}
                ])
                .to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o1/r1/releases/latest".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"rel-etag-1\"".to_string()),
                body: serde_json::json!({"tag_name": "v9.9.9", "body": "notes", "assets": []})
                    .to_string(),
                honor_inm: None,
            },
        );
        routes.insert(
            "/repos/o2/r2/releases/latest".to_string(),
            MockResp {
                status: 404,
                reason: "Not Found",
                etag: None,
                body: "{}".to_string(),
                honor_inm: None,
            },
        );
        let srv = spawn_mock(routes).await;
        let svc = test_service();
        let mut cache: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        let result = svc
            .sync_starred_repos_with_cache(Some("testuser"), None, &mut cache, Some(&srv.base))
            .await
            .unwrap();
        assert_eq!(result.total_starred, 2);
        assert_eq!(result.other_repos.len(), 2);
        let r1 = result
            .other_repos
            .iter()
            .find(|r| r.full_name == "o1/r1")
            .unwrap();
        assert!(r1.has_releases);
        assert_eq!(r1.latest_release_tag.as_deref(), Some("v9.9.9"));
        // API 请求失败 (404) 时保持原有行为：返回 false 且无 tag，不触发 panic。
        let r2 = result
            .other_repos
            .iter()
            .find(|r| r.full_name == "o2/r2")
            .unwrap();
        assert!(!r2.has_releases);
        assert!(r2.latest_release_tag.is_none());
        // 全新的 200 响应填充缓存优先映射表，加速后续的低成本重新同步。
        let key = CatalogService::starred_release_endpoint("o1/r1");
        let entry = cache.get(&key).unwrap();
        assert_eq!(entry.0.as_deref(), Some("\"rel-etag-1\""));
        assert!(entry.1.as_ref().unwrap().contains("v9.9.9"));
    }

    #[tokio::test]
    async fn test_starred_release_cache_first_no_refetch() {
        let release_hits = Arc::new(AtomicUsize::new(0));
        let hits_c = release_hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{}", port);
        let starred_body = serde_json::json!([
            {"name": "r1", "full_name": "o1/r1",
             "html_url": "https://github.com/o1/r1", "description": "d1",
             "stargazers_count": 7u64, "forks_count": 2u64, "language": "Rust"}
        ])
        .to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let starred_body = starred_body.clone();
                let hits_c = hits_c.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                    let mut reader = tokio::io::BufReader::new(&mut sock);
                    let mut req_line = String::new();
                    if reader.read_line(&mut req_line).await.is_err() {
                        return;
                    }
                    let path = req_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.is_err() {
                            return;
                        }
                        if line == "\r\n" || line == "\n" || line.trim().is_empty() {
                            break;
                        }
                    }
                    let body = if path.starts_with("/repos/") {
                        // 若“缓存优先”机制正常工作，此处绝不会被触发；若触发则返回 500 以证明是缓存数据（而非网络请求）决定了结果。
                        hits_c.fetch_add(1, Ordering::SeqCst);
                        "boom".to_string()
                    } else {
                        starred_body
                    };
                    let status = if path.starts_with("/repos/") {
                        "HTTP/1.1 500 Internal Server Error"
                    } else {
                        "HTTP/1.1 200 OK"
                    };
                    let resp = format!(
                        "{}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                        status,
                        body.len(),
                        body
                    );
                    let _ = reader.into_inner().write_all(resp.as_bytes()).await;
                });
            }
        });
        let svc = test_service();
        let key = CatalogService::starred_release_endpoint("o1/r1");
        let mut cache: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        cache.insert(
            key,
            (
                Some("\"cached-rel-etag\"".to_string()),
                Some(
                    serde_json::json!({"tag_name": "v1.0.0", "body": "", "assets": []}).to_string(),
                ),
            ),
        );
        let result = svc
            .sync_starred_repos_with_cache(Some("testuser"), None, &mut cache, Some(&base))
            .await
            .unwrap();
        let r1 = result
            .other_repos
            .iter()
            .find(|r| r.full_name == "o1/r1")
            .unwrap();
        assert!(r1.has_releases);
        assert_eq!(r1.latest_release_tag.as_deref(), Some("v1.0.0"));
        assert_eq!(
            release_hits.load(Ordering::SeqCst),
            0,
            "cache-first: cached release must not hit network"
        );
    }

    #[tokio::test]
    async fn test_starred_release_fanout_capped() {
        let release_hits = Arc::new(AtomicUsize::new(0));
        let hits_c = release_hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{}", port);
        let n = super::STARRED_RELEASE_ENRICH_LIMIT + 5;
        let mut starred = Vec::new();
        for i in 0..n {
            starred.push(serde_json::json!(
                {"name": format!("r{}", i), "full_name": format!("o/r{}", i),
                 "html_url": format!("https://github.com/o/r{}", i),
                 "stargazers_count": 1u64, "forks_count": 0u64}
            ));
        }
        let starred_body = serde_json::Value::Array(starred).to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let starred_body = starred_body.clone();
                let hits_c = hits_c.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                    let mut reader = tokio::io::BufReader::new(&mut sock);
                    let mut req_line = String::new();
                    if reader.read_line(&mut req_line).await.is_err() {
                        return;
                    }
                    let path = req_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.is_err() {
                            return;
                        }
                        if line == "\r\n" || line == "\n" || line.trim().is_empty() {
                            break;
                        }
                    }
                    let (status, body) = if path.starts_with("/repos/") {
                        hits_c.fetch_add(1, Ordering::SeqCst);
                        (
                            "HTTP/1.1 200 OK",
                            serde_json::json!({"tag_name": "v2.0.0", "body": "", "assets": []})
                                .to_string(),
                        )
                    } else {
                        ("HTTP/1.1 200 OK", starred_body)
                    };
                    let resp = format!(
                        "{}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                        status,
                        body.len(),
                        body
                    );
                    let _ = reader.into_inner().write_all(resp.as_bytes()).await;
                });
            }
        });
        // 客户端发起请求前，给予 mock 服务短暂的端口绑定就绪时间。
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let svc = test_service();
        let mut cache: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        let result = svc
            .sync_starred_repos_with_cache(Some("testuser"), None, &mut cache, Some(&base))
            .await
            .unwrap();
        assert_eq!(result.other_repos.len(), n);
        assert!(
            release_hits.load(Ordering::SeqCst) <= super::STARRED_RELEASE_ENRICH_LIMIT,
            "quota guard: release lookups capped at STARRED_RELEASE_ENRICH_LIMIT"
        );
        // 超出上限的仓库保持原有行为（false，安装状态未知），不再发起网络请求。
        let enriched = result.other_repos.iter().filter(|r| r.has_releases).count();
        assert!(enriched <= super::STARRED_RELEASE_ENRICH_LIMIT);
    }
}
