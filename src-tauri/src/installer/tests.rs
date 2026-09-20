use super::*;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

#[test]
fn test_classify_asset() {
    assert_eq!(
        InstallerEngine::classify_asset("vlc-3.0.21-win64.msi").0,
        AssetKind::Msi
    );
    assert_eq!(
        InstallerEngine::classify_asset("RustDesk-1.2.6-Setup.exe").0,
        AssetKind::SetupExe
    );
    assert_eq!(
        InstallerEngine::classify_asset("app-portable.zip").0,
        AssetKind::PortableZip
    );
    assert_eq!(
        InstallerEngine::classify_asset("obs-studio_30.1.2_amd64.deb").0,
        AssetKind::Deb
    );
    assert_eq!(
        InstallerEngine::classify_asset("LocalSend-1.15.2.AppImage").0,
        AssetKind::AppImage
    );
    assert_eq!(
        InstallerEngine::classify_asset("KeePassXC-2.7.9.dmg").0,
        AssetKind::Dmg
    );
    assert_eq!(
        InstallerEngine::classify_asset("Wireshark-4.2.4.pkg").0,
        AssetKind::Pkg
    );
    assert_eq!(
        InstallerEngine::classify_asset("rustdesk-1.2.6.rpm").0,
        AssetKind::Rpm
    );
}

#[test]
fn test_classify_7z_never_portable() {
    // P1-4: product decision — drop the `.7z` portable claim, do NOT add a 7z dependency.
    // No `.7z` filename may ever classify as PortableZip (extractor only opens zip::ZipArchive).
    let cases = [
        "app-portable.7z",
        "app-portable-win64.7z",
        "tool-windows-x64.7z",
        "tool-win64.7z",
        "tool-macos-arm64.7z",
        "tool-linux-x86_64.7z",
        "random.7z",
        "APP-PORTABLE-WIN64.7Z",
    ];
    for name in cases {
        let (kind, _, _) = InstallerEngine::classify_asset(name);
        assert_ne!(kind, AssetKind::PortableZip, ".7z must never be PortableZip: {}", name);
        assert_eq!(kind, AssetKind::Other, ".7z must map to Other: {}", name);
    }
    // Guard: `.zip` portable claim stays intact.
    assert_eq!(
        InstallerEngine::classify_asset("app-portable.zip").0,
        AssetKind::PortableZip
    );
    assert_eq!(
        InstallerEngine::classify_asset("tool-windows-x64.zip").0,
        AssetKind::PortableZip
    );
}

#[test]
fn test_build_unix_install_commands() {
    let test_path = Path::new("/tmp/test-installer.dmg");
    let cmds = InstallerEngine::build_unix_install_commands(&AssetKind::Dmg, test_path);
    assert_eq!(cmds[0][0], "hdiutil");
    assert_eq!(cmds[0][1], "attach");

    let pkg_path = Path::new("/tmp/app.pkg");
    let pkg_cmds = InstallerEngine::build_unix_install_commands(&AssetKind::Pkg, pkg_path);
    assert_eq!(pkg_cmds[0][0], "installer");

    let appimage_path = Path::new("/home/user/app.AppImage");
    let ai_cmds = InstallerEngine::build_unix_install_commands(&AssetKind::AppImage, appimage_path);
    assert_eq!(ai_cmds[0][0], "chmod");

    let deb_path = Path::new("/tmp/pkg.deb");
    let deb_cmds = InstallerEngine::build_unix_install_commands(&AssetKind::Deb, deb_path);
    assert_eq!(deb_cmds[0][0], "pkexec");
    assert_eq!(deb_cmds[0][1], "dpkg");

    let rpm_path = Path::new("/tmp/pkg.rpm");
    let rpm_cmds = InstallerEngine::build_unix_install_commands(&AssetKind::Rpm, rpm_path);
    assert_eq!(rpm_cmds[0][0], "pkexec");
    assert_eq!(rpm_cmds[0][1], "rpm");
}

#[test]
fn test_hash_calculation() {
    let mut tmp = NamedTempFile::new().unwrap();
    write!(tmp, "hello z-store real download test").unwrap();
    tmp.flush().unwrap();

    let hash = InstallerEngine::compute_sha256(tmp.path()).unwrap();
    assert_eq!(hash.len(), 64);
}

#[test]
fn test_expand_env_path_and_portable_dir() {
    let expanded = expand_env_path("C:\\Custom\\Path");
    assert_eq!(expanded, PathBuf::from("C:\\Custom\\Path"));

    let base = dirs_or_fallback_with_base("test-app", Some("D:\\PortableApps"));
    assert_eq!(base, PathBuf::from("D:\\PortableApps").join("test-app"));

    let base_default = dirs_or_fallback_with_base("test-app", None);
    assert!(base_default.to_string_lossy().contains("test-app"));

    // 测试跨平台 ~/Downloads 与默认下载目录
    let def_dl = default_download_dir();
    assert!(def_dl.to_string_lossy().ends_with("Downloads"));

    let tilde_dl = expand_env_path("~/Downloads");
    assert_eq!(tilde_dl, def_dl);

    let tilde_win_dl = expand_env_path("~\\Downloads");
    assert_eq!(tilde_win_dl, def_dl);

    let empty_dl = expand_env_path("");
    assert_eq!(empty_dl, def_dl);

    let whitespace_dl = expand_env_path("   ");
    assert_eq!(whitespace_dl, def_dl);
}

#[test]
fn test_parse_uninstaller_command() {
    let (exe, args) = parse_uninstaller_command(r#""E:\Program Files\PicGo\Uninstall PicGo.exe" /allusers /S"#);
    assert_eq!(exe, r#"E:\Program Files\PicGo\Uninstall PicGo.exe"#);
    assert_eq!(args, vec!["/allusers", "/S"]);

    let (exe2, args2) = parse_uninstaller_command(r#"C:\Tools\uninstall.exe"#);
    assert_eq!(exe2, r#"C:\Tools\uninstall.exe"#);
    assert!(args2.is_empty());

    let (exe3, args3) = parse_uninstaller_command(r#""C:\Program Files (x86)\App\unins000.exe""#);
    assert_eq!(exe3, r#"C:\Program Files (x86)\App\unins000.exe"#);
    assert!(args3.is_empty());
}

#[test]
fn test_uninstaller_payload_semicolon_stays_inert_argv() {
    let payload = r#""/opt/myapp/uninstall.sh" --remove; touch /tmp/zstore_pwned_semicolon"#;
    let (exe, args) = parse_uninstaller_command(payload);
    assert_eq!(exe, "/opt/myapp/uninstall.sh");
    // `;` must remain a literal argv element, never a shell command separator.
    assert!(args.iter().any(|a| a.contains(';')), "semicolon must stay inside argv, got: {:?}", args);
    assert!(!exe.contains(';'));
}

#[test]
fn test_uninstaller_payload_andand_stays_inert_argv() {
    let payload = r#""/opt/myapp/uninstall.sh" --remove && touch /tmp/zstore_pwned_andand"#;
    let (exe, args) = parse_uninstaller_command(payload);
    assert_eq!(exe, "/opt/myapp/uninstall.sh");
    // `&&` must remain a literal argv element, never a shell chain operator.
    assert!(args.iter().any(|a| a.contains("&&")), "&& must stay inside argv, got: {:?}", args);
    assert!(!exe.contains('&'));
}

#[test]
fn test_uninstaller_payload_backtick_stays_inert_argv() {
    let payload = r#""/opt/myapp/uninstall.sh" --remove `touch /tmp/zstore_pwned_backtick`"#;
    let (exe, args) = parse_uninstaller_command(payload);
    assert_eq!(exe, "/opt/myapp/uninstall.sh");
    // Backticks must remain literal argv text, never command substitution.
    assert!(args.iter().any(|a| a.contains('`')), "backticks must stay inside argv, got: {:?}", args);
    assert!(!exe.contains('`'));
}

#[test]
fn test_uninstaller_payload_argv_spawn_never_executes_injected_command() {
    // Mirror of the fixed Unix path: parse -> argv spawn (never `sh -c`).
    // The injected `touch` must never run; the bogus exe must be rejected.
    let dir = std::env::temp_dir().join("zstore_uninstall_pwn_test");
    let _ = std::fs::create_dir_all(&dir);
    let sentinel = dir.join("pwned_argv");
    let _ = std::fs::remove_file(&sentinel);
    let payload = format!(
        "\"/nonexistent-zstore-uninstall-xyz\" --remove; touch {}",
        sentinel.display()
    );
    let (exe, args) = parse_uninstaller_command(&payload);
    assert_eq!(exe, "/nonexistent-zstore-uninstall-xyz");
    assert!(args.iter().any(|a| a.contains(';')));
    let spawn = std::process::Command::new(&exe).args(&args).output();
    assert!(spawn.is_err(), "bogus exe must be rejected, never shelled");
    assert!(!sentinel.exists(), "injected command must not have executed");
}

#[test]
fn test_select_best_asset_fail_closed_no_cross_os_fallback() {
    // P1-5: empty OS-match with non-empty assets must return None — never fall
    // back to cross-OS assets (e.g. `.deb`-only assets on Windows must not
    // select the `.deb`).
    #[cfg(target_os = "windows")]
    let foreign_os = "linux";
    #[cfg(target_os = "macos")]
    let foreign_os = "linux";
    #[cfg(target_os = "linux")]
    let foreign_os = "windows";
    #[cfg(target_os = "android")]
    let foreign_os = "windows";
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    let foreign_os = "never-matching-os-xyz";

    let assets = vec![crate::models::ReleaseAsset {
        name: "obs-studio_30.1.2_amd64.deb".to_string(),
        download_url: "https://example.com/obs-studio_30.1.2_amd64.deb".to_string(),
        size_bytes: 12345,
        sha256: None,
        os: foreign_os.to_string(),
        arch: "x86_64".to_string(),
        kind: "deb".to_string(),
    }];
    assert!(
        select_best_asset(&assets).is_none(),
        "fail closed: foreign-OS-only assets must yield None, got {:?}",
        select_best_asset(&assets).map(|a| &a.name)
    );
    // Empty input stays None as well.
    let empty: Vec<crate::models::ReleaseAsset> = vec![];
    assert!(select_best_asset(&empty).is_none());
}

#[test]
fn test_uninstall_unix_path_never_shells_command_string() {
    // P0-3: the Unix uninstall path must not hand the DB-sourced command
    // string to `sh -c`; it must spawn via argv from parse_uninstaller_command.
    let src = include_str!("executor.rs");
    assert!(
        !src.contains("\"-c\", uninstaller_cmd"),
        "Unix uninstaller still passes command string to sh -c"
    );
}

