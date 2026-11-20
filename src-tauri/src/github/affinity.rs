use super::affinity_text::{self, CatalogIdf};
use super::developer_profile::EtagGetOutcome;
use super::models::{CatalogItem, GitHubRepoResponse};
use super::CatalogService;
use super::{GITHUB_API_BASE, GITHUB_STARRED_MAX_PAGE_SIZE};
use crate::db::{
    Database, FeedbackScope, RawAffinitySignals, RepoRelation, UncatalogedSignalBrief,
    UserRepoSignal,
};
use crate::models::AppSummary;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// 跨周期启动增量同步冷却窗口：6 小时（21600 秒）。
/// 用户隔天或隔半个月重新打开应用时自动触发 ETag 条件请求同步。
pub const AFFINITY_SYNC_COOLDOWN_SECS: i64 = 6 * 3600;

/// 画像同步单端点最大翻页数（每页 100 条，至多拉取 5000 条仓库信号，避免极端账号耗尽配额或阻塞同步）。
pub const AFFINITY_SYNC_MAX_PAGES: u32 = 50;

/// 设置项键：最近一次完成 GitHub 画像信号同步的 Unix 秒级时间戳。
pub const SETTING_AFFINITY_GITHUB_SYNCED_AT: &str = "affinity_github_synced_at";

/// 设置项键：Star 列表已完成 `star+json` 格式同步（后续可正常使用 ETag 条件请求）。
pub const SETTING_AFFINITY_STARRED_FORMAT_UPGRADED: &str = "affinity_starred_format_upgraded";

/// 设置项键：推荐画像是否使用本地应用信息（收藏、版本关注、已安装、浏览、搜索；默认 `"true"`）。
pub const SETTING_ENABLE_LOCAL_AFFINITY: &str = "enable_local_affinity";

/// 设置项键：推荐画像是否使用 GitHub 用户信息（Star、Fork、自有仓库；默认 `"true"`）。
/// 关闭时同时停止 GitHub 画像信号的启动、登录与手动同步（判断在 `sync_github_affinity_signals_bg`）。
pub const SETTING_ENABLE_GITHUB_AFFINITY: &str = "enable_github_affinity";

/// 布尔设置开关：缺省或非 `"false"` / `"0"` 为开启。
fn is_switch_on(db: &Database, key: &str) -> bool {
    !matches!(
        db.get_setting(key)
            .ok()
            .flatten()
            .map(|s| s.trim().to_ascii_lowercase()),
        Some(v) if v == "false" || v == "0"
    )
}

/// 本地应用信息信号源开关。
pub fn is_local_affinity_enabled(db: &Database) -> bool {
    is_switch_on(db, SETTING_ENABLE_LOCAL_AFFINITY)
}

/// GitHub 用户信息信号源开关。
pub fn is_github_affinity_enabled(db: &Database) -> bool {
    is_switch_on(db, SETTING_ENABLE_GITHUB_AFFINITY)
}

/// 推荐画像启用的信号源；任一开启即为个性化推荐，全部关闭回到编辑精选。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AffinitySources {
    pub local: bool,
    pub github: bool,
}

impl AffinitySources {
    pub const ALL: Self = Self {
        local: true,
        github: true,
    };

    pub fn load(db: &Database) -> Self {
        Self {
            local: is_local_affinity_enabled(db),
            github: is_github_affinity_enabled(db),
        }
    }

    pub fn any(self) -> bool {
        self.local || self.github
    }
}

/// 判断距上次同步是否已超过冷却窗口（6 小时），用于应用启动时跨周期保鲜检查。
pub fn should_sync_affinity_on_startup(last_synced_at: Option<i64>, now_secs: i64) -> bool {
    match last_synced_at {
        None => true,
        Some(ts) if ts <= 0 => true,
        Some(ts) => now_secs.saturating_sub(ts) >= AFFINITY_SYNC_COOLDOWN_SECS,
    }
}

impl CatalogService {
    /// 用户 GitHub Star 仓库画像同步端点（按页生成 canonical ETag 缓存键）。
    pub fn affinity_starred_page_endpoint(page: u32) -> String {
        format!(
            "{}/user/starred?per_page={}&page={}",
            GITHUB_API_BASE,
            GITHUB_STARRED_MAX_PAGE_SIZE,
            page.max(1)
        )
    }

    /// 用户个人及 Fork 仓库画像同步端点（按页生成 canonical ETag 缓存键）。
    pub fn affinity_owner_repos_page_endpoint(page: u32) -> String {
        format!(
            "{}/user/repos?type=owner&sort=updated&per_page={}&page={}",
            GITHUB_API_BASE,
            GITHUB_STARRED_MAX_PAGE_SIZE,
            page.max(1)
        )
    }

    /// 检查本地 `affinity_github_synced_at` 是否已过冷却期。
    pub fn should_sync_affinity(db: &Database, now_secs: i64) -> bool {
        let last = db
            .get_setting(SETTING_AFFINITY_GITHUB_SYNCED_AT)
            .ok()
            .flatten()
            .and_then(|s| s.trim().parse::<i64>().ok());
        should_sync_affinity_on_startup(last, now_secs)
    }

    /// 派生后台异步任务执行 GitHub 画像信号静默同步，完成后广播 `zstore://affinity-updated`。
    pub fn spawn_github_affinity_sync(db: Arc<Mutex<Database>>, token: String) {
        let clean = token.trim().to_string();
        if clean.is_empty() {
            return;
        }
        tauri::async_runtime::spawn(async move {
            if Self::sync_github_affinity_signals_bg(&db, &clean, None)
                .await
                .is_ok()
            {
                crate::notify_affinity_updated();
            }
        });
    }

    /// ETag 感知的 GitHub 画像信号分页同步，仅在两个端点均成功时更新同步时间戳。
    pub async fn sync_github_affinity_signals_bg(
        db_mutex: &Mutex<Database>,
        token: &str,
        api_base: Option<&str>,
    ) -> Result<usize, String> {
        let clean_token = token.trim();
        if clean_token.is_empty() {
            return Err("GitHub Token 为空，跳过画像同步".to_string());
        }
        let github_enabled = {
            let db = db_mutex.lock().map_err(|e| e.to_string())?;
            is_github_affinity_enabled(&db)
        };
        if !github_enabled {
            return Err("推荐偏好已关闭 GitHub 用户信息，未同步".to_string());
        }

        let starred_rels = [RepoRelation::Starred.as_str()];
        let owner_rels = [RepoRelation::Forked.as_str(), RepoRelation::Owned.as_str()];

        let client = crate::shared_http_client();
        let headers = super::http::bearer_headers(Some(clean_token));
        let mut starred_headers = headers.clone();
        starred_headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static(STARRED_ACCEPT),
        );
        let now = crate::now_secs();
        let starred_ctx = PageFetchCtx {
            db_mutex,
            client: &client,
            headers: &starred_headers,
            api_base,
            now,
            time_source: SignalTimeSource::StarredAt,
        };
        let repos_ctx = PageFetchCtx {
            headers: &headers,
            time_source: SignalTimeSource::RepoActivity,
            ..starred_ctx
        };

        let (starred_res, repos_res) = tokio::join!(
            fetch_paginated_repo_signals(
                &starred_ctx,
                Self::affinity_starred_page_endpoint,
                |_| RepoRelation::Starred,
            ),
            fetch_paginated_repo_signals(
                &repos_ctx,
                Self::affinity_owner_repos_page_endpoint,
                |r| {
                    if r.fork.unwrap_or(false) {
                        RepoRelation::Forked
                    } else {
                        RepoRelation::Owned
                    }
                },
            )
        );

        let db = db_mutex.lock().map_err(|e| e.to_string())?;

        let starred_ok = apply_paginated_signal_outcome(
            &db,
            &starred_rels,
            Self::affinity_starred_page_endpoint,
            starred_res,
            now,
        );
        let repos_ok = apply_paginated_signal_outcome(
            &db,
            &owner_rels,
            Self::affinity_owner_repos_page_endpoint,
            repos_res,
            now,
        );

        if !starred_ok && !repos_ok {
            return Err("GitHub 画像信号同步失败：无法获取 Star 或个人仓库列表".to_string());
        }

        if starred_ok {
            let _ = db.set_setting(SETTING_AFFINITY_STARRED_FORMAT_UPGRADED, "true");
        }
        if starred_ok && repos_ok {
            let _ = db.set_setting(SETTING_AFFINITY_GITHUB_SYNCED_AT, &now.to_string());
        }

        let final_count = db.get_user_repo_signals().map(|v| v.len()).unwrap_or(0);
        Ok(final_count)
    }
}

struct CachedPageWrite {
    endpoint_url: String,
    etag: String,
    payload_json: String,
}

struct PaginatedSignalsResult {
    signals: Vec<UserRepoSignal>,
    any_fresh: bool,
    last_page: u32,
    fresh_pages: Vec<CachedPageWrite>,
    touched_pages: Vec<String>,
}

enum PaginatedFetchErr {
    Unauthorized,
    Failed,
}

struct ParsedSignalPage {
    signals: Vec<UserRepoSignal>,
    raw_count: usize,
}

/// `/user/starred` 的媒体类型：响应元素包装为 `{ starred_at, repo }`，带真实标星时间。
pub const STARRED_ACCEPT: &str = "application/vnd.github.star+json";

/// 仓库信号的时间来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalTimeSource {
    /// 用户标星时间 `starred_at`。
    StarredAt,
    /// 仓库最近推送 `pushed_at`，其次 `updated_at`。
    RepoActivity,
}

/// Star 列表元素：`star+json` 包装格式或裸仓库（服务端忽略媒体类型或旧缓存载荷）。
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum StarredPageItem {
    Wrapped {
        #[serde(default)]
        starred_at: Option<String>,
        repo: GitHubRepoResponse,
    },
    Bare(GitHubRepoResponse),
}

fn parse_rfc3339_secs(raw: Option<&str>) -> Option<i64> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|dt| dt.unix_timestamp())
}

/// 解析一页仓库信号；缺少可用时间时按分页全局序号回退，保持列表降序顺序。
fn parse_repo_signals_page<F>(
    json_text: &str,
    now: i64,
    idx_offset: usize,
    time_source: SignalTimeSource,
    classify: &F,
) -> Option<ParsedSignalPage>
where
    F: Fn(&GitHubRepoResponse) -> RepoRelation,
{
    let items: Vec<StarredPageItem> = serde_json::from_str(json_text).ok()?;
    let raw_count = items.len();
    let signals = items
        .into_iter()
        .enumerate()
        .filter_map(|(i, item)| {
            let (starred_at, r) = match item {
                StarredPageItem::Wrapped { starred_at, repo } => (starred_at, repo),
                StarredPageItem::Bare(repo) => (None, repo),
            };
            let full_name = crate::forge::canonical_app_id(r.full_name.as_deref()?)?;
            let relation = classify(&r).as_str().to_string();
            let real_ts = match time_source {
                SignalTimeSource::StarredAt => parse_rfc3339_secs(starred_at.as_deref()),
                SignalTimeSource::RepoActivity => parse_rfc3339_secs(r.pushed_at.as_deref())
                    .or_else(|| parse_rfc3339_secs(r.updated_at.as_deref())),
            };
            let global_idx = (idx_offset + i) as i64;
            let updated_at = real_ts.unwrap_or_else(|| now.saturating_sub(global_idx * 3600));
            Some(UserRepoSignal {
                full_name,
                relation,
                language: r.language.unwrap_or_default(),
                description: r.description.unwrap_or_default(),
                stars: r.stargazers_count.unwrap_or(0),
                forks: r.forks_count.unwrap_or(0),
                updated_at,
            })
        })
        .collect();
    Some(ParsedSignalPage { signals, raw_count })
}

/// Star 页缓存载荷有条目却不含 `starred_at` 时是旧格式。尚未以 `star+json` 完整同步过时
/// 跳过 ETag 重新拉取；同步过一次后即使服务端仍返回旧格式也照常发条件请求。
fn is_legacy_starred_payload(payload: &str) -> bool {
    payload.contains('{') && !payload.contains("\"starred_at\"")
}

/// 单个分页端点拉取的共享上下文。
#[derive(Clone, Copy)]
struct PageFetchCtx<'a> {
    db_mutex: &'a Mutex<Database>,
    client: &'a reqwest::Client,
    headers: &'a reqwest::header::HeaderMap,
    api_base: Option<&'a str>,
    now: i64,
    time_source: SignalTimeSource,
}

async fn fetch_paginated_repo_signals<E, F>(
    ctx: &PageFetchCtx<'_>,
    endpoint_for_page: E,
    classify: F,
) -> Result<PaginatedSignalsResult, PaginatedFetchErr>
where
    E: Fn(u32) -> String,
    F: Fn(&GitHubRepoResponse) -> RepoRelation,
{
    let now = ctx.now;
    let mut all_signals: Vec<UserRepoSignal> = Vec::new();
    let mut seen_keys: HashSet<(String, String)> = HashSet::new();
    let mut fresh_pages: Vec<CachedPageWrite> = Vec::new();
    let mut touched_pages: Vec<String> = Vec::new();
    let mut any_fresh = false;
    let mut last_page = 0u32;
    let mut idx_offset = 0usize;

    for page in 1..=AFFINITY_SYNC_MAX_PAGES {
        let ep = endpoint_for_page(page);
        let (cached_etag, cached_payload) = {
            let db = ctx.db_mutex.lock().map_err(|_| PaginatedFetchErr::Failed)?;
            let payload = db.get_cached_payload(&ep).ok().flatten();
            let legacy = ctx.time_source == SignalTimeSource::StarredAt
                && db
                    .get_setting(SETTING_AFFINITY_STARRED_FORMAT_UPGRADED)
                    .ok()
                    .flatten()
                    .is_none()
                && payload
                    .as_deref()
                    .map(is_legacy_starred_payload)
                    .unwrap_or(false);
            let etag = if payload.is_some() && !legacy {
                db.get_etag(&ep)
                    .ok()
                    .flatten()
                    .filter(|e| !e.trim().is_empty())
            } else {
                None
            };
            (etag, payload)
        };

        let (outcome, has_next) = super::http::get_with_etag_with_link(
            ctx.client,
            &ep,
            ctx.api_base,
            ctx.headers,
            cached_etag.as_deref(),
        )
        .await;

        match outcome {
            EtagGetOutcome::Unauthorized => {
                crate::notify_auth_expired();
                return Err(PaginatedFetchErr::Unauthorized);
            }
            EtagGetOutcome::Failed => {
                return Err(PaginatedFetchErr::Failed);
            }
            EtagGetOutcome::Fresh { text, etag } => {
                let Some(parsed) =
                    parse_repo_signals_page(&text, now, idx_offset, ctx.time_source, &classify)
                else {
                    return Err(PaginatedFetchErr::Failed);
                };
                idx_offset += parsed.raw_count;
                any_fresh = true;
                last_page = page;
                for sig in parsed.signals {
                    if seen_keys.insert((sig.full_name.clone(), sig.relation.clone())) {
                        all_signals.push(sig);
                    }
                }
                fresh_pages.push(CachedPageWrite {
                    endpoint_url: ep,
                    etag: etag.unwrap_or_default(),
                    payload_json: text,
                });
                if !has_next || parsed.raw_count == 0 {
                    break;
                }
            }
            EtagGetOutcome::NotModified => {
                let Some(payload) = cached_payload else {
                    return Err(PaginatedFetchErr::Failed);
                };
                let Some(parsed) =
                    parse_repo_signals_page(&payload, now, idx_offset, ctx.time_source, &classify)
                else {
                    return Err(PaginatedFetchErr::Failed);
                };
                idx_offset += parsed.raw_count;
                last_page = page;
                touched_pages.push(ep);
                for sig in parsed.signals {
                    if seen_keys.insert((sig.full_name.clone(), sig.relation.clone())) {
                        all_signals.push(sig);
                    }
                }
                let should_continue = has_next || parsed.raw_count >= GITHUB_STARRED_MAX_PAGE_SIZE;
                if !should_continue || parsed.raw_count == 0 {
                    break;
                }
            }
        }
    }

    Ok(PaginatedSignalsResult {
        signals: all_signals,
        any_fresh,
        last_page,
        fresh_pages,
        touched_pages,
    })
}

fn apply_paginated_signal_outcome<E>(
    db: &Database,
    relations: &[&str],
    endpoint_for_page: E,
    result: Result<PaginatedSignalsResult, PaginatedFetchErr>,
    now: i64,
) -> bool
where
    E: Fn(u32) -> String,
{
    let Ok(res) = result else {
        return false;
    };
    let has_existing = db.has_user_repo_signals_for_relations(relations);
    if res.any_fresh || !has_existing {
        let _ = db.replace_user_repo_signals_by_relations(relations, &res.signals);
    }
    // 分页 ETag 保存 / 保鲜 / 尾页清理合并为单事务提交；失败整体回滚，下次同步重试。
    let _ = db.with_immediate_transaction(|| {
        for page in &res.fresh_pages {
            db.save_etag(&page.endpoint_url, &page.etag, &page.payload_json, now)?;
        }
        for ep in &res.touched_pages {
            db.touch_etag(ep, now)?;
        }
        if res.last_page > 0 {
            for stale_page in (res.last_page + 1)..=AFFINITY_SYNC_MAX_PAGES {
                let stale_ep = endpoint_for_page(stale_page);
                if !db.has_etag_entry(&stale_ep)? {
                    break;
                }
                db.delete_etag(&stale_ep)?;
            }
        }
        Ok(())
    });
    true
}

/// 推荐种子与用户的关系（推荐理由「因为你 X 了 Y」中的 X）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeedRelation {
    Favorite,
    Installed,
    Watched,
    Starred,
    Forked,
    Owned,
}

/// 画像中的一个推荐种子：命中目录、用户与之有显式关系的应用。
#[derive(Debug, Clone, PartialEq)]
pub struct SeedRef {
    pub id: String,
    pub relation: SeedRelation,
    /// 基准权重 × 时间衰减，用于挑选近期最强的种子。
    pub strength: f64,
    pub category: String,
}

/// 推荐理由（与打分同源，见 `affinity_explain`）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reason {
    Seed {
        seed_id: String,
        relation: SeedRelation,
    },
    Category {
        category: String,
    },
    Owner {
        owner: String,
    },
    Keywords {
        tokens: Vec<String>,
    },
    Fresh {
        added_at: String,
    },
    Explore {
        category: String,
    },
}

/// 用户本地亲和度画像（内存中由 `RawAffinitySignals` 实时聚合）。
#[derive(Debug, Clone, Default)]
pub struct UserAffinityProfile {
    pub has_signals: bool,
    pub category_weights: HashMap<String, f64>,
    pub owner_weights: HashMap<String, f64>,
    pub token_weights: HashMap<String, f64>,
    /// 已收藏 / 关注 / Star / 已安装的应用：推荐时让位推新。
    pub known_ids: HashSet<String>,
    /// 参与聚合的信号条数（画像状态分档与隐私看板使用）。
    pub signal_count: usize,
    /// 已安装应用：不进精选页推荐区块。
    pub installed_ids: HashSet<String>,
    /// 应用内显式关系（收藏 ∪ 关注 ∪ 已安装），不受信号源开关影响：精选货架硬排除。
    pub explicit_local_ids: HashSet<String>,
    /// 有效期内被标记「不感兴趣」的应用。
    pub dismissed_app_ids: HashSet<String>,
    /// 有效期内被标记「少推这类」的分类 key。
    pub dismissed_categories: HashSet<String>,
    /// 推荐种子，按 `strength` 降序、同 id 只保留最强关系。
    pub seeds: Vec<SeedRef>,
    /// 构建画像时目录的逆文档频率（与目录共享，目录不变时不重算）。
    pub idf: Arc<CatalogIdf>,
    /// 目录条目别名（小写 id → aliases），供种子相似度使用。
    pub aliases: Arc<HashMap<String, Vec<String>>>,
}

/// 画像构建所需的目录只读视图：按小写 id 点查、按小写仓库名反查上游，
/// 以及目录级 IDF 与别名（实现方可缓存，画像只持有 `Arc`）。
pub trait AffinityCatalog {
    fn item(&self, id_lower: &str) -> Option<&CatalogItem>;
    /// 仓库名相同的目录条目中星数最高者；并列取目录顺序中最后一条。
    fn top_by_repo_name(&self, repo_lower: &str) -> Option<&CatalogItem>;
    fn idf(&self) -> Arc<CatalogIdf>;
    fn aliases(&self) -> Arc<HashMap<String, Vec<String>>>;
}

/// 基于目录切片现建索引的视图（单测与一次性调用；常驻目录走 `CatalogService::build_affinity_profile`）。
pub struct SliceCatalog<'a> {
    by_id: HashMap<String, &'a CatalogItem>,
    by_repo_name: HashMap<String, Vec<&'a CatalogItem>>,
    idf: Arc<CatalogIdf>,
    aliases: Arc<HashMap<String, Vec<String>>>,
}

impl<'a> SliceCatalog<'a> {
    pub fn new(catalog: &'a [CatalogItem]) -> Self {
        let mut by_id: HashMap<String, &CatalogItem> = HashMap::with_capacity(catalog.len());
        let mut by_repo_name: HashMap<String, Vec<&CatalogItem>> = HashMap::new();
        let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
        for item in catalog {
            let id = item.id.to_lowercase();
            if !item.aliases.is_empty() {
                aliases.insert(id.clone(), item.aliases.clone());
            }
            by_id.insert(id, item);
            by_repo_name
                .entry(item.repo.to_lowercase())
                .or_default()
                .push(item);
        }
        Self {
            by_id,
            by_repo_name,
            idf: Arc::new(CatalogIdf::from_catalog(catalog)),
            aliases: Arc::new(aliases),
        }
    }
}

impl AffinityCatalog for SliceCatalog<'_> {
    fn item(&self, id_lower: &str) -> Option<&CatalogItem> {
        self.by_id.get(id_lower).copied()
    }

    fn top_by_repo_name(&self, repo_lower: &str) -> Option<&CatalogItem> {
        self.by_repo_name
            .get(repo_lower)
            .and_then(|list| list.iter().max_by_key(|c| c.stars).copied())
    }

    fn idf(&self) -> Arc<CatalogIdf> {
        self.idf.clone()
    }

    fn aliases(&self) -> Arc<HashMap<String, Vec<String>>> {
        self.aliases.clone()
    }
}

/// 各信号的时间衰减半衰期（天）。
const DECAY_HALF_LIFE_DAYS: f64 = 30.0;
const SHORT_DECAY_HALF_LIFE_DAYS: f64 = 7.0;
/// 浏览历史单应用权重模型参数：基准权重 0.6，5 分钟突发防抖，log2 上限系数 3.5（封顶 2.1）。
const VIEW_BASE_WEIGHT: f64 = 0.6;
const VIEW_BURST_DEBOUNCE_SECS: i64 = 300;
const VIEW_LOG_CAP: f64 = 3.5;

/// 本地通道与 GitHub 通道都有信号时的融合系数。
const LOCAL_CHANNEL_SHARE: f64 = 0.65;
const GITHUB_CHANNEL_SHARE: f64 = 0.35;
/// 软饱和归一化的置信尺度。
const CAT_TAU: f64 = 2.2;
const OWNER_TAU: f64 = 2.5;
const TOKEN_TAU: f64 = 2.0;
/// 兴趣种子分类的最低权重。
const INTEREST_SEED_FLOOR: f64 = 0.75;
/// 「少推这类」分类在打分时的抑制量。
const DISMISSED_CATEGORY_PENALTY: f64 = 1.5;
/// 已知应用（收藏 / 关注 / Star / 已装）在主信息流中的让位量。
const KNOWN_PENALTY: f64 = 1.2;
/// 关键词前 3 名的单调加权系数。
const TOKEN_RANK_COEFFS: [f64; 3] = [0.60, 0.25, 0.15];

/// 计算同一应用多次浏览的衰减对数权重：`0.6 * min(log2(1 + c_eff), 3.5)`。
/// 5 分钟窗口内的连续浏览只计一次；其余每次按 7 天半衰期衰减后求和得到 `c_eff`。
fn compute_effective_view_weight(timestamps: &[i64], now_secs: i64) -> f64 {
    if timestamps.is_empty() {
        return 0.0;
    }
    let mut sorted = timestamps.to_vec();
    sorted.sort_unstable();

    let mut c_eff = 0.0_f64;
    let mut last_kept: Option<i64> = None;
    for ts in sorted {
        if let Some(prev) = last_kept {
            if ts - prev < VIEW_BURST_DEBOUNCE_SECS {
                continue;
            }
        }
        last_kept = Some(ts);
        c_eff += time_decay_with(ts, now_secs, SHORT_DECAY_HALF_LIFE_DAYS, 0.0);
    }
    if c_eff <= 0.0 {
        return 0.0;
    }
    let factor = (1.0 + c_eff).log2().min(VIEW_LOG_CAP);
    VIEW_BASE_WEIGHT * factor
}

/// 30 天半衰期时间衰减函数，保底系数 `0.25`。
fn time_decay(timestamp: i64, now_secs: i64) -> f64 {
    time_decay_with(timestamp, now_secs, DECAY_HALF_LIFE_DAYS, 0.25)
}

/// 指定半衰期与保底系数的时间衰减。
fn time_decay_with(timestamp: i64, now_secs: i64, half_life_days: f64, floor: f64) -> f64 {
    if timestamp <= 0 || now_secs <= timestamp {
        return 1.0;
    }
    let dt = (now_secs - timestamp) as f64;
    let half_life = half_life_days * 86400.0;
    let lambda = std::f64::consts::LN_2 / half_life;
    (-lambda * dt).exp().max(floor)
}

/// 分项亲和度（`affinity_boost` 与 `affinity_explain` 共用）。
struct AffinityBreakdown {
    cat: f64,
    owner: f64,
    tok: f64,
    /// 命中的关键词（按 `用户词权重 × IDF` 降序，至多 3 个）。
    matched_tokens: Vec<String>,
    cat_penalty: f64,
    known_penalty: f64,
}

/// 推荐理由的最低分项贡献：低于此值的分项不作为理由展示。
const REASON_MIN_CONTRIBUTION: f64 = 0.25;
/// 单个推荐条目最多展示的理由数。
pub const MAX_REASONS: usize = 2;

/// 目录外 GitHub 仓库的可信度系数：`0.7 + 0.3 * (1 - exp(-stars / 50))`。
/// 压低零星空壳仓库，不放大高星头部。
fn uncataloged_repo_credibility(stars: u64) -> f64 {
    0.7 + 0.3 * (1.0 - (-(stars as f64) / 50.0).exp())
}

/// 软饱和归一化：`W(k) = (v_k / max_v) * (1 - exp(-v_k / tau))`
fn normalize_soft_saturated(raw: HashMap<String, f64>, tau: f64) -> HashMap<String, f64> {
    let max_v = raw.values().copied().fold(0.0_f64, f64::max);
    if max_v <= 1e-9 {
        return HashMap::new();
    }
    raw.into_iter()
        .filter_map(|(k, v)| {
            if v <= 1e-9 {
                None
            } else {
                let rel = (v / max_v).clamp(0.0, 1.0);
                let conf = 1.0 - (-v / tau).exp();
                Some((k, (rel * conf).clamp(0.0, 1.0)))
            }
        })
        .collect()
}

/// 按维度融合两个通道：两侧都有值时 `0.65 * local + 0.35 * github`，否则取有值的一侧。
fn fuse_channels(
    local: HashMap<String, f64>,
    github: HashMap<String, f64>,
) -> HashMap<String, f64> {
    if local.is_empty() {
        return github;
    }
    if github.is_empty() {
        return local;
    }
    let mut out: HashMap<String, f64> = HashMap::with_capacity(local.len() + github.len());
    for (k, v) in &local {
        *out.entry(k.clone()).or_insert(0.0) += LOCAL_CHANNEL_SHARE * v;
    }
    for (k, v) in &github {
        *out.entry(k.clone()).or_insert(0.0) += GITHUB_CHANNEL_SHARE * v;
    }
    out
}

/// 从文本中提取画像词元（中英双语，见 `affinity_text::extract_tokens`）。
pub fn extract_affinity_tokens(text: &str) -> Vec<String> {
    affinity_text::extract_tokens(text)
}

/// 将目录外仓库按 `language`、`description` 与 `full_name` 映射到标准分类
/// （词边界匹配，见 `affinity_text::infer_categories`）。
pub fn infer_categories_from_repo(
    language: &str,
    description: &str,
    full_name: &str,
) -> Vec<(&'static str, f64)> {
    affinity_text::infer_categories(language, description, full_name)
}

/// 单个信号通道（本地应用信息或 GitHub 用户信息）的原始累加器。
#[derive(Default)]
struct ChannelAcc {
    raw_cat: HashMap<String, f64>,
    raw_owner: HashMap<String, f64>,
    raw_tokens: HashMap<String, f64>,
}

impl ChannelAcc {
    fn add_category(&mut self, cat: &str, w: f64) {
        let key = cat.trim().to_lowercase();
        if !key.is_empty() && w > 0.0 {
            *self.raw_cat.entry(key).or_insert(0.0) += w;
        }
    }

    fn add_owner(&mut self, owner: &str, w: f64) {
        let key = owner.trim().to_lowercase();
        if !key.is_empty() && w > 0.0 {
            *self.raw_owner.entry(key).or_insert(0.0) += w;
        }
    }

    /// 词元权重乘以目录 IDF，泛化词贡献被压低。
    fn add_token_list(&mut self, tokens: Vec<String>, w: f64, idf: &CatalogIdf) {
        for tok in tokens {
            let tw = w * idf.weight(&tok);
            *self.raw_tokens.entry(tok).or_insert(0.0) += tw;
        }
    }

    fn add_tokens(&mut self, text: &str, w: f64, idf: &CatalogIdf) {
        self.add_token_list(extract_affinity_tokens(text), w, idf);
    }

    fn add_catalog_item(&mut self, item: &CatalogItem, w: f64, idf: &CatalogIdf) {
        self.add_category(&item.category, w);
        self.add_owner(&item.owner, w);
        self.add_token_list(affinity_text::extract_catalog_item_tokens(item), w, idf);
    }

    /// 未命中目录的本地应用：优先用 `app_details` 概要，否则只凭 `owner/repo`。
    fn add_uncataloged_app(
        &mut self,
        id_lower: &str,
        brief: Option<&UncatalogedSignalBrief>,
        w: f64,
        idf: &CatalogIdf,
    ) {
        let (owner_part, repo_part) = id_lower.split_once('/').unwrap_or(("", id_lower));
        match brief {
            Some(b) => {
                let text = affinity_text::app_text(
                    &b.name,
                    &b.repo,
                    &b.description,
                    b.description_en.as_deref(),
                    &[],
                );
                let cat = b.category.trim().to_lowercase();
                if affinity_text::is_standard_category(&cat) {
                    self.add_category(&cat, w);
                } else {
                    for (c, conf) in infer_categories_from_repo("", &text, id_lower) {
                        self.add_category(c, w * conf);
                    }
                }
                let owner = if b.owner.trim().is_empty() {
                    owner_part
                } else {
                    b.owner.as_str()
                };
                self.add_owner(owner, w);
                self.add_tokens(&text, w, idf);
            }
            None => {
                for (c, conf) in infer_categories_from_repo("", "", id_lower) {
                    self.add_category(c, w * conf);
                }
                self.add_owner(owner_part, w);
                self.add_tokens(repo_part, w, idf);
            }
        }
    }

    fn normalize(self) -> ChannelWeights {
        ChannelWeights {
            category: normalize_soft_saturated(self.raw_cat, CAT_TAU),
            owner: normalize_soft_saturated(self.raw_owner, OWNER_TAU),
            token: normalize_soft_saturated(self.raw_tokens, TOKEN_TAU),
        }
    }
}

/// 一个通道归一化后的分类、作者、词元权重（均在 `[0, 1]`）。
struct ChannelWeights {
    category: HashMap<String, f64>,
    owner: HashMap<String, f64>,
    token: HashMap<String, f64>,
}

impl ChannelWeights {
    /// 按维度融合本地与 GitHub 两个通道（见 `fuse_channels`）。
    fn fuse(local: Self, github: Self) -> Self {
        Self {
            category: fuse_channels(local.category, github.category),
            owner: fuse_channels(local.owner, github.owner),
            token: fuse_channels(local.token, github.token),
        }
    }
}

/// 跨通道共享的画像状态：已知集合、信号计数与推荐种子。
#[derive(Default)]
struct ProfileAcc {
    local: ChannelAcc,
    github: ChannelAcc,
    known_ids: HashSet<String>,
    signal_count: usize,
    seeds: HashMap<String, SeedRef>,
}

impl ProfileAcc {
    fn add_seed(&mut self, item: &CatalogItem, relation: SeedRelation, strength: f64) {
        let id = item.id.to_lowercase();
        let replace = self
            .seeds
            .get(&id)
            .map(|s| strength > s.strength)
            .unwrap_or(true);
        if replace {
            self.seeds.insert(
                id.clone(),
                SeedRef {
                    id,
                    relation,
                    strength,
                    category: item.category.trim().to_lowercase(),
                },
            );
        }
    }
}

impl UserAffinityProfile {
    /// 从本地信号快照与当前收录库实时聚合用户亲和度画像（全部信号源）。
    pub fn from_signals(raw: &RawAffinitySignals, catalog: &[CatalogItem], now_secs: i64) -> Self {
        Self::from_signals_with_sources(raw, catalog, now_secs, AffinitySources::ALL)
    }

    /// 按 `sources` 开关聚合用户亲和度画像；已安装/显式关系与负反馈始终加载以排除已知与屏蔽项。
    pub fn from_signals_with_sources(
        raw: &RawAffinitySignals,
        catalog: &[CatalogItem],
        now_secs: i64,
        sources: AffinitySources,
    ) -> Self {
        Self::from_catalog(raw, &SliceCatalog::new(catalog), now_secs, sources)
    }

    /// 与 `from_signals_with_sources` 同一算法，目录经只读视图按需点查，
    /// IDF 与别名直接复用视图提供的共享实例。
    pub fn from_catalog<C: AffinityCatalog + ?Sized>(
        raw: &RawAffinitySignals,
        catalog: &C,
        now_secs: i64,
        sources: AffinitySources,
    ) -> Self {
        let empty_pairs: Vec<(String, i64)> = Vec::new();
        let empty_repo: Vec<UserRepoSignal> = Vec::new();
        let (favorites, watched, installed, views, searches) = if sources.local {
            (
                &raw.favorites,
                &raw.watched,
                &raw.installed,
                &raw.views,
                &raw.searches,
            )
        } else {
            (
                &empty_pairs,
                &empty_pairs,
                &empty_pairs,
                &empty_pairs,
                &empty_pairs,
            )
        };
        let (repo_signals, user_stars) = if sources.github {
            (&raw.repo_signals, &raw.user_stars)
        } else {
            (&empty_repo, &empty_pairs)
        };

        let idf = catalog.idf();
        let aliases = catalog.aliases();

        let lower_ids = |pairs: &[(String, i64)]| -> Vec<String> {
            pairs
                .iter()
                .map(|(id, _)| id.trim().to_lowercase())
                .filter(|id| !id.is_empty())
                .collect()
        };
        let installed_ids: HashSet<String> = lower_ids(&raw.installed).into_iter().collect();
        let explicit_local_ids: HashSet<String> = lower_ids(&raw.favorites)
            .into_iter()
            .chain(lower_ids(&raw.watched))
            .chain(installed_ids.iter().cloned())
            .collect();

        let mut acc = ProfileAcc::default();

        // 1. 本地显式关系：收藏 4.0、关注 3.5、已安装 3.2，30 天半衰期
        let explicit = [
            (favorites, 4.0, SeedRelation::Favorite),
            (watched, 3.5, SeedRelation::Watched),
            (installed, 3.2, SeedRelation::Installed),
        ];
        for (pairs, base_w, relation) in explicit {
            for (app_id, ts) in pairs {
                let id_lower = app_id.trim().to_lowercase();
                if id_lower.is_empty() {
                    continue;
                }
                let decay = time_decay(*ts, now_secs);
                let w = base_w * decay;
                acc.known_ids.insert(id_lower.clone());
                acc.signal_count += 1;
                if let Some(item) = catalog.item(&id_lower) {
                    acc.local.add_catalog_item(item, w, &idf);
                    acc.add_seed(item, relation, w);
                } else {
                    let brief = raw.uncataloged_briefs.get(&id_lower);
                    acc.local.add_uncataloged_app(&id_lower, brief, w, &idf);
                }
            }
        }

        // 2. 浏览历史：同应用去抖合并后按时间衰减求有效次数，再做 log2(1 + c_eff)
        // 加权并封顶（<= 2.1）；不计入已知，按去重应用数计入 signal_count。
        let mut views_by_app: HashMap<String, Vec<i64>> = HashMap::new();
        for (app_id, ts) in views {
            let id_lower = app_id.trim().to_lowercase();
            if !id_lower.is_empty() {
                views_by_app.entry(id_lower).or_default().push(*ts);
            }
        }
        let mut view_ids: Vec<&String> = views_by_app.keys().collect();
        view_ids.sort();
        for id_lower in view_ids {
            let w = compute_effective_view_weight(&views_by_app[id_lower], now_secs);
            if w <= 1e-9 {
                continue;
            }
            acc.signal_count += 1;
            match catalog.item(id_lower) {
                Some(item) => acc.local.add_catalog_item(item, w, &idf),
                None => {
                    let brief = raw.uncataloged_briefs.get(id_lower);
                    acc.local.add_uncataloged_app(id_lower, brief, w, &idf);
                }
            }
        }

        // 3. 搜索词：基准权重 0.4，7 天半衰期，只进关键词词袋
        for (query, ts) in searches {
            if extract_affinity_tokens(query).is_empty() {
                continue;
            }
            acc.signal_count += 1;
            let w = 0.4 * time_decay_with(*ts, now_secs, SHORT_DECAY_HALF_LIFE_DAYS, 0.0);
            acc.local.add_tokens(query, w, &idf);
        }

        // 4. GitHub 仓库信号：forked 3.8、starred 3.0、owned 2.4
        let mut starred_in_repo_signals: HashSet<String> = HashSet::new();
        for sig in repo_signals {
            let full_lower = sig.full_name.trim().to_lowercase();
            if full_lower.is_empty() {
                continue;
            }
            let rel_kind = sig.relation_kind();
            let base_w = match rel_kind {
                Some(RepoRelation::Forked) => 3.8,
                Some(RepoRelation::Starred) => {
                    starred_in_repo_signals.insert(full_lower.clone());
                    3.0
                }
                Some(RepoRelation::Owned) => 2.4,
                None => 2.0,
            };
            let decay = time_decay(sig.updated_at, now_secs);
            acc.signal_count += 1;

            // 精确匹配目录；Fork 仓库 (<user>/<repo>) 额外按 <repo> 反查上游条目
            let matched_cat_item: Option<&CatalogItem> = catalog.item(&full_lower).or_else(|| {
                if rel_kind == Some(RepoRelation::Forked) {
                    let (_, repo_part) = full_lower.split_once('/')?;
                    catalog.top_by_repo_name(repo_part)
                } else {
                    None
                }
            });

            if let Some(item) = matched_cat_item {
                let w = base_w * decay;
                acc.known_ids.insert(item.id.to_lowercase());
                acc.github.add_catalog_item(item, w, &idf);
                let relation = match rel_kind {
                    Some(RepoRelation::Forked) => Some(SeedRelation::Forked),
                    Some(RepoRelation::Starred) => Some(SeedRelation::Starred),
                    Some(RepoRelation::Owned) => Some(SeedRelation::Owned),
                    None => None,
                };
                if let Some(relation) = relation {
                    acc.add_seed(item, relation, w);
                }
            } else {
                let w = base_w * decay * uncataloged_repo_credibility(sig.stars);
                for (cat, conf) in
                    infer_categories_from_repo(&sig.language, &sig.description, &full_lower)
                {
                    acc.github.add_category(cat, w * conf);
                }
                let (owner, repo_part) = full_lower.split_once('/').unwrap_or(("", &full_lower));
                if rel_kind == Some(RepoRelation::Starred) {
                    acc.github.add_owner(owner, w * 0.6);
                }
                acc.github.add_tokens(
                    &format!("{} {}", repo_part, sig.description),
                    w * 0.85,
                    &idf,
                );
            }
        }

        // 5. 应用内 Star 表：补充未在 repo_signals 出现的星标记录，基准权重 3.0
        for (full_name, ts) in user_stars {
            let full_lower = full_name.trim().to_lowercase();
            if full_lower.is_empty() || starred_in_repo_signals.contains(&full_lower) {
                continue;
            }
            let w = 3.0 * time_decay(*ts, now_secs);
            acc.known_ids.insert(full_lower.clone());
            if let Some(item) = catalog.item(&full_lower) {
                acc.signal_count += 1;
                acc.github.add_catalog_item(item, w, &idf);
                acc.add_seed(item, SeedRelation::Starred, w);
            } else if let Some((owner, repo)) = full_lower.split_once('/') {
                acc.signal_count += 1;
                acc.github.add_owner(owner, w * 0.6);
                acc.github.add_tokens(repo, w * 0.7, &idf);
            }
        }

        // 6. 兴趣种子：显式分类先验，不衰减
        let interest_cats: Vec<String> = raw
            .interest_seeds
            .iter()
            .map(|c| c.trim().to_lowercase())
            .filter(|c| !c.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        acc.signal_count += interest_cats.len();

        let mut dismissed_app_ids: HashSet<String> = HashSet::new();
        let mut dismissed_categories: HashSet<String> = HashSet::new();
        for fb in &raw.feedback {
            let key = fb.target.trim().to_lowercase();
            match fb.scope {
                FeedbackScope::App => dismissed_app_ids.insert(key),
                FeedbackScope::Category => dismissed_categories.insert(key),
            };
        }

        if acc.signal_count == 0 {
            return Self {
                installed_ids,
                explicit_local_ids,
                dismissed_app_ids,
                dismissed_categories,
                known_ids: acc.known_ids,
                idf,
                aliases,
                ..Self::default()
            };
        }

        let ChannelWeights {
            category: mut category_weights,
            owner: owner_weights,
            token: token_weights,
        } = ChannelWeights::fuse(acc.local.normalize(), acc.github.normalize());

        for cat in interest_cats {
            let w = category_weights.entry(cat).or_insert(0.0);
            *w = w
                .max(INTEREST_SEED_FLOOR)
                .max(1.0 - (1.0 - *w) * 0.4)
                .min(1.0);
        }
        for cat in &dismissed_categories {
            if let Some(w) = category_weights.get_mut(cat) {
                *w *= 0.5;
            }
        }

        let has_signals =
            !category_weights.is_empty() || !owner_weights.is_empty() || !token_weights.is_empty();

        let mut seeds: Vec<SeedRef> = acc.seeds.into_values().collect();
        seeds.sort_by(|a, b| {
            b.strength
                .partial_cmp(&a.strength)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });

        Self {
            has_signals,
            category_weights,
            owner_weights,
            token_weights,
            known_ids: acc.known_ids,
            signal_count: acc.signal_count,
            installed_ids,
            explicit_local_ids,
            dismissed_app_ids,
            dismissed_categories,
            seeds,
            idf,
            aliases,
        }
    }

    /// 近期最强的推荐种子，分类互不相同。
    pub fn top_seeds(&self, limit: usize) -> Vec<SeedRef> {
        let mut used: HashSet<&str> = HashSet::new();
        let mut out = Vec::new();
        for seed in &self.seeds {
            if out.len() >= limit {
                break;
            }
            if seed.category.is_empty() || !used.insert(seed.category.as_str()) {
                continue;
            }
            out.push(seed.clone());
        }
        out
    }

    /// 计算候选应用相对于当前用户画像的动态亲和度增益：
    /// `3.2 * P_cat + 1.8 * P_owner + 1.8 * P_tok - 1.5 * I(少推这类) - 1.2 * I(已知)`
    pub fn affinity_boost(&self, app: &AppSummary) -> f64 {
        if !self.has_signals {
            return 0.0;
        }
        let b = self.breakdown(app);
        3.2 * b.cat + 1.8 * b.owner + 1.8 * b.tok - b.cat_penalty - b.known_penalty
    }

    /// 推荐理由：取 `affinity_boost` 中贡献最大的分类 / 作者 / 关键词分项（贡献低于 0.25 的不出），
    /// 至多 `MAX_REASONS` 条。
    pub fn affinity_explain(&self, app: &AppSummary) -> Vec<Reason> {
        if !self.has_signals {
            return Vec::new();
        }
        let b = self.breakdown(app);
        let mut parts: Vec<(f64, Reason)> = Vec::with_capacity(3);
        if 3.2 * b.cat >= REASON_MIN_CONTRIBUTION {
            parts.push((
                3.2 * b.cat,
                Reason::Category {
                    category: app.core.category.trim().to_lowercase(),
                },
            ));
        }
        if 1.8 * b.owner >= REASON_MIN_CONTRIBUTION {
            parts.push((
                1.8 * b.owner,
                Reason::Owner {
                    owner: app.core.owner.trim().to_string(),
                },
            ));
        }
        // 画像只有词袋信号（如仅有搜索历史）时，命中的关键词是唯一可解释来源，不受贡献门槛限制
        let tok_is_sole_source =
            self.category_weights.is_empty() && self.owner_weights.is_empty() && b.tok > 0.0;
        if (1.8 * b.tok >= REASON_MIN_CONTRIBUTION || tok_is_sole_source)
            && !b.matched_tokens.is_empty()
        {
            parts.push((
                1.8 * b.tok,
                Reason::Keywords {
                    tokens: b.matched_tokens.clone(),
                },
            ));
        }
        // 稳定排序：同贡献时保持分类 → 作者 → 关键词的固定顺序
        parts.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        parts
            .into_iter()
            .take(MAX_REASONS)
            .map(|(_, r)| r)
            .collect()
    }

    fn breakdown(&self, app: &AppSummary) -> AffinityBreakdown {
        let is_known = self.known_ids.contains(&app.core.id.to_lowercase());

        let cat_key = app.core.category.trim().to_lowercase();
        let cat_score = self.category_weights.get(&cat_key).copied().unwrap_or(0.0);

        let owner_key = app.core.owner.trim().to_lowercase();
        // 开发者权重用于发掘同一开发者的其他未收藏作品；已收藏/已关注条目自身不重复享受同作者自激励
        let owner_score = if is_known {
            0.0
        } else {
            self.owner_weights.get(&owner_key).copied().unwrap_or(0.0)
        };

        // 候选文本不含别名（spec §3.3：name + repo + 中英简介）
        let mut matched: Vec<(String, f64)> = affinity_text::extract_summary_tokens(app, &[])
            .into_iter()
            .filter_map(|t| {
                let w = self.token_weights.get(&t).copied()? * self.idf.weight(&t);
                (w > 1e-9).then_some((t, w))
            })
            .collect();
        matched.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        matched.truncate(TOKEN_RANK_COEFFS.len());
        // 固定系数加权：多命中一个偏好词只会加分，分数随命中集合单调不减
        let raw_tok_score = matched
            .iter()
            .zip(TOKEN_RANK_COEFFS)
            .map(|((_, s), c)| s * c)
            .sum::<f64>()
            .clamp(0.0, 1.0);
        let matched_tokens: Vec<String> = matched.into_iter().map(|(t, _)| t).collect();
        let tok_score = if is_known {
            raw_tok_score * 0.4
        } else {
            raw_tok_score
        };

        AffinityBreakdown {
            cat: cat_score,
            owner: owner_score,
            tok: tok_score,
            matched_tokens,
            cat_penalty: if self.dismissed_categories.contains(&cat_key) {
                DISMISSED_CATEGORY_PENALTY
            } else {
                0.0
            },
            known_penalty: if is_known { KNOWN_PENALTY } else { 0.0 },
        }
    }

    /// 返回按归一化权重降序排列的 Top N 偏好分类。
    pub fn top_categories(&self, limit: usize) -> Vec<(String, f64)> {
        let mut list: Vec<(String, f64)> = self
            .category_weights
            .iter()
            .map(|(k, v)| (k.clone(), (*v * 100.0).round() / 100.0))
            .collect();
        list.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        list.truncate(limit);
        list
    }

    /// 以画像构建时的目录 IDF 与别名计算种子相似度。
    pub fn seed_similarity(&self, seed: &AppSummary, candidate: &AppSummary) -> f64 {
        seed_similarity_with_idf(seed, candidate, Some(&*self.idf), Some(&*self.aliases))
    }

    /// 种子相似度使用的词元（名称、仓库、目录别名与中英简介）；同一应用参与多次比较时
    /// 由调用方预提取一次，再交给 `seed_similarity_with_tokens`。
    pub fn similarity_tokens(&self, app: &AppSummary) -> Vec<String> {
        similarity_tokens(app, Some(&*self.aliases))
    }

    /// 以预提取词元计算种子相似度，结果与 `seed_similarity` 逐位一致。
    pub fn seed_similarity_with_tokens(
        &self,
        seed: &AppSummary,
        seed_tokens: &[String],
        candidate: &AppSummary,
        candidate_tokens: &[String],
    ) -> f64 {
        similarity_from_tokens(seed, seed_tokens, candidate, candidate_tokens, &self.idf)
    }

    /// `because_you` 条目的单条理由：优先画像给出的作者 / 关键词理由，其次种子与候选
    /// 共同的高 IDF 词元，都没有时回退到分类。
    pub fn seed_shelf_reason(&self, seed: &AppSummary, candidate: &AppSummary) -> Reason {
        if let Some(r) = self
            .affinity_explain(candidate)
            .into_iter()
            .find(|r| matches!(r, Reason::Owner { .. } | Reason::Keywords { .. }))
        {
            return r;
        }
        let tokens = |a: &AppSummary| affinity_text::extract_summary_tokens(a, &[]);
        let seed_toks: HashSet<String> = tokens(seed).into_iter().collect();
        let mut shared: Vec<(String, f64)> = tokens(candidate)
            .into_iter()
            .filter(|t| seed_toks.contains(t))
            .map(|t| {
                let w = self.idf.weight(&t);
                (t, w)
            })
            .filter(|(_, w)| *w >= SHARED_TOKEN_MIN_IDF)
            .collect();
        shared.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        if !shared.is_empty() {
            return Reason::Keywords {
                tokens: shared.into_iter().take(3).map(|(t, _)| t).collect(),
            };
        }
        Reason::Category {
            category: candidate.core.category.trim().to_lowercase(),
        }
    }
}

/// `seed_shelf_reason` 里种子与候选共同词元的最低 IDF。
const SHARED_TOKEN_MIN_IDF: f64 = 0.5;

/// 种子相似度使用的词元：名称、仓库、别名与中英简介。
fn similarity_tokens(
    app: &AppSummary,
    aliases_map: Option<&HashMap<String, Vec<String>>>,
) -> Vec<String> {
    let aliases = aliases_map
        .and_then(|m| m.get(&app.core.id.to_lowercase()))
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    affinity_text::extract_summary_tokens(app, aliases)
}

/// 候选应用与推荐种子的相似度：
/// `0.25 * I(同分类) + 0.25 * I(同作者) + 0.50 * IDF 加权词元余弦`。
/// 不传 `idf` 时所有词等权。
pub fn seed_similarity_with_idf(
    seed: &AppSummary,
    candidate: &AppSummary,
    idf: Option<&CatalogIdf>,
    aliases_map: Option<&HashMap<String, Vec<String>>>,
) -> f64 {
    let default_idf = CatalogIdf::default();
    let idf = idf.unwrap_or(&default_idf);
    similarity_from_tokens(
        seed,
        &similarity_tokens(seed, aliases_map),
        candidate,
        &similarity_tokens(candidate, aliases_map),
        idf,
    )
}

/// 种子相似度公式本体（见 `seed_similarity_with_idf`），词元由调用方给出。
fn similarity_from_tokens(
    seed: &AppSummary,
    seed_tokens: &[String],
    candidate: &AppSummary,
    candidate_tokens: &[String],
    idf: &CatalogIdf,
) -> f64 {
    let same_cat = !seed.core.category.trim().is_empty()
        && seed
            .core
            .category
            .trim()
            .eq_ignore_ascii_case(candidate.core.category.trim());
    let same_owner = !seed.core.owner.trim().is_empty()
        && seed
            .core
            .owner
            .trim()
            .eq_ignore_ascii_case(candidate.core.owner.trim());
    let sim_tok = idf.cosine_similarity(seed_tokens, candidate_tokens);
    (if same_cat { 0.25 } else { 0.0 }) + (if same_owner { 0.25 } else { 0.0 }) + 0.5 * sim_tok
}

/// 等权词元版本的种子相似度（无目录上下文时使用）。
pub fn seed_similarity(seed: &AppSummary, candidate: &AppSummary) -> f64 {
    seed_similarity_with_idf(seed, candidate, None, None)
}

/// 统计信号仓库中最常出现的 Top N 编程语言（用于设置页隐私数据看板展示）。
pub fn top_signal_languages(raw: &RawAffinitySignals, limit: usize) -> Vec<String> {
    let mut counts: HashMap<String, (String, usize)> = HashMap::new();
    for sig in &raw.repo_signals {
        let lang = sig.language.trim();
        if lang.is_empty() {
            continue;
        }
        let key = lang.to_lowercase();
        let entry = counts.entry(key).or_insert_with(|| (lang.to_string(), 0));
        entry.1 += 1;
    }
    let mut list: Vec<(String, usize)> = counts.into_values().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    list.into_iter().take(limit).map(|(lang, _)| lang).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::developer_starred::test_support::{
        spawn_mock, spawn_mock_routes, MockResp, MockRoute,
    };
    use std::sync::Mutex;

    fn sample_catalog() -> Vec<CatalogItem> {
        vec![
            CatalogItem {
                id: "mpv-player/mpv".to_string(),
                name: "mpv".to_string(),
                owner: "mpv-player".to_string(),
                repo: "mpv".to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: "命令行极客视频播放器".to_string(),
                description_en: Some("Command line video player".to_string()),
                category: "media".to_string(),
                category_name: "影音视听".to_string(),
                aliases: vec!["mpv".to_string()],
                default_version: "v0.38.0".to_string(),
                added_at: None,
                license: "GPL-2.0".to_string(),
                stars: 28000,
                forks: 2900,
                is_verified: true,
                homepage: None,
                install_dirs: vec![],
                search_subdirs: vec![],
                publishers: vec![],
                platforms: vec!["windows".to_string()],
                identifiers: HashMap::new(),
            },
            CatalogItem {
                id: "jellyfin/jellyfin-media-player".to_string(),
                name: "Jellyfin Media Player".to_string(),
                owner: "jellyfin".to_string(),
                repo: "jellyfin-media-player".to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: "Jellyfin 官方桌面影音客户端".to_string(),
                description_en: Some("Jellyfin desktop media player".to_string()),
                category: "media".to_string(),
                category_name: "影音视听".to_string(),
                aliases: vec![],
                default_version: "v1.11.1".to_string(),
                added_at: None,
                license: "GPL-3.0".to_string(),
                stars: 3500,
                forks: 320,
                is_verified: true,
                homepage: None,
                install_dirs: vec![],
                search_subdirs: vec![],
                publishers: vec![],
                platforms: vec!["windows".to_string()],
                identifiers: HashMap::new(),
            },
            CatalogItem {
                id: "rustdesk/rustdesk".to_string(),
                name: "RustDesk".to_string(),
                owner: "rustdesk".to_string(),
                repo: "rustdesk".to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: "开源远程桌面软件".to_string(),
                description_en: Some("Open-source remote desktop".to_string()),
                category: "system".to_string(),
                category_name: "系统实用".to_string(),
                aliases: vec![],
                default_version: "v1.3.0".to_string(),
                added_at: None,
                license: "AGPL-3.0".to_string(),
                stars: 70000,
                forks: 8000,
                is_verified: true,
                homepage: None,
                install_dirs: vec![],
                search_subdirs: vec![],
                publishers: vec![],
                platforms: vec!["windows".to_string()],
                identifiers: HashMap::new(),
            },
        ]
    }

    #[tokio::test]
    async fn sync_skips_network_when_github_source_disabled() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(SETTING_ENABLE_GITHUB_AFFINITY, "false")
            .unwrap();
        let db_mutex = Mutex::new(db);
        // 不可达地址：若真的发请求会得到网络错误而非开关错误
        let res = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "token",
            Some("http://127.0.0.1:9"),
        )
        .await;
        let err = res.expect_err("GitHub 用户信息关闭时应当拒绝同步");
        assert!(err.contains("GitHub 用户信息"), "{err}");
        let db = db_mutex.lock().unwrap();
        assert!(db
            .get_setting(SETTING_AFFINITY_GITHUB_SYNCED_AT)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn sync_github_affinity_signals_sends_etag_and_persists_relations() {
        let starred_json = serde_json::json!([
            {
                "starred_at": "2024-05-01T08:00:00Z",
                "repo": {
                    "name": "mpv",
                    "full_name": "mpv-player/mpv",
                    "description": "Command line video player",
                    "stargazers_count": 28000u64,
                    "forks_count": 2900u64,
                    "language": "C",
                    "fork": false
                }
            }
        ])
        .to_string();
        let repos_json = serde_json::json!([
            {
                "name": "rustdesk",
                "full_name": "myuser/rustdesk",
                "description": "Forked remote desktop",
                "stargazers_count": 5u64,
                "forks_count": 1u64,
                "language": "Rust",
                "fork": true
            },
            {
                "name": "my-cli",
                "full_name": "myuser/my-cli",
                "description": "Personal CLI tool",
                "stargazers_count": 20u64,
                "forks_count": 2u64,
                "language": "Rust",
                "fork": false
            }
        ])
        .to_string();

        let mut routes = HashMap::new();
        routes.insert(
            "/user/starred?per_page=100&page=1".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"etag-starred-1\"".to_string()),
                body: starred_json,
                honor_inm: Some("\"etag-starred-1\"".to_string()),
            },
        );
        routes.insert(
            "/user/repos?type=owner&sort=updated&per_page=100&page=1".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"etag-repos-1\"".to_string()),
                body: repos_json,
                honor_inm: Some("\"etag-repos-1\"".to_string()),
            },
        );

        let srv = spawn_mock(routes).await;
        let db_mutex = Mutex::new(Database::open_in_memory().unwrap());

        // 首轮同步：200 OK，写入 3 条信号（1 starred, 1 forked, 1 owned）并记录 ETag 与时间戳
        let count = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        assert_eq!(count, 3);

        {
            let db = db_mutex.lock().unwrap();
            let signals = db.get_user_repo_signals().unwrap();
            assert!(signals
                .iter()
                .any(|s| s.full_name == "mpv-player/mpv" && s.relation == "starred"));
            assert!(signals
                .iter()
                .any(|s| s.full_name == "myuser/rustdesk" && s.relation == "forked"));
            assert!(signals
                .iter()
                .any(|s| s.full_name == "myuser/my-cli" && s.relation == "owned"));
            assert!(db
                .get_setting(SETTING_AFFINITY_GITHUB_SYNCED_AT)
                .unwrap()
                .is_some());
        }

        // 第二轮同步：携带 If-None-Match 命中 304 Not Modified，不报错且保留 3 条信号
        let count2 = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        assert_eq!(count2, 3);
        let seen = srv.seen_inm.lock().unwrap();
        assert_eq!(
            seen.get("/user/starred?per_page=100&page=1")
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"etag-starred-1\"")
        );
        assert_eq!(
            seen.get("/user/repos?type=owner&sort=updated&per_page=100&page=1")
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"etag-repos-1\"")
        );
    }

    fn mk_repo_json(items: Vec<(String, bool, &str)>) -> String {
        let arr: Vec<serde_json::Value> = items
            .into_iter()
            .map(|(full_name, fork, lang)| {
                let name = full_name.split('/').nth(1).unwrap_or("repo");
                serde_json::json!({
                    "name": name,
                    "full_name": full_name,
                    "description": format!("desc {name}"),
                    "stargazers_count": 42u64,
                    "forks_count": 5u64,
                    "language": lang,
                    "fork": fork
                })
            })
            .collect();
        serde_json::Value::Array(arr).to_string()
    }

    /// `star+json` 包装格式的 Star 页（`starred_at` 按序号递减）。
    fn mk_starred_json(items: Vec<(String, bool, &str)>) -> String {
        let bare: Vec<serde_json::Value> = serde_json::from_str(&mk_repo_json(items)).unwrap();
        let arr: Vec<serde_json::Value> = bare
            .into_iter()
            .enumerate()
            .map(|(i, repo)| {
                let ts = 1_700_000_000i64 - (i as i64) * 60;
                let starred_at = time::OffsetDateTime::from_unix_timestamp(ts)
                    .unwrap()
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap();
                serde_json::json!({ "starred_at": starred_at, "repo": repo })
            })
            .collect();
        serde_json::Value::Array(arr).to_string()
    }

    #[tokio::test]
    async fn sync_github_affinity_signals_paginates_all_pages_and_recovers_on_304() {
        let starred_p1: Vec<(String, bool, &str)> = (0..100)
            .map(|i| (format!("org/starred-{i}"), false, "Rust"))
            .collect();
        let starred_p2: Vec<(String, bool, &str)> = (100..135)
            .map(|i| (format!("org/starred-{i}"), false, "TypeScript"))
            .collect();
        let repos_p1: Vec<(String, bool, &str)> = (0..100)
            .map(|i| (format!("me/repo-{i}"), i % 2 == 0, "Rust"))
            .collect();
        let repos_p2: Vec<(String, bool, &str)> = (100..112)
            .map(|i| (format!("me/repo-{i}"), true, "Go"))
            .collect();

        let mut routes = HashMap::new();
        routes.insert(
            "/user/starred?per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"s-etag-1\"".to_string()),
                    body: mk_starred_json(starred_p1),
                    honor_inm: Some("\"s-etag-1\"".to_string()),
                },
                link: Some(
                    "<https://api.github.com/user/starred?per_page=100&page=2>; rel=\"next\""
                        .to_string(),
                ),
            },
        );
        routes.insert(
            "/user/starred?per_page=100&page=2".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"s-etag-2\"".to_string()),
                    body: mk_starred_json(starred_p2),
                    honor_inm: Some("\"s-etag-2\"".to_string()),
                },
                link: None,
            },
        );
        routes.insert(
            "/user/repos?type=owner&sort=updated&per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"r-etag-1\"".to_string()),
                    body: mk_repo_json(repos_p1),
                    honor_inm: Some("\"r-etag-1\"".to_string()),
                },
                link: Some(
                    "<https://api.github.com/user/repos?type=owner&sort=updated&per_page=100&page=2>; rel=\"next\""
                        .to_string(),
                ),
            },
        );
        routes.insert(
            "/user/repos?type=owner&sort=updated&per_page=100&page=2".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"r-etag-2\"".to_string()),
                    body: mk_repo_json(repos_p2),
                    honor_inm: Some("\"r-etag-2\"".to_string()),
                },
                link: None,
            },
        );

        let srv = spawn_mock_routes(routes).await;
        let db_mutex = Mutex::new(Database::open_in_memory().unwrap());

        let total = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        // 135 starred + 112 owner repos = 247
        assert_eq!(total, 247);

        {
            let db = db_mutex.lock().unwrap();
            let signals = db.get_user_repo_signals().unwrap();
            let starred_cnt = signals.iter().filter(|s| s.relation == "starred").count();
            let forked_cnt = signals.iter().filter(|s| s.relation == "forked").count();
            let owned_cnt = signals.iter().filter(|s| s.relation == "owned").count();
            assert_eq!(starred_cnt, 135, "必须突破单页 100 上限拉全全部 Star");
            assert_eq!(forked_cnt, 62);
            assert_eq!(owned_cnt, 50);
            assert!(signals.iter().any(|s| s.full_name == "org/starred-134"));
            assert!(signals.iter().any(|s| s.full_name == "me/repo-111"));
        }

        // 清空 GitHub 账号信号后再次同步：两页均命中 304，必须完整从 api_etag_cache 恢复全部 247 条
        db_mutex
            .lock()
            .unwrap()
            .clear_github_account_signals()
            .unwrap();
        let restored = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        assert_eq!(restored, 247);

        let seen = srv.seen_inm.lock().unwrap();
        assert_eq!(
            seen.get("/user/starred?per_page=100&page=2")
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"s-etag-2\"")
        );
        assert_eq!(
            seen.get("/user/repos?type=owner&sort=updated&per_page=100&page=2")
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"r-etag-2\"")
        );
    }

    #[tokio::test]
    async fn sync_github_affinity_signals_preserves_existing_on_partial_page_failure() {
        let starred_p1: Vec<(String, bool, &str)> = (0..100)
            .map(|i| (format!("org/starred-{i}"), false, "Rust"))
            .collect();

        let mut routes = HashMap::new();
        routes.insert(
            "/user/starred?per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"s-etag-1\"".to_string()),
                    body: mk_starred_json(starred_p1),
                    honor_inm: None,
                },
                link: Some(
                    "<https://api.github.com/user/starred?per_page=100&page=2>; rel=\"next\""
                        .to_string(),
                ),
            },
        );
        // page=2 缺失 → mock 返回 404 Failed
        routes.insert(
            "/user/repos?type=owner&sort=updated&per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"r-etag-1\"".to_string()),
                    body: mk_repo_json(vec![("me/tool".to_string(), false, "Rust")]),
                    honor_inm: None,
                },
                link: None,
            },
        );

        let srv = spawn_mock_routes(routes).await;
        let db_mutex = Mutex::new(Database::open_in_memory().unwrap());
        // 预置既有 starred 信号
        db_mutex
            .lock()
            .unwrap()
            .upsert_user_repo_signals(&[UserRepoSignal {
                full_name: "keep/existing".to_string(),
                relation: "starred".to_string(),
                language: "Rust".to_string(),
                description: "keep".to_string(),
                stars: 10,
                forks: 1,
                updated_at: 1_700_000_000,
            }])
            .unwrap();

        let total = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        // repos 成功（1 owned），starred 因第 2 页失败而保留既有 keep/existing
        assert_eq!(total, 2);
        let db = db_mutex.lock().unwrap();
        let signals = db.get_user_repo_signals().unwrap();
        assert!(signals
            .iter()
            .any(|s| s.full_name == "keep/existing" && s.relation == "starred"));
        assert!(!signals.iter().any(|s| s.full_name == "org/starred-0"));
        assert!(db
            .get_setting(SETTING_AFFINITY_GITHUB_SYNCED_AT)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn sync_github_affinity_signals_prunes_stale_trailing_page_etag_when_shrinking() {
        let db_mutex = Mutex::new(Database::open_in_memory().unwrap());
        {
            let db = db_mutex.lock().unwrap();
            // 模拟历史曾同步过第 2 页缓存
            db.save_etag(
                &CatalogService::affinity_starred_page_endpoint(2),
                "\"old-p2\"",
                "[]",
                1_700_000_000,
            )
            .unwrap();
        }

        let mut routes = HashMap::new();
        routes.insert(
            "/user/starred?per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"s-only-p1\"".to_string()),
                    body: mk_starred_json(vec![("org/one".to_string(), false, "Rust")]),
                    honor_inm: Some("\"s-only-p1\"".to_string()),
                },
                link: None,
            },
        );
        routes.insert(
            "/user/repos?type=owner&sort=updated&per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"r-only-p1\"".to_string()),
                    body: mk_repo_json(vec![]),
                    honor_inm: Some("\"r-only-p1\"".to_string()),
                },
                link: None,
            },
        );

        let srv = spawn_mock_routes(routes).await;
        let count = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        assert_eq!(count, 1);

        {
            let db = db_mutex.lock().unwrap();
            assert!(db
                .get_etag(&CatalogService::affinity_starred_page_endpoint(2))
                .unwrap()
                .is_none());
        }

        // 二次同步（page=1 返回 304）不应再去探已被清理的 page=2
        let count2 = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        assert_eq!(count2, 1);
        let counts = srv.request_counts.lock().unwrap();
        assert_eq!(
            counts.get("/user/starred?per_page=100&page=1").copied(),
            Some(2)
        );
        assert_eq!(
            counts.get("/user/starred?per_page=100&page=2").copied(),
            None
        );
    }

    #[tokio::test]
    async fn sync_github_affinity_signals_recovers_when_trailing_page_etag_evicted_and_touches_304_lru(
    ) {
        let starred_p1: Vec<(String, bool, &str)> = (0..100)
            .map(|i| (format!("org/starred-{i}"), false, "Rust"))
            .collect();
        let starred_p2: Vec<(String, bool, &str)> = (100..135)
            .map(|i| (format!("org/starred-{i}"), false, "TypeScript"))
            .collect();

        let mut routes = HashMap::new();
        routes.insert(
            "/user/starred?per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"s-etag-1\"".to_string()),
                    body: mk_starred_json(starred_p1),
                    honor_inm: Some("\"s-etag-1\"".to_string()),
                },
                link: Some(
                    "<https://api.github.com/user/starred?per_page=100&page=2>; rel=\"next\""
                        .to_string(),
                ),
            },
        );
        routes.insert(
            "/user/starred?per_page=100&page=2".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"s-etag-2\"".to_string()),
                    body: mk_starred_json(starred_p2),
                    honor_inm: Some("\"s-etag-2\"".to_string()),
                },
                link: None,
            },
        );
        routes.insert(
            "/user/repos?type=owner&sort=updated&per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"r-etag-1\"".to_string()),
                    body: mk_repo_json(vec![]),
                    honor_inm: Some("\"r-etag-1\"".to_string()),
                },
                link: None,
            },
        );

        let srv = spawn_mock_routes(routes).await;
        let db_mutex = Mutex::new(Database::open_in_memory().unwrap());

        let count1 = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        assert_eq!(count1, 135);

        // 模拟 page=2 缓存被 LRU 淘汰且 page=1 时间戳老化；304 响应不带 Link 头时仍必须续拉 page=2 恢复全量 135 条
        {
            let db = db_mutex.lock().unwrap();
            db.touch_etag(&CatalogService::affinity_starred_page_endpoint(1), 100)
                .unwrap();
            db.delete_etag(&CatalogService::affinity_starred_page_endpoint(2))
                .unwrap();
            db.save_etag(
                "https://api.github.com/repos/other/older",
                "\"old\"",
                "{}",
                500,
            )
            .unwrap();
        }

        let count2 = CatalogService::sync_github_affinity_signals_bg(
            &db_mutex,
            "gho_test_token",
            Some(&srv.base),
        )
        .await
        .unwrap();
        assert_eq!(count2, 135);

        {
            let db = db_mutex.lock().unwrap();
            let signals = db.get_user_repo_signals().unwrap();
            assert_eq!(
                signals.len(),
                135,
                "尾页缓存缺失时不得在 page=1 (304) 处截断"
            );
            // page=1 与 repos?page=1 命中 304 后均刷新了 last_checked_at，保留最近 3 条时只淘汰 older 行
            db.prune_api_etag_cache(3).unwrap();
            assert!(db
                .get_etag(&CatalogService::affinity_starred_page_endpoint(1))
                .unwrap()
                .is_some());
            assert!(db
                .get_etag(&CatalogService::affinity_starred_page_endpoint(2))
                .unwrap()
                .is_some());
            assert!(db
                .get_etag("https://api.github.com/repos/other/older")
                .unwrap()
                .is_none());
        }
    }

    fn single_page_routes(starred_body: String, repos_body: String) -> HashMap<String, MockRoute> {
        let mut routes = HashMap::new();
        routes.insert(
            "/user/starred?per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"s-new\"".to_string()),
                    body: starred_body,
                    honor_inm: Some("\"s-new\"".to_string()),
                },
                link: None,
            },
        );
        routes.insert(
            "/user/repos?type=owner&sort=updated&per_page=100&page=1".to_string(),
            MockRoute {
                resp: MockResp {
                    status: 200,
                    reason: "OK",
                    etag: Some("\"r-new\"".to_string()),
                    body: repos_body,
                    honor_inm: Some("\"r-new\"".to_string()),
                },
                link: None,
            },
        );
        routes
    }

    #[tokio::test]
    async fn starred_sync_uses_star_json_and_real_timestamps() {
        let starred = serde_json::json!([
            { "starred_at": "2024-05-01T08:00:00Z",
              "repo": { "full_name": "org/new-star", "language": "Rust" } },
            { "starred_at": "2019-01-02T03:04:05Z",
              "repo": { "full_name": "org/old-star", "language": "C" } }
        ])
        .to_string();
        let repos = serde_json::json!([
            { "full_name": "me/pushed", "fork": false,
              "pushed_at": "2023-03-04T05:06:07Z", "updated_at": "2020-01-01T00:00:00Z" },
            { "full_name": "me/updated-only", "fork": true,
              "updated_at": "2021-06-07T08:09:10Z" }
        ])
        .to_string();
        let srv = spawn_mock_routes(single_page_routes(starred, repos)).await;
        let db_mutex = Mutex::new(Database::open_in_memory().unwrap());
        CatalogService::sync_github_affinity_signals_bg(&db_mutex, "t", Some(&srv.base))
            .await
            .unwrap();

        let ts = |s: &str| parse_rfc3339_secs(Some(s)).unwrap();
        let db = db_mutex.lock().unwrap();
        let sigs = db.get_user_repo_signals().unwrap();
        let at = |name: &str| {
            sigs.iter()
                .find(|s| s.full_name == name)
                .unwrap()
                .updated_at
        };
        assert_eq!(at("org/new-star"), ts("2024-05-01T08:00:00Z"));
        assert_eq!(at("org/old-star"), ts("2019-01-02T03:04:05Z"));
        assert_eq!(at("me/pushed"), ts("2023-03-04T05:06:07Z"));
        assert_eq!(at("me/updated-only"), ts("2021-06-07T08:09:10Z"));

        let accepts = srv.seen_accept.lock().unwrap();
        assert_eq!(
            accepts
                .get("/user/starred?per_page=100&page=1")
                .cloned()
                .flatten()
                .as_deref(),
            Some(STARRED_ACCEPT)
        );
    }

    #[test]
    fn bare_starred_page_falls_back_to_decreasing_index_timestamps() {
        let now = 1_700_000_000i64;
        let body = mk_repo_json(vec![
            ("org/first".to_string(), false, "Rust"),
            ("org/second".to_string(), false, "Rust"),
        ]);
        let page = parse_repo_signals_page(&body, now, 100, SignalTimeSource::StarredAt, &|_| {
            RepoRelation::Starred
        })
        .unwrap();
        assert_eq!(page.raw_count, 2);
        let sig = &page.signals;
        assert!(sig[0].updated_at > sig[1].updated_at);
        assert_eq!(sig[0].updated_at, now - 100 * 3600);
        assert_eq!(sig[1].updated_at, now - 101 * 3600);
    }

    #[tokio::test]
    async fn legacy_starred_cache_skips_if_none_match_and_upgrades() {
        let db_mutex = Mutex::new(Database::open_in_memory().unwrap());
        let ep = CatalogService::affinity_starred_page_endpoint(1);
        db_mutex
            .lock()
            .unwrap()
            .save_etag(
                &ep,
                "\"s-new\"",
                &mk_repo_json(vec![("org/old".to_string(), false, "Rust")]),
                1_700_000_000,
            )
            .unwrap();

        let srv = spawn_mock_routes(single_page_routes(
            mk_starred_json(vec![("org/old".to_string(), false, "Rust")]),
            mk_repo_json(vec![]),
        ))
        .await;
        CatalogService::sync_github_affinity_signals_bg(&db_mutex, "t", Some(&srv.base))
            .await
            .unwrap();

        let seen = srv.seen_inm.lock().unwrap();
        assert_eq!(
            seen.get("/user/starred?per_page=100&page=1")
                .cloned()
                .flatten(),
            None,
            "旧格式缓存不得携带 If-None-Match"
        );
        let db = db_mutex.lock().unwrap();
        let payload = db.get_cached_payload(&ep).unwrap().unwrap();
        assert!(payload.contains("\"starred_at\""));
        let sigs = db.get_user_repo_signals().unwrap();
        assert_eq!(sigs[0].updated_at, 1_700_000_000);
    }

    #[tokio::test]
    async fn legacy_upgrade_happens_once_even_if_server_keeps_bare_format() {
        let db_mutex = Mutex::new(Database::open_in_memory().unwrap());
        let ep = CatalogService::affinity_starred_page_endpoint(1);
        let bare = mk_repo_json(vec![("org/old".to_string(), false, "Rust")]);
        db_mutex
            .lock()
            .unwrap()
            .save_etag(&ep, "\"s-new\"", &bare, 1_700_000_000)
            .unwrap();
        let srv = spawn_mock_routes(single_page_routes(bare, mk_repo_json(vec![]))).await;
        let path = "/user/starred?per_page=100&page=1";

        CatalogService::sync_github_affinity_signals_bg(&db_mutex, "t", Some(&srv.base))
            .await
            .unwrap();
        assert_eq!(
            srv.seen_inm.lock().unwrap().get(path).cloned().flatten(),
            None
        );

        CatalogService::sync_github_affinity_signals_bg(&db_mutex, "t", Some(&srv.base))
            .await
            .unwrap();
        assert_eq!(
            srv.seen_inm
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"s-new\""),
            "升级过一次后应恢复条件请求"
        );
    }

    #[test]
    fn cooldown_check_triggers_after_six_hours_or_fifteen_days() {
        let now = 1_700_000_000i64;
        assert!(should_sync_affinity_on_startup(None, now));
        // 15 天前同步过 → 必须触发跨周期保鲜同步
        let fifteen_days_ago = now - 15 * 86400;
        assert!(should_sync_affinity_on_startup(Some(fifteen_days_ago), now));
        // 1 小时前同步过 → 冷却期内不重复触发
        let one_hour_ago = now - 3600;
        assert!(!should_sync_affinity_on_startup(Some(one_hour_ago), now));
    }

    #[test]
    fn profile_boosts_matching_category_and_penalizes_already_known_seed() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            repo_signals: vec![UserRepoSignal {
                full_name: "someone/ffmpeg-gui".to_string(),
                relation: "starred".to_string(),
                language: "C++".to_string(),
                description: "Video and audio stream player with ffmpeg".to_string(),
                stars: 5000,
                forks: 600,
                updated_at: now - 3600,
            }],
            user_stars: vec![],
            favorites: vec![("mpv-player/mpv".to_string(), now - 1800)],
            watched: vec![],
            ..Default::default()
        };

        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!(profile.has_signals);
        assert!(
            profile
                .category_weights
                .get("media")
                .copied()
                .unwrap_or(0.0)
                > 0.7,
            "media 分类权重应当显著高于其他分类"
        );

        let mpv_summary = catalog[0].to_summary();
        let jellyfin_summary = catalog[1].to_summary();
        let rustdesk_summary = catalog[2].to_summary();

        let boost_jellyfin = profile.affinity_boost(&jellyfin_summary);
        let boost_mpv = profile.affinity_boost(&mpv_summary);
        let boost_rustdesk = profile.affinity_boost(&rustdesk_summary);

        assert!(
            boost_jellyfin > boost_rustdesk + 2.0,
            "同属 media 分类且未被收藏的 Jellyfin 应获得比 system 分类更高的画像增益"
        );
        assert!(
            boost_jellyfin > boost_mpv,
            "已收藏的种子应用 mpv 自身施加适度让位降权，优先推新同分类未收藏应用 Jellyfin"
        );
    }

    #[test]
    fn signal_sources_gate_local_and_github_contributions() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            repo_signals: vec![UserRepoSignal {
                full_name: "rustdesk/rustdesk".to_string(),
                relation: "starred".to_string(),
                language: "Rust".to_string(),
                description: "Remote desktop".to_string(),
                stars: 70000,
                forks: 8000,
                updated_at: now,
            }],
            favorites: vec![("mpv-player/mpv".to_string(), now)],
            installed: vec![("jellyfin/jellyfin-media-player".to_string(), now)],
            ..Default::default()
        };
        let only = |local, github| {
            UserAffinityProfile::from_signals_with_sources(
                &raw,
                &catalog,
                now,
                AffinitySources { local, github },
            )
        };

        let github_only = only(false, true);
        assert!(github_only.category_weights.contains_key("system"));
        assert!(!github_only.category_weights.contains_key("media"));
        assert!(!github_only.known_ids.contains("mpv-player/mpv"));
        // 已安装集合不受开关影响：精选页仍需排除已装应用
        assert!(github_only
            .installed_ids
            .contains("jellyfin/jellyfin-media-player"));

        let local_only = only(true, false);
        assert!(local_only.category_weights.contains_key("media"));
        assert!(!local_only.category_weights.contains_key("system"));
        assert!(!local_only.known_ids.contains("rustdesk/rustdesk"));

        let none = only(false, false);
        assert!(!none.has_signals);
        assert!(none
            .installed_ids
            .contains("jellyfin/jellyfin-media-player"));

        // 只开 GitHub 且尚无 GitHub 数据：冷启动选择卡填的兴趣方向仍让画像脱离冷启动
        let seeds_only = RawAffinitySignals {
            interest_seeds: vec!["games".to_string()],
            ..Default::default()
        };
        let github_cold = UserAffinityProfile::from_signals_with_sources(
            &seeds_only,
            &catalog,
            now,
            AffinitySources {
                local: false,
                github: true,
            },
        );
        assert!(github_cold.has_signals);
        assert!(github_cold.category_weights.contains_key("games"));
    }

    #[test]
    fn forked_repo_matches_upstream_catalog_item_by_repo_name() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            repo_signals: vec![UserRepoSignal {
                full_name: "myuser/rustdesk".to_string(),
                relation: "forked".to_string(),
                language: "Rust".to_string(),
                description: String::new(),
                stars: 1,
                forks: 0,
                updated_at: now,
            }],
            ..Default::default()
        };

        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!(profile.has_signals);
        assert!(
            profile
                .category_weights
                .get("system")
                .copied()
                .unwrap_or(0.0)
                > 0.8,
            "Fork 的 myuser/rustdesk 应当反查命中上游 rustdesk/rustdesk 并赋予 system 分类权重"
        );
    }

    #[test]
    fn installed_signal_alone_builds_profile_and_marks_known() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            installed: vec![("rustdesk/rustdesk".to_string(), now - 60)],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!(profile.has_signals);
        assert!(
            profile
                .category_weights
                .get("system")
                .copied()
                .unwrap_or(0.0)
                > 0.0
        );
        assert!(profile.known_ids.contains("rustdesk/rustdesk"));
        assert!(profile.installed_ids.contains("rustdesk/rustdesk"));
        assert_eq!(profile.signal_count, 1);
        assert_eq!(profile.seeds[0].relation, SeedRelation::Installed);
    }

    #[test]
    fn short_decay_halves_after_seven_days() {
        let now = 1_700_000_000i64;
        let d = time_decay_with(now - 7 * 86400, now, SHORT_DECAY_HALF_LIFE_DAYS, 0.0);
        assert!(
            (d - 0.5).abs() < 0.005,
            "7 天前的浏览权重应约为一半，实际 {d}"
        );
    }

    #[test]
    fn search_queries_only_touch_token_weights() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            searches: vec![("remote desktop".to_string(), now)],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!(profile.category_weights.is_empty());
        assert!(profile.token_weights.contains_key("remote"));
        assert!(
            !profile.token_weights.contains_key("desktop"),
            "desktop 是停用词"
        );
    }

    #[test]
    fn interest_seeds_count_as_signals_and_category_feedback_halves_weight() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let mut raw = RawAffinitySignals {
            interest_seeds: vec!["media".to_string(), "system".to_string()],
            ..Default::default()
        };
        let base = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!(base.has_signals);
        assert_eq!(base.signal_count, 2);
        let before = base.category_weights["media"];

        raw.feedback = vec![crate::db::FeedFeedback {
            target: "media".to_string(),
            scope: FeedbackScope::Category,
            created_at: now,
        }];
        let after = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!((after.category_weights["media"] - before * 0.5).abs() < 1e-9);
    }

    #[test]
    fn app_feedback_is_exposed_even_without_signals() {
        let catalog = sample_catalog();
        let raw = RawAffinitySignals {
            feedback: vec![crate::db::FeedFeedback {
                target: "mpv-player/mpv".to_string(),
                scope: FeedbackScope::App,
                created_at: 1,
            }],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, 10);
        assert!(!profile.has_signals);
        assert!(profile.dismissed_app_ids.contains("mpv-player/mpv"));
    }

    #[test]
    fn explain_matches_boost_sources_and_orders_category_first() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            favorites: vec![("mpv-player/mpv".to_string(), now)],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        let jellyfin = catalog[1].to_summary();
        let reasons = profile.affinity_explain(&jellyfin);
        assert!(!reasons.is_empty());
        assert_eq!(
            reasons[0],
            Reason::Category {
                category: "media".to_string()
            }
        );
        // 已知条目自身不出作者理由
        let mpv = catalog[0].to_summary();
        assert!(!profile
            .affinity_explain(&mpv)
            .iter()
            .any(|r| matches!(r, Reason::Owner { .. })));
        assert!(reasons.len() <= MAX_REASONS);
    }

    #[test]
    fn top_seeds_have_distinct_categories() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            favorites: vec![
                ("mpv-player/mpv".to_string(), now),
                ("jellyfin/jellyfin-media-player".to_string(), now),
                ("rustdesk/rustdesk".to_string(), now),
            ],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        let seeds = profile.top_seeds(5);
        assert_eq!(seeds.len(), 2);
        assert_ne!(seeds[0].category, seeds[1].category);
    }

    #[test]
    fn seed_similarity_rewards_same_category_and_owner() {
        let catalog = sample_catalog();
        let mpv = catalog[0].to_summary();
        let jellyfin = catalog[1].to_summary();
        let rustdesk = catalog[2].to_summary();
        assert!(seed_similarity(&mpv, &jellyfin) >= 0.28);
        assert!(seed_similarity(&mpv, &rustdesk) < 0.28);
    }

    fn cat_item(id: &str, category: &str, desc: &str, aliases: &[&str]) -> CatalogItem {
        let (owner, repo) = id.split_once('/').unwrap();
        CatalogItem {
            id: id.to_string(),
            name: repo.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: desc.to_string(),
            description_en: None,
            category: category.to_string(),
            category_name: category.to_string(),
            aliases: aliases.iter().map(|a| a.to_string()).collect(),
            default_version: "v1".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 1000,
            forks: 100,
            is_verified: true,
            homepage: None,
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec!["windows".to_string()],
            identifiers: HashMap::new(),
        }
    }

    /// 目录填充：让 IDF 接近真实目录量级。
    fn filler(n: usize) -> Vec<CatalogItem> {
        (0..n)
            .map(|i| cat_item(&format!("filler{i}/thing{i}"), "dev", "generic helper", &[]))
            .collect()
    }

    #[test]
    fn keyword_score_is_monotonic_in_matched_set() {
        let mut catalog = filler(20);
        catalog.push(cat_item("seed/fav", "media", "ffmpeg video player", &[]));
        catalog.push(cat_item("studio/a", "media", "video", &[]));
        catalog.push(cat_item("studio/b", "media", "video player ffmpeg", &[]));
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            favorites: vec![("seed/fav".to_string(), now)],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        let a = catalog[21].to_summary();
        let b = catalog[22].to_summary();
        assert!(
            profile.affinity_boost(&b) > profile.affinity_boost(&a),
            "命中更多偏好词的候选得分必须更高"
        );
    }

    #[test]
    fn local_favorites_survive_flood_of_github_repos() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let descs = [
            "A library for parsing data",
            "Command line helper for developers",
            "Async runtime and framework",
            "Personal dotfiles",
        ];
        let repo_signals: Vec<UserRepoSignal> = (0..300)
            .map(|i| UserRepoSignal {
                full_name: format!("org{i}/repo{i}"),
                relation: "starred".to_string(),
                language: if i % 2 == 0 { "Rust" } else { "Python" }.to_string(),
                description: descs[i % descs.len()].to_string(),
                stars: 5000,
                forks: 300,
                updated_at: now - (i as i64) * 3600,
            })
            .collect();
        let raw = RawAffinitySignals {
            repo_signals,
            favorites: vec![
                ("mpv-player/mpv".to_string(), now),
                ("jellyfin/jellyfin-media-player".to_string(), now),
            ],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!(
            profile.category_weights["media"] >= 0.45,
            "{:?}",
            profile.category_weights
        );
        let top: Vec<String> = profile
            .top_categories(2)
            .into_iter()
            .map(|(c, _)| c)
            .collect();
        assert!(top.contains(&"media".to_string()), "{top:?}");
    }

    #[test]
    fn chinese_search_history_yields_keyword_boost_and_reason() {
        let mut catalog = sample_catalog();
        catalog.extend(filler(20));
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            searches: vec![("远程桌面".to_string(), now)],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!(profile.has_signals);
        let rustdesk = catalog[2].to_summary();
        assert!(profile.affinity_boost(&rustdesk) > 0.0);
        assert!(profile
            .affinity_explain(&rustdesk)
            .iter()
            .any(|r| matches!(r, Reason::Keywords { .. })));
        assert_eq!(profile.affinity_boost(&catalog[0].to_summary()), 0.0);
    }

    #[test]
    fn uncataloged_local_signals_use_briefs_or_repo_name() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let mut briefs = HashMap::new();
        briefs.insert(
            "acme/player".to_string(),
            crate::db::UncatalogedSignalBrief {
                name: "Player".to_string(),
                owner: "acme".to_string(),
                repo: "player".to_string(),
                description: String::new(),
                description_en: Some("A tiny video player".to_string()),
                category: "external".to_string(),
            },
        );
        let raw = RawAffinitySignals {
            favorites: vec![("acme/player".to_string(), now)],
            views: vec![("other/markdown-notes".to_string(), now)],
            uncataloged_briefs: briefs,
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert!(profile.has_signals);
        assert_eq!(profile.signal_count, 2);
        assert!(profile.category_weights.contains_key("media"));
        assert!(profile.category_weights.contains_key("office"));
        assert!(profile.owner_weights.contains_key("acme"));
        assert!(profile.explicit_local_ids.contains("acme/player"));
    }

    #[test]
    fn explicit_local_ids_ignore_local_source_switch() {
        let catalog = sample_catalog();
        let raw = RawAffinitySignals {
            favorites: vec![("mpv-player/mpv".to_string(), 1)],
            watched: vec![("rustdesk/rustdesk".to_string(), 1)],
            installed: vec![("jellyfin/jellyfin-media-player".to_string(), 1)],
            feedback: vec![crate::db::FeedFeedback {
                target: "Games".to_string(),
                scope: FeedbackScope::Category,
                created_at: 1,
            }],
            ..Default::default()
        };
        let p = UserAffinityProfile::from_signals_with_sources(
            &raw,
            &catalog,
            10,
            AffinitySources {
                local: false,
                github: true,
            },
        );
        assert!(!p.has_signals);
        assert_eq!(p.explicit_local_ids.len(), 3);
        assert!(p.dismissed_categories.contains("games"));
    }

    #[test]
    fn dismissed_category_is_penalized_in_boost() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        let mut raw = RawAffinitySignals {
            favorites: vec![("rustdesk/rustdesk".to_string(), now)],
            ..Default::default()
        };
        let jellyfin = catalog[1].to_summary();
        let before =
            UserAffinityProfile::from_signals(&raw, &catalog, now).affinity_boost(&jellyfin);
        raw.feedback = vec![crate::db::FeedFeedback {
            target: "media".to_string(),
            scope: FeedbackScope::Category,
            created_at: now,
        }];
        let after =
            UserAffinityProfile::from_signals(&raw, &catalog, now).affinity_boost(&jellyfin);
        assert!((before - after - 1.5).abs() < 1e-9, "{before} {after}");
    }

    #[test]
    fn seed_similarity_crosses_categories_on_shared_domain_terms() {
        let mut catalog = filler(30);
        catalog.push(cat_item(
            "rustdesk/rustdesk",
            "system",
            "远程控制与局域网传输，Remote control and LAN file transfer",
            &["远程控制", "局域网传输"],
        ));
        catalog.push(cat_item(
            "landrop/landrop",
            "network",
            "局域网传输与远程控制工具，LAN file transfer with remote control",
            &["局域网传输"],
        ));
        let now = 1_700_000_000i64;
        let raw = RawAffinitySignals {
            favorites: vec![("rustdesk/rustdesk".to_string(), now)],
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        let a = catalog[30].to_summary();
        let b = catalog[31].to_summary();
        let sim = profile.seed_similarity(&a, &b);
        assert!(sim >= 0.28, "sim = {sim}");
        let unrelated = catalog[0].to_summary();
        assert!(profile.seed_similarity(&a, &unrelated) < 0.28);
    }

    #[test]
    fn view_weight_uses_burst_debounce_and_log2_with_cap() {
        let now = 1_700_000_000i64;
        // 1. 单次即刻浏览：log2(2) * 0.6 = 0.6
        let w1 = compute_effective_view_weight(&[now], now);
        assert!((w1 - 0.6).abs() < 1e-9, "单次浏览应保持 0.6，实际 {w1}");

        // 2. 5 分钟内连续多次：防抖合并为 1 次
        let w_burst = compute_effective_view_weight(&[now - 200, now - 100, now], now);
        assert!(
            (w_burst - w1).abs() < 0.005,
            "5 分钟内突发浏览应合并为约 1 次，实际 {w_burst}"
        );

        // 3. 间隔超过 5 分钟的 3 次浏览：log2(4) * 0.6 = 1.2
        let w3 = compute_effective_view_weight(&[now - 800, now - 400, now], now);
        assert!(
            (w3 - 1.2).abs() < 0.005,
            "3 次有效浏览应约为 1.2，实际 {w3}"
        );

        // 4. 极大量浏览封顶于 0.6 * 3.5 = 2.1，不会压倒收藏/安装
        let many: Vec<i64> = (0..50).map(|i| now - i * 400).collect();
        let w_many = compute_effective_view_weight(&many, now);
        assert!(
            (w_many - 2.1).abs() < 1e-9,
            "超量浏览应封顶 2.1，实际 {w_many}"
        );
    }

    #[test]
    fn duplicate_views_of_single_app_count_as_one_signal_and_scale_logarithmically() {
        let catalog = sample_catalog();
        let now = 1_700_000_000i64;
        // 同一应用浏览 10 次（间隔 10 分钟），仅计 1 个 signal_count，且不标为 known
        let views_many: Vec<(String, i64)> = (0..10)
            .map(|i| ("mpv-player/mpv".to_string(), now - i * 600))
            .collect();
        let raw = RawAffinitySignals {
            views: views_many,
            ..Default::default()
        };
        let profile = UserAffinityProfile::from_signals(&raw, &catalog, now);
        assert_eq!(
            profile.signal_count, 1,
            "同一应用多次浏览不得虚增 signal_count"
        );
        assert!(!profile.known_ids.contains("mpv-player/mpv"));
        assert!(
            profile
                .category_weights
                .get("media")
                .copied()
                .unwrap_or(0.0)
                > 0.0
        );

        // 与仅浏览 1 次相比，category_weight（软饱和归一化前受单类饱和影响）更高，且增量呈次线性收敛
        let raw_one = RawAffinitySignals {
            views: vec![("mpv-player/mpv".to_string(), now)],
            ..Default::default()
        };
        let profile_one = UserAffinityProfile::from_signals(&raw_one, &catalog, now);
        assert!(
            profile.category_weights["media"] > profile_one.category_weights["media"],
            "多次有效浏览的分类置信度应高于单次浏览"
        );
    }
}
