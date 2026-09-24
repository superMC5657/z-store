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

impl From<&CatalogItem> for ScanConfig {
    fn from(cat: &CatalogItem) -> Self {
        let mut target_executables = cat.get_identifiers("windows");
        if target_executables.is_empty() {
            let clean_repo = cat.repo.to_lowercase().replace(['.', '-'], "");
            // ADR-0010：id 为 owner/repo 坐标，不能再当文件名候选，仅以 repo/name 派生
            target_executables = vec![
                format!("{}.exe", cat.repo.to_lowercase()),
                format!("{}.exe", cat.repo),
                format!("{}.exe", clean_repo),
                format!("{}64.exe", cat.repo.to_lowercase()),
                format!("{}-x64.exe", cat.repo.to_lowercase()),
            ];
        }

        let mut install_dirs = cat.install_dirs.clone();
        if install_dirs.is_empty() {
            install_dirs = vec![
                cat.repo.clone(),
                cat.repo.to_lowercase(),
                cat.name.clone(),
            ];
        }

        let mut search_subdirs = cat.search_subdirs.clone();
        if search_subdirs.is_empty() {
            search_subdirs = vec![
                "bin".to_string(),
                "bin\\64bit".to_string(),
                "bin/64bit".to_string(),
                "bin\\x64".to_string(),
                "bin/x64".to_string(),
                "app".to_string(),
                "App".to_string(),
                "Core".to_string(),
            ];
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
        let clean = name.to_lowercase().replace(['.', '-'], "");
        Self {
            target_executables: vec![
                format!("{}.exe", name.to_lowercase()),
                format!("{}.exe", name),
                format!("{}.exe", clean),
                format!("{}64.exe", name.to_lowercase()),
                format!("{}-x64.exe", name.to_lowercase()),
            ],
            install_dirs: vec![name.to_string(), name.to_lowercase()],
            search_subdirs: vec![
                "bin".to_string(),
                "bin\\64bit".to_string(),
                "bin/64bit".to_string(),
                "bin\\x64".to_string(),
                "bin/x64".to_string(),
                "app".to_string(),
                "App".to_string(),
                "Core".to_string(),
            ],
        }
    }
}

impl From<&String> for ScanConfig {
    fn from(name: &String) -> Self {
        Self::from(name.as_str())
    }
}
