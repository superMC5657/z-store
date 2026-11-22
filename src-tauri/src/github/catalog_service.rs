use super::catalog_feed_score::*;
use crate::github::affinity_text::CatalogIdf;
use crate::github::models::{AppRepoCoordinates, CatalogItem};
use crate::github::CatalogService;
use crate::models::AppSummary;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

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
    let items: Vec<CatalogItem> =
        serde_json::from_str(&text).map_err(|e| format!("解析本地收录清单 JSON 失败: {}", e))?;
    Ok(RemoteCatalogFetch {
        items: Some(items),
        etag: Some(local_etag),
        via: CatalogVia::Local,
    })
}

/// 远端清单响应体上限：16 MiB（现行清单约 0.4 MiB），超限视为不可重试失败。
const MAX_CATALOG_BYTES: usize = 16 * 1024 * 1024;

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

/// 单侧目录（远端精选或本地收录）：条目按装载顺序保存，`index` 为 `id → 首次出现下标`，
/// `by_repo` 为小写仓库名 → 下标（升序）；仅在整体替换时重建，详情回写不改 `id`/`repo`。
#[derive(Default)]
pub(crate) struct CatalogBucket {
    items: Vec<CatalogItem>,
    index: HashMap<String, usize>,
    by_repo: HashMap<String, Vec<usize>>,
}

impl CatalogBucket {
    fn new(items: Vec<CatalogItem>) -> Self {
        let mut index = HashMap::with_capacity(items.len());
        let mut by_repo: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, item) in items.iter().enumerate() {
            index.entry(item.id.to_lowercase()).or_insert(i);
            by_repo.entry(item.repo.to_lowercase()).or_default().push(i);
        }
        Self {
            items,
            index,
            by_repo,
        }
    }

    fn lookup_index(&self, key: &str) -> Option<usize> {
        if let Some(&i) = self.index.get(key) {
            return Some(i);
        }
        if key.chars().any(char::is_uppercase) {
            return self.index.get(&key.to_lowercase()).copied();
        }
        None
    }

    pub(crate) fn get(&self, key: &str) -> Option<&CatalogItem> {
        self.lookup_index(key).map(|i| &self.items[i])
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut CatalogItem> {
        let i = self.lookup_index(key)?;
        self.items.get_mut(i)
    }

    pub(crate) fn contains(&self, key: &str) -> bool {
        self.lookup_index(key).is_some()
    }

    /// 下标 `i` 是否为该 `id` 在本侧的首次出现（同侧重复 id 只认第一条）。
    fn is_first(&self, i: usize) -> bool {
        self.lookup_index(self.items[i].id.as_str()) == Some(i)
    }
}

/// 目录文本派生量：只依赖名称/仓库/别名/简介，目录整体替换时失效，详情回写不失效。
pub(crate) struct CatalogDerived {
    pub(crate) idf: Arc<CatalogIdf>,
    /// 小写 id → aliases（仅非空），供种子相似度使用。
    pub(crate) aliases: Arc<HashMap<String, Vec<String>>>,
}

/// 远端精选目录 + 本地收录 overlay 的合并存储（远端优先：本地仅补位远端缺席的 id）。
#[derive(Default)]
pub struct CatalogStore {
    remote: CatalogBucket,
    collected: CatalogBucket,
    derived: OnceLock<Arc<CatalogDerived>>,
}

impl CatalogStore {
    /// 合并目录按序遍历：远端全部行在前，本地收录仅取远端缺席且同侧首次出现的行。
    pub(crate) fn merged(&self) -> impl Iterator<Item = (&CatalogItem, MergedOrigin)> + '_ {
        let remote = self.remote.items.iter().map(move |item| {
            (
                item,
                MergedOrigin::Remote {
                    verified: item.is_verified,
                    collected: self.collected.contains(&item.id),
                },
            )
        });
        let local = self
            .collected
            .items
            .iter()
            .enumerate()
            .filter(move |(i, item)| !self.remote.contains(&item.id) && self.collected.is_first(*i))
            .map(|(_, item)| (item, MergedOrigin::Local));
        remote.chain(local)
    }

    /// 按 canonical id 查合并目录（远端优先）。
    pub(crate) fn get(&self, key: &str) -> Option<&CatalogItem> {
        self.remote.get(key).or_else(|| self.collected.get(key))
    }

    /// 合并目录中仓库名（小写）相同的条目里星数最高者；并列取合并顺序中最后一条。
    pub(crate) fn top_by_repo_name(&self, repo_lower: &str) -> Option<&CatalogItem> {
        let remote = self
            .remote
            .by_repo
            .get(repo_lower)
            .into_iter()
            .flatten()
            .map(|&i| &self.remote.items[i]);
        let local = self
            .collected
            .by_repo
            .get(repo_lower)
            .into_iter()
            .flatten()
            .filter(|&&i| {
                self.collected.is_first(i) && !self.remote.contains(&self.collected.items[i].id)
            })
            .map(|&i| &self.collected.items[i]);
        remote.chain(local).max_by_key(|c| c.stars)
    }

    /// 文本派生量（懒构建并缓存到下一次目录整体替换）。
    pub(crate) fn derived(&self) -> Arc<CatalogDerived> {
        self.derived
            .get_or_init(|| {
                let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
                let idf = CatalogIdf::from_catalog_iter(self.merged().map(|(item, _)| {
                    if !item.aliases.is_empty() {
                        aliases.insert(item.id.to_lowercase(), item.aliases.clone());
                    }
                    item
                }));
                Arc::new(CatalogDerived {
                    idf: Arc::new(idf),
                    aliases: Arc::new(aliases),
                })
            })
            .clone()
    }

    fn set_remote(&mut self, items: Vec<CatalogItem>) {
        self.remote = CatalogBucket::new(items);
        self.derived = OnceLock::new();
    }

    fn set_collected(&mut self, items: Vec<CatalogItem>) {
        self.collected = CatalogBucket::new(items);
        self.derived = OnceLock::new();
    }
}

/// 读锁内的合并目录画像视图：O(1) 点查 + 缓存的 IDF 与别名。
struct StoreAffinityView<'a> {
    store: &'a CatalogStore,
    derived: Arc<CatalogDerived>,
}

impl crate::github::affinity::AffinityCatalog for StoreAffinityView<'_> {
    fn item(&self, id_lower: &str) -> Option<&CatalogItem> {
        self.store.get(id_lower)
    }

    fn top_by_repo_name(&self, repo_lower: &str) -> Option<&CatalogItem> {
        self.store.top_by_repo_name(repo_lower)
    }

    fn idf(&self) -> Arc<CatalogIdf> {
        self.derived.idf.clone()
    }

    fn aliases(&self) -> Arc<HashMap<String, Vec<String>>> {
        self.derived.aliases.clone()
    }
}

/// 合并目录行的来源（盖章输入）。
#[derive(Debug, Clone, Copy)]
pub(crate) enum MergedOrigin {
    /// 远端行；`collected` 为本地收录是否也有同 id 行。
    Remote { verified: bool, collected: bool },
    /// 本地收录补位行。
    Local,
}

/// 远端优先去重合并（同一形状唯一实现）：`remote` 原样在前，`local` 按 id 补位
/// （已存在即跳过）。
#[cfg(test)]
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

/// 目录项对小写查询词 `q` 的关键词匹配分（0 = 未命中）；按优先级逐级小写化，命中即停。
fn search_score(item: &CatalogItem, q: &str) -> i32 {
    let name_lower = item.name.to_lowercase();
    if name_lower == q || item.id.to_lowercase() == q {
        return SEARCH_SCORE_EXACT_MATCH;
    }
    if name_lower.starts_with(q) {
        return SEARCH_SCORE_PREFIX_MATCH;
    }
    if name_lower.contains(q) {
        return SEARCH_SCORE_NAME_CONTAINS;
    }
    if crate::github::alternatives::resolved_alternatives(item)
        .iter()
        .any(|a| a.to_lowercase().contains(q))
    {
        return SEARCH_SCORE_ALTERNATIVE_MATCH;
    }
    if item.aliases.iter().any(|a| a.to_lowercase().contains(q)) {
        return SEARCH_SCORE_ALIAS_CONTAINS;
    }
    if item.owner.to_lowercase().contains(q) || item.repo.to_lowercase().contains(q) {
        return SEARCH_SCORE_OWNER_OR_REPO_CONTAINS;
    }
    // 单字符查询不触发简介模糊匹配，避免大量单字母噪点泛滥。
    if q.chars().count() >= 2
        && (item.description.to_lowercase().contains(q)
            || item
                .description_en
                .as_deref()
                .is_some_and(|en| en.to_lowercase().contains(q)))
    {
        return SEARCH_SCORE_DESCRIPTION_CONTAINS;
    }
    0
}

/// 分类过滤口径（大小写不敏感，`category` 或 `category_name` 任一相等）。
pub(crate) fn category_matches(item: &CatalogItem, cat_lower: &str) -> bool {
    item.category.to_lowercase() == cat_lower || item.category_name.to_lowercase() == cat_lower
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

    /// 以给定远端目录构建实例（本地收录为空）。
    pub(crate) fn with_items(items: Vec<CatalogItem>) -> Self {
        let mut store = CatalogStore::default();
        store.set_remote(items);
        Self {
            store: RwLock::new(store),
        }
    }

    /// 目录读锁（中毒时沿用内部数据：写入只有整体替换与单条字段合并，不留半写状态）。
    pub(crate) fn read_store(&self) -> std::sync::RwLockReadGuard<'_, CatalogStore> {
        self.store.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write_store(&self) -> std::sync::RwLockWriteGuard<'_, CatalogStore> {
        self.store.write().unwrap_or_else(|e| e.into_inner())
    }
    pub fn get_catalog_count(&self) -> usize {
        self.read_store().remote.items.len()
    }

    /// 远端精选目录本体（不含本地收录 overlay）：转正判定与目录计数口径。
    pub fn get_remote_catalog_items(&self) -> Vec<CatalogItem> {
        self.read_store().remote.items.clone()
    }

    /// 合并目录（远端在前，本地收录按 id 补位去重）的整份拷贝；只供需要独立持有全库的
    /// 慢路径（扫描器）使用，热路径请用借用访问。
    pub fn get_catalog_items(&self) -> Vec<CatalogItem> {
        self.read_store()
            .merged()
            .map(|(item, _)| item.clone())
            .collect()
    }

    /// 本地库 overlay 同步（启动与 `custom_apps` 每次变更后调用）：
    /// 输入须已过滤为未归档的 collected 系/`submitted`，库内保存原始 payload。
    pub fn set_collected_items(&self, items: Vec<CatalogItem>) {
        self.write_store().set_collected(items);
    }

    /// 从 SQLite 同步远端精选目录（`catalog_apps`）与本地库 overlay（`custom_apps`）到内存热读索引。
    pub fn sync_from_db(&self, db: &crate::db::Database) {
        if let (Ok(remote), Ok(local)) = (db.list_catalog_apps(), db.list_local_library_items()) {
            let mut store = self.write_store();
            store.set_remote(remote);
            store.set_collected(local);
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
        self.read_store().remote.get(&key).cloned()
    }

    /// 按 canonical id 检索本地库项（collected 系/`submitted` 且未归档）。
    pub fn get_collected_item(&self, id: &str) -> Option<CatalogItem> {
        let key = crate::forge::canonical_app_id(id)?;
        self.read_store().collected.get(&key).cloned()
    }

    /// 目录项检索唯一口：远端精确命中优先，其次本地收录补位。
    pub fn get_catalog_item(&self, id: &str) -> Option<CatalogItem> {
        let key = crate::forge::canonical_app_id(id)?;
        self.read_store().get(&key).cloned()
    }

    /// 借用命中条目执行 `f`（读锁内，零克隆）；未知标识或未收录返回 `None`。
    pub fn with_catalog_item<R>(&self, id: &str, f: impl FnOnce(&CatalogItem) -> R) -> Option<R> {
        let key = crate::forge::canonical_app_id(id)?;
        self.read_store().get(&key).map(f)
    }

    /// 收录成员判定唯一口（写时标记/启动回填/图标分流共用）：远端或本地收录均视为已收录。
    pub fn is_cataloged(&self, id: &str) -> bool {
        let Some(key) = crate::forge::canonical_app_id(id) else {
            return false;
        };
        let store = self.read_store();
        store.remote.contains(&key) || store.collected.contains(&key)
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

    /// 合并目录行按来源盖章（与 `resolve_catalog_stamp` 同口径，免二次查表）。
    fn stamp_merged(core: &mut crate::models::AppCore, origin: MergedOrigin) {
        match origin {
            MergedOrigin::Remote {
                verified,
                collected,
            } => Self::apply_stamp_flags(core, Some(verified), collected),
            MergedOrigin::Local => Self::apply_stamp_flags(core, None, true),
        }
    }

    /// 合并目录行按来源投影为已盖章的 `AppSummary`。
    fn project_merged_summary(item: &CatalogItem, origin: MergedOrigin) -> AppSummary {
        let mut summary = item.to_summary();
        Self::stamp_merged(&mut summary.core, origin);
        summary
    }

    /// 远端目录中归属 `owner`（大小写不敏感）的条目数。
    pub(crate) fn count_remote_by_owner(&self, owner: &str) -> usize {
        self.read_store()
            .remote
            .items
            .iter()
            .filter(|i| i.owner.eq_ignore_ascii_case(owner))
            .count()
    }

    /// 解析并设置应用摘要的收录来源与验证标记。
    fn resolve_catalog_stamp(&self, core: &mut crate::models::AppCore) {
        let Some(key) = crate::forge::canonical_app_id(&core.id) else {
            Self::apply_stamp_flags(core, None, false);
            return;
        };
        let (remote_verified, is_collected) = {
            let store = self.read_store();
            (
                store.remote.get(&key).map(|i| i.is_verified),
                store.collected.contains(&key),
            )
        };
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

    /// 合并目录全量已盖章摘要（单趟 O(N+M) 投影，零 CatalogItem 克隆与零重复归一化）。
    pub fn merged_summaries(&self) -> Vec<AppSummary> {
        self.merged_summaries_filtered(|_| true)
    }

    /// 合并目录中满足 `pred` 的已盖章摘要（合并顺序）：读锁内先过滤，只为命中行构造 `AppSummary`。
    pub fn merged_summaries_filtered<F>(&self, mut pred: F) -> Vec<AppSummary>
    where
        F: FnMut(&CatalogItem) -> bool,
    {
        let store = self.read_store();
        store
            .merged()
            .filter(|(item, _)| pred(item))
            .map(|(item, origin)| Self::project_merged_summary(item, origin))
            .collect()
    }

    /// 基于当前合并目录构建本地亲和度画像：目录 IDF 与别名取缓存（目录整体替换后首次调用时重建），
    /// 条目经索引按需点查，不克隆目录。
    pub fn build_affinity_profile(
        &self,
        raw: &crate::db::RawAffinitySignals,
        now_secs: i64,
        sources: crate::github::affinity::AffinitySources,
    ) -> crate::github::affinity::UserAffinityProfile {
        let store = self.read_store();
        let view = StoreAffinityView {
            derived: store.derived(),
            store: &store,
        };
        crate::github::affinity::UserAffinityProfile::from_catalog(raw, &view, now_secs, sources)
    }

    /// 整体替换远端精选目录（文本派生缓存随之失效）。
    pub fn update_items(&self, new_items: Vec<CatalogItem>) {
        self.write_store().set_remote(new_items);
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
        if crate::github::models::is_placeholder_description(&core.description)
            && !crate::github::models::is_placeholder_description(&detail.core.description)
        {
            core.description = detail.core.description.clone();
        }
        let cur_en_placeholder = core
            .description_en
            .as_deref()
            .is_none_or(crate::github::models::is_placeholder_description);
        if cur_en_placeholder {
            if let Some(ref en) = detail.core.description_en {
                if !crate::github::models::is_placeholder_description(en) {
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

    /// 从应用详情全量回写内存目录项（同时覆盖远端与本地收录同 id 行）：
    /// 同步 `stars`、`forks`、`default_version`、`platforms`、`license`、`homepage` 与缺省时的 `http(s)` 图标。
    /// 这些字段不参与画像分词，文本派生缓存保持有效。
    pub fn update_catalog_item_from_detail(&self, detail: &crate::models::AppDetail) {
        if detail.is_stale == Some(true) {
            return;
        }
        let Some(key) = crate::forge::canonical_app_id(&detail.core.id) else {
            return;
        };
        let mut guard = self.write_store();
        let store = &mut *guard;
        for bucket in [&mut store.remote, &mut store.collected] {
            if let Some(item) = bucket.get_mut(&key) {
                item.merge_from_detail(detail);
            }
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
        let mut guard = self.write_store();
        let store = &mut *guard;
        for bucket in [&mut store.remote, &mut store.collected] {
            if let Some(item) = bucket.get_mut(&key) {
                if item.platforms.is_empty() {
                    item.platforms = platforms.to_vec();
                }
            }
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
            let (url, etag) = (url.to_string(), cached_etag.map(str::to_string));
            return tokio::task::spawn_blocking(move || fetch_local_catalog(&url, etag.as_deref()))
                .await
                .map_err(|e| e.to_string())?;
        }
        let mirror = mirror_prefix.filter(|_| is_default_catalog_source(url));
        self.fetch_http_catalog(url, cached_etag, mirror).await
    }

    /// HTTP 清单拉取：经共享无令牌清单传输（[`crate::forge::http::fetch_manifest_with_mirror_fallback`]）；
    /// 镜像响应须通过严格结构校验才采纳，镜像侧 ETag 不落库（下次同步仍以官方源为准）。
    pub(crate) async fn fetch_http_catalog(
        &self,
        url: &str,
        cached_etag: Option<&str>,
        mirror_prefix: Option<&str>,
    ) -> Result<RemoteCatalogFetch, String> {
        let fetched = crate::forge::http::fetch_manifest_with_mirror_fallback(
            &crate::forge::http::manifest_client(),
            crate::forge::http::ManifestRequest {
                url,
                cached_etag,
                mirror_prefix,
                max_bytes: MAX_CATALOG_BYTES,
                label: "收录清单",
            },
            |body| {
                let items: Vec<CatalogItem> = serde_json::from_slice(body)
                    .map_err(|e| format!("解析收录清单 JSON 失败: {e}"))?;
                validate_mirrored_catalog(&items)
            },
        )
        .await?;
        let via = if fetched.via_mirror {
            CatalogVia::Mirror
        } else {
            CatalogVia::Direct
        };
        let items = match fetched.body {
            None => None,
            Some(body) => Some(
                serde_json::from_slice::<Vec<CatalogItem>>(&body)
                    .map_err(|e| format!("解析收录清单 JSON 失败: {e}"))?,
            ),
        };
        Ok(RemoteCatalogFetch {
            items,
            etag: fetched.etag,
            via,
        })
    }

    /// 本地合并目录搜索（空查询按 stars 降序，命中分类名返回全分类，否则按关键词匹配分排序）。
    pub fn search_local_catalog(&self, query: &str) -> Vec<AppSummary> {
        let q = query.trim().to_lowercase();
        let store = self.read_store();
        let by_stars_desc = |mut rows: Vec<AppSummary>| {
            rows.sort_by_key(|b| std::cmp::Reverse(b.core.stars));
            rows
        };

        if q.is_empty() {
            return by_stars_desc(
                store
                    .merged()
                    .map(|(item, origin)| Self::project_merged_summary(item, origin))
                    .collect(),
            );
        }

        let mut category_hits: Vec<(&CatalogItem, MergedOrigin)> = Vec::new();
        let mut keyword_hits: Vec<(i32, &CatalogItem, MergedOrigin)> = Vec::new();
        for (item, origin) in store.merged() {
            if category_matches(item, &q) {
                category_hits.push((item, origin));
            }
            // 分类命中即整体走分类分支，之后不必再算关键词分。
            if category_hits.is_empty() {
                let score = search_score(item, &q);
                if score > 0 {
                    keyword_hits.push((score, item, origin));
                }
            }
        }

        if !category_hits.is_empty() {
            return by_stars_desc(
                category_hits
                    .into_iter()
                    .map(|(item, origin)| Self::project_merged_summary(item, origin))
                    .collect(),
            );
        }

        keyword_hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.stars.cmp(&a.1.stars)));
        keyword_hits
            .into_iter()
            .map(|(_, item, origin)| Self::project_merged_summary(item, origin))
            .collect()
    }

    /// 轻量 deduce（`get_platforms_lite` 通道 SSOT）：收录库非空平台优先，否则 GitHub release 原始资产 → deduce + 排序。
    /// 空推导明确返回空向量，不做任何兜底；`platforms/valid-asset/sort` 真相源在 `detail_assets`。
    pub(crate) fn deduce_lite_platforms(
        &self,
        id: &str,
        assets: &[crate::github::models::GitHubAssetResponse],
    ) -> Vec<String> {
        let catalog_platforms = self.with_catalog_item(id, |i| i.platforms.clone());
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
        let in_catalog = self
            .read_store()
            .get(&clean)
            .map(|item| AppRepoCoordinates {
                owner: item.owner.clone(),
                repo: item.repo.clone(),
                name: item.name.clone(),
                description: item.description.clone(),
                icon: item.icon.clone(),
                icon_bg: item.icon_bg.clone(),
            });
        if let Some(coords) = in_catalog {
            Ok(coords)
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

/// 详情页「相似开源项目」计算入参（支持已收录与未收录外部仓库）。
pub struct SimilarAppSeed<'a> {
    pub clean_id: &'a str,
    pub name: Option<&'a str>,
    pub owner: Option<&'a str>,
    pub category: Option<&'a str>,
    pub description: Option<&'a str>,
    pub description_en: Option<&'a str>,
}

/// 单条相似开源项目匹配结果（未回填 DB 确认图标前的目录态投影）。
pub struct SimilarAppMatch {
    pub app: AppSummary,
    pub similarity: f64,
    pub reasons: Vec<crate::github::affinity::Reason>,
}

/// `CatalogService::find_similar_apps` 计算产物。
pub struct SimilarAppsPlan {
    pub target_id: String,
    pub target_alternatives: Vec<String>,
    pub items: Vec<SimilarAppMatch>,
}

const SIMILAR_MIN_SIMILARITY: f64 = 0.25;
const SIMILAR_DEFAULT_LIMIT: usize = 4;
const SIMILAR_MIN_LIMIT: usize = 1;
const SIMILAR_MAX_LIMIT: usize = 8;

/// 构造未收录应用临时 `AppSummary` 种子，供详情页相似项目打分使用。
fn build_external_seed_summary(seed: &SimilarAppSeed<'_>) -> AppSummary {
    let (parsed_owner, parsed_repo) = crate::forge::RepositoryUrlParser::parse(seed.clean_id)
        .map(|c| (c.owner, c.repo))
        .or_else(|| {
            seed.clean_id
                .split_once('/')
                .map(|(o, r)| (o.to_string(), r.to_string()))
        })
        .unwrap_or_else(|| (String::new(), seed.clean_id.to_string()));
    let owner = seed
        .owner
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(parsed_owner);
    let name = seed
        .name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| parsed_repo.clone());
    let category = seed
        .category
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .unwrap_or_default();
    let description = seed
        .description
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_default();
    let description_en = seed
        .description_en
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    AppSummary {
        core: crate::models::AppCore {
            id: seed.clean_id.to_string(),
            name,
            description_en,
            owner,
            repo: parsed_repo,
            icon: String::new(),
            icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
            description,
            stars: 0,
            forks: 0,
            license: String::new(),
            latest_version: String::new(),
            category,
            category_name: String::new(),
            is_verified: false,
            forge: None,
            forge_host: None,
            homepage: None,
            platforms: Vec::new(),
            is_cataloged: Some(false),
            source: None,
            status: None,
            added_at: None,
            alternatives: crate::github::alternatives::resolved_alternatives_for(
                &[],
                seed.clean_id,
            ),
        },
    }
}

impl CatalogService {
    /// 基于读锁内 `CatalogStore::derived()`（IDF + 别名）计算相似开源项目（零网络）。
    pub fn find_similar_apps(
        &self,
        seed: &SimilarAppSeed<'_>,
        hidden_ids: &std::collections::HashSet<String>,
        limit: Option<usize>,
    ) -> SimilarAppsPlan {
        let store = self.read_store();
        let derived = store.derived();
        let clean_lower = seed.clean_id.to_lowercase();

        let seed_summary = if let Some(item) = store.get(&clean_lower) {
            item.to_summary()
        } else {
            build_external_seed_summary(seed)
        };
        let target_alternatives = seed_summary.core.alternatives.clone();

        let seed_aliases = derived
            .aliases
            .get(&clean_lower)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let seed_tokens =
            crate::github::affinity_text::extract_summary_tokens(&seed_summary, seed_aliases);

        let cap = limit
            .unwrap_or(SIMILAR_DEFAULT_LIMIT)
            .clamp(SIMILAR_MIN_LIMIT, SIMILAR_MAX_LIMIT);

        let mut scored: Vec<(f64, u64, f64, AppSummary)> = Vec::new();
        for (item, origin) in store.merged() {
            let item_lower = item.id.to_lowercase();
            if item_lower == clean_lower || hidden_ids.contains(&item_lower) {
                continue;
            }
            let cand_summary = Self::project_merged_summary(item, origin);
            let cand_tokens =
                crate::github::affinity::similarity_tokens(&cand_summary, Some(&*derived.aliases));
            let sim = crate::github::affinity::similarity_from_tokens(
                &seed_summary,
                &seed_tokens,
                &cand_summary,
                &cand_tokens,
                &derived.idf,
            );
            if sim < SIMILAR_MIN_SIMILARITY {
                continue;
            }
            let rank = sim * 10.0 + 0.15 * feed_stars_forks_base(item.stars, item.forks);
            scored.push((rank, item.stars, sim, cand_summary));
        }

        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| a.3.core.id.cmp(&b.3.core.id))
        });
        scored.truncate(cap);

        let items = scored
            .into_iter()
            .map(|(_, _, sim, app)| {
                let reasons = crate::github::affinity::explain_similarity_reasons(
                    &seed_summary,
                    &seed_tokens,
                    &app,
                    &derived.idf,
                    Some(&*derived.aliases),
                );
                SimilarAppMatch {
                    app,
                    similarity: sim,
                    reasons,
                }
            })
            .collect();

        SimilarAppsPlan {
            target_id: seed.clean_id.to_string(),
            target_alternatives,
            items,
        }
    }
}

/// 收录申请前置门禁：仅未提交的 collected 系行可进入 Issue 预填 / 标记已提交。
pub fn ensure_collected_for_pr(entry: &crate::db::CustomAppEntry) -> Result<(), String> {
    if entry.status == crate::db::custom_apps::CUSTOM_APP_STATUS_SUBMITTED {
        return Err(format!("已提交行不可重复提交: {}", entry.id));
    }
    if !crate::db::custom_apps::is_collected_status(&entry.status) {
        return Err("须先收录进本地再提交 Issue".to_string());
    }
    Ok(())
}

/// 首次启动播种：仅当 `catalog_apps` 为空时从配置种子 `catalog.json` 写入。
/// 种子反序列化失败记 warn 并按空种子继续（目录随后由远端清单同步补齐）。
fn seed_catalog_from_config_if_empty(db: &crate::db::Database) -> rusqlite::Result<bool> {
    if db.count_catalog_apps()? > 0 {
        return Ok(false);
    }
    let json = crate::config::get_project_config()
        .catalog
        .load_catalog_json();
    let seed_items: Vec<CatalogItem> = match serde_json::from_str(&json) {
        Ok(items) => items,
        Err(e) => {
            let mut ev = crate::z_log::WideEvent::new("catalog", "seed parse failed");
            ev.field("reason", &e);
            ev.warn();
            Vec::new()
        }
    };
    db.seed_catalog_apps_if_empty(&seed_items)
}

/// 按数据库目录口径（`catalog_apps` + 本地库）校准收藏与关注的 `is_cataloged` 标记；
/// 只读 `id` 列，仅写入标记变化的行（可在调用方事务内执行）。
fn backfill_cataloged_flags(db: &crate::db::Database) -> rusqlite::Result<()> {
    let cataloged_ids = db.list_cataloged_ids()?;
    let is_hit = |raw: &str| -> bool {
        crate::forge::canonical_app_id(raw)
            .map(|c| cataloged_ids.contains(&c))
            .unwrap_or(false)
    };
    for f in &db.get_favorite_entries()? {
        let hit = is_hit(&f.app_id);
        if hit != f.is_cataloged {
            db.set_favorite_cataloged(&f.app_id, hit)?;
        }
    }
    for w in &db.get_watched_apps()? {
        let hit = is_hit(&w.app_id);
        if hit != w.is_cataloged {
            db.set_watched_cataloged(&w.app_id, hit)?;
        }
    }
    Ok(())
}

fn log_backfill_failure(reason: &rusqlite::Error) {
    let mut ev = crate::z_log::WideEvent::new("app", "backfill cataloged flags failed");
    ev.field(
        "reason",
        crate::log_support::short_reason(&reason.to_string()),
    );
    ev.warn();
}

/// 本地库条目进入收录态：图标轮换槽以 L1 目录图标为准并同步详情图标。
fn mark_icon_cycle_cataloged(db: &crate::db::Database, item: &CatalogItem) {
    let icon = item.icon.trim();
    if icon.is_empty() {
        return;
    }
    let clean_id = crate::forge::canonical_lookup_id(&item.id);
    let mut cycle = db
        .get_icon_cycle(&clean_id)
        .ok()
        .flatten()
        .unwrap_or_else(|| crate::db::AppIconCycle::new(&clean_id, &item.owner, &item.repo));
    cycle.is_cataloged = true;
    if cycle.l1_url != icon {
        cycle.cache_file = String::new();
    }
    cycle.l1_url = icon.to_string();
    cycle.selected_url = icon.to_string();
    cycle.level = 1;
    cycle.pinned = false;
    let _ = db.upsert_icon_cycle(&cycle);
    let _ = db.sync_detail_icon(&clean_id, icon);
}

/// 本地库条目离开收录态：清空 L1 槽与磁盘缓存指针，图标回归 L2+ 轮换。
fn mark_icon_cycle_uncataloged(db: &crate::db::Database, clean_id: &str) {
    if let Ok(Some(mut cycle)) = db.get_icon_cycle(clean_id) {
        cycle.is_cataloged = false;
        cycle.l1_url = String::new();
        cycle.cache_file = String::new();
        let _ = db.upsert_icon_cycle(&cycle);
    }
}

/// 目录持久化权威：`catalog_apps` / `custom_apps` 写入与内存索引、收藏/关注收录标记、
/// `app_icon_cycles` L1 槽及 `repo_card_cache` 已收录行清理在同一入口内保持一致。
/// 所有方法接收调用方已持锁的 `&Database`。
impl CatalogService {
    /// 启动装载：空库播种 → 内存装载远端精选与本地库 → 收录标记校准 → 清理已收录富卡行。
    pub fn initialize_from_db(&self, db: &crate::db::Database) {
        let _ = seed_catalog_from_config_if_empty(db);
        self.sync_from_db(db);
        if let Err(e) = backfill_cataloged_flags(db) {
            log_backfill_failure(&e);
        }
        let _ = db.purge_cataloged_repo_cards();
    }

    /// 远端清单权威覆盖：单事务内替换 `catalog_apps`、退役已转正草稿、校准收录标记、
    /// 清理已收录富卡行并可选落盘 ETag（防目录写失败导致假 304）；提交后刷新内存目录。
    /// 返回本次转正归档的草稿 id。
    pub fn apply_remote_manifest(
        &self,
        db: &crate::db::Database,
        items: &[CatalogItem],
        etag_entry: Option<(&str, &str, i64)>,
    ) -> rusqlite::Result<Vec<String>> {
        let graduated = db.with_immediate_transaction(|| {
            db.replace_catalog_apps_in_tx(items)?;
            let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
            let graduated = db.retire_custom_apps_in_tx(&ids)?;
            backfill_cataloged_flags(db)?;
            db.purge_cataloged_repo_cards()?;
            if let Some((url, etag, now)) = etag_entry {
                db.save_etag(url, etag, "[]", now)?;
            }
            Ok(graduated)
        })?;
        self.sync_from_db(db);
        Ok(graduated)
    }

    /// 暂存本地草稿（宽松校验，强制 `is_verified = false`）。新建行为 `draft`；
    /// 已存在行保留原状态与 `pr_url`，处于本地库态时同步图标槽并清理富卡行。
    pub fn save_custom_draft(
        &self,
        db: &crate::db::Database,
        item: CatalogItem,
    ) -> crate::AppResult<crate::db::CustomAppEntry> {
        use crate::db::custom_apps::{resolve_license_gate, validate_custom_item, ValidateMode};
        let canonical =
            validate_custom_item(&item, ValidateMode::DraftLenient, &resolve_license_gate())
                .map_err(crate::AppError::new)?;
        let mut normalized = item;
        normalized.id = canonical;
        normalized.is_verified = false;
        let entry = db.upsert_custom_app_payload(&normalized)?;
        if crate::db::custom_apps::is_local_library_status(&entry.status) {
            mark_icon_cycle_cataloged(db, &entry.item);
            let _ = db.purge_cataloged_repo_cards();
        }
        self.after_local_library_change(db);
        Ok(entry)
    }

    /// 草稿 → 本地已收录（严格校验，`is_verified` 保持 `false`）。
    pub fn collect_local_app(
        &self,
        db: &crate::db::Database,
        id: &str,
    ) -> crate::AppResult<crate::db::CustomAppEntry> {
        let key = crate::forge::canonical_lookup_id(id);
        let entry = db.mark_custom_app_collected(&key)?;
        mark_icon_cycle_cataloged(db, &entry.item);
        let _ = db.purge_cataloged_repo_cards();
        self.after_local_library_change(db);
        Ok(entry)
    }

    /// 本地已收录 → 草稿（仅未归档的已收录行）。
    pub fn revert_collected_to_draft(
        &self,
        db: &crate::db::Database,
        id: &str,
    ) -> crate::AppResult<crate::db::CustomAppEntry> {
        let key = crate::forge::canonical_lookup_id(id);
        let entry = db.revert_collected_to_draft(&key)?;
        mark_icon_cycle_uncataloged(db, &key);
        self.after_local_library_change(db);
        Ok(entry)
    }

    /// 撤回已提交标记：`submitted` → `collected` 并清空 `pr_url`（仍在本地库内）。
    pub fn withdraw_submitted(
        &self,
        db: &crate::db::Database,
        id: &str,
    ) -> crate::AppResult<crate::db::CustomAppEntry> {
        let key = crate::forge::canonical_lookup_id(id);
        let entry = db.withdraw_submitted(&key)?;
        self.after_local_library_change(db);
        Ok(entry)
    }

    /// 标记为已提交并记录 `pr_url`（仅允许未归档的 `collected` 行）。
    pub fn mark_submitted(
        &self,
        db: &crate::db::Database,
        id: &str,
        pr_url: &str,
    ) -> crate::AppResult<crate::db::CustomAppEntry> {
        let key = crate::forge::canonical_lookup_id(id);
        let entry = db
            .get_custom_app(&key)?
            .ok_or_else(|| crate::AppError::new(format!("草稿不存在: {}", key)))?;
        ensure_collected_for_pr(&entry).map_err(crate::AppError::new)?;
        let entry = db.mark_custom_app_submitted(&key, pr_url)?;
        self.after_local_library_change(db);
        Ok(entry)
    }

    /// 删除草稿或本地库条目（返回是否命中）。
    pub fn delete_custom_app(&self, db: &crate::db::Database, id: &str) -> crate::AppResult<bool> {
        let key = crate::forge::canonical_lookup_id(id);
        let hit = db.delete_custom_app(&key)?;
        if hit {
            mark_icon_cycle_uncataloged(db, &key);
        }
        self.after_local_library_change(db);
        Ok(hit)
    }

    /// 本地库变更收尾：重载内存 overlay 并按数据库口径校准收录标记。
    fn after_local_library_change(&self, db: &crate::db::Database) {
        self.sync_collected_from_db(db);
        if let Err(e) = backfill_cataloged_flags(db) {
            log_backfill_failure(&e);
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
            alternatives: Vec::new(),
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

    fn detail_for(id: &str, stars: u64) -> crate::models::AppDetail {
        let mut core = item(id, "o", "r").to_summary().core;
        core.stars = stars;
        crate::models::AppDetail {
            core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: Vec::new(),
            cached_at: None,
            is_stale: None,
        }
    }

    fn test_service(items: Vec<CatalogItem>) -> CatalogService {
        CatalogService::with_items(items)
    }

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

    /// 索引语义与线性扫描一致：同侧重复 id 只认首行，本地与远端同 id 时远端优先，
    /// 合并目录不重复输出。
    #[test]
    fn test_index_keeps_first_row_and_remote_priority() {
        let mut first = item("o/dup", "o", "dup");
        first.name = "First".to_string();
        let mut second = item("o/dup", "o", "dup");
        second.name = "Second".to_string();
        let svc = test_service(vec![first, second, item("o/shared", "o", "shared")]);
        let mut shadow = item("o/shared", "o", "shared");
        shadow.name = "Shadow".to_string();
        let mut local_a = item("o/local", "o", "local");
        local_a.name = "Local A".to_string();
        let mut local_b = item("o/local", "o", "local");
        local_b.name = "Local B".to_string();
        svc.set_collected_items(vec![shadow, local_a, local_b]);

        assert_eq!(
            svc.get_remote_catalog_item("o/dup").map(|i| i.name),
            Some("First".to_string())
        );
        assert_eq!(
            svc.get_catalog_item("o/shared").map(|i| i.name),
            Some("Test App".to_string())
        );
        assert_eq!(
            svc.get_collected_item("o/local").map(|i| i.name),
            Some("Local A".to_string())
        );
        let merged: Vec<String> = svc
            .get_catalog_items()
            .into_iter()
            .map(|i| i.name)
            .collect();
        assert_eq!(merged, vec!["First", "Second", "Test App", "Local A"]);
        let summaries: Vec<String> = svc
            .merged_summaries()
            .into_iter()
            .map(|s| s.core.name)
            .collect();
        assert_eq!(summaries, merged);
    }

    /// 详情回写经索引就地合并远端与本地同 id 行；未知标识与陈旧详情不动目录。
    #[test]
    fn test_detail_and_platform_writeback_hit_both_buckets() {
        let svc = test_service(vec![item("o/both", "o", "both")]);
        svc.set_collected_items(vec![item("o/both", "o", "both")]);

        let mut detail = detail_for("O/Both", 42);
        svc.update_catalog_item_from_detail(&detail);
        assert_eq!(svc.get_remote_catalog_item("o/both").unwrap().stars, 42);
        assert_eq!(svc.get_collected_item("o/both").unwrap().stars, 42);

        detail.core.stars = 99;
        detail.is_stale = Some(true);
        svc.update_catalog_item_from_detail(&detail);
        assert_eq!(svc.get_remote_catalog_item("o/both").unwrap().stars, 42);

        svc.update_catalog_item_platforms("o/both", &["linux".to_string()]);
        svc.update_catalog_item_platforms("o/both", &["windows".to_string()]);
        assert_eq!(
            svc.get_remote_catalog_item("o/both").unwrap().platforms,
            vec!["linux".to_string()]
        );
        assert_eq!(
            svc.get_collected_item("o/both").unwrap().platforms,
            vec!["linux".to_string()]
        );
        svc.update_catalog_item_platforms("not-an-id", &["linux".to_string()]);
    }

    /// 过滤投影只为命中行构造摘要，盖章口径与全量投影一致。
    #[test]
    fn test_merged_summaries_filtered_matches_full_projection() {
        let mut verified = item("o/verified", "o", "verified");
        verified.is_verified = true;
        verified.category = "media".to_string();
        let svc = test_service(vec![verified, item("o/both", "o", "both")]);
        svc.set_collected_items(vec![
            item("o/both", "o", "both"),
            item("o/local", "o", "local"),
        ]);

        let mut visited = 0usize;
        let dev_rows = svc.merged_summaries_filtered(|i| {
            visited += 1;
            i.category == "dev"
        });
        assert_eq!(visited, 3);
        let full: Vec<AppSummary> = svc
            .merged_summaries()
            .into_iter()
            .filter(|s| s.core.category == "dev")
            .collect();
        assert_eq!(
            serde_json::to_value(&dev_rows).unwrap(),
            serde_json::to_value(&full).unwrap()
        );
        assert_eq!(
            dev_rows[0].core.source.as_deref(),
            Some(CATALOG_SOURCE_LOCAL)
        );
        assert_eq!(
            dev_rows[1].core.source.as_deref(),
            Some(CATALOG_SOURCE_LOCAL)
        );
    }

    /// 本地搜索三个分支：分类命中整体走分类、关键词按分值再按星数、空查询全量按星数。
    #[test]
    fn test_search_branches_keep_order_and_stamps() {
        let mut low = item("o/editor-lite", "o", "editor-lite");
        low.name = "Editor Lite".to_string();
        low.stars = 5;
        let mut high = item("o/editor", "o", "editor");
        high.name = "Editor".to_string();
        high.stars = 10;
        let mut media = item("o/player", "o", "player");
        media.name = "Player".to_string();
        media.category = "media".to_string();
        media.category_name = "影音".to_string();
        media.stars = 1;
        let svc = test_service(vec![low, high, media]);

        let ids = |rows: Vec<AppSummary>| -> Vec<String> {
            rows.into_iter().map(|s| s.core.id).collect()
        };
        assert_eq!(
            ids(svc.search_local_catalog("editor")),
            vec!["o/editor", "o/editor-lite"]
        );
        assert_eq!(ids(svc.search_local_catalog("影音")), vec!["o/player"]);
        assert_eq!(
            ids(svc.search_local_catalog("DEV")),
            vec!["o/editor", "o/editor-lite"]
        );
        assert_eq!(
            ids(svc.search_local_catalog("  ")),
            vec!["o/editor", "o/editor-lite", "o/player"]
        );
        assert!(svc.search_local_catalog("zzz").is_empty());
    }

    /// 仓库名反查：星数最高者胜出，并列取合并顺序最后一条；被远端遮蔽的本地行不参与。
    #[test]
    fn test_top_by_repo_name_uses_merged_view() {
        let mut a = item("a/tool", "a", "Tool");
        a.stars = 10;
        let mut b = item("b/tool", "b", "tool");
        b.stars = 10;
        let svc = test_service(vec![a, b]);
        let mut shadow = item("b/tool", "b", "tool");
        shadow.stars = 1000;
        let mut c = item("c/tool", "c", "tool");
        c.stars = 5;
        svc.set_collected_items(vec![shadow, c]);

        let store = svc.read_store();
        assert_eq!(
            store.top_by_repo_name("tool").map(|i| i.id.as_str()),
            Some("b/tool")
        );
        assert_eq!(store.top_by_repo_name("tool").map(|i| i.stars), Some(10));
        assert!(store.top_by_repo_name("none").is_none());
    }

    /// 文本派生缓存：目录未变时复用同一实例；详情回写不失效；整体替换任一侧即重建。
    #[test]
    fn test_derived_cache_lifecycle() {
        let svc = test_service(vec![item("o/remote", "o", "remote")]);
        let first = svc.read_store().derived();
        assert!(Arc::ptr_eq(&first, &svc.read_store().derived()));

        let detail = detail_for("o/remote", 7);
        svc.update_catalog_item_from_detail(&detail);
        svc.update_catalog_item_platforms("o/remote", &["linux".to_string()]);
        assert!(Arc::ptr_eq(&first, &svc.read_store().derived()));

        let mut local = item("o/local", "o", "local");
        local.aliases = vec!["LocalAlias".to_string()];
        svc.set_collected_items(vec![local]);
        let second = svc.read_store().derived();
        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(
            second.aliases.get("o/local"),
            Some(&vec!["LocalAlias".to_string()])
        );

        svc.update_items(vec![item("o/other", "o", "other")]);
        assert!(!Arc::ptr_eq(&second, &svc.read_store().derived()));
    }

    /// 常驻目录构建的画像与按合并目录切片构建的画像逐项一致（含 Fork 反查与本地补位）。
    #[test]
    fn test_build_affinity_profile_matches_slice_build() {
        use crate::db::{RawAffinitySignals, UserRepoSignal};
        use crate::github::affinity::{AffinitySources, UserAffinityProfile};

        let mut editor = item("acme/editor", "acme", "editor");
        editor.description = "fast code editor".to_string();
        editor.stars = 500;
        editor.aliases = vec!["CodePad".to_string()];
        let mut player = item("media/player", "media", "player");
        player.category = "media".to_string();
        player.description = "video player".to_string();
        player.stars = 300;
        let mut clone_editor = item("other/editor", "other", "editor");
        clone_editor.description = "another editor".to_string();
        clone_editor.stars = 50;
        let svc = test_service(vec![editor, player, clone_editor]);
        let mut notes = item("me/notes", "me", "notes");
        notes.category = "office".to_string();
        notes.description = "markdown notes".to_string();
        let mut shadow = item("media/player", "media", "player");
        shadow.description = "local shadow text".to_string();
        svc.set_collected_items(vec![notes, shadow]);

        let now = 1_700_000_000;
        let raw = RawAffinitySignals {
            favorites: vec![("acme/editor".to_string(), now - 86_400)],
            watched: vec![("me/notes".to_string(), now)],
            views: vec![
                ("media/player".to_string(), now - 3_600),
                ("ghost/app".to_string(), now),
            ],
            searches: vec![("markdown editor".to_string(), now)],
            repo_signals: vec![UserRepoSignal {
                full_name: "alice/editor".to_string(),
                relation: "forked".to_string(),
                language: "Rust".to_string(),
                description: "my fork".to_string(),
                stars: 1,
                forks: 0,
                updated_at: now - 10,
            }],
            user_stars: vec![("media/player".to_string(), now)],
            interest_seeds: vec!["dev".to_string()],
            ..RawAffinitySignals::default()
        };

        let merged = svc.get_catalog_items();
        for sources in [
            AffinitySources::ALL,
            AffinitySources {
                local: true,
                github: false,
            },
        ] {
            let from_store = svc.build_affinity_profile(&raw, now, sources);
            let from_slice =
                UserAffinityProfile::from_signals_with_sources(&raw, &merged, now, sources);
            assert!(from_store.has_signals);
            assert_eq!(from_store.has_signals, from_slice.has_signals);
            assert_eq!(from_store.category_weights, from_slice.category_weights);
            assert_eq!(from_store.owner_weights, from_slice.owner_weights);
            assert_eq!(from_store.token_weights, from_slice.token_weights);
            assert_eq!(from_store.known_ids, from_slice.known_ids);
            assert_eq!(from_store.signal_count, from_slice.signal_count);
            assert_eq!(from_store.seeds, from_slice.seeds);
            assert_eq!(*from_store.aliases, *from_slice.aliases);
            for tok in ["editor", "player", "codepad", "markdown", "unseen"] {
                assert_eq!(from_store.idf.weight(tok), from_slice.idf.weight(tok));
            }
        }
    }

    #[test]
    fn test_mixed_case_bucket_ids_and_owner_count() {
        let mut remote_mixed = item("Acme/Tool", "Acme", "Tool");
        remote_mixed.description = "remote tool".to_string();
        let remote_other = item("other/app", "other", "app");
        let svc = test_service(vec![remote_mixed, remote_other]);
        svc.set_collected_items(vec![
            item("acme/tool", "acme", "tool"),
            item("Local/App", "Local", "App"),
        ]);

        assert_eq!(svc.count_remote_by_owner("acme"), 1);
        assert_eq!(svc.count_remote_by_owner("local"), 0);
        assert!(svc.is_cataloged("acme/tool"));
        assert!(svc.is_cataloged("local/app"));
        assert_eq!(
            svc.get_catalog_item("acme/tool").map(|i| i.description),
            Some("remote tool".to_string())
        );

        let merged = svc.merged_summaries();
        let ids: Vec<&str> = merged.iter().map(|s| s.core.id.as_str()).collect();
        assert_eq!(ids, vec!["Acme/Tool", "other/app", "Local/App"]);

        let raw = crate::db::RawAffinitySignals {
            favorites: vec![("local/app".to_string(), 1_700_000_000)],
            ..Default::default()
        };
        let profile = svc.build_affinity_profile(
            &raw,
            1_700_000_000,
            crate::github::affinity::AffinitySources::ALL,
        );
        assert_eq!(profile.seeds.len(), 1);
        assert_eq!(profile.seeds[0].id, "local/app");
    }

    #[test]
    fn test_search_score_alternatives_priority_and_single_char_description_gate() {
        let mut alt_hit = item("rustdesk/rustdesk", "rustdesk", "rustdesk");
        alt_hit.name = "RustDesk".to_string();
        alt_hit.stars = 10;

        let mut desc_hit = item("other/helper", "other", "helper");
        desc_hit.name = "Helper".to_string();
        desc_hit.description = "不同于 TeamViewer 的轻量工具".to_string();
        desc_hit.stars = 99_999;

        let mut single_char_desc = item("other/xtool", "other", "xtool");
        single_char_desc.name = "Alpha".to_string();
        single_char_desc.description = "contains z inside".to_string();

        let svc = test_service(vec![desc_hit, alt_hit, single_char_desc]);

        let hits = svc.search_local_catalog("toDesk");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].core.id, "rustdesk/rustdesk");

        let ranked = svc.search_local_catalog("teamviewer");
        assert_eq!(ranked.len(), 2);
        assert_eq!(
            ranked[0].core.id, "rustdesk/rustdesk",
            "alternative match (38) must outrank description-only match (20) despite fewer stars"
        );
        assert_eq!(ranked[1].core.id, "other/helper");

        assert!(
            svc.search_local_catalog("z").is_empty(),
            "single-char query must not trigger description fuzzy match"
        );
        let two_char = svc.search_local_catalog("zi");
        assert!(two_char.is_empty());
        let inside_hit = svc.search_local_catalog("inside");
        assert_eq!(inside_hit.len(), 1);
        assert_eq!(inside_hit[0].core.id, "other/xtool");
    }

    #[test]
    fn test_find_similar_apps_cataloged_external_hidden_and_clamping() {
        let mut seed_item = item("rustdesk/rustdesk", "rustdesk", "rustdesk");
        seed_item.name = "RustDesk".to_string();
        seed_item.category = "system".to_string();
        seed_item.description = "远程桌面控制工具".to_string();
        seed_item.description_en = Some("Remote desktop control software".to_string());
        seed_item.stars = 80_000;

        let mut same_owner = item("rustdesk/rustdesk-server", "rustdesk", "rustdesk-server");
        same_owner.name = "RustDesk Server".to_string();
        same_owner.category = "system".to_string();
        same_owner.description = "远程桌面自建中继服务".to_string();
        same_owner.stars = 5_000;

        let mut hidden_peer = item("hidden/remote-app", "hidden", "remote-app");
        hidden_peer.name = "Hidden Remote".to_string();
        hidden_peer.category = "system".to_string();
        hidden_peer.description = "Remote desktop control alternative".to_string();
        hidden_peer.stars = 90_000;

        let mut same_track = item("acme/moonlight", "acme", "moonlight");
        same_track.name = "Moonlight".to_string();
        same_track.category = "system".to_string();
        same_track.description = "远程桌面低延迟串流".to_string();
        same_track.description_en = Some("Remote desktop streaming".to_string());
        same_track.stars = 20_000;

        let mut extra_items = Vec::new();
        for idx in 0..10 {
            let mut peer = item(&format!("peer/sys-{idx}"), "peer", &format!("sys-{idx}"));
            peer.name = format!("System Peer {idx}");
            peer.category = "system".to_string();
            peer.description = "远程桌面工具".to_string();
            peer.stars = 100 + idx as u64;
            extra_items.push(peer);
        }

        let mut unrelated = item("media/music", "media", "music");
        unrelated.name = "Music Player".to_string();
        unrelated.category = "media".to_string();
        unrelated.description = "Audio equalizer".to_string();

        let mut catalog = vec![seed_item, same_owner, hidden_peer, same_track, unrelated];
        catalog.extend(extra_items);
        let svc = test_service(catalog);

        let hidden: std::collections::HashSet<String> =
            ["hidden/remote-app".to_string()].into_iter().collect();

        // 1. 已收录应用：排除自身、排除隐藏应用、透出目标平替标签
        let plan = svc.find_similar_apps(
            &SimilarAppSeed {
                clean_id: "rustdesk/rustdesk",
                name: None,
                owner: None,
                category: None,
                description: None,
                description_en: None,
            },
            &hidden,
            Some(4),
        );
        assert!(plan.target_alternatives.iter().any(|a| a == "TeamViewer"));
        assert!(!plan
            .items
            .iter()
            .any(|i| i.app.core.id == "rustdesk/rustdesk"));
        assert!(!plan
            .items
            .iter()
            .any(|i| i.app.core.id == "hidden/remote-app"));
        assert!(!plan.items.iter().any(|i| i.app.core.id == "media/music"));
        assert_eq!(plan.items.len(), 4);
        let owner_hit = plan
            .items
            .iter()
            .find(|i| i.app.core.id == "rustdesk/rustdesk-server")
            .expect("same owner peer should match");
        assert!(owner_hit
            .reasons
            .iter()
            .any(|r| matches!(r, crate::github::affinity::Reason::Owner { .. })));

        // 2. limit 夹紧在 1..=8
        let min_clamped = svc.find_similar_apps(
            &SimilarAppSeed {
                clean_id: "rustdesk/rustdesk",
                name: None,
                owner: None,
                category: None,
                description: None,
                description_en: None,
            },
            &hidden,
            Some(0),
        );
        assert_eq!(min_clamped.items.len(), 1);
        let max_clamped = svc.find_similar_apps(
            &SimilarAppSeed {
                clean_id: "rustdesk/rustdesk",
                name: None,
                owner: None,
                category: None,
                description: None,
                description_en: None,
            },
            &hidden,
            Some(100),
        );
        assert_eq!(max_clamped.items.len(), 8);

        // 3. 未收录外部应用：仅凭 name/category/description 命中同赛道已收录应用
        let external_plan = svc.find_similar_apps(
            &SimilarAppSeed {
                clean_id: "external/anydesk-clone",
                name: Some("AnyDesk Clone"),
                owner: Some("external"),
                category: Some("system"),
                description: Some("远程桌面控制"),
                description_en: Some("Remote desktop control"),
            },
            &hidden,
            Some(4),
        );
        assert!(!external_plan.items.is_empty());
        assert!(external_plan
            .items
            .iter()
            .any(|i| i.app.core.id == "rustdesk/rustdesk"));
        assert!(external_plan.items[0].reasons.iter().any(|r| matches!(
            r,
            crate::github::affinity::Reason::Keywords { .. }
                | crate::github::affinity::Reason::Category { .. }
        )));

        // 4. 零结果边界
        let empty_plan = svc.find_similar_apps(
            &SimilarAppSeed {
                clean_id: "external/nothing",
                name: Some("Unicorn"),
                owner: Some("nobody"),
                category: Some("unknown-cat"),
                description: Some("Quantum flux"),
                description_en: None,
            },
            &hidden,
            None,
        );
        assert!(empty_plan.items.is_empty());
        assert!(empty_plan.target_alternatives.is_empty());
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::db::Database;
    use std::collections::HashMap;

    fn item(id: &str) -> CatalogItem {
        let (owner, repo) = id.split_once('/').unwrap();
        CatalogItem {
            id: id.to_string(),
            name: repo.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: "desc".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 10,
            forks: 1,
            is_verified: true,
            homepage: Some("https://example.com".to_string()),
            platforms: vec!["windows".to_string()],
            identifiers: HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        }
    }

    fn seed_repo_card(db: &Database, id: &str) {
        let (owner, repo) = id.split_once('/').unwrap();
        db.exec_write(
            "INSERT OR REPLACE INTO repo_card_cache (id, owner, repo, updated_at) VALUES (?1, ?2, ?3, 1)",
            rusqlite::params![id, owner, repo],
        )
        .unwrap();
    }

    fn has_repo_card(db: &Database, id: &str) -> bool {
        db.get_repo_card(id).unwrap().is_some()
    }

    fn fav_flag(db: &Database, id: &str) -> bool {
        db.get_favorite_entries()
            .unwrap()
            .into_iter()
            .find(|f| f.app_id == id)
            .map(|f| f.is_cataloged)
            .unwrap()
    }

    #[test]
    fn apply_remote_manifest_overwrites_retires_backfills_purges_and_refreshes_memory() {
        let db = Database::open_in_memory().unwrap();
        let svc = CatalogService::new_empty();
        db.seed_catalog_apps_if_empty(&[item("o/old")]).unwrap();
        svc.initialize_from_db(&db);
        db.add_favorite("o/old", true).unwrap();
        db.add_favorite("o/new", false).unwrap();
        let mut draft = item("o/new");
        draft.is_verified = false;
        db.upsert_custom_app_payload(&draft).unwrap();
        db.mark_custom_app_collected("o/new").unwrap();
        seed_repo_card(&db, "o/fresh");

        let url = "https://example.com/catalog.json";
        let graduated = svc
            .apply_remote_manifest(
                &db,
                &[item("o/new"), item("o/fresh")],
                Some((url, "W/\"v2\"", 1_700_000_000)),
            )
            .unwrap();

        assert_eq!(graduated, vec!["o/new".to_string()]);
        assert!(!db.exists_catalog_app("o/old").unwrap());
        assert!(db.get_custom_app("o/new").unwrap().unwrap().archived);
        assert!(!fav_flag(&db, "o/old"));
        assert!(fav_flag(&db, "o/new"));
        assert!(!has_repo_card(&db, "o/fresh"));
        assert_eq!(db.get_etag(url).unwrap().as_deref(), Some("W/\"v2\""));
        assert!(!svc.is_cataloged("o/old"));
        assert!(svc.get_remote_catalog_item("o/fresh").is_some());
        assert!(svc.get_collected_item("o/new").is_none());
    }

    #[test]
    fn apply_remote_manifest_failure_rolls_back_and_keeps_memory() {
        let db = Database::open_in_memory().unwrap();
        let svc = CatalogService::new_empty();
        db.seed_catalog_apps_if_empty(&[item("o/keep")]).unwrap();
        svc.initialize_from_db(&db);
        db.exec_write("DROP TABLE api_etag_cache", []).unwrap();

        let res = svc.apply_remote_manifest(
            &db,
            &[item("o/other")],
            Some(("https://example.com/c.json", "e", 1)),
        );
        assert!(res.is_err());
        assert!(db.exists_catalog_app("o/keep").unwrap());
        assert!(svc.is_cataloged("o/keep"));
        assert!(!svc.is_cataloged("o/other"));
    }

    #[test]
    fn initialize_from_db_loads_overlay_backfills_flags_and_purges_cards() {
        let db = Database::open_in_memory().unwrap();
        db.seed_catalog_apps_if_empty(&[item("o/remote")]).unwrap();
        db.upsert_custom_app_payload(&item("o/local")).unwrap();
        db.mark_custom_app_collected("o/local").unwrap();
        db.add_favorite("o/local", false).unwrap();
        seed_repo_card(&db, "o/remote");
        seed_repo_card(&db, "o/free");

        let svc = CatalogService::new_empty();
        svc.initialize_from_db(&db);

        assert!(svc.is_cataloged("o/remote"));
        assert!(svc.get_collected_item("o/local").is_some());
        assert!(fav_flag(&db, "o/local"));
        assert!(!has_repo_card(&db, "o/remote"));
        assert!(has_repo_card(&db, "o/free"));
    }

    #[test]
    fn collect_local_app_syncs_memory_flags_icon_slot_and_purges_card() {
        let db = Database::open_in_memory().unwrap();
        let svc = CatalogService::new_empty();
        let mut draft = item("o/app");
        draft.icon = "https://cdn.example.com/app.png".to_string();
        svc.save_custom_draft(&db, draft).unwrap();
        db.add_favorite("o/app", false).unwrap();
        seed_repo_card(&db, "o/app");
        assert!(!svc.is_cataloged("o/app"));

        let entry = svc.collect_local_app(&db, "O/App").unwrap();
        assert!(!entry.item.is_verified);
        assert!(svc.get_catalog_item("o/app").is_some());
        assert!(fav_flag(&db, "o/app"));
        assert!(!has_repo_card(&db, "o/app"));
        let cycle = db.get_icon_cycle("o/app").unwrap().unwrap();
        assert!(cycle.is_cataloged);
        assert_eq!(cycle.l1_url, "https://cdn.example.com/app.png");
        assert_eq!(cycle.level, 1);
    }

    #[test]
    fn save_custom_draft_on_active_library_entry_purges_repo_card() {
        let db = Database::open_in_memory().unwrap();
        let svc = CatalogService::new_empty();
        svc.save_custom_draft(&db, item("o/app")).unwrap();
        svc.collect_local_app(&db, "o/app").unwrap();
        seed_repo_card(&db, "o/app");

        let mut edited = item("o/app");
        edited.description = "edited".to_string();
        edited.icon = "https://cdn.example.com/new.png".to_string();
        let entry = svc.save_custom_draft(&db, edited).unwrap();

        assert!(crate::db::custom_apps::is_local_library_status(
            &entry.status
        ));
        assert!(!has_repo_card(&db, "o/app"));
        assert_eq!(
            svc.get_collected_item("o/app").unwrap().description,
            "edited"
        );
        let cycle = db.get_icon_cycle("o/app").unwrap().unwrap();
        assert_eq!(cycle.l1_url, "https://cdn.example.com/new.png");
    }

    #[test]
    fn save_custom_draft_rejects_invalid_and_forces_unverified() {
        let db = Database::open_in_memory().unwrap();
        let svc = CatalogService::new_empty();
        let mut bad = item("o/app");
        bad.id = "O/App".to_string();
        assert!(svc.save_custom_draft(&db, bad).is_err());

        let entry = svc.save_custom_draft(&db, item("o/app")).unwrap();
        assert!(!entry.item.is_verified);
        assert!(!svc.is_cataloged("o/app"));
    }

    #[test]
    fn revert_and_delete_leave_catalog_and_clear_icon_slot() {
        let db = Database::open_in_memory().unwrap();
        let svc = CatalogService::new_empty();
        let mut draft = item("o/app");
        draft.icon = "https://cdn.example.com/app.png".to_string();
        svc.save_custom_draft(&db, draft).unwrap();
        svc.collect_local_app(&db, "o/app").unwrap();
        db.add_favorite("o/app", true).unwrap();

        svc.revert_collected_to_draft(&db, "o/app").unwrap();
        assert!(!svc.is_cataloged("o/app"));
        assert!(!fav_flag(&db, "o/app"));
        let cycle = db.get_icon_cycle("o/app").unwrap().unwrap();
        assert!(!cycle.is_cataloged);
        assert!(cycle.l1_url.is_empty());

        svc.collect_local_app(&db, "o/app").unwrap();
        assert!(svc.is_cataloged("o/app"));
        assert!(svc.delete_custom_app(&db, "o/app").unwrap());
        assert!(!svc.is_cataloged("o/app"));
        assert!(db.get_custom_app("o/app").unwrap().is_none());
        assert!(!fav_flag(&db, "o/app"));
        assert!(!db.get_icon_cycle("o/app").unwrap().unwrap().is_cataloged);
        assert!(!svc.delete_custom_app(&db, "o/app").unwrap());
    }

    #[test]
    fn mark_submitted_and_withdraw_keep_entry_in_library() {
        let db = Database::open_in_memory().unwrap();
        let svc = CatalogService::new_empty();
        svc.save_custom_draft(&db, item("o/app")).unwrap();
        assert!(svc
            .mark_submitted(&db, "o/app", "https://github.com/x/y/issues/1")
            .is_err());

        svc.collect_local_app(&db, "o/app").unwrap();
        let entry = svc
            .mark_submitted(&db, "o/app", "https://github.com/x/y/issues/1")
            .unwrap();
        assert_eq!(
            entry.status,
            crate::db::custom_apps::CUSTOM_APP_STATUS_SUBMITTED
        );
        assert!(svc.is_cataloged("o/app"));

        let entry = svc.withdraw_submitted(&db, "o/app").unwrap();
        assert!(entry.pr_url.is_none());
        assert!(svc.is_cataloged("o/app"));
    }
}
