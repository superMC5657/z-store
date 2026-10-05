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

/// Linux 裸名候选（无扩展名；与 `exe_candidates` 互补，Windows 行为不受影响）。
fn bare_candidates(base: &str) -> Vec<String> {
    let lower = base.to_lowercase();
    let clean = lower.replace(['.', '-'], "");
    let mut out = vec![lower.clone(), base.to_string(), clean];
    out.sort();
    out.dedup();
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

/// 当前平台裸名是否需要并入 `target_executables`（仅 Linux）。
fn needs_bare_candidates() -> bool {
    cfg!(target_os = "linux")
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
    crate::now_secs()
}

impl From<&CatalogItem> for ScanConfig {
    fn from(cat: &CatalogItem) -> Self {
        // Windows：保持原有语义（windows 标识为空才用 repo 派生 .exe）。
        // Linux：优先取 linux 原生标识（catalog.json 如 motrix），为空才回退；
        // 为兼容存量单测（.exe 夹具）额外并入 .exe 派生，不改变 Windows 行为。
        #[cfg(target_os = "windows")]
        let mut target_executables = cat.get_identifiers("windows");
        #[cfg(not(target_os = "windows"))]
        let mut target_executables = cat.get_native_identifiers();
        if target_executables.is_empty() {
            // ADR-0010：id 为 owner/repo 坐标，不能再当文件名候选，仅以 repo/name 派生
            target_executables = exe_candidates(&cat.repo);
        }
        #[cfg(target_os = "linux")]
        {
            for extra in exe_candidates(&cat.repo) {
                if !target_executables.contains(&extra) {
                    target_executables.push(extra);
                }
            }
            for extra in bare_candidates(&cat.repo) {
                if !target_executables.contains(&extra) {
                    target_executables.push(extra);
                }
            }
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
        let mut target_executables = exe_candidates(name);
        // Linux 下并入裸名（/usr/bin/<token> 等无扩展名），Windows 保持纯 .exe 不变。
        if needs_bare_candidates() {
            for extra in bare_candidates(name) {
                if !target_executables.contains(&extra) {
                    target_executables.push(extra);
                }
            }
        }
        Self {
            target_executables,
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
