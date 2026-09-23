use super::AssetKind;

pub fn classify_asset(filename: &str) -> (AssetKind, &'static str, &'static str) {
    let name_lower = filename.to_lowercase();

    let arch = if name_lower.contains("arm64") || name_lower.contains("aarch64") {
        "aarch64"
    } else if name_lower.contains("x86_64")
        || name_lower.contains("x64")
        || name_lower.contains("amd64")
        || name_lower.contains("win64")
    {
        "x86_64"
    } else if name_lower.contains("x86")
        || name_lower.contains("i686")
        || name_lower.contains("i386")
        || name_lower.contains("win32")
        || name_lower.contains("ia32")
    {
        "x86"
    } else {
        "universal"
    };

    if name_lower.ends_with(".msi") {
        (AssetKind::Msi, "windows", arch)
    } else if name_lower.ends_with("-setup.exe")
        || name_lower.ends_with("_setup.exe")
        || name_lower.ends_with("-installer.exe")
        || name_lower.ends_with("_installer.exe")
        || name_lower.contains("install")
        || name_lower.ends_with(".exe")
    {
        (AssetKind::SetupExe, "windows", arch)
    } else if (name_lower.contains("portable")
        || name_lower.contains("win")
        || name_lower.contains("windows"))
        && name_lower.ends_with(".zip")
    {
        (AssetKind::PortableZip, "windows", arch)
    } else if name_lower.ends_with(".deb") {
        (AssetKind::Deb, "linux", arch)
    } else if name_lower.ends_with(".rpm") {
        (AssetKind::Rpm, "linux", arch)
    } else if name_lower.ends_with(".appimage") {
        (AssetKind::AppImage, "linux", arch)
    } else if name_lower.ends_with(".dmg") {
        (AssetKind::Dmg, "macos", arch)
    } else if name_lower.ends_with(".pkg") {
        (AssetKind::Pkg, "macos", arch)
    } else if name_lower.ends_with(".apk") {
        (AssetKind::Apk, "android", "arm64-v8a")
    } else if name_lower.ends_with(".zip") {
        let zip_os = if name_lower.contains("darwin")
            || name_lower.contains("macos")
            || name_lower.contains("osx")
            || name_lower.contains("mac")
        {
            "macos"
        } else if name_lower.contains("linux") {
            "linux"
        } else {
            "windows"
        };
        (AssetKind::PortableZip, zip_os, arch)
    } else if name_lower.ends_with(".7z") {
        // P1-4：移除 `.7z` 文件的便携版识别声明 —— 解压器仅支持
        // `zip::ZipArchive`，因此 `.7z` 按照下文 `.tar.gz` 的既有惯例归类为 Other（不支持）。不额外引入 7z 依赖。
        (AssetKind::Other, "all", "universal")
    } else if name_lower.ends_with(".tar.gz") || name_lower.ends_with(".tar.xz") {
        let tar_os = if name_lower.contains("darwin")
            || name_lower.contains("macos")
            || name_lower.contains("osx")
            || name_lower.contains("mac")
        {
            "macos"
        } else {
            "linux"
        };
        (AssetKind::Other, tar_os, arch)
    } else {
        (AssetKind::Other, "all", "universal")
    }
}

/// 资产评分权重常量
pub const SCORE_ASSET_OS_MATCH: i32 = 100;
pub const SCORE_ASSET_OS_ALL: i32 = 30;
pub const PENALTY_ASSET_OS_MISMATCH: i32 = -100;

pub const SCORE_ASSET_ARCH_MATCH: i32 = 50;
pub const SCORE_ASSET_ARCH_UNIVERSAL: i32 = 25;
pub const SCORE_ASSET_ARCH_COMPAT_X86: i32 = 10;
pub const PENALTY_ASSET_ARCH_MISMATCH: i32 = -50;

pub const SCORE_ASSET_KIND_PRIMARY: i32 = 20;
pub const SCORE_ASSET_KIND_SECONDARY: i32 = 15;
pub const SCORE_ASSET_KIND_TERTIARY: i32 = 12;
pub const SCORE_ASSET_KIND_PORTABLE: i32 = 10;

/// 根据当前系统平台与 CPU 架构为资产计算适配匹配度打分
pub fn score_asset(a: &crate::models::ReleaseAsset) -> i32 {
    #[cfg(target_os = "windows")]
    let target_os = "windows";
    #[cfg(target_os = "macos")]
    let target_os = "macos";
    #[cfg(target_os = "linux")]
    let target_os = "linux";
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )))]
    let target_os = "all";

    #[cfg(target_arch = "x86_64")]
    let target_arch = "x86_64";
    #[cfg(target_arch = "aarch64")]
    let target_arch = "aarch64";
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    let target_arch = "universal";

    let mut score: i32 = 0;
    if a.os == target_os {
        score += SCORE_ASSET_OS_MATCH;
    } else if a.os == "all" {
        score += SCORE_ASSET_OS_ALL;
    } else {
        score += PENALTY_ASSET_OS_MISMATCH;
    }

    if a.arch == target_arch {
        score += SCORE_ASSET_ARCH_MATCH;
    } else if a.arch == "universal" {
        score += SCORE_ASSET_ARCH_UNIVERSAL;
    } else if target_arch == "x86_64" && a.arch == "x86" {
        score += SCORE_ASSET_ARCH_COMPAT_X86;
    } else {
        score += PENALTY_ASSET_ARCH_MISMATCH;
    }

    #[cfg(target_os = "windows")]
    match a.kind.as_str() {
        "msi" => score += SCORE_ASSET_KIND_PRIMARY,
        "setup_exe" => score += SCORE_ASSET_KIND_SECONDARY,
        "portable_zip" => score += SCORE_ASSET_KIND_PORTABLE,
        _ => {}
    }

    #[cfg(target_os = "macos")]
    match a.kind.as_str() {
        "dmg" => score += SCORE_ASSET_KIND_PRIMARY,
        "pkg" => score += SCORE_ASSET_KIND_SECONDARY,
        "portable_zip" => score += SCORE_ASSET_KIND_PORTABLE,
        _ => {}
    }

    #[cfg(target_os = "linux")]
    match a.kind.as_str() {
        "appimage" => score += SCORE_ASSET_KIND_PRIMARY,
        "deb" => score += SCORE_ASSET_KIND_SECONDARY,
        "rpm" => score += SCORE_ASSET_KIND_TERTIARY,
        "portable_zip" => score += SCORE_ASSET_KIND_PORTABLE,
        _ => {}
    }

    score
}

/// 根据当前系统平台（Windows / macOS / Linux）与 CPU 架构（x86_64 / aarch64）智能择取最优安装包资产
pub fn select_best_asset(
    assets: &[crate::models::ReleaseAsset],
) -> Option<&crate::models::ReleaseAsset> {
    #[cfg(target_os = "windows")]
    let target_os = "windows";
    #[cfg(target_os = "macos")]
    let target_os = "macos";
    #[cfg(target_os = "linux")]
    let target_os = "linux";
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )))]
    let target_os = "all";

    let os_matches: Vec<&crate::models::ReleaseAsset> = assets
        .iter()
        .filter(|a| a.os == target_os || a.os == "all")
        .collect();

    // P1-5 故障阻断：产物非空但操作系统匹配结果为空时返回 None ——
    // 绝不可跨系统回退选择产物。
    if os_matches.is_empty() {
        log::debug!("selector decision none candidates={}", assets.len());
        return None;
    }

    let candidates = os_matches;

    let best = candidates.iter().max_by_key(|a| score_asset(a)).copied();
    // 决策 debug：只记 basename + 分数 + 候选数，不记全路径/URL。
    if let Some(b) = best {
        log::debug!(
            "selector decision file={} score={} candidates={}",
            crate::log_support::file_base(&b.name),
            score_asset(b),
            assets.len()
        );
    } else {
        log::debug!("selector decision none candidates={}", assets.len());
    }
    best
}
