pub mod display_icon;
pub mod executable;
pub mod join;
pub mod lnk_target;
pub mod matcher;
pub mod registry;
pub mod types;

#[cfg(test)]
mod tests;

pub use types::{AppMatchResult, ImportAppRequest, ScanConfig, ScannedRawApp};

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
}
