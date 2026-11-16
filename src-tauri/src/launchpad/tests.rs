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
        vec![pin("ghost/none", FUTURE, 1), pin("acme/hyper-term", "not-a-date", 2)],
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
