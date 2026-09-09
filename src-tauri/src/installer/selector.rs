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
        && (name_lower.ends_with(".zip") || name_lower.ends_with(".7z"))
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
    } else if name_lower.ends_with(".zip") || name_lower.ends_with(".7z") {
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
    #[cfg(target_os = "android")]
    let target_os = "android";
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    let target_os = "all";

    #[cfg(target_arch = "x86_64")]
    let target_arch = "x86_64";
    #[cfg(target_arch = "aarch64")]
    let target_arch = "aarch64";
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    let target_arch = "universal";

    let os_matches: Vec<&crate::models::ReleaseAsset> = assets
        .iter()
        .filter(|a| a.os == target_os || a.os == "all")
        .collect();

    let candidates = if os_matches.is_empty() {
        assets.iter().collect::<Vec<&crate::models::ReleaseAsset>>()
    } else {
        os_matches
    };

    candidates.into_iter().max_by_key(|a| {
        let mut score: i32 = 0;
        if a.os == target_os {
            score += 100;
        }
        if a.arch == target_arch {
            score += 50;
        } else if a.arch == "universal" {
            score += 25;
        } else if target_arch == "x86_64" && a.arch == "x86" {
            score += 10;
        } else {
            score -= 50;
        }

        #[cfg(target_os = "windows")]
        match a.kind.as_str() {
            "msi" => score += 20,
            "setup_exe" => score += 15,
            "portable_zip" => score += 10,
            _ => {}
        }

        #[cfg(target_os = "macos")]
        match a.kind.as_str() {
            "dmg" => score += 20,
            "pkg" => score += 15,
            "portable_zip" => score += 10,
            _ => {}
        }

        #[cfg(target_os = "linux")]
        match a.kind.as_str() {
            "appimage" => score += 20,
            "deb" => score += 15,
            "rpm" => score += 12,
            "portable_zip" => score += 10,
            _ => {}
        }

        score
    })
}
