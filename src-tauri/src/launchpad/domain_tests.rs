//! 广场领域接口测试：清单装载（304 / 镜像 / 快照降级）、本地水合、脉冲同步与讨论写透。

use super::feed::{hydrate_entries, is_id_in_snapshot, load_launchpad_manifest};
use super::preflight::resolve_preflight_icon;
use super::pulse::sync_discussions;
use crate::db::Database;
use crate::icons::verify_custom_icon_d8;
use crate::test_support::{dead_addr, serve, Reply};
use std::sync::Mutex;

const MANIFEST: &str = r#"{
  "version": 1,
  "generated_at": "2027-01-15T00:00:00Z",
  "pinned": [],
  "items": [
    {"id": "acme/hyper-term", "name": "HyperTerm", "owner": "acme", "repo": "hyper-term",
     "forge": "github", "forge_host": "github.com", "icon": "data:image/png;base64,AAAA",
     "maker_note": "hi", "launched_at": "2027-01-10T00:00:00Z"},
    {"id": "rustdesk/rustdesk", "name": "RustDesk", "owner": "rustdesk", "repo": "rustdesk",
     "forge": "github", "forge_host": "github.com", "icon": "",
     "maker_note": "remote", "launched_at": "2027-01-09T00:00:00Z"}
  ]
}"#;

const URL_PATH: &str = "/launchpad.json";

fn mem_db() -> Mutex<Database> {
    Mutex::new(Database::open_in_memory().unwrap())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

fn count(db: &Database, table: &str) -> i64 {
    db.query_scalar_opt(&format!("SELECT COUNT(*) FROM {table}"), [])
        .unwrap()
        .unwrap_or(0)
}

#[tokio::test]
async fn fresh_200_persists_snapshot_and_etag() {
    let server = serve(|_| Reply::ok(MANIFEST).header("ETag", "W/\"v1\"")).await;
    let url = format!("{}{}", server.base, URL_PATH);
    let db = mem_db();
    let load = load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .unwrap();
    assert!(!load.is_stale);
    assert_eq!(load.manifest.items.len(), 2);
    assert_eq!(
        load.manifest.items[0].icon, "",
        "data: icon stripped before persisting"
    );
    let guard = db.lock().unwrap();
    assert_eq!(guard.get_etag(&url).unwrap().as_deref(), Some("W/\"v1\""));
    let (payload, _) = guard.get_launchpad_feed_cache(&url).unwrap().unwrap();
    assert!(!payload.contains("data:image"));
}

#[tokio::test]
async fn not_modified_reuses_snapshot_without_rewriting_payload() {
    let server = serve(|req| {
        if req.to_ascii_lowercase().contains("if-none-match") {
            Reply::status("304 Not Modified")
        } else {
            Reply::ok(MANIFEST).header("ETag", "W/\"v1\"")
        }
    })
    .await;
    let url = format!("{}{}", server.base, URL_PATH);
    let db = mem_db();
    load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .unwrap();
    let before = db
        .lock()
        .unwrap()
        .get_launchpad_feed_cache(&url)
        .unwrap()
        .unwrap()
        .0;

    let load = load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .unwrap();
    assert!(!load.is_stale);
    assert_eq!(load.manifest.items.len(), 2);
    assert_eq!(server.hits(), 2);
    assert!(server.requests()[1]
        .to_ascii_lowercase()
        .contains("if-none-match: w/\"v1\""));
    let after = db
        .lock()
        .unwrap()
        .get_launchpad_feed_cache(&url)
        .unwrap()
        .unwrap()
        .0;
    assert_eq!(before, after);
}

#[tokio::test]
async fn force_refresh_skips_conditional_header() {
    let server = serve(|_| Reply::ok(MANIFEST).header("ETag", "W/\"v1\"")).await;
    let url = format!("{}{}", server.base, URL_PATH);
    let db = mem_db();
    load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .unwrap();
    load_launchpad_manifest(&db, &client(), &url, None, true)
        .await
        .unwrap();
    assert!(!server.requests()[1]
        .to_ascii_lowercase()
        .contains("if-none-match"));
}

#[tokio::test]
async fn upstream_failure_falls_back_to_stale_snapshot() {
    let url = format!("http://{}{}", dead_addr(), URL_PATH);
    let db = mem_db();
    db.lock()
        .unwrap()
        .save_launchpad_feed_cache(&url, MANIFEST)
        .unwrap();
    let load = load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .unwrap();
    assert!(load.is_stale);
    assert_eq!(load.manifest.items.len(), 2);
}

#[tokio::test]
async fn malformed_json_and_5xx_without_snapshot_error_out() {
    let server = serve(|_| Reply::ok("<html>portal</html>")).await;
    let url = format!("{}{}", server.base, URL_PATH);
    let db = mem_db();
    assert!(load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .is_err());

    let server = serve(|_| Reply::status("500 Internal Server Error")).await;
    let url = format!("{}{}", server.base, URL_PATH);
    assert!(load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .is_err());
}

#[tokio::test]
async fn malformed_json_keeps_previous_snapshot() {
    let server = serve(|_| Reply::ok("{\"version\": 9}")).await;
    let url = format!("{}{}", server.base, URL_PATH);
    let db = mem_db();
    db.lock()
        .unwrap()
        .save_launchpad_feed_cache(&url, MANIFEST)
        .unwrap();
    let load = load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .unwrap();
    assert!(load.is_stale);
    let (payload, _) = db
        .lock()
        .unwrap()
        .get_launchpad_feed_cache(&url)
        .unwrap()
        .unwrap();
    assert_eq!(payload, MANIFEST);
}

#[tokio::test]
async fn oversized_payload_is_rejected() {
    let huge = format!(
        "{{\"version\":1,\"items\":[],\"pad\":\"{}\"}}",
        "x".repeat(crate::db::launchpad::LAUNCHPAD_FEED_CACHE_MAX_BYTES)
    );
    let server = serve(move |_| Reply::ok(huge.clone())).await;
    let url = format!("{}{}", server.base, URL_PATH);
    let db = mem_db();
    assert!(load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .is_err());
    assert!(db
        .lock()
        .unwrap()
        .get_launchpad_feed_cache(&url)
        .unwrap()
        .is_none());
}

#[test]
fn hydration_never_touches_catalog_tables_and_stamps_cataloged_items() {
    let db = Database::open_in_memory().unwrap();
    let catalog = crate::github::CatalogService::new_empty();
    let seeded: crate::github::models::CatalogItem = serde_json::from_value(serde_json::json!({
        "id": "rustdesk/rustdesk", "name": "RustDesk", "owner": "rustdesk", "repo": "rustdesk",
        "icon": "", "icon_bg": "", "description": "", "category": "network",
        "category_name": "网络", "aliases": [], "default_version": "latest", "license": "AGPL-3.0",
        "stars": 1, "forks": 0, "is_verified": true, "platforms": ["windows"]
    }))
    .unwrap();
    catalog.update_items(vec![seeded]);
    let catalog_rows = count(&db, "catalog_apps");
    let custom_rows = count(&db, "custom_apps");

    let manifest =
        crate::launchpad::sanitize_manifest(crate::launchpad::parse_manifest(MANIFEST).unwrap());
    let (_, mut items) = crate::launchpad::partition_spotlight_and_recent(&manifest, 0);
    hydrate_entries(&db, &catalog, &mut items, false, 0);

    assert_eq!(count(&db, "catalog_apps"), catalog_rows);
    assert_eq!(count(&db, "custom_apps"), custom_rows);
    assert!(db.get_repo_card("acme/hyper-term").unwrap().is_some());
    assert!(db.get_repo_card("rustdesk/rustdesk").unwrap().is_none());
    let rd = items
        .iter()
        .find(|e| e.summary.core.id == "rustdesk/rustdesk")
        .unwrap();
    assert_eq!(rd.summary.core.is_cataloged, Some(true));
    let ht = items
        .iter()
        .find(|e| e.summary.core.id == "acme/hyper-term")
        .unwrap();
    assert_ne!(ht.summary.core.is_cataloged, Some(true));
    let card = db.get_repo_card("acme/hyper-term").unwrap().unwrap();
    assert!(!card.summary.core.icon.starts_with("data:"));
}

#[test]
fn hydration_overlays_local_star_state_only_when_logged_in() {
    let db = Database::open_in_memory().unwrap();
    db.set_starred("acme", "hyper-term", true).unwrap();
    let catalog = crate::github::CatalogService::new_empty();
    let manifest = crate::launchpad::parse_manifest(MANIFEST).unwrap();
    let (_, mut items) = crate::launchpad::partition_spotlight_and_recent(&manifest, 0);
    let mut anon = items.clone();
    let missing = hydrate_entries(&db, &catalog, &mut items, true, 0);
    let ht = items
        .iter()
        .find(|e| e.summary.core.id == "acme/hyper-term")
        .unwrap();
    assert!(ht.viewer_has_starred);
    assert!(missing.iter().any(|c| c.id == "acme/hyper-term"));

    hydrate_entries(&db, &catalog, &mut anon, false, 0);
    assert!(anon.iter().all(|e| !e.viewer_has_starred));
}

#[test]
fn persisted_discussion_state_survives_restart_hydration_and_clears_viewer_flag_on_logout() {
    let manifest_with_disc = r#"{
      "version": 1,
      "generated_at": "2026-11-17T03:23:57Z",
      "pinned": [],
      "items": [
        {"id": "supermc5657/z-viewer", "name": "ZViewer", "owner": "superMC5657", "repo": "z-viewer",
         "forge": "github", "forge_host": "github.com", "icon": "",
         "maker_note": "hi", "launched_at": "2026-11-17T03:03:31Z",
         "stars": 0, "discussion_repo": "superMC5657/z-store-launchpad", "discussion_number": 3,
         "discussion_comments_count": 0, "discussion_upvotes": 0}
      ]
    }"#;
    let db = Database::open_in_memory().unwrap();
    let url = "https://raw.githubusercontent.com/superMC5657/z-store-launchpad/main/launchpad.json";
    db.save_launchpad_feed_cache(url, manifest_with_disc)
        .unwrap();
    let manifest = crate::launchpad::parse_manifest(manifest_with_disc).unwrap();
    let manifest_ts =
        crate::launchpad::parse_rfc3339_secs(manifest.generated_at.as_deref().unwrap()).unwrap();

    // 用户会话内：顶帖 + 评论 2 条 + Star，写入本地 SQLite
    db.record_launchpad_upvote(
        "superMC5657/z-store-launchpad",
        3,
        "D_kwDOVwccks4ArNkl",
        1,
        true,
        manifest_ts + 10,
    )
    .unwrap();
    db.record_launchpad_comment_added("superMC5657/z-store-launchpad", 3, None, manifest_ts + 20)
        .unwrap();
    db.record_launchpad_comment_added("superMC5657/z-store-launchpad", 3, None, manifest_ts + 30)
        .unwrap();
    db.set_starred("superMC5657", "z-viewer", true).unwrap();
    db.adjust_launchpad_repo_stars("superMC5657", "z-viewer", 1)
        .unwrap();

    // 模拟应用重启：静态 launchpad.json 仍为全 0，但从同一 SQLite 重新水合
    let catalog = crate::github::CatalogService::new_empty();
    let (_, mut restarted) =
        crate::launchpad::partition_spotlight_and_recent(&manifest, manifest_ts + 60);
    hydrate_entries(&db, &catalog, &mut restarted, true, manifest_ts);
    let zv = &restarted[0];
    assert_eq!(zv.discussion_upvotes, 1);
    assert_eq!(zv.discussion_comments_count, 2);
    assert!(zv.viewer_has_upvoted);
    assert!(zv.viewer_has_starred);
    assert_eq!(zv.summary.core.stars, 1);
    assert_eq!(zv.discussion_node_id.as_deref(), Some("D_kwDOVwccks4ArNkl"));

    // 模拟登出后重新水合：本人态清零，公开计数保留
    crate::oauth::revoke_oauth_session(
        &db,
        &std::sync::Mutex::new(None),
        crate::oauth::RevokeReason::ManualLogout,
    )
    .unwrap();
    let (_, mut logged_out) =
        crate::launchpad::partition_spotlight_and_recent(&manifest, manifest_ts + 120);
    hydrate_entries(&db, &catalog, &mut logged_out, false, manifest_ts);
    assert_eq!(logged_out[0].discussion_upvotes, 1);
    assert_eq!(logged_out[0].discussion_comments_count, 2);
    assert!(!logged_out[0].viewer_has_upvoted);
    assert!(!logged_out[0].viewer_has_starred);
}

#[tokio::test]
async fn sync_launchpad_discussions_fetches_live_graphql_and_persists_for_offline_restart() {
    let manifest_raw = r#"{
      "version": 1,
      "generated_at": "2026-11-17T03:23:57Z",
      "pinned": [],
      "items": [
        {"id": "supermc5657/z-viewer", "name": "ZViewer", "owner": "superMC5657", "repo": "z-viewer",
         "forge": "github", "forge_host": "github.com", "icon": "",
         "maker_note": "hi", "launched_at": "2026-11-17T03:03:31Z",
         "stars": 0, "latest_version": "v0.3.2",
         "discussion_repo": "superMC5657/z-store-launchpad", "discussion_number": 3,
         "discussion_comments_count": 0, "discussion_upvotes": 0}
      ]
    }"#;
    let gql_server = serve(|_| {
        Reply::ok(
            r#"{"data":{
              "d0":{"discussion":{
                "id":"D_live_3","upvoteCount":6,"viewerCanUpvote":true,"viewerHasUpvoted":true,
                "reactionGroups":[],
                "comments":{"totalCount":1,"nodes":[{"replies":{"totalCount":2}}]}
              }},
              "r0":{"stargazerCount":15,"forkCount":2,"viewerHasStarred":true,"latestRelease":{"tagName":"v0.4.0"}}
            }}"#,
        )
    })
    .await;

    let source_url = "https://example.com/launchpad.json";
    let db = mem_db();
    db.lock()
        .unwrap()
        .save_launchpad_feed_cache(source_url, manifest_raw)
        .unwrap();
    let catalog = crate::github::CatalogService::new_empty();

    let pulses = sync_discussions(
        &db,
        &catalog,
        &client(),
        &gql_server.base,
        source_url,
        Some("gho_test"),
        false,
    )
    .await
    .unwrap();
    assert_eq!(pulses.len(), 1);
    assert_eq!(pulses[0].discussion_upvotes, Some(6));
    assert_eq!(pulses[0].discussion_comments_count, Some(3));
    assert_eq!(pulses[0].viewer_has_upvoted, Some(true));
    assert_eq!(pulses[0].stars, Some(15));
    assert_eq!(pulses[0].latest_version.as_deref(), Some("v0.4.0"));
    assert_eq!(pulses[0].viewer_has_starred, Some(true));

    // repo_card_cache 必须也收到来自 pulse 的最新星数与版本（非嵌套事务写透）
    let card = db
        .lock()
        .unwrap()
        .get_repo_card("supermc5657/z-viewer")
        .unwrap()
        .unwrap();
    assert_eq!(card.summary.core.stars, 15);
    assert_eq!(card.summary.core.latest_version, "v0.4.0");

    // 紧接着模拟断网重启：仅靠本地 SQLite 水合即可还原刚才从 discussions 拿到的全部最新卡片数据
    let manifest = crate::launchpad::parse_manifest(manifest_raw).unwrap();
    let (_, mut items) = crate::launchpad::partition_spotlight_and_recent(&manifest, 0);
    {
        let guard = db.lock().unwrap();
        hydrate_entries(&guard, &catalog, &mut items, true, 0);
    }
    assert_eq!(items[0].discussion_upvotes, 6);
    assert_eq!(items[0].discussion_comments_count, 3);
    assert!(items[0].viewer_has_upvoted);
    assert!(items[0].viewer_has_starred);
    assert_eq!(items[0].summary.core.stars, 15);
    assert_eq!(items[0].summary.core.latest_version, "v0.4.0");
    assert_eq!(count(&db.lock().unwrap(), "catalog_apps"), 0);
    assert_eq!(count(&db.lock().unwrap(), "custom_apps"), 0);

    // 匿名 REST 通道再次同步（REST 不返回原生 upvote_count，+1=0）：更新评论数为 5，但不冲零原生顶帖 6
    let rest_server = serve(|_| {
        Reply::ok(r#"{"node_id":"D_live_3","number":3,"title":"ZViewer","body":"x","comments":5,"reactions":{"+1":0}}"#)
            .header("ETag", "W/\"d3\"")
    })
    .await;
    let anon_pulses = sync_discussions(
        &db,
        &catalog,
        &client(),
        &rest_server.base,
        source_url,
        None,
        true,
    )
    .await
    .unwrap();
    assert_eq!(anon_pulses.len(), 1);
    assert_eq!(anon_pulses[0].discussion_comments_count, Some(5));
    assert_eq!(anon_pulses[0].discussion_upvotes, Some(6));
    assert_eq!(anon_pulses[0].viewer_has_upvoted, Some(false));
}

#[tokio::test]
async fn partial_graphql_response_and_newer_manifest_do_not_corrupt_counts_or_repo_stats() {
    let manifest_v1 = r#"{
      "version": 1,
      "generated_at": "2026-11-17T03:00:00Z",
      "pinned": [],
      "items": [
        {"id": "supermc5657/z-viewer", "name": "ZViewer", "owner": "superMC5657", "repo": "z-viewer",
         "forge": "github", "forge_host": "github.com", "icon": "",
         "maker_note": "hi", "launched_at": "2026-11-17T02:00:00Z",
         "stars": 10, "forks": 1, "latest_version": "v0.3.2",
         "discussion_repo": "superMC5657/z-store-launchpad", "discussion_number": 3,
         "discussion_comments_count": 7, "discussion_upvotes": 4}
      ]
    }"#;
    let manifest_v2 = r#"{
      "version": 1,
      "generated_at": "2027-01-15T04:00:00Z",
      "pinned": [],
      "items": [
        {"id": "supermc5657/z-viewer", "name": "ZViewer", "owner": "superMC5657", "repo": "z-viewer",
         "forge": "github", "forge_host": "github.com", "icon": "",
         "maker_note": "hi", "launched_at": "2026-11-17T02:00:00Z",
         "stars": 88, "forks": 9, "latest_version": "v0.9.0",
         "discussion_repo": "superMC5657/z-store-launchpad", "discussion_number": 3,
         "discussion_comments_count": 7, "discussion_upvotes": 4}
      ]
    }"#;
    let source_url = "https://example.com/launchpad.json";
    let db = mem_db();
    db.lock()
        .unwrap()
        .save_launchpad_feed_cache(source_url, manifest_v1)
        .unwrap();
    let catalog = crate::github::CatalogService::new_empty();

    // 1. 局部 GraphQL 只返回 r0（repo 统计），d0 为 null：不得把 comments_count 冲成 0，应保留静态清单基线 7 与 4
    let partial_gql = serve(|_| {
        Reply::ok(
            r#"{"data":{
              "d0":{"discussion":null},
              "r0":{"stargazerCount":12,"forkCount":2,"viewerHasStarred":false,"latestRelease":{"tagName":"v0.3.3"}}
            }}"#,
        )
    })
    .await;
    let pulses = sync_discussions(
        &db,
        &catalog,
        &client(),
        &partial_gql.base,
        source_url,
        Some("gho_test"),
        false,
    )
    .await
    .unwrap();
    assert_eq!(pulses[0].discussion_comments_count, Some(7));
    assert_eq!(pulses[0].discussion_upvotes, Some(4));
    assert_eq!(pulses[0].stars, Some(12));

    // 2. 随后本地一次顶帖交互（只改 discussion，不拉取 repo），不得把 repo_synced_at 虚增到未来，
    //    因此新版 launchpad.json (v2, generated_at > repo_synced_at) 的 stars=88 / v0.9.0 必须生效。
    let v2 = crate::launchpad::parse_manifest(manifest_v2).unwrap();
    let v2_ts = crate::launchpad::parse_rfc3339_secs(v2.generated_at.as_deref().unwrap()).unwrap();
    db.lock()
        .unwrap()
        .record_launchpad_upvote(
            "superMC5657/z-store-launchpad",
            3,
            "D_3",
            5,
            true,
            v2_ts + 60,
        )
        .unwrap();

    let (_, mut items) = crate::launchpad::partition_spotlight_and_recent(&v2, v2_ts + 120);
    {
        let guard = db.lock().unwrap();
        hydrate_entries(&guard, &catalog, &mut items, true, v2_ts);
    }
    assert_eq!(items[0].discussion_upvotes, 5);
    assert_eq!(items[0].discussion_comments_count, 7);
    assert_eq!(items[0].summary.core.stars, 88);
    assert_eq!(items[0].summary.core.forks, 9);
    assert_eq!(items[0].summary.core.latest_version, "v0.9.0");
}

#[tokio::test]
async fn verify_custom_icon_d8_validates_png_and_rejects_html() {
    let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec();
    png.resize(320, 0);
    let png_server = serve(move |req| {
        if req.starts_with("HEAD ") {
            Reply::status("405 Method Not Allowed")
        } else {
            Reply::status("206 Partial Content")
                .header("Content-Type", "image/png")
                .body(png.clone())
        }
    })
    .await;
    assert!(verify_custom_icon_d8(&client(), &format!("{}/logo.png", png_server.base)).await);
    assert_eq!(png_server.hits(), 2);
    assert!(png_server.requests()[0].starts_with("HEAD "));
    assert!(png_server.requests()[1]
        .to_ascii_lowercase()
        .contains("range: bytes=0-65535"));

    let tiny_server = serve(|req| {
        if req.starts_with("HEAD ") {
            Reply::status("405 Method Not Allowed")
        } else {
            Reply::status("206 Partial Content")
                .header("Content-Type", "image/png")
                .body(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec())
        }
    })
    .await;
    assert!(!verify_custom_icon_d8(&client(), &format!("{}/tiny.png", tiny_server.base)).await);

    let miss_server = serve(|_| Reply::status("404 Not Found")).await;
    assert!(!verify_custom_icon_d8(&client(), &format!("{}/missing.png", miss_server.base)).await);
    assert_eq!(miss_server.hits(), 1);

    let html_server =
        serve(|_| Reply::ok("<html>not an image</html>").header("Content-Type", "text/html")).await;
    assert!(!verify_custom_icon_d8(&client(), &format!("{}/logo.png", html_server.base)).await);
    assert_eq!(html_server.hits(), 1);
}

#[test]
fn is_id_in_launchpad_snapshot_detects_existing_entries() {
    let db = Database::open_in_memory().unwrap();
    let url = "https://example.com/launchpad.json";
    db.save_launchpad_feed_cache(url, MANIFEST).unwrap();
    assert!(is_id_in_snapshot(&db, url, "acme/hyper-term"));
    assert!(is_id_in_snapshot(&db, url, "RustDesk/RustDesk"));
    assert!(!is_id_in_snapshot(&db, url, "other/missing"));
}

#[tokio::test]
async fn resolve_preflight_icon_rejects_http_and_data_schemes() {
    let coord = crate::forge::RepositoryUrlParser::parse("acme/demo").unwrap();
    let c = client();

    let http_res =
        resolve_preflight_icon(&c, &c, &coord, None, Some("http://example.com/a.png")).await;
    assert!(matches!(
        http_res,
        crate::launchpad::PreflightIconOutcome::CustomInvalidScheme(_)
    ));

    let data_res =
        resolve_preflight_icon(&c, &c, &coord, None, Some("data:image/png;base64,iVBOR")).await;
    assert!(matches!(
        data_res,
        crate::launchpad::PreflightIconOutcome::CustomInvalidScheme(_)
    ));
}

#[tokio::test]
async fn retryable_primary_failure_adopts_validated_mirror_without_saving_etag() {
    let mirror = serve(|_| Reply::ok(MANIFEST).header("ETag", "W/\"mirror\"")).await;
    let url = format!("http://{}{}", dead_addr(), URL_PATH);
    let db = mem_db();
    db.lock()
        .unwrap()
        .save_etag(&url, "W/\"old\"", "", 1)
        .unwrap();
    let load = load_launchpad_manifest(&db, &client(), &url, Some(&mirror.base), false)
        .await
        .unwrap();
    assert!(!load.is_stale);
    assert_eq!(load.manifest.items.len(), 2);
    assert!(!mirror.requests()[0]
        .to_ascii_lowercase()
        .contains("if-none-match"));
    let guard = db.lock().unwrap();
    assert!(guard.get_launchpad_feed_cache(&url).unwrap().is_some());
    assert_eq!(
        guard.get_etag(&url).unwrap(),
        None,
        "mirror ETag never persisted"
    );
}

#[tokio::test]
async fn invalid_mirror_manifest_is_rejected_and_falls_back_to_snapshot() {
    let bad =
        r#"{"version":1,"items":[{"id":"../escape","name":"x","owner":"..","repo":"escape"}]}"#;
    let mirror = serve(move |_| Reply::ok(bad)).await;
    let url = format!("http://{}{}", dead_addr(), URL_PATH);
    let db = mem_db();
    let err = load_launchpad_manifest(&db, &client(), &url, Some(&mirror.base), false)
        .await
        .unwrap_err();
    assert!(err.contains("镜像清单校验失败"), "{err}");

    db.lock()
        .unwrap()
        .save_launchpad_feed_cache(&url, MANIFEST)
        .unwrap();
    let load = load_launchpad_manifest(&db, &client(), &url, Some(&mirror.base), false)
        .await
        .unwrap();
    assert!(load.is_stale);
}

#[tokio::test]
async fn non_retryable_primary_failure_never_hits_mirror() {
    let primary = serve(|_| Reply::status("404 Not Found")).await;
    let mirror = serve(|_| Reply::ok(MANIFEST)).await;
    let url = format!("{}{}", primary.base, URL_PATH);
    let err = load_launchpad_manifest(&mem_db(), &client(), &url, Some(&mirror.base), false)
        .await
        .unwrap_err();
    assert!(err.contains("404"), "{err}");
    assert_eq!(mirror.hits(), 0);
}

fn rest_discussion_key(number: u64) -> String {
    format!(
        "{}/repos/o/r/discussions/{number}",
        crate::github::GITHUB_API_BASE
    )
}

fn rest_comments_key(number: u64) -> String {
    format!(
        "{}/comments?per_page={}",
        rest_discussion_key(number),
        crate::github::discussions::COMMENTS_PAGE_SIZE
    )
}

fn seed_anonymous_cache(db: &Mutex<Database>, number: u64) {
    let g = db.lock().unwrap();
    g.save_etag(&rest_discussion_key(number), "W/\"d\"", "{}", 1)
        .unwrap();
    g.save_etag(&rest_comments_key(number), "W/\"c\"", "[]", 1)
        .unwrap();
}

#[tokio::test]
async fn upvote_writes_through_and_invalidates_only_discussion_cache() {
    let server = serve(|_| {
        Reply::ok(r#"{"data":{"addUpvote":{"subject":{"id":"D_1","upvoteCount":13,"viewerHasUpvoted":true}}}}"#)
    })
    .await;
    let db = mem_db();
    seed_anonymous_cache(&db, 7);
    let lp = super::discussion::LaunchpadDiscussions {
        db: &db,
        client: client(),
        api_base: &server.base,
        token: Some("tok".to_string()),
    };
    let r = lp
        .toggle_upvote("o/r", 7, Some("D_1"), false)
        .await
        .unwrap();
    assert_eq!((r.upvote_count, r.viewer_has_upvoted), (13, true));
    let g = db.lock().unwrap();
    let st = g.get_launchpad_discussion_state("o/r", 7).unwrap().unwrap();
    assert_eq!((st.upvote_count, st.viewer_has_upvoted), (13, Some(true)));
    assert_eq!(st.node_id, "D_1");
    assert_eq!(g.get_etag(&rest_discussion_key(7)).unwrap(), None);
    assert!(g.get_etag(&rest_comments_key(7)).unwrap().is_some());
}

#[tokio::test]
async fn comment_writes_through_and_invalidates_discussion_and_comment_caches() {
    let server = serve(|_| {
        Reply::ok(r#"{"data":{"addDiscussionComment":{"comment":{"id":"DC_9","body":"hi"}}}}"#)
    })
    .await;
    let db = mem_db();
    seed_anonymous_cache(&db, 7);
    let lp = super::discussion::LaunchpadDiscussions {
        db: &db,
        client: client(),
        api_base: &server.base,
        token: Some("tok".to_string()),
    };
    let c = lp
        .add_comment("o/r", 7, Some("D_1"), "hi", None)
        .await
        .unwrap();
    assert_eq!(c.id, "DC_9");
    let g = db.lock().unwrap();
    let st = g.get_launchpad_discussion_state("o/r", 7).unwrap().unwrap();
    assert_eq!(st.comments_count, 1);
    assert_eq!(g.get_etag(&rest_discussion_key(7)).unwrap(), None);
    assert_eq!(g.get_etag(&rest_comments_key(7)).unwrap(), None);
}

#[tokio::test]
async fn writes_require_login_before_touching_network_or_cache() {
    let server = serve(|_| Reply::status("500 Internal Server Error")).await;
    let db = mem_db();
    seed_anonymous_cache(&db, 7);
    let lp = super::discussion::LaunchpadDiscussions {
        db: &db,
        client: client(),
        api_base: &server.base,
        token: None,
    };
    let err = lp
        .toggle_upvote("not a repo", 7, None, false)
        .await
        .unwrap_err();
    assert!(err.contains("登录"), "{err}");
    assert_eq!(server.hits(), 0);
    assert!(db
        .lock()
        .unwrap()
        .get_etag(&rest_discussion_key(7))
        .unwrap()
        .is_some());
}
