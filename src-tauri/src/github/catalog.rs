use super::models::{AppRepoCoordinates, CatalogItem};
use super::CatalogService;
use crate::models::AppSummary;
use reqwest::header::{IF_NONE_MATCH, USER_AGENT};
use std::sync::RwLock;

/// 启发式搜索匹配打分权重常量
pub const SEARCH_SCORE_EXACT_MATCH: i32 = 100;
pub const SEARCH_SCORE_PREFIX_MATCH: i32 = 60;
pub const SEARCH_SCORE_CHINESE_CONTAINS: i32 = 50;
pub const SEARCH_SCORE_NAME_CONTAINS: i32 = 40;
pub const SEARCH_SCORE_ALIAS_CONTAINS: i32 = 35;
pub const SEARCH_SCORE_OWNER_OR_REPO_CONTAINS: i32 = 30;
pub const SEARCH_SCORE_DESC_CONTAINS: i32 = 15;

impl Default for CatalogService {
    fn default() -> Self {
        Self::new()
    }
}

impl CatalogService {
    pub fn new() -> Self {
        let cfg = crate::config::get_project_config();
        let items: Vec<CatalogItem> = cfg.catalog.load_catalog_items().unwrap_or_default();
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(10)
            .tcp_keepalive(std::time::Duration::from_secs(60))
            .timeout(std::time::Duration::from_secs(cfg.network.api_timeout_seconds))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            items: RwLock::new(items),
            client,
        }
    }

    pub fn get_catalog_count(&self) -> usize {
        self.items.read().map(|i| i.len()).unwrap_or(0)
    }

    pub fn get_catalog_items(&self) -> Vec<CatalogItem> {
        self.items.read().map(|i| i.clone()).unwrap_or_default()
    }

    /// 按 canonical id 检索收录项（入口统一归一化，库内精确匹配）
    pub fn get_catalog_item(&self, id: &str) -> Option<CatalogItem> {
        let key = crate::forge::canonical_app_id(id);
        self.items
            .read()
            .ok()
            .and_then(|items| items.iter().find(|i| i.id == key).cloned())
    }

    pub fn update_items(&self, new_items: Vec<CatalogItem>) {
        if let Ok(mut lock) = self.items.write() {
            *lock = new_items;
        }
    }

    /// 动态回写并保鲜单个应用的实时统计数据（Stars、Forks、最新版本等）
    pub fn update_catalog_item_stats(
        &self,
        id: &str,
        stars: Option<u64>,
        forks: Option<u64>,
        version: Option<&str>,
    ) {
        let key = crate::forge::canonical_app_id(id);
        if let Ok(mut items) = self.items.write() {
            if let Some(item) = items.iter_mut().find(|i| i.id == key) {
                if let Some(s) = stars {
                    item.stars = s;
                }
                if let Some(f) = forks {
                    item.forks = f;
                }
                if let Some(v) = version {
                    if !v.trim().is_empty() {
                        item.default_version = v.to_string();
                    }
                }
            }
        }
    }

    pub async fn sync_remote_catalog(
        &self,
        url: &str,
        cached_etag: Option<&str>,
    ) -> Result<(Option<Vec<CatalogItem>>, Option<String>), String> {
        let is_local = url.starts_with("file://")
            || (!url.starts_with("http://") && !url.starts_with("https://"));

        if is_local {
            let clean_path = if let Some(stripped) = url.strip_prefix("file://") {
                let trimmed = stripped.trim_start_matches('/');
                if trimmed.len() >= 2 && trimmed.chars().nth(1) == Some(':') {
                    trimmed.to_string()
                } else {
                    stripped.to_string()
                }
            } else {
                url.to_string()
            };

            log::info!("sync catalog loading local file='{}'", clean_path);

            let path = std::path::Path::new(&clean_path);
            if !path.exists() {
                return Err(format!("本地收录清单文件不存在: {}", clean_path));
            }

            let metadata = std::fs::metadata(path)
                .map_err(|e| format!("读取本地收录清单文件元数据失败 ({}): {}", clean_path, e))?;
            let mtime = metadata
                .modified()
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                })
                .unwrap_or(0);
            let local_etag = format!("W/\"local-{}\"", mtime);

            if let Some(etag) = cached_etag {
                if etag == local_etag {
                    log::info!("sync catalog local file='{}' unchanged (304)", clean_path);
                    return Ok((None, None));
                }
            }

            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("读取本地清单内容失败 ({}): {}", clean_path, e))?;
            let items: Vec<CatalogItem> = serde_json::from_str(&text)
                .map_err(|e| format!("解析本地收录清单 JSON 失败: {}", e))?;
            self.update_items(items.clone());
            log::info!("sync catalog local file='{}' ok items={}", clean_path, items.len());
            return Ok((Some(items), Some(local_etag)));
        }

        // 远程 HTTP/HTTPS 请求
        let safe_url = crate::log_support::sanitize_url(url);
        log::info!("http fetch catalog url='{}' etag={:?}", safe_url, cached_etag);
        let start = std::time::Instant::now();

        let mut req = self.client.get(url).header(USER_AGENT, "ZStore-Client/0.1.0");
        if let Some(etag) = cached_etag {
            req = req.header(IF_NONE_MATCH, etag);
        }
        let resp = req.send().await.map_err(|e| {
            let reason = crate::log_support::short_reason(&e.to_string());
            log::warn!("http fetch catalog failed url='{}' reason={}", safe_url, reason);
            format!("请求收录清单失败: {}", e)
        })?;
        let elapsed = start.elapsed().as_millis();

        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            log::info!("http fetch catalog resp url='{}' status=304 not_modified elapsed_ms={}", safe_url, elapsed);
            return Ok((None, None));
        }
        if !resp.status().is_success() {
            log::warn!("http fetch catalog resp url='{}' status={} elapsed_ms={}", safe_url, resp.status(), elapsed);
            return Err(format!("同步收录清单失败，HTTP 状态码: {}", resp.status()));
        }
        let new_etag = resp
            .headers()
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());
        let text = resp.text().await.map_err(|e| format!("读取清单内容失败: {}", e))?;
        let items: Vec<CatalogItem> = serde_json::from_str(&text)
            .map_err(|e| format!("解析收录清单 JSON 失败: {}", e))?;
        self.update_items(items.clone());
        log::info!("http fetch catalog resp url='{}' status=200 items={} elapsed_ms={}", safe_url, items.len(), elapsed);
        Ok((Some(items), new_etag))
    }

    pub fn get_all_summaries(&self) -> Vec<AppSummary> {
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());
        items.iter().map(|item| item.to_summary()).collect()
    }

    pub fn search_apps(&self, query: &str) -> Vec<AppSummary> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            let mut all = self.get_all_summaries();
            all.sort_by_key(|b| std::cmp::Reverse(b.stars));
            return all;
        }

        // 分类过滤匹配
        if let Some(cat_match) = self.filter_by_category(&q) {
            return cat_match;
        }

        let mut matches: Vec<(i32, AppSummary)> = Vec::new();
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());

        for item in items.iter() {
            let mut score = 0;

            let name_lower = item.name.to_lowercase();
            let id_lower = item.id.to_lowercase();
            let zh_lower = item.chinese_name.as_deref().unwrap_or("").to_lowercase();
            let desc_lower = item.description.to_lowercase();
            let owner_lower = item.owner.to_lowercase();
            let repo_lower = item.repo.to_lowercase();

            if name_lower == q || id_lower == q {
                score += SEARCH_SCORE_EXACT_MATCH;
            } else if name_lower.starts_with(&q) {
                score += SEARCH_SCORE_PREFIX_MATCH;
            } else if zh_lower.contains(&q) {
                score += SEARCH_SCORE_CHINESE_CONTAINS;
            } else if name_lower.contains(&q) {
                score += SEARCH_SCORE_NAME_CONTAINS;
            } else if owner_lower.contains(&q) || repo_lower.contains(&q) {
                score += SEARCH_SCORE_OWNER_OR_REPO_CONTAINS;
            } else if item.aliases.iter().any(|a| a.to_lowercase().contains(&q)) {
                score += SEARCH_SCORE_ALIAS_CONTAINS;
            } else if desc_lower.contains(&q) {
                score += SEARCH_SCORE_DESC_CONTAINS;
            }

            if score > 0 {
                matches.push((score, item.to_summary()));
            }
        }

        // 按匹配分值高优先，同分值按 Star 降序
        matches.sort_by(|a, b| {
            if b.0 != a.0 {
                b.0.cmp(&a.0)
            } else {
                b.1.stars.cmp(&a.1.stars)
            }
        });

        matches.into_iter().map(|(_, s)| s).collect()
    }

    pub fn filter_by_category(&self, category: &str) -> Option<Vec<AppSummary>> {
        let cat_clean = category.trim().to_lowercase();
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());
        let matched: Vec<AppSummary> = items
            .iter()
            .filter(|item| {
                item.category.to_lowercase() == cat_clean
                    || item.category_name.to_lowercase() == cat_clean
            })
            .map(|item| item.to_summary())
            .collect();

        if matched.is_empty() {
            None
        } else {
            let mut sorted = matched;
            sorted.sort_by_key(|b| std::cmp::Reverse(b.stars));
            Some(sorted)
        }
    }

    /// 解析仓库坐标：收录库内按 canonical id 精确命中；
    /// 目录之外的 GitHub 仓库（在线搜索结果）由统一解析器合成坐标。
    pub fn get_repo_coordinates(&self, id: &str) -> Result<AppRepoCoordinates, String> {
        let clean = crate::forge::canonical_app_id(id);
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = items.iter().find(|i| i.id == clean) {
            Ok(AppRepoCoordinates {
                owner: item.owner.clone(),
                repo: item.repo.clone(),
                name: item.name.clone(),
                description: item.description.clone(),
                icon: item.icon.clone(),
                icon_bg: item.icon_bg.clone(),
            })
        } else if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean) {
            if coord.forge == crate::forge::ForgeType::GitHub {
                Ok(AppRepoCoordinates {
                    owner: coord.owner,
                    name: coord.repo.clone(),
                    repo: coord.repo,
                    description: "GitHub 社区开源项目".to_string(),
                    icon: String::new(),
                    icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
                })
            } else {
                Err(format!("未识别的仓库坐标: {}", id))
            }
        } else {
            Err(format!("收录库中不存在该应用: {}", id))
        }
    }

    pub fn get_endpoints(
        &self,
        id: &str,
    ) -> Result<(String, String, String, String, String, String), String> {
        let coords = self.get_repo_coordinates(id)?;
        Ok((
            coords.owner,
            coords.repo,
            coords.name,
            coords.description,
            coords.icon,
            coords.icon_bg,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn item(id: &str, owner: &str, repo: &str) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            name: "Test App".to_string(),
            chinese_name: None,
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            license: "MIT".to_string(),
            stars: 0,
            forks: 0,
            is_verified: false,
            publisher_fingerprint: None,
            homepage: None,
            identifiers: HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec!["windows".to_string()],
        }
    }

    fn test_service(items: Vec<CatalogItem>) -> CatalogService {
        CatalogService {
            items: RwLock::new(items),
            client: reqwest::Client::new(),
        }
    }

    /// ADR-0010：入站标识归一化（canonical = 小写 owner/repo / forge 前缀坐标）
    #[test]
    fn test_canonical_app_id() {
        // canonical id 原样保留（统一小写）
        assert_eq!(
            crate::forge::canonical_app_id("rustdesk/rustdesk"),
            "rustdesk/rustdesk"
        );
        // 大小写不敏感
        assert_eq!(
            crate::forge::canonical_app_id("RustDesk/RustDesk"),
            "rustdesk/rustdesk"
        );
        // 完整仓库 URL → canonical
        assert_eq!(
            crate::forge::canonical_app_id("https://github.com/rustdesk/rustdesk"),
            "rustdesk/rustdesk"
        );
        // gh: 前缀短语法
        assert_eq!(
            crate::forge::canonical_app_id("gh:rustdesk/rustdesk"),
            "rustdesk/rustdesk"
        );
        // 非 GitHub forge 前缀保持带前缀坐标
        assert_eq!(
            crate::forge::canonical_app_id("codeberg:FreeTubeApp/FreeTube"),
            "codeberg:freetubeapp/freetube"
        );
        // 未知标识原样小写兜底
        assert_eq!(crate::forge::canonical_app_id("Unknown-App"), "unknown-app");
        // 空输入
        assert_eq!(crate::forge::canonical_app_id(""), "");
        assert_eq!(crate::forge::canonical_app_id("   "), "");
    }

    /// ADR-0010：目录检索入口统一归一化后按 id 唯一精确匹配
    #[test]
    fn test_get_catalog_item_matches_id_only() {
        let svc = test_service(vec![item(
            "rustdesk/rustdesk",
            "rustdesk",
            "rustdesk",
        )]);

        assert!(svc.get_catalog_item("rustdesk/rustdesk").is_some());
        assert!(svc.get_catalog_item("RUSTDESK/RUSTDESK").is_some());
        assert!(svc.get_catalog_item("rustdesk").is_none());
        assert!(svc.get_catalog_item("nope").is_none());
    }

    #[test]
    fn test_get_repo_coordinates() {
        let svc = test_service(vec![item(
            "rustdesk/rustdesk",
            "rustdesk",
            "rustdesk",
        )]);

        let coords = svc.get_repo_coordinates("rustdesk/rustdesk").unwrap();
        assert_eq!(coords.owner, "rustdesk");
        assert_eq!(coords.repo, "rustdesk");
        // 目录之外的 owner/repo 坐标（在线搜索结果）合成兜底
        let external = svc.get_repo_coordinates("unknown/external").unwrap();
        assert_eq!(external.owner, "unknown");
        assert_eq!(external.repo, "external");
        assert!(svc.get_repo_coordinates("does-not-exist").is_err());
    }
}
