use super::*;
use crate::models::UpdateRule;

#[test]
fn test_is_version_newer() {
    // 4 段式 MSI 与 3 段式 GitHub Release 相同版本时不误报
    assert!(!is_version_newer("3.0.21.0", "v3.0.21"));
    assert!(!is_version_newer("3.0.21", "3.0.21.0"));
    assert!(!is_version_newer("v1.2.3", "1.2.3"));

    // 真实新版本应当触发
    assert!(is_version_newer("3.0.20", "3.0.21"));
    assert!(is_version_newer("v1.0.0", "v1.1.0"));
    assert!(is_version_newer("1.9.9", "2.0.0"));

    // 降级（如 nightly 或用户更高版本）不应当触发
    assert!(!is_version_newer("3.0.22", "3.0.21"));
    assert!(!is_version_newer("1.4.0", "1.3.1"));
}

#[test]
fn test_is_version_newer_matrix() {
    // 子问题 1：预发布版本低于正式版（SemVer 全序：1.0.0-beta.1 < 1.0.0）
    assert!(!is_version_newer("1.0.0", "1.0.0-beta.1"));
    assert!(is_version_newer("1.0.0-beta.1", "1.0.0"));
    assert!(is_version_newer("1.0.0-beta.1", "1.0.0-beta.2"));
    assert!(!is_version_newer("1.0.0-beta.2", "1.0.0-beta.1"));

    // 子问题 2：`tip` 等非 SemVer 标签不对任何版本误报
    assert!(!is_version_newer("1.0.0", "tip"));
    assert!(!is_version_newer("tip", "1.0.0"));
    assert!(!is_version_newer("tip", "tip"));

    // 子问题 3：`R2` 后缀不做数值推测——单侧不可解析一律不提示；
    // 两侧都不可解析才退化为归一化字符串不等。
    assert!(!is_version_newer("v1.5.7", "v26.02-v1.5.7-R2"));
    assert!(is_version_newer("v26.02-v1.5.7-R1", "v26.02-v1.5.7-R2"));
    assert!(!is_version_newer("v26.02-v1.5.7-R2", "v26.02-v1.5.7-R2"));

    // 4 段式 MSI：末段 0 截断后按 SemVer 比较（等值不误报，真升级仍检出）
    assert!(!is_version_newer("3.0.21.0", "v3.0.21"));
    assert!(is_version_newer("3.0.21.0", "3.0.22"));
    assert!(!is_version_newer("3.0.22", "3.0.21.0"));
}

#[test]
fn test_should_include_update() {
    // 1. 无规则，有新版本 -> 应当包含
    assert!(should_include_update("v1.0.0", "v1.1.0", None));
    // 2. 无规则，相同版本 -> 不应当包含
    assert!(!should_include_update("v1.1.0", "v1.1.0", None));

    // 3. 规则锁定 (is_frozen == true) -> 即使有新版本也忽略
    let frozen_rule = UpdateRule {
        app_id: "test".to_string(),
        skipped_version: None,
        is_frozen: true,
        is_hidden: false,
        updated_at: 1000,
    };
    assert!(!should_include_update("v1.0.0", "v2.0.0", Some(&frozen_rule)));

    // 4. 规则隐藏 (is_hidden == true) -> 即使有新版本也忽略
    let hidden_rule = UpdateRule {
        app_id: "test".to_string(),
        skipped_version: None,
        is_frozen: false,
        is_hidden: true,
        updated_at: 1000,
    };
    assert!(!should_include_update("v1.0.0", "v2.0.0", Some(&hidden_rule)));

    // 5. 规则跳过当前最新版本 -> 忽略此最新版本
    let skip_rule = UpdateRule {
        app_id: "test".to_string(),
        skipped_version: Some("v2.0.0".to_string()),
        is_frozen: false,
        is_hidden: false,
        updated_at: 1000,
    };
    assert!(!should_include_update("v1.0.0", "v2.0.0", Some(&skip_rule)));
    assert!(!should_include_update("v1.0.0", "2.0.0", Some(&skip_rule))); // v 前缀容错

    // 6. 规则跳过了 v2.0.0，但推出了更新的 v2.1.0 -> 应当恢复提示！
    assert!(should_include_update("v1.0.0", "v2.1.0", Some(&skip_rule)));
}

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

    let selected = select_best_asset(&assets).unwrap();
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    assert_eq!(selected.name, "rustdesk-1.4.9-x86_64.msi");
}

#[test]
fn test_decide_ownership_verified_requires_api_auth() {
    // README 命中 + 未授权（wrong token / 无 token）⇒ 恒为 false：
    // 子串命中 alone NEVER verifies。
    assert!(!super::forge::decide_ownership_verified(
        "welcome CODE123 here",
        "CODE123",
        false
    ));
    // owner + API-ok（README 命中且仓库 API 确认 push 权限）⇒ true。
    assert!(super::forge::decide_ownership_verified(
        "welcome CODE123 here",
        "CODE123",
        true
    ));
    // README 未命中 + API-ok ⇒ false。
    assert!(!super::forge::decide_ownership_verified(
        "no code here",
        "CODE123",
        true
    ));
    // 空校验码 ⇒ 恒为 false（即使 API-ok）。
    assert!(!super::forge::decide_ownership_verified(
        "welcome CODE123 here",
        "   ",
        true
    ));
    assert!(!super::forge::decide_ownership_verified("anything", "", true));
}

#[test]
fn test_base64_encode_and_icon_cache_path() {
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");

    assert_eq!(detect_image_mime(b"\x89PNG\r\n\x1a\n123"), "image/png");
    assert_eq!(detect_image_mime(b"GIF89a..."), "image/gif");
    assert_eq!(detect_image_mime(&[0xff, 0xd8, 0xff, 0x00]), "image/jpeg");
    assert_eq!(detect_image_mime(b"<svg xmlns=..."), "image/svg+xml");

    // canonical id（owner/repo）优先解析为 {owner}_{repo}.png 唯一命名空间
    let p1 = get_icon_cache_path("rustdesk/rustdesk", "https://github.com/rustdesk.png");
    assert!(p1.to_string_lossy().ends_with("rustdesk_rustdesk.png"));

    let p2 = get_icon_cache_path("microsoft/terminal", "https://github.com/microsoft.png");
    assert!(p2.to_string_lossy().ends_with("microsoft_terminal.png"));

    let p3 = get_icon_cache_path("alacritty/alacritty", "https://github.com/alacritty.png");
    assert!(p3.to_string_lossy().ends_with("alacritty_alacritty.png"));

    // 无法解析为仓库坐标的 id：消毒后直接命名
    let p4 = get_icon_cache_path("localsend", "https://github.com/localsend.png");
    assert!(p4.to_string_lossy().ends_with("localsend.png"));
}
