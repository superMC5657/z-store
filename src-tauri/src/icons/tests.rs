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

#[test]
fn base64_encode_matches_reference_for_all_remainders() {
    // 覆盖 0/1/2 余数与全部字节值（含 `+` `/` 字母表尾部）。
    let data: Vec<u8> = (0u8..=255).collect();
    for len in 0..data.len() {
        let got = base64_encode(&data[..len]);
        assert_eq!(got.len(), len.div_ceil(3) * 4);
        assert!(got.is_ascii());
    }
    assert_eq!(base64_encode(b"\xfb\xff\xbf"), "+/+/");
    assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
}

#[test]
fn write_icon_file_failure_keeps_old_files_and_meta() {
    let db = Database::open_in_memory().unwrap();
    let root = tempfile::tempdir().unwrap();
    let missing_dir = root.path().join("absent");
    let png = b"\x89PNG\r\n\x1a\n12345678";
    let url = "https://example.com/fail.png";
    let fname = write_icon_file(
        &missing_dir,
        Some(&db),
        &IconRef::new(url, "png"),
        true,
        png,
    );
    assert!(fname.is_empty(), "write into a missing dir must fail");
    let expected = hash_icon_filename(url, "png");
    assert_eq!(db.get_icon_cache_url(&expected).unwrap(), None);

    let icons_dir = root.path().join("icons");
    std::fs::create_dir_all(&icons_dir).unwrap();
    let ok = write_icon_file(&icons_dir, Some(&db), &IconRef::new(url, "png"), true, png);
    assert_eq!(ok, expected);
    assert!(icons_dir.join(&ok).is_file());
    assert_eq!(db.get_icon_cache_url(&ok).unwrap().as_deref(), Some(url));
}

#[tokio::test]
async fn cache_icon_url_shared_downloads_once_for_concurrent_requests() {
    use crate::test_support::{serve, Reply};
    let server = serve(|_| {
        Reply::ok(&b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"[..]).header("Content-Type", "image/png")
    })
    .await;
    let url = format!("{}/shared-icon.png", server.base);
    let db = std::sync::Mutex::new(Database::open_in_memory().unwrap());
    let root = tempfile::tempdir().unwrap();
    let client = reqwest::Client::new();
    let (a, b) = tokio::join!(
        cache_icon_url_shared(&db, &client, root.path(), &url, false),
        cache_icon_url_shared(&db, &client, root.path(), &url, false)
    );
    let a = a.expect("cached");
    assert_eq!(Some(a.clone()), b);
    assert_eq!(server.hits(), 1, "same selected_url downloads once");
    assert!(root.path().join(&a).is_file());
}

#[tokio::test]
async fn get_or_fetch_icon_rejects_non_image_data_uri() {
    let state = crate::AppState {
        db: std::sync::Arc::new(std::sync::Mutex::new(Database::open_in_memory().unwrap())),
        catalog: crate::github::CatalogService::new_empty(),
        mirror: std::sync::Mutex::new(crate::mirror::MirrorManager::new()),
        github_token: std::sync::Mutex::new(None),
        sync_lock: tokio::sync::Mutex::new(()),
        startup_catalog_synced: std::sync::atomic::AtomicBool::new(false),
    };
    let img = "DATA:image/png;base64,AAAA";
    assert_eq!(
        get_or_fetch_icon(&state, None, img.to_string())
            .await
            .unwrap(),
        img
    );
    assert!(
        get_or_fetch_icon(&state, None, "data:text/html,<b>x</b>".to_string())
            .await
            .is_err()
    );
}

// ---------------------------------------------------------------------------
// IconFetch 世代通道
// ---------------------------------------------------------------------------

#[test]
fn icon_lane_maps_ctx_to_lane_and_expected_gen() {
    let search = IconFetchCtx::Search {
        search_id: "s1".to_string(),
        gen: 7,
    };
    assert_eq!(IconLane::of(&search), (IconLane::Search, 7));
    let trend = IconFetchCtx::Trend {
        board: "weekly".to_string(),
        gen: 3,
    };
    assert_eq!(IconLane::of(&trend), (IconLane::Trend, 3));
    assert_eq!(
        IconLane::of(&IconFetchCtx::Starred { gen: 5 }),
        (IconLane::Starred, 5)
    );
    assert_eq!(
        IconLane::of(&IconFetchCtx::Launchpad { gen: 9 }),
        (IconLane::Launchpad, 9)
    );
}

#[test]
fn icon_lane_advance_is_monotonic_and_observed_by_current() {
    let a = IconLane::Trend.advance();
    assert!(IconLane::Trend.current() >= a);
    let b = IconLane::Trend.advance();
    assert!(b > a, "advance strictly increases");
}

#[test]
fn emit_payload_carries_ctx_through_single_interface() {
    let job = IconFetchJob {
        id: "o/r".to_string(),
        owner: "O".to_string(),
        repo: "R".to_string(),
        ctx: IconFetchCtx::Trend {
            board: "weekly".to_string(),
            gen: 3,
        },
    };
    let p = icon_ready_payload(&job, "https://cdn.simpleicons.org/r", 2, "live");
    assert_eq!(p.id, "o/r");
    assert_eq!(p.level, 2);
    assert_eq!(p.via, "live");
    let v = serde_json::to_value(&p).unwrap();
    assert_eq!(v["context"]["kind"], "trend");
    assert_eq!(v["context"]["board"], "weekly");
    assert_eq!(v["context"]["gen"], 3);
}

/// 内存事件收集器（测试 adapter）。
#[derive(Default)]
struct CollectSink(std::sync::Mutex<Vec<IconReadyPayload>>);

impl IconEventSink for CollectSink {
    fn icon_ready(&self, payload: &IconReadyPayload) {
        self.0.lock().unwrap().push(payload.clone());
    }
}

fn lane_job(gen: u64) -> IconFetchJob {
    IconFetchJob {
        id: "o/r".to_string(),
        owner: "O".to_string(),
        repo: "R".to_string(),
        ctx: IconFetchCtx::Starred { gen },
    }
}

#[test]
fn current_gen_stream_hit_selects_icon_syncs_card_and_emits() {
    let db = std::sync::Mutex::new(Database::open_in_memory().unwrap());
    let sink = CollectSink::default();
    let l3 = "https://raw.githubusercontent.com/o/r/main/icon.png";
    record_stream_hit_with(&db, &lane_job(4), l3, 3, "live", &|| 4, &sink);

    let cycle = db.lock().unwrap().get_icon_cycle("o/r").unwrap().unwrap();
    assert_eq!(cycle.selected_url, l3);
    assert_eq!(cycle.level, 3);
    assert!(!cycle.is_cataloged);
    let events = sink.0.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].id, "o/r");
    assert_eq!(events[0].level, 3);
    assert_eq!(events[0].via, "live");
}

#[test]
fn stale_gen_stream_hit_only_fills_empty_slot_without_emitting() {
    let db = std::sync::Mutex::new(Database::open_in_memory().unwrap());
    let sink = CollectSink::default();
    let l2 = "https://cdn.simpleicons.org/r";
    record_stream_hit_with(&db, &lane_job(1), l2, 2, "live", &|| 1, &sink);
    assert_eq!(sink.0.lock().unwrap().len(), 1);

    // 世代已推进到 2：过期 L4 命中只补 l4 槽，选中态不动、不发射。
    let l4 = "https://raw.githubusercontent.com/o/r/main/logo.png";
    record_stream_hit_with(&db, &lane_job(1), l4, 4, "live", &|| 2, &sink);
    let cycle = db.lock().unwrap().get_icon_cycle("o/r").unwrap().unwrap();
    assert_eq!(cycle.l4_url, l4);
    assert_eq!(cycle.selected_url, l2);
    assert_eq!(cycle.level, 2);
    assert_eq!(sink.0.lock().unwrap().len(), 1, "stale gen must not emit");
}

#[test]
fn gen_advanced_between_write_and_emit_suppresses_event() {
    let db = std::sync::Mutex::new(Database::open_in_memory().unwrap());
    let sink = CollectSink::default();
    // 首次检查为当前世代（落库收编），发射前世代被推进：只写库不发射。
    let calls = std::sync::atomic::AtomicU64::new(0);
    let gen = || {
        if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            5
        } else {
            6
        }
    };
    let l3 = "https://raw.githubusercontent.com/o/r/main/icon.png";
    record_stream_hit_with(&db, &lane_job(5), l3, 3, "live", &gen, &sink);
    let cycle = db.lock().unwrap().get_icon_cycle("o/r").unwrap().unwrap();
    assert_eq!(cycle.selected_url, l3);
    assert!(sink.0.lock().unwrap().is_empty());
}

fn stream_cycle(selected_level: i32, selected_url: &str, pinned: bool) -> crate::db::AppIconCycle {
    let mut c = crate::db::AppIconCycle::new("o/r", "o", "r");
    c.is_cataloged = false;
    c.level = selected_level;
    c.l2_url = "https://cdn.simpleicons.org/r".to_string();
    c.selected_url = selected_url.to_string();
    c.cache_file = "r.png".to_string();
    c.updated_at = 1000;
    c.pinned = pinned;
    c
}

#[test]
fn stale_stream_hit_fills_slot_without_moving_selection() {
    // 不降级守卫：过期 L3 只补 l3 空槽（过期写库），level/selected/cache/updated_at 不动。
    let l3 = "https://raw.githubusercontent.com/o/r/main/icon.png";
    let mut c = stream_cycle(2, "https://cdn.simpleicons.org/r", false);
    let was_pinned = lanes::merge_stream_hit(&mut c, 3, l3, false, 2000, false);
    assert!(!was_pinned);
    assert_eq!(c.l3_url, l3);
    assert_eq!(c.level, 2);
    assert_eq!(c.selected_url, "https://cdn.simpleicons.org/r");
    assert_eq!(c.cache_file, "r.png");
    assert_eq!(c.updated_at, 1000);
}

#[test]
fn fresh_stream_hit_merges_fully_like_merge_detail_icon() {
    // 新鲜命中全量合并：L3 收编选中。
    let l3 = "https://raw.githubusercontent.com/o/r/main/icon.png";
    let mut c = stream_cycle(2, "https://cdn.simpleicons.org/r", false);
    let was_pinned = lanes::merge_stream_hit(&mut c, 3, l3, false, 2000, true);
    assert!(!was_pinned);
    assert_eq!(c.level, 3);
    assert_eq!(c.l3_url, l3);
    assert_eq!(c.selected_url, l3);
    assert_eq!(c.updated_at, 2000);
}

#[test]
fn stale_stream_hit_on_pinned_only_fills_slot() {
    // pinned 行新旧一致：过期 L4 只补槽，不改选中（返回 true）。
    let l4 = "https://raw.githubusercontent.com/o/r/main/logo.png";
    let mut c = stream_cycle(2, "https://cdn.simpleicons.org/r", true);
    let was_pinned = lanes::merge_stream_hit(&mut c, 4, l4, false, 2000, false);
    assert!(was_pinned);
    assert_eq!(c.l4_url, l4);
    assert_eq!(c.level, 2);
    assert_eq!(c.selected_url, "https://cdn.simpleicons.org/r");
    assert_eq!(c.updated_at, 1000);
}

#[test]
fn stale_stream_hit_on_pinned_l5_keeps_badge() {
    // pinned L5（用户手动选空徽章）：过期命中只补槽，level=5 与双空选中态保持（锁徽章态）。
    let l4 = "https://raw.githubusercontent.com/o/r/main/logo.png";
    let mut c = crate::db::AppIconCycle::new("o/r", "o", "r");
    crate::icons::seal_empty_selection(&mut c);
    c.pinned = true;
    let was_pinned = lanes::merge_stream_hit(&mut c, 4, l4, false, 2000, false);
    assert!(was_pinned);
    assert_eq!(c.level, 5);
    assert!(c.selected_url.is_empty());
    assert!(c.cache_file.is_empty());
    assert_eq!(c.l4_url, l4);
}
