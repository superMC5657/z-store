use super::developer_endpoints::{GITHUB_API_BASE, GITHUB_STARRED_MAX_PAGE_SIZE};
use super::developer_profile::EtagGetOutcome;
use super::models::{CatalogItem, GitHubRepoResponse};
use super::CatalogService;
use crate::db::{Database, RawAffinitySignals, RepoRelation, UserRepoSignal};
use crate::models::{AppSummary, DeveloperRepoItem, StarredSyncResult};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// 跨周期启动增量同步冷却窗口：6 小时（21600 秒）。
/// 用户隔天或隔半个月重新打开应用时自动触发 ETag 条件请求同步。
pub const AFFINITY_SYNC_COOLDOWN_SECS: i64 = 6 * 3600;

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
    /// 用户 GitHub Star 仓库画像同步端点（canonical ETag 缓存键）。
    pub fn affinity_starred_endpoint() -> String {
        format!(
            "{}/user/starred?per_page={}",
            GITHUB_API_BASE, GITHUB_STARRED_MAX_PAGE_SIZE
        )
    }

    /// 用户个人及 Fork 仓库画像同步端点（canonical ETag 缓存键）。
    pub fn affinity_owner_repos_endpoint() -> String {
        format!(
            "{}/user/repos?type=owner&sort=updated&per_page={}",
            GITHUB_API_BASE, GITHUB_STARRED_MAX_PAGE_SIZE
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

    /// ETag 感知的 GitHub 画像信号静默增量同步：
    /// - 端点 1：`/user/starred?per_page=100` → 写入 `relation = "starred"`
    /// - 端点 2：`/user/repos?type=owner&sort=updated&per_page=100` → 按 `fork` 字段区分 `"forked"` 与 `"owned"`
    /// - 复用 `api_etag_cache` 发送 `If-None-Match`，`304 Not Modified` 零配额恢复；
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

        let starred_ep = Self::affinity_starred_endpoint();
        let repos_ep = Self::affinity_owner_repos_endpoint();
        let starred_rels = [RepoRelation::Starred.as_str()];
        let owner_rels = [RepoRelation::Forked.as_str(), RepoRelation::Owned.as_str()];

        let (
            starred_etag,
            starred_payload,
            has_starred,
            repos_etag,
            repos_payload,
            has_owner_repos,
        ) = {
            let db = db_mutex.lock().map_err(|e| e.to_string())?;
            let s_etag = db
                .get_etag(&starred_ep)
                .ok()
                .flatten()
                .filter(|e| !e.trim().is_empty());
            let s_payload = db.get_cached_payload(&starred_ep).ok().flatten();
            let s_has = db.has_user_repo_signals_for_relations(&starred_rels);
            let r_etag = db
                .get_etag(&repos_ep)
                .ok()
                .flatten()
                .filter(|e| !e.trim().is_empty());
            let r_payload = db.get_cached_payload(&repos_ep).ok().flatten();
            let r_has = db.has_user_repo_signals_for_relations(&owner_rels);
            (s_etag, s_payload, s_has, r_etag, r_payload, r_has)
        };

        let client = super::http::build_api_client()?;
        let headers = super::http::bearer_headers(Some(clean_token));

        let (starred_outcome, repos_outcome) = tokio::join!(
            Self::get_with_etag(
                &client,
                &starred_ep,
                api_base,
                &headers,
                starred_etag.as_deref(),
                "affinity-starred",
            ),
            Self::get_with_etag(
                &client,
                &repos_ep,
                api_base,
                &headers,
                repos_etag.as_deref(),
                "affinity-repos",
            )
        );

        let now = crate::now_secs();
        let db = db_mutex.lock().map_err(|e| e.to_string())?;

        let starred_ok = apply_etag_signal_outcome(
            &db,
            &starred_ep,
            &starred_rels,
            starred_outcome,
            starred_payload.as_deref(),
            has_starred,
            now,
            |_| RepoRelation::Starred,
        );
        let repos_ok = apply_etag_signal_outcome(
            &db,
            &repos_ep,
            &owner_rels,
            repos_outcome,
            repos_payload.as_deref(),
            has_owner_repos,
            now,
            |r| {
                if r.fork.unwrap_or(false) {
                    RepoRelation::Forked
                } else {
                    RepoRelation::Owned
                }
            },
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

    /// 从本地 `api_etag_cache` 已缓存的 `/user/starred` 响应组装 `StarredSyncResult`（零额外网络请求）。
    pub fn build_starred_sync_result_from_cached(
        &self,
        db_mutex: &Mutex<Database>,
    ) -> Result<StarredSyncResult, String> {
        let starred_ep = Self::affinity_starred_endpoint();
        let db = db_mutex.lock().map_err(|e| e.to_string())?;
        let payload = db
            .get_cached_payload(&starred_ep)
            .ok()
            .flatten()
            .unwrap_or_else(|| "[]".to_string());
        let starred_list: Vec<GitHubRepoResponse> = serde_json::from_str(&payload)
            .map_err(|e| format!("解析本地 Starred 缓存数据失败: {}", e))?;

        let total_starred = starred_list.len();
        let catalog_list = self.get_catalog_items();
        let mut catalog_matches = Vec::new();
        let mut other_repos = Vec::new();

        for r in starred_list {
            let full_name = r.full_name.clone().unwrap_or_default();
            let repo_name = r.name.clone().unwrap_or_default();
            if let Some(cat) = catalog_list.iter().find(|c| {
                crate::forge::canonical_app_id(&full_name).as_deref() == Some(c.id.as_str())
            }) {
                catalog_matches.push(self.item_to_stamped_summary(cat));
            } else {
                let html_url = r
                    .html_url
                    .unwrap_or_else(|| format!("https://github.com/{}", full_name));
                let rel_ep = Self::starred_release_endpoint(&full_name);
                let latest_release_tag = db
                    .get_cached_payload(&rel_ep)
                    .ok()
                    .flatten()
                    .and_then(|pl| Self::parse_release_tag(&pl));
                let has_releases = latest_release_tag.is_some();
                other_repos.push(DeveloperRepoItem {
                    id: full_name.clone(),
                    name: repo_name,
                    full_name,
                    description: r.description,
                    html_url,
                    stars: r.stargazers_count.unwrap_or(0),
                    forks: r.forks_count.unwrap_or(0),
                    language: r.language,
                    has_releases,
                    in_catalog: false,
                    latest_release_tag,
                });
            }
        }

        Ok(StarredSyncResult {
            total_starred,
            catalog_matches,
            other_repos,
        })
    }
}

fn parse_repo_signals<F>(json_text: &str, ts: i64, classify: F) -> Option<Vec<UserRepoSignal>>
where
    F: Fn(&GitHubRepoResponse) -> RepoRelation,
{
    let repos: Vec<GitHubRepoResponse> = serde_json::from_str(json_text).ok()?;
    Some(
        repos
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
            .collect(),
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_etag_signal_outcome<F>(
    db: &Database,
    endpoint_url: &str,
    relations: &[&str],
    outcome: EtagGetOutcome,
    cached_payload: Option<&str>,
    has_existing_for_relations: bool,
    now: i64,
    classify: F,
) -> bool
where
    F: Fn(&GitHubRepoResponse) -> RepoRelation,
{
    match outcome {
        EtagGetOutcome::Fresh { text, etag } => {
            if let Some(signals) = parse_repo_signals(&text, now, classify) {
                let _ = db.replace_user_repo_signals_by_relations(relations, &signals);
                let _ = db.save_etag(endpoint_url, etag.as_deref().unwrap_or(""), &text, now);
                return true;
            }
            false
        }
        EtagGetOutcome::NotModified => {
            if !has_existing_for_relations {
                if let Some(payload) = cached_payload {
                    if let Some(signals) = parse_repo_signals(payload, now, classify) {
                        let _ = db.replace_user_repo_signals_by_relations(relations, &signals);
                    }
                }
            }
            true
        }
        EtagGetOutcome::Unauthorized => {
            crate::notify_auth_expired();
            false
        }
        EtagGetOutcome::Failed => false,
    }
}

/// 用户本地亲和度画像（内存中由 `RawAffinitySignals` 实时聚合）。
#[derive(Debug, Clone, Default)]
pub struct UserAffinityProfile {
    pub has_signals: bool,
    pub category_weights: HashMap<String, f64>,
    pub owner_weights: HashMap<String, f64>,
    pub token_weights: HashMap<String, f64>,
    pub avg_fork_ratio: f64,
    pub known_ids: HashSet<String>,
}

/// 30 天半衰期时间衰减函数，保底系数 `0.25`。
fn time_decay(timestamp: i64, now_secs: i64) -> f64 {
    if timestamp <= 0 || now_secs <= timestamp {
        return 1.0;
    }
    let dt = (now_secs - timestamp) as f64;
    let half_life = 30.0 * 86400.0;
    let lambda = std::f64::consts::LN_2 / half_life;
    (-lambda * dt).exp().max(0.25)
}

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
        }

        impl AffinityAcc {
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
            } else if let Some((owner, repo)) = full_lower.split_once('/') {
                acc.signal_count += 1;
                let w = 3.0 * decay;
                *acc.raw_owner.entry(owner.to_string()).or_insert(0.0) += w * 0.6;
                for tok in extract_affinity_tokens(repo) {
                    *acc.raw_tokens.entry(tok).or_insert(0.0) += w * 0.7;
                }
            }
        }

        if acc.signal_count == 0 {
            return Self::default();
        }

        let category_weights = normalize_soft_saturated(acc.raw_cat, 2.2);
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
        }
    }

    /// 计算候选应用相对于当前用户画像的动态亲和度增益：
    /// `3.2 * P_cat + 1.8 * P_owner + 1.8 * P_tok + ForkResonance - 1.2 * I(AlreadyKnown)`
    pub fn affinity_boost(&self, app: &AppSummary) -> f64 {
        if !self.has_signals {
            return 0.0;
        }

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
        let mut matched_tok_weights: Vec<f64> = tokens
            .iter()
            .filter_map(|t| self.token_weights.get(t).copied())
            .collect();
        matched_tok_weights.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        let raw_tok_score = if matched_tok_weights.is_empty() {
            0.0
        } else {
            let take_n = matched_tok_weights.len().min(3);
            let sum: f64 = matched_tok_weights.iter().take(take_n).sum();
            (sum / (take_n as f64)).clamp(0.0, 1.0)
        };
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

        3.2 * cat_score + 1.8 * owner_score + 1.8 * tok_score + fork_resonance - known_penalty
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
    use crate::github::developer_starred::test_support::{spawn_mock, MockResp};
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
            "/user/starred?per_page=100".to_string(),
            MockResp {
                status: 200,
                reason: "OK",
                etag: Some("\"etag-starred-1\"".to_string()),
                body: starred_json,
                honor_inm: Some("\"etag-starred-1\"".to_string()),
            },
        );
        routes.insert(
            "/user/repos?type=owner&sort=updated&per_page=100".to_string(),
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
            seen.get("/user/starred?per_page=100")
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"etag-starred-1\"")
        );
        assert_eq!(
            seen.get("/user/repos?type=owner&sort=updated&per_page=100")
                .cloned()
                .flatten()
                .as_deref(),
            Some("\"etag-repos-1\"")
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
}
