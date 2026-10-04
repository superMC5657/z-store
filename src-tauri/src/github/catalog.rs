use super::models::{AppRepoCoordinates, CatalogItem};
use super::CatalogService;
use crate::models::AppSummary;
use reqwest::header::{IF_NONE_MATCH, USER_AGENT};
use std::sync::RwLock;

/// 启发式搜索匹配打分权重常量
pub const SEARCH_SCORE_EXACT_MATCH: i32 = 100;
pub const SEARCH_SCORE_PREFIX_MATCH: i32 = 60;
pub const SEARCH_SCORE_NAME_CONTAINS: i32 = 40;
pub const SEARCH_SCORE_ALIAS_CONTAINS: i32 = 35;
pub const SEARCH_SCORE_OWNER_OR_REPO_CONTAINS: i32 = 30;
pub const SEARCH_SCORE_DESC_CONTAINS: i32 = 15;

/// 发现页 Feed 推荐策略（可插拔，hero 置顶留给前端，后端不 hardcode 具体 id）。
/// 打分口径以前端 `src/services/feed.ts` 为 canonical（同形同量级，跨层可比）：
/// - Balanced: `ln(stars+1) + (jitter01-0.5)*0.3`（jitter 半幅 0.15）；
/// - FreshFirst: `jitter01*10 + ln(stars+1)*0.05`（jitter 主导；目录暂无 updated_at 字段，此为近似，换 seed 即换一批）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FeedStrategy {
    /// 纯 stars 降序（确定性默认，供分类/趋势/搜索空态沿用）。
    StarsOnly,
    /// 默认：`ln(stars+1)` 主序 + 轻扰动（±0.15）打散头部垄断。
    #[default]
    Balanced,
    /// 新鲜优先近似：目录暂无 updated_at 字段，用 seed 抖动主导近似“常看常新”
    ///（`jitter01*10 + ln(stars+1)*0.05`，与前端 fresh 同形）；None seed 时回退 stars 降序。
    FreshFirst,
}

/// Feed 轻扰动参数（与前端 `FEED_JITTER_HALF = 0.15` 同形同量级）：
/// Balanced 总摆动 `2 * HALF = 0.3`，只有头部相近星数才会被打散；
/// Fresh 用下方 `FEED_FRESH_*` 权重，jitter 主导。
pub const FEED_JITTER_HALF: f64 = 0.15;
/// Fresh 策略权重（与前端 `fresh` 同形）：jitter 主导 + 星数只给 5% 权重。
pub const FEED_FRESH_JITTER_SCALE: f64 = 10.0;
pub const FEED_FRESH_STARS_WEIGHT: f64 = 0.05;

/// FNV-1a 64 确定性哈希（std 默认 SipHash 随机种子跨进程不稳定，此处必须确定性）。
fn fnv1a64_with_seed(id: &str, seed: u64) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut h = OFFSET ^ seed;
    for b in id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(PRIME);
    }
    // 最终雪崩强化低位区分度
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51afd7ed558ccd);
    h ^= h >> 33;
    h
}

/// 纯函数：给定 id+seed 的确定性抖动，归一到 [0,1)（与前端 `hashSeeded01` 同语义：
/// 同一 (id, seed) 必得同一抖动，换 seed 即换一批；允许 FNV 位宽/雪崩实现不同，
/// 但公式/量级/seed 语义一致）。id 统一小写归一后再哈希，与前端 `toLowerCase` 对齐。
pub fn feed_jitter01(id: &str, seed: u64) -> f64 {
    let lower = id.to_lowercase();
    let h = fnv1a64_with_seed(&lower, seed);
    // 归一到 [0,1)：除以 2^64（前端除以 2^32，同为“哈希全域/模数”语义）。
    (h as f64) / 18446744073709551616.0
}

/// 纯函数：星数基线 `ln(stars+1)`（与前端 `starsBase` 同形；单调性与 stars 一致，取对数压缩头部差距）。
pub fn feed_stars_base(stars: u64) -> f64 {
    ((stars as f64) + 1.0).ln()
}

/// 纯函数：三策略统一 scorer 表（与前端 `feedScorers` 同形同量级，调用方按策略取一行）：
/// - StarsOnly: 纯 `ln(stars+1)`，忽略 jitter/seed；
/// - Balanced: `ln(stars+1) + (jitter01-0.5)*0.3`；
/// - FreshFirst: `jitter01*10 + ln(stars+1)*0.05`（无 updated_at 字段时的 jitter 近似）。
pub fn feed_score(strategy: FeedStrategy, stars: u64, jitter01: f64) -> f64 {
    let base = feed_stars_base(stars);
    match strategy {
        FeedStrategy::StarsOnly => base,
        FeedStrategy::Balanced => base + (jitter01 - 0.5) * FEED_JITTER_HALF * 2.0,
        FeedStrategy::FreshFirst => {
            jitter01 * FEED_FRESH_JITTER_SCALE + base * FEED_FRESH_STARS_WEIGHT
        }
    }
}

/// 纯函数：Feed 排序（可插拔策略）。输入为已过滤的 summaries，不做 hidden 过滤。
/// 口径与前端 `rankFeed` 对齐（canonical 见 `src/services/feed.ts`）：
/// - StarsOnly → 纯 `ln(stars+1)` 降序，忽略 seed；
/// - Balanced + Some(seed) → `ln(stars+1)+(jitter01-0.5)*0.3` 降序；None seed → 纯星数基线降序（向后兼容）；
/// - FreshFirst + Some(seed) → `jitter01*10+ln(stars+1)*0.05` 降序（无 updated_at 字段的近似）；None → 星数基线降序。
/// tie 按 id 升序（后端确定性；前端按入参稳定排序，两端分数同形同量级即可跨层可比）。
pub fn rank_feed_with_strategy(
    items: Vec<AppSummary>,
    seed: Option<u64>,
    strategy: FeedStrategy,
) -> Vec<AppSummary> {
    // 单 scorer 表收敛：先按策略选分，再走同一条 scored-sort 路径（消 Repeated Switches）。
    if strategy == FeedStrategy::StarsOnly || seed.is_none() {
        let mut items = items;
        items.sort_by(|a, b| {
            b.stars
                .cmp(&a.stars)
                .then_with(|| a.id.cmp(&b.id))
        });
        return items;
    }
    let s = seed.unwrap_or(0);
    let mut scored: Vec<(f64, AppSummary)> = items
        .into_iter()
        .map(|app| {
            let jitter = feed_jitter01(&app.id, s);
            let score = feed_score(strategy, app.stars, jitter);
            (score, app)
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.id.cmp(&b.1.id))
    });
    scored.into_iter().map(|(_, app)| app).collect()
}

/// 纯函数：默认 Balanced 的便捷包装（发现页直接用）。
pub fn rank_feed(items: Vec<AppSummary>, seed: Option<u64>) -> Vec<AppSummary> {
    rank_feed_with_strategy(items, seed, FeedStrategy::Balanced)
}

/// 纯函数：分页切片（供 get_home_feed / search_apps 分页复用，边界守好）。
/// 返回 (page_items, total, has_more)，has_more = (offset+limit) < total（saturating）。
pub fn paginate_feed<T: Clone>(items: &[T], limit: usize, offset: usize) -> (Vec<T>, usize, bool) {
    let total = items.len();
    if offset >= total {
        return (Vec::new(), total, false);
    }
    let end = offset.saturating_add(limit).min(total);
    let page = items[offset..end].to_vec();
    let has_more = offset.saturating_add(limit) < total;
    (page, total, has_more)
}

/// P3-3: 当 `url` 为官方默认软件源时返回 true（空字符串同样由调用方视为默认源，并在发起同步前进行解析）。
fn is_default_catalog_source(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return true;
    }
    let default_url = crate::config::get_project_config()
        .catalog
        .default_source_url
        .trim()
        .to_string();
    trimmed == default_url
}

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
            .timeout(std::time::Duration::from_secs(
                cfg.network.api_timeout_seconds,
            ))
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

    /// 按 canonical id 检索收录项（入口统一归一化，库内精确匹配；未知标识直接拒绝）
    pub fn get_catalog_item(&self, id: &str) -> Option<CatalogItem> {
        let key = crate::forge::canonical_app_id(id)?;
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
        let Some(key) = crate::forge::canonical_app_id(id) else {
            return;
        };
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
        // P3-3 信任冲突防范：任何非默认软件源都会静默替换受信任的软件目录，
        // 因此在此处重点记录其来源（设置界面已在危险确认弹窗后方才放行变更）。默认流程保持不变。
        // 未来演进（暂未实现）：受信任源域名白名单 + 签名/清单校验（如已签名的目录数据包）；本阶段暂无签名基础设施。
        if is_default_catalog_source(url) {
            log::info!(
                "sync catalog official default source url='{}'",
                crate::log_support::sanitize_url(url)
            );
        } else {
            log::warn!(
                "sync catalog CUSTOM source url='{}' (non-default, replaces trusted directory)",
                crate::log_support::sanitize_url(url)
            );
        }

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
            log::info!(
                "sync catalog local file='{}' ok items={}",
                clean_path,
                items.len()
            );
            return Ok((Some(items), Some(local_etag)));
        }

        // 远程 HTTP/HTTPS 请求
        let safe_url = crate::log_support::sanitize_url(url);
        let (req_id, sid) = super::http::new_log_ctx();
        let req_host = crate::log_support::host_of(url);
        log::debug!(
            "http fetch catalog sid={} req={} url='{}'",
            sid,
            req_id,
            safe_url
        );
        let start = std::time::Instant::now();

        let mut req = self
            .client
            .get(url)
            .header(USER_AGENT, super::http::GH_USER_AGENT);
        if let Some(etag) = cached_etag {
            req = req.header(IF_NONE_MATCH, etag);
        }
        let resp = req.send().await.map_err(|e| {
            let reason = crate::log_support::short_reason(&e.to_string());
            log::warn!(
                "http fetch catalog failed sid={} req={} host={} reason={}",
                sid,
                req_id,
                req_host,
                reason
            );
            format!("请求收录清单失败: {}", e)
        })?;
        let elapsed = start.elapsed().as_millis();

        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            log::debug!("http fetch catalog resp sid={} req={} url='{}' status=304 not_modified elapsed_ms={}", sid, req_id, safe_url, elapsed);
            log::info!(
                "http resp catalog sid={} req={} host={} status=304 elapsed_ms={}",
                sid,
                req_id,
                req_host,
                elapsed
            );
            return Ok((None, None));
        }
        if !resp.status().is_success() {
            log::warn!(
                "http fetch catalog resp sid={} req={} host={} status={} elapsed_ms={}",
                sid,
                req_id,
                req_host,
                resp.status(),
                elapsed
            );
            return Err(format!("同步收录清单失败，HTTP 状态码: {}", resp.status()));
        }
        let new_etag = resp
            .headers()
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取清单内容失败: {}", e))?;
        let items: Vec<CatalogItem> =
            serde_json::from_str(&text).map_err(|e| format!("解析收录清单 JSON 失败: {}", e))?;
        self.update_items(items.clone());
        log::debug!(
            "http fetch catalog resp sid={} req={} url='{}' status=200 items={} elapsed_ms={}",
            sid,
            req_id,
            safe_url,
            items.len(),
            elapsed
        );
        log::info!(
            "http resp catalog sid={} req={} host={} status=200 items={} elapsed_ms={}",
            sid,
            req_id,
            req_host,
            items.len(),
            elapsed
        );
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
            let desc_lower = item.description.to_lowercase();
            let owner_lower = item.owner.to_lowercase();
            let repo_lower = item.repo.to_lowercase();

            if name_lower == q || id_lower == q {
                score += SEARCH_SCORE_EXACT_MATCH;
            } else if name_lower.starts_with(&q) {
                score += SEARCH_SCORE_PREFIX_MATCH;
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

    /// 分页包装：None=全量（向后兼容，分类/趋势/搜索空态沿用 stars 降序默认），Some 时切 slice（越界守好）。
    /// 注意：hidden 过滤在 command 层做，此处仅对全量 search 结果切片，空查询/非空打分逻辑与 `search_apps` 一致。
    pub fn search_apps_paged(
        &self,
        query: &str,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> Vec<AppSummary> {
        let full = self.search_apps(query);
        match (limit, offset) {
            (None, None) => full,
            _ => {
                let off = offset.unwrap_or(0);
                if off >= full.len() {
                    return Vec::new();
                }
                let end = match limit {
                    Some(l) => off.saturating_add(l).min(full.len()),
                    None => full.len(),
                };
                full[off..end].to_vec()
            }
        }
    }

    /// 解析仓库坐标：收录库内按 canonical id 精确命中；
    /// 目录之外的 GitHub 仓库（在线搜索结果）由统一解析器合成外部坐标（external_synth）。
    /// 未知标识直接拒绝，不再透传。
    pub fn get_repo_coordinates(&self, id: &str) -> Result<AppRepoCoordinates, String> {
        let clean = crate::forge::canonical_app_id(id)
            .ok_or_else(|| format!("无法识别的应用标识: {}", id))?;
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
            // external_synth：在线搜索返回的目录外 GitHub 坐标，现行 search 回退路径，保留
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
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            license: "MIT".to_string(),
            stars: 0,
            forks: 0,
            is_verified: false,
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

    /// ADR-0010：入站标识归一化（canonical = 小写 owner/repo / forge 前缀坐标；未知标识拒绝）
    #[test]
    fn test_canonical_app_id() {
        // canonical id 原样保留（统一小写）
        assert_eq!(
            crate::forge::canonical_app_id("rustdesk/rustdesk").as_deref(),
            Some("rustdesk/rustdesk")
        );
        // 大小写不敏感
        assert_eq!(
            crate::forge::canonical_app_id("RustDesk/RustDesk").as_deref(),
            Some("rustdesk/rustdesk")
        );
        // 完整仓库 URL → canonical
        assert_eq!(
            crate::forge::canonical_app_id("https://github.com/rustdesk/rustdesk").as_deref(),
            Some("rustdesk/rustdesk")
        );
        // gh: 前缀短语法
        assert_eq!(
            crate::forge::canonical_app_id("gh:rustdesk/rustdesk").as_deref(),
            Some("rustdesk/rustdesk")
        );
        // 非 GitHub forge 前缀保持带前缀坐标
        assert_eq!(
            crate::forge::canonical_app_id("codeberg:FreeTubeApp/FreeTube").as_deref(),
            Some("codeberg:freetubeapp/freetube")
        );
        // 未知标识显式拒绝，不再透传
        assert!(crate::forge::canonical_app_id("Unknown-App").is_none());
        // 空输入
        assert!(crate::forge::canonical_app_id("").is_none());
        assert!(crate::forge::canonical_app_id("   ").is_none());
    }

    /// ADR-0010：目录检索入口统一归一化后按 id 唯一精确匹配
    #[test]
    fn test_get_catalog_item_matches_id_only() {
        let svc = test_service(vec![item("rustdesk/rustdesk", "rustdesk", "rustdesk")]);

        assert!(svc.get_catalog_item("rustdesk/rustdesk").is_some());
        assert!(svc.get_catalog_item("RUSTDESK/RUSTDESK").is_some());
        assert!(svc.get_catalog_item("rustdesk").is_none());
        assert!(svc.get_catalog_item("nope").is_none());
    }

    #[test]
    fn test_get_repo_coordinates() {
        let svc = test_service(vec![item("rustdesk/rustdesk", "rustdesk", "rustdesk")]);

        let coords = svc.get_repo_coordinates("rustdesk/rustdesk").unwrap();
        assert_eq!(coords.owner, "rustdesk");
        assert_eq!(coords.repo, "rustdesk");
        // external_synth：目录之外的 owner/repo 坐标（在线搜索结果）合成外部坐标
        let external = svc.get_repo_coordinates("unknown/external").unwrap();
        assert_eq!(external.owner, "unknown");
        assert_eq!(external.repo, "external");
        assert!(svc.get_repo_coordinates("does-not-exist").is_err());
    }

    /// P3-3：默认源与自定义源来源检查（同步日志审计门禁）。
    #[test]
    fn test_is_default_catalog_source() {
        let default_url = crate::config::get_project_config()
            .catalog
            .default_source_url
            .clone();
        assert!(!default_url.trim().is_empty());
        assert!(is_default_catalog_source(""));
        assert!(is_default_catalog_source("   "));
        assert!(is_default_catalog_source(&default_url));
        assert!(!is_default_catalog_source(
            "https://evil.example.com/catalog.json"
        ));
        assert!(!is_default_catalog_source(
            "file:///tmp/custom-catalog.json"
        ));
    }
}
