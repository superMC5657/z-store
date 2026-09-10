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

