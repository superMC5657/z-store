pub mod downloader;
pub mod executor;
pub mod paths;
pub mod selector;

#[cfg(test)]
mod tests;

pub use executor::InstallOutcome;
pub use executor::{execute_installation, execute_uninstallation, parse_uninstaller_command};
pub use paths::{
    default_download_dir, dirs_or_fallback, dirs_or_fallback_with_base, expand_env_path,
    resolve_uninstaller_command, user_home_dir,
};
pub use selector::{classify_asset, score_asset, select_best_asset};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetKind {
    Msi,
    SetupExe,
    PortableZip,
    PortableTarball,
    Deb,
    Rpm,
    AppImage,
    Dmg,
    Pkg,
    Apk,
    Other,
}

/// `AssetKind -> &str` 唯一收敛点（`forge/provider.rs::AssetKindExt` 与
/// `github/detail.rs` 内联 `match` 均已收敛至此，禁止另起重复映射）。
impl AssetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssetKind::Msi => "msi",
            AssetKind::SetupExe => "setup_exe",
            AssetKind::PortableZip => "portable_zip",
            AssetKind::PortableTarball => "portable_tarball",
            AssetKind::Deb => "deb",
            AssetKind::Rpm => "rpm",
            AssetKind::AppImage => "appimage",
            AssetKind::Dmg => "dmg",
            AssetKind::Pkg => "pkg",
            AssetKind::Apk => "apk",
            AssetKind::Other => "other",
        }
    }
}

/// 整词边界匹配：`word` 前后必须为起始/结尾或分隔符（`-`/`_`/`/`）。
/// 子串 `contains` 会误命中（`win` 命中 `darwin`/`twin`/`drawing`、
/// `mac` 命中 `machine`），此处一律走整词判定。
pub(crate) fn contains_word(name_lower: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let mut start = 0;
    while let Some(pos) = name_lower[start..].find(word) {
        let s = start + pos;
        let e = s + word.len();
        let before_ok =
            s == 0 || matches!(name_lower.as_bytes()[s - 1], b'-' | b'_' | b'.');
        let after_ok = e == name_lower.len()
            || matches!(name_lower.as_bytes()[e], b'-' | b'_' | b'.');
        if before_ok && after_ok {
            return true;
        }
        start = s + 1;
    }
    false
}

pub struct InstallerEngine;

impl InstallerEngine {
    pub fn classify_asset(filename: &str) -> (AssetKind, &'static str, &'static str) {
        selector::classify_asset(filename)
    }

    pub async fn download_with_progress(
        app_handle: &tauri::AppHandle,
        task_id: &str,
        download_url: &str,
        asset_name: &str,
        expected_sha256: Option<&str>,
        custom_download_dir: Option<&std::path::Path>,
    ) -> Result<(std::path::PathBuf, String), String> {
        downloader::download_with_progress(
            app_handle,
            task_id,
            download_url,
            asset_name,
            expected_sha256,
            custom_download_dir,
        )
        .await
    }

    pub async fn execute_installation(
        installer_path: &std::path::Path,
        kind: &AssetKind,
        app_id: &str,
        custom_portable_dir: Option<&str>,
    ) -> Result<executor::InstallOutcome, String> {
        executor::execute_installation(installer_path, kind, app_id, custom_portable_dir).await
    }
}
