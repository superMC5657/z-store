use crate::github::CatalogItem;
use serde::{Deserialize, Serialize};

/// 发现来源枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Registry,
    Scoop,
    Shortcut,
    Desktop,
    Appimage,
    MacosApp,
}

impl SourceKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Registry => "registry",
            Self::Scoop => "scoop",
            Self::Shortcut => "shortcut",
            Self::Desktop => "desktop",
            Self::Appimage => "appimage",
            Self::MacosApp => "macos_app",
        }
    }
}

/// 置信度分级阈值常量
pub const MIN_QUALIFIED_SCORE: f32 = 0.45;
pub const TIER_HIGH_CONFIDENCE_THRESHOLD: f32 = 0.70;
pub const TIER_MEDIUM_CONFIDENCE_THRESHOLD: f32 = 0.55;

/// 置信度等级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfidenceTier {
    High,
    Medium,
    Low,
}

impl ConfidenceTier {
    pub fn from_score(score: f32) -> Self {
        if score >= TIER_HIGH_CONFIDENCE_THRESHOLD {
            Self::High
        } else if score >= TIER_MEDIUM_CONFIDENCE_THRESHOLD {
            Self::Medium
        } else {
            Self::Low
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}

/// 匹配依据编码（前端按此映射文案）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchReason {
    ExactName,
    PrefixName,
    Alias,
    Executable,
    BundleId,
    InstallDir,
    Publisher,
    Version,
}

impl MatchReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExactName => "exact_name",
            Self::PrefixName => "prefix_name",
            Self::Alias => "alias",
            Self::Executable => "executable",
            Self::BundleId => "bundle_id",
            Self::InstallDir => "install_dir",
            Self::Publisher => "publisher",
            Self::Version => "version",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScannedRawApp {
    pub display_name: String,
    pub display_version: String,
    pub publisher: Option<String>,
    pub install_location: Option<String>,
    pub display_icon: Option<String>,
    pub uninstall_string: Option<String>,
    #[serde(default)]
    pub installed_at: Option<i64>,
    /// 系统侧的应用包标识：注册表卸载子键名（去 `_is1`，GUID 键不记）、Scoop 应用名、
    /// Linux `.desktop` 文件名、macOS `CFBundleIdentifier`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_key: Option<String>,
    /// 发现来源。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<SourceKind>,
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
    pub confidence_tier: ConfidenceTier,
    pub resolved_executable_path: Option<String>,
    /// 匹配依据编码。
    #[serde(default)]
    pub match_reasons: Vec<MatchReason>,
}

impl AppMatchResult {
    /// 导入时写入 `installed_apps.install_path` 的路径：优先已解析的主程序，其次注册表安装目录。
    /// 「我的应用」以该路径在磁盘上存在为可见前提，故扫描结果也以它为准。
    pub fn import_path(&self) -> Option<&str> {
        self.resolved_executable_path
            .as_deref()
            .or(self.scanned.install_location.as_deref())
            .map(super::version::unquote_path)
            .filter(|p| !p.is_empty())
    }
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
pub struct ScanOutcome {
    pub scanned_count: usize,
    pub unmanaged: Vec<AppMatchResult>,
}

#[derive(Debug, Clone)]
pub struct ScanConfig {
    pub target_executables: Vec<String>,
    pub install_dirs: Vec<String>,
    pub search_subdirs: Vec<String>,
}

/// 判断标识符是否为安装包或压缩包资产名，而非安装后的主程序名（应用自身名称已含的词除外）。
pub fn is_installer_asset_identifier(ident: &str, repo: &str, app_name: &str) -> bool {
    let lower = ident.trim().to_lowercase();
    if lower.is_empty() {
        return false;
    }
    if [".paf.exe", ".msi", ".zip", ".7z"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        return true;
    }
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    let owner_text = format!("{} {}", repo.to_lowercase(), app_name.to_lowercase());

    if ["setup", "installer"]
        .iter()
        .any(|kw| stem.contains(kw) && !owner_text.contains(kw))
    {
        return true;
    }
    if has_embedded_version(stem) && !has_embedded_version(&owner_text) {
        return true;
    }
    const PACKAGING_TOKENS: &[&str] = &[
        "install", "portable", "release", "x64", "x86", "x32", "amd64", "win32", "win64", "arm64",
        "aarch64", "mingw", "win", "windows",
    ];
    let owner_tokens: Vec<&str> = owner_text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    stem.split(|c: char| !c.is_alphanumeric())
        .any(|t| PACKAGING_TOKENS.contains(&t) && !owner_tokens.contains(&t))
}

/// 是否内嵌 `数字[._]数字` 形态的版本段（`8.9.8`、`4_4_198`）。
fn has_embedded_version(s: &str) -> bool {
    s.as_bytes()
        .windows(3)
        .any(|w| w[0].is_ascii_digit() && (w[1] == b'.' || w[1] == b'_') && w[2].is_ascii_digit())
}

/// 当前平台原生标识中剔除安装包资产名后的主程序候选。
pub fn clean_native_identifiers(cat: &CatalogItem) -> Vec<String> {
    cat.get_native_identifiers()
        .into_iter()
        .filter(|id| !is_installer_asset_identifier(id, &cat.repo, &cat.name))
        .collect()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
/// 名称可直接作文件名候选（ASCII 字母数字与 `-_.+ `）时返回其 `.exe` 候选。
fn name_exe_candidates(name: &str) -> Vec<String> {
    let trimmed = name.trim();
    let shaped = !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | ' '));
    if shaped {
        exe_candidates(trimmed)
    } else {
        Vec::new()
    }
}

fn push_unique(out: &mut Vec<String>, extra: impl IntoIterator<Item = String>) {
    for e in extra {
        if !out.contains(&e) {
            out.push(e);
        }
    }
}

/// 生成可执行文件名候选。
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

/// 默认搜索子目录。
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

/// 当前 Unix 秒级时间戳。
pub(crate) fn now_secs() -> i64 {
    crate::now_secs()
}

impl From<&CatalogItem> for ScanConfig {
    fn from(cat: &CatalogItem) -> Self {
        // 精校主程序标识在前，repo/名称派生候选追加在后（id 为 owner/repo 坐标，仅以 repo 派生）。
        let mut target_executables = clean_native_identifiers(cat);
        #[cfg(target_os = "windows")]
        {
            push_unique(&mut target_executables, exe_candidates(&cat.repo));
            push_unique(&mut target_executables, name_exe_candidates(&cat.name));
        }
        #[cfg(not(target_os = "windows"))]
        {
            push_unique(&mut target_executables, bare_candidates(&cat.repo));
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
