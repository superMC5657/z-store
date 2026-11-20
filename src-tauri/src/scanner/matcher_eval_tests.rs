//! 基于 `catalog.json` 的纯打分与指派质量基准测试。

use super::matcher::CatalogMatchIndex;
use super::{ConfidenceTier, ScannedRawApp};
use crate::github::CatalogItem;

fn real_catalog() -> Vec<CatalogItem> {
    serde_json::from_str(include_str!("../../../catalog.json")).expect("catalog.json parses")
}

fn app(
    name: &str,
    version: &str,
    publisher: Option<&str>,
    location: Option<&str>,
    icon: Option<&str>,
) -> ScannedRawApp {
    ScannedRawApp {
        display_name: name.to_string(),
        display_version: version.to_string(),
        publisher: publisher.map(str::to_string),
        install_location: location.map(str::to_string),
        display_icon: icon.map(str::to_string),
        ..Default::default()
    }
}

/// (本机名称, 匹配到的收录 id, 置信度, 依据)
fn assign_ids(
    scanned: &[ScannedRawApp],
    catalog: &[CatalogItem],
) -> Vec<(String, String, f32, String)> {
    // 测试样本均为 Windows 注册表/安装路径形态，跨平台 CI（Linux/macOS）需固定按 windows 标识建索引。
    let index = CatalogMatchIndex::build_for_platform(catalog, "windows");
    index
        .assign(scanned)
        .into_iter()
        .map(|a| {
            (
                scanned[a.scanned_index].display_name.clone(),
                a.catalog.id.clone(),
                a.confidence(),
                a.reasons()
                    .iter()
                    .map(|r| r.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
            )
        })
        .collect()
}

#[test]
fn adversarial_non_catalog_apps_produce_zero_false_positives() {
    let catalog = real_catalog();
    let adversarial = vec![
        app(
            "Miniconda3 py311_24.1.2-0 (Python 3.11.7 64-bit)",
            "py311_24.1.2-0",
            Some("Anaconda, Inc."),
            Some(r"C:\Users\admin\miniconda3"),
            Some(r"C:\Users\admin\miniconda3\Menu\console_shortcut.ico"),
        ),
        app(
            "WPS Office (12.1.0.17827)",
            "12.1.0.17827",
            Some("Kingsoft Corp."),
            Some(r"C:\Program Files\WPS Office"),
            Some(r"C:\Program Files\WPS Office\office6\wps.exe"),
        ),
        app(
            "Microsoft Office Professional Plus 2021 - zh-cn",
            "16.0.17928.20156",
            Some("Microsoft Corporation"),
            Some(r"C:\Program Files\Microsoft Office"),
            None,
        ),
        app(
            "Microsoft Visual Studio IDE 2022",
            "17.10.35013.160",
            Some("Microsoft Corporation"),
            Some(r"C:\Program Files\Microsoft Visual Studio\2022\Community"),
            Some(r"C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\devenv.exe"),
        ),
        app(
            "Factorio",
            "1.1.110",
            Some("Wube Software LTD."),
            Some(r"C:\Program Files\Factorio"),
            Some(r"C:\Program Files\Factorio\bin\x64\factorio.exe"),
        ),
        app(
            "Twitch",
            "8.0.0",
            Some("Twitch Interactive, Inc."),
            Some(r"C:\Users\admin\AppData\Roaming\Twitch"),
            Some(r"C:\Users\admin\AppData\Roaming\Twitch\Bin\Twitch.exe"),
        ),
        app(
            "Dolby Atmos",
            "3.20500.511.0",
            Some("Dolby Laboratories"),
            Some(r"C:\Program Files\Dolby\Dolby Atmos"),
            None,
        ),
        app(
            "AnyDesk",
            "ad 8.0.14",
            Some("AnyDesk Software GmbH"),
            Some(r"C:\Program Files (x86)\AnyDesk"),
            Some(r"C:\Program Files (x86)\AnyDesk\AnyDesk.exe"),
        ),
        app(
            "TeamViewer",
            "15.57.5",
            Some("TeamViewer"),
            Some(r"C:\Program Files\TeamViewer"),
            Some(r"C:\Program Files\TeamViewer\TeamViewer.exe"),
        ),
        app(
            "1Password 8",
            "8.10.40",
            Some("AgileBits Inc."),
            Some(r"C:\Users\admin\AppData\Local\1Password\app\8"),
            Some(r"C:\Users\admin\AppData\Local\1Password\app\8\1Password.exe"),
        ),
        app(
            "Postman x86_64 11.2.0",
            "11.2.0",
            Some("Postman"),
            Some(r"C:\Users\admin\AppData\Local\Postman"),
            Some(r"C:\Users\admin\AppData\Local\Postman\app.ico"),
        ),
        app(
            "Mozilla Firefox (x64 zh-CN)",
            "128.0",
            Some("Mozilla"),
            Some(r"C:\Program Files\Mozilla Firefox"),
            Some(r"C:\Program Files\Mozilla Firefox\firefox.exe,0"),
        ),
        app(
            "Epic Games Launcher",
            "1.3.93.0",
            Some("Epic Games, Inc."),
            Some(r"C:\Program Files (x86)\Epic Games\"),
            None,
        ),
        app(
            "WinRAR 7.01 (64-bit)",
            "7.01.0",
            Some("win.rar GmbH"),
            Some(r"C:\Program Files\WinRAR\"),
            Some(r"C:\Program Files\WinRAR\WinRAR.exe"),
        ),
        app(
            "Navicat Premium 17",
            "17.0.10",
            Some("PremiumSoft CyberTech Ltd."),
            Some(r"C:\Program Files\PremiumSoft\Navicat Premium 17\"),
            Some(r"C:\Program Files\PremiumSoft\Navicat Premium 17\navicat.exe"),
        ),
        app(
            "NVIDIA Graphics Driver 560.94",
            "560.94",
            Some("NVIDIA Corporation"),
            None,
            Some(r"C:\Windows\system32\nvidia-smi.exe"),
        ),
        app(
            "Realtek Audio Console",
            "1.0.0",
            Some("Realtek Semiconductor Corp."),
            None,
            None,
        ),
        app(
            "Docker Desktop",
            "4.33.1",
            Some("Docker Inc."),
            Some(r"C:\Program Files\Docker\Docker"),
            Some(r"C:\Program Files\Docker\Docker\Docker Desktop.exe"),
        ),
        app(
            "7-Zip 24.08 (x64)",
            "24.08",
            Some("Igor Pavlov"),
            Some(r"C:\Program Files\7-Zip"),
            Some(r"C:\Program Files\7-Zip\7zFM.exe"),
        ),
    ];

    let matches = assign_ids(&adversarial, &catalog);
    assert!(
        matches.is_empty(),
        "unexpected false positives: {matches:#?}"
    );
}

#[test]
fn curated_real_world_installed_variants_recall_accurately() {
    let catalog = real_catalog();
    let local = r"C:\Users\admin\AppData\Local";
    let cases: Vec<(ScannedRawApp, &str, Option<ConfidenceTier>)> = vec![
        (
            app(
                "Microsoft Visual Studio Code (User)",
                "1.92.0",
                Some("Microsoft Corporation"),
                Some(&format!(r"{local}\Programs\Microsoft VS Code\")),
                Some(&format!(r"{local}\Programs\Microsoft VS Code\Code.exe")),
            ),
            "microsoft/vscode",
            Some(ConfidenceTier::High),
        ),
        (
            app(
                "VSCodium (User)",
                "1.92.0",
                Some("VSCodium"),
                Some(&format!(r"{local}\Programs\VSCodium\")),
                Some(&format!(r"{local}\Programs\VSCodium\VSCodium.exe")),
            ),
            "vscodium/vscodium",
            Some(ConfidenceTier::High),
        ),
        (
            app(
                "Notepad++ (64-bit x64)",
                "8.6.9",
                Some("Notepad++ Team"),
                Some(r"C:\Program Files\Notepad++"),
                Some(r"C:\Program Files\Notepad++\notepad++.exe"),
            ),
            "notepad-plus-plus/notepad-plus-plus",
            Some(ConfidenceTier::High),
        ),
        (
            app(
                "Notepad Next",
                "0.7",
                None,
                Some(r"C:\Program Files\NotepadNext"),
                Some(r"C:\Program Files\NotepadNext\NotepadNext.exe"),
            ),
            "dail8859/notepadnext",
            Some(ConfidenceTier::High),
        ),
        (
            app("Motrix 1.8.18", "1.8.18", Some("Dr_rOot"), None, None),
            "agalwood/motrix",
            None,
        ),
        (
            app(
                "GitHub Desktop",
                "3.4.8",
                Some("GitHub, Inc."),
                Some(&format!(r"{local}\GitHubDesktop")),
                Some(&format!(r"{local}\GitHubDesktop\app.ico")),
            ),
            "desktop/desktop",
            None,
        ),
        (
            app(
                "VLC media player 3.0.20",
                "3.0.20",
                Some("VideoLAN"),
                Some(r"C:\Program Files\VideoLAN\VLC"),
                Some(r"C:\Program Files\VideoLAN\VLC\vlc.exe,0"),
            ),
            "videolan/vlc",
            Some(ConfidenceTier::High),
        ),
        (
            app(
                "RustDesk",
                "1.3.0",
                Some("RustDesk"),
                Some(r"C:\Program Files\RustDesk"),
                Some(r"C:\Program Files\RustDesk\rustdesk.exe"),
            ),
            "rustdesk/rustdesk",
            Some(ConfidenceTier::High),
        ),
        (
            app(
                "Clash Verge",
                "1.7.7",
                None,
                Some(r"C:\Program Files\Clash Verge"),
                Some(r"C:\Program Files\Clash Verge\Clash Verge.exe"),
            ),
            "clash-verge-rev/clash-verge-rev",
            None,
        ),
        (
            app(
                "Bulk Crap Uninstaller",
                "5.8",
                Some("Marcin Szeniak"),
                Some(r"C:\Program Files\BCUninstaller"),
                Some(r"C:\Program Files\BCUninstaller\Bulk-Crap-Uninstaller.exe"),
            ),
            "bcuninstaller/bulk-crap-uninstaller",
            None,
        ),
        (
            app(
                "思源笔记",
                "3.1.0",
                None,
                None,
                Some(r"D:\SiYuan\SiYuan.exe"),
            ),
            "siyuan-note/siyuan",
            None,
        ),
    ];
    let scanned: Vec<ScannedRawApp> = cases.iter().map(|(a, _, _)| a.clone()).collect();
    let matches = assign_ids(&scanned, &catalog);

    for (fixture, expected_id, expected_tier) in &cases {
        let hit = matches
            .iter()
            .find(|(name, ..)| *name == fixture.display_name)
            .unwrap_or_else(|| {
                panic!(
                    "{} was not matched; all: {matches:#?}",
                    fixture.display_name
                )
            });
        assert_eq!(hit.1, *expected_id, "{}: {hit:?}", fixture.display_name);
        if let Some(tier) = expected_tier {
            let actual = ConfidenceTier::from_score(hit.2);
            assert_eq!(actual, *tier, "{}: {hit:?}", fixture.display_name);
        }
    }
    assert_eq!(matches.len(), cases.len(), "{matches:#?}");
}

#[test]
fn inverted_index_matches_full_catalog_in_bounded_time() {
    let catalog = real_catalog();
    let mut scanned: Vec<ScannedRawApp> = Vec::new();
    for i in 0..360 {
        scanned.push(app(
            &format!("Vendor Utility Suite {i} Component"),
            &format!("{}.{}.{}", i % 7, i % 13, i),
            Some(&format!("Vendor {} Corporation", i % 17)),
            Some(&format!(r"C:\Program Files\Vendor{}\Suite {i}", i % 17)),
            Some(&format!(
                r"C:\Program Files\Vendor{}\Suite {i}\suite{i}.exe",
                i % 17
            )),
        ));
    }
    for item in catalog.iter().take(40) {
        scanned.push(app(&item.name, "", None, None, None));
    }

    let start = std::time::Instant::now();
    let first = assign_ids(&scanned, &catalog);
    let elapsed = start.elapsed();
    let second = assign_ids(&scanned, &catalog);
    assert_eq!(first, second, "matching must be deterministic");
    // debug 模式下 2-vCPU CI 并发跑全量单测约 100~200ms；放宽至 500ms 消除抖动，仍可捕获 O(N*M) 退化。
    assert!(
        elapsed < std::time::Duration::from_millis(500),
        "full-catalog match took {elapsed:?}"
    );
}

#[test]
fn variant_guard_requires_whole_token_evidence() {
    let catalog = real_catalog();
    // 路径里 `zhang` / `trevor` 含 `ng` / `rev` 子串，但不是变体词证据
    let upstream = vec![
        app(
            "GoldenDict",
            "1.5.0",
            None,
            Some(r"C:\Users\zhang\AppData\Local\GoldenDict"),
            Some(r"C:\Users\zhang\AppData\Local\GoldenDict\GoldenDict.exe"),
        ),
        app(
            "Clash Verge",
            "1.3.8",
            None,
            Some(r"C:\Users\trevor\AppData\Local\Clash Verge"),
            Some(r"C:\Users\trevor\AppData\Local\Clash Verge\clash-verge.exe"),
        ),
    ];
    let matches = assign_ids(&upstream, &catalog);
    assert!(
        matches
            .iter()
            .all(|(_, id, ..)| id != "xiaoyifang/goldendict-ng"
                && id != "clash-verge-rev/clash-verge-rev"),
        "variant entry matched without whole-token evidence: {matches:#?}"
    );

    let variants = vec![
        (
            app(
                "GoldenDict-ng",
                "24.09.0",
                None,
                Some(r"C:\Program Files\GoldenDict-ng"),
                Some(r"C:\Program Files\GoldenDict-ng\goldendict.exe"),
            ),
            "xiaoyifang/goldendict-ng",
        ),
        (
            app(
                "7-Zip ZS 24.07 (x64)",
                "24.07",
                Some("Tino Reichardt"),
                Some(r"C:\Program Files\7-Zip-Zstandard"),
                Some(r"C:\Program Files\7-Zip-Zstandard\7zFM.exe"),
            ),
            "mcmilk/7-zip-zstd",
        ),
        (
            app(
                "NotepadNext",
                "0.7",
                None,
                Some(r"C:\Program Files\NotepadNext"),
                Some(r"C:\Program Files\NotepadNext\NotepadNext.exe"),
            ),
            "dail8859/notepadnext",
        ),
    ];
    let scanned: Vec<ScannedRawApp> = variants.iter().map(|(a, _)| a.clone()).collect();
    let matches = assign_ids(&scanned, &catalog);
    for (fixture, expected_id) in &variants {
        let hit = matches
            .iter()
            .find(|(name, ..)| *name == fixture.display_name)
            .unwrap_or_else(|| {
                panic!(
                    "{} was not matched; all: {matches:#?}",
                    fixture.display_name
                )
            });
        assert_eq!(hit.1, *expected_id, "{hit:?}");
    }
}

#[test]
fn linux_platform_index_recalls_linux_identifiers_and_windows_fallback() {
    use super::MatchReason;
    let catalog = real_catalog();
    let index = CatalogMatchIndex::build_for_platform(&catalog, "linux");
    let scanned = vec![
        app(
            "Clash Verge Rev",
            "2.5.10",
            None,
            Some("/usr/bin/clash-verge"),
            None,
        ),
        app(
            "Notepad++",
            "8.6.9",
            None,
            Some("/opt/notepad++/notepad++"),
            None,
        ),
    ];
    let matches: Vec<(String, String, Vec<MatchReason>)> = index
        .assign(&scanned)
        .into_iter()
        .map(|a| {
            (
                scanned[a.scanned_index].display_name.clone(),
                a.catalog.id.clone(),
                a.reasons().to_vec(),
            )
        })
        .collect();
    let clash = matches
        .iter()
        .find(|(name, ..)| name == "Clash Verge Rev")
        .expect("Clash Verge Rev matched");
    assert_eq!(clash.1, "clash-verge-rev/clash-verge-rev");
    assert!(
        clash.2.contains(&MatchReason::Executable),
        "expected linux native identifier match: {clash:?}"
    );

    let npp = matches
        .iter()
        .find(|(name, ..)| name == "Notepad++")
        .expect("Notepad++ matched");
    assert_eq!(npp.1, "notepad-plus-plus/notepad-plus-plus");
    assert!(
        npp.2.contains(&MatchReason::Executable),
        "expected linux fallback from windows .exe identifier: {npp:?}"
    );
}
