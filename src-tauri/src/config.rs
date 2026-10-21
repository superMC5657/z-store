use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const EMBEDDED_CONFIG: &str = include_str!("../config.toml");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfig {
    #[serde(default)]
    pub runtime: RuntimeConfig,
    #[serde(default)]
    pub cache: CacheConfig,
    #[serde(default)]
    pub network: NetworkConfig,
    #[serde(default)]
    pub limits: LimitsConfig,
    #[serde(default)]
    pub oauth: OauthConfig,
    #[serde(default)]
    pub catalog: CatalogConfig,
    #[serde(default)]
    pub license_gate: LicenseGateConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RuntimeConfig {
    #[serde(default = "default_strict_errors")]
    pub strict_errors: bool,
}

fn default_strict_errors() -> bool {
    cfg!(debug_assertions)
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            strict_errors: default_strict_errors(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CacheConfig {
    #[serde(default = "default_detail_ttl_minutes")]
    pub detail_ttl_minutes: i64,
    #[serde(default = "default_asset_max_mb")]
    pub asset_max_mb: u64,
    #[serde(default = "default_asset_max_files")]
    pub asset_max_files: usize,
}

fn default_detail_ttl_minutes() -> i64 {
    60
}

fn default_asset_max_mb() -> u64 {
    500
}

fn default_asset_max_files() -> usize {
    2000
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            detail_ttl_minutes: default_detail_ttl_minutes(),
            asset_max_mb: default_asset_max_mb(),
            asset_max_files: default_asset_max_files(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetworkConfig {
    #[serde(default = "default_connect_timeout_seconds")]
    pub connect_timeout_seconds: u64,
    #[serde(default = "default_download_timeout_seconds")]
    pub download_timeout_seconds: u64,
    #[serde(default = "default_chunk_timeout_seconds")]
    pub chunk_timeout_seconds: u64,
    #[serde(default = "default_api_timeout_seconds")]
    pub api_timeout_seconds: u64,
    #[serde(default = "default_ping_timeout_ms")]
    pub ping_timeout_ms: u64,
}

fn default_connect_timeout_seconds() -> u64 {
    15
}
fn default_download_timeout_seconds() -> u64 {
    300
}
fn default_chunk_timeout_seconds() -> u64 {
    30
}
fn default_api_timeout_seconds() -> u64 {
    12
}
fn default_ping_timeout_ms() -> u64 {
    4000
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            connect_timeout_seconds: default_connect_timeout_seconds(),
            download_timeout_seconds: default_download_timeout_seconds(),
            chunk_timeout_seconds: default_chunk_timeout_seconds(),
            api_timeout_seconds: default_api_timeout_seconds(),
            ping_timeout_ms: default_ping_timeout_ms(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimitsConfig {
    #[serde(default = "default_search_history_limit")]
    pub search_history_limit: usize,
    #[serde(default = "default_view_history_limit")]
    pub view_history_limit: usize,
    #[serde(default = "default_online_search_page_size")]
    pub online_search_page_size: usize,
    /// 统一图标补探配置（搜索与趋势共用收敛，与趋势 `buffered(5)` 对齐）。
    #[serde(default)]
    pub icon_fetch: IconFetchConfig,
}

/// 统一图标补探配置（`limits.icon_fetch`）。
/// 默认：`pool=5 / total_timeout_secs=15`。
/// 快慢超时经 `network.api_timeout_seconds` 统一配置；整批总量按页伸缩。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct IconFetchConfig {
    #[serde(default = "default_icon_fetch_pool")]
    pub pool: usize,
    #[serde(default = "default_icon_fetch_total_timeout_secs")]
    pub total_timeout_secs: u64,
}

fn default_icon_fetch_pool() -> usize {
    5
}
fn default_icon_fetch_total_timeout_secs() -> u64 {
    15
}

impl Default for IconFetchConfig {
    fn default() -> Self {
        Self {
            pool: default_icon_fetch_pool(),
            total_timeout_secs: default_icon_fetch_total_timeout_secs(),
        }
    }
}

fn default_search_history_limit() -> usize {
    20
}
fn default_view_history_limit() -> usize {
    30
}
fn default_online_search_page_size() -> usize {
    20
}

/// 在线搜索分页钳制边界：前后端统一钳制 1-50。
pub const ONLINE_SEARCH_PER_PAGE_MIN: usize = 1;
pub const ONLINE_SEARCH_PER_PAGE_MAX: usize = 50;

impl LimitsConfig {
    /// 在线搜索 `per_page` 归一化：None=默认 `online_search_page_size`，其余钳制 1-50。
    pub fn clamp_online_search_per_page(&self, per_page: Option<u32>) -> usize {
        match per_page {
            None => self.online_search_page_size.max(ONLINE_SEARCH_PER_PAGE_MIN),
            Some(n) => (n as usize).clamp(
                ONLINE_SEARCH_PER_PAGE_MIN,
                ONLINE_SEARCH_PER_PAGE_MAX,
            ),
        }
    }

    /// 在线搜索 `page` 归一化：None/0=第 1 页，其余保持原值（下限 1）。
    pub fn normalize_online_search_page(page: Option<u32>) -> u32 {
        match page {
            None | Some(0) => 1,
            Some(n) => n,
        }
    }
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            search_history_limit: default_search_history_limit(),
            view_history_limit: default_view_history_limit(),
            online_search_page_size: default_online_search_page_size(),
            icon_fetch: IconFetchConfig::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OauthConfig {
    #[serde(default = "default_oauth_client_id")]
    pub default_client_id: String,
}

fn default_oauth_client_id() -> String {
    // 与嵌入 config.toml [oauth] default_client_id 两处同值：常量供外部文件缺段时回退，
    // 嵌入字面量供正常启动读取；一致性由
    // `serde_field_defaults_match_embedded_baseline` 逐项校验锁定。
    "Ov23lik0b7fDGMLTiOYH".to_string()
}

impl Default for OauthConfig {
    fn default() -> Self {
        Self {
            default_client_id: default_oauth_client_id(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogConfig {
    #[serde(default = "default_local_path")]
    pub local_path: String,
    #[serde(default = "default_source_url")]
    pub default_source_url: String,
}

fn default_local_path() -> String {
    "../catalog.json".to_string()
}

fn default_source_url() -> String {
    "https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json".to_string()
}

impl Default for CatalogConfig {
    fn default() -> Self {
        Self {
            local_path: default_local_path(),
            default_source_url: default_source_url(),
        }
    }
}

/// 默认许可名单（ADR-0018）：编译期兜底；运行时源为编译进发行的 config.toml
/// `[license_gate] allowed`（serde 缺段时回落本常量），两者由
/// `license_allowed_matches_constant_item_by_item` 测试锁定同序同值。
pub const DEFAULT_LICENSE_ALLOWLIST: &[&str] = &[
    "MIT",
    "ISC",
    "APACHE-2.0",
    "APACHE-1.1",
    "GPL-2.0",
    "GPL-2.0-ONLY",
    "GPL-2.0-OR-LATER",
    "GPL-3.0",
    "GPL-3.0-ONLY",
    "GPL-3.0-OR-LATER",
    "LGPL-2.0",
    "LGPL-2.0-ONLY",
    "LGPL-2.0-OR-LATER",
    "LGPL-2.1",
    "LGPL-2.1-ONLY",
    "LGPL-2.1-OR-LATER",
    "LGPL-3.0",
    "LGPL-3.0-ONLY",
    "LGPL-3.0-OR-LATER",
    "AGPL-3.0",
    "AGPL-3.0-ONLY",
    "AGPL-3.0-OR-LATER",
    "BSD-2-CLAUSE",
    "BSD-3-CLAUSE",
    "MPL-2.0",
    "MPL-1.1",
    "MPL-1.0",
    "MS-PL",
    "MS-RL",
    "UNLICENSE",
    "ZLIB",
    "ARTISTIC-2.0",
    "EPL-1.0",
    "EPL-2.0",
    "CDDL-1.0",
    "OSL-3.0",
    "AFL-3.0",
];

/// 嵌入配置门禁段的编译期扫描（`[license_gate]`）：`enabled=true`（缺键默认开）
/// 且 `allowed=[...]` 存在但括号内无有效条目时返回 false，由下方 `const assert`
/// 直接编译失败。有效条目指引号内含非空白字符，与运行时归一“空白串归一为空”口径等价；
/// 缺段 / 缺 `allowed` 键视为 serde 默认全量名单，不判错。
const fn embedded_gate_section_valid(config: &str) -> bool {
    let bytes = config.as_bytes();
    let len = bytes.len();
    let header: &[u8] = b"[license_gate]";
    let hlen = header.len();
    let mut section_start: Option<usize> = None;
    let mut i = 0;
    while i + hlen <= len {
        let mut k = 0;
        while k < hlen && bytes[i + k] == header[k] {
            k += 1;
        }
        if k == hlen {
            section_start = Some(i + hlen);
            break;
        }
        i += 1;
    }
    let start = match section_start {
        Some(s) => s,
        None => return true,
    };
    let mut end = len;
    let mut j = start;
    while j < len {
        if bytes[j] == b'[' && (bytes[j - 1] == b'\n' || bytes[j - 1] == b'\r') {
            end = j;
            break;
        }
        j += 1;
    }
    let mut enabled = true;
    if let Some(pos) = find_bytes(bytes, start, end, b"enabled") {
        let mut p = pos + 7;
        while p < end && bytes[p] != b'=' && bytes[p] != b'\n' {
            p += 1;
        }
        if p < end && bytes[p] == b'=' {
            p += 1;
            while p < end && (bytes[p] == b' ' || bytes[p] == b'\t') {
                p += 1;
            }
            if p + 5 <= end
                && bytes[p] == b'f'
                && bytes[p + 1] == b'a'
                && bytes[p + 2] == b'l'
                && bytes[p + 3] == b's'
                && bytes[p + 4] == b'e'
            {
                enabled = false;
            }
        }
    }
    if !enabled {
        return true;
    }
    let allowed_pos = match find_bytes(bytes, start, end, b"allowed") {
        Some(p) => p,
        None => return true,
    };
    let mut p = allowed_pos + 7;
    while p < end && bytes[p] != b'=' && bytes[p] != b'\n' {
        p += 1;
    }
    if p >= end || bytes[p] != b'=' {
        return true;
    }
    p += 1;
    while p < end && bytes[p] != b'[' && bytes[p] != b'\n' {
        p += 1;
    }
    if p >= end || bytes[p] != b'[' {
        return true;
    }
    p += 1;
    let mut in_quote: Option<u8> = None;
    let mut has_content = false;
    let mut found = false;
    while p < end {
        let b = bytes[p];
        match in_quote {
            None => {
                if b == b']' {
                    break;
                } else if b == b'"' || b == b'\'' {
                    in_quote = Some(b);
                    has_content = false;
                }
            }
            Some(q) => {
                if b == b'\\' {
                    if p + 1 < end {
                        has_content = true;
                        p += 1;
                    }
                } else if b == q {
                    if has_content {
                        found = true;
                    }
                    in_quote = None;
                } else if b != b' ' && b != b'\t' && b != b'\r' && b != b'\n' {
                    has_content = true;
                }
            }
        }
        p += 1;
    }
    found
}

/// 字节子串定位（供上方 `const` 扫描使用）。
const fn find_bytes(hay: &[u8], start: usize, end: usize, needle: &[u8]) -> Option<usize> {
    let nlen = needle.len();
    if nlen == 0 {
        return Some(start);
    }
    let mut i = start;
    while i + nlen <= end {
        let mut k = 0;
        while k < nlen && hay[i + k] == needle[k] {
            k += 1;
        }
        if k == nlen {
            return Some(i);
        }
        i += 1;
    }
    None
}

const _: () = assert!(
    embedded_gate_section_valid(EMBEDDED_CONFIG),
    "license_gate.allowed 为空/非法，请填OSI名单或显式 enabled=false"
);

/// 归一口径与 `db::custom_apps::normalize_license` 一致：
/// 去空白 → 大写 → 空格/下划线折 `-` → 尾 `+` 视为或后续版本。
/// 校验侧只用它判空（有效条目即归一后非空），名单命中比对仍走校验侧。
fn normalize_license_token(raw: &str) -> String {
    let mut s = raw
        .trim()
        .to_ascii_uppercase()
        .replace([' ', '_'], "-");
    if s.ends_with('+') {
        s.pop();
        if !s.ends_with("-OR-LATER") {
            s.push_str("-OR-LATER");
        }
    }
    s
}

/// 嵌入门禁运行时复核：`enabled=true` 且 `allowed` 为空或归一后无有效条目时
/// 返回固定文案错误，由 `ProjectConfig::default` 直接 panic，不回退基线。
fn validate_embedded_license_gate(gate: &LicenseGateConfig) -> Result<(), String> {
    if !gate.enabled {
        return Ok(());
    }
    let has_valid = gate
        .allowed
        .iter()
        .any(|a| !normalize_license_token(a).is_empty());
    if has_valid {
        Ok(())
    } else {
        Err("license_gate.allowed 为空/非法，请填OSI名单或显式 enabled=false".to_string())
    }
}

/// 外部配置合并：其余项取外部文件值，`license_gate` 两字段恒为编译时嵌入值；
/// 外部不一致直接忽略并记 WARN，行为以编译时为准。
fn apply_compiled_license_gate(
    mut external: ProjectConfig,
    compiled: &ProjectConfig,
) -> ProjectConfig {
    if external.license_gate.enabled != compiled.license_gate.enabled
        || external.license_gate.allowed != compiled.license_gate.allowed
    {
        log::warn!(
            "license_gate 运行时覆盖已忽略，以编译时嵌入值为准 (external enabled={} allowed_len={})",
            external.license_gate.enabled,
            external.license_gate.allowed.len()
        );
    }
    external.license_gate = compiled.license_gate.clone();
    external
}

/// 开源协议门禁（`[license_gate]`，ADR-0018）：默认开 + OSI 全量名单（D1 严格不变）；
/// 关闭仅放行本地草稿提交（可审计 WARN），不改变官方生态仓口径。
/// 门禁唯一源为编译时 config（行为由 `config.toml` 在编译发行时确定，无运行时覆盖）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LicenseGateConfig {
    #[serde(default = "default_license_gate_enabled")]
    pub enabled: bool,
    #[serde(default = "default_license_gate_allowed")]
    pub allowed: Vec<String>,
}

fn default_license_gate_enabled() -> bool {
    true
}

fn default_license_gate_allowed() -> Vec<String> {
    DEFAULT_LICENSE_ALLOWLIST
        .iter()
        .map(|s| s.to_string())
        .collect()
}

impl Default for LicenseGateConfig {
    fn default() -> Self {
        Self {
            enabled: default_license_gate_enabled(),
            allowed: default_license_gate_allowed(),
        }
    }
}

impl CatalogConfig {
    /// 解析 catalog.json 的真实有效路径：依据 `config.toml [catalog] local_path`。
    /// 路径存在即返回；不存在即返回 None，由调用方回退编译期内置清单。
    pub fn resolve_local_path(&self) -> Option<std::path::PathBuf> {
        let configured = std::path::Path::new(&self.local_path);
        if configured.is_file() {
            return Some(configured.to_path_buf());
        }

        None
    }

    /// 外部 `config.toml` 载入时把相对 `local_path` 锚定到该文件所在目录：
    /// 配置发现已是绝对路径，`local_path` 随之不再依赖进程 CWD。
    /// 嵌入/默认值不经此处，保持原有 CWD 相对语义。
    fn rebase_local_path(&mut self, config_dir: &std::path::Path) {
        let configured = std::path::Path::new(&self.local_path);
        if configured.is_relative() {
            self.local_path = config_dir
                .join(configured)
                .to_string_lossy()
                .into_owned();
        }
    }

    /// 读取本地收录清单内容：优先使用配置的 local_path 文件；
    /// 文件缺失或为空时使用编译期内置清单。
    pub fn load_catalog_json(&self) -> String {
        if let Some(path) = self.resolve_local_path() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if !content.trim().is_empty() {
                    return content;
                }
            }
        }
        include_str!("../../catalog.json").to_string()
    }

    /// 读取并反序列化本地收录清单应用列表（使用配置的 local_path）
    pub fn load_catalog_items<T: serde::de::DeserializeOwned>(&self) -> Option<Vec<T>> {
        let json = self.load_catalog_json();
        serde_json::from_str(&json).ok()
    }
}

impl Default for ProjectConfig {
    fn default() -> Self {
        let cfg: Self = toml::from_str(EMBEDDED_CONFIG).unwrap_or_else(|e| {
            log::warn!("嵌入 config.toml 解析失败，按节回退编译期默认值: {}", e);
            Self {
                runtime: RuntimeConfig::default(),
                cache: CacheConfig::default(),
                network: NetworkConfig::default(),
                limits: LimitsConfig::default(),
                oauth: OauthConfig::default(),
                catalog: CatalogConfig::default(),
                license_gate: LicenseGateConfig::default(),
            }
        });
        if let Err(msg) = validate_embedded_license_gate(&cfg.license_gate) {
            panic!("{}", msg);
        }
        cfg
    }
}

static GLOBAL_CONFIG: OnceLock<ProjectConfig> = OnceLock::new();

/// 外部 config.toml 候选（全绝对路径，消除 CWD 依赖——同一机器不同工作目录
/// 读到同一份配置）：安装目录随包覆盖优先，其次用户配置目录（与数据目录同域）。
/// 开发期覆写走嵌入文件（`include_str!` 随构建生效）或放置于 target 调试目录。
fn external_config_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
    {
        candidates.push(dir.join("config.toml"));
    }
    candidates.push(crate::resolve_default_app_data_dir().join("config.toml"));
    candidates
}

pub fn get_project_config() -> &'static ProjectConfig {
    GLOBAL_CONFIG.get_or_init(|| {
        let compiled = ProjectConfig::default();
        let candidates = external_config_candidates();
        for path in &candidates {
            if !path.is_file() {
                continue;
            }
            let parsed = std::fs::read_to_string(path)
                .map_err(|e| e.to_string())
                .and_then(|content| {
                    toml::from_str::<ProjectConfig>(&content).map_err(|e| e.to_string())
                });
            match parsed {
                Ok(mut external) => {
                    if let Some(config_dir) = path.parent() {
                        external.catalog.rebase_local_path(config_dir);
                    }
                    log::info!("外部 config.toml 已加载 path={}", path.display());
                    return apply_compiled_license_gate(external, &compiled);
                }
                Err(reason) => {
                    log::warn!(
                        "外部 config.toml 读取/解析失败，跳过 path={} reason={}",
                        path.display(),
                        reason
                    );
                }
            }
        }
        log::debug!(
            "未加载任何外部 config.toml，使用编译期嵌入配置（候选：{}）",
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
        compiled
    })
}

/// 运行错误策略当前值（config.toml 缺失时按构建类型回退）。
pub fn is_strict_errors() -> bool {
    get_project_config().runtime.strict_errors
}

/// 有效超时：取统一配置中枢 `network.api_timeout_seconds`，0 视为未设置用 `fallback`。
pub(crate) fn api_timeout_or(fallback: std::time::Duration) -> std::time::Duration {
    let secs = get_project_config().network.api_timeout_seconds;
    if secs > 0 {
        std::time::Duration::from_secs(secs)
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedded_config_parses_successfully() {
        let conf = ProjectConfig::default();
        assert!(conf.runtime.strict_errors);
        assert_eq!(conf.cache.detail_ttl_minutes, 60);
        assert_eq!(conf.cache.asset_max_mb, 500);
        assert_eq!(conf.cache.asset_max_files, 2000);
        assert_eq!(conf.network.connect_timeout_seconds, 15);
        assert_eq!(conf.network.download_timeout_seconds, 300);
        assert_eq!(conf.network.chunk_timeout_seconds, 30);
        assert_eq!(conf.network.api_timeout_seconds, 12);
        assert_eq!(conf.network.ping_timeout_ms, 4000);
        assert_eq!(conf.limits.search_history_limit, 20);
        assert_eq!(conf.limits.view_history_limit, 30);
        assert_eq!(conf.limits.online_search_page_size, 20);
        assert_eq!(conf.limits.icon_fetch.pool, 5);
        assert_eq!(conf.limits.icon_fetch.total_timeout_secs, 15);
        assert!(!conf.oauth.default_client_id.is_empty());
        assert_eq!(conf.catalog.local_path, "../catalog.json");
        assert!(!conf.catalog.default_source_url.is_empty());
        assert!(conf.catalog.resolve_local_path().is_some());
        let items: Option<Vec<serde_json::Value>> = conf.catalog.load_catalog_items();
        assert!(items.is_some());
        assert!(items.unwrap().len() >= 20);
    }

    #[test]
    fn external_relative_local_path_is_rebased_to_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let mut catalog = CatalogConfig::default();
        catalog.rebase_local_path(dir.path());
        assert_eq!(
            std::path::Path::new(&catalog.local_path),
            dir.path().join("../catalog.json"),
            "相对 local_path 应锚定到 config.toml 所在目录"
        );

        // 绝对路径原样保留。
        let abs = dir.path().join("catalog.json");
        let mut catalog = CatalogConfig {
            local_path: abs.to_string_lossy().into_owned(),
            ..CatalogConfig::default()
        };
        catalog.rebase_local_path(std::path::Path::new("C:\\elsewhere"));
        assert_eq!(catalog.local_path, abs.to_string_lossy());
    }

    #[test]
    fn test_get_project_config_returns_reference() {
        let conf = get_project_config();
        assert_eq!(conf.cache.detail_ttl_minutes, 60);
        assert_eq!(conf.network.api_timeout_seconds, 12);
        assert_eq!(conf.limits.search_history_limit, 20);
    }

    /// 种子 catalog.json schema 校验（构建期，与外部目录仓校验同口径的可执行子集）：
    /// - 先过运行时 serde 模型 `CatalogItem`（字段漂移在此暴露，运行时解析失败前移到测试期）；
    /// - 再锁结构不变量：id 唯一且等于小写 `owner/repo`、展示字段非空、
    ///   platforms/identifiers 键恒在五平台集合内、别名条内唯一且不与 id 重合。
    #[test]
    fn embedded_seed_catalog_matches_runtime_schema() {
        let seed = include_str!("../../catalog.json");
        let items: Vec<crate::github::models::CatalogItem> = serde_json::from_str(seed)
            .expect("种子 catalog.json 必须能反序列化为运行时 CatalogItem 模型");
        assert!(!items.is_empty(), "种子清单不得为空");

        const PLATFORM_KEYS: [&str; 5] = ["windows", "macos", "linux", "ios", "android"];
        let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for item in &items {
            let id_lower = item.id.to_lowercase();
            assert!(
                seen_ids.insert(id_lower.clone()),
                "id 重复：{id_lower}"
            );
            let coord = format!("{}/{}", item.owner, item.repo).to_lowercase();
            assert_eq!(id_lower, coord, "id 必须等于小写 owner/repo：{}", item.id);
            for (field, v) in [
                ("name", &item.name),
                ("description", &item.description),
                ("category", &item.category),
                ("category_name", &item.category_name),
                ("license", &item.license),
                ("default_version", &item.default_version),
            ] {
                assert!(!v.trim().is_empty(), "{id_lower} 的 {field} 不得为空");
            }
            for p in &item.platforms {
                assert!(
                    PLATFORM_KEYS.contains(&p.as_str()),
                    "{id_lower} 平台键越界：{p}"
                );
            }
            for (key, values) in &item.identifiers {
                assert!(
                    PLATFORM_KEYS.contains(&key.as_str()),
                    "{id_lower} identifiers 键越界：{key}"
                );
                assert!(
                    values.iter().all(|v| !v.trim().is_empty()),
                    "{id_lower} identifiers[{key}] 含空串"
                );
            }
            let mut aliases: std::collections::HashSet<String> = std::collections::HashSet::new();
            for alias in &item.aliases {
                let a = alias.trim().to_lowercase();
                assert!(!a.is_empty(), "{id_lower} 存在空别名");
                assert!(a != id_lower, "{id_lower} 别名与 id 重合：{alias}");
                assert!(
                    aliases.insert(a),
                    "{id_lower} 别名条内重复：{alias}"
                );
            }
        }
    }

    #[test]
    fn api_timeout_or_returns_configured_secs() {
        // 返回统一配置中枢 `network.api_timeout_seconds` 对应的超时。
        let expected =
            std::time::Duration::from_secs(get_project_config().network.api_timeout_seconds);
        assert_eq!(super::api_timeout_or(std::time::Duration::from_secs(10)), expected);
        assert_eq!(
            super::api_timeout_or(std::time::Duration::from_millis(1500)),
            expected
        );
    }

    #[test]
    fn icon_fetch_payload_deserializes_pool_and_total_timeout() {
        // IconFetchConfig 契约：仅 `pool` / `total_timeout_secs` 两个字段。
        let payload = r#"
            [limits.icon_fetch]
            pool = 5
            total_timeout_secs = 15
        "#;
        let conf: ProjectConfig =
            toml::from_str(payload).expect("icon_fetch payload must parse");
        assert_eq!(conf.limits.icon_fetch.pool, 5);
        assert_eq!(conf.limits.icon_fetch.total_timeout_secs, 15);
    }

    #[test]
    fn runtime_strict_errors_parses_explicit_value() {
        let conf: ProjectConfig =
            toml::from_str("[runtime]\nstrict_errors = false").expect("runtime payload must parse");
        assert!(!conf.runtime.strict_errors);
    }

    #[test]
    fn runtime_strict_errors_missing_key_falls_back_to_build_default() {
        let conf: ProjectConfig =
            toml::from_str("[cache]\ndetail_ttl_minutes = 60").expect("payload must parse");
        assert_eq!(conf.runtime.strict_errors, cfg!(debug_assertions));
    }

    #[test]
    fn license_allowed_matches_constant_item_by_item() {
        // 运行时源（嵌入 config.toml [license_gate] allowed）与编译期兜底常量
        // 逐项同序同值比对，杜绝静默漂移。
        let conf = ProjectConfig::default();
        assert!(conf.license_gate.enabled);
        let expected: Vec<String> = DEFAULT_LICENSE_ALLOWLIST
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(conf.license_gate.allowed, expected);
    }

    #[test]
    fn license_gate_parses_explicit_disable_and_subset() {
        let conf: ProjectConfig = toml::from_str(
            "[license_gate]\nenabled = false\nallowed = [\"MIT\", \"GPL-3.0\"]",
        )
        .expect("license_gate payload must parse");
        assert!(!conf.license_gate.enabled);
        assert_eq!(conf.license_gate.allowed, vec!["MIT".to_string(), "GPL-3.0".to_string()]);
    }

    #[test]
    fn license_gate_missing_section_falls_back_to_default() {
        let conf: ProjectConfig =
            toml::from_str("[cache]\ndetail_ttl_minutes = 60").expect("payload must parse");
        assert!(conf.license_gate.enabled);
        assert_eq!(conf.license_gate.allowed.len(), 37);
    }

    #[test]
    fn license_gate_empty_or_blank_allowed_fails_validation() {
        // 空名单 / 全空白条目（归一后无有效条目）直接报错，不回退基线。
        let err_msg = "license_gate.allowed 为空/非法，请填OSI名单或显式 enabled=false";
        let gate = LicenseGateConfig {
            enabled: true,
            allowed: vec![],
        };
        assert_eq!(
            validate_embedded_license_gate(&gate).unwrap_err(),
            err_msg
        );
        let gate = LicenseGateConfig {
            enabled: true,
            allowed: vec!["  ".to_string(), String::new()],
        };
        assert_eq!(
            validate_embedded_license_gate(&gate).unwrap_err(),
            err_msg
        );
        // 大小写 / 空格形态经归一仍算有效条目。
        let gate = LicenseGateConfig {
            enabled: true,
            allowed: vec![" mit ".to_string()],
        };
        assert!(validate_embedded_license_gate(&gate).is_ok());
        // 关闭语义不变：空名单也放行。
        let gate = LicenseGateConfig {
            enabled: false,
            allowed: vec![],
        };
        assert!(validate_embedded_license_gate(&gate).is_ok());
    }

    #[test]
    fn embedded_gate_section_scanner_matches_runtime_check() {
        // 当前嵌入配置必须通过编译期扫描（与顶部 const assert 同口径）。
        assert!(embedded_gate_section_valid(EMBEDDED_CONFIG));
        // 开 + 空 / 全空白 → 非法。
        assert!(!embedded_gate_section_valid(
            "[license_gate]\nenabled = true\nallowed = []"
        ));
        assert!(!embedded_gate_section_valid(
            "[license_gate]\nenabled = true\nallowed = [\"  \", \"\"]"
        ));
        // 关 → 放行；缺段 / 缺键 → serde 默认全量，不判错。
        assert!(embedded_gate_section_valid(
            "[license_gate]\nenabled = false\nallowed = []"
        ));
        assert!(embedded_gate_section_valid("[cache]\ndetail_ttl_minutes = 60"));
        assert!(embedded_gate_section_valid("[license_gate]\nenabled = true"));
        assert!(embedded_gate_section_valid(
            "[license_gate]\nenabled = true\nallowed = [\"mit \"]"
        ));
    }

    #[test]
    fn external_license_gate_override_is_ignored() {
        // 外部文件的门禁两字段被编译时嵌入值覆盖，其余项保留外部值。
        let compiled = ProjectConfig::default();
        let external: ProjectConfig = toml::from_str(
            "[cache]\ndetail_ttl_minutes = 5\n[license_gate]\nenabled = false\nallowed = []",
        )
        .expect("payload must parse");
        assert_eq!(external.cache.detail_ttl_minutes, 5);
        let merged = apply_compiled_license_gate(external, &compiled);
        assert_eq!(merged.cache.detail_ttl_minutes, 5);
        assert!(merged.license_gate.enabled);
        assert_eq!(merged.license_gate.allowed.len(), 37);
    }

    #[test]
    fn serde_field_defaults_match_embedded_baseline() {
        // 单一事实源锁（工单 12）：serde 逐字段默认函数与嵌入 config.toml 字面量
        // 逐项相等——外部文件缺字段时落的是与嵌入兜底同源的值，不存在第二套默认值。
        // `strict_errors` 例外：按构建类型回退（cfg!(debug_assertions)）是文档化语义，
        // 与文件字面量刻意不同源。
        let embedded = ProjectConfig::default();
        let baseline = ProjectConfig {
            runtime: RuntimeConfig::default(),
            cache: CacheConfig::default(),
            network: NetworkConfig::default(),
            limits: LimitsConfig::default(),
            oauth: OauthConfig::default(),
            catalog: CatalogConfig::default(),
            license_gate: LicenseGateConfig::default(),
        };
        assert_eq!(baseline.runtime.strict_errors, cfg!(debug_assertions));
        assert_eq!(embedded.cache, baseline.cache);
        assert_eq!(embedded.network, baseline.network);
        assert_eq!(embedded.limits, baseline.limits);
        assert_eq!(embedded.oauth, baseline.oauth);
        assert_eq!(embedded.catalog, baseline.catalog);
        assert_eq!(embedded.license_gate, baseline.license_gate);
    }

    #[test]
    fn embedded_config_toml_declares_every_section() {
        // 逐段存在性锁：默认值回退会让"删段"在相等断言下静默通过，
        // 这里直接锁嵌入文本结构（段存在、license 名单条数、enabled 为布尔）。
        let doc: toml::Value = toml::from_str(EMBEDDED_CONFIG).expect("embedded config must parse");
        for section in [
            "runtime",
            "cache",
            "network",
            "limits",
            "oauth",
            "catalog",
            "license_gate",
        ] {
            assert!(
                doc.get(section).is_some_and(|v| v.is_table()),
                "嵌入 config.toml 缺 [{section}] 段"
            );
        }
        let allowed = doc
            .get("license_gate")
            .and_then(|v| v.get("allowed"))
            .and_then(|v| v.as_array())
            .expect("license_gate.allowed 必须是数组");
        assert_eq!(allowed.len(), 37, "license 白名单条目数漂移");
        assert!(
            doc.get("license_gate")
                .and_then(|v| v.get("enabled"))
                .is_some_and(|v| v.is_bool()),
            "license_gate.enabled 缺失或非布尔"
        );
    }

    #[test]
    fn external_config_candidates_are_absolute_and_cwd_independent() {
        // 候选全为绝对路径（工单 12）：不同工作目录解析到同一份配置。
        let candidates = external_config_candidates();
        assert!(!candidates.is_empty());
        for path in candidates {
            assert!(path.is_absolute(), "{} 应当为绝对路径", path.display());
            assert_eq!(path.file_name().map(|s| s.to_string_lossy()), Some("config.toml".into()));
        }
    }
}
