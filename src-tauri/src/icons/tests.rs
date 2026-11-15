use super::*;
use crate::db::{AppIconCycle, Database};

#[test]
fn test_bytes_to_data_uri_and_base64() {
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");

    let png_bytes = b"\x89PNG\r\n\x1a\n";
    let uri = bytes_to_data_uri(png_bytes);
    assert!(uri.starts_with("data:image/png;base64,"));

    let svg_bytes = b"<svg></svg>";
    let svg_uri = bytes_to_data_uri(svg_bytes);
    assert!(svg_uri.starts_with("data:image/svg+xml;base64,"));
}

#[test]
fn test_source_and_fallback_mapping() {
    assert_eq!(source_for_level(1), "official");
    assert_eq!(source_for_level(2), "simple-icons");
    assert_eq!(source_for_level(3), "trees");
    assert_eq!(source_for_level(4), "readme");
    assert_eq!(source_for_level(5), "none");
    assert_eq!(source_for_level(0), "none");

    assert!(!is_fallback_for_level(1));
    assert!(is_fallback_for_level(2));
    assert!(is_fallback_for_level(3));
    assert!(is_fallback_for_level(4));
    assert!(is_fallback_for_level(5));
}

#[test]
fn test_resolve_icon_coord_variants_and_acceptance() {
    let (id, r) = resolve_icon_coord("rustdesk/rustdesk").unwrap();
    assert_eq!(id, "rustdesk/rustdesk");
    assert_eq!(r.owner, "rustdesk");
    assert_eq!(r.repo, "rustdesk");

    let (id, r) = resolve_icon_coord("RustDesk/RustDesk").unwrap();
    assert_eq!(id, "rustdesk/rustdesk");
    assert_eq!(r.owner, "RustDesk");
    assert_eq!(r.repo, "RustDesk");

    let (id, r) = resolve_icon_coord("https://github.com/agalwood/Motrix").unwrap();
    assert_eq!(id, "agalwood/motrix");
    assert_eq!(r.owner, "agalwood");
    assert_eq!(r.repo, "Motrix");

    let (id, r) = resolve_icon_coord("gh:vlang/v").unwrap();
    assert_eq!(id, "vlang/v");
    assert_eq!(r.owner, "vlang");
    assert_eq!(r.repo, "v");

    assert!(resolve_icon_coord("xyz:owner/repo").is_err());
    assert!(resolve_icon_coord("").is_err());
    assert!(resolve_icon_coord("   ").is_err());
    assert!(resolve_icon_coord("justaname").is_err());

    let cases = [
        "owner/repo",
        "Owner/Repo",
        "gh:owner/repo",
        "codeberg:FreeTubeApp/FreeTube",
        "gitea:git.example.com/owner/repo",
        "https://github.com/owner/repo",
        "xyz:owner/repo",
        "no-slash-id",
        "owner/repo/extra",
    ];
    for c in cases {
        assert_eq!(
            resolve_icon_coord(c).is_ok(),
            crate::commands::require_app_id(c).is_ok(),
            "acceptance diverged for {c}"
        );
    }
}

#[test]
fn test_next_cycle_level_progression_and_wrap() {
    let mut cycle = AppIconCycle {
        app_id: "test/test".to_string(),
        owner: "test".to_string(),
        repo: "test".to_string(),
        is_cataloged: true,
        level: 1,
        l1_url: "https://example.com/1.png".to_string(),
        l2_url: "https://example.com/2.png".to_string(),
        l3_url: "https://example.com/3.png".to_string(),
        l4_url: "https://example.com/4.png".to_string(),
        selected_url: "https://example.com/1.png".to_string(),
        cache_file: "test.png".to_string(),
        updated_at: 0,
        pinned: false,
    };

    assert_eq!(next_cycle_level(1, &cycle), 2);
    assert_eq!(next_cycle_level(2, &cycle), 3);
    assert_eq!(next_cycle_level(3, &cycle), 4);
    assert_eq!(next_cycle_level(4, &cycle), 5);
    assert_eq!(next_cycle_level(5, &cycle), 1);

    cycle.l2_url.clear();
    cycle.l3_url.clear();
    assert_eq!(next_cycle_level(1, &cycle), 4);
    assert_eq!(next_cycle_level(4, &cycle), 5);
    assert_eq!(next_cycle_level(5, &cycle), 1);

    cycle.l4_url.clear();
    assert_eq!(next_cycle_level(1, &cycle), 5);
    assert_eq!(next_cycle_level(5, &cycle), 1);

    cycle.l1_url.clear();
    assert_eq!(next_cycle_level(1, &cycle), 5);
    assert_eq!(next_cycle_level(5, &cycle), 5);

    let non_cat = AppIconCycle {
        app_id: "noncat/test".to_string(),
        owner: "noncat".to_string(),
        repo: "test".to_string(),
        is_cataloged: false,
        level: 2,
        l1_url: String::new(),
        l2_url: "https://example.com/2.png".to_string(),
        l3_url: "https://example.com/3.png".to_string(),
        l4_url: "https://example.com/4.png".to_string(),
        selected_url: "https://example.com/2.png".to_string(),
        cache_file: "test_l2.png".to_string(),
        updated_at: 0,
        pinned: false,
    };
    assert_eq!(next_cycle_level(2, &non_cat), 3);
    assert_eq!(next_cycle_level(3, &non_cat), 4);
    assert_eq!(next_cycle_level(4, &non_cat), 5);
    assert_eq!(next_cycle_level(5, &non_cat), 2);

    assert_eq!(first_available_level(&non_cat), Some(2));
    assert_eq!(first_available_level(&cycle), None);
}

#[test]
fn test_hash_candidate_helper_and_filename_single_source() {
    assert!(hash_icon_candidate_filenames(&IconRef::new("", "png")).is_empty());
    assert!(hash_icon_candidate_filenames(&IconRef::new("   ", "png")).is_empty());

    let a_png = IconRef::new("https://example.com/a.png", "png");
    let c = hash_icon_candidate_filenames(&a_png);
    assert_eq!(c.len(), KNOWN_ICON_EXTS.len());
    assert!(c[0].ends_with(".png"));
    let mut seen = std::collections::HashSet::new();
    for f in &c {
        assert!(seen.insert(f.clone()), "duplicate candidate {f}");
    }
    let a_svg = IconRef::new("https://example.com/a.png", "svg");
    assert!(hash_icon_candidate_filenames(&a_svg)[0].ends_with(".svg"));
    assert_eq!(
        c,
        hash_icon_candidate_filenames(&IconRef::new("  https://example.com/a.png  ", "png"))
    );

    let h1_url = "https://github.com/rustdesk.png";
    assert_eq!(
        hash_icon_filename(h1_url, "png"),
        format!(
            "{}.png",
            &crate::sha256_digest_hex(h1_url.trim().as_bytes())[..16]
        )
    );

    let h2_url = "https://localsend.org/app-logo";
    assert_eq!(
        hash_icon_filename(h2_url, "png"),
        format!(
            "{}.png",
            &crate::sha256_digest_hex(h2_url.trim().as_bytes())[..16]
        )
    );

    assert_eq!(
        detect_image_mime(b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00"),
        "image/avif"
    );
    assert_eq!(
        infer_ext_from_url("https://example.com/logo.JPEG?raw=1#top"),
        Some("jpg")
    );
    assert_eq!(mime_to_ext("image/x-icon"), "ico");
}

#[test]
fn test_l5_empty_selection_keeps_cached_file() {
    let db = Database::open_in_memory().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let icons_dir = dir.path();
    let cache_file = "abc123_l2.png";
    std::fs::write(icons_dir.join(cache_file), b"\x89PNG\r\n\x1a\n12345678").unwrap();

    let mut cycle = AppIconCycle {
        app_id: "o/r".to_string(),
        owner: "o".to_string(),
        repo: "r".to_string(),
        is_cataloged: false,
        level: 2,
        l2_url: "https://example.com/2.png".to_string(),
        selected_url: "https://example.com/2.png".to_string(),
        cache_file: cache_file.to_string(),
        updated_at: crate::now_secs(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&cycle).unwrap();

    seal_empty_selection(&mut cycle);
    db.upsert_icon_cycle(&cycle).unwrap();

    assert!(icons_dir.join(cache_file).is_file());
    let row = db.get_icon_cycle("o/r").unwrap().expect("cycle exists");
    assert_eq!(row.level, 5);
    assert!(row.selected_url.is_empty());
    assert!(row.cache_file.is_empty());
    assert_eq!(row.l2_url, "https://example.com/2.png");
}

#[test]
fn test_load_split_cached_bytes_self_heals_empty_cache_file_and_meta() {
    let db = Database::open_in_memory().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let icons_dir = dir.path();
    let png_bytes = b"\x89PNG\r\n\x1a\n12345678";

    let uncat_url = "https://cdn.simpleicons.org/selfheal";
    let uncat_fname = hash_icon_filename(uncat_url, "png");
    std::fs::write(icons_dir.join(&uncat_fname), png_bytes).unwrap();
    let uncat_cycle = AppIconCycle {
        app_id: "heal/uncat".to_string(),
        owner: "heal".to_string(),
        repo: "uncat".to_string(),
        is_cataloged: false,
        level: 2,
        l2_url: uncat_url.to_string(),
        selected_url: uncat_url.to_string(),
        cache_file: String::new(),
        updated_at: crate::now_secs(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&uncat_cycle).unwrap();

    let hit = load_split_cached_bytes(
        icons_dir,
        &db,
        &IconRef::new(uncat_url, "png"),
        false,
        Some(&uncat_cycle),
    );
    assert_eq!(hit.as_deref(), Some(&png_bytes[..]));
    let healed_cycle = db.get_icon_cycle("heal/uncat").unwrap().unwrap();
    assert_eq!(healed_cycle.cache_file, uncat_fname);

    let cat_url = "https://example.com/cat_selfheal.png";
    let cat_fname = hash_icon_filename(cat_url, "png");
    std::fs::write(icons_dir.join(&cat_fname), png_bytes).unwrap();
    let cat_hit =
        load_split_cached_bytes(icons_dir, &db, &IconRef::new(cat_url, "png"), true, None);
    assert_eq!(cat_hit.as_deref(), Some(&png_bytes[..]));
    assert_eq!(
        db.get_icon_cache_url(&cat_fname).unwrap().as_deref(),
        Some(cat_url)
    );
}

#[tokio::test]
async fn test_resolve_confirmed_icon_from_db_scenarios() {
    let db = Database::open_in_memory().unwrap();
    let app_id = "testowner/testrepo";
    let owner = "testowner";
    let repo = "testrepo";

    assert_eq!(
        resolve_confirmed_icon_from_db(&db, app_id, owner, repo),
        None
    );

    let empty_cycle = AppIconCycle {
        app_id: app_id.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        level: 5,
        selected_url: String::new(),
        cache_file: String::new(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&empty_cycle).unwrap();
    assert_eq!(
        resolve_confirmed_icon_from_db(&db, app_id, owner, repo),
        None
    );

    let cycle_missing_file = AppIconCycle {
        app_id: app_id.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        level: 1,
        selected_url: "https://example.com/icon.png".to_string(),
        cache_file: "non_existent_file_12345.png".to_string(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&cycle_missing_file).unwrap();
    assert_eq!(
        resolve_confirmed_icon_from_db(&db, app_id, owner, repo),
        Some("https://example.com/icon.png".to_string())
    );

    let icons_dir = crate::get_app_data_dir().join("icons");
    let _ = std::fs::create_dir_all(&icons_dir);
    let test_filename = "testowner_testrepo_l1.png";
    let test_file_path = icons_dir.join(test_filename);
    let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4";
    std::fs::write(&test_file_path, png_bytes).unwrap();

    let cycle_valid = AppIconCycle {
        app_id: app_id.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        level: 1,
        selected_url: "https://example.com/icon.png".to_string(),
        cache_file: test_filename.to_string(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&cycle_valid).unwrap();

    let resolved = resolve_confirmed_icon_from_db(&db, app_id, owner, repo);
    assert!(resolved.is_some());
    let uri = resolved.unwrap();
    assert!(uri.starts_with("data:image/png;base64,"));

    let resolved_case =
        resolve_confirmed_icon_from_db(&db, "TestOwner/TestRepo", "TestOwner", "TestRepo");
    assert_eq!(resolved_case, Some(uri));

    let _ = std::fs::remove_file(&test_file_path);
}

#[test]
fn search_resolve_falls_back_to_selected_url_and_level4_requires_disk_file() {
    let db = Database::open_in_memory().unwrap();
    let cycle = AppIconCycle {
        app_id: "fallbackowner/fallbackrepo".to_string(),
        owner: "fallbackowner".to_string(),
        repo: "fallbackrepo".to_string(),
        level: 2,
        selected_url: "https://cdn.simpleicons.org/fallbackrepo".to_string(),
        cache_file: String::new(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&cycle).unwrap();
    assert_eq!(
        resolve_confirmed_icon_from_db(
            &db,
            "fallbackowner/fallbackrepo",
            "fallbackowner",
            "fallbackrepo"
        ),
        Some("https://cdn.simpleicons.org/fallbackrepo".to_string())
    );

    let app_id = "m2owner/m2repo";
    let l4_no_file = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "m2owner".to_string(),
        repo: "m2repo".to_string(),
        level: 4,
        selected_url: "https://example.com/m2.png".to_string(),
        cache_file: String::new(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&l4_no_file).unwrap();
    assert_eq!(
        resolve_confirmed_icon_from_db(&db, app_id, "m2owner", "m2repo"),
        None
    );

    let l4_url = "https://example.com/m2_on_disk_l4.png";
    let fname = hash_icon_filename(l4_url, "png");
    let icons_dir = crate::get_app_data_dir().join("icons");
    let _ = std::fs::create_dir_all(&icons_dir);
    let disk_path = icons_dir.join(&fname);
    std::fs::write(&disk_path, b"\x89PNG\r\n\x1a\n12345678").unwrap();
    let l4_on_disk = AppIconCycle {
        app_id: app_id.to_string(),
        owner: "m2owner".to_string(),
        repo: "m2repo".to_string(),
        level: 4,
        selected_url: l4_url.to_string(),
        cache_file: String::new(),
        ..Default::default()
    };
    db.upsert_icon_cycle(&l4_on_disk).unwrap();
    let resolved_l4 = resolve_confirmed_icon_from_db(&db, app_id, "m2owner", "m2repo");
    assert!(resolved_l4
        .as_deref()
        .is_some_and(|s| s.starts_with("data:image/png;base64,")));
    let healed = db.get_icon_cycle(app_id).unwrap().unwrap();
    assert_eq!(healed.cache_file, fname);
    let _ = std::fs::remove_file(&disk_path);
}
