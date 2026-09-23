pub mod downloader;
pub mod executor;
pub mod paths;
pub mod selector;

#[cfg(test)]
mod tests;

pub use executor::{execute_installation, execute_uninstallation, parse_uninstaller_command};
pub use executor::InstallOutcome;
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
    Deb,
    Rpm,
    AppImage,
    Dmg,
    Pkg,
    Apk,
    Other,
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
