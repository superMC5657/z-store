use super::*;
use crate::db::{Database, RepoCardUpsert};
use crate::models::{AppCore, AppDetail, AppSummary};
use crate::repositories::{DetailRepository, EtagWrite};

fn sample_core(id: &str) -> AppCore {
    let (owner, repo) = id.split_once('/').unwrap();
    AppCore {
        id: id.to_string(),
        name: repo.to_string(),
        description_en: None,
        owner: owner.to_string(),
        repo: repo.to_string(),
        icon: String::new(),
        icon_bg: String::new(),
        description: "desc".to_string(),
        stars: 10,
        forks: 2,
        license: "MIT".to_string(),
        latest_version: "v1.0.0".to_string(),
        category: "external".to_string(),
        category_name: "跨平台开源".to_string(),
        is_verified: false,
        forge: Some("github".to_string()),
        forge_host: Some("github.com".to_string()),
        homepage: None,
        platforms: vec!["windows".to_string()],
        is_cataloged: None,
        source: None,
        status: None,
        added_at: None,
        alternatives: Vec::new(),
    }
}

fn sample_detail(id: &str, is_private: bool) -> AppDetail {
    AppDetail {
        core: sample_core(id),
        changelog: "## v1.0.0".to_string(),
        readme_markdown: "# Secret".to_string(),
        readme_variants: None,
        releases: Vec::new(),
        cached_at: Some(1_700_000_000),
        is_stale: None,
        is_private,
    }
}

fn sample_card(id: &str, is_private: bool) -> RepoCardUpsert {
    RepoCardUpsert {
        summary: AppSummary {
            core: sample_core(id),
        },
        confirmed_other: false,
        is_private: Some(is_private),
    }
}

fn seed_private_and_public_caches(db: &Database, host_pat: Option<&str>) {
    let now = crate::now_secs();
    let user = OAuthUser {
        login: "alice".to_string(),
        avatar_url: "https://github.com/alice.png".to_string(),
        has_list_scope: true,
        is_expired: false,
    };
    save_oauth_session(db, "gho_account_a", Some(&user));
    if let Some(pat) = host_pat {
        db.exec_write(
            "INSERT INTO host_tokens (host, token, updated_at) VALUES ('github.com', ?1, 1)",
            rusqlite::params![pat],
        )
        .unwrap();
    }
    // Account signals & stars
    db.set_starred("org", "secret", true).unwrap();
    db.exec_write(
        "INSERT INTO user_repo_signals (full_name, relation, language, description, stars, forks, updated_at) \
         VALUES ('org/secret', 'starred', 'Rust', 'private', 1, 0, ?1)",
        rusqlite::params![now],
    )
    .unwrap();

    // Starred feed cache (@me: private + public user)
    db.save_starred_feed_cache("@me:alice", "@me:alice", "{\"v\":2}")
        .unwrap();
    db.save_starred_feed_cache("torvalds", "torvalds", "{\"v\":2}")
        .unwrap();

    // Search list cache (private + public)
    db.save_search_list_cache("secret|1|20", "secret", "{\"v\":2}", true)
        .unwrap();
    db.save_search_list_cache("rust|1|20", "rust", "{\"v\":2}", false)
        .unwrap();

    // Repo card cache (private + public + prefix-colliding public repo)
    db.upsert_repo_cards_batch(&[
        sample_card("org/secret", true),
        sample_card("org/secret-public", false),
        sample_card("pub/open", false),
    ])
    .unwrap();

    // app_details:
    // 1. org/secret (explicitly is_private = true)
    // 2. org/etag-only-secret (legacy row with is_private = false, only known private from ETag payload)
    // 3. org/card-only-secret (legacy row with is_private = false, known private from repo_card_cache)
    // 4. pub/open (public)
    db.save_app_detail("org/secret", &sample_detail("org/secret", true))
        .unwrap();
    db.save_app_detail("org/detail-only", &sample_detail("org/detail-only", true))
        .unwrap();
    db.save_app_detail(
        "org/etag-only-secret",
        &sample_detail("org/etag-only-secret", false),
    )
    .unwrap();
    db.save_app_detail("pub/open", &sample_detail("pub/open", false))
        .unwrap();
    db.save_app_detail(
        "org/secret-public",
        &sample_detail("org/secret-public", false),
    )
    .unwrap();

    // api_etag_cache:
    // - /user/...
    // - /search/repositories?...
    // - /repos/{private}* (exact, mixed-case, /releases/latest, /readme, ?query)
    // - /repos/{etag-only-secret} with "private": true payload
    // - /repos/{secret-public} & /repos/pub/open (MUST survive!)
    db.save_etag(
        "https://api.github.com/user/starred?per_page=20&page=1",
        "\"u\"",
        "[]",
        now,
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/search/repositories?q=secret+in:name,description&sort=stars&order=desc&per_page=20&page=1",
        "\"s\"",
        "{\"items\":[{\"full_name\":\"org/secret\",\"private\":true}]}",
        now,
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/repos/Org/Secret",
        "\"r1\"",
        "{\"full_name\":\"Org/Secret\",\"private\":true}",
        now,
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/repos/org/secret/releases/latest",
        "\"r2\"",
        "{\"tag_name\":\"v1.0.0\"}",
        now,
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/repos/org/secret/readme",
        "\"r3\"",
        "# Secret README",
        now,
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/repos/org/detail-only/readme",
        "\"r4\"",
        "# Detail Only Secret",
        now,
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/repos/org/etag-only-secret",
        "",
        "{\"full_name\":\"org/etag-only-secret\",\"private\":true}",
        now,
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/repos/org/secret-public",
        "\"pub1\"",
        "{\"full_name\":\"org/secret-public\",\"private\":false}",
        now,
    )
    .unwrap();
    db.save_etag(
        "https://api.github.com/repos/pub/open",
        "\"pub2\"",
        "{\"full_name\":\"pub/open\",\"private\":false}",
        now,
    )
    .unwrap();
}

#[test]
fn manual_logout_purges_all_private_caches_even_when_host_pat_exists() {
    let db = Database::open_in_memory().unwrap();
    seed_private_and_public_caches(&db, Some("ghp_account_b_pat"));
    let cache = std::sync::Mutex::new(Some("gho_account_a".to_string()));

    let fallback = revoke_oauth_session(&db, &cache, RevokeReason::ManualLogout).unwrap();
    assert_eq!(fallback.as_deref(), Some("ghp_account_b_pat"));
    assert_eq!(cache.lock().unwrap().as_deref(), Some("ghp_account_b_pat"));

    // Account A's private caches & signals MUST be purged despite host PAT fallback.
    assert!(db.get_starred_feed_cache("@me:alice").unwrap().is_none());
    assert!(db.get_repo_card("org/secret").unwrap().is_none());
    assert!(db.get_search_list_cache("secret|1|20").unwrap().is_none());
    assert!(!db.is_starred("org", "secret").unwrap());
    let signal_count: i64 = db
        .query_scalar_opt("SELECT COUNT(*) FROM user_repo_signals", [])
        .unwrap()
        .unwrap_or(-1);
    assert_eq!(signal_count, 0);

    // Private app_details & ETags (including /search/repositories) MUST be purged.
    assert!(db.get_app_detail("org/secret", None).unwrap().is_none());
    assert!(db
        .get_app_detail("org/detail-only", None)
        .unwrap()
        .is_none());
    assert!(db
        .get_app_detail("org/etag-only-secret", None)
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/Org/Secret")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/org/secret/releases/latest")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/org/secret/readme")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/org/detail-only/readme")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/org/etag-only-secret")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/search/repositories?q=secret+in:name,description&sort=stars&order=desc&per_page=20&page=1")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/user/starred?per_page=20&page=1")
        .unwrap()
        .is_none());

    // Public caches & prefix-similar public repos MUST survive.
    assert!(db.get_starred_feed_cache("torvalds").unwrap().is_some());
    assert!(db.get_search_list_cache("rust|1|20").unwrap().is_some());
    assert!(db.get_repo_card("org/secret-public").unwrap().is_some());
    assert!(db.get_repo_card("pub/open").unwrap().is_some());
    assert!(db
        .get_app_detail("org/secret-public", None)
        .unwrap()
        .is_some());
    assert!(db.get_app_detail("pub/open", None).unwrap().is_some());
    assert!(db
        .get_etag("https://api.github.com/repos/org/secret-public")
        .unwrap()
        .is_some());
    assert!(db
        .get_etag("https://api.github.com/repos/pub/open")
        .unwrap()
        .is_some());
}

#[test]
fn auth_expired_401_purges_private_details_repo_etags_and_search_etags() {
    let db = Database::open_in_memory().unwrap();
    seed_private_and_public_caches(&db, None);
    let cache = std::sync::Mutex::new(Some("gho_account_a".to_string()));

    let fallback = revoke_oauth_session(&db, &cache, RevokeReason::AuthExpired401).unwrap();
    assert!(fallback.is_none());

    assert!(db.get_starred_feed_cache("@me:alice").unwrap().is_none());
    assert!(db.get_repo_card("org/secret").unwrap().is_none());
    assert!(db.get_search_list_cache("secret|1|20").unwrap().is_none());
    assert!(db.get_app_detail("org/secret", None).unwrap().is_none());
    assert!(db
        .get_app_detail("org/detail-only", None)
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/Org/Secret")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/org/secret/releases/latest")
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/search/repositories?q=secret+in:name,description&sort=stars&order=desc&per_page=20&page=1")
        .unwrap()
        .is_none());

    // Public rows remain intact.
    assert!(db
        .get_app_detail("org/secret-public", None)
        .unwrap()
        .is_some());
    assert!(db
        .get_etag("https://api.github.com/repos/org/secret-public")
        .unwrap()
        .is_some());
}

#[test]
fn persist_detail_bundle_persists_is_private_and_roundtrips_json() {
    let db = Database::open_in_memory().unwrap();
    let detail = sample_detail("org/private-app", false);
    let etags = vec![EtagWrite {
        url: "https://api.github.com/repos/org/private-app".to_string(),
        etag: "\"e1\"".to_string(),
        payload: r#"{"full_name":"org/private-app","private":true}"#.to_string(),
        timestamp: crate::now_secs(),
    }];
    DetailRepository::persist_detail_bundle(&db, "org/private-app", &detail, None, &etags).unwrap();

    let loaded = db.get_app_detail("org/private-app", None).unwrap().unwrap();
    assert!(
        loaded.is_private,
        "repo_private_flag must propagate into app_details.is_private"
    );
    let serialized = serde_json::to_value(&loaded).unwrap();
    assert_eq!(serialized["is_private"], true);

    revoke_oauth_session(
        &db,
        &std::sync::Mutex::new(None),
        RevokeReason::ManualLogout,
    )
    .unwrap();
    assert!(db
        .get_app_detail("org/private-app", None)
        .unwrap()
        .is_none());
    assert!(db
        .get_etag("https://api.github.com/repos/org/private-app")
        .unwrap()
        .is_none());
}

#[test]
fn legacy_app_details_schema_upgrades_with_is_private_column() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE app_details (
            app_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner TEXT NOT NULL,
            repo TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            description_en TEXT,
            icon TEXT NOT NULL DEFAULT '',
            icon_bg TEXT NOT NULL DEFAULT '',
            stars INTEGER NOT NULL DEFAULT 0,
            forks INTEGER NOT NULL DEFAULT 0,
            license TEXT NOT NULL DEFAULT '',
            latest_version TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT 'external',
            category_name TEXT NOT NULL DEFAULT '跨平台开源',
            forge TEXT NOT NULL DEFAULT 'github',
            forge_host TEXT NOT NULL DEFAULT 'github.com',
            homepage TEXT,
            platforms_json TEXT NOT NULL DEFAULT '[]',
            changelog TEXT NOT NULL DEFAULT '',
            readme_markdown TEXT NOT NULL DEFAULT '',
            readme_variants_json TEXT,
            releases_json TEXT NOT NULL DEFAULT '[]',
            cached_at INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO app_details (app_id, name, owner, repo) VALUES ('pub/legacy', 'Legacy', 'pub', 'legacy');
        PRAGMA user_version = 9;
        "#,
    )
    .unwrap();
    let db = Database { conn };
    db.init_schema().unwrap();
    let row = db.get_app_detail("pub/legacy", None).unwrap().unwrap();
    assert!(!row.is_private);
}
