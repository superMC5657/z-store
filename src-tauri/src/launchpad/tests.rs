use super::*;

const NOW: i64 = 1_800_000_000; // 2027-01-15T08:00:00Z

fn item(id: &str) -> RawLaunchpadItem {
    let (owner, repo) = id.rsplit_once('/').unwrap();
    RawLaunchpadItem {
        id: id.to_string(),
        name: repo.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        forge: "github".to_string(),
        forge_host: "github.com".to_string(),
        maker_note: "hello".to_string(),
        launched_at: "2027-01-10T00:00:00Z".to_string(),
        discussion_repo: "superMC5657/z-store-launchpad".to_string(),
        discussion_number: 1,
        ..Default::default()
    }
}

fn pin(id: &str, until: &str, order: u32) -> RawLaunchpadPin {
    RawLaunchpadPin {
        id: id.to_string(),
        pin_until: until.to_string(),
        pin_tier: "sponsor".to_string(),
        pin_order: order,
    }
}

fn manifest(items: Vec<RawLaunchpadItem>, pinned: Vec<RawLaunchpadPin>) -> RawLaunchpadManifest {
    RawLaunchpadManifest {
        version: 1,
        generated_at: None,
        discussions_repo: None,
        pinned,
        items,
    }
}

const FUTURE: &str = "2027-02-01T00:00:00Z";
const PAST: &str = "2027-01-01T00:00:00Z";

fn ids(entries: &[LaunchpadEntry]) -> Vec<String> {
    entries.iter().map(|e| e.summary.core.id.clone()).collect()
}

#[test]
fn active_pin_goes_to_spotlight_only() {
    let m = manifest(
        vec![item("a/one"), item("b/two"), item("c/three")],
        vec![pin("b/two", FUTURE, 1)],
    );
    let (spot, recent) = partition_spotlight_and_recent(&m, NOW);
    assert_eq!(ids(&spot), vec!["b/two"]);
    assert!(spot[0].is_pinned);
    assert_eq!(spot[0].pin_tier.as_deref(), Some("sponsor"));
    assert_eq!(ids(&recent), vec!["a/one", "c/three"]);
    assert!(recent.iter().all(|e| !e.is_pinned));
}

#[test]
fn expired_pin_falls_back_to_recent() {
    let m = manifest(
        vec![item("a/one"), item("b/two")],
        vec![pin("b/two", PAST, 1)],
    );
    let (spot, recent) = partition_spotlight_and_recent(&m, NOW);
    assert!(spot.is_empty());
    assert_eq!(ids(&recent), vec!["a/one", "b/two"]);
    assert!(recent.iter().all(|e| !e.is_pinned && e.pin_until.is_none()));
}

#[test]
fn pin_until_equal_to_now_counts_as_expired() {
    let until = time::OffsetDateTime::from_unix_timestamp(NOW)
        .unwrap()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    let m = manifest(vec![item("a/one")], vec![pin("a/one", &until, 1)]);
    let (spot, recent) = partition_spotlight_and_recent(&m, NOW);
    assert!(spot.is_empty());
    assert_eq!(recent.len(), 1);
}

#[test]
fn more_than_four_active_pins_overflow_into_recent() {
    let items: Vec<_> = ["a/p1", "a/p2", "a/p3", "a/p4", "a/p5"]
        .iter()
        .map(|id| item(id))
        .collect();
    let pinned = vec![
        pin("a/p5", FUTURE, 5),
        pin("a/p1", FUTURE, 1),
        pin("a/p3", FUTURE, 3),
        pin("a/p2", FUTURE, 2),
        pin("a/p4", FUTURE, 4),
    ];
    let (spot, recent) = partition_spotlight_and_recent(&manifest(items, pinned), NOW);
    assert_eq!(spot.len(), SPOTLIGHT_MAX_SLOTS);
    assert_eq!(ids(&spot), vec!["a/p1", "a/p2", "a/p3", "a/p4"]);
    assert_eq!(ids(&recent), vec!["a/p5"]);
    assert!(!recent[0].is_pinned);
}

#[test]
fn invalid_duplicate_and_dangling_entries_are_skipped() {
    let mut bad = item("x/y");
    bad.id = "../etc".to_string();
    let m = manifest(
        vec![item("Acme/Hyper-Term"), item("acme/hyper-term"), bad],
        vec![
            pin("ghost/none", FUTURE, 1),
            pin("acme/hyper-term", "not-a-date", 2),
        ],
    );
    let (spot, recent) = partition_spotlight_and_recent(&m, NOW);
    assert!(spot.is_empty());
    assert_eq!(ids(&recent), vec!["acme/hyper-term"]);
}

#[test]
fn data_icons_are_stripped_in_parse_and_sanitize() {
    let mut it = item("a/one");
    it.icon = "data:image/png;base64,AAAA".to_string();
    it.maker.avatar_url = "data:image/svg+xml,<svg/>".to_string();
    let m = manifest(vec![it.clone()], vec![]);
    let (_, recent) = partition_spotlight_and_recent(&m, NOW);
    assert_eq!(recent[0].summary.core.icon, "");
    assert_eq!(recent[0].maker.avatar_url, "");

    let clean = sanitize_manifest(manifest(vec![it], vec![]));
    assert_eq!(clean.items[0].icon, "");
    assert_eq!(clean.items[0].maker.avatar_url, "");

    assert_eq!(sanitize_icon("https://x/icon.png"), "https://x/icon.png");
    assert_eq!(sanitize_icon("http://x/icon.png"), "");
    assert_eq!(sanitize_icon("javascript:alert(1)"), "");
}

#[test]
fn parse_manifest_rejects_wrong_version_and_bad_json() {
    assert!(parse_manifest("{\"version\":2,\"items\":[]}").is_err());
    assert!(parse_manifest("<html>").is_err());
    assert!(parse_manifest("{\"version\":1}").is_ok());
}

#[test]
fn strict_validation_rejects_bad_ids_and_dangling_pins() {
    let mut bad = item("a/one");
    bad.id = "not an id".to_string();
    assert!(validate_manifest_strict(&manifest(vec![bad], vec![])).is_err());
    assert!(validate_manifest_strict(&manifest(
        vec![item("a/one")],
        vec![pin("b/two", FUTURE, 1)]
    ))
    .is_err());
    assert!(validate_manifest_strict(&manifest(
        vec![item("a/one")],
        vec![pin("a/one", FUTURE, 1)]
    ))
    .is_ok());
}

#[test]
fn entry_projection_normalizes_platforms_and_discussion_url() {
    let mut it = item("a/one");
    it.platforms = vec![
        "Windows".to_string(),
        "linux".to_string(),
        "windows".to_string(),
        "beos".to_string(),
    ];
    it.discussion_url = String::new();
    it.discussion_number = 42;
    it.maker_note = "  line one\n line two ".to_string();
    it.stars_7d_delta = -5;
    let (_, recent) = partition_spotlight_and_recent(&manifest(vec![it], vec![]), NOW);
    let e = &recent[0];
    assert_eq!(e.summary.core.platforms, vec!["windows", "linux"]);
    assert_eq!(
        e.discussion_url,
        "https://github.com/superMC5657/z-store-launchpad/discussions/42"
    );
    assert_eq!(e.maker_note, "line one line two");
    assert_eq!(e.stars_7d_delta, 0);
    assert_eq!(e.summary.core.forge.as_deref(), Some("github"));
}

fn preflight_coord(input: &str) -> (crate::forge::UniversalRepoCoord, String) {
    parse_preflight_coord(input).expect("valid coord")
}

fn preflight_repo(license: Option<&str>) -> crate::forge::ForgeRepoInfo {
    crate::forge::ForgeRepoInfo::from_counts(
        "HyperTerm".to_string(),
        Some("GPU terminal".to_string()),
        Some(42),
        Some(5),
        Some("Rust".to_string()),
        Some("main".to_string()),
        Some("https://hyper.example.dev".to_string()),
    )
    .with_license_and_avatar(
        license.map(str::to_string),
        Some("https://avatars.githubusercontent.com/u/1?v=4".to_string()),
    )
}

fn preflight_asset(name: &str, size_bytes: u64) -> crate::models::ReleaseAsset {
    crate::models::ReleaseAsset {
        name: name.to_string(),
        download_url: format!("https://example.com/{name}"),
        size_bytes,
        sha256: None,
        os: String::new(),
        arch: String::new(),
        kind: String::new(),
    }
}

fn preflight_release(tag: &str, assets: Vec<crate::models::ReleaseAsset>) -> crate::forge::ForgeReleaseInfo {
    crate::forge::ForgeReleaseInfo {
        tag_name: tag.to_string(),
        name: Some(tag.to_string()),
        body: None,
        published_at: None,
        assets,
    }
}

#[test]
fn preflight_coord_accepts_shorthand_at_prefix_and_forges() {
    let (c1, id1) = preflight_coord("@Acme/Hyper-Term");
    assert_eq!(c1.forge, crate::forge::ForgeType::GitHub);
    assert_eq!(id1, "acme/hyper-term");

    let (c2, id2) = preflight_coord("https://codeberg.org/FreeTube/FreeTube");
    assert_eq!(c2.forge, crate::forge::ForgeType::Codeberg);
    assert_eq!(id2, "codeberg:freetube/freetube");

    assert!(parse_preflight_coord("invalid query").is_none());
    assert!(!invalid_coord_preflight_result("bad").ok);
}

#[test]
fn preflight_accepts_mit_with_valid_assets_and_icon() {
    let (coord, id) = preflight_coord("acme/hyper-term");
    let repo = preflight_repo(Some("MIT"));
    let release = preflight_release(
        "v1.2.0",
        vec![
            preflight_asset("HyperTerm-1.2.0-setup.exe", 18_000_000),
            preflight_asset("HyperTerm-1.2.0.AppImage", 22_000_000),
            preflight_asset("SHA256SUMS", 512),
        ],
    );
    let allowed = crate::config::LicenseGateConfig::default().allowed;
    let res = evaluate_launchpad_preflight(LaunchpadPreflightInput {
        coord: &coord,
        canonical_id: &id,
        already_in_launchpad: false,
        already_in_catalog: false,
        repo_res: Ok(&repo),
        release_res: Ok(&release),
        icon_outcome: PreflightIconOutcome::AutoProbed(Some(
            "https://cdn.simpleicons.org/hyper".to_string(),
        )),
        allowed_licenses: &allowed,
    });
    assert!(res.ok);
    assert_eq!(res.canonical_id, "acme/hyper-term");
    assert_eq!(res.license, "MIT");
    assert_eq!(res.latest_version, "v1.2.0");
    assert_eq!(res.platforms, vec!["windows", "linux"]);
    assert_eq!(res.installable_asset_count, 2);
    assert!(res.has_checksum_manifest);
    assert_eq!(res.resolved_icon_url, "https://cdn.simpleicons.org/hyper");
    assert!(res
        .checks
        .iter()
        .all(|c| c.status == PreflightCheckStatus::Pass));
}

#[test]
fn preflight_blocks_noassertion_and_non_osi_licenses() {
    let (coord, id) = preflight_coord("acme/prop");
    let allowed = crate::config::LicenseGateConfig::default().allowed;
    let release = preflight_release(
        "v1.0.0",
        vec![preflight_asset("app-setup.exe", 5_000_000)],
    );

    for bad_license in [Some("NOASSERTION"), Some("BUSL-1.1"), None] {
        let repo = preflight_repo(bad_license);
        let res = evaluate_launchpad_preflight(LaunchpadPreflightInput {
            coord: &coord,
            canonical_id: &id,
            already_in_launchpad: false,
            already_in_catalog: false,
            repo_res: Ok(&repo),
            release_res: Ok(&release),
            icon_outcome: PreflightIconOutcome::AutoProbed(None),
            allowed_licenses: &allowed,
        });
        assert!(!res.ok, "expected fail for license {:?}", bad_license);
        let check = res
            .checks
            .iter()
            .find(|c| c.key == PreflightCheckKey::License)
            .unwrap();
        assert_eq!(check.status, PreflightCheckStatus::Fail);
    }
}

#[test]
fn preflight_blocks_missing_or_source_only_releases() {
    let (coord, id) = preflight_coord("acme/no-bin");
    let repo = preflight_repo(Some("Apache-2.0"));
    let allowed = crate::config::LicenseGateConfig::default().allowed;

    let src_only = preflight_release(
        "v0.1.0",
        vec![
            preflight_asset("app-0.1.0-source.tar.gz", 20_000_000),
            preflight_asset("tiny.exe", 500_000),
        ],
    );
    let res1 = evaluate_launchpad_preflight(LaunchpadPreflightInput {
        coord: &coord,
        canonical_id: &id,
        already_in_launchpad: false,
        already_in_catalog: false,
        repo_res: Ok(&repo),
        release_res: Ok(&src_only),
        icon_outcome: PreflightIconOutcome::AutoProbed(None),
        allowed_licenses: &allowed,
    });
    assert!(!res1.ok);
    assert_eq!(
        res1.checks
            .iter()
            .find(|c| c.key == PreflightCheckKey::Release)
            .unwrap()
            .status,
        PreflightCheckStatus::Fail
    );

    let res2 = evaluate_launchpad_preflight(LaunchpadPreflightInput {
        coord: &coord,
        canonical_id: &id,
        already_in_launchpad: false,
        already_in_catalog: false,
        repo_res: Ok(&repo),
        release_res: Err("HTTP 404"),
        icon_outcome: PreflightIconOutcome::AutoProbed(None),
        allowed_licenses: &allowed,
    });
    assert!(!res2.ok);
    assert_eq!(
        res2.checks
            .iter()
            .find(|c| c.key == PreflightCheckKey::Release)
            .unwrap()
            .status,
        PreflightCheckStatus::Fail
    );
}

#[test]
fn preflight_blocks_invalid_custom_icon_scheme_and_warns_on_duplicates() {
    let (coord, id) = preflight_coord("acme/hyper-term");
    let repo = preflight_repo(Some("MIT"));
    let release = preflight_release(
        "v1.0.0",
        vec![preflight_asset("app-setup.exe", 5_000_000)],
    );
    let allowed = crate::config::LicenseGateConfig::default().allowed;

    let bad_icon = evaluate_launchpad_preflight(LaunchpadPreflightInput {
        coord: &coord,
        canonical_id: &id,
        already_in_launchpad: true,
        already_in_catalog: true,
        repo_res: Ok(&repo),
        release_res: Ok(&release),
        icon_outcome: PreflightIconOutcome::CustomInvalidScheme("仅支持 https://".to_string()),
        allowed_licenses: &allowed,
    });
    assert!(!bad_icon.ok);
    assert!(bad_icon.already_in_launchpad);
    assert!(bad_icon.already_in_catalog);
    assert_eq!(
        bad_icon
            .checks
            .iter()
            .find(|c| c.key == PreflightCheckKey::Duplicate)
            .unwrap()
            .status,
        PreflightCheckStatus::Warn
    );
    assert_eq!(
        bad_icon
            .checks
            .iter()
            .find(|c| c.key == PreflightCheckKey::Icon)
            .unwrap()
            .status,
        PreflightCheckStatus::Fail
    );
}
