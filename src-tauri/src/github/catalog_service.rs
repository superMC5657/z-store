use super::catalog_feed_score::*;
use crate::github::models::{AppRepoCoordinates, CatalogItem};
use crate::github::CatalogService;
use crate::models::AppSummary;
use reqwest::header::{IF_NONE_MATCH, USER_AGENT};
use std::sync::RwLock;

/// 目录来源标记：远端精选收录库行。
pub const CATALOG_SOURCE_REMOTE: &str = "remote";
/// 目录来源标记：本地收录（`custom_apps` collected 系）补位行。
pub const CATALOG_SOURCE_LOCAL: &str = "local";

/// 当 `url` 为官方默认软件源时返回 true（空字符串同样由调用方视为默认源，并在发起同步前进行解析）。
pub(crate) fn is_default_catalog_source(url: &str) -> bool {
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
        // 清单跟随系统代理：不再把默认源 host 塞进 per-client no_proxy，
        // 有代理走代理、无代理直连（与图标通道一致）。
        let catalog_extra: Vec<String> = Vec::new();
        let builder = reqwest::Client::builder()
            .pool_max_idle_per_host(10)
            .tcp_keepalive(std::time::Duration::from_secs(60))
            .timeout(std::time::Duration::from_secs(
                cfg.network.api_timeout_seconds,
            ));
        let client = crate::proxy::apply_proxy(builder, &catalog_extra)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            items: RwLock::new(items),
            collected: RwLock::new(Vec::new()),
            client,
        }
    }

    pub fn get_catalog_count(&self) -> usize {
        self.items.read().map(|i| i.len()).unwrap_or(0)
    }

    /// 远端精选目录本体（不含本地收录 overlay）：转正判定与目录计数口径。
    pub fn get_remote_catalog_items(&self) -> Vec<CatalogItem> {
        self.items.read().map(|i| i.clone()).unwrap_or_default()
    }

    /// 合并目录（远端在前，本地收录按 id 补位去重）：全站收录视图唯一来源。
    pub fn get_catalog_items(&self) -> Vec<CatalogItem> {
        let remote = self.get_remote_catalog_items();
        let collected = self
            .collected
            .read()
            .map(|c| c.clone())
            .unwrap_or_default();
        let mut seen: std::collections::HashSet<String> =
            remote.iter().map(|i| i.id.clone()).collect();
        let mut out = remote;
        for item in collected {
            if seen.insert(item.id.clone()) {
                out.push(item);
            }
        }
        out
    }

    /// 本地库 overlay 同步（启动与 `custom_apps` 每次变更后调用）：
    /// 输入须已过滤为未归档的 collected 系/`submitted`，库内保存原始 payload。
    pub fn set_collected_items(&self, items: Vec<CatalogItem>) {
        if let Ok(mut lock) = self.collected.write() {
            *lock = items;
        }
    }

    /// 从 SQLite `custom_apps` 重读本地库 overlay（最佳努力，失败即保持现值）。
    pub fn sync_collected_from_db(&self, db: &crate::db::Database) {
        if let Ok(items) = db.list_local_library_items() {
            self.set_collected_items(items);
        }
    }

    /// 按 canonical id 检索远端收录项（入口统一归一化，库内精确匹配；未知标识直接拒绝）。
    pub fn get_remote_catalog_item(&self, id: &str) -> Option<CatalogItem> {
        let key = crate::forge::canonical_app_id(id)?;
        self.items
            .read()
            .ok()
            .and_then(|items| items.iter().find(|i| i.id == key).cloned())
    }

    /// 本地库 overlay 全量（collected 系/`submitted` 且未归档）。
    pub fn get_collected_items(&self) -> Vec<CatalogItem> {
        self.collected.read().map(|c| c.clone()).unwrap_or_default()
    }

    /// 按 canonical id 检索本地库项（collected 系/`submitted` 且未归档）。
    pub fn get_collected_item(&self, id: &str) -> Option<CatalogItem> {
        let key = crate::forge::canonical_app_id(id)?;
        self.collected
            .read()
            .ok()
            .and_then(|items| items.iter().find(|i| i.id == key).cloned())
    }

    /// 本地收录命中判定（canonical 归一，零网络）。
    pub fn is_collected_id(&self, id: &str) -> bool {
        self.get_collected_item(id).is_some()
    }

    /// 目录项检索唯一口：远端精确命中优先，其次本地收录补位。
    pub fn get_catalog_item(&self, id: &str) -> Option<CatalogItem> {
        self.get_remote_catalog_item(id)
            .or_else(|| self.get_collected_item(id))
    }

    /// 收录成员判定唯一口（写时标记/启动回填/图标分流共用）：远端或本地收录均视为已收录。
    pub fn is_cataloged(&self, id: &str) -> bool {
        self.get_catalog_item(id).is_some()
    }

    /// 收录态决议（盖章唯一口径）：返回 `(is_cataloged, source, status)`。
    /// - 远端已验证 → `remote`（蓝标优先，本地同 id 不降级）；
    /// - 本地收录（含远端未验证同仓补位）→ `local` + `status=collected`；
    /// - 远端未验证且无本地收录 → `remote`；
    /// - 均未命中 → `is_cataloged=false`（来源缺席）。
    fn resolve_catalog_stamp(
        &self,
        id: &str,
    ) -> (bool, Option<String>, Option<String>) {
        let remote = self.get_remote_catalog_item(id);
        let is_collected = self.is_collected_id(id);
        let remote_verified = remote.as_ref().map(|i| i.is_verified).unwrap_or(false);
        if remote.is_some() && (remote_verified || !is_collected) {
            (true, Some(CATALOG_SOURCE_REMOTE.to_string()), None)
        } else if is_collected {
            (
                true,
                Some(CATALOG_SOURCE_LOCAL.to_string()),
                Some(crate::db::custom_apps::CUSTOM_APP_STATUS_COLLECTED.to_string()),
            )
        } else {
            (false, None, None)
        }
    }

    /// 收录态盖章（`AppSummary` 投影唯一口）。
    pub fn stamp_summary(&self, summary: &mut AppSummary) {
        let (cataloged, source, status) = self.resolve_catalog_stamp(&summary.id);
        summary.is_cataloged = Some(cataloged);
        summary.source = source;
        summary.status = status;
    }

    /// 收录态盖章（`AppDetail` 投影唯一口，口径与 `stamp_summary` 一致）。
    pub fn stamp_detail(&self, detail: &mut crate::models::AppDetail) {
        let (cataloged, source, status) = self.resolve_catalog_stamp(&detail.id);
        detail.is_cataloged = Some(cataloged);
        detail.source = source;
        detail.status = status;
    }

    /// 目录项转已盖章摘要（列表/详情/搜索统一投影）。
    pub fn item_to_stamped_summary(&self, item: &CatalogItem) -> AppSummary {
        let mut summary = item.to_summary();
        self.stamp_summary(&mut summary);
        summary
    }

    /// 合并目录全量已盖章摘要（首页/分类/搜索共用）。
    pub fn merged_summaries(&self) -> Vec<AppSummary> {
        self.get_catalog_items()
            .iter()
            .map(|item| self.item_to_stamped_summary(item))
            .collect()
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

    pub async fn fetch_remote_catalog(
        &self,
        url: &str,
        cached_etag: Option<&str>,
    ) -> Result<(Option<Vec<CatalogItem>>, Option<String>), String> {
        // 信任冲突防范：任何非默认软件源都会静默替换受信任的软件目录，
        // 因此在此处重点记录其来源（设置界面已在危险确认弹窗后方才放行变更）。
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
        let (req_id, sid) = crate::github::http::new_log_ctx();
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
            .header(USER_AGENT, crate::github::http::GH_USER_AGENT);
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

    /// 本地库 overlay 唯一口径：未归档的 collected 系 + `submitted` 行参与合并。
    /// 调用方须先经 `db::custom_apps::list_local_library_*` 或 `collected_overlay_items` 过滤；
    /// 本函数不做状态判断，仅执行远端优先去重合并（`catalog.json` 只读禁写回，
    /// 合并不写回内存 `items`，转正由退役标记处理）。
    pub fn is_collected_overlay_status(status: &str, archived: bool) -> bool {
        crate::db::custom_apps::is_local_library_status(status) && !archived
    }

    /// 本地库 overlay 合并（ADR-0017）：本地库条目叠加到内存目录视图。
    /// - 输入 `custom` 调用方须已过滤为本地库（collected 系/`submitted` 且未归档）；
    /// - 远端优先去重：远端 id 已存在时 custom 同 id 条目丢弃，不覆盖；
    /// - `is_cataloged` 恒 true（视图内即视为已收录），来源经 `source` 区分
    ///  （`remote` / `custom`），调用方按需展示“自维护”角标；
    /// - 纯合并视图，不写回内存 `items`（吸入远端以上游同步为准，转正由退役标记处理）。
    pub fn merge_catalog_overlay_view(
        remote: &[CatalogItem],
        custom: &[CatalogItem],
    ) -> Vec<MergedCatalogEntry> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::with_capacity(remote.len() + custom.len());
        for item in remote {
            seen.insert(item.id.clone());
            out.push(MergedCatalogEntry {
                summary: item.to_summary(),
                source: CatalogEntrySource::Remote.as_str().to_string(),
                is_cataloged: true,
            });
        }
        for item in custom {
            if seen.insert(item.id.clone()) {
                out.push(MergedCatalogEntry {
                    summary: item.to_summary(),
                    source: CatalogEntrySource::Custom.as_str().to_string(),
                    is_cataloged: true,
                });
            }
        }
        out
    }

    /// 内存目录 + 本地库 custom 的合并条目（远端优先，custom 补位）。
    /// 调用方传入的 `custom` 须已过滤为本地库（collected 系/`submitted` 且未归档）。
    pub fn merged_items_with_overlay(&self, custom: Vec<CatalogItem>) -> Vec<CatalogItem> {
        let remote = self.get_catalog_items();
        let mut seen: std::collections::HashSet<String> =
            remote.iter().map(|i| i.id.clone()).collect();
        let mut out = remote;
        for item in custom {
            if seen.insert(item.id.clone()) {
                out.push(item);
            }
        }
        out
    }

    pub fn search_apps(&self, query: &str) -> Vec<AppSummary> {
        let items = self.get_catalog_items();
        self.search_in_slice(&items, query)
    }

    /// 本地库叠加搜索（与 `search_apps` 同行为）：`extra` 须已过滤为
    /// 本地库（collected 系/`submitted` 且未归档），远端优先去重后同分值同排序执行搜索。
    pub fn search_apps_with_overlay(
        &self,
        query: &str,
        extra: &[CatalogItem],
    ) -> Vec<AppSummary> {
        let merged = self.merged_items_with_overlay(extra.to_vec());
        self.search_in_slice(&merged, query)
    }

    fn search_in_slice(&self, items: &[CatalogItem], query: &str) -> Vec<AppSummary> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            let mut all: Vec<AppSummary> = items
                .iter()
                .map(|i| self.item_to_stamped_summary(i))
                .collect();
            all.sort_by_key(|b| std::cmp::Reverse(b.stars));
            return all;
        }

        // 分类过滤匹配
        if let Some(cat_match) = self.filter_in_slice(items, &q) {
            return cat_match;
        }

        let mut matches: Vec<(i32, AppSummary)> = Vec::new();

        for item in items.iter() {
            let mut score = 0;

            let name_lower = item.name.to_lowercase();
            let id_lower = item.id.to_lowercase();
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
            }

            if score > 0 {
                matches.push((score, self.item_to_stamped_summary(item)));
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
        let items = self.get_catalog_items();
        self.filter_in_slice(&items, category)
    }

    fn filter_in_slice(&self, items: &[CatalogItem], category: &str) -> Option<Vec<AppSummary>> {
        let cat_clean = category.trim().to_lowercase();
        let matched: Vec<AppSummary> = items
            .iter()
            .filter(|item| {
                item.category.to_lowercase() == cat_clean
                    || item.category_name.to_lowercase() == cat_clean
            })
            .map(|item| self.item_to_stamped_summary(item))
            .collect();

        if matched.is_empty() {
            None
        } else {
            let mut sorted = matched;
            sorted.sort_by_key(|b| std::cmp::Reverse(b.stars));
            Some(sorted)
        }
    }

    /// 轻量 deduce（`get_platforms_lite` 通道 SSOT）：GitHub release 原始资产 → deduce + 收录库 ios 并集 + 排序。
    /// 空推导明确返回空向量，不做任何兜底；`platforms/valid-asset/sort` 真相源在 `detail_assets`。
    pub(crate) fn deduce_lite_platforms(
        &self,
        id: &str,
        assets: &[crate::github::models::GitHubAssetResponse],
    ) -> Vec<String> {
        let catalog_platforms = self.get_catalog_item(id).map(|i| i.platforms);
        crate::github::detail_assets::lite_platforms_for_github_assets(
            assets,
            catalog_platforms.as_deref(),
        )
    }

    /// 解析仓库坐标：收录库内按 canonical id 精确命中；
    /// 目录之外的 GitHub 仓库（在线搜索结果）由统一解析器合成外部坐标（external_synth）。
    /// 未知标识直接拒绝，不透传。
    pub fn get_repo_coordinates(&self, id: &str) -> Result<AppRepoCoordinates, String> {
        let clean = crate::forge::canonical_app_id(id)
            .ok_or_else(|| format!("无法识别的应用标识: {}", id))?;
        if let Some(item) = self.get_catalog_item(&clean) {
            Ok(AppRepoCoordinates {
                owner: item.owner.clone(),
                repo: item.repo.clone(),
                name: item.name.clone(),
                description: item.description.clone(),
                icon: item.icon.clone(),
                icon_bg: item.icon_bg.clone(),
            })
        } else if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean) {
            // external_synth：在线搜索返回的目录外 GitHub 坐标（search 回退路径）
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

/// 合并视图条目来源：远端精选收录 vs 本地自维护草稿（ADR-0017）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogEntrySource {
    Remote,
    Custom,
}

impl CatalogEntrySource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Remote => "remote",
            Self::Custom => "custom",
        }
    }
}

/// 合并目录视图行：`AppSummary` 扁平展开 + 来源标记。
/// `is_cataloged` 恒 true（视图内即视为已收录）；custom 行由 `source=custom` 区分，
/// 前端按需展示“自维护”角标。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MergedCatalogEntry {
    #[serde(flatten)]
    pub summary: AppSummary,
    pub source: String,
    pub is_cataloged: bool,
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
            platforms: Vec::new(),
        }
    }

    fn test_service(items: Vec<CatalogItem>) -> CatalogService {
        CatalogService {
            items: RwLock::new(items),
            collected: RwLock::new(Vec::new()),
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
        // 未知标识显式拒绝
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

    /// 默认源与自定义源来源检查（同步日志审计门禁）。
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

    /// ADR-0017：overlay 合并远端优先去重（同 id 取远端行，custom 仅补位；来源标记可分）。
    #[test]
    fn test_merge_catalog_overlay_remote_first() {
        let remote = vec![item("o/dup", "o", "dup"), item("o/remote", "o", "remote")];
        let mut dup_custom = item("o/dup", "o", "dup");
        dup_custom.name = "Custom Shadow".to_string();
        let custom = vec![dup_custom, item("o/local", "o", "local")];

        let view = CatalogService::merge_catalog_overlay_view(&remote, &custom);
        assert_eq!(view.len(), 3);
        // 同 id 取远端行（custom 影子被丢弃）。
        let dup = view.iter().find(|e| e.summary.id == "o/dup").unwrap();
        assert_eq!(dup.summary.name, "Test App");
        assert_eq!(dup.source, "remote");
        assert!(dup.is_cataloged);
        // custom 补位行标记来源。
        let local = view.iter().find(|e| e.summary.id == "o/local").unwrap();
        assert_eq!(local.source, "custom");
        assert!(local.is_cataloged);
        // 顺序：远端在前，custom 补位在后。
        assert_eq!(view[0].summary.id, "o/dup");
        assert_eq!(view[2].summary.id, "o/local");

        let svc = test_service(remote);
        let merged = svc.merged_items_with_overlay(custom);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].name, "Test App");
    }

    /// 本地库 overlay 口径：collected 系 + `submitted` 且未归档参与合并。
    #[test]
    fn test_collected_overlay_status_gate() {
        assert!(CatalogService::is_collected_overlay_status("collected", false));
        assert!(CatalogService::is_collected_overlay_status("submitted", false));
        assert!(!CatalogService::is_collected_overlay_status("draft", false));
        assert!(!CatalogService::is_collected_overlay_status("submitted", true));
        assert!(!CatalogService::is_collected_overlay_status("collected", true));
        assert_eq!(
            crate::db::custom_apps::CUSTOM_APP_STATUS_COLLECTED,
            "collected"
        );
    }

    /// overlay 叠加搜索与远端同行为：本地收录可搜，远端优先去重。
    #[test]
    fn test_search_with_overlay_finds_local() {
        let svc = test_service(vec![item("o/remote", "o", "remote")]);
        let mut local = item("o/local", "o", "local");
        local.name = "Local Tool".to_string();
        let hits = svc.search_apps_with_overlay("local", &[local.clone()]);
        assert!(hits.iter().any(|s| s.id == "o/local"));
        // 空查询含本地（stars 降序全量）。
        let all = svc.search_apps_with_overlay("", &[local]);
        assert_eq!(all.len(), 2);
    }

    /// 本地收录 overlay 并入统一目录：检索/收录判定/坐标/搜索均命中。
    #[test]
    fn test_collected_overlay_joins_catalog_interface() {
        let svc = test_service(vec![item("o/remote", "o", "remote")]);
        let mut local = item("o/local", "o", "local");
        local.name = "Local Tool".to_string();
        svc.set_collected_items(vec![local]);

        assert!(svc.is_cataloged("o/local"));
        assert!(svc.is_collected_id("O/LOCAL"));
        assert_eq!(
            svc.get_catalog_item("o/local").map(|i| i.name),
            Some("Local Tool".to_string())
        );
        // 远端优先：同 id 命中的是远端行。
        assert_eq!(
            svc.get_catalog_item("o/remote").map(|i| i.name),
            Some("Test App".to_string())
        );
        // 坐标回退命中本地收录（未知标识仍拒绝）。
        let coords = svc.get_repo_coordinates("o/local").expect("local coords");
        assert_eq!(coords.name, "Local Tool");
        // 搜索覆盖合并目录。
        let hits = svc.search_apps("local tool");
        assert!(hits.iter().any(|s| s.id == "o/local"));
        // 远端本体口径不含本地收录。
        assert_eq!(svc.get_remote_catalog_items().len(), 1);
        assert_eq!(svc.get_catalog_items().len(), 2);
    }

    /// overlay 来源：`sync_collected_from_db` 后合并目录含本地收录，
    /// 远端本体口径仍不含（scanner/detail/installer 走合并目录）。
    #[test]
    fn test_sync_collected_from_db_feeds_merged_catalog_only() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let mut local = item("o/local", "o", "local");
        local.name = "Local Tool".to_string();
        local.description = "a local tool".to_string();
        local.homepage = Some("https://example.com/local".to_string());
        db.upsert_custom_app_payload(&local).unwrap();
        db.mark_custom_app_collected("o/local").unwrap();

        let svc = test_service(vec![item("o/remote", "o", "remote")]);
        // 同步前 overlay 为空：合并目录只有远端行。
        assert!(svc.get_catalog_item("o/local").is_none());
        svc.sync_collected_from_db(&db);

        assert_eq!(
            svc.get_catalog_item("o/local").map(|i| i.name),
            Some("Local Tool".to_string())
        );
        assert_eq!(svc.get_catalog_items().len(), 2);
        assert!(svc.get_catalog_items().iter().any(|i| i.id == "o/local"));
        // 远端本体口径不含本地收录。
        assert_eq!(svc.get_remote_catalog_items().len(), 1);
        assert!(!svc
            .get_remote_catalog_items()
            .iter()
            .any(|i| i.id == "o/local"));
    }

    /// submitted 仍在本地库：sync 后并入合并目录，收藏/关注 `is_cataloged` 保持 true。
    #[test]
    fn test_sync_collected_from_db_includes_submitted() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let mut local = item("o/pending", "o", "pending");
        local.name = "Pending Issue Tool".to_string();
        local.description = "awaiting upstream merge".to_string();
        local.homepage = Some("https://example.com/pending".to_string());
        db.upsert_custom_app_payload(&local).unwrap();
        db.mark_custom_app_collected("o/pending").unwrap();
        db.mark_custom_app_submitted("o/pending", "https://github.com/x/y/pull/1")
            .unwrap();
        // 收藏写入时序：目录就绪后写时判定。
        db.add_favorite("o/pending", false).unwrap();

        let svc = test_service(Vec::new());
        svc.sync_collected_from_db(&db);
        assert!(svc.is_cataloged("o/pending"));
        assert_eq!(
            svc.get_catalog_item("o/pending").map(|i| i.name),
            Some("Pending Issue Tool".to_string())
        );
        // 回填口径与 `backfill_cataloged_flags` 同源：收藏标记转 true。
        db.set_favorite_cataloged("o/pending", svc.is_cataloged("o/pending"))
            .unwrap();
        let favorites = db.get_favorite_entries().unwrap();
        assert_eq!(favorites.len(), 1);
        assert!(favorites[0].is_cataloged);

        // 归档行退出 overlay：同步后不再可搜可装。
        db.retire_custom_apps_on_sync(&["o/pending".to_string()])
            .unwrap();
        svc.sync_collected_from_db(&db);
        assert!(!svc.is_cataloged("o/pending"));
    }

    /// 收录态盖章：蓝标优先、本地补位、未收录 false。
    #[test]
    fn test_stamp_summary_source_rules() {
        let mut remote = item("o/verified", "o", "verified");
        remote.is_verified = true;
        let svc = test_service(vec![
            remote,
            item("o/remote", "o", "remote"),
            item("o/both", "o", "both"),
        ]);
        // 本地收录同 id 不夺蓝标（已验证远端仍 source=remote）。
        svc.set_collected_items(vec![
            item("o/verified", "o", "verified"),
            item("o/both", "o", "both"),
            item("o/local", "o", "local"),
        ]);

        let mut verified = svc.item_to_stamped_summary(&item("o/verified", "o", "verified"));
        assert_eq!(verified.source.as_deref(), Some(CATALOG_SOURCE_REMOTE));
        assert_eq!(verified.is_cataloged, Some(true));
        assert_eq!(verified.status, None);

        // 远端未验证 + 本地收录同仓 → 本地补位（橘黄）。
        verified = svc.item_to_stamped_summary(&item("o/both", "o", "both"));
        assert_eq!(verified.source.as_deref(), Some(CATALOG_SOURCE_LOCAL));
        assert_eq!(verified.status.as_deref(), Some("collected"));
        assert_eq!(verified.is_cataloged, Some(true));

        // 纯远端未验证。
        let remote_only = svc.item_to_stamped_summary(&item("o/remote", "o", "remote"));
        assert_eq!(remote_only.source.as_deref(), Some(CATALOG_SOURCE_REMOTE));
        assert_eq!(remote_only.status, None);

        // 纯本地收录。
        let local_only = svc.item_to_stamped_summary(&item("o/local", "o", "local"));
        assert_eq!(local_only.source.as_deref(), Some(CATALOG_SOURCE_LOCAL));
        assert_eq!(local_only.status.as_deref(), Some("collected"));

        // 未收录（在线/趋势野生仓）。
        let empty = test_service(Vec::new());
        let unknown = empty.item_to_stamped_summary(&item("o/unknown", "o", "unknown"));
        assert_eq!(unknown.is_cataloged, Some(false));
        assert_eq!(unknown.source, None);
        assert_eq!(unknown.status, None);
    }

    /// 合并目录摘要：远端在前、本地补位，逐行盖章。
    #[test]
    fn test_merged_summaries_stamps_every_row() {
        let svc = test_service(vec![item("o/remote", "o", "remote")]);
        svc.set_collected_items(vec![item("o/local", "o", "local")]);
        let rows = svc.merged_summaries();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "o/remote");
        assert_eq!(rows[1].id, "o/local");
        for row in &rows {
            assert_eq!(row.is_cataloged, Some(true));
            assert!(row.source.is_some());
        }
    }
}
