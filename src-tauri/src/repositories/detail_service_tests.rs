use super::*;
use crate::db::{Database, RepoCardUpsert};
use crate::forge::{ForgeReleaseInfo, ForgeRepoInfo};
use crate::models::{AppSummary, ReleaseAsset};
use crate::test_support::{serve, Reply};
use futures_util::future::BoxFuture;

fn test_state() -> AppState {
    AppState {
        db: std::sync::Arc::new(std::sync::Mutex::new(Database::open_in_memory().unwrap())),
        catalog: crate::github::CatalogService::new_empty(),
        mirror: std::sync::Mutex::new(crate::mirror::MirrorManager::new()),
        github_token: std::sync::Mutex::new(None),
        sync_lock: tokio::sync::Mutex::new(()),
        startup_catalog_synced: std::sync::atomic::AtomicBool::new(false),
    }
}

fn github(base: &str) -> DetailSources<'_> {
    DetailSources {
        github_api_base: Some(base),
        forge: None,
    }
}

fn core(id: &str, owner: &str, repo: &str, forge: &str, host: &str) -> AppCore {
    AppCore {
        id: id.to_string(),
        name: repo.to_string(),
        description_en: None,
        owner: owner.to_string(),
        repo: repo.to_string(),
        icon: String::new(),
        icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
        description: "Real tool".to_string(),
        stars: 7,
        forks: 3,
        license: "MIT".to_string(),
        latest_version: "v1.0.0".to_string(),
        category: "external".to_string(),
        category_name: "跨平台开源".to_string(),
        is_verified: false,
        forge: Some(forge.to_string()),
        forge_host: Some(host.to_string()),
        homepage: None,
        platforms: vec!["windows".to_string()],
        is_cataloged: None,
        source: None,
        status: None,
        added_at: None,
        alternatives: Vec::new(),
    }
}

fn asset(name: &str, url: &str) -> ReleaseAsset {
    let (kind, os, arch) = crate::forge::provider::classify_asset_fields(name);
    ReleaseAsset {
        name: name.to_string(),
        download_url: url.to_string(),
        size_bytes: 20_000_000,
        sha256: None,
        os,
        arch,
        kind,
    }
}

fn detail(id: &str, owner: &str, repo: &str) -> AppDetail {
    AppDetail {
        core: core(id, owner, repo, "github", "github.com"),
        changelog: "## v1.0.0".to_string(),
        readme_markdown: "# Readme".to_string(),
        readme_variants: None,
        releases: vec![asset("app-setup.exe", "https://example.com/app-setup.exe")],
        cached_at: None,
        is_stale: None,
        is_private: false,
    }
}

fn card(id: &str, platforms: &[&str], confirmed_other: bool) -> RepoCardUpsert {
    let (owner, repo) = id.split_once('/').unwrap();
    let mut c = core(id, owner, repo, "github", "github.com");
    c.platforms = platforms.iter().map(|p| p.to_string()).collect();
    c.is_cataloged = Some(false);
    RepoCardUpsert {
        summary: AppSummary { core: c },
        confirmed_other,
        is_private: Some(false),
    }
}

fn catalog_item(id: &str, platforms: &[&str]) -> crate::github::CatalogItem {
    let (owner, repo) = id.split_once('/').unwrap();
    crate::github::CatalogItem {
        id: id.to_string(),
        name: "精选".to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        icon: String::new(),
        icon_bg: String::new(),
        description: "精选简介".to_string(),
        description_en: None,
        category: "dev".to_string(),
        category_name: "开发工具".to_string(),
        aliases: vec![],
        alternatives: Vec::new(),
        default_version: "v9.0.0".to_string(),
        added_at: None,
        license: "MIT".to_string(),
        stars: 1,
        forks: 1,
        is_verified: true,
        homepage: None,
        platforms: platforms.iter().map(|p| p.to_string()).collect(),
        identifiers: Default::default(),
        install_dirs: vec![],
        search_subdirs: vec![],
        publishers: vec![],
    }
}

/// 多源 forge mock adapter：按构造结果回放 repo / latest release。
struct MockForge {
    repo: Result<ForgeRepoInfo, String>,
    release: Result<ForgeReleaseInfo, String>,
}

impl MockForge {
    fn ok(assets: Vec<ReleaseAsset>) -> Self {
        Self {
            repo: Ok(ForgeRepoInfo::from_counts(
                "FreeTube".to_string(),
                Some("Private YouTube client".to_string()),
                Some(12),
                Some(2),
                None,
                Some("main".to_string()),
                None,
            )),
            release: Ok(ForgeReleaseInfo {
                tag_name: "v0.22.0".to_string(),
                name: None,
                body: Some("notes".to_string()),
                published_at: Some("2026-11-13T00:00:00Z".to_string()),
                assets,
            }),
        }
    }

    fn offline() -> Self {
        Self {
            repo: Err("connect refused".to_string()),
            release: Err("connect refused".to_string()),
        }
    }
}

impl ForgeProvider for MockForge {
    fn forge_type(&self) -> ForgeType {
        ForgeType::Codeberg
    }

    fn fetch_repo<'a>(
        &'a self,
        _host: &'a str,
        _owner: &'a str,
        _repo: &'a str,
        _token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ForgeRepoInfo, String>> {
        let r = self.repo.clone();
        Box::pin(async move { r })
    }

    fn fetch_latest_release<'a>(
        &'a self,
        _host: &'a str,
        _owner: &'a str,
        _repo: &'a str,
        _token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ForgeReleaseInfo, String>> {
        let r = self.release.clone();
        Box::pin(async move { r })
    }
}

fn forge(mock: &MockForge) -> DetailSources<'_> {
    DetailSources {
        github_api_base: None,
        forge: Some(mock),
    }
}

fn release_json(tag: &str, asset_name: &str) -> String {
    serde_json::json!({
        "tag_name": tag,
        "body": "notes",
        "published_at": "2026-11-13T00:00:00Z",
        "assets": [{
            "name": asset_name,
            "size": 20_000_000,
            "browser_download_url": format!("https://github.com/o/r/releases/download/{tag}/{asset_name}"),
        }],
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// 完整详情
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ttl_hit_serves_cached_detail_without_network() {
    let state = test_state();
    state
        .db()
        .unwrap()
        .save_app_detail("acme/tool", &detail("acme/tool", "acme", "tool"))
        .unwrap();
    let srv = serve(|_| Reply::status("500 Internal Server Error")).await;

    let hit = resolve_app_detail(&state, github(&srv.base), "acme/tool", false)
        .await
        .unwrap();
    assert_eq!(hit.core.latest_version, "v1.0.0");
    assert_eq!(hit.is_stale, None);
    assert_eq!(hit.core.is_cataloged, Some(false));
    assert_eq!(srv.hits(), 0, "TTL hit must not touch the network");
}

#[tokio::test]
async fn github_304_reuses_cached_detail_and_refreshes_repo_card_in_one_bundle() {
    let state = test_state();
    {
        let db = state.db().unwrap();
        db.save_app_detail("acme/tool", &detail("acme/tool", "acme", "tool"))
            .unwrap();
        db.exec_write("UPDATE app_details SET cached_at = 1", [])
            .unwrap();
        let rel_ep = crate::github::github_latest_release_endpoint("acme", "tool");
        db.save_etag(
            &rel_ep,
            "\"rel-1\"",
            &release_json("v1.0.0", "app-setup.exe"),
            1,
        )
        .unwrap();
        let repo_ep = crate::github::github_repo_endpoint("acme", "tool");
        db.save_etag(
            &repo_ep,
            "\"repo-1\"",
            r#"{"name":"tool","stargazers_count":99,"forks_count":4}"#,
            1,
        )
        .unwrap();
    }
    let srv = serve(|_| Reply::status("304 Not Modified")).await;

    let got = resolve_app_detail(&state, github(&srv.base), "acme/tool", false)
        .await
        .unwrap();
    assert_eq!(got.is_stale, None);
    assert_eq!(got.core.latest_version, "v1.0.0");
    assert_eq!(
        got.core.stars, 99,
        "304 still refreshes stats from cached repo JSON"
    );
    assert_eq!(srv.hits(), 2, "release + repo conditional requests only");
    let reqs = srv.requests().join("\n").to_ascii_lowercase();
    assert!(reqs.contains("if-none-match: \"rel-1\""), "{reqs}");
    assert!(reqs.contains("if-none-match: \"repo-1\""), "{reqs}");

    let db = state.db().unwrap();
    let ttl = detail_ttl_secs(&db).max(60);
    assert!(
        db.get_app_detail("acme/tool", Some(ttl)).unwrap().is_some(),
        "304 reuse refreshes cached_at"
    );
    let card = db.get_repo_card("acme/tool").unwrap().expect("repo card");
    assert_eq!(card.summary.core.stars, 99);
    assert_eq!(card.summary.core.platforms, vec!["windows"]);
}

#[tokio::test]
async fn github_failure_falls_back_to_stale_cache_or_errors() {
    let state = test_state();
    let srv = serve(|_| Reply::status("403 Forbidden")).await;
    // 无旧行：release 与 repo 都失败时仍合成 stale 空详情（不落库）。
    let synthesized = resolve_app_detail(&state, github(&srv.base), "acme/none", true)
        .await
        .unwrap();
    assert_eq!(synthesized.is_stale, Some(true));
    assert!(state
        .db()
        .unwrap()
        .get_app_detail("acme/none", None)
        .unwrap()
        .is_none());

    // 有旧行：强制刷新失败返回旧行并标 stale。
    state
        .db()
        .unwrap()
        .save_app_detail("acme/tool", &detail("acme/tool", "acme", "tool"))
        .unwrap();
    let stale = resolve_app_detail(&state, github(&srv.base), "acme/tool", true)
        .await
        .unwrap();
    assert_eq!(stale.is_stale, Some(true));
    assert_eq!(stale.core.latest_version, "v1.0.0");
}

#[tokio::test]
async fn forge_detail_fills_checksum_manifest_for_both_manifest_names() {
    for manifest in ["checksums.txt", "SHA256SUMS"] {
        let hash = "c".repeat(64);
        let body = format!(
            "{hash}  FreeTube-setup.exe\n{}  *other.zip\n",
            "d".repeat(64)
        );
        let srv = serve(move |req| {
            if req.contains("/dl/manifest ") {
                Reply::ok(body.clone())
            } else {
                Reply::status("404 Not Found")
            }
        })
        .await;
        let mock = MockForge::ok(vec![
            asset(
                "FreeTube-setup.exe",
                &format!("{}/dl/FreeTube-setup.exe", srv.base),
            ),
            asset(manifest, &format!("{}/dl/manifest", srv.base)),
        ]);
        let state = test_state();

        let got = resolve_app_detail(&state, forge(&mock), "codeberg:freetube/freetube", false)
            .await
            .unwrap();
        let exe = got
            .releases
            .iter()
            .find(|a| a.name == "FreeTube-setup.exe")
            .unwrap();
        assert_eq!(exe.sha256.as_deref(), Some(hash.as_str()), "{manifest}");
        assert_eq!(got.core.forge.as_deref(), Some("codeberg"));
        assert_eq!(got.core.latest_version, "v0.22.0");
        assert_eq!(srv.hits(), 1, "only the manifest is downloaded");

        let db = state.db().unwrap();
        let stored = db
            .get_app_detail("codeberg:freetube/freetube", None)
            .unwrap()
            .expect("persisted");
        assert!(stored.releases.iter().any(|a| a.sha256.is_some()));
        assert!(db
            .get_repo_card("codeberg:freetube/freetube")
            .unwrap()
            .is_some());
    }
}

#[tokio::test]
async fn forge_detail_failure_returns_stale_cache_or_error() {
    let state = test_state();
    let offline = MockForge::offline();
    assert!(
        resolve_app_detail(&state, forge(&offline), "codeberg:o/r", true)
            .await
            .is_err()
    );

    let mut old = detail("codeberg:o/r", "o", "r");
    old.core.forge = Some("codeberg".to_string());
    old.core.forge_host = Some("codeberg.org".to_string());
    state
        .db()
        .unwrap()
        .save_app_detail("codeberg:o/r", &old)
        .unwrap();
    let stale = resolve_app_detail(&state, forge(&offline), "codeberg:o/r", true)
        .await
        .unwrap();
    assert_eq!(stale.is_stale, Some(true));
    assert_eq!(stale.core.latest_version, "v1.0.0");
}

#[test]
fn persist_gate_only_stale_skips_fresh_true_empty_persists() {
    assert!(should_skip_persist(Some(true)));
    assert!(!should_skip_persist(None));
    assert!(!should_skip_persist(Some(false)));
}

#[test]
fn prefetch_reads_all_three_detail_etags() {
    let db = Database::open_in_memory().unwrap();
    let rel = crate::github::github_latest_release_endpoint("o", "r");
    let readme = crate::github::github_readme_endpoint("o", "r");
    db.save_etag(&rel, "e1", "p1", 1).unwrap();
    db.save_etag(&readme, "e3", "p3", 1).unwrap();
    let got = prefetch_detail_etags(&db, "o", "r");
    assert_eq!(got.release_etag.as_deref(), Some("e1"));
    assert_eq!(got.release_payload.as_deref(), Some("p1"));
    assert_eq!(got.repo_etag, None);
    assert_eq!(got.repo_payload, None);
    assert_eq!(got.readme_etag.as_deref(), Some("e3"));
    assert_eq!(got.readme_payload.as_deref(), Some("p3"));
}

// ---------------------------------------------------------------------------
// platforms-lite
// ---------------------------------------------------------------------------

#[tokio::test]
async fn platforms_lite_github_fresh_404_and_offline_states() {
    // Fresh 200：推导平台、写 ETag、未收录富卡写平台与 tag。
    let state = test_state();
    let srv =
        serve(|_| Reply::ok(release_json("v2.0.0", "tool-setup.exe")).header("etag", "\"r2\""))
            .await;
    let lite = resolve_platforms_lite(&state, github(&srv.base), "acme/tool", false)
        .await
        .unwrap();
    assert_eq!(lite.platforms, vec!["windows"]);
    assert!(!lite.from_cache);
    assert_eq!(lite.is_stale, None);
    {
        let db = state.db().unwrap();
        let card = db
            .get_repo_card_platform_state("acme/tool")
            .unwrap()
            .unwrap();
        assert_eq!(card.platforms, vec!["windows"]);
        assert!(!card.confirmed_other);
        let rel_ep = crate::github::github_latest_release_endpoint("acme", "tool");
        assert_eq!(db.get_etag(&rel_ep).unwrap().as_deref(), Some("\"r2\""));
    }
    // 再次请求命中 12h 富卡快径，零网络。
    let again = resolve_platforms_lite(&state, github(&srv.base), "acme/tool", false)
        .await
        .unwrap();
    assert!(again.from_cache);
    assert_eq!(srv.hits(), 1);

    // 已知仓库 404 = 零发布：确认 Other。
    let srv404 = serve(|_| Reply::status("404 Not Found")).await;
    state
        .db()
        .unwrap()
        .upsert_repo_cards_batch(&[card("acme/zero", &[], false)])
        .unwrap();
    let zero = resolve_platforms_lite(&state, github(&srv404.base), "acme/zero", true)
        .await
        .unwrap();
    assert!(zero.platforms.is_empty());
    assert_eq!(zero.is_stale, None);
    assert!(
        state
            .db()
            .unwrap()
            .get_repo_card_platform_state("acme/zero")
            .unwrap()
            .unwrap()
            .confirmed_other
    );

    // 未知仓库失败且无缓存：stale 空结果，不写富卡。
    let srv403 = serve(|_| Reply::status("403 Forbidden")).await;
    let offline = resolve_platforms_lite(&state, github(&srv403.base), "acme/ghost", false)
        .await
        .unwrap();
    assert!(offline.platforms.is_empty());
    assert_eq!(offline.is_stale, Some(true));
    assert!(state
        .db()
        .unwrap()
        .get_repo_card_platform_state("acme/ghost")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn platforms_lite_github_304_restores_payload_and_touches_detail() {
    let state = test_state();
    {
        let db = state.db().unwrap();
        let rel_ep = crate::github::github_latest_release_endpoint("acme", "mac");
        db.save_etag(&rel_ep, "\"m1\"", &release_json("v3.0.0", "Mac.dmg"), 1)
            .unwrap();
    }
    let srv = serve(|_| Reply::status("304 Not Modified")).await;
    let lite = resolve_platforms_lite(&state, github(&srv.base), "acme/mac", true)
        .await
        .unwrap();
    assert_eq!(lite.platforms, vec!["macos"]);
    assert!(lite.from_cache);
    let card = state
        .db()
        .unwrap()
        .get_repo_card_platform_state("acme/mac")
        .unwrap()
        .unwrap();
    assert_eq!(card.platforms, vec!["macos"]);
}

#[tokio::test]
async fn platforms_lite_forge_writes_back_repo_card_and_catalog_wins() {
    let state = test_state();
    let mock = MockForge::ok(vec![asset(
        "FreeTube.AppImage",
        "https://x/FreeTube.AppImage",
    )]);
    let lite = resolve_platforms_lite(&state, forge(&mock), "codeberg:o/r", false)
        .await
        .unwrap();
    assert_eq!(lite.platforms, vec!["linux"]);
    let card = state
        .db()
        .unwrap()
        .get_repo_card_platform_state("codeberg:o/r")
        .unwrap()
        .unwrap();
    assert_eq!(card.platforms, vec!["linux"]);

    // 收录库非空平台为真值：强制刷新也不触网。
    state
        .catalog
        .update_items(vec![catalog_item("acme/curated", &["macos"])]);
    let offline = MockForge::offline();
    let curated = resolve_platforms_lite(&state, forge(&offline), "acme/curated", true)
        .await
        .unwrap();
    assert_eq!(curated.platforms, vec!["macos"]);
    assert!(curated.from_cache);
}

#[test]
fn platforms_lite_from_cache_prefers_catalog_platforms_over_cached_releases() {
    let state = test_state();
    let mut local_item = catalog_item("demo/app", &["windows", "ios", "android"]);
    state.catalog.set_collected_items(vec![local_item.clone()]);
    let mut cached = detail("demo/app", "demo", "app");
    cached.core.platforms = vec!["windows".to_string()];
    state
        .db()
        .unwrap()
        .save_app_detail("demo/app", &cached)
        .unwrap();

    let lite = platforms_lite_from_cache(&state, "demo/app").expect("cache hit");
    assert_eq!(lite.platforms, vec!["windows", "ios", "android"]);

    // 自收录平台为空 [] 时回退 Release 推导
    local_item.platforms = Vec::new();
    state.catalog.set_collected_items(vec![local_item]);
    let fallback = platforms_lite_from_cache(&state, "demo/app").expect("cache hit");
    assert_eq!(fallback.platforms, vec!["windows"]);
}

#[test]
fn platforms_lite_fast_path_serves_settled_repo_cards_only() {
    let state = test_state();
    state
        .db()
        .unwrap()
        .upsert_repo_cards_batch(&[
            card("acme/other", &[], true),
            card("acme/win", &["windows"], false),
            card("acme/unknown", &[], false),
        ])
        .unwrap();
    let other = platforms_lite_from_cache(&state, "acme/other").expect("confirmed other hit");
    assert!(other.from_cache);
    assert!(other.platforms.is_empty());
    assert_eq!(other.is_stale, None);
    let win = platforms_lite_from_cache(&state, "acme/win").expect("platform hit");
    assert_eq!(win.platforms, vec!["windows"]);
    assert!(platforms_lite_from_cache(&state, "acme/unknown").is_none());

    // 超出 12h 新鲜窗口的卡片不走快径。
    state
        .db()
        .unwrap()
        .exec_write("UPDATE repo_card_cache SET updated_at = 1", [])
        .unwrap();
    assert!(platforms_lite_from_cache(&state, "acme/win").is_none());
}

#[test]
fn lite_write_back_confirms_other_for_uncataloged_only() {
    let state = test_state();
    state
        .catalog
        .update_items(vec![catalog_item("acme/curated", &[])]);
    let db = state.db().unwrap();
    write_back_lite_platforms(&state, &db, "acme/curated", "acme", "curated", &[], None);
    write_back_lite_platforms(&state, &db, "acme/zero", "acme", "zero", &[], None);
    assert!(db
        .get_repo_card_platform_state("acme/curated")
        .unwrap()
        .is_none());
    assert!(
        db.get_repo_card_platform_state("acme/zero")
            .unwrap()
            .unwrap()
            .confirmed_other
    );
}

#[test]
fn platforms_lite_stale_row_heals_misclassified_maccy_assets_and_respects_catalog() {
    let catalog = crate::github::CatalogService::new_empty();
    let mut maccy_stale = detail("p0deje/maccy", "p0deje", "Maccy");
    maccy_stale.core.platforms = vec!["windows".to_string()];
    maccy_stale.releases = vec![ReleaseAsset {
        name: "Maccy.app.zip".to_string(),
        download_url: "https://example.com/Maccy.app.zip".to_string(),
        size_bytes: 5_288_775,
        sha256: None,
        os: "windows".to_string(),
        arch: "universal".to_string(),
        kind: "portable_zip".to_string(),
    }];

    let rel = decide_shallow_release(&EtagGetOutcome::Failed, None, Some(&maccy_stale), None)
        .expect("stale row fallback");
    assert_eq!(rel.source, ShallowSource::StaleRow);
    let platforms =
        resolve_lite_platforms_from_shallow(&catalog, "p0deje/maccy", &rel, Some(&maccy_stale));
    assert_eq!(platforms, vec!["macos".to_string()]);

    // 收录库明确指定非空平台时，stale 自愈仍保持收录库优先
    let mut curated = catalog_item("p0deje/maccy", &["macos", "ios"]);
    curated.repo = "Maccy".to_string();
    catalog.set_collected_items(vec![curated]);
    let with_catalog =
        resolve_lite_platforms_from_shallow(&catalog, "p0deje/maccy", &rel, Some(&maccy_stale));
    assert_eq!(with_catalog, vec!["macos".to_string(), "ios".to_string()]);
}

// ---------------------------------------------------------------------------
// 轻量 Release
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lightweight_release_without_force_reads_local_tiers_only() {
    let state = test_state();
    let srv = serve(|_| Reply::status("500 Internal Server Error")).await;
    assert!(
        resolve_latest_release_lightweight(&state, github(&srv.base), "acme/tool", false)
            .await
            .is_err()
    );

    state
        .catalog
        .update_items(vec![catalog_item("acme/tool", &[])]);
    let cat = resolve_latest_release_lightweight(&state, github(&srv.base), "acme/tool", false)
        .await
        .unwrap();
    assert_eq!(cat.tag, "v9.0.0");

    state
        .db()
        .unwrap()
        .save_app_detail("acme/tool", &detail("acme/tool", "acme", "tool"))
        .unwrap();
    let row = resolve_latest_release_lightweight(&state, github(&srv.base), "acme/tool", false)
        .await
        .unwrap();
    assert_eq!(row.tag, "v1.0.0");
    assert_eq!(row.body, "## v1.0.0");
    assert_eq!(srv.hits(), 0);
}

#[tokio::test]
async fn lightweight_release_force_saves_etag_then_304_touches_detail() {
    let state = test_state();
    let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let srv = serve(move |_| {
        if n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            Reply::ok(release_json("v2.0.0", "tool-setup.exe")).header("etag", "\"r2\"")
        } else {
            Reply::status("304 Not Modified")
        }
    })
    .await;
    let fresh = resolve_latest_release_lightweight(&state, github(&srv.base), "acme/tool", true)
        .await
        .unwrap();
    assert_eq!(fresh.tag, "v2.0.0");
    assert_eq!(fresh.published_at, Some(1_794_528_000));

    {
        let db = state.db().unwrap();
        db.save_app_detail("acme/tool", &detail("acme/tool", "acme", "tool"))
            .unwrap();
        db.exec_write("UPDATE app_details SET cached_at = 1", [])
            .unwrap();
    }
    let cached = resolve_latest_release_lightweight(&state, github(&srv.base), "acme/tool", true)
        .await
        .unwrap();
    assert_eq!(cached.tag, "v2.0.0", "304 restores the cached payload");
    let reqs = srv.requests().join("\n").to_ascii_lowercase();
    assert!(reqs.contains("if-none-match: \"r2\""), "{reqs}");
    let db = state.db().unwrap();
    let ttl = detail_ttl_secs(&db).max(60);
    assert!(
        db.get_app_detail("acme/tool", Some(ttl)).unwrap().is_some(),
        "304 touches app_details cached_at"
    );
    drop(db);
    assert_eq!(
        cached_release_published_at(&state, "acme/tool", "v2.0.0"),
        Some(1_794_528_000)
    );
}

#[tokio::test]
async fn lightweight_release_force_uses_forge_adapter_for_non_github() {
    let state = test_state();
    let mock = MockForge::ok(Vec::new());
    let rel = resolve_latest_release_lightweight(&state, forge(&mock), "codeberg:o/r", true)
        .await
        .unwrap();
    assert_eq!(rel.tag, "v0.22.0");
    assert_eq!(rel.body, "notes");
    assert_eq!(rel.published_at, Some(1_794_528_000));
}

#[test]
fn update_check_304_restores_payload_and_falls_back_on_corrupt_cache() {
    let valid_payload = r#"{"tag_name":"v2.4.0","body":"release notes","assets":[]}"#;
    let rel = resolve_update_shallow_with_fallback(
        &EtagGetOutcome::NotModified,
        Some(valid_payload),
        None,
        Some("v1.0.0"),
    )
    .expect("304 with valid cached payload should succeed");
    assert_eq!(rel.source, ShallowSource::Payload);
    assert_eq!(rel.tag, "v2.4.0");
    assert_eq!(rel.body, "release notes");
    assert!(rel.touch);

    // 损坏的 cached_payload 自动降级至 catalog_default_version
    let fallback = resolve_update_shallow_with_fallback(
        &EtagGetOutcome::NotModified,
        Some("{corrupt-json"),
        None,
        Some("v1.8.0"),
    )
    .expect("304 with corrupt payload should fall back to catalog default");
    assert_eq!(fallback.source, ShallowSource::Catalog);
    assert_eq!(fallback.tag, "v1.8.0");

    // 损坏且无兜底时返回 NotModifiedWithoutCache 供上层自愈重试
    let err = resolve_update_shallow_with_fallback(
        &EtagGetOutcome::NotModified,
        Some("{corrupt-json"),
        None,
        None,
    )
    .unwrap_err();
    assert_eq!(
        err,
        ShallowError::Miss(ShallowMiss::NotModifiedWithoutCache)
    );
}

#[test]
fn publish_time_parsed_only_for_matching_tag() {
    let payload = r#"{"tag_name":"v0.101.0","published_at":"2026-11-13T00:00:00Z"}"#;
    assert_eq!(
        release_published_at_from_payload(payload, "v0.101.0"),
        Some(1_794_528_000)
    );
    assert_eq!(release_published_at_from_payload(payload, "v0.102.0"), None);
    assert_eq!(
        release_published_at_from_payload(r#"{"tag_name":"v1","published_at":null}"#, "v1"),
        None
    );
    assert_eq!(release_published_at_from_payload("not json", "v1"), None);
}

#[test]
fn rfc3339_publish_time_parses_utc_and_offset_timestamps() {
    assert_eq!(
        parse_rfc3339_unix("2026-11-13T00:00:00Z"),
        Some(1_794_528_000)
    );
    assert_eq!(
        parse_rfc3339_unix("2026-11-13T08:00:00+08:00"),
        Some(1_794_528_000)
    );
    assert_eq!(parse_rfc3339_unix("   "), None);
    assert_eq!(parse_rfc3339_unix("not-a-date"), None);
}
