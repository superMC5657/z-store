use crate::installer::classify_asset;
use crate::models::ReleaseAsset;

/// 1MB 门禁阈值（对齐 catalog 仓 checkBinary）
pub const ONE_MB_BYTES: u64 = 1024 * 1024;

/// 判断文件名是否为排除的校验和、签名或轻量元数据文件
pub fn is_excluded_signature_or_text(name_lower: &str) -> bool {
    const EXCLUDED_SUFFIXES: &[&str] = &[
        ".sha256",
        ".sha512",
        ".sha1",
        ".md5",
        ".sig",
        ".asc",
        ".txt",
        ".md",
        ".json",
        ".yml",
        ".yaml",
        ".xml",
        ".sbom",
        ".blockmap",
        ".zsync",
    ];
    if EXCLUDED_SUFFIXES.iter().any(|s| name_lower.ends_with(s)) {
        return true;
    }
    // 聚合校验和文件名判定（如 SHA256SUMS 等）
    if name_lower.contains("checksum")
        || name_lower.contains("sha256sum")
        || name_lower.contains("sha512sum")
        || name_lower.contains("md5sum")
    {
        return true;
    }
    false
}

/// 判断文件名是否为 macOS `.app` 打包的 tar 归档（属于二进制分发包，非源码包）。
pub fn is_app_bundle_tarball(name_lower: &str) -> bool {
    name_lower.ends_with(".app.tar.gz")
        || name_lower.ends_with(".app.tgz")
        || name_lower.ends_with(".app.tar.xz")
        || name_lower.ends_with(".app.tar")
}

/// 判断是否为源码包（源码归档或含源码标记的包，不可作为安装包）
pub fn is_source_package(name_lower: &str) -> bool {
    // tar 系归档：后缀命中后加二进制豁免 —— 含源码标记仍为 true；
    // 否则同时含 OS 词 + Arch 词则视为二进制分发包（false，放行）。
    if name_lower.ends_with(".tar.gz")
        || name_lower.ends_with(".tar.xz")
        || name_lower.ends_with(".tar.bz2")
        || name_lower.ends_with(".tgz")
        || name_lower.ends_with(".tar")
    {
        if name_lower.contains("source")
            || name_lower.contains("sources")
            || name_lower.contains("-src.")
            || name_lower.contains("_src.")
            || name_lower.contains(".src.")
            || name_lower.contains("src-")
            || name_lower.contains("-source.")
            || name_lower.contains("_source.")
        {
            return true;
        }
        // 整词边界匹配：`win` 不得误命中 `darwin`/`twin`/`drawing`，
        // `x86` 不得与 `x86_64` 子串重叠；os+arch 双命中才视为二进制分发包（false，放行）。
        let has_os = crate::installer::contains_word(name_lower, "darwin")
            || crate::installer::contains_word(name_lower, "macos")
            || crate::installer::contains_word(name_lower, "osx")
            || crate::installer::contains_word(name_lower, "linux")
            || crate::installer::contains_word(name_lower, "windows")
            || crate::installer::contains_word(name_lower, "win");
        let has_arch = crate::installer::contains_word(name_lower, "arm64")
            || crate::installer::contains_word(name_lower, "aarch64")
            || crate::installer::contains_word(name_lower, "x64")
            || crate::installer::contains_word(name_lower, "x86_64")
            || crate::installer::contains_word(name_lower, "amd64")
            || crate::installer::contains_word(name_lower, "armv7")
            || crate::installer::contains_word(name_lower, "armhf")
            || crate::installer::contains_word(name_lower, "i386")
            || crate::installer::contains_word(name_lower, "i686")
            || crate::installer::contains_word(name_lower, "x86");
        if is_app_bundle_tarball(name_lower) {
            return false;
        }
        if has_os && has_arch {
            return false;
        }
        return true;
    }
    // 包含 source/sources 命名标记
    if name_lower.contains("source") || name_lower.contains("sources") {
        return true;
    }
    // 包含 src 关键字命名标记（如 app-src.zip, app_src.zip, src.zip 等）
    if name_lower.contains("-src.")
        || name_lower.contains("_src.")
        || name_lower.contains(".src.")
        || name_lower.starts_with("src.")
        || name_lower.starts_with("src-")
        || name_lower.ends_with("-src.zip")
        || name_lower.ends_with("_src.zip")
    {
        return true;
    }
    false
}

/// 判断资产是否为有效可安装的二进制分发包（> 1MB，非校验/签名/源码包）。
pub fn is_valid_installer_asset(name: &str, size_bytes: u64) -> bool {
    if size_bytes <= ONE_MB_BYTES {
        return false;
    }
    let lower = name.to_lowercase();
    if is_excluded_signature_or_text(&lower) {
        return false;
    }
    if is_source_package(&lower) {
        return false;
    }
    let (kind, _, _) = classify_asset(name);
    match kind {
        crate::installer::AssetKind::Msi
        | crate::installer::AssetKind::SetupExe
        | crate::installer::AssetKind::Dmg
        | crate::installer::AssetKind::Pkg
        | crate::installer::AssetKind::AppImage
        | crate::installer::AssetKind::Deb
        | crate::installer::AssetKind::Rpm
        | crate::installer::AssetKind::Apk => true,
        crate::installer::AssetKind::PortableZip => true,
        crate::installer::AssetKind::PortableTarball => true,
        crate::installer::AssetKind::Other => {
            // msix 扩展名支持
            lower.ends_with(".msix")
        }
    }
}

/// 根据资产列表推断支持的平台（带安装包校验规则过滤）。
/// 源码包、<=1MB 占位包、.sha256/.sig/.txt 均不算可安装资产；
/// 若无任何有效可安装包，则返回空列表（避免虚假发布）。
pub fn platforms_from_assets(assets: &[ReleaseAsset]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for a in assets {
        if !is_valid_installer_asset(&a.name, a.size_bytes) {
            continue;
        }
        let (_, os, _) = classify_asset(&a.name);
        if os != "all" {
            set.insert(os.to_string());
        } else if a.name.to_lowercase().ends_with(".msix") {
            set.insert("windows".to_string());
        }
    }
    let mut plats: Vec<String> = set.into_iter().collect();
    sort_platforms(&mut plats);
    plats
}

/// 平台排序 SSOT（deduce 结果统一经此排序）。
pub fn sort_platforms(platforms: &mut [String]) {
    const ORDER: &[&str] = &["windows", "macos", "linux", "ios", "android"];
    platforms.sort_by_key(|p| ORDER.iter().position(|&x| x == p.as_str()).unwrap_or(99));
}

/// 详情/轻量通道平台决议 SSOT（收录库优先，空 `[]` 时回退 Release 推导）：
/// - 收录库 `catalog_platforms` 为 `Some` 且含有效非空平台时，直接以收录库为准；
/// - 否则（未收录或收录库为 `[]`），使用 Release 资产推导的 `deduced`。
pub fn resolve_platforms_catalog_first(
    deduced: Vec<String>,
    catalog_platforms: Option<&[String]>,
) -> Vec<String> {
    catalog_platforms
        .and_then(clean_catalog_platforms)
        .unwrap_or(deduced)
}

/// 收录库平台清洗：去空白、剔除空串与 `other`，保持收录库原序；清洗后为空返回 `None`。
pub fn clean_catalog_platforms(catalog_platforms: &[String]) -> Option<Vec<String>> {
    let clean: Vec<String> = catalog_platforms
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("other"))
        .collect();
    (!clean.is_empty()).then_some(clean)
}

/// 一步完成：先查收录库平台（非空即用），为空或未收录时从 Release 资产推导。
pub fn platforms_with_catalog_priority(
    releases: &[ReleaseAsset],
    catalog_platforms: Option<&[String]>,
) -> Vec<String> {
    catalog_platforms
        .and_then(clean_catalog_platforms)
        .unwrap_or_else(|| platforms_from_assets(releases))
}

/// 按当前资产分类规则刷新 `ReleaseAsset` 的 `kind`、`os`、`arch`（用于 304/DB 缓存读取自愈）。
pub fn refresh_release_assets_classification(releases: &mut [ReleaseAsset]) {
    for r in releases.iter_mut() {
        let (kind, os, arch) = crate::forge::provider::classify_asset_fields(&r.name);
        r.kind = kind;
        r.os = os;
        r.arch = arch;
    }
}

/// 清理并重排缓存详情中的安装包、平台与收录精校元数据。
pub fn heal_cached_detail(
    detail: &mut crate::models::AppDetail,
    catalog_item: Option<&crate::github::models::CatalogItem>,
) {
    if !detail.releases.is_empty() {
        detail
            .releases
            .retain(|r| is_valid_installer_asset(&r.name, r.size_bytes));
        refresh_release_assets_classification(&mut detail.releases);
        detail
            .releases
            .sort_by_key(|b| std::cmp::Reverse(crate::installer::score_asset(b)));
        detail.core.platforms = platforms_with_catalog_priority(
            &detail.releases,
            catalog_item.map(|i| i.platforms.as_slice()),
        );
    } else if let Some(clean) = catalog_item.and_then(|i| clean_catalog_platforms(&i.platforms)) {
        detail.core.platforms = clean;
    }
    if let Some(item) = catalog_item {
        item.overlay_detail_core(&mut detail.core);
    }
}

/// 判断小写文件名是否为可抓取的 SHA-256 校验清单候选：
/// 排除二进制安装包、压缩归档、签名与结构化元数据，防止误下 `sha256sum-win.exe` / `checksum-cli.zip` / `SHA256SUMS.asc`。
pub fn is_checksum_manifest_asset(lower_name: &str) -> bool {
    const NON_MANIFEST_SUFFIXES: &[&str] = &[
        ".exe", ".msi", ".msix", ".dmg", ".pkg", ".appimage", ".deb", ".rpm", ".apk", ".ipa",
        ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".xz", ".txz", ".bz2", ".tbz2", ".zst",
        ".iso", ".bin", ".run", ".sh", ".bat", ".cmd", ".ps1", ".dll", ".so", ".dylib", ".sig",
        ".asc", ".gpg", ".minisig", ".pem", ".crt", ".cer", ".sbom", ".blockmap", ".zsync",
        ".json", ".yml", ".yaml", ".xml", ".md",
    ];
    if NON_MANIFEST_SUFFIXES
        .iter()
        .any(|suf| lower_name.ends_with(suf))
    {
        return false;
    }
    // 排除明确指向非 SHA-256 算法的清单（如 SHA512SUMS / MD5SUMS / checksums-sha1.txt）。
    if (lower_name.contains("sha512") || lower_name.contains("sha1") || lower_name.contains("md5"))
        && !lower_name.contains("sha256")
    {
        return false;
    }
    lower_name.ends_with(".sha256")
        || lower_name.ends_with(".sha256sum")
        || lower_name.ends_with(".sha256sums")
        || lower_name.contains("checksum")
        || lower_name.contains("sha256")
}

/// 按指定宿主 OS/Arch 判断 checksum 文件名是否与目标宿主相关（入参 `lower_name` 须为小写）。
/// 无 OS/Arch 提示词的通用清单（如 `SHA256SUMS` / `checksums.txt`）在全平台放行；
/// 携带明确平台/架构词时按词边界精确匹配，跨平台 `.zip` 不再强行归为 Windows。
pub fn checksum_asset_platform_eligible_for(
    lower_name: &str,
    host_os: &str,
    host_arch: &str,
) -> (bool, &'static str) {
    use crate::installer::contains_word;

    let has_win = contains_word(lower_name, "windows")
        || contains_word(lower_name, "win")
        || contains_word(lower_name, "win64")
        || contains_word(lower_name, "win32")
        || contains_word(lower_name, "mingw")
        || contains_word(lower_name, "msvc")
        || contains_word(lower_name, "msi")
        || contains_word(lower_name, "exe")
        || contains_word(lower_name, "msix")
        || contains_word(lower_name, "nsis");
    let has_mac = contains_word(lower_name, "macos")
        || contains_word(lower_name, "darwin")
        || contains_word(lower_name, "osx")
        || contains_word(lower_name, "mac")
        || contains_word(lower_name, "apple")
        || contains_word(lower_name, "dmg")
        || contains_word(lower_name, "pkg")
        || lower_name.contains(".app.");
    let has_linux = contains_word(lower_name, "linux")
        || contains_word(lower_name, "appimage")
        || contains_word(lower_name, "deb")
        || contains_word(lower_name, "rpm")
        || contains_word(lower_name, "flatpak")
        || contains_word(lower_name, "snap")
        || contains_word(lower_name, "musl")
        || contains_word(lower_name, "gnu");
    let has_other_os = contains_word(lower_name, "android")
        || contains_word(lower_name, "apk")
        || contains_word(lower_name, "ios")
        || contains_word(lower_name, "ipa")
        || contains_word(lower_name, "freebsd")
        || contains_word(lower_name, "openbsd")
        || contains_word(lower_name, "netbsd");

    let has_any_os = has_win || has_mac || has_linux || has_other_os;
    if has_any_os && host_os != "all" {
        let os_ok = match host_os {
            "windows" => has_win,
            "macos" => has_mac,
            "linux" => has_linux,
            _ => true,
        };
        if !os_ok {
            let reason = if has_linux {
                "linux"
            } else if has_mac {
                "macos"
            } else if has_win {
                "windows"
            } else {
                "other_os"
            };
            return (false, reason);
        }
    }

    let has_x64 = contains_word(lower_name, "x86_64")
        || contains_word(lower_name, "amd64")
        || contains_word(lower_name, "x64")
        || contains_word(lower_name, "win64");
    let has_arm64 = contains_word(lower_name, "arm64") || contains_word(lower_name, "aarch64");
    let has_x86 = contains_word(lower_name, "x86")
        || contains_word(lower_name, "i386")
        || contains_word(lower_name, "i686")
        || contains_word(lower_name, "ia32")
        || contains_word(lower_name, "win32");
    let has_other_arch = contains_word(lower_name, "armv7")
        || contains_word(lower_name, "armhf")
        || contains_word(lower_name, "armv6")
        || contains_word(lower_name, "riscv64")
        || contains_word(lower_name, "ppc64le")
        || contains_word(lower_name, "s390x");
    let has_universal = contains_word(lower_name, "universal");

    let has_any_arch = has_x64 || has_arm64 || has_x86 || has_other_arch;
    if has_any_arch && !has_universal {
        let norm_arch = match host_arch {
            "x86_64" | "x64" | "amd64" => "x86_64",
            "aarch64" | "arm64" => "aarch64",
            "x86" | "i686" | "i386" => "x86",
            _ => "universal",
        };
        let arch_ok = match norm_arch {
            "x86_64" => has_x64 || (host_os == "windows" && has_x86),
            "aarch64" => has_arm64,
            "x86" => has_x86,
            _ => true,
        };
        if !arch_ok {
            let reason = if has_arm64 {
                "arm64"
            } else if has_x64 {
                "x86_64"
            } else if has_x86 {
                "x86"
            } else {
                "other_arch"
            };
            return (false, reason);
        }
    }

    if has_any_os || has_any_arch {
        (true, "platform_match")
    } else {
        (true, "generic")
    }
}

/// checksum 文件名平台相关性判定（按编译期当前宿主 `target_os`/`target_arch` 过滤；入参须为小写文件名）。
pub fn checksum_asset_platform_eligible(lower_name: &str) -> (bool, &'static str) {
    checksum_asset_platform_eligible_for(
        lower_name,
        crate::installer::selector::current_target_os(),
        crate::installer::selector::current_target_arch(),
    )
}

/// GitHub 原始资产 → 收录库平台优先（保持收录库原序），空时最小 `ReleaseAsset` 投影 → deduce（lite 通道 SSOT）。
/// 空推导明确返回空向量，不做任何兜底；推导分支排序 ORDER 复用 `sort_platforms`。
pub(crate) fn lite_platforms_for_github_assets(
    assets: &[crate::github::models::GitHubAssetResponse],
    catalog_platforms: Option<&[String]>,
) -> Vec<String> {
    if let Some(clean) = catalog_platforms.and_then(clean_catalog_platforms) {
        return clean;
    }
    let lite: Vec<ReleaseAsset> = assets
        .iter()
        .map(|a| ReleaseAsset {
            name: a.name.clone(),
            download_url: String::new(),
            size_bytes: a.size,
            sha256: None,
            os: String::new(),
            arch: String::new(),
            kind: String::new(),
        })
        .collect();
    platforms_from_assets(&lite)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_installer_asset_filters() {
        // 1. <= 1MB 占位包与小文件被过滤
        assert!(!is_valid_installer_asset("app-setup.exe", ONE_MB_BYTES));
        assert!(!is_valid_installer_asset("app-setup.exe", 500_000));
        assert!(!is_valid_installer_asset("app.deb", 1024));

        // 2. 校验和、签名、元数据被过滤
        assert!(!is_valid_installer_asset("app.exe.sha256", 5_000_000));
        assert!(!is_valid_installer_asset("app.sig", 5_000_000));
        assert!(!is_valid_installer_asset("app.asc", 5_000_000));
        assert!(!is_valid_installer_asset("release-notes.txt", 5_000_000));
        assert!(!is_valid_installer_asset("SHA256SUMS", 5_000_000));
        assert!(!is_valid_installer_asset("checksums.txt", 5_000_000));

        // 3. 源码包不可作为安装包
        assert!(!is_valid_installer_asset("app-1.0.tar.gz", 25_000_000));
        assert!(!is_valid_installer_asset("source.tar.gz", 25_000_000));
        assert!(!is_valid_installer_asset("sources.tar.xz", 25_000_000));
        assert!(!is_valid_installer_asset("app-source.zip", 25_000_000));
        assert!(!is_valid_installer_asset("app-src.zip", 25_000_000));
        assert!(!is_valid_installer_asset("src.zip", 25_000_000));
        // 3b. 二进制 tarball 放行，源码标记 tarball 继续过滤
        assert!(is_valid_installer_asset(
            "pi-darwin-arm64.tar.gz",
            25_000_000
        ));
        assert!(is_valid_installer_asset("pi-linux-x64.tar.gz", 25_000_000));
        assert!(!is_valid_installer_asset(
            "pi-1.0.2-source.tar.gz",
            25_000_000
        ));

        // 4. 认可的主流二进制安装包
        assert!(is_valid_installer_asset(
            "RustDesk-1.2.6-Setup.exe",
            20_000_000
        ));
        assert!(is_valid_installer_asset("vlc-3.0.21-win64.msi", 40_000_000));
        assert!(is_valid_installer_asset("app.msix", 30_000_000));
        assert!(is_valid_installer_asset("KeePassXC-2.7.9.dmg", 50_000_000));
        assert!(is_valid_installer_asset("Wireshark-4.2.4.pkg", 60_000_000));
        assert!(is_valid_installer_asset(
            "LocalSend-1.15.2.AppImage",
            35_000_000
        ));
        assert!(is_valid_installer_asset(
            "obs-studio_30.1.2_amd64.deb",
            70_000_000
        ));
        assert!(is_valid_installer_asset("rustdesk-1.2.6.rpm", 30_000_000));
        assert!(is_valid_installer_asset("app-release.apk", 15_000_000));
        assert!(is_valid_installer_asset("app-windows-x64.zip", 15_000_000));
        assert!(is_valid_installer_asset(
            "pi-windows-x64.tar.gz",
            15_000_000
        ));
        assert!(is_valid_installer_asset("pi-linux-x64.tar.xz", 15_000_000));
    }

    #[test]
    fn test_platforms_from_assets_empty_on_source_and_invalid() {
        fn make_asset(name: &str, size_bytes: u64) -> ReleaseAsset {
            ReleaseAsset {
                name: name.to_string(),
                download_url: "https://example.com/download".to_string(),
                size_bytes,
                sha256: None,
                os: String::new(),
                arch: String::new(),
                kind: String::new(),
            }
        }

        // 纯源码包：platforms 必须置空
        let source_only = vec![
            make_asset("app-1.0.tar.gz", 20_000_000),
            make_asset("app-source.zip", 15_000_000),
        ];
        assert!(platforms_from_assets(&source_only).is_empty());

        // 纯校验和与文档：platforms 必须置空
        let docs_only = vec![
            make_asset("checksums.txt", 5_000_000),
            make_asset("app.sig", 2_000_000),
        ];
        assert!(platforms_from_assets(&docs_only).is_empty());

        // 占位包 (<= 1MB)：platforms 必须置空
        let stub_only = vec![make_asset("app-setup.exe", 500_000)];
        assert!(platforms_from_assets(&stub_only).is_empty());

        // 空资产列表：platforms 必须置空
        assert!(platforms_from_assets(&[]).is_empty());
    }

    #[test]
    fn test_platforms_from_assets_derives_valid_platforms() {
        fn make_asset(name: &str, size_bytes: u64) -> ReleaseAsset {
            ReleaseAsset {
                name: name.to_string(),
                download_url: "https://example.com/download".to_string(),
                size_bytes,
                sha256: None,
                os: String::new(),
                arch: String::new(),
                kind: String::new(),
            }
        }

        let mixed = vec![
            make_asset("app-setup.exe", 20_000_000),
            make_asset("app_amd64.deb", 25_000_000),
            make_asset("app.dmg", 30_000_000),
            make_asset("app.tar.gz", 15_000_000), // 源码包，被过滤
            make_asset("app.sig", 5_000),         // 签名，被过滤
            make_asset("stub.exe", 500_000),      // <= 1MB，被过滤
        ];

        let plats = platforms_from_assets(&mixed);
        assert_eq!(
            plats,
            vec![
                "windows".to_string(),
                "macos".to_string(),
                "linux".to_string()
            ]
        );

        // macOS .app.zip (bad case: Maccy.app.zip) must derive ["macos"], never ["windows"]
        let maccy_assets = vec![make_asset("Maccy.app.zip", 5_288_775)];
        assert_eq!(
            platforms_from_assets(&maccy_assets),
            vec!["macos".to_string()]
        );

        // .app.tar.gz is a binary bundle archive, not a source tarball
        assert!(is_valid_installer_asset("Maccy.app.tar.gz", 5_288_775));
    }

    #[test]
    fn test_checksum_platform_filter_respects_runtime_os_and_arch() {
        // 通用聚合清单在所有平台/架构均放行
        for (os, arch) in [
            ("windows", "x86_64"),
            ("windows", "aarch64"),
            ("macos", "aarch64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
        ] {
            assert!(
                checksum_asset_platform_eligible_for("checksums-sha256.txt", os, arch).0,
                "generic checksums must pass on {os}/{arch}"
            );
            assert!(
                checksum_asset_platform_eligible_for("sha256sums", os, arch).0,
                "SHA256SUMS must pass on {os}/{arch}"
            );
        }

        // Windows x86_64：放行 Windows/x86 资产，拒绝 linux/darwin（含 .zip!）/arm64
        assert!(
            checksum_asset_platform_eligible_for(
                "rustdesk-1.2.6-windows-msi.sha256",
                "windows",
                "x86_64"
            )
            .0
        );
        assert!(
            !checksum_asset_platform_eligible_for("app-darwin.zip.sha256", "windows", "x86_64").0,
            "darwin .zip checksum must NOT match Windows"
        );
        assert!(
            !checksum_asset_platform_eligible_for(
                "freecad-linux-aarch64.sha256",
                "windows",
                "x86_64"
            )
            .0
        );
        assert!(
            !checksum_asset_platform_eligible_for(
                "app-1.0-linux.tar.gz.sha256",
                "windows",
                "x86_64"
            )
            .0
        );

        // macOS arm64：放行 macOS/darwin arm64 与 universal，拒绝 Windows/Linux/x86_64
        assert!(
            checksum_asset_platform_eligible_for("app-darwin-arm64.zip.sha256", "macos", "aarch64")
                .0
        );
        assert!(
            checksum_asset_platform_eligible_for("app-universal.dmg.sha256", "macos", "aarch64").0
        );
        assert!(
            !checksum_asset_platform_eligible_for("app-win-x64.msi.sha256", "macos", "aarch64").0
        );
        assert!(
            !checksum_asset_platform_eligible_for("app-darwin-x64.dmg.sha256", "macos", "aarch64").0
        );

        // Linux aarch64：放行 linux-aarch64，拒绝 linux-x64 与 Windows
        assert!(
            checksum_asset_platform_eligible_for(
                "freecad-linux-aarch64.sha256",
                "linux",
                "aarch64"
            )
            .0
        );
        assert!(
            !checksum_asset_platform_eligible_for(
                "freecad-linux-aarch64.sha256",
                "linux",
                "x86_64"
            )
            .0
        );
        assert!(
            checksum_asset_platform_eligible_for("app-1.0-linux.tar.gz.sha256", "linux", "x86_64")
                .0
        );
    }

    #[test]
    fn test_is_checksum_manifest_asset_excludes_binaries_archives_and_sigs() {
        for ok in [
            "sha256sums",
            "checksums.txt",
            "checksums-sha256.txt",
            "app-win.msi.sha256",
            "app-macos.dmg.sha256sum",
            "app-linux.appimage.sha256.txt",
        ] {
            assert!(is_checksum_manifest_asset(ok), "{ok} should be accepted");
        }
        for bad in [
            "sha256sum-win.exe",
            "checksum-cli.zip",
            "sha256-tool-linux.tar.gz",
            "checksums.txt.asc",
            "sha256sums.sig",
            "checksums.txt.gpg",
            "sha512sums",
            "md5sums.txt",
            "checksums.json",
            "app-win.msi",
        ] {
            assert!(!is_checksum_manifest_asset(bad), "{bad} must be rejected");
        }
    }

    #[test]
    fn test_platforms_with_catalog_priority_prefers_nonempty_catalog_and_falls_back_when_empty() {
        let releases = vec![ReleaseAsset {
            name: "app-setup.exe".to_string(),
            download_url: "https://example.com/app-setup.exe".to_string(),
            size_bytes: 20_000_000,
            sha256: None,
            os: String::new(),
            arch: String::new(),
            kind: String::new(),
        }];

        // 收录库非空时优先取收录库（保留 android / ios / macos 等）
        let curated = vec![
            "windows".to_string(),
            "macos".to_string(),
            "android".to_string(),
            "ios".to_string(),
        ];
        assert_eq!(
            platforms_with_catalog_priority(&releases, Some(&curated)),
            curated
        );

        // 收录库仅含 ios 且无 release 二进制时，仍保留收录库的 ios
        let ios_only = vec!["ios".to_string()];
        assert_eq!(
            platforms_with_catalog_priority(&[], Some(&ios_only)),
            ios_only
        );

        // 收录库为空 [] 时回退 Release 推导
        assert_eq!(
            platforms_with_catalog_priority(&releases, Some(&[])),
            vec!["windows".to_string()]
        );

        // 未收录（None）走 Release 推导
        assert_eq!(
            platforms_with_catalog_priority(&releases, None),
            vec!["windows".to_string()]
        );
    }
}
