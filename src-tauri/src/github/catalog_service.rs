use super::catalog_feed_score::*;
use crate::github::models::{AppRepoCoordinates, CatalogItem};
use crate::github::CatalogService;
use crate::models::AppSummary;
use reqwest::header::{IF_NONE_MATCH, USER_AGENT};
use std::sync::RwLock;

/// 目录来源标记：远端精选收录库行。
pub const CATALOG_SOURCE_REMOTE: &str = "remote";
/// 目录来源标记：本地收录（`custom_apps` collected 系/`submitted`）补位行。
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

/// 清单实际来源通道（同步宽事件 `via` 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogVia {
    /// 首跳：清单池（跟随系统代理）。
    Direct,
    /// 官方默认源经加速镜像回退。
    Mirror,
    /// 本地 `file://` / 路径。
    Local,
}

impl std::fmt::Display for CatalogVia {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CatalogVia::Direct => "direct",
            CatalogVia::Mirror => "mirror",
            CatalogVia::Local => "local",
        })
    }
}

/// 远程清单拉取结果：`items == None` 即 304 未变更。
#[derive(Debug)]
pub struct RemoteCatalogFetch {
    pub items: Option<Vec<CatalogItem>>,
    pub etag: Option<String>,
    pub via: CatalogVia,
}

struct CatalogFetchError {
    message: String,
    /// 传输失败 / 429 / 5xx：官方默认源可经镜像重试。
    retryable: bool,
}

/// 本地清单文件读取：以 mtime 合成弱 ETag，命中缓存 ETag 即视为未变更。
fn fetch_local_catalog(url: &str, cached_etag: Option<&str>) -> Result<RemoteCatalogFetch, String> {
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

    if cached_etag == Some(local_etag.as_str()) {
        return Ok(RemoteCatalogFetch {
            items: None,
            etag: None,
            via: CatalogVia::Local,
        });
    }

    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读取本地清单内容失败 ({}): {}", clean_path, e))?;
    let items: Vec<CatalogItem> = serde_json::from_str(&text)
        .map_err(|e| format!("解析本地收录清单 JSON 失败: {}", e))?;
    Ok(RemoteCatalogFetch {
        items: Some(items),
        etag: Some(local_etag),
        via: CatalogVia::Local,
    })
}

async fn fetch_catalog_once(
    client: &reqwest::Client,
    url: &str,
    cached_etag: Option<&str>,
    via: CatalogVia,
) -> Result<RemoteCatalogFetch, CatalogFetchError> {
    let fail = |message: String, retryable: bool| CatalogFetchError { message, retryable };
    let mut req = client
        .get(url)
        .header(USER_AGENT, crate::github::http::GH_USER_AGENT);
    if let Some(etag) = cached_etag {
        req = req.header(IF_NONE_MATCH, etag);
    }
    let resp = req.send().await.map_err(|e| {
        crate::proxy::note_transport_error(&e);
        fail(format!("请求收录清单失败: {}", e), true)
    })?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(RemoteCatalogFetch {
            items: None,
            etag: None,
            via,
        });
    }
    if !status.is_success() {
        let retryable = status.as_u16() == 429 || status.is_server_error();
        return Err(fail(
            format!("同步收录清单失败，HTTP 状态码: {}", status),
            retryable,
        ));
    }
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());
    let text = resp
        .text()
        .await
        .map_err(|e| fail(format!("读取清单内容失败: {}", e), true))?;
    let items: Vec<CatalogItem> = serde_json::from_str(&text)
        .map_err(|e| fail(format!("解析收录清单 JSON 失败: {}", e), false))?;
    Ok(RemoteCatalogFetch {
        items: Some(items),
        etag,
        via,
    })
}

/// 镜像清单严格校验：拒绝空数组与任一非法 `Canonical App Id`，防止门户页/截断响应覆盖目录。
fn validate_mirrored_catalog(items: &[CatalogItem]) -> Result<(), String> {
    if items.is_empty() {
        return Err("镜像返回空清单".to_string());
    }
    if let Some(bad) = items
        .iter()
        .find(|i| crate::forge::canonical_app_id(&i.id).is_none())
    {
        return Err(format!(
            "镜像清单含非法应用标识: {}",
            crate::log_support::short_reason(&bad.id)
        ));
    }
    Ok(())
}

/// 远端优先去重合并（同一形状唯一实现）：`remote` 原样在前，`local` 按 id 补位
/// （已存在即跳过）。
fn merge_remote_first(remote: Vec<CatalogItem>, local: Vec<CatalogItem>) -> Vec<CatalogItem> {
    let mut seen: std::collections::HashSet<String> = remote.iter().map(|i| i.id.clone()).collect();
    let mut out = remote;
    for item in local {
        if seen.insert(item.id.clone()) {
            out.push(item);
        }
    }
    out
}

impl Default for CatalogService {
    fn default() -> Self {
        Self::new()
    }
}

impl CatalogService {
    /// 构建纯内存默认实例（种子夹具/单元测试用；运行时主路径请用 `new_empty` + `sync_from_db`）。
    pub fn new() -> Self {
        let cfg = crate::config::get_project_config();
        let items: Vec<CatalogItem> = cfg.catalog.load_catalog_items().unwrap_or_default();
        Self::with_items(items)
    }

    /// 构建空目录实例（生产启动路径：先完成 DB 播种与迁移，再经 `sync_from_db` 从 SQLite 装载）。
    pub fn new_empty() -> Self {
        Self::with_items(Vec::new())
    }

    fn with_items(items: Vec<CatalogItem>) -> Self {
        Self {
            items: RwLock::new(items),
            collected: RwLock::new(Vec::new()),
            client: crate::proxy::ClientSlot::new(),
        }
    }

    /// 清单 Client 构造（无 Token，独立连接池参数）；`extra_hosts` 追加 per-client `no_proxy`。
    fn build_catalog_client(
        snap: &crate::proxy::ProxySnapshot,
        extra_hosts: &[String],
    ) -> Result<reqwest::Client, String> {
        let cfg = crate::config::get_project_config();
        let builder = reqwest::Client::builder()
            .pool_max_idle_per_host(10)
            .connect_timeout(std::time::Duration::from_secs(5))
            .tcp_keepalive(std::time::Duration::from_secs(60))
            .timeout(std::time::Duration::from_secs(
                cfg.network.api_timeout_seconds,
            ));
        crate::proxy::apply_proxy_snapshot(builder, snap, extra_hosts)
            .build()
            .map_err(|e| e.to_string())
    }

    /// 指定快照下的清单池 Client：签名不变复用，变化即重建。
    pub(crate) fn http_client_for(&self, snap: &crate::proxy::ProxySnapshot) -> reqwest::Client {
        self.client
            .get_or_build(&snap.signature(&[]), || Self::build_catalog_client(snap, &[]))
            .unwrap_or_else(|_| crate::proxy::fallback_client(snap, &[]))
    }

    /// 当前系统代理快照下的清单池 Client（跟随系统代理：有代理走代理、无代理直连）。
    pub(crate) fn http_client(&self) -> reqwest::Client {
        self.http_client_for(&crate::proxy::current_proxy_snapshot())
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
        let collected = self.collected.read().map(|c| c.clone()).unwrap_or_default();
        merge_remote_first(remote, collected)
    }

    /// 本地库 overlay 同步（启动与 `custom_apps` 每次变更后调用）：
    /// 输入须已过滤为未归档的 collected 系/`submitted`，库内保存原始 payload。
    pub fn set_collected_items(&self, items: Vec<CatalogItem>) {
        if let Ok(mut lock) = self.collected.write() {
            *lock = items;
        }
    }

    /// 从 SQLite 同步远端精选目录（`catalog_apps`）与本地库 overlay（`custom_apps`）到内存热读索引。
    pub fn sync_from_db(&self, db: &crate::db::Database) {
        if let Ok((remote, local)) = crate::repositories::CatalogRepository::load_remote_and_local(db) {
            self.update_items(remote);
            self.set_collected_items(local);
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

    /// 按 canonical id 检索本地库项（collected 系/`submitted` 且未归档）。
    pub fn get_collected_item(&self, id: &str) -> Option<CatalogItem> {
        let key = crate::forge::canonical_app_id(id)?;
        self.collected
            .read()
            .ok()
            .and_then(|items| items.iter().find(|i| i.id == key).cloned())
    }

    fn has_collected_key(&self, key: &str) -> bool {
        self.collected
            .read()
            .ok()
            .map(|items| items.iter().any(|i| i.id == key))
            .unwrap_or(false)
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

    /// 根据已知远端验证状态与本地收录命中状态为 `AppCore` 盖章。
    fn apply_stamp_flags(
        core: &mut crate::models::AppCore,
        remote_verified: Option<bool>,
        is_collected: bool,
    ) {
        if let Some(verified) = remote_verified {
            if verified || !is_collected {
                core.is_cataloged = Some(true);
                core.source = Some(CATALOG_SOURCE_REMOTE.to_string());
                core.status = None;
                return;
            }
        }
        if is_collected {
            core.is_cataloged = Some(true);
            core.source = Some(CATALOG_SOURCE_LOCAL.to_string());
            core.status = Some(crate::db::custom_apps::CUSTOM_APP_STATUS_COLLECTED.to_string());
        } else {
            core.is_cataloged = Some(false);
            core.source = None;
            core.status = None;
        }
    }

    /// 收录态决议（盖章唯一口径）：
    /// - 远端已验证 → `remote`（蓝标优先，本地同 id 不降级）；
    /// - 本地收录（含远端未验证同仓补位）→ `local` + `status=collected`；
    /// - 远端未验证且无本地收录 → `remote`；
    /// - 均未命中 → `is_cataloged=false`（来源缺席）。
    fn resolve_catalog_stamp(&self, core: &mut crate::models::AppCore) {
        let Some(key) = crate::forge::canonical_app_id(&core.id) else {
            Self::apply_stamp_flags(core, None, false);
            return;
        };
        let remote_verified = self
            .items
            .read()
            .ok()
            .and_then(|items| items.iter().find(|i| i.id == key).map(|i| i.is_verified));
        let is_collected = self.has_collected_key(&key);
        Self::apply_stamp_flags(core, remote_verified, is_collected);
    }

    /// 收录态盖章（`AppSummary` 投影唯一口）。
    pub fn stamp_summary(&self, summary: &mut AppSummary) {
        self.resolve_catalog_stamp(&mut summary.core);
    }

    /// 收录态盖章（`AppDetail` 投影唯一口，口径与 `stamp_summary` 一致）。
    pub fn stamp_detail(&self, detail: &mut crate::models::AppDetail) {
        self.resolve_catalog_stamp(&mut detail.core);
    }

    /// 目录项转已盖章摘要（列表/详情/搜索统一投影）。
    pub fn item_to_stamped_summary(&self, item: &CatalogItem) -> AppSummary {
        let mut summary = item.to_summary();
        self.stamp_summary(&mut summary);
        summary
    }

    /// 合并目录全量已盖章摘要（首页/分类/最新入库共用，单趟 O(N+M) 投影，零 CatalogItem 克隆与零重复归一化）。
    pub fn merged_summaries(&self) -> Vec<AppSummary> {
        let remote_guard = self.items.read().ok();
        let collected_guard = self.collected.read().ok();
        let remote_slice: &[CatalogItem] = remote_guard.as_deref().map_or(&[], |v| v.as_slice());
        let collected_slice: &[CatalogItem] =
            collected_guard.as_deref().map_or(&[], |v| v.as_slice());

        let collected_ids: std::collections::HashSet<&str> =
            collected_slice.iter().map(|i| i.id.as_str()).collect();
        let mut seen: std::collections::HashSet<&str> =
            std::collections::HashSet::with_capacity(remote_slice.len() + collected_slice.len());
        let mut out = Vec::with_capacity(remote_slice.len() + collected_slice.len());

        for item in remote_slice {
            seen.insert(item.id.as_str());
            let mut summary = item.to_summary();
            Self::apply_stamp_flags(
                &mut summary.core,
                Some(item.is_verified),
                collected_ids.contains(item.id.as_str()),
            );
            out.push(summary);
        }
        for item in collected_slice {
            if seen.insert(item.id.as_str()) {
                let mut summary = item.to_summary();
                Self::apply_stamp_flags(&mut summary.core, None, true);
                out.push(summary);
            }
        }
        out
    }

    pub fn update_items(&self, new_items: Vec<CatalogItem>) {
        if let Ok(mut lock) = self.items.write() {
            *lock = new_items;
        }
    }

    /// 将本地缓存详情（`AppDetail`）的非占位字段合并回填至未收录卡片摘要（`AppCore`）（SSOT）。
    pub(crate) fn apply_detail_to_summary_core(
        core: &mut crate::models::AppCore,
        detail: &crate::models::AppDetail,
    ) {
        if !detail.core.platforms.is_empty() {
            core.platforms = detail.core.platforms.clone();
        }
        if !CatalogItem::is_concrete_version(&core.latest_version)
            && CatalogItem::is_concrete_version(&detail.core.latest_version)
        {
            core.latest_version = detail.core.latest_version.clone();
        }
        let cur_desc_placeholder = core.description.trim().is_empty()
            || crate::github::detail_fetch::is_placeholder_description(&core.description);
        if cur_desc_placeholder
            && !detail.core.description.trim().is_empty()
            && !crate::github::detail_fetch::is_placeholder_description(&detail.core.description)
        {
            core.description = detail.core.description.clone();
        }
        let cur_en_placeholder = core
            .description_en
            .as_deref()
            .map(|s| {
                s.trim().is_empty() || crate::github::detail_fetch::is_placeholder_description(s)
            })
            .unwrap_or(true);
        if cur_en_placeholder {
            if let Some(ref en) = detail.core.description_en {
                if !en.trim().is_empty()
                    && !crate::github::detail_fetch::is_placeholder_description(en)
                {
                    core.description_en = Some(en.clone());
                }
            }
        }
        if !CatalogItem::is_concrete_license(&core.license)
            && CatalogItem::is_concrete_license(&detail.core.license)
        {
            core.license = detail.core.license.clone();
        }
        let cur_hp_empty = core
            .homepage
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if cur_hp_empty {
            if let Some(ref hp) = detail.core.homepage {
                if !hp.trim().is_empty() {
                    core.homepage = Some(hp.clone());
                }
            }
        }
        if core.icon.trim().is_empty() && CatalogItem::is_remote_http_icon(&detail.core.icon) {
            core.icon = detail.core.icon.trim().to_string();
        }
    }

    /// 从应用详情全量回写内存目录项（同时覆盖远端 `items` 与本地收录 `collected`）：
    /// 同步 `stars`、`forks`、`default_version`、`platforms`、`license`、`homepage` 与缺省时的 `http(s)` 图标。
    pub fn update_catalog_item_from_detail(&self, detail: &crate::models::AppDetail) {
        if detail.is_stale == Some(true) {
            return;
        }
        let Some(key) = crate::forge::canonical_app_id(&detail.core.id) else {
            return;
        };
        let apply = |list: &mut Vec<CatalogItem>| {
            if let Some(item) = list.iter_mut().find(|i| i.id == key) {
                item.merge_from_detail(detail);
            }
        };
        if let Ok(mut items) = self.items.write() {
            apply(&mut items);
        }
        if let Ok(mut collected) = self.collected.write() {
            apply(&mut collected);
        }
    }

    /// 平台懒回填同步内存目录项（与 `db.update_catalog_app_platforms` 保持一致：仅目录原为空时补齐）。
    pub fn update_catalog_item_platforms(&self, id: &str, platforms: &[String]) {
        if platforms.is_empty() {
            return;
        }
        let Some(key) = crate::forge::canonical_app_id(id) else {
            return;
        };
        let apply = |list: &mut Vec<CatalogItem>| {
            if let Some(item) = list.iter_mut().find(|i| i.id == key) {
                if item.platforms.is_empty() {
                    item.platforms = platforms.to_vec();
                }
            }
        };
        if let Ok(mut items) = self.items.write() {
            apply(&mut items);
        }
        if let Ok(mut collected) = self.collected.write() {
            apply(&mut collected);
        }
    }

    /// 清单拉取（不开启镜像回退）：返回 `(items, etag)`，`items == None` 即未变更。
    pub async fn fetch_remote_catalog(
        &self,
        url: &str,
        cached_etag: Option<&str>,
    ) -> Result<(Option<Vec<CatalogItem>>, Option<String>), String> {
        self.fetch_remote_catalog_with_fallback(url, cached_etag, None)
            .await
            .map(|f| (f.items, f.etag))
    }

    /// 清单拉取唯一分发：本地文件（`file://` 或无 http(s) scheme）读盘；远程经 HTTP，
    /// 仅官方默认源（[`is_default_catalog_source`]）在首跳传输失败 / 429 / 5xx 时经
    /// `mirror_prefix` 重试一次，自定义源与本地文件恒不改写。
    pub async fn fetch_remote_catalog_with_fallback(
        &self,
        url: &str,
        cached_etag: Option<&str>,
        mirror_prefix: Option<&str>,
    ) -> Result<RemoteCatalogFetch, String> {
        let is_remote = url.starts_with("http://") || url.starts_with("https://");
        if !is_remote {
            return fetch_local_catalog(url, cached_etag);
        }
        let mirror = mirror_prefix.filter(|_| is_default_catalog_source(url));
        self.fetch_http_catalog(url, cached_etag, mirror).await
    }

    /// HTTP 清单拉取：首跳经清单池（跟随系统代理）；`mirror_prefix` 为 `Some` 且首跳可重试失败时，
    /// 经镜像前缀重试一次（镜像 host 走 per-client `no_proxy` 直连，绝不携带 Token），
    /// 镜像响应须通过严格结构校验才采纳。
    pub(crate) async fn fetch_http_catalog(
        &self,
        url: &str,
        cached_etag: Option<&str>,
        mirror_prefix: Option<&str>,
    ) -> Result<RemoteCatalogFetch, String> {
        let primary =
            fetch_catalog_once(&self.http_client(), url, cached_etag, CatalogVia::Direct).await;
        let primary_err = match primary {
            Ok(f) => return Ok(f),
            Err(e) if e.retryable => e.message,
            Err(e) => return Err(e.message),
        };
        let Some(prefix) = mirror_prefix else {
            return Err(primary_err);
        };
        let mirrored = crate::mirror::prefix_with_base(prefix, url);
        let client = Self::build_catalog_client(
            &crate::proxy::current_proxy_snapshot(),
            &crate::proxy::proxy_hosts_for(&mirrored),
        )?;
        // 镜像不发条件请求：恒取完整正文并严格校验，镜像无法以 304 冻结目录；
        // 镜像侧 ETag 不落库（下次同步仍以官方源为准）。
        let fetched = fetch_catalog_once(&client, &mirrored, None, CatalogVia::Mirror)
            .await
            .map_err(|e| format!("{}；镜像重试失败: {}", primary_err, e.message))?;
        let Some(items) = fetched.items else {
            return Err(format!("{}；镜像清单校验失败: 未发条件请求却返回 304", primary_err));
        };
        validate_mirrored_catalog(&items)
            .map_err(|reason| format!("{}；镜像清单校验失败: {}", primary_err, reason))?;
        Ok(RemoteCatalogFetch {
            items: Some(items),
            etag: None,
            via: CatalogVia::Mirror,
        })
    }

    pub fn search_local_catalog(&self, query: &str) -> Vec<AppSummary> {
        let items = self.get_catalog_items();
        self.search_in_slice(&items, query)
    }

    fn search_in_slice(&self, items: &[CatalogItem], query: &str) -> Vec<AppSummary> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            let mut all: Vec<AppSummary> = items
                .iter()
                .map(|i| self.item_to_stamped_summary(i))
                .collect();
            all.sort_by_key(|b| std::cmp::Reverse(b.core.stars));
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
                b.1.core.stars.cmp(&a.1.core.stars)
            }
        });

        matches.into_iter().map(|(_, s)| s).collect()
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
            sorted.sort_by_key(|b| std::cmp::Reverse(b.core.stars));
            Some(sorted)
        }
    }

    /// 轻量 deduce（`get_platforms_lite` 通道 SSOT）：收录库非空平台优先，否则 GitHub release 原始资产 → deduce + 排序。
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
                    icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                })
            } else {
                Err(format!("未识别的仓库坐标: {}", id))
            }
        } else {
            Err(format!("收录库中不存在该应用: {}", id))
        }
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
            added_at: None,
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
            client: crate::proxy::ClientSlot::new(),
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

    /// 合并函数遵循远端优先去重（同 id 取远端行，custom 仅补位）。
    #[test]
    fn test_merge_catalog_overlay_remote_first() {
        let remote = vec![item("o/dup", "o", "dup"), item("o/remote", "o", "remote")];
        let mut dup_custom = item("o/dup", "o", "dup");
        dup_custom.name = "Custom Shadow".to_string();
        let custom = vec![dup_custom, item("o/local", "o", "local")];

        let merged = merge_remote_first(remote, custom);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].name, "Test App");
        assert_eq!(merged[2].id, "o/local");
    }

    /// 本地库 overlay 口径（canonical 谓词 `db::custom_apps::is_local_library_entry`）：
    /// collected 系 + `submitted` 且未归档参与合并。
    #[test]
    fn test_collected_overlay_status_gate() {
        use crate::db::custom_apps::{is_local_library_entry, CustomAppEntry};

        fn entry(status: &str, archived: bool) -> CustomAppEntry {
            CustomAppEntry {
                id: "o/r".to_string(),
                item: item("o/r", "o", "r"),
                status: status.to_string(),
                pr_url: None,
                created_at: 0,
                updated_at: 0,
                archived,
            }
        }

        assert!(is_local_library_entry(&entry("collected", false)));
        assert!(is_local_library_entry(&entry("submitted", false)));
        assert!(!is_local_library_entry(&entry("draft", false)));
        assert!(!is_local_library_entry(&entry("submitted", true)));
        assert!(!is_local_library_entry(&entry("collected", true)));
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
        svc.set_collected_items(vec![local]);
        let hits = svc.search_local_catalog("local");
        assert!(hits.iter().any(|s| s.core.id == "o/local"));
        // 空查询含本地（stars 降序全量）。
        let all = svc.search_local_catalog("");
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
        assert!(svc.get_collected_item("O/LOCAL").is_some());
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
        let hits = svc.search_local_catalog("local tool");
        assert!(hits.iter().any(|s| s.core.id == "o/local"));
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

        // 归档行退出 overlay：同步后退出本地搜索与安装视图。
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
        assert_eq!(verified.core.source.as_deref(), Some(CATALOG_SOURCE_REMOTE));
        assert_eq!(verified.core.is_cataloged, Some(true));
        assert_eq!(verified.core.status, None);

        // 远端未验证 + 本地收录同仓 → 本地补位（橘黄）。
        verified = svc.item_to_stamped_summary(&item("o/both", "o", "both"));
        assert_eq!(verified.core.source.as_deref(), Some(CATALOG_SOURCE_LOCAL));
        assert_eq!(verified.core.status.as_deref(), Some("collected"));
        assert_eq!(verified.core.is_cataloged, Some(true));

        // 纯远端未验证。
        let remote_only = svc.item_to_stamped_summary(&item("o/remote", "o", "remote"));
        assert_eq!(
            remote_only.core.source.as_deref(),
            Some(CATALOG_SOURCE_REMOTE)
        );
        assert_eq!(remote_only.core.status, None);

        // 纯本地收录。
        let local_only = svc.item_to_stamped_summary(&item("o/local", "o", "local"));
        assert_eq!(
            local_only.core.source.as_deref(),
            Some(CATALOG_SOURCE_LOCAL)
        );
        assert_eq!(local_only.core.status.as_deref(), Some("collected"));

        // 未收录（在线/趋势野生仓）。
        let empty = test_service(Vec::new());
        let unknown = empty.item_to_stamped_summary(&item("o/unknown", "o", "unknown"));
        assert_eq!(unknown.core.is_cataloged, Some(false));
        assert_eq!(unknown.core.source, None);
        assert_eq!(unknown.core.status, None);
    }

    /// 合并目录摘要：远端在前、本地补位，逐行盖章。
    #[test]
    fn test_merged_summaries_stamps_every_row() {
        let svc = test_service(vec![item("o/remote", "o", "remote")]);
        svc.set_collected_items(vec![item("o/local", "o", "local")]);
        let rows = svc.merged_summaries();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].core.id, "o/remote");
        assert_eq!(rows[1].core.id, "o/local");
        for row in &rows {
            assert_eq!(row.core.is_cataloged, Some(true));
            assert!(row.core.source.is_some());
        }
    }
}
