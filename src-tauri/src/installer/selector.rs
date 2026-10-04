use super::{contains_word, AssetKind};

pub fn classify_asset(filename: &str) -> (AssetKind, &'static str, &'static str) {
    let name_lower = filename.to_lowercase();
    let n = name_lower.as_str();

    let arch = if contains_word(n, "arm64") || contains_word(n, "aarch64") {
        "aarch64"
    } else if contains_word(n, "x86_64")
        || contains_word(n, "x64")
        || contains_word(n, "amd64")
        || contains_word(n, "win64")
    {
        "x86_64"
    } else if contains_word(n, "x86")
        || contains_word(n, "i686")
        || contains_word(n, "i386")
        || contains_word(n, "win32")
        || contains_word(n, "ia32")
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
        || contains_word(n, "win")
        || contains_word(n, "windows"))
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
        let zip_os = if contains_word(n, "darwin")
            || contains_word(n, "macos")
            || contains_word(n, "osx")
            || contains_word(n, "mac")
        {
            "macos"
        } else if contains_word(n, "linux") {
            "linux"
        } else {
            "windows"
        };
        (AssetKind::PortableZip, zip_os, arch)
    } else if name_lower.ends_with(".7z") {
        // P1-4：移除 `.7z` 文件的便携版识别声明 —— 解压器仅支持
        // `zip::ZipArchive`，因此 `.7z` 按照下文 `.tar.gz` 的既有惯例归类为 Other（不支持）。不额外引入 7z 依赖。
        (AssetKind::Other, "all", "universal")
    } else if name_lower.ends_with(".tar.bz2") {
        // executor 仅支持 gzip/xz/plain（无 bzip2 依赖），`.tar.bz2` 必败，
        // 与 `.7z` 一致归类为 Other（不可装），不引入新依赖。
        (AssetKind::Other, "all", "universal")
    } else if name_lower.ends_with(".tar.gz")
        || name_lower.ends_with(".tar.xz")
        || name_lower.ends_with(".tgz")
        || name_lower.ends_with(".tar")
    {
        let tar_os = if contains_word(n, "darwin")
            || contains_word(n, "macos")
            || contains_word(n, "osx")
            || contains_word(n, "mac")
        {
            "macos"
        } else if contains_word(n, "windows")
            || contains_word(n, "win64")
            || contains_word(n, "win32")
            || contains_word(n, "win")
        {
            "windows"
        } else {
            "linux"
        };
        (AssetKind::PortableTarball, tar_os, arch)
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
pub const SCORE_ASSET_KIND_TARBALL: i32 = 5;

/// 获取当前系统平台标识字符串（windows / macos / linux / all）。
pub fn current_target_os() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "all"
    }
}

/// 获取当前 CPU 架构标识字符串（x86_64 / aarch64 / universal）。
pub fn current_target_arch() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        "x86_64"
    }
    #[cfg(target_arch = "aarch64")]
    {
        "aarch64"
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        "universal"
    }
}

/// 根据当前系统平台与 CPU 架构为资产计算适配匹配度打分
pub fn score_asset(a: &crate::models::ReleaseAsset) -> i32 {
    let target_os = current_target_os();
    let target_arch = current_target_arch();

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

    // kind 加成收敛为单处 `kind.as_str()` 映射（各目标 OS 的 primary/secondary
    // arm 经 cfg 门控，行为与原三处分支逐平台一致；`compressed_tarball` 别名已删除）。
    match a.kind.as_str() {
        #[cfg(target_os = "windows")]
        "msi" => score += SCORE_ASSET_KIND_PRIMARY,
        #[cfg(target_os = "windows")]
        "setup_exe" => score += SCORE_ASSET_KIND_SECONDARY,
        #[cfg(target_os = "macos")]
        "dmg" => score += SCORE_ASSET_KIND_PRIMARY,
        #[cfg(target_os = "macos")]
        "pkg" => score += SCORE_ASSET_KIND_SECONDARY,
        #[cfg(target_os = "linux")]
        "appimage" => score += SCORE_ASSET_KIND_PRIMARY,
        #[cfg(target_os = "linux")]
        "deb" => score += SCORE_ASSET_KIND_SECONDARY,
        #[cfg(target_os = "linux")]
        "rpm" => score += SCORE_ASSET_KIND_TERTIARY,
        "portable_zip" => score += SCORE_ASSET_KIND_PORTABLE,
        "portable_tarball" => score += SCORE_ASSET_KIND_TARBALL,
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
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
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
