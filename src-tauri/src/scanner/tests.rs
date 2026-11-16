use super::*;
use crate::github::CatalogItem;

const TEST_ICON_BG_VLC: &str = "#ff8800";
const TEST_ICON_BG_OBS: &str = "#302e31";

/// 测试本地临时目录 helper（收敛 current_dir + tempdir_in 样板，仅测试代码）。
fn temp_test_dir(prefix: &str) -> tempfile::TempDir {
    let parent = std::env::current_dir().expect("current_dir for temp_test_dir");
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(parent)
        .expect("temp_test_dir")
}

fn create_mock_catalog() -> Vec<CatalogItem> {
    vec![
        CatalogItem {
            id: "videolan/vlc".to_string(),
            name: "VLC Media Player".to_string(),
            owner: "videolan".to_string(),
            repo: "vlc".to_string(),
            icon: "vlc.svg".to_string(),
            icon_bg: TEST_ICON_BG_VLC.to_string(),
            description: "开源全能媒体播放器".to_string(),
            description_en: Some("Open source multimedia player".to_string()),
            category: "multimedia".to_string(),
            category_name: "影音视听".to_string(),
            aliases: vec!["vlc".to_string(), "videolan".to_string()],
            default_version: "v3.0.21".to_string(),
            added_at: None,
            license: "GPL-2.0".to_string(),
            stars: 45000,
            forks: 7000,
            is_verified: true,
            homepage: None,
            identifiers: std::collections::HashMap::from([
                ("windows".to_string(), vec!["vlc.exe".to_string()]),
                ("linux".to_string(), vec!["vlc".to_string()]),
            ]),
            install_dirs: vec!["VideoLAN\\VLC".to_string(), "VLC".to_string()],
            search_subdirs: vec![],
            publishers: vec!["VideoLAN".to_string()],
            platforms: vec![
                "windows".to_string(),
                "macos".to_string(),
                "linux".to_string(),
            ],
        },
        CatalogItem {
            id: "obsproject/obs-studio".to_string(),
            name: "OBS Studio".to_string(),
            owner: "obsproject".to_string(),
            repo: "obs-studio".to_string(),
            icon: "obs.svg".to_string(),
            icon_bg: TEST_ICON_BG_OBS.to_string(),
            description: "开源直播与录屏工具".to_string(),
            description_en: Some(
                "Open source software for video recording and live streaming".to_string(),
            ),
            category: "multimedia".to_string(),
            category_name: "影音视听".to_string(),
            aliases: vec!["obs".to_string(), "bilibili".to_string()],
            default_version: "v31.0.1".to_string(),
            added_at: None,
            license: "GPL-2.0".to_string(),
            stars: 62000,
            forks: 11000,
            is_verified: true,
            homepage: None,
            identifiers: std::collections::HashMap::from([
                (
                    "windows".to_string(),
                    vec!["obs64.exe".to_string(), "obs.exe".to_string()],
                ),
                ("linux".to_string(), vec!["obs".to_string()]),
            ]),
            install_dirs: vec!["obs-studio".to_string()],
            search_subdirs: vec!["bin/64bit".to_string(), "bin".to_string()],
            publishers: vec!["OBS Project".to_string()],
            platforms: vec![
                "windows".to_string(),
                "macos".to_string(),
                "linux".to_string(),
            ],
        },
    ]
}

#[test]
fn test_match_apps_high_confidence() {
    let catalog = create_mock_catalog();
    let scanned = vec![
        ScannedRawApp {
            display_name: "VLC media player 3.0.21".to_string(),
            display_version: "3.0.21".to_string(),
            publisher: Some("VideoLAN".to_string()),
            install_location: Some(r"C:\Program Files\VideoLAN\VLC".to_string()),
            display_icon: Some(r"C:\Program Files\VideoLAN\VLC\vlc.exe,0".to_string()),
            uninstall_string: Some(r"C:\Program Files\VideoLAN\VLC\uninstall.exe".to_string()),
            installed_at: None,
        },
        ScannedRawApp {
            display_name: "OBS Studio".to_string(),
            display_version: "31.0.1".to_string(),
            publisher: Some("OBS Project".to_string()),
            install_location: Some(r"C:\Program Files\obs-studio".to_string()),
            display_icon: None,
            uninstall_string: None,
            installed_at: None,
        },
    ];

    let results = AppScanner::match_apps(&scanned, &catalog);
    assert_eq!(results.len(), 2);

    let vlc_match = results
        .iter()
        .find(|r| r.catalog_id == "videolan/vlc")
        .unwrap();
    assert!(vlc_match.confidence >= 0.70);
    assert_eq!(vlc_match.confidence_tier, "high");

    let obs_match = results
        .iter()
        .find(|r| r.catalog_id == "obsproject/obs-studio")
        .unwrap();
    assert!(obs_match.confidence >= 0.70);
    assert_eq!(obs_match.confidence_tier, "high");
}

#[test]
fn test_match_apps_unrelated_filtered() {
    let catalog = create_mock_catalog();
    let scanned = vec![ScannedRawApp {
        display_name: "Some Proprietary Tool 1.0".to_string(),
        display_version: "1.0.0".to_string(),
        publisher: Some("Unknown Corp".to_string()),
        install_location: None,
        display_icon: None,
        uninstall_string: None,
        installed_at: None,
    }];

    let results = AppScanner::match_apps(&scanned, &catalog);
    assert_eq!(results.len(), 0);
}

#[test]
fn test_clean_display_icon() {
    let p1 = AppScanner::clean_display_icon(r#""C:\Program Files\VideoLAN\VLC\vlc.exe",0"#);
    assert_eq!(
        p1,
        Some(std::path::PathBuf::from(
            r#"C:\Program Files\VideoLAN\VLC\vlc.exe"#
        ))
    );

    let p2 = AppScanner::clean_display_icon(r#"C:\Program Files\App\app.exe,-1"#);
    assert_eq!(
        p2,
        Some(std::path::PathBuf::from(r#"C:\Program Files\App\app.exe"#))
    );

    let p3 = AppScanner::clean_display_icon(r#""C:\App\app.exe""#);
    assert_eq!(p3, Some(std::path::PathBuf::from(r#"C:\App\app.exe"#)));

    let p4 = AppScanner::clean_display_icon(r#"C:\App\not_an_exe.dll"#);
    assert_eq!(p4, None);
}

#[test]
fn test_match_expanded_apps_from_catalog() {
    let cfg = crate::config::get_project_config();
    let catalog: Vec<CatalogItem> = cfg
        .catalog
        .load_catalog_items()
        .expect("failed to load catalog via config local_path");
    let scanned = vec![
        ScannedRawApp {
            display_name: "qBittorrent".to_string(),
            display_version: "5.0.3.10".to_string(),
            publisher: Some("The qBittorrent project".to_string()),
            install_location: None,
            display_icon: Some(r#""E:\Program Files\qBittorrent\qbittorrent.exe",0"#.to_string()),
            uninstall_string: None,
            installed_at: None,
        },
        ScannedRawApp {
            display_name: "Motrix 1.8.19".to_string(),
            display_version: "1.8.19".to_string(),
            publisher: Some("Dr_rOot".to_string()),
            install_location: None,
            display_icon: Some(r#"E:\Program Files\Motrix\Motrix.exe,0"#.to_string()),
            uninstall_string: None,
            installed_at: None,
        },
        ScannedRawApp {
            display_name: "Playnite".to_string(),
            display_version: "10.37".to_string(),
            publisher: Some("Josef Nemec".to_string()),
            install_location: Some(r#"C:\Users\user\AppData\Local\Playnite\"#.to_string()),
            display_icon: Some(
                r#"C:\Users\user\AppData\Local\Playnite\Playnite.DesktopApp.exe"#.to_string(),
            ),
            uninstall_string: None,
            installed_at: None,
        },
        ScannedRawApp {
            display_name: "Telegram Desktop".to_string(),
            display_version: "6.9.3".to_string(),
            publisher: Some("Telegram FZ-LLC".to_string()),
            install_location: Some(r#"E:\Program Files\Telegram Desktop\"#.to_string()),
            display_icon: Some(r#"E:\Program Files\Telegram Desktop\Telegram.exe"#.to_string()),
            uninstall_string: None,
            installed_at: None,
        },
    ];

    let results = AppScanner::match_apps(&scanned, &catalog);
    assert_eq!(results.len(), 4);
    // ADR-0010：真实清单 id 为 canonical owner/repo
    assert!(results
        .iter()
        .any(|r| r.catalog_id == "qbittorrent/qbittorrent"));
    assert!(results.iter().any(|r| r.catalog_id == "agalwood/motrix"));
    assert!(results
        .iter()
        .any(|r| r.catalog_id == "josefnemec/playnite"));
    assert!(results
        .iter()
        .any(|r| r.catalog_id == "telegramdesktop/tdesktop"));
}

#[test]
fn test_is_installer_or_cache_path() {
    assert!(AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\App\unins000.exe")
    ));
    assert!(AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\App\setup.exe")
    ));
    assert!(AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\Package Cache\app.exe")
    ));
    assert!(AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\Temp\app.exe")
    ));
    assert!(AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\Windows\Installer\{GUID}\app.exe")
    ));
    for aux in [
        "Update.exe",
        "crashpad_handler.exe",
        "elevate.exe",
        "foo-setup.exe",
    ] {
        assert!(
            AppScanner::is_installer_or_cache_path(&std::path::Path::new(r"C:\App").join(aux)),
            "{aux}"
        );
    }

    assert!(!AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\Program Files\VLC\vlc.exe")
    ));
    assert!(!AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\Programs\Tool\tool.exe")
    ));
    // 只含 temp 子串的路径段不算缓存目录
    assert!(!AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\Users\tempuser\AppData\Local\Programs\Motrix\Motrix.exe")
    ));
    assert!(!AppScanner::is_installer_or_cache_path(
        std::path::Path::new(r"C:\Program Files\Core Temp\Core Temp.exe")
    ));
}

#[test]
fn valid_app_executable_exempts_declared_targets() {
    let targets = vec!["bulk-crap-uninstaller.exe".to_string()];
    let p = |s: &str| std::path::PathBuf::from(s);
    assert!(AppScanner::is_valid_app_executable(
        &p(r"C:\Program Files\BCUninstaller\Bulk-Crap-Uninstaller.exe"),
        &targets
    ));
    for aux in [
        "unins000.exe",
        "Update.exe",
        "crashpad_handler.exe",
        "elevate.exe",
    ] {
        assert!(
            !AppScanner::is_valid_app_executable(&p(r"C:\App").join(aux), &targets),
            "{aux}"
        );
    }
    assert!(!AppScanner::is_valid_app_executable(
        &p(r"C:\Users\x\AppData\Local\Temp\Bulk-Crap-Uninstaller.exe"),
        &targets
    ));
}

#[test]
fn clean_display_icon_handles_quotes_and_index_in_any_order() {
    let expected = Some(std::path::PathBuf::from(r"C:\Program Files\App\app.exe"));
    for raw in [
        r#""C:\Program Files\App\app.exe,0""#,
        r#""C:\Program Files\App\app.exe",0"#,
        r#"C:\Program Files\App\app.exe,-101"#,
        r#"  "C:\Program Files\App\app.exe" , 0 "#,
    ] {
        assert_eq!(AppScanner::clean_display_icon(raw), expected, "{raw}");
    }
    assert_eq!(
        AppScanner::clean_display_icon(r#""C:\Users\Public\Desktop\App.lnk",0"#),
        Some(std::path::PathBuf::from(r"C:\Users\Public\Desktop\App.lnk"))
    );
}

#[test]
fn find_exe_prefers_newest_squirrel_app_dir_over_update_exe() {
    let temp_dir = temp_test_dir(".test_squirrel_");
    let root = temp_dir.path();
    std::fs::write(root.join("Update.exe"), b"dummy").unwrap();
    for ver in ["app-3.5.0", "app-3.6.10", "app-3.6.9"] {
        let d = root.join(ver);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("GitHubDesktop.exe"), b"dummy").unwrap();
    }
    let config = ScanConfig {
        target_executables: vec!["GitHubDesktop.exe".to_string()],
        install_dirs: vec!["GitHubDesktop".to_string()],
        search_subdirs: vec![],
    };
    assert_eq!(
        AppScanner::find_exe_in_directory(root, &config).map(std::path::PathBuf::from),
        Some(root.join("app-3.6.10").join("GitHubDesktop.exe"))
    );
}

#[test]
fn find_exe_does_not_guess_in_multi_binary_directory() {
    let temp_dir = temp_test_dir(".test_multi_exe_");
    let root = temp_dir.path();
    std::fs::write(root.join("foo.exe"), b"dummy").unwrap();
    std::fs::write(root.join("bar.exe"), b"dummy").unwrap();
    let config = ScanConfig {
        target_executables: vec!["demo.exe".to_string()],
        install_dirs: vec!["demo".to_string()],
        search_subdirs: vec![],
    };
    assert!(AppScanner::find_exe_in_directory(root, &config).is_none());
    // 文件名与配置词元一致时多二进制目录也可采纳
    std::fs::write(root.join("Demo.exe"), b"dummy").unwrap();
    let found = AppScanner::find_exe_in_directory(root, &config).unwrap();
    assert!(found.to_lowercase().ends_with("demo.exe"));
}

#[test]
fn bulk_crap_uninstaller_resolves_as_declared_target() {
    let temp_dir = temp_test_dir(".test_bcu_");
    let root = temp_dir.path();
    std::fs::write(root.join("Bulk-Crap-Uninstaller.exe"), b"dummy").unwrap();
    std::fs::write(root.join("unins000.exe"), b"dummy").unwrap();
    let config = ScanConfig {
        target_executables: vec!["Bulk-Crap-Uninstaller.exe".to_string()],
        install_dirs: vec!["BCUninstaller".to_string()],
        search_subdirs: vec![],
    };
    let found = AppScanner::find_exe_in_directory(root, &config).unwrap();
    assert!(found.ends_with("Bulk-Crap-Uninstaller.exe"));
}

#[test]
fn installer_asset_identifiers_are_detected() {
    use super::types::is_installer_asset_identifier as asset;
    for (id, repo, name) in [
        (
            "npp.8.9.8.Installer.arm64.exe",
            "notepad-plus-plus",
            "Notepad++",
        ),
        ("GitHubDesktopSetup-x64.exe", "desktop", "GitHub Desktop"),
        ("rio-portable-aarch64.exe", "rio", "Rio"),
        (
            "SQLiteDatabaseBrowserPortable_3.13.1.paf.exe",
            "sqlitebrowser",
            "DB Browser",
        ),
        ("Wave-win32-x64.exe", "waveterm", "Wave Terminal"),
        (
            "OpenShellSetup_4_4_198.exe",
            "open-shell-menu",
            "Open-Shell",
        ),
    ] {
        assert!(asset(id, repo, name), "{id}");
    }
    for (id, repo, name) in [
        (
            "Bulk-Crap-Uninstaller.exe",
            "bulk-crap-uninstaller",
            "BCUninstaller",
        ),
        ("x64dbg.exe", "x64dbg", "x64dbg"),
        ("obs64.exe", "obs-studio", "OBS Studio"),
        ("mpv.net.exe", "mpv.net", "mpv.net"),
        ("Playnite.DesktopApp.exe", "playnite", "Playnite"),
        ("terminal.exe", "terminal", "Windows Terminal"),
    ] {
        assert!(!asset(id, repo, name), "{id}");
    }
}

#[cfg(target_os = "windows")]
#[test]
fn scan_config_keeps_repo_candidates_alongside_curated_identifiers() {
    let mut cat = create_mock_catalog().remove(0);
    cat.repo = "motrix".to_string();
    cat.name = "Motrix".to_string();
    cat.identifiers.insert(
        "windows".to_string(),
        vec![
            "Motrix-Setup-1.8.19.exe".to_string(),
            "Motrix.exe".to_string(),
        ],
    );
    let config = ScanConfig::from(&cat);
    assert_eq!(config.target_executables[0], "Motrix.exe");
    assert!(!config
        .target_executables
        .iter()
        .any(|t| t.contains("Setup")));
    assert!(config
        .target_executables
        .contains(&"motrix.exe".to_string()));
}

#[test]
fn test_parse_install_date_to_unix() {
    use crate::scanner::registry::parse_install_date_to_unix;

    // YYYYMMDD
    let ts = parse_install_date_to_unix("20260915");
    assert!(ts.is_some());
    let ts_val = ts.unwrap();

    // YYYY-MM-DD
    let ts2 = parse_install_date_to_unix("2026-09-15");
    assert_eq!(ts2, Some(ts_val));

    // YYYY/MM/DD
    let ts3 = parse_install_date_to_unix("2026/09/15");
    assert_eq!(ts3, Some(ts_val));

    // YYYY.MM.DD
    let ts4 = parse_install_date_to_unix("2026.09.15");
    assert_eq!(ts4, Some(ts_val));

    // Invalid dates
    assert_eq!(parse_install_date_to_unix(""), None);
    assert_eq!(parse_install_date_to_unix("not-a-date"), None);
    assert_eq!(parse_install_date_to_unix("20261301"), None);
}

#[test]
fn test_detect_path_installed_at() {
    let temp_file = tempfile::NamedTempFile::new().unwrap();
    let ts = AppScanner::detect_path_installed_at(temp_file.path().to_str().unwrap());
    assert!(ts.is_some());
    let now = super::types::now_secs();
    assert!((ts.unwrap() - now).abs() <= 10);

    assert_eq!(
        AppScanner::detect_path_installed_at(r"C:\non_existent_folder_xyz_123\not_real.exe"),
        None
    );
}

#[test]
fn test_find_exe_in_directory_deterministic() {
    let temp_dir = temp_test_dir(".test_find_exe_");
    let root = temp_dir.path();
    let config = ScanConfig {
        target_executables: vec!["demo-app.exe".to_string(), "demo.exe".to_string()],
        install_dirs: vec!["demo-app".to_string()],
        search_subdirs: vec!["bin/x64".to_string()],
    };

    // 1. 空目录返回 None
    assert!(AppScanner::find_exe_in_directory(root, &config).is_none());

    // 2. 存在匹配可执行文件时返回完整路径
    let target = root.join("demo-app.exe");
    std::fs::write(&target, b"dummy").unwrap();
    assert_eq!(
        AppScanner::find_exe_in_directory(root, &config).map(std::path::PathBuf::from),
        Some(target.clone())
    );
    std::fs::remove_file(&target).unwrap();

    // 3. 存在子目录匹配 (search_subdirs)
    let sub = root.join("bin").join("x64");
    std::fs::create_dir_all(&sub).unwrap();
    let sub_target = sub.join("demo.exe");
    std::fs::write(&sub_target, b"dummy").unwrap();
    assert_eq!(
        AppScanner::find_exe_in_directory(root, &config).map(std::path::PathBuf::from),
        Some(sub_target.clone())
    );
    std::fs::remove_file(&sub_target).unwrap();

    // 4. 单 exe 浅遍历推断（排除安装包与卸载程序）
    let single_exe = root.join("any_unique_name.exe");
    std::fs::write(&single_exe, b"dummy").unwrap();
    let uninstaller = root.join("unins000.exe");
    std::fs::write(&uninstaller, b"dummy").unwrap();
    assert_eq!(
        AppScanner::find_exe_in_directory(root, &config).map(std::path::PathBuf::from),
        Some(single_exe)
    );
}

#[test]
fn test_resolve_lnk_target_safety() {
    // 1. 不存在的文件应安全返回 None
    assert!(
        AppScanner::resolve_lnk_target(std::path::Path::new(r"C:\non_existent_file.lnk")).is_none()
    );

    // 2. 小于 76 字节或损坏的数据应安全返回 None 而不 Panic
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), b"invalid header data").unwrap();
    assert!(AppScanner::resolve_lnk_target(temp.path()).is_none());
}

#[test]
fn test_resolve_lnk_target_fixture() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let fixture_path = std::path::Path::new(manifest_dir)
        .join("tests")
        .join("fixtures")
        .join("sample_cmd.lnk");

    if fixture_path.exists() {
        let resolved = AppScanner::resolve_lnk_target(&fixture_path);
        #[cfg(target_os = "windows")]
        {
            assert!(resolved.is_some(), "should resolve sample_cmd.lnk target");
            let target = resolved.unwrap();
            assert!(
                target.to_string_lossy().to_lowercase().ends_with("cmd.exe"),
                "target should end with cmd.exe, got: {:?}",
                target
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Windows 快捷方式目标在 Linux 上不可能存在：解析必须优雅返回 None，绝不 panic。
            assert!(resolved.is_none());
        }
    }
}

#[test]
fn test_resolve_installed_app_path_non_existent() {
    // 测试不存在的应用返回 None，绝不产生假路径或 Panic（在任何纯净环境/CI 均稳定）
    let non_existent =
        AppScanner::resolve_installed_app_path("NonExistentApp999", "non-existent-app-999", None);
    assert!(non_existent.is_none());
}

#[test]
fn test_resolve_installed_app_path_deterministic() {
    let test_app_id = "deterministic-test-app";
    let portable_dir = crate::installer::dirs_or_fallback_with_base(test_app_id, None);
    std::fs::create_dir_all(&portable_dir).expect("failed to create portable test dir");
    let fake_exe = portable_dir.join("deterministic-test-app.exe");
    std::fs::write(&fake_exe, b"MZ fake executable").expect("failed to write fake exe");

    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _guard = Cleanup(portable_dir.clone());

    let resolved =
        AppScanner::resolve_installed_app_path("Deterministic Test App", test_app_id, None);
    assert!(resolved.is_some(), "should resolve deterministic test app");
    assert_eq!(std::path::PathBuf::from(resolved.unwrap()), fake_exe);
}

// ============================================================================
// 本地开发环境专用测试（依赖本机存量软件与全盘扫描，仅按需执行: cargo test -- --ignored）
// ============================================================================

#[ignore = "requires Clash Verge shortcut installed at C:\\ProgramData\\..."]
#[test]
fn test_resolve_lnk_target_local() {
    let lnk = std::path::Path::new(
        r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Clash Verge.lnk",
    );
    if lnk.exists() {
        let target = AppScanner::resolve_lnk_target(lnk);
        assert!(target.is_some());
    }
}

#[ignore = "requires real local installed apps (e.g. Clash Verge, WezTerm, qBittorrent, Oh My Posh)"]
#[test]
fn test_resolve_installed_app_path_real() {
    // 测试真实系统环境中存量软件的多源嗅探能力（注册表/多磁盘/快捷方式解构）
    let path1 = AppScanner::resolve_installed_app_path(
        "Clash Verge Rev",
        "clash-verge-rev",
        Some("clash-verge-rev"),
    );
    let path2 = AppScanner::resolve_installed_app_path("WezTerm", "wezterm", Some("wezterm"));

    let path3 =
        AppScanner::resolve_installed_app_path("qBittorrent", "qbittorrent", Some("qBittorrent"));

    let _path4 =
        AppScanner::resolve_installed_app_path("Oh My Posh", "oh-my-posh", Some("oh-my-posh"));

    assert!(path1.is_some() || path2.is_some() || path3.is_some());
}

#[ignore = "benchmark/exploratory scan on local host, runs across all catalog items"]
#[test]
fn test_batch_detect_catalog_apps() {
    let cfg = crate::config::get_project_config();
    let catalog: Vec<CatalogItem> = cfg
        .catalog
        .load_catalog_items()
        .expect("failed to load catalog via config local_path");
    let mut detected = Vec::new();
    for cat in &catalog {
        if let Some(path) =
            AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo))
        {
            detected.push((cat.id.clone(), cat.name.clone(), path));
        }
    }
    assert!(
        detected.len() <= catalog.len(),
        "detected apps must be a subset of catalog"
    );
}

#[test]
fn test_match_unmanaged_filters_managed_with_canonical_healing_and_no_fabrication() {
    let mut catalog = create_mock_catalog();
    catalog.push(CatalogItem {
        id: "rustdesk/rustdesk".to_string(),
        name: "RustDesk".to_string(),
        owner: "rustdesk".to_string(),
        repo: "rustdesk".to_string(),
        icon: String::new(),
        icon_bg: String::new(),
        description: String::new(),
        description_en: None,
        category: "system".to_string(),
        category_name: "系统实用".to_string(),
        aliases: vec![],
        default_version: "v1.0.0".to_string(),
        added_at: None,
        license: "AGPL-3.0".to_string(),
        stars: 0,
        forks: 0,
        is_verified: false,
        homepage: None,
        identifiers: std::collections::HashMap::new(),
        install_dirs: vec![],
        search_subdirs: vec![],
        publishers: vec![],
        platforms: vec![],
    });
    let scanned = vec![
        ScannedRawApp {
            display_name: "VLC media player".to_string(),
            display_version: String::new(),
            publisher: Some("VideoLAN".to_string()),
            install_location: None,
            display_icon: None,
            uninstall_string: None,
            installed_at: None,
        },
        ScannedRawApp {
            display_name: "RustDesk".to_string(),
            display_version: String::new(),
            publisher: Some("RustDesk".to_string()),
            install_location: None,
            display_icon: None,
            uninstall_string: None,
            installed_at: None,
        },
        ScannedRawApp {
            display_name: " utterly-unrelated-thing ".to_string(),
            display_version: String::new(),
            publisher: None,
            install_location: None,
            display_icon: None,
            uninstall_string: None,
            installed_at: None,
        },
    ];
    // 大小写漂移行 `RustDesk/RustDesk` 经 canonical 归一识别为已纳管并剔除
    let results =
        AppScanner::match_unmanaged(&scanned, &catalog, ["RustDesk/RustDesk".to_string()]);
    assert_eq!(results.len(), 1, "only unmanaged VLC should remain");
    assert_eq!(results[0].catalog_id, "videolan/vlc");
}

#[test]
fn test_import_path_prefers_executable_then_install_location() {
    let make = |exe: Option<&str>, loc: Option<&str>| AppMatchResult {
        scanned: ScannedRawApp {
            display_name: "Windows Terminal".to_string(),
            display_version: "1.0".to_string(),
            publisher: None,
            install_location: loc.map(str::to_string),
            display_icon: Some("/opt/icons/wt.ico".to_string()),
            uninstall_string: None,
            installed_at: None,
        },
        catalog_id: "microsoft/terminal".to_string(),
        name: "Windows Terminal".to_string(),
        owner: "microsoft".to_string(),
        repo: "terminal".to_string(),
        icon: String::new(),
        icon_bg: String::new(),
        description: String::new(),
        local_version: "1.0".to_string(),
        catalog_version: "1.0".to_string(),
        confidence: 0.6,
        confidence_tier: "medium".to_string(),
        resolved_executable_path: exe.map(str::to_string),
    };

    assert_eq!(
        make(Some("/opt/wt/wt.exe"), Some("/opt/wt")).import_path(),
        Some("/opt/wt/wt.exe")
    );
    assert_eq!(
        make(None, Some("\"/opt/wt\"")).import_path(),
        Some("/opt/wt")
    );
    // 只有图标路径不算可导入路径
    assert_eq!(make(None, None).import_path(), None);
    assert_eq!(make(None, Some("  ")).import_path(), None);
}

#[test]
fn test_format_fixed_version() {
    use super::version::format_fixed_version;
    assert_eq!(
        format_fixed_version([0, 1, 3853, 0]).as_deref(),
        Some("0.1.3853")
    );
    assert_eq!(
        format_fixed_version([1, 2, 3, 4]).as_deref(),
        Some("1.2.3.4")
    );
    assert_eq!(format_fixed_version([2, 0, 0, 0]).as_deref(), Some("2.0.0"));
    assert_eq!(format_fixed_version([0, 0, 0, 0]), None);
}

fn registry_entry(version: &str, location: Option<&str>, icon: Option<&str>) -> ScannedRawApp {
    ScannedRawApp {
        display_name: "Magpie".to_string(),
        display_version: version.to_string(),
        publisher: None,
        install_location: location.map(str::to_string),
        display_icon: icon.map(str::to_string),
        uninstall_string: None,
        installed_at: None,
    }
}

#[test]
fn test_detect_local_version_prefers_registry_then_executable() {
    let exe = |_: &str| Some("0.1.3853".to_string());
    assert_eq!(
        AppScanner::detect_local_version("v2.0.0", Some("a.exe"), exe).as_deref(),
        Some("v2.0.0")
    );
    assert_eq!(
        AppScanner::detect_local_version("  ", Some("a.exe"), exe).as_deref(),
        Some("0.1.3853")
    );
    // 都没有时版本未知，不回落到收录库版本
    assert_eq!(AppScanner::detect_local_version("", None, exe), None);
    assert_eq!(
        AppScanner::detect_local_version("", Some("a.exe"), |_| None),
        None
    );
}

#[test]
fn test_detect_installed_version_matches_registry_entry_by_path() {
    let entries = vec![
        registry_entry("9.9.9", Some(r"C:\Users\me\AppData\Local\Programs"), None),
        registry_entry(
            "",
            Some(r"C:\Users\me\AppData\Local\Programs\magpie\"),
            None,
        ),
        registry_entry("1.0.0", Some(r"C:\Other"), None),
    ];
    let exe = |p: &str| {
        assert!(p.ends_with("magpie.exe"));
        Some("0.1.3853".to_string())
    };
    // 取安装目录最长的那条（magpie 自身条目，版本为空 → 读主程序）
    assert_eq!(
        AppScanner::detect_installed_version(
            &entries,
            "c:/users/me/appdata/local/programs/magpie/magpie.exe",
            exe
        )
        .as_deref(),
        Some("0.1.3853")
    );

    let by_icon = vec![registry_entry(
        "3.1.0",
        None,
        Some(r#""C:\Tools\foo.exe",0"#),
    )];
    assert_eq!(
        AppScanner::detect_installed_version(&by_icon, r"C:\Tools\foo.exe", |_| None).as_deref(),
        Some("3.1.0")
    );

    // 找到条目但注册表与主程序都没有版本：版本未知（空串），用于清掉早先填充的收录库版本
    assert_eq!(
        AppScanner::detect_installed_version(
            &entries,
            r"C:\Users\me\AppData\Local\Programs\magpie",
            |_| panic!("a directory is not an executable")
        )
        .as_deref(),
        Some("")
    );

    // 找不到注册表条目时保持原版本，不读主程序
    assert_eq!(
        AppScanner::detect_installed_version(&entries, r"D:\Portable\magpie.exe", |_| {
            panic!("must not read exe without a registry entry")
        }),
        None
    );
}

#[test]
fn test_same_version_ignores_v_prefix_and_whitespace() {
    use super::version::same_version;
    assert!(same_version("v0.1.4095", "0.1.4095"));
    assert!(same_version(" V1.2.3 ", "v1.2.3"));
    assert!(!same_version("0.1.3853", "v0.1.4095"));
    assert!(!same_version("", "1.0.0"));
}

#[cfg(target_os = "windows")]
#[test]
fn test_read_exe_version_reads_system_executable() {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".to_string());
    let notepad = format!(r"{windir}\System32\notepad.exe");
    let version = AppScanner::read_exe_version(&notepad).expect("notepad has a version resource");
    assert!(version.split('.').count() >= 3, "{version}");
    assert_eq!(
        AppScanner::read_exe_version(&format!(r"{windir}\System32")),
        None
    );
    assert_eq!(
        AppScanner::read_exe_version(r"Z:\definitely\missing.exe"),
        None
    );
}
