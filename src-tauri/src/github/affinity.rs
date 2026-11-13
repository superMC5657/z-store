use super::{GITHUB_API_BASE, GITHUB_STARRED_MAX_PAGE_SIZE};
use super::developer_profile::EtagGetOutcome;
use super::models::{CatalogItem, GitHubRepoResponse};
use super::CatalogService;
use crate::db::{Database, FeedbackScope, RawAffinitySignals, RepoRelation, UserRepoSignal};
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

/// 设置项键：是否启用本地个性化精选推荐（默认 `"true"`）。
pub const SETTING_ENABLE_LOCAL_AFFINITY: &str = "enable_local_affinity";

/// 判断本地个性化推荐开关是否开启（缺省或 `"true"` / `"1"` 为开启）。
pub fn is_local_affinity_enabled(db: &Database) -> bool {
    !matches!(
        db.get_setting(SETTING_ENABLE_LOCAL_AFFINITY)
            .ok()
            .flatten()
            .map(|s| s.trim().to_ascii_lowercase()),
        Some(v) if v == "false" || v == "0"
    )
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

    /// ETag 感知的 GitHub 画像信号静默增量同步（全量分页，受 `AFFINITY_SYNC_MAX_PAGES` 上限保护）：
    /// - 端点 1：`/user/starred?per_page=100&page=N` → 写入 `relation = "starred"`
    /// - 端点 2：`/user/repos?type=owner&sort=updated&per_page=100&page=N` → 按 `fork` 字段区分 `"forked"` 与 `"owned"`
    /// - 逐页复用 `api_etag_cache` 发送 `If-None-Match`，`304 Not Modified` 零配额恢复；
    /// - 遵循 `Link: rel="next"` 续拉下一页，任一页失败时中止写入以保留既有完整信号；
    /// - 两个端点均成功（200 或 304）时更新 `user_settings.affinity_github_synced_at`。
    pub async fn sync_github_affinity_signals_bg(
        db_mutex: &Mutex<Database>,
        token: &str,
        api_base: Option<&str>,
    ) -> Result<usize, String> {
        let clean_token = token.trim();
        if clean_token.is_empty() {
            return Err("GitHub Token 为空，跳过画像同步".to_string());
        }

        let starred_rels = [RepoRelation::Starred.as_str()];
        let owner_rels = [RepoRelation::Forked.as_str(), RepoRelation::Owned.as_str()];

        let client = crate::shared_http_client();
        let headers = super::http::bearer_headers(Some(clean_token));
        let now = crate::now_secs();

        let (starred_res, repos_res) = tokio::join!(
            fetch_paginated_repo_signals(
                db_mutex,
                &client,
                &headers,
                api_base,
                now,
                Self::affinity_starred_page_endpoint,
                |_| RepoRelation::Starred,
            ),
            fetch_paginated_repo_signals(
                db_mutex,
                &client,
                &headers,
                api_base,
                now,
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

fn parse_repo_signals_page<F>(
    json_text: &str,
    ts: i64,
    classify: &F,
) -> Option<ParsedSignalPage>
where
    F: Fn(&GitHubRepoResponse) -> RepoRelation,
{
    let repos: Vec<GitHubRepoResponse> = serde_json::from_str(json_text).ok()?;
    let raw_count = repos.len();
    let signals = repos
        .into_iter()
        .filter_map(|r| {
            let full_name = crate::forge::canonical_app_id(r.full_name.as_deref()?)?;
            let relation = classify(&r).as_str().to_string();
            Some(UserRepoSignal {
                full_name,
                relation,
                language: r.language.unwrap_or_default(),
                description: r.description.unwrap_or_default(),
                stars: r.stargazers_count.unwrap_or(0),
                forks: r.forks_count.unwrap_or(0),
                updated_at: ts,
            })
        })
        .collect();
    Some(ParsedSignalPage { signals, raw_count })
}

async fn fetch_paginated_repo_signals<E, F>(
    db_mutex: &Mutex<Database>,
    client: &reqwest::Client,
    headers: &reqwest::header::HeaderMap,
    api_base: Option<&str>,
    now: i64,
    endpoint_for_page: E,
    classify: F,
) -> Result<PaginatedSignalsResult, PaginatedFetchErr>
where
    E: Fn(u32) -> String,
    F: Fn(&GitHubRepoResponse) -> RepoRelation,
{
    let mut all_signals: Vec<UserRepoSignal> = Vec::new();
    let mut seen_keys: HashSet<(String, String)> = HashSet::new();
    let mut fresh_pages: Vec<CachedPageWrite> = Vec::new();
    let mut touched_pages: Vec<String> = Vec::new();
    let mut any_fresh = false;
    let mut last_page = 0u32;

    for page in 1..=AFFINITY_SYNC_MAX_PAGES {
        let ep = endpoint_for_page(page);
        let (cached_etag, cached_payload) = {
            let db = db_mutex.lock().map_err(|_| PaginatedFetchErr::Failed)?;
            let payload = db.get_cached_payload(&ep).ok().flatten();
            let etag = if payload.is_some() {
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
            client,
            &ep,
            api_base,
            headers,
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
                let Some(parsed) = parse_repo_signals_page(&text, now, &classify) else {
                    return Err(PaginatedFetchErr::Failed);
                };
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
                let Some(parsed) = parse_repo_signals_page(&payload, now, &classify) else {
                    return Err(PaginatedFetchErr::Failed);
                };
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
    for page in &res.fresh_pages {
        let _ = db.save_etag(&page.endpoint_url, &page.etag, &page.payload_json, now);
    }
    for ep in &res.touched_pages {
        let _ = db.touch_etag(ep, now);
    }
    if res.last_page > 0 {
        for stale_page in (res.last_page + 1)..=AFFINITY_SYNC_MAX_PAGES {
            let stale_ep = endpoint_for_page(stale_page);
            let has_stale = db.get_etag(&stale_ep).ok().flatten().is_some()
                || db.get_cached_payload(&stale_ep).ok().flatten().is_some();
            if !has_stale {
                break;
            }
            let _ = db.delete_etag(&stale_ep);
        }
    }
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
    pub avg_fork_ratio: f64,
    /// 已收藏 / 关注 / Star / 已安装的应用：推荐时让位推新。
    pub known_ids: HashSet<String>,
    /// 参与聚合的信号条数（画像状态分档与隐私看板使用）。
    pub signal_count: usize,
    /// 已安装应用：不进精选页推荐区块。
    pub installed_ids: HashSet<String>,
    /// 有效期内被标记「不感兴趣」的应用。
    pub dismissed_app_ids: HashSet<String>,
    /// 推荐种子，按 `strength` 降序、同 id 只保留最强关系。
    pub seeds: Vec<SeedRef>,
}

/// 各信号的时间衰减半衰期（天）。
const DECAY_HALF_LIFE_DAYS: f64 = 30.0;
const SHORT_DECAY_HALF_LIFE_DAYS: f64 = 7.0;
/// 浏览历史单应用权重模型参数：基准权重 0.6，5 分钟突发防抖，log2 上限系数 3.5（封顶 2.1）。
const VIEW_BASE_WEIGHT: f64 = 0.6;
const VIEW_BURST_DEBOUNCE_SECS: i64 = 300;
const VIEW_LOG_CAP: f64 = 3.5;

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
    /// 命中的关键词（按权重降序，至多 3 个）。
    matched_tokens: Vec<String>,
    fork_resonance: f64,
    known_penalty: f64,
}

/// 推荐理由的最低分项贡献：低于此值的分项不作为理由展示。
const REASON_MIN_CONTRIBUTION: f64 = 0.25;
/// 单个推荐条目最多展示的理由数。
pub const MAX_REASONS: usize = 2;

/// 信号源仓库 Stars & Forks 规模调制系数：
/// `1.0 + 0.04 * ln(stars + 1) + 0.08 * ln(forks + 1)`
fn repo_scale_factor(stars: u64, forks: u64) -> f64 {
    1.0 + 0.04 * ((stars as f64) + 1.0).ln() + 0.08 * ((forks as f64) + 1.0).ln()
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

/// 停用词过滤表（避免常见虚词污染词袋亲和度）。
fn is_stop_token(tok: &str) -> bool {
    matches!(
        tok,
        "the"
            | "and"
            | "for"
            | "with"
            | "from"
            | "that"
            | "this"
            | "app"
            | "application"
            | "software"
            | "tool"
            | "tools"
            | "open"
            | "source"
            | "free"
            | "cross"
            | "platform"
            | "windows"
            | "linux"
            | "macos"
            | "android"
            | "ios"
            | "client"
            | "based"
            | "written"
            | "fast"
            | "modern"
            | "simple"
            | "lightweight"
            | "using"
            | "built"
            | "support"
    )
}

/// 从文本中提取小写英文词元（长度 >= 3）与关键双字词根。
pub fn extract_affinity_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw_part in text
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '+')
        .map(|s| s.trim_matches('-').to_ascii_lowercase())
    {
        if raw_part.len() >= 3 && !is_stop_token(&raw_part) && seen.insert(raw_part.clone()) {
            out.push(raw_part);
        }
    }
    out
}

/// 将目录外 GitHub Star/Fork 仓库根据 `language`、`description` 与 `full_name`
/// 映射到 ZStore 的 10 大标准分类（返回 `(category_id, confidence)` 列表）。
pub fn infer_categories_from_repo(
    language: &str,
    description: &str,
    full_name: &str,
) -> Vec<(&'static str, f64)> {
    let lang = language.trim().to_ascii_lowercase();
    let text = format!("{} {} {}", full_name, description, language).to_lowercase();

    let rules: [(&str, &[&str]); 10] = [
        (
            "media",
            &[
                "video", "audio", "music", "player", "media", "ffmpeg", "mpv", "vlc", "stream",
                "podcast", "codec", "subtitle", "danmaku", "iptv", "spotify", "lyric", "recorder",
                "音视频", "播放器", "音乐", "视频", "直播", "字幕", "录音",
            ],
        ),
        (
            "security",
            &[
                "security",
                "password",
                "crypto",
                "encrypt",
                "cipher",
                "vault",
                "2fa",
                "totp",
                "otp",
                "auth",
                "privacy",
                "firewall",
                "keepass",
                "bitwarden",
                "gpg",
                "pgp",
                "audit",
                "密码",
                "加密",
                "隐私",
                "安全",
                "验证器",
            ],
        ),
        (
            "network",
            &[
                "network",
                "proxy",
                "vpn",
                "tunnel",
                "dns",
                "clash",
                "sing-box",
                "v2ray",
                "xray",
                "trojan",
                "wireguard",
                "torrent",
                "bittorrent",
                "aria2",
                "download",
                "transfer",
                "localsend",
                "http",
                "packet",
                "代理",
                "下载",
                "传输",
                "网络",
                "磁力",
                "内网穿透",
            ],
        ),
        (
            "ops",
            &[
                "docker",
                "kubernetes",
                "k8s",
                "container",
                "devops",
                "server",
                "monitor",
                "prometheus",
                "grafana",
                "ansible",
                "terraform",
                "nginx",
                "redis",
                "postgres",
                "database",
                "ssh",
                "sftp",
                "cluster",
                "infra",
                "homelab",
                "运维",
                "容器",
                "服务器",
                "监控",
                "数据库",
            ],
        ),
        (
            "graphics",
            &[
                "image",
                "photo",
                "graphics",
                "draw",
                "paint",
                "canvas",
                "blender",
                "3d",
                "svg",
                "vector",
                "design",
                "shader",
                "gimp",
                "krita",
                "inkscape",
                "screenshot",
                "ocr",
                "color",
                "图像",
                "画图",
                "设计",
                "截图",
                "修图",
                "建模",
            ],
        ),
        (
            "office",
            &[
                "note",
                "markdown",
                "knowledge",
                "obsidian",
                "logseq",
                "notion",
                "pdf",
                "document",
                "office",
                "spreadsheet",
                "todo",
                "task",
                "calendar",
                "pomodoro",
                "clipboard",
                "latex",
                "typst",
                "笔记",
                "文档",
                "办公",
                "待办",
                "思维导图",
                "日历",
            ],
        ),
        (
            "reading",
            &[
                "ebook",
                "epub",
                "reader",
                "rss",
                "feed",
                "book",
                "calibre",
                "novel",
                "manga",
                "comic",
                "dictionary",
                "translate",
                "translator",
                "anki",
                "flashcard",
                "阅读",
                "电子书",
                "漫画",
                "翻译",
                "词典",
                "订阅",
            ],
        ),
        (
            "games",
            &[
                "game",
                "gaming",
                "emulator",
                "retro",
                "arcade",
                "minecraft",
                "steam",
                "godot",
                "unity",
                "unreal",
                "voxel",
                "puzzle",
                "chess",
                "游戏",
                "模拟器",
                "联机",
            ],
        ),
        (
            "system",
            &[
                "desktop",
                "remote",
                "rustdesk",
                "window",
                "launcher",
                "explorer",
                "file-manager",
                "file manager",
                "cleaner",
                "uninstaller",
                "disk",
                "partition",
                "archive",
                "zip",
                "7zip",
                "driver",
                "hotkey",
                "autohotkey",
                "powertoys",
                "远程桌面",
                "桌面",
                "系统",
                "清理",
                "压缩",
                "启动器",
                "文件管理",
            ],
        ),
        (
            "dev",
            &[
                "editor",
                "ide",
                "terminal",
                "shell",
                "git",
                "compiler",
                "debugger",
                "sdk",
                "framework",
                "library",
                "cli",
                "neovim",
                "vim",
                "vscode",
                "zed",
                "api",
                "json",
                "regex",
                "開發",
                "开发",
                "终端",
                "编辑器",
                "代码",
            ],
        ),
    ];

    let mut matched: Vec<(&'static str, f64)> = Vec::new();
    for (cat, kw_list) in rules {
        let mut hits = 0usize;
        for kw in kw_list {
            if text.contains(kw) {
                hits += 1;
            }
        }
        if hits > 0 {
            let weight = (0.55 + (hits.saturating_sub(1) as f64) * 0.2).min(1.0);
            matched.push((cat, weight));
        }
    }

    // 语言辅助启发式加成
    let lang_hint: Option<(&'static str, f64)> = match lang.as_str() {
        "hcl" | "dockerfile" | "nix" | "shell" | "bash" | "powershell" => Some(("ops", 0.5)),
        "shaderlab" | "glsl" | "hlsl" | "wgsl" => Some(("graphics", 0.6)),
        "gdscript" => Some(("games", 0.85)),
        "tex" | "typst" => Some(("office", 0.65)),
        _ => None,
    };
    if let Some((cat, w)) = lang_hint {
        if !matched.iter().any(|(c, _)| *c == cat) {
            matched.push((cat, w));
        }
    }

    if matched.is_empty() && !lang.is_empty() {
        matched.push(("dev", 0.45));
    }

    matched.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    matched
}

impl UserAffinityProfile {
    /// 从本地信号快照与当前收录库实时聚合用户亲和度画像。
    pub fn from_signals(
        raw: &RawAffinitySignals,
        catalog: &[CatalogItem],
        now_secs: i64,
    ) -> Self {
        let mut by_id: HashMap<String, &CatalogItem> = HashMap::with_capacity(catalog.len());
        let mut by_repo_name: HashMap<String, Vec<&CatalogItem>> = HashMap::new();
        for item in catalog {
            by_id.insert(item.id.to_lowercase(), item);
            by_repo_name
                .entry(item.repo.to_lowercase())
                .or_default()
                .push(item);
        }

        #[derive(Default)]
        struct AffinityAcc {
            raw_cat: HashMap<String, f64>,
            raw_owner: HashMap<String, f64>,
            raw_tokens: HashMap<String, f64>,
            known_ids: HashSet<String>,
            fork_ratio_sum: f64,
            fork_ratio_weight: f64,
            signal_count: usize,
            seeds: HashMap<String, SeedRef>,
        }

        impl AffinityAcc {
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

            fn add_catalog_item(&mut self, item: &CatalogItem, weight: f64, mark_known: bool) {
                self.signal_count += 1;
                let cat_key = item.category.trim().to_lowercase();
                if !cat_key.is_empty() {
                    *self.raw_cat.entry(cat_key).or_insert(0.0) += weight;
                }
                let owner_key = item.owner.trim().to_lowercase();
                if !owner_key.is_empty() {
                    *self.raw_owner.entry(owner_key).or_insert(0.0) += weight;
                }
                let combined_text = format!(
                    "{} {} {} {} {}",
                    item.name,
                    item.repo,
                    item.description,
                    item.description_en.as_deref().unwrap_or(""),
                    item.aliases.join(" ")
                );
                for tok in extract_affinity_tokens(&combined_text) {
                    *self.raw_tokens.entry(tok).or_insert(0.0) += weight;
                }
                if item.stars > 0 {
                    let ratio = ((item.forks as f64) / (item.stars as f64)).min(1.0);
                    self.fork_ratio_sum += ratio * weight;
                    self.fork_ratio_weight += weight;
                }
                if mark_known {
                    self.known_ids.insert(item.id.to_lowercase());
                }
            }
        }

        let mut acc = AffinityAcc::default();

        // 1. 应用内收藏 (user_favorites): 基准权重 4.0
        for (app_id, ts) in &raw.favorites {
            let id_lower = app_id.trim().to_lowercase();
            if id_lower.is_empty() {
                continue;
            }
            let decay = time_decay(*ts, now_secs);
            acc.known_ids.insert(id_lower.clone());
            if let Some(item) = by_id.get(&id_lower) {
                let scale = repo_scale_factor(item.stars, item.forks);
                acc.add_catalog_item(item, 4.0 * decay * scale, true);
                acc.add_seed(item, SeedRelation::Favorite, 4.0 * decay);
            }
        }

        // 2. 应用内版本关注 (watched_apps): 基准权重 3.5
        for (app_id, ts) in &raw.watched {
            let id_lower = app_id.trim().to_lowercase();
            if id_lower.is_empty() {
                continue;
            }
            let decay = time_decay(*ts, now_secs);
            acc.known_ids.insert(id_lower.clone());
            if let Some(item) = by_id.get(&id_lower) {
                let scale = repo_scale_factor(item.stars, item.forks);
                acc.add_catalog_item(item, 3.5 * decay * scale, true);
                acc.add_seed(item, SeedRelation::Watched, 3.5 * decay);
            }
        }

        // 2b. 已安装 (installed_apps): 基准权重 3.2，30 天半衰期；已装应用不再推荐
        let mut installed_ids: HashSet<String> = HashSet::new();
        for (app_id, ts) in &raw.installed {
            let id_lower = app_id.trim().to_lowercase();
            if id_lower.is_empty() {
                continue;
            }
            installed_ids.insert(id_lower.clone());
            acc.known_ids.insert(id_lower.clone());
            let decay = time_decay(*ts, now_secs);
            if let Some(item) = by_id.get(&id_lower) {
                let scale = repo_scale_factor(item.stars, item.forks);
                acc.add_catalog_item(item, 3.2 * decay * scale, true);
                acc.add_seed(item, SeedRelation::Installed, 3.2 * decay);
            }
        }

        // 记录已在 repo_signals 中处理过的 starred 仓库，避免与 user_stars 重复累加
        let mut starred_in_repo_signals: HashSet<String> = HashSet::new();

        // 3. GitHub 仓库信号 (user_repo_signals: 'forked'=3.8, 'starred'=3.0, 'owned'=2.4)
        for sig in &raw.repo_signals {
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
            let scale = repo_scale_factor(sig.stars, sig.forks);
            let w = base_w * decay * scale;

            // 尝试精确匹配 CatalogItem；若为 forked 仓库 (<user>/<repo>)，额外按 <repo> 反查上游条目
            let matched_cat_item: Option<&CatalogItem> =
                by_id.get(&full_lower).copied().or_else(|| {
                    if rel_kind == Some(RepoRelation::Forked) {
                        let (_, repo_part) = full_lower.split_once('/')?;
                        by_repo_name
                            .get(repo_part)
                            .and_then(|list| list.iter().max_by_key(|c| c.stars).copied())
                    } else {
                        None
                    }
                });

            if let Some(item) = matched_cat_item {
                let eff_stars = sig.stars.max(item.stars);
                let eff_forks = sig.forks.max(item.forks);
                let eff_w = base_w * decay * repo_scale_factor(eff_stars, eff_forks);
                acc.add_catalog_item(item, eff_w, true);
                let relation = match rel_kind {
                    Some(RepoRelation::Forked) => Some(SeedRelation::Forked),
                    Some(RepoRelation::Starred) => Some(SeedRelation::Starred),
                    Some(RepoRelation::Owned) => Some(SeedRelation::Owned),
                    None => None,
                };
                if let Some(relation) = relation {
                    acc.add_seed(item, relation, base_w * decay);
                }
            } else {
                acc.signal_count += 1;
                let inferred =
                    infer_categories_from_repo(&sig.language, &sig.description, &full_lower);
                for (cat, conf) in inferred {
                    *acc.raw_cat.entry(cat.to_string()).or_insert(0.0) += w * conf;
                }
                if rel_kind == Some(RepoRelation::Starred) {
                    if let Some((owner, _)) = full_lower.split_once('/') {
                        if !owner.is_empty() {
                            *acc.raw_owner.entry(owner.to_string()).or_insert(0.0) += w * 0.6;
                        }
                    }
                }
                let text = format!("{} {} {}", full_lower, sig.language, sig.description);
                for tok in extract_affinity_tokens(&text) {
                    *acc.raw_tokens.entry(tok).or_insert(0.0) += w * 0.85;
                }
                if sig.stars > 0 {
                    let ratio = ((sig.forks as f64) / (sig.stars as f64)).min(1.0);
                    acc.fork_ratio_sum += ratio * w;
                    acc.fork_ratio_weight += w;
                }
            }
        }

        // 4. 应用内 Star 表 (user_stars): 补充未在 repo_signals 出现的星标记录，基准权重 3.0
        for (full_name, ts) in &raw.user_stars {
            let full_lower = full_name.trim().to_lowercase();
            if full_lower.is_empty() || starred_in_repo_signals.contains(&full_lower) {
                continue;
            }
            let decay = time_decay(*ts, now_secs);
            acc.known_ids.insert(full_lower.clone());
            if let Some(item) = by_id.get(&full_lower) {
                let scale = repo_scale_factor(item.stars, item.forks);
                acc.add_catalog_item(item, 3.0 * decay * scale, true);
                acc.add_seed(item, SeedRelation::Starred, 3.0 * decay);
            } else if let Some((owner, repo)) = full_lower.split_once('/') {
                acc.signal_count += 1;
                let w = 3.0 * decay;
                *acc.raw_owner.entry(owner.to_string()).or_insert(0.0) += w * 0.6;
                for tok in extract_affinity_tokens(repo) {
                    *acc.raw_tokens.entry(tok).or_insert(0.0) += w * 0.7;
                }
            }
        }

        // 5. 浏览历史 (view_history): 同应用去抖合并后按时间衰减求有效次数，再做 log2(1 + c_eff)
        // 加权并封顶（0.6 * min(log2(1 + c_eff), 3.5) <= 2.1），仅命中目录的条目；不计入已知，
        // 且按去重应用数计入 signal_count。
        let mut views_by_app: HashMap<String, Vec<i64>> = HashMap::new();
        for (app_id, ts) in &raw.views {
            let id_lower = app_id.trim().to_lowercase();
            if id_lower.is_empty() || !by_id.contains_key(&id_lower) {
                continue;
            }
            views_by_app.entry(id_lower).or_default().push(*ts);
        }
        for (id_lower, ts_list) in views_by_app {
            if let Some(item) = by_id.get(&id_lower) {
                let weight = compute_effective_view_weight(&ts_list, now_secs);
                if weight > 1e-9 {
                    acc.add_catalog_item(item, weight, false);
                }
            }
        }

        // 6. 搜索词 (search_history): 基准权重 0.4，7 天半衰期，只进关键词词袋
        for (query, ts) in &raw.searches {
            let toks = extract_affinity_tokens(query);
            if toks.is_empty() {
                continue;
            }
            acc.signal_count += 1;
            let w = 0.4 * time_decay_with(*ts, now_secs, SHORT_DECAY_HALF_LIFE_DAYS, 0.0);
            for tok in toks {
                *acc.raw_tokens.entry(tok).or_insert(0.0) += w;
            }
        }

        // 7. 兴趣种子 (user_interest_seeds): 基准权重 2.0，不衰减，只进分类权重
        for cat in &raw.interest_seeds {
            let key = cat.trim().to_lowercase();
            if key.is_empty() {
                continue;
            }
            acc.signal_count += 1;
            *acc.raw_cat.entry(key).or_insert(0.0) += 2.0;
        }

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
                dismissed_app_ids,
                known_ids: acc.known_ids,
                ..Self::default()
            };
        }

        let mut category_weights = normalize_soft_saturated(acc.raw_cat, 2.2);
        for cat in &dismissed_categories {
            if let Some(w) = category_weights.get_mut(cat) {
                *w *= 0.5;
            }
        }
        let owner_weights = normalize_soft_saturated(acc.raw_owner, 2.5);
        let token_weights = normalize_soft_saturated(acc.raw_tokens, 2.5);
        let avg_fork_ratio = if acc.fork_ratio_weight > 0.0 {
            (acc.fork_ratio_sum / acc.fork_ratio_weight).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let has_signals = !category_weights.is_empty()
            || !owner_weights.is_empty()
            || !token_weights.is_empty();

        Self {
            has_signals,
            category_weights,
            owner_weights,
            token_weights,
            avg_fork_ratio,
            known_ids: acc.known_ids,
            signal_count: acc.signal_count,
            installed_ids,
            dismissed_app_ids,
            seeds: {
                let mut seeds: Vec<SeedRef> = acc.seeds.into_values().collect();
                seeds.sort_by(|a, b| {
                    b.strength
                        .partial_cmp(&a.strength)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| a.id.cmp(&b.id))
                });
                seeds
            },
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
    /// `3.2 * P_cat + 1.8 * P_owner + 1.8 * P_tok + ForkResonance - 1.2 * I(AlreadyKnown)`
    pub fn affinity_boost(&self, app: &AppSummary) -> f64 {
        if !self.has_signals {
            return 0.0;
        }
        let b = self.breakdown(app);
        3.2 * b.cat + 1.8 * b.owner + 1.8 * b.tok + b.fork_resonance - b.known_penalty
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
        if 1.8 * b.tok >= REASON_MIN_CONTRIBUTION && !b.matched_tokens.is_empty() {
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

        let app_text = format!(
            "{} {}",
            app.core.description,
            app.core.description_en.as_deref().unwrap_or("")
        );
        let tokens = extract_affinity_tokens(&app_text);
        let mut matched: Vec<(String, f64)> = tokens
            .into_iter()
            .filter_map(|t| {
                let w = self.token_weights.get(&t).copied()?;
                Some((t, w))
            })
            .collect();
        matched.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let take_n = matched.len().min(3);
        let raw_tok_score = if take_n == 0 {
            0.0
        } else {
            let sum: f64 = matched.iter().take(take_n).map(|(_, w)| *w).sum();
            (sum / (take_n as f64)).clamp(0.0, 1.0)
        };
        let matched_tokens: Vec<String> = matched.into_iter().take(take_n).map(|(t, _)| t).collect();
        let tok_score = if is_known {
            raw_tok_score * 0.4
        } else {
            raw_tok_score
        };

        let fork_resonance = if app.core.stars > 0 && app.core.forks > 0 && self.avg_fork_ratio > 0.0
        {
            let app_ratio = ((app.core.forks as f64) / (app.core.stars as f64)).min(1.0);
            let diff = (app_ratio - self.avg_fork_ratio).abs();
            (1.0 - (diff / 0.25).min(1.0)) * 0.35
        } else {
            0.0
        };

        let known_penalty = if is_known { 1.2 } else { 0.0 };

        AffinityBreakdown {
            cat: cat_score,
            owner: owner_score,
            tok: tok_score,
            matched_tokens,
            fork_resonance,
            known_penalty,
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
}

/// 候选应用与推荐种子的相似度：同分类 0.5 + 同作者 0.3 + 描述关键词 Jaccard × 0.2。
pub fn seed_similarity(seed: &AppSummary, candidate: &AppSummary) -> f64 {
    let same_cat = !seed.core.category.trim().is_empty()
        && seed.core.category.trim().eq_ignore_ascii_case(candidate.core.category.trim());
    let same_owner = !seed.core.owner.trim().is_empty()
        && seed.core.owner.trim().eq_ignore_ascii_case(candidate.core.owner.trim());
    let toks = |a: &AppSummary| -> HashSet<String> {
        extract_affinity_tokens(&format!(
            "{} {}",
            a.core.description,
            a.core.description_en.as_deref().unwrap_or("")
        ))
        .into_iter()
        .collect()
    };
    let (ta, tb) = (toks(seed), toks(candidate));
    let union = ta.union(&tb).count();
    let jaccard = if union == 0 {
        0.0
    } else {
        ta.intersection(&tb).count() as f64 / union as f64
    };
    (if same_cat { 0.5 } else { 0.0 }) + (if same_owner { 0.3 } else { 0.0 }) + 0.2 * jaccard
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
    async fn sync_github_affinity_signals_sends_etag_and_persists_relations() {
        let starred_json = serde_json::json!([
            {
                "name": "mpv",
                "full_name": "mpv-player/mpv",
                "description": "Command line video player",
                "stargazers_count": 28000u64,
                "forks_count": 2900u64,
                "language": "C",
                "fork": false
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
                    body: mk_repo_json(starred_p1),
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
                    body: mk_repo_json(starred_p2),
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

        // 清空本地画像后再次同步：两页均命中 304，必须完整从 api_etag_cache 恢复全部 247 条
        db_mutex
            .lock()
            .unwrap()
            .clear_affinity_profile_signals()
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
                    body: mk_repo_json(starred_p1),
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
        // repos 成功（1 owned），starred 因第 2 页失败而保留原有 keep/existing（不被截断覆盖）
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
                    body: mk_repo_json(vec![("org/one".to_string(), false, "Rust")]),
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
        assert_eq!(counts.get("/user/starred?per_page=100&page=1").copied(), Some(2));
        assert_eq!(counts.get("/user/starred?per_page=100&page=2").copied(), None);
    }

    #[tokio::test]
    async fn sync_github_affinity_signals_recovers_when_trailing_page_etag_evicted_and_touches_304_lru() {
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
                    body: mk_repo_json(starred_p1),
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
                    body: mk_repo_json(starred_p2),
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
            db.save_etag("https://api.github.com/repos/other/older", "\"old\"", "{}", 500)
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
            assert_eq!(signals.len(), 135, "尾页缓存缺失时不得在 page=1 (304) 处截断");
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
            profile.category_weights.get("media").copied().unwrap_or(0.0) > 0.7,
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
        assert!(profile.category_weights.get("system").copied().unwrap_or(0.0) > 0.0);
        assert!(profile.known_ids.contains("rustdesk/rustdesk"));
        assert!(profile.installed_ids.contains("rustdesk/rustdesk"));
        assert_eq!(profile.signal_count, 1);
        assert_eq!(profile.seeds[0].relation, SeedRelation::Installed);
    }

    #[test]
    fn short_decay_halves_after_seven_days() {
        let now = 1_700_000_000i64;
        let d = time_decay_with(now - 7 * 86400, now, SHORT_DECAY_HALF_LIFE_DAYS, 0.0);
        assert!((d - 0.5).abs() < 0.005, "7 天前的浏览权重应约为一半，实际 {d}");
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
        assert!(profile.token_weights.contains_key("desktop"));
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
        assert!(seed_similarity(&mpv, &jellyfin) >= 0.5);
        assert!(seed_similarity(&mpv, &rustdesk) < 0.35);
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
        assert!(profile.category_weights.get("media").copied().unwrap_or(0.0) > 0.0);

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
