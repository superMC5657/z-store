pub mod display_icon;
pub mod executable;
pub mod lnk_target;
#[cfg(any(target_os = "macos", test))]
pub mod macos;
pub mod matcher;
pub mod registry;
pub mod types;
pub mod version;

#[cfg(test)]
mod tests;

pub use types::{AppMatchResult, ImportAppRequest, ScanConfig, ScanOutcome, ScannedRawApp};

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

    /// 确保匹配结果带有磁盘上存在的导入路径：已有则原样返回；否则经路径修复补上主程序路径
    /// （版本未知时顺带读该主程序的版本）；仍找不到返回 None。
    fn ensure_import_path(mut m: AppMatchResult) -> Option<AppMatchResult> {
        if m.import_path()
            .is_some_and(|p| std::path::Path::new(p).exists())
        {
            return Some(m);
        }
        let repaired = Self::resolve_installed_app_path(&m.name, &m.catalog_id, None)?;
        if m.local_version.trim().is_empty() {
            m.local_version = Self::read_exe_version(&repaired).unwrap_or_default();
        }
        m.resolved_executable_path = Some(repaired);
        Some(m)
    }
}
