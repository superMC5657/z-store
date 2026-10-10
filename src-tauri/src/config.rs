use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const EMBEDDED_CONFIG: &str = include_str!("../config.toml");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfig {
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    #[serde(default = "default_detail_ttl_minutes")]
    pub detail_ttl_minutes: i64,
}

fn default_detail_ttl_minutes() -> i64 {
    30
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            detail_ttl_minutes: default_detail_ttl_minutes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
/// 默认：`pool=5 / total_timeout_secs=15 / compat_collect=true`。
/// 快慢超时经 `network.api_timeout_seconds` 统一配置；整批总量按页伸缩。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct IconFetchConfig {
    #[serde(default = "default_icon_fetch_pool")]
    pub pool: usize,
    #[serde(default = "default_icon_fetch_total_timeout_secs")]
    pub total_timeout_secs: u64,
    #[serde(default = "default_icon_fetch_compat_collect")]
    pub compat_collect: bool,
}

fn default_icon_fetch_pool() -> usize {
    5
}
fn default_icon_fetch_total_timeout_secs() -> u64 {
    15
}
fn default_icon_fetch_compat_collect() -> bool {
    true
}

impl Default for IconFetchConfig {
    fn default() -> Self {
        Self {
            pool: default_icon_fetch_pool(),
            total_timeout_secs: default_icon_fetch_total_timeout_secs(),
            compat_collect: default_icon_fetch_compat_collect(),
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
    12
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OauthConfig {
    #[serde(default = "default_oauth_client_id")]
    pub default_client_id: String,
}

fn default_oauth_client_id() -> String {
    String::new()
}

impl Default for OauthConfig {
    fn default() -> Self {
        Self {
            default_client_id: default_oauth_client_id(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    "https://gh-proxy.com/https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json".to_string()
}

impl Default for CatalogConfig {
    fn default() -> Self {
        Self {
            local_path: default_local_path(),
            default_source_url: default_source_url(),
        }
    }
}

impl CatalogConfig {
    /// 解析 catalog.json 的真实有效路径：唯一依据 `config.toml [catalog] local_path`。
    /// 配置路径存在即返回；不存在即返回 None，由调用方回退编译期内置清单。
    pub fn resolve_local_path(&self) -> Option<std::path::PathBuf> {
        let configured = std::path::Path::new(&self.local_path);
        if configured.is_file() {
            return Some(configured.to_path_buf());
        }

        None
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
        toml::from_str(EMBEDDED_CONFIG).unwrap_or_else(|_| Self {
            cache: CacheConfig::default(),
            network: NetworkConfig::default(),
            limits: LimitsConfig::default(),
            oauth: OauthConfig::default(),
            catalog: CatalogConfig::default(),
        })
    }
}

static GLOBAL_CONFIG: OnceLock<ProjectConfig> = OnceLock::new();

pub fn get_project_config() -> &'static ProjectConfig {
    GLOBAL_CONFIG.get_or_init(|| {
        let external_candidates = [
            std::path::PathBuf::from("config.toml"),
            std::path::PathBuf::from("src-tauri/config.toml"),
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|dir| dir.join("config.toml")))
                .unwrap_or_default(),
        ];

        for path in &external_candidates {
            if path.is_file() {
                if let Ok(content) = std::fs::read_to_string(path) {
                    if let Ok(parsed) = toml::from_str::<ProjectConfig>(&content) {
                        return parsed;
                    }
                }
            }
        }

        ProjectConfig::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedded_config_parses_successfully() {
        let conf = ProjectConfig::default();
        assert_eq!(conf.cache.detail_ttl_minutes, 30);
        assert_eq!(conf.network.connect_timeout_seconds, 15);
        assert_eq!(conf.network.download_timeout_seconds, 300);
        assert_eq!(conf.network.chunk_timeout_seconds, 30);
        assert_eq!(conf.network.api_timeout_seconds, 12);
        assert_eq!(conf.network.ping_timeout_ms, 4000);
        assert_eq!(conf.limits.search_history_limit, 20);
        assert_eq!(conf.limits.view_history_limit, 30);
        assert_eq!(conf.limits.online_search_page_size, 12);
        assert_eq!(conf.limits.icon_fetch.pool, 5);
        assert_eq!(conf.limits.icon_fetch.total_timeout_secs, 15);
        assert!(conf.limits.icon_fetch.compat_collect);
        assert!(!conf.oauth.default_client_id.is_empty());
        assert_eq!(conf.catalog.local_path, "../catalog.json");
        assert!(!conf.catalog.default_source_url.is_empty());
        assert!(conf.catalog.resolve_local_path().is_some());
        let items: Option<Vec<serde_json::Value>> = conf.catalog.load_catalog_items();
        assert!(items.is_some());
        assert!(items.unwrap().len() >= 20);
    }

    #[test]
    fn test_get_project_config_returns_reference() {
        let conf = get_project_config();
        assert_eq!(conf.cache.detail_ttl_minutes, 30);
        assert_eq!(conf.network.api_timeout_seconds, 12);
        assert_eq!(conf.limits.search_history_limit, 20);
    }
}
