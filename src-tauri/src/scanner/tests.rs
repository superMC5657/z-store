use super::*;
use crate::github::CatalogItem;

fn create_mock_catalog() -> Vec<CatalogItem> {
    vec![
        CatalogItem {
            id: "videolan/vlc".to_string(),
            name: "VLC Media Player".to_string(),
            chinese_name: Some("VLC 播放器".to_string()),
            owner: "videolan".to_string(),
            repo: "vlc".to_string(),
            icon: "vlc.svg".to_string(),
            icon_bg: "#ff8800".to_string(),
            description: "开源全能媒体播放器".to_string(),
            category: "multimedia".to_string(),
            category_name: "影音视听".to_string(),
            aliases: vec!["vlc".to_string(), "videolan".to_string()],
            default_version: "v3.0.21".to_string(),
            license: "GPL-2.0".to_string(),
            stars: 45000,
            forks: 7000,
            is_verified: true,
            publisher_fingerprint: None,
            homepage: None,
            executables: vec!["vlc.exe".to_string()],
            install_dirs: vec!["VideoLAN\\VLC".to_string(), "VLC".to_string()],
            search_subdirs: vec![],
            publishers: vec!["VideoLAN".to_string()],
            platforms: vec!["windows".to_string(), "macos".to_string(), "linux".to_string()],
        },
        CatalogItem {
            id: "obsproject/obs-studio".to_string(),
            name: "OBS Studio".to_string(),
            chinese_name: Some("OBS 直播录屏".to_string()),
            owner: "obsproject".to_string(),
            repo: "obs-studio".to_string(),
            icon: "obs.svg".to_string(),
            icon_bg: "#302e31".to_string(),
            description: "开源直播与录屏工具".to_string(),
            category: "multimedia".to_string(),
            category_name: "影音视听".to_string(),
            aliases: vec!["obs".to_string(), "bilibili".to_string()],
            default_version: "v31.0.1".to_string(),
            license: "GPL-2.0".to_string(),
            stars: 62000,
            forks: 11000,
            is_verified: true,
            publisher_fingerprint: None,
            homepage: None,
            executables: vec!["obs64.exe".to_string(), "obs.exe".to_string()],
            install_dirs: vec!["obs-studio".to_string()],
            search_subdirs: vec!["bin/64bit".to_string(), "bin".to_string()],
            publishers: vec!["OBS Project".to_string()],
            platforms: vec!["windows".to_string(), "macos".to_string(), "linux".to_string()],
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
        },
        ScannedRawApp {
            display_name: "OBS Studio".to_string(),
            display_version: "31.0.1".to_string(),
            publisher: Some("OBS Project".to_string()),
            install_location: Some(r"C:\Program Files\obs-studio".to_string()),
            display_icon: None,
            uninstall_string: None,
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
        },
        ScannedRawApp {
            display_name: "Motrix 1.8.19".to_string(),
            display_version: "1.8.19".to_string(),
            publisher: Some("Dr_rOot".to_string()),
            install_location: None,
            display_icon: Some(r#"E:\Program Files\Motrix\Motrix.exe,0"#.to_string()),
            uninstall_string: None,
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
        },
        ScannedRawApp {
            display_name: "Telegram Desktop".to_string(),
            display_version: "6.9.3".to_string(),
            publisher: Some("Telegram FZ-LLC".to_string()),
            install_location: Some(r#"E:\Program Files\Telegram Desktop\"#.to_string()),
            display_icon: Some(r#"E:\Program Files\Telegram Desktop\Telegram.exe"#.to_string()),
            uninstall_string: None,
        },
    ];

    let results = AppScanner::match_apps(&scanned, &catalog);
    assert_eq!(results.len(), 4);
    assert!(results.iter().any(|r| r.catalog_id == "qbittorrent"));
    assert!(results.iter().any(|r| r.catalog_id == "motrix"));
    assert!(results.iter().any(|r| r.catalog_id == "playnite"));
    assert!(results.iter().any(|r| r.catalog_id == "telegram-desktop"));
}

#[test]
fn test_resolve_lnk_target() {
    let lnk = std::path::Path::new(
        r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Clash Verge.lnk",
    );
    if lnk.exists() {
        let target = AppScanner::resolve_lnk_target(lnk);
        println!("RESOLVED LNK TARGET for Clash Verge: {:?}", target);
        assert!(target.is_some());
    }
}

#[test]
fn test_resolve_installed_app_path_real() {
    // 测试真实系统环境中存量软件的多源嗅探能力（注册表/多磁盘/快捷方式解构）
    let path1 = AppScanner::resolve_installed_app_path(
        "Clash Verge Rev",
        "clash-verge-rev",
        Some("clash-verge-rev"),
    );
    println!("Clash Verge resolved path: {:?}", path1);

    let path2 = AppScanner::resolve_installed_app_path("WezTerm", "wezterm", Some("wezterm"));
    println!("WezTerm resolved path: {:?}", path2);

    let path3 =
        AppScanner::resolve_installed_app_path("qBittorrent", "qbittorrent", Some("qBittorrent"));
    println!("qBittorrent resolved path: {:?}", path3);

    let path4 =
        AppScanner::resolve_installed_app_path("Oh My Posh", "oh-my-posh", Some("oh-my-posh"));
    println!("Oh My Posh resolved path: {:?}", path4);

    assert!(path1.is_some() || path2.is_some() || path3.is_some());

    // 测试不存在的应用返回 None，绝不产生假路径或 Panic
    let non_existent =
        AppScanner::resolve_installed_app_path("NonExistentApp999", "non-existent-app-999", None);
    println!("NonExistent resolved path: {:?}", non_existent);
    assert!(non_existent.is_none());
}

#[test]
fn test_batch_detect_catalog_apps() {
    let cfg = crate::config::get_project_config();
    let catalog: Vec<CatalogItem> = cfg
        .catalog
        .load_catalog_items()
        .expect("failed to load catalog via config local_path");
    let start = std::time::Instant::now();
    let mut detected = Vec::new();
    for cat in &catalog {
        if let Some(path) =
            AppScanner::resolve_installed_app_path(&cat.name, &cat.id, Some(&cat.repo))
        {
            detected.push((cat.id.clone(), cat.name.clone(), path));
        }
    }
    let elapsed = start.elapsed();
    println!("Batch detected {} apps in {:?}", detected.len(), elapsed);
    for (id, name, path) in &detected {
        println!("  [DETECTED] {} ({}): {}", name, id, path);
    }
}
