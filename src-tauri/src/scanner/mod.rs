pub mod matcher;
pub mod registry;
pub mod resolver;
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
        #[cfg(not(target_os = "windows"))]
        {
            // 非 Windows 平台（预留 Linux/macOS）
            Vec::new()
        }
    }
}
