use super::*;
use std::path::{Path, PathBuf};

#[test]
fn test_classify_asset() {
    assert_eq!(classify_asset("vlc-3.0.21-win64.msi").0, AssetKind::Msi);
    assert_eq!(
        classify_asset("RustDesk-1.2.6-Setup.exe").0,
        AssetKind::SetupExe
    );
    assert_eq!(classify_asset("app-portable.zip").0, AssetKind::PortableZip);
    assert_eq!(
        classify_asset("obs-studio_30.1.2_amd64.deb").0,
        AssetKind::Deb
    );
    assert_eq!(
        classify_asset("LocalSend-1.15.2.AppImage").0,
        AssetKind::AppImage
    );
    assert_eq!(classify_asset("KeePassXC-2.7.9.dmg").0, AssetKind::Dmg);
    assert_eq!(classify_asset("Wireshark-4.2.4.pkg").0, AssetKind::Pkg);
    assert_eq!(classify_asset("rustdesk-1.2.6.rpm").0, AssetKind::Rpm);

    // macOS .app bundle archives (e.g. Maccy.app.zip) must classify as macos, not windows
    let (kind, os, _) = classify_asset("Maccy.app.zip");
    assert_eq!(kind, AssetKind::PortableZip);
    assert_eq!(os, "macos");

    let (kind, os, _) = classify_asset("Rectangle-portable.app.zip");
    assert_eq!(kind, AssetKind::PortableZip);
    assert_eq!(os, "macos");

    let (kind, os, _) = classify_asset("App-macos-portable.zip");
    assert_eq!(kind, AssetKind::PortableZip);
    assert_eq!(os, "macos");

    let (kind, os, _) = classify_asset("app-linux-portable.zip");
    assert_eq!(kind, AssetKind::PortableZip);
    assert_eq!(os, "linux");

    let (kind, os, _) = classify_asset("app-win64-portable.zip");
    assert_eq!(kind, AssetKind::PortableZip);
    assert_eq!(os, "windows");

    let (kind, os, _) = classify_asset("Maccy.app.tar.gz");
    assert_eq!(kind, AssetKind::PortableTarball);
    assert_eq!(os, "macos");
}

#[test]
fn test_classify_asset_requires_exe_for_setup_exe_even_with_install_keyword() {
    // 回归 F-04：含 "install"/"installer" 的非 .exe 资产绝不得误分类为 Windows SetupExe
    let cases = [
        ("App-macos-installer.dmg", AssetKind::Dmg, "macos"),
        ("App-installer.pkg", AssetKind::Pkg, "macos"),
        ("app-linux-installer.AppImage", AssetKind::AppImage, "linux"),
        ("foo-install.deb", AssetKind::Deb, "linux"),
        ("foo-install.rpm", AssetKind::Rpm, "linux"),
        ("tool-installer.zip", AssetKind::PortableZip, "windows"),
        ("tool-macos-installer.zip", AssetKind::PortableZip, "macos"),
        (
            "tool-linux-install.tar.gz",
            AssetKind::PortableTarball,
            "linux",
        ),
        ("install.sh", AssetKind::Other, "all"),
        ("App-installer.exe", AssetKind::SetupExe, "windows"),
        ("App-Setup.exe", AssetKind::SetupExe, "windows"),
        ("plain-tool.exe", AssetKind::SetupExe, "windows"),
    ];
    for (name, expected_kind, expected_os) in cases {
        let (kind, os, _) = classify_asset(name);
        assert_eq!(kind, expected_kind, "asset kind mismatch for {}", name);
        assert_eq!(os, expected_os, "asset os mismatch for {}", name);
    }
}

#[test]
fn test_classify_tarball_binary() {
    // 二进制 tarball 统一归类为 PortableTarball（源码过滤由 detail 层负责）。
    let (kind, os, arch) = classify_asset("pi-darwin-arm64.tar.gz");
    assert_eq!(kind, AssetKind::PortableTarball);
    assert_eq!(os, "macos");
    assert_eq!(arch, "aarch64");

    let (kind, os, arch) = classify_asset("pi-linux-x64.tar.gz");
    assert_eq!(kind, AssetKind::PortableTarball);
    assert_eq!(os, "linux");
    assert_eq!(arch, "x86_64");

    let (kind, os, _) = classify_asset("tool-windows-x64.tar.gz");
    assert_eq!(kind, AssetKind::PortableTarball);
    assert_eq!(os, "windows");

    let (kind, os, _) = classify_asset("tool-win64.tar.gz");
    assert_eq!(kind, AssetKind::PortableTarball);
    assert_eq!(os, "windows");

    // 扩展后缀覆盖：.tgz / .tar / .tar.xz 走 tar 分支；
    // .tar.bz2 executor 不支持 bzip2（与 .7z 一致归 Other，不可装）。
    for name in [
        "pi-linux-x64.tgz",
        "pi-linux-x64.tar",
        "pi-linux-x64.tar.xz",
    ] {
        let (kind, os, _) = classify_asset(name);
        assert_eq!(
            kind,
            AssetKind::PortableTarball,
            "tar ext must map: {}",
            name
        );
        assert_eq!(os, "linux", "tar os must be linux: {}", name);
    }
    assert_eq!(
        classify_asset("pi-linux-x64.tar.bz2").0,
        AssetKind::Other,
        ".tar.bz2 must map to Other (bzip2 unsupported)"
    );

    // .7z 保持 Other，不受 tar 分支影响
    assert_eq!(classify_asset("tool-linux-x64.7z").0, AssetKind::Other);
}

#[test]
fn test_tarball_score_bottom_and_no_cross_os_fallback() {
    use crate::models::ReleaseAsset;
    let target_os = selector::current_target_os();
    let target_arch = selector::current_target_arch();

    fn mk(os: &str, arch: &str, kind: &str, name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            download_url: "https://example.com/download".to_string(),
            size_bytes: 20_000_000,
            sha256: None,
            os: os.to_string(),
            arch: arch.to_string(),
            kind: kind.to_string(),
        }
    }

    // 同 OS/Arch 下 tarball 垫底：portable_zip(+10) > portable_tarball(+5)
    let zip = mk(target_os, target_arch, "portable_zip", "app.tar.zip");
    let tar = mk(target_os, target_arch, "portable_tarball", "app.tar.gz");
    let zip_score = selector::score_asset(&zip);
    let tar_score = selector::score_asset(&tar);
    assert!(
        zip_score > tar_score,
        "portable_zip({}) must outrank portable_tarball({})",
        zip_score,
        tar_score
    );
    assert_eq!(
        zip_score - tar_score,
        selector::SCORE_ASSET_KIND_PORTABLE - selector::SCORE_ASSET_KIND_TARBALL
    );
    // 未知 kind 不加分，tarball 仅 `portable_tarball` 生效。
    let tar_unknown_kind = mk(target_os, target_arch, "compressed_tarball", "app.tar.gz");
    assert!(
        selector::score_asset(&tar_unknown_kind) < tar_score,
        "removed alias compressed_tarball must not score as tarball"
    );

    // 仅本平台可安装：跨 OS tar 绝不回退
    #[cfg(target_os = "windows")]
    let foreign_os = "linux";
    #[cfg(target_os = "macos")]
    let foreign_os = "linux";
    #[cfg(target_os = "linux")]
    let foreign_os = "windows";
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let foreign_os = "never-matching-os-xyz";
    let foreign_tar = vec![mk(
        foreign_os,
        target_arch,
        "portable_tarball",
        "pi-foreign.tar.gz",
    )];
    assert!(select_best_asset(&foreign_tar).is_none());
}

#[test]
fn test_classify_7z_never_portable() {
    // 产品决策 —— 放弃对 `.7z` 的便携版支持声明，不增加 7z 依赖。
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
        let (kind, _, _) = classify_asset(name);
        assert_ne!(
            kind,
            AssetKind::PortableZip,
            ".7z must never be PortableZip: {}",
            name
        );
        assert_eq!(kind, AssetKind::Other, ".7z must map to Other: {}", name);
    }
    // 守卫测试：确保 `.zip` 的便携版声明保持完好。
    assert_eq!(classify_asset("app-portable.zip").0, AssetKind::PortableZip);
    assert_eq!(
        classify_asset("tool-windows-x64.zip").0,
        AssetKind::PortableZip
    );
}

#[test]
fn test_unix_real_impl_argv_locked() {
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
    // 与 Unix 路径对称：解析 -> argv spawn（绝不使用 `sh -c`）。
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
    // 产物非空但操作系统匹配结果为空时必须返回 None —— 绝不可跨系统回退
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
    // Unix/Windows 卸载路径位于 executor_uninstall.rs，绝不能将数据库/注册表命令串传给
    // `sh -c` 或 `cmd`，必须通过 parse_uninstaller_command 解析出的 argv 列表直接调用。
    let src = include_str!("executor_uninstall.rs");
    assert!(
        src.contains("fn execute_uninstallation_inner")
            && src.contains("parse_uninstaller_command(uninstaller_cmd)"),
        "test must inspect the real uninstall implementation in executor_uninstall.rs"
    );
    assert!(
        !src.contains("\"-c\", uninstaller_cmd")
            && !src.contains("Command::new(\"sh\")")
            && !src.contains("Command::new(\"/bin/sh\")")
            && !src.contains("Command::new(\"cmd\")")
            && !src.contains("Command::new(\"cmd.exe\")"),
        "Uninstaller must execute parsed argv directly, never via shell"
    );
}

// --- SetupExe 安装包类型嗅探 + 静默参数识别（纯函数，无实际启动）---
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
    // 与 MSI 行为对齐：setup_exe 一律交互式（无静默参数），由其自带向导控制流程；
    // 嗅探/分类不动，仅参数为空。未知类型不断言（交互式回退）。
    for kind in [
        executor::SetupKind::Nsis,
        executor::SetupKind::Inno,
        executor::SetupKind::Unknown,
    ] {
        assert!(
            executor::silent_args_for_setup_kind(&kind).is_empty(),
            "setup_exe must launch interactive (no silent flags), got kind={:?}",
            kind
        );
    }
}

// --- 跨平台跳过是非成功信号，绝不能视为 Ok 安装完成 ---
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

mod version_rules {
    use crate::installer::managed::{is_version_newer, should_include_update};
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
    fn two_segment_versions_compare_against_pe_three_segment() {
        assert!(is_version_newer("0.15.0", "v0.16"));
        assert!(!is_version_newer("0.15.0", "v0.15"));
        assert!(is_version_newer("10.37.0", "10.38"));
        assert!(!is_version_newer("10.38", "10.37.0"));
        assert!(is_version_newer("v0.15", "v0.16"));
        // 带 `-` 的复合标签不补段，按不可解析处理
        assert!(!is_version_newer("1.0.0", "v26.02-v1.5.7-R2"));
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
        assert!(!should_include_update(
            "v1.0.0",
            "v2.0.0",
            Some(&frozen_rule)
        ));

        // 4. 规则隐藏 (is_hidden == true) -> 仍包含，供「已隐藏」签与规则管理跳过版本
        let hidden_rule = UpdateRule {
            app_id: "test".to_string(),
            skipped_version: None,
            is_frozen: false,
            is_hidden: true,
            updated_at: 1000,
        };
        assert!(should_include_update(
            "v1.0.0",
            "v2.0.0",
            Some(&hidden_rule)
        ));

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
}
