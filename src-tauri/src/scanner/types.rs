use crate::github::CatalogItem;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannedRawApp {
    pub display_name: String,
    pub display_version: String,
    pub publisher: Option<String>,
    pub install_location: Option<String>,
    pub display_icon: Option<String>,
    pub uninstall_string: Option<String>,
    #[serde(default)]
    pub installed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppMatchResult {
    pub scanned: ScannedRawApp,
    pub catalog_id: String,
    pub name: String,
    pub owner: String,
    pub repo: String,
    pub icon: String,
    pub icon_bg: String,
    pub description: String,
    pub local_version: String,
    pub catalog_version: String,
    pub confidence: f32,
    pub confidence_tier: String, // 置信度等级："high"（高）、"medium"（中）、"low"（低）
    pub resolved_executable_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportAppRequest {
    pub app_id: String,
    pub app_name: String,
    pub version: String,
    pub install_path: Option<String>,
    pub uninstall_command: Option<String>,
    #[serde(default)]
    pub installed_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ScanConfig {
    pub target_executables: Vec<String>,
    pub install_dirs: Vec<String>,
    pub search_subdirs: Vec<String>,
}

/// 可执行文件名候选（本地 helper，收敛两个 From impl）。
fn exe_candidates(base: &str) -> Vec<String> {
    let lower = base.to_lowercase();
    let clean = lower.replace(['.', '-'], "");
    vec![
        format!("{}.exe", lower),
        format!("{}.exe", base),
        format!("{}.exe", clean),
        format!("{}64.exe", lower),
        format!("{}-x64.exe", lower),
    ]
}

/// 默认搜索子目录（本地 helper，收敛两个 From impl）。
fn default_search_subdirs() -> Vec<String> {
    vec![
        "bin".to_string(),
        "bin\\64bit".to_string(),
        "bin/64bit".to_string(),
        "bin\\x64".to_string(),
        "bin/x64".to_string(),
        "app".to_string(),
        "App".to_string(),
        "Core".to_string(),
    ]
}

/// 秒级时间戳（本地 helper，供 executable/tests 收敛 now_secs）。
pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl From<&CatalogItem> for ScanConfig {
    fn from(cat: &CatalogItem) -> Self {
        let mut target_executables = cat.get_identifiers("windows");
        if target_executables.is_empty() {
            // ADR-0010：id 为 owner/repo 坐标，不能再当文件名候选，仅以 repo/name 派生
            target_executables = exe_candidates(&cat.repo);
        }

        let mut install_dirs = cat.install_dirs.clone();
        if install_dirs.is_empty() {
            install_dirs = vec![cat.repo.clone(), cat.repo.to_lowercase(), cat.name.clone()];
        }

        let mut search_subdirs = cat.search_subdirs.clone();
        if search_subdirs.is_empty() {
            search_subdirs = default_search_subdirs();
        }

        Self {
            target_executables,
            install_dirs,
            search_subdirs,
        }
    }
}

impl From<&str> for ScanConfig {
    fn from(name: &str) -> Self {
        Self {
            target_executables: exe_candidates(name),
            install_dirs: vec![name.to_string(), name.to_lowercase()],
            search_subdirs: default_search_subdirs(),
        }
    }
}

impl From<&String> for ScanConfig {
    fn from(name: &String) -> Self {
        Self::from(name.as_str())
    }
}
