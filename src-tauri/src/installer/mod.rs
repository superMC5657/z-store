pub mod downloader_http;
pub mod downloader_progress;
pub mod executor;
pub mod managed;
pub mod paths;
pub mod selector;

#[cfg(test)]
mod tests;

pub use downloader_http::download_with_progress;
pub use executor::{execute_installation, parse_uninstaller_command};
pub use paths::{
    default_download_dir, dirs_or_fallback, dirs_or_fallback_with_base, expand_env_path,
    resolve_uninstaller_command, sanitize_shortcut_name,
};
pub use selector::{classify_asset, score_asset, select_best_asset};

/// 同步阻塞闭包卸到 Tokio 阻塞线程池（注册表枚举、文件系统探测、解压、进程启动等）。
pub async fn run_blocking<T, F>(f: F) -> crate::AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| crate::AppError::new(e.to_string()))
}

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

/// `AssetKind -> &str` 唯一映射点（禁止另起重复映射）。
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
        let before_ok = s == 0 || matches!(name_lower.as_bytes()[s - 1], b'-' | b'_' | b'.');
        let after_ok =
            e == name_lower.len() || matches!(name_lower.as_bytes()[e], b'-' | b'_' | b'.');
        if before_ok && after_ok {
            return true;
        }
        start = s + 1;
    }
    false
}
