pub mod display_icon;
pub mod executable;
pub mod lnk_target;
pub mod matcher;
pub mod registry;
pub mod types;

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
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            // 预留 macOS 等平台
            Vec::new()
        }
    }

    /// 扫描系统已安装应用并过滤已纳管条目，返回扫描总数与待纳管匹配结果。
    pub fn scan_unmanaged(
        catalog: &[crate::github::CatalogItem],
        installed_ids: impl IntoIterator<Item = String>,
    ) -> ScanOutcome {
        let scanned = Self::scan_system_apps();
        let scanned_count = scanned.len();
        let unmanaged = Self::match_unmanaged(&scanned, catalog, installed_ids);
        ScanOutcome {
            scanned_count,
            unmanaged,
        }
    }
}
