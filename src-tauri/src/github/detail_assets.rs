use crate::installer::InstallerEngine;
use crate::models::ReleaseAsset;

/// 1MB 门禁阈值（对齐 catalog 仓 checkBinary）
pub const ONE_MB_BYTES: u64 = 1024 * 1024;

/// 判断文件名是否为排除的校验和、签名或轻量元数据文件
pub fn is_excluded_signature_or_text(name_lower: &str) -> bool {
    const EXCLUDED_SUFFIXES: &[&str] = &[
        ".sha256", ".sha512", ".sha1", ".md5",
        ".sig", ".asc",
        ".txt", ".md",
        ".json", ".yml", ".yaml", ".xml",
        ".sbom", ".blockmap", ".zsync",
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

/// 判断资产是否为有效可安装的二进制分发包（对齐 catalog 仓 checkBinary）：
/// 1. 过滤 <= 1MB (1_048_576 字节) 占位包与小文件；
/// 2. 排除 .sha256/.sig/.txt 及类似校验、签名、元数据文件；
/// 3. 排除源码包（含有 source/src 标记或 .tar.gz 归档等）；
/// 4. 认可 exe/msi/msix/dmg/pkg/AppImage/deb/rpm/apk 及非源码便携 zip。
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
    let (kind, _, _) = InstallerEngine::classify_asset(name);
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
            // msix 扩展名特殊兼容支持
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
        let (_, os, _) = InstallerEngine::classify_asset(&a.name);
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
    platforms.sort_by_key(|p| {
        ORDER.iter().position(|&x| x == p.as_str()).unwrap_or(99)
    });
}

/// ios 并集 + 排序 SSOT（detail/fetch + lite 共用唯一真相源）：
/// deduced 为空直接返回空（永不 stamp `["other"]`/`["windows"]`）；
/// 非空时并入收录库的 `ios`（仅 ios，前端 virtual-Other 之外唯一允许的收录侧并集），再按 ORDER 排序。
pub fn with_ios_union(deduced: Vec<String>, catalog_platforms: &[String]) -> Vec<String> {
    if deduced.is_empty() {
        return Vec::new();
    }
    let mut set = std::collections::BTreeSet::new();
    for p in &deduced {
        set.insert(p.clone());
    }
    for p in catalog_platforms {
        if p == "ios" {
            set.insert(p.clone());
        }
    }
    let mut list: Vec<String> = set.into_iter().collect();
    sort_platforms(&mut list);
    list
}

/// deduce + ios 并集一步完成（releases 已为最小 `ReleaseAsset` 投影时用）。
/// `catalog_platforms=None` 时等价于纯 `platforms_from_assets`。
pub fn platforms_with_ios_union(
    releases: &[ReleaseAsset],
    catalog_platforms: Option<&[String]>,
) -> Vec<String> {
    let deduced = platforms_from_assets(releases);
    match catalog_platforms {
        Some(cp) => with_ios_union(deduced, cp),
        None => deduced,
    }
}

/// checksum 文件名平台相关性判定（与 installer 资产过滤同模块 single source；入参须为小写文件名）。
/// Windows 相关（msi/exe/zip/setup/portable/win）或通用命名时返回 true；
/// 携带 linux/mac/dmg/appimage/deb/rpm/aarch64/arm64/darwin 任一提示词时返回 false 及命中的提示词。
pub fn checksum_asset_platform_eligible(lower_name: &str) -> (bool, &'static str) {
    const WIN_HINTS: &[&str] = &["msi", "exe", "zip", "setup", "portable", "win"];
    if WIN_HINTS.iter().any(|h| lower_name.contains(*h)) {
        return (true, "windows_relevant");
    }
    const NON_WIN_HINTS: &[&str] = &[
        "linux", "mac", "dmg", "appimage", "deb", "rpm", "aarch64", "arm64", "darwin",
    ];
    for hint in NON_WIN_HINTS {
        if lower_name.contains(*hint) {
            return (false, hint);
        }
    }
    (true, "generic")
}

/// GitHub 原始资产 → 最小 `ReleaseAsset` 投影 → deduce + ios 并集（lite 通道 SSOT）。
/// 空推导明确返回空向量，不做任何兜底；排序 ORDER 复用 `sort_platforms`。
pub(crate) fn lite_platforms_for_github_assets(
    assets: &[crate::github::models::GitHubAssetResponse],
    catalog_platforms: Option<&[String]>,
) -> Vec<String> {
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
    platforms_with_ios_union(&lite, catalog_platforms)
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
        assert!(is_valid_installer_asset("pi-darwin-arm64.tar.gz", 25_000_000));
        assert!(is_valid_installer_asset("pi-linux-x64.tar.gz", 25_000_000));
        assert!(!is_valid_installer_asset("pi-1.0.2-source.tar.gz", 25_000_000));

        // 4. 认可的主流二进制安装包
        assert!(is_valid_installer_asset("RustDesk-1.2.6-Setup.exe", 20_000_000));
        assert!(is_valid_installer_asset("vlc-3.0.21-win64.msi", 40_000_000));
        assert!(is_valid_installer_asset("app.msix", 30_000_000));
        assert!(is_valid_installer_asset("KeePassXC-2.7.9.dmg", 50_000_000));
        assert!(is_valid_installer_asset("Wireshark-4.2.4.pkg", 60_000_000));
        assert!(is_valid_installer_asset("LocalSend-1.15.2.AppImage", 35_000_000));
        assert!(is_valid_installer_asset("obs-studio_30.1.2_amd64.deb", 70_000_000));
        assert!(is_valid_installer_asset("rustdesk-1.2.6.rpm", 30_000_000));
        assert!(is_valid_installer_asset("app-release.apk", 15_000_000));
        assert!(is_valid_installer_asset("app-windows-x64.zip", 15_000_000));
        assert!(is_valid_installer_asset("pi-windows-x64.tar.gz", 15_000_000));
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
            make_asset("app.sig", 5_000),          // 签名，被过滤
            make_asset("stub.exe", 500_000),       // <= 1MB，被过滤
        ];

        let plats = platforms_from_assets(&mixed);
        assert_eq!(plats, vec!["windows".to_string(), "macos".to_string(), "linux".to_string()]);
    }

    #[test]
    fn test_checksum_platform_filter_skips_linux_aarch64_only() {
        // 单源覆盖，不两处重复测。
        // FreeCAD 案：Linux-aarch64-only 的 checksum 文件必须跳过，不产生请求。
        let (ok, _) = checksum_asset_platform_eligible("freecad-linux-aarch64.sha256");
        assert!(!ok);
        let (ok, _) = checksum_asset_platform_eligible("app-1.0-linux.tar.gz.sha256");
        assert!(!ok);
        // Windows 相关与通用命名允许请求。
        let (ok, reason) = checksum_asset_platform_eligible("rustdesk-1.2.6-windows-msi.sha256");
        assert!(ok, "{}", reason);
        let (ok, reason) = checksum_asset_platform_eligible("checksums-sha256.txt");
        assert!(ok, "{}", reason);
        let (ok, _) = checksum_asset_platform_eligible("SHA256SUMS");
        assert!(ok);
    }
}
