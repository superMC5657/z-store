use super::*;

#[test]
fn test_select_best_asset() {
    let assets = vec![
        crate::models::ReleaseAsset {
            name: "app-macos.dmg".to_string(),
            download_url: "http://example.com/dmg".to_string(),
            size_bytes: 1000,
            sha256: None,
            os: "macos".to_string(),
            arch: "universal".to_string(),
            kind: "dmg".to_string(),
        },
        crate::models::ReleaseAsset {
            name: "app-setup.exe".to_string(),
            download_url: "http://example.com/exe".to_string(),
            size_bytes: 1000,
            sha256: None,
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            kind: "setup_exe".to_string(),
        },
        crate::models::ReleaseAsset {
            name: "app-linux.AppImage".to_string(),
            download_url: "http://example.com/appimage".to_string(),
            size_bytes: 1000,
            sha256: None,
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            kind: "appimage".to_string(),
        },
    ];

    let selected = select_best_asset(&assets).unwrap();
    #[cfg(target_os = "windows")]
    assert_eq!(selected.os, "windows");
    #[cfg(target_os = "macos")]
    assert_eq!(selected.os, "macos");
    #[cfg(target_os = "linux")]
    assert_eq!(selected.os, "linux");
}

#[test]
fn test_select_best_asset_arch_priority() {
    let assets = vec![
        crate::models::ReleaseAsset {
            name: "rustdesk-1.4.9-aarch64.exe".to_string(),
            download_url: "http://example.com/aarch64".to_string(),
            size_bytes: 1000,
            sha256: None,
            os: "windows".to_string(),
            arch: "aarch64".to_string(),
            kind: "setup_exe".to_string(),
        },
        crate::models::ReleaseAsset {
            name: "rustdesk-1.4.9-x86_64.msi".to_string(),
            download_url: "http://example.com/x86_64".to_string(),
            size_bytes: 1000,
            sha256: None,
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            kind: "msi".to_string(),
        },
    ];

    let selected = select_best_asset(&assets);
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        let selected = selected.unwrap();
        assert_eq!(selected.name, "rustdesk-1.4.9-x86_64.msi");
    }
    #[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
    {
        assert!(
            selected.is_none(),
            "windows-only assets must never be selected on other platforms"
        );
    }
}
