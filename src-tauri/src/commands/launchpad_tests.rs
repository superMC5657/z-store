use super::*;
use crate::test_support::{dead_addr, serve, Reply};

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
    assert_eq!(load.manifest.items[0].icon, "", "data: icon stripped before persisting");
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
    let before = db.lock().unwrap().get_launchpad_feed_cache(&url).unwrap().unwrap().0;

    let load = load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .unwrap();
    assert!(!load.is_stale);
    assert_eq!(load.manifest.items.len(), 2);
    assert_eq!(server.hits(), 2);
    assert!(server.requests()[1].to_ascii_lowercase().contains("if-none-match: w/\"v1\""));
    let after = db.lock().unwrap().get_launchpad_feed_cache(&url).unwrap().unwrap().0;
    assert_eq!(before, after);
}

#[tokio::test]
async fn force_refresh_skips_conditional_header() {
    let server = serve(|_| Reply::ok(MANIFEST).header("ETag", "W/\"v1\"")).await;
    let url = format!("{}{}", server.base, URL_PATH);
    let db = mem_db();
    load_launchpad_manifest(&db, &client(), &url, None, false).await.unwrap();
    load_launchpad_manifest(&db, &client(), &url, None, true).await.unwrap();
    assert!(!server.requests()[1].to_ascii_lowercase().contains("if-none-match"));
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
    db.lock().unwrap().save_launchpad_feed_cache(&url, MANIFEST).unwrap();
    let load = load_launchpad_manifest(&db, &client(), &url, None, false)
        .await
        .unwrap();
    assert!(load.is_stale);
    let (payload, _) = db.lock().unwrap().get_launchpad_feed_cache(&url).unwrap().unwrap();
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
    assert!(db.lock().unwrap().get_launchpad_feed_cache(&url).unwrap().is_none());
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

    let manifest = crate::launchpad::sanitize_manifest(
        crate::launchpad::parse_manifest(MANIFEST).unwrap(),
    );
    let (_, mut items) = crate::launchpad::partition_spotlight_and_recent(&manifest, 0);
    hydrate_entries(&db, &catalog, &mut items, false);

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
    let missing = hydrate_entries(&db, &catalog, &mut items, true);
    let ht = items
        .iter()
        .find(|e| e.summary.core.id == "acme/hyper-term")
        .unwrap();
    assert!(ht.viewer_has_starred);
    assert!(missing.iter().any(|c| c.id == "acme/hyper-term"));

    hydrate_entries(&db, &catalog, &mut anon, false);
    assert!(anon.iter().all(|e| !e.viewer_has_starred));
}
