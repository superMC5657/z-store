pub mod display_icon;
pub mod executable;
#[cfg(any(target_os = "linux", test))]
pub mod linux;
pub mod lnk_target;
#[cfg(any(target_os = "macos", test))]
pub mod macos;
pub mod matcher;
pub mod registry;
pub mod types;
pub mod version;

#[cfg(test)]
mod matcher_eval_tests;
#[cfg(test)]
mod tests;

pub use types::{
    AppMatchResult, ConfidenceTier, ImportAppRequest, MatchReason, ScanConfig, ScanOutcome,
    ScannedRawApp, SourceKind,
};

pub struct AppScanner;

impl AppScanner {
    /// 扫描系统已安装应用列表
    pub fn scan_system_apps() -> Vec<ScannedRawApp> {
        #[cfg(target_os = "windows")]
        {
            Self::scan_windows_registry()
        }
        #[cfg(target_os = "linux")]
        {
            Self::scan_linux_desktop()
        }
        #[cfg(target_os = "macos")]
        {
            Self::scan_macos_apps()
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        {
            Vec::new()
        }
    }

    /// 扫描系统已安装应用并过滤已纳管条目，返回扫描总数与待纳管匹配结果。
    /// 导入路径须在磁盘上存在；不存在时按「我的应用」同一套路径修复（`resolve_installed_app_path`，
    /// 参数与 `get_installed_apps` 一致）补找，仍找不到的条目被剔除——导入后它也不会显示。
    pub fn scan_unmanaged(
        catalog: &[crate::github::CatalogItem],
        installed_ids: impl IntoIterator<Item = String>,
    ) -> ScanOutcome {
        let scanned = Self::scan_system_apps();
        let scanned_count = scanned.len();
        let unmanaged = Self::match_unmanaged(&scanned, catalog, installed_ids)
            .into_iter()
            .filter_map(Self::ensure_import_path)
            .collect();
        ScanOutcome {
            scanned_count,
            unmanaged,
        }
    }

    /// 确保匹配结果带有磁盘上存在的导入路径：已解析主程序存在则原样返回；本机条目自带的
    /// 安装目录仍存在时也原样保留（不拿全盘探测结果覆盖成无关路径）；两者都不在时才经路径修复
    /// 补上主程序路径（版本未知时顺带读该主程序的版本）；仍找不到返回 None。
    fn ensure_import_path(mut m: AppMatchResult) -> Option<AppMatchResult> {
        let exists = |p: &str| {
            let p = version::unquote_path(p);
            !p.is_empty() && std::path::Path::new(p).exists()
        };
        if m.resolved_executable_path.as_deref().is_some_and(exists) {
            return Some(m);
        }
        if m.scanned.install_location.as_deref().is_some_and(exists) {
            m.resolved_executable_path = None;
            return Some(m);
        }
        let repaired = Self::resolve_installed_app_path(&m.name, &m.catalog_id, Some(&m.repo))?;
        if m.local_version.trim().is_empty() {
            m.local_version = Self::read_exe_version(&repaired).unwrap_or_default();
        }
        m.resolved_executable_path = Some(repaired);
        Some(m)
    }
}
