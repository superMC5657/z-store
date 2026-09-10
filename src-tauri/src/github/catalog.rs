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

    pub fn get_catalog_item(&self, id: &str) -> Option<CatalogItem> {
        self.items.read().ok().and_then(|items| {
            items
                .iter()
                .find(|i| {
                    i.id.eq_ignore_ascii_case(id)
                        || format!("{}/{}", i.owner, i.repo).eq_ignore_ascii_case(id)
                })
                .cloned()
        })
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
        if let Ok(mut items) = self.items.write() {
            if let Some(item) = items.iter_mut().find(|i| {
                i.id.eq_ignore_ascii_case(id)
                    || format!("{}/{}", i.owner, i.repo).eq_ignore_ascii_case(id)
            }) {
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
                    return Ok((None, None));
                }
            }

            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("读取本地清单内容失败 ({}): {}", clean_path, e))?;
            let items: Vec<CatalogItem> = serde_json::from_str(&text)
                .map_err(|e| format!("解析本地收录清单 JSON 失败: {}", e))?;
            self.update_items(items.clone());
            return Ok((Some(items), Some(local_etag)));
        }

        // 远程 HTTP/HTTPS 请求
        let mut req = self.client.get(url).header(USER_AGENT, "ZStore-Client/0.1.0");
        if let Some(etag) = cached_etag {
            req = req.header(IF_NONE_MATCH, etag);
        }
        let resp = req.send().await.map_err(|e| format!("请求收录清单失败: {}", e))?;
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            // 清单未变动
            return Ok((None, None));
        }
        if !resp.status().is_success() {
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

    pub fn get_repo_coordinates(&self, id: &str) -> Result<AppRepoCoordinates, String> {
        let clean = id.trim().to_lowercase();
        let items = self.items.read().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = items.iter().find(|i| i.id.to_lowercase() == clean) {
            Ok(AppRepoCoordinates {
                owner: item.owner.clone(),
                repo: item.repo.clone(),
                name: item.name.clone(),
                description: item.description.clone(),
                icon: item.icon.clone(),
                icon_bg: item.icon_bg.clone(),
            })
        } else if id.contains('/') {
            let parts: Vec<&str> = id.split('/').collect();
            if parts.len() == 2 {
                let owner = parts[0].trim().to_string();
                let repo = parts[1].trim().to_string();
                let name = repo.clone();
                Ok(AppRepoCoordinates {
                    owner,
                    repo,
                    name,
                    description: "GitHub 社区开源项目".to_string(),
                    icon: "📦".to_string(),
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
