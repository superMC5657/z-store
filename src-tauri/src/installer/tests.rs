use super::*;
use std::path::{Path, PathBuf};

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
    // P1-4：产品决策 —— 放弃对 `.7z` 的便携版支持声明，不增加 7z 依赖。
    // 任何 `.7z` 文件名均不得分类为 PortableZip（解压器仅能解开 zip::ZipArchive）。
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
        assert_ne!(
            kind,
            AssetKind::PortableZip,
            ".7z must never be PortableZip: {}",
            name
        );
        assert_eq!(kind, AssetKind::Other, ".7z must map to Other: {}", name);
    }
    // 守卫测试：确保 `.zip` 的便携版声明保持完好。
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
fn test_unix_real_impl_argv_locked() {
    // 旧桩 build_unix_install_commands 已删：Pkg 桩曾用 `installer -pkg -target`，
    // 与 macOS 真实实现 `open -W` 漂移；Dmg 桩用占位 `/Volumes/<App>`，
    // 与真实 hdiutil 挂载探测漂移；Apk 桩（`pm install`）无真实执行体。
    // 故直调 linux/macos 真实 argv helper 锁定，不再经由已删旧桩。
    let deb = executor::linux::deb_install_argv(Path::new("/tmp/pkg.deb"));
    assert_eq!(deb, vec!["pkexec", "dpkg", "-i", "/tmp/pkg.deb"]);
    let rpm = executor::linux::rpm_install_argv(Path::new("/tmp/pkg.rpm"));
    assert_eq!(rpm, vec!["pkexec", "rpm", "-i", "/tmp/pkg.rpm"]);
    let chmod = executor::linux::appimage_chmod_argv(Path::new("/home/user/app.AppImage"));
    assert_eq!(chmod, vec!["chmod", "+x", "/home/user/app.AppImage"]);
    let launch = executor::linux::appimage_launch_argv(Path::new("/home/user/app.AppImage"));
    assert_eq!(launch, vec!["/home/user/app.AppImage"]);

    let pkg = executor::macos::pkg_open_argv(Path::new("/tmp/app.pkg"));
    assert_eq!(pkg, vec!["open", "-W", "/tmp/app.pkg"]);
    let attach = executor::macos::dmg_attach_argv(Path::new("/tmp/test-installer.dmg"));
    assert_eq!(
        attach,
        vec![
            "hdiutil",
            "attach",
            "-nobrowse",
            "-readonly",
            "/tmp/test-installer.dmg"
        ]
    );
    let detach = executor::macos::dmg_detach_argv(Path::new("/Volumes/TestApp"));
    assert_eq!(
        detach,
        vec!["hdiutil", "detach", "/Volumes/TestApp", "-force"]
    );
    let copy = executor::macos::dmg_copy_argv(
        Path::new("/Volumes/TestApp/TestApp.app"),
        Path::new("/Applications/TestApp.app"),
    );
    assert_eq!(
        copy,
        vec![
            "cp",
            "-R",
            "/Volumes/TestApp/TestApp.app",
            "/Applications/TestApp.app"
        ]
    );
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
    let (exe, args) =
        parse_uninstaller_command(r#""E:\Program Files\PicGo\Uninstall PicGo.exe" /allusers /S"#);
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
    // `;` 必须作为 argv 的字面量元素保留，绝不能作为 shell 命令分隔符。
    assert!(
        args.iter().any(|a| a.contains(';')),
        "semicolon must stay inside argv, got: {:?}",
        args
    );
    assert!(!exe.contains(';'));
}

#[test]
fn test_uninstaller_payload_andand_stays_inert_argv() {
    let payload = r#""/opt/myapp/uninstall.sh" --remove && touch /tmp/zstore_pwned_andand"#;
    let (exe, args) = parse_uninstaller_command(payload);
    assert_eq!(exe, "/opt/myapp/uninstall.sh");
    // `&&` 必须作为 argv 的字面量元素保留，绝不能作为 shell 连词运算符。
    assert!(
        args.iter().any(|a| a.contains("&&")),
        "&& must stay inside argv, got: {:?}",
        args
    );
    assert!(!exe.contains('&'));
}

#[test]
fn test_uninstaller_payload_backtick_stays_inert_argv() {
    let payload = r#""/opt/myapp/uninstall.sh" --remove `touch /tmp/zstore_pwned_backtick`"#;
    let (exe, args) = parse_uninstaller_command(payload);
    assert_eq!(exe, "/opt/myapp/uninstall.sh");
    // 反引号必须作为 argv 的字面量文本保留，绝不能作为命令替换符。
    assert!(
        args.iter().any(|a| a.contains('`')),
        "backticks must stay inside argv, got: {:?}",
        args
    );
    assert!(!exe.contains('`'));
}

#[test]
fn test_uninstaller_payload_argv_spawn_never_executes_injected_command() {
    // 与修复后的 Unix 路径对称：解析 -> argv spawn（绝不使用 `sh -c`）。
    // 注入的 `touch` 绝不得运行；虚假 exe 必须被拒绝。
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
    assert!(
        !sentinel.exists(),
        "injected command must not have executed"
    );
}

#[test]
fn test_select_best_asset_fail_closed_no_cross_os_fallback() {
    // P1-5：产物非空但操作系统匹配结果为空时必须返回 None —— 绝不可跨系统回退
    // （例如在 Windows 下仅有 `.deb` 产物时绝不能误选 `.deb`）。
    #[cfg(target_os = "windows")]
    let foreign_os = "linux";
    #[cfg(target_os = "macos")]
    let foreign_os = "linux";
    #[cfg(target_os = "linux")]
    let foreign_os = "windows";
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
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
    // 输入为空时同样保持返回 None。
    let empty: Vec<crate::models::ReleaseAsset> = vec![];
    assert!(select_best_asset(&empty).is_none());
}

#[test]
fn test_uninstall_unix_path_never_shells_command_string() {
    // P0-3：Unix 卸载路径绝不能将来自数据库的命令字符串直接传给 `sh -c`；
    // 必须通过 parse_uninstaller_command 解析出的 argv 参数列表进行调用。
    let src = include_str!("executor.rs");
    assert!(
        !src.contains("\"-c\", uninstaller_cmd"),
        "Unix uninstaller still passes command string to sh -c"
    );
}

// --- 审查项 3.3-3：SetupExe 安装包类型嗅探 + 静默参数识别（纯函数，无实际启动）---
#[test]
fn test_sniff_nsis_fixture() {
    // 包含 NSIS 标记的最小 PE 头测试固件。
    let mut bytes = vec![0x4Du8, 0x5A, 0x90, 0x00];
    bytes.extend_from_slice(b"NullsoftInst foo");
    assert_eq!(
        executor::sniff_setup_kind(&bytes),
        executor::SetupKind::Nsis
    );
}

#[test]
fn test_sniff_inno_fixture() {
    let mut bytes = vec![0x4Du8, 0x5A, 0x90, 0x00];
    bytes.extend_from_slice(b"Inno Setup Setup Data v6");
    assert_eq!(
        executor::sniff_setup_kind(&bytes),
        executor::SetupKind::Inno
    );
}

#[test]
fn test_sniff_unknown_fixture() {
    let bytes = vec![0x4Du8, 0x5A, 0x90, 0x00, 0x01, 0x02, 0x03];
    assert_eq!(
        executor::sniff_setup_kind(&bytes),
        executor::SetupKind::Unknown
    );
}

#[test]
fn test_silent_args_mapping() {
    assert_eq!(
        executor::silent_args_for_setup_kind(&executor::SetupKind::Nsis),
        vec!["/S".to_string()]
    );
    assert_eq!(
        executor::silent_args_for_setup_kind(&executor::SetupKind::Inno),
        vec!["/VERYSILENT".to_string(), "/NORESTART".to_string()]
    );
    assert!(
        executor::silent_args_for_setup_kind(&executor::SetupKind::Unknown).is_empty(),
        "unknown type must never guess flags (interactive fallback)"
    );
}

// --- 审查项 3.3-4：跨平台跳过是非成功信号，绝不能视为 Ok 安装完成 ---
#[test]
fn test_skipped_outcome_is_non_success() {
    let skipped = executor::InstallOutcome::Skipped("skip: test".to_string());
    assert!(
        skipped.into_result().is_err(),
        "Skipped must not read as success"
    );
    let installed = executor::InstallOutcome::Installed("ok".to_string());
    assert!(installed.into_result().is_ok());
}

#[tokio::test]
async fn test_foreign_platform_skip_is_not_recorded_as_installed() {
    // 在当前 Windows 主机上，macOS DMG 安装是完全无操作的操作：
    // 它必须作为 Skipped 返回（由调用方转换为 Err），绝不能返回 Ok。
    #[cfg(target_os = "windows")]
    {
        let res = executor::execute_installation(
            Path::new("C:\\nonexistent\\pkg.dmg"),
            &AssetKind::Dmg,
            "test-app",
            None,
        )
        .await;
        match res {
            Ok(executor::InstallOutcome::Skipped(_)) => {}
            other => panic!("DMG on Windows must be Skipped, got {:?}", other.is_ok()),
        }
    }
}
