use crate::AppState;
use serde::{Deserialize, Serialize};

// 图标 C1 深核适配层（薄）：探测经 `github::icon_fetch` 深核直调
// `icon_probe` 原语（L2/L3-live 纯探，不碰 DB/fs），持久化经单一写入路径
// `write_icon_file`（`catalog vs cycle` 分流收敛在内 + `icons/` 落盘 +
// `icon_cache_meta` 同步），下载经 `download_icon_bytes_direct`；
// L1=官方填充 + L4=README 现场扒分居本适配器
//（详情链专属，不受流式核约束），L5 空选经 `empty_cycle_result` + `seal_empty_selection`。
// `persist_catalog_icon`/`cleanup_stale_cycle_variants` 为缝内私有，
// 命令层只经 `write_icon_file`/`download_icon_bytes_direct`（probe-vs-persist 缝合一）。

// ADR-0008：网络超时统一经 `config::api_timeout_or` 单一来源（统一配置中枢同一键）；
// 配置为 0（未设置）时回退到调用方传入的默认值。
pub(crate) use crate::config::api_timeout_or;

/// 图标轮换返回结构
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IconCycleResult {
    pub url: String,
    pub remote_url: String,
    pub level: i32,
    pub source: String,
    pub is_fallback: bool,
    pub total_levels: usize,
    pub is_cataloged: bool,
}

pub(crate) use crate::db::icon_cycle::{
    first_available_level, is_fallback_for_level, next_cycle_level, source_for_level,
};

/// 解析入站应用标识（薄委托：本体见 db::icon_cycle::resolve_icon_coord）：
/// 非收录 app_id 允许 owner/repo 直通（不经过必须在收录库中的强校验）。
pub(crate) fn resolve_app_coord(app_id: &str) -> Result<(String, String, String), String> {
    let (canon, repo) = crate::db::icon_cycle::resolve_icon_coord(app_id)?;
    Ok((canon, repo.owner, repo.repo))
}

/// 图标下载唯一落点：失败只记 warn（见调用方），不重试。
/// 命令层一律经此。
pub(crate) async fn download_icon_bytes_direct(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    crate::commands::icons::download_icon_bytes(client, None, url).await
}

/// L5 空态返回统一构造（首字母徽章，level 纯L=5）：
/// `url/remote=""` + source=none + fallback=true。命令层 L5 三处散字面量收敛至此；
/// `is_cataloged` 原样透传（收录恒 L1 不会进此，签名保留防串）。
pub(crate) fn empty_cycle_result(is_cataloged: bool) -> IconCycleResult {
    IconCycleResult {
        url: String::new(),
        remote_url: String::new(),
        level: 5,
        source: "none".to_string(),
        is_fallback: true,
        total_levels: 5,
        is_cataloged,
    }
}

/// 有效图片文件读取唯一落点：存在 + 可读 + 非空 + 合法图片才返回字节。
pub(crate) fn read_valid_image_file(path: &std::path::Path) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    std::fs::read(path)
        .ok()
        .filter(|b| !b.is_empty() && crate::commands::icons::is_valid_image(b))
}

/// 最高频缓存读的 blocking 卸载：仅最高频 1-2 处经此异步入口（spawn_blocking），
/// 其余同步路径（read_level_cache_file / load_split_cached_bytes / 落盘写等）保持不动。
pub(crate) async fn read_valid_image_file_async(path: std::path::PathBuf) -> Option<Vec<u8>> {
    tokio::task::spawn_blocking(move || read_valid_image_file(&path))
        .await
        .ok()
        .flatten()
}

/// 落盘扩展名全集（读侧兜底 + 写侧残留清理用）：`infer` 白名单 + `mime_to_ext` 实产出。
pub(crate) const KNOWN_ICON_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "apng", "bmp",
];

/// 图标 persist/read 坐标束：将 `persist_*` / `read_*` / hash 候选路径上
/// 散装 travelling 的 `(url, ext)` 收为单一域类型，参数顺序写错即编译错。
/// - `url`：备选 Logo 真地址（调用方保证已 trim，类型 `&str` 不变，无归一化）；
/// - `ext`：URL 后缀暂定（类型 `&str` 不变；写侧 sniff 纠正的
///   `real_ext` 仍在缝内由字节派生，不进本束）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct IconRef<'a> {
    pub url: &'a str,
    pub ext: &'a str,
}

impl<'a> IconRef<'a> {
    pub(crate) fn new(url: &'a str, ext: &'a str) -> Self {
        Self { url, ext }
    }
}

/// hash 候选文件名唯一构造（FINAL 双探：`inferred` 快路径 + `KNOWN` 全后缀兜底，sniff 纠正场景）：
/// `read_level_cache_file` 与 `load_split_cached_bytes`（收录 hash 双探）共用此唯一构造。
/// 空 url 返回空 Vec（调用方视为未命中）。
fn hash_icon_candidate_filenames(icon: &IconRef<'_>) -> Vec<String> {
    let url = icon.url.trim();
    if url.is_empty() {
        return Vec::new();
    }
    let full = crate::sha256_digest_hex(url.as_bytes());
    let hash_stem = &full[..16.min(full.len())];
    let mut out: Vec<String> = Vec::with_capacity(KNOWN_ICON_EXTS.len() + 1);
    out.push(format!("{}.{}", hash_stem, icon.ext));
    for ext in KNOWN_ICON_EXTS {
        if *ext == icon.ext {
            continue;
        }
        out.push(format!("{}.{}", hash_stem, ext));
    }
    out
}

/// 指定级别缓存文件读取（hash 双探：`inferred` 快路径 + `KNOWN` 全后缀兜底）：
/// `sha256(url)[0:16].{ext}`；命中要求：存在 + 合法图 + 文件 7 天新鲜（`is_icon_file_fresh`）；
/// 图标通道禁用 ETag，不查表。未中由调用方走网络重拉。
/// L1–L4 备选 Logo 必落盘；README 正文图永不进此（调用方不传正文 URL）。
pub(crate) fn read_level_cache_file(
    icons_dir: &std::path::Path,
    icon: &IconRef<'_>,
) -> Option<Vec<u8>> {
    for fname in hash_icon_candidate_filenames(icon) {
        let p = icons_dir.join(&fname);
        if crate::commands::icons::is_icon_file_fresh(&p) {
            if let Some(b) = read_valid_image_file(&p) {
                return Some(b);
            }
        }
    }
    None
}

/// 两表分流缓存读取唯一落点（FINAL：hash 双探 + 7 天 TTL + ETag 禁用）：
/// - 收录查 `icon_cache_meta`（要求：文件存在 + 合法图 + 文件 7 天新鲜 + meta URL 相等 + meta 7 天有效）；
///   `hash(url).{ext}` 候选（含全后缀兜底）；
/// - 非收录查传入 cycle（要求：`cache_file` 非空 + `selected_url` 相等 + 文件 7 天新鲜 + 行 7 天有效
///   `is_icon_fresh(updated_at)`；`cache_file` 本身已是最终 hash 名）；
/// - `noncatalog_cycle=None` 或 `cache_file` 为空视为未命中；TTL 外一律视为未命中（调用方后台重下 1 次，前台不闪）。
/// - 图标通道禁用 ETag 查表：此处永不读 `api_etag_cache`，命中即 0 请求；ETag 仅详情/平台通道用。
/// - L1–L4 备选 Logo 必落盘命中；README 正文图永不进此（调用方不传正文 URL，不计不预热）。
pub(crate) fn load_split_cached_bytes(
    icons_dir: &std::path::Path,
    db: &crate::db::Database,
    icon: &IconRef<'_>,
    is_cataloged: bool,
    noncatalog_cycle: Option<&crate::db::AppIconCycle>,
) -> Option<Vec<u8>> {
    let url_trimmed = icon.url.trim();
    let now = crate::now_secs();
    if is_cataloged {
        // hash(url).{inferred + KNOWN 兜底}，每候选验 “文件新鲜 + DB 记录 URL 相等 + DB 7 天有效”。
        for filename in hash_icon_candidate_filenames(icon) {
            let cache_file = icons_dir.join(&filename);
            if !crate::commands::icons::is_icon_file_fresh(&cache_file) {
                continue;
            }
            if let Ok(Some((recorded_url, at))) =
                crate::db::icon_cycle::get_icon_cache_record(db, &filename)
            {
                if recorded_url.trim() == url_trimmed
                    && crate::db::icon_cycle::is_icon_fresh(at, now)
                {
                    if let Some(b) = read_valid_image_file(&cache_file) {
                        return Some(b);
                    }
                }
            }
        }
        None
    } else if let Some(cycle) = noncatalog_cycle {
        // DB 有效：行 7 天内 + selected_url 相等；文件有效：存在 + 合法 + 7 天新鲜。
        if cycle.cache_file.is_empty() || cycle.selected_url.trim() != url_trimmed {
            return None;
        }
        if !crate::db::icon_cycle::is_icon_fresh(cycle.updated_at, now) {
            return None;
        }
        let p = icons_dir.join(&cycle.cache_file);
        if !crate::commands::icons::is_icon_file_fresh(&p) {
            return None;
        }
        read_valid_image_file(&p)
    } else {
        None
    }
}

/// 同 hash 同 ext 的旧后缀残留清理（缝内私有）：保留 `keep_filename`，
/// 同 hash 其余 [`KNOWN_ICON_EXTS`] 变体存在即删（sniff 纠正场景 `png→jpg` 防双文件）。
fn cleanup_stale_cycle_variants(
    icons_dir: &std::path::Path,
    keep_filename: &str,
) {
    // keep 为 hash 名时：同 hash 不同 ext 变体即删。
    if let Some(dot) = keep_filename.rfind('.') {
        let keep_stem = &keep_filename[..dot];
        for ext in KNOWN_ICON_EXTS {
            let alt = format!("{}.{}", keep_stem, ext);
            if alt != keep_filename {
                let p = icons_dir.join(&alt);
                if p.is_file() {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
}

/// 收录应用落盘唯一落点（hash 单轨）：
/// `hash(url).{real_ext}` 落盘 + `icon_cache_meta[hash名]` 同步（改名时删旧 inferred-hash 键），
/// 返回最终 hash 文件名。全量清理同 hash 其余变体 + 对应旧 meta 键。
/// 取 `icon.url` + `icon.ext`（inferred，仅旧键清理用）。
fn persist_catalog_icon(
    icons_dir: &std::path::Path,
    db_opt: Option<&crate::db::Database>,
    icon: &IconRef<'_>,
    real_ext: &str,
    bytes: &[u8],
) -> String {
    let url_trimmed = icon.url.trim();
    if url_trimmed.is_empty() {
        return String::new();
    }
    let inferred_ext = icon.ext;
    let final_filename =
        crate::db::icon_cycle::hash_icon_filename(url_trimmed, real_ext);
    if final_filename.is_empty() {
        return String::new();
    }
    let _ = std::fs::write(icons_dir.join(&final_filename), bytes);

    // 同 hash 不同 ext 残留（inferred-hash 与其他变体）存在即删 + 旧 meta 键同步清。
    let full = crate::sha256_digest_hex(url_trimmed.trim().as_bytes());
    let hash_stem = &full[..16.min(full.len())];
    let initial_filename = format!("{}.{}", hash_stem, inferred_ext);
    if initial_filename != final_filename {
        let p = icons_dir.join(&initial_filename);
        if p.is_file() {
            let _ = std::fs::remove_file(&p);
        }
    }
    for ext in KNOWN_ICON_EXTS {
        let alt = format!("{}.{}", hash_stem, ext);
        if alt != final_filename && alt != initial_filename {
            let p = icons_dir.join(&alt);
            if p.is_file() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    if let Some(db) = db_opt {
        if initial_filename != final_filename {
            let _ = db.delete_icon_cache_url(&initial_filename);
        }
        for ext in KNOWN_ICON_EXTS {
            let alt = format!("{}.{}", hash_stem, ext);
            if alt != final_filename && alt != initial_filename {
                let _ = db.delete_icon_cache_url(&alt);
            }
        }
        let _ = db.save_icon_cache_url(&final_filename, url_trimmed);
    }
    // 配额 LRU（只清文件不删 DB URL，见下；水位与 asset 同源，经 db_opt 读 DB 配额）。
    enforce_icon_quota_lru(db_opt, icons_dir);
    final_filename
}

/// 写侧单一写入路径（hash 单轨，probe-vs-persist 缝收敛点）：
/// `icons/` 落盘 + `icon_cache_meta` 同步二合一，收录/非收录统一为 `hash(url).{real_ext}`。
/// - `real_ext` 经字节嗅探纠正（`detect_image_mime/mime_to_ext`），`icon.ext`（inferred）仅作旧键清理用；
/// - L1–L4 备选 Logo 必落盘（L4 仅 cycle 头部备选 Logo；正文图永不进此）；
/// - 图标通道禁用 ETag：此处永不读写 `api_etag_cache`；
/// - 写后触发配额 LRU（只清文件不删 DB URL，见 `enforce_icon_quota_lru`）。
/// 调用方随后经 `seal_cycle_selection + upsert/set_selected` 固化行（`let _` 吞错）。
/// ADR-0010：key 经 canonical id 派生；level 纯L，via 正交。
pub(crate) fn write_icon_file(
    icons_dir: &std::path::Path,
    db_opt: Option<&crate::db::Database>,
    icon: &IconRef<'_>,
    is_cataloged: bool,
    bytes: &[u8],
) -> String {
    let url_trimmed = icon.url;
    let real_ext = crate::commands::icons::mime_to_ext(crate::commands::icons::detect_image_mime(
        bytes,
    ));
    if is_cataloged {
        persist_catalog_icon(icons_dir, db_opt, icon, real_ext, bytes)
    } else {
        let fname = crate::db::icon_cycle::hash_icon_filename(url_trimmed, real_ext);
        if fname.is_empty() {
            return String::new();
        }
        let _ = std::fs::write(icons_dir.join(&fname), bytes);
        cleanup_stale_cycle_variants(icons_dir, &fname);
        enforce_icon_quota_lru(db_opt, icons_dir);
        fname
    }
}

/// 配额 LRU（图标盘配额唯一落点，FINAL 口径：只清文件不删 DB URL）：
/// - 配额水位与 asset 通道同源（`db::cache::asset_quota_limits`，DB 设置优先，缺省 2000 文件 / 500 MiB，
///   常量只在 `db::cache` 一处定义）；无 DB 时回退共享常量；
/// - 按文件 mtime 最旧优先淘汰，直至文件数/总字节双水位线下；
/// - 永不调用 `delete_icon_cache_url/delete_icon_cycle`（DB URL 保留，文件缺失下次经 URL 重下恢复，
///   避免配额淘汰导致“有 URL 无文件”变“无 URL 无文件”丢失自愈能力）；
/// - 全部 best-effort（`let _` 吞错），失败不阻塞写侧；`icons/` 不存在直接返回。
pub(crate) fn enforce_icon_quota_lru(
    db_opt: Option<&crate::db::Database>,
    icons_dir: &std::path::Path,
) {
    let (max_files, max_bytes) = match db_opt {
        Some(db) => crate::db::cache::asset_quota_limits(db),
        None => (
            crate::db::cache::ASSET_CACHE_MAX_FILES as u64,
            crate::db::cache::ASSET_CACHE_MAX_BYTES,
        ),
    };
    let max_files = max_files as usize;
    let Ok(rd) = std::fs::read_dir(icons_dir) else {
        return;
    };
    let mut entries: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total_bytes: u64 = 0;
    for ent in rd.flatten() {
        let p = ent.path();
        if !p.is_file() {
            continue;
        }
        // 仅管图标后缀（含无后缀文件亦管，避免漏网撑盘）。
        let meta = match std::fs::metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let len = meta.len();
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        total_bytes = total_bytes.saturating_add(len);
        entries.push((p, len, mtime));
    }
    if entries.len() <= max_files && total_bytes <= max_bytes {
        return;
    }
    entries.sort_by(|a, b| a.2.cmp(&b.2));
    let mut files = entries.len();
    let mut bytes = total_bytes;
    for (p, len, _) in entries {
        if files <= max_files && bytes <= max_bytes {
            break;
        }
        // 只删文件，绝不删 DB（icon_cache_meta / app_icon_cycles 原样保留）。
        if std::fs::remove_file(&p).is_ok() {
            files = files.saturating_sub(1);
            bytes = bytes.saturating_sub(len);
        }
    }
}

/// 非收录 cycle 行加载-or-新建唯一落点（get_or_fetch 直取路径用）。
/// `lookup_id` 保持调用方原始 trim 形态（与 `db.get_icon_cycle(clean_id)` 键一致）；
/// 新建行 owner/repo 经 owner_repo_for_new_cycle 推导。
pub(crate) fn load_or_new_cycle(
    db: &crate::db::Database,
    lookup_id: &str,
) -> crate::db::AppIconCycle {
    db.get_icon_cycle(lookup_id)
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            let (owner, repo) = crate::db::icon_cycle::owner_repo_for_new_cycle(lookup_id);
            crate::db::AppIconCycle::new(lookup_id, owner, repo)
        })
}

/// 匿名兜底探测唯一落点（get_or_fetch_icon 直取失败分支）：
/// 无 token，只跑免鉴权级（Simple Icons L2），跳过 Trees 以保护匿名配额；
/// 经 `icon_fetch::probe_anon_simple` 深核单调，命中即下载返回字节。
/// L4 不进匿名兜底（需网络详情链专属）。
pub(crate) async fn fetch_anon_probe_bytes(
    client: &reqwest::Client,
    app_id_label: &str,
    owner: &str,
    repo: &str,
) -> Option<Vec<u8>> {
    let probed_url = crate::github::icon_fetch::probe_anon_simple(client, owner, repo).await?;
    log::debug!(
        "icon probe fallback hit app_id='{}' source=simple-icons url='{}'",
        app_id_label,
        crate::log_support::sanitize_url(&probed_url)
    );
    download_icon_bytes_direct(client, &probed_url).await.ok()
}

/// README 图标探测（L4 详情链专属适配器，不受流式核约束，需网络）。
/// L4=README现场扒：先读本地详情缓存 `readme_markdown`，再远端拉取；
/// 与 L2/L3-live 正交（L2/L3 经深核，L4 经此处）。
async fn probe_readme(
    client: &reqwest::Client,
    state: &AppState,
    token: Option<&str>,
    owner: &str,
    repo: &str,
    app_id: &str,
) -> String {
    // 1. 优先从 SQLite 本地详情缓存读取 readme_markdown
    if let Ok(db) = state.db() {
        if let Ok(Some(detail)) = db.get_cached_app_detail(app_id, None) {
            if !detail.readme_markdown.trim().is_empty() {
                let (logo, _) = crate::github::CatalogService::extract_and_strip_logo_from_readme(
                    &detail.readme_markdown,
                    owner,
                    repo,
                );
                // 纵深：非远端地址视为无，绝不入库、绝不下载，继续走远端分支。
                if let Some(url) = logo {
                    if crate::github::markdown::is_http_url(url.trim()) {
                        return url;
                    }
                }
            }
        }
    }

    // 2. 远端拉取 README
    let readme_url = format!("https://api.github.com/repos/{}/{}/readme", owner, repo);
    let mut req = client
        .get(&readme_url)
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .header("Accept", "application/vnd.github.raw");
    if let Some(tok) = token.filter(|t| !t.trim().is_empty()) {
        req = req.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", tok.trim()),
        );
    }

    if let Ok(Ok(resp)) = tokio::time::timeout(api_timeout_or(std::time::Duration::from_secs(8)), req.send()).await {
        if resp.status().is_success() {
            if let Ok(raw_readme) = resp.text().await {
                let (logo, _) = crate::github::CatalogService::extract_and_strip_logo_from_readme(
                    &raw_readme,
                    owner,
                    repo,
                );
                if let Some(url) = logo {
                    if crate::github::markdown::is_http_url(url.trim()) {
                        return url;
                    }
                }
            }
        }
    }

    String::new()
}

/// 填充补全 1..4 各级可用 URL（详情/cycle 适配器，薄）：
/// - L1=官方：仅收录应用官方源填 `l1_url`（Curated Catalog 例外之 L1 填充）；
///   未收录永不填 L1（UI cycle 非收录 only）。
/// - L2/L3-live：经 `icon_fetch` 深核（`probe_l2_simple`/`probe_l3_trees`，
///   `buffered(3)`+验图+caps），不另写 naive 探；L3 无 token 直接跳过。
/// - L4=README现场扒：经本文件 `probe_readme`（详情链专属，需网络）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn ensure_cycle_levels(
    cycle: &mut crate::db::AppIconCycle,
    state: &AppState,
    owner: &str,
    repo: &str,
    app_id: &str,
    is_cataloged: bool,
    catalog_item: Option<&crate::github::CatalogItem>,
    token: Option<&str>,
) {
    let client = crate::forge::http::new_icon_client(
        crate::config::get_project_config().network.api_timeout_seconds,
    )
    .unwrap_or_default();

    // 图标L1=官方：仅收录应用官方源填图标L1（l1_url）；未收录应用保持为空
    if is_cataloged && cycle.l1_url.trim().is_empty() {
        if let Some(item) = catalog_item {
            let u = item.icon.trim();
            if u.starts_with("http://") || u.starts_with("https://") {
                cycle.l1_url = u.to_string();
            }
        }
    }

    // 图标L2=品牌库：品牌库 Simple Icons（深核）
    let need_l2 = cycle.l2_url.trim().is_empty();
    // 图标L3=仓库：翻全家 Git Trees (有 token 才跑，深核)
    let need_l3 = token.filter(|t| !t.trim().is_empty()).is_some()
        && cycle.l3_url.trim().is_empty();
    // L4=README现场扒
    let need_l4 = cycle.l4_url.trim().is_empty();
    // L3 鉴权头与流式核同源（`token_headers`，Token 方案）。
    let slow_headers = token
        .filter(|t| !t.trim().is_empty())
        .map(|t| crate::github::http::token_headers(Some(t)));

    let (probed_l2, probed_l3, probed_l4) = tokio::join!(
        async {
            if need_l2 {
                crate::github::icon_fetch::probe_l2_simple(&client, owner, repo)
                    .await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        },
        async {
            if need_l3 {
                crate::github::icon_fetch::probe_l3_trees(
                    &client,
                    slow_headers.as_ref(),
                    owner,
                    repo,
                )
                .await
                .unwrap_or_default()
            } else {
                String::new()
            }
        },
        async {
            if need_l4 {
                probe_readme(&client, state, token, owner, repo, app_id).await
            } else {
                String::new()
            }
        }
    );

    if need_l2 && !probed_l2.is_empty() {
        cycle.l2_url = probed_l2;
    }
    if need_l3 && !probed_l3.is_empty() {
        cycle.l3_url = probed_l3;
    }
    if need_l4 && !probed_l4.is_empty() {
        cycle.l4_url = probed_l4;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_source_and_fallback_mapping() {
        assert_eq!(source_for_level(1), "official");
        assert_eq!(source_for_level(2), "simple-icons");
        assert_eq!(source_for_level(3), "trees");
        assert_eq!(source_for_level(4), "readme");
        assert_eq!(source_for_level(5), "none");
        assert_eq!(source_for_level(0), "none");

        assert!(!is_fallback_for_level(1));
        assert!(is_fallback_for_level(2));
        assert!(is_fallback_for_level(3));
        assert!(is_fallback_for_level(4));
        assert!(is_fallback_for_level(5));
    }

    #[test]
    fn test_resolve_app_coord_variants() {
        // 1. 标准 owner/repo
        let (id, o, r) = resolve_app_coord("rustdesk/rustdesk").unwrap();
        assert_eq!(id, "rustdesk/rustdesk");
        assert_eq!(o, "rustdesk");
        assert_eq!(r, "rustdesk");

        // 2. 带大写 owner/repo
        let (id, o, r) = resolve_app_coord("RustDesk/RustDesk").unwrap();
        assert_eq!(id, "rustdesk/rustdesk");
        assert_eq!(o, "RustDesk");
        assert_eq!(r, "RustDesk");

        // 3. GitHub 完整 URL
        let (id, o, r) = resolve_app_coord("https://github.com/agalwood/Motrix").unwrap();
        assert_eq!(id, "agalwood/motrix");
        assert_eq!(o, "agalwood");
        assert_eq!(r, "Motrix");

        // 4. 前缀短语法
        let (id, o, r) = resolve_app_coord("gh:vlang/v").unwrap();
        assert_eq!(id, "vlang/v");
        assert_eq!(o, "vlang");
        assert_eq!(r, "v");

        // 5. 非法输入
        assert!(resolve_app_coord("").is_err());
        assert!(resolve_app_coord("   ").is_err());
        assert!(resolve_app_coord("justaname").is_err());
    }

    #[test]
    fn test_next_cycle_level_progression_and_wrap() {
        let mut cycle = crate::db::AppIconCycle {
            app_id: "test/test".to_string(),
            owner: "test".to_string(),
            repo: "test".to_string(),
            is_cataloged: true,
            level: 1,
            l1_url: "https://example.com/1.png".to_string(),
            l2_url: "https://example.com/2.png".to_string(),
            l3_url: "https://example.com/3.png".to_string(),
            l4_url: "https://example.com/4.png".to_string(),
            selected_url: "https://example.com/1.png".to_string(),
            cache_file: "test.png".to_string(),
            updated_at: 0,
        };

        // 全满时：1 -> 2 -> 3 -> 4 -> 5 -> 1
        assert_eq!(next_cycle_level(1, &cycle), 2);
        assert_eq!(next_cycle_level(2, &cycle), 3);
        assert_eq!(next_cycle_level(3, &cycle), 4);
        assert_eq!(next_cycle_level(4, &cycle), 5);
        assert_eq!(next_cycle_level(5, &cycle), 1);

        // 存在空档时顺延：2 和 3 为空
        cycle.l2_url = "".to_string();
        cycle.l3_url = "".to_string();
        assert_eq!(next_cycle_level(1, &cycle), 4);
        assert_eq!(next_cycle_level(4, &cycle), 5);
        assert_eq!(next_cycle_level(5, &cycle), 1);

        // 仅图标L1=官方有效：1 -> 5 -> 1
        cycle.l4_url = "".to_string();
        assert_eq!(next_cycle_level(1, &cycle), 5);
        assert_eq!(next_cycle_level(5, &cycle), 1);

        // 1..4 全部为空：始终顺延到 5
        cycle.l1_url = "".to_string();
        assert_eq!(next_cycle_level(1, &cycle), 5);
        assert_eq!(next_cycle_level(5, &cycle), 5);

        // 非收录应用：1 档永远跳过，5 回绕到 2
        let non_cat = crate::db::AppIconCycle {
            app_id: "noncat/test".to_string(),
            owner: "noncat".to_string(),
            repo: "test".to_string(),
            is_cataloged: false,
            level: 2,
            l1_url: "".to_string(),
            l2_url: "https://example.com/2.png".to_string(),
            l3_url: "https://example.com/3.png".to_string(),
            l4_url: "https://example.com/4.png".to_string(),
            selected_url: "https://example.com/2.png".to_string(),
            cache_file: "test_l2.png".to_string(),
            updated_at: 0,
        };
        assert_eq!(next_cycle_level(2, &non_cat), 3);
        assert_eq!(next_cycle_level(3, &non_cat), 4);
        assert_eq!(next_cycle_level(4, &non_cat), 5);
        assert_eq!(next_cycle_level(5, &non_cat), 2);

        // 验证 first_available_level
        assert_eq!(first_available_level(&non_cat), Some(2));
        assert_eq!(first_available_level(&cycle), None);
    }

    #[test]
    fn test_two_table_split_db_behavior() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let cat_app = "rustdesk/rustdesk";
        let non_cat_app = "custom/unknown";

        // 1. 收录应用：写 icon_cache_meta 与 app_icon_cycles
        let cat_cycle = crate::db::AppIconCycle {
            app_id: cat_app.to_string(),
            owner: "rustdesk".to_string(),
            repo: "rustdesk".to_string(),
            is_cataloged: true,
            level: 1,
            l1_url: "https://example.com/l1.png".to_string(),
            selected_url: "https://example.com/l1.png".to_string(),
            cache_file: "rustdesk_rustdesk.png".to_string(),
            updated_at: 1000,
            ..Default::default()
        };
        db.upsert_icon_cycle(&cat_cycle).unwrap();
        db.save_icon_cache_url("rustdesk_rustdesk.png", "https://example.com/l1.png").unwrap();

        // 校验：收录应用在两表中均可查到
        assert_eq!(
            db.get_icon_cache_url("rustdesk_rustdesk.png").unwrap(),
            Some("https://example.com/l1.png".to_string())
        );
        let cat_res = db.get_icon_cycle(cat_app).unwrap().unwrap();
        assert!(cat_res.is_cataloged);
        assert_eq!(cat_res.cache_file, "rustdesk_rustdesk.png");

        // 2. 非收录应用：只走 app_icon_cycles，且文件名带 _l{level} 后缀
        let non_cat_cycle = crate::db::AppIconCycle {
            app_id: non_cat_app.to_string(),
            owner: "custom".to_string(),
            repo: "unknown".to_string(),
            is_cataloged: false,
            level: 2,
            l2_url: "https://cdn.simpleicons.org/custom".to_string(),
            selected_url: "https://cdn.simpleicons.org/custom".to_string(),
            cache_file: "custom_unknown_l2.png".to_string(),
            updated_at: 2000,
            ..Default::default()
        };
        db.upsert_icon_cycle(&non_cat_cycle).unwrap();

        // 校验：非收录应用绝不写入 icon_cache_meta
        assert_eq!(
            db.get_icon_cache_url("custom_unknown_l2.png").unwrap(),
            None
        );
        // 但在 app_icon_cycles 中完整保留
        let non_cat_res = db.get_icon_cycle(non_cat_app).unwrap().unwrap();
        assert!(!non_cat_res.is_cataloged);
        assert_eq!(non_cat_res.level, 2);
        assert_eq!(non_cat_res.cache_file, "custom_unknown_l2.png");
    }

    #[test]
    fn test_hash_candidate_helper_single_source() {
        // hash 候选唯一构造，`read_level_cache_file` 与 `load_split_cached_bytes` 共用。
        let empty = IconRef::new("", "png");
        assert!(hash_icon_candidate_filenames(&empty).is_empty());
        let blank = IconRef::new("   ", "png");
        assert!(hash_icon_candidate_filenames(&blank).is_empty());
        let a_png = IconRef::new("https://example.com/a.png", "png");
        let c = hash_icon_candidate_filenames(&a_png);
        // inferred ∈ KNOWN 时总数即 KNOWN 全集（首位 inferred + 其余兜底，无重复）。
        assert_eq!(c.len(), KNOWN_ICON_EXTS.len());
        assert!(c[0].ends_with(".png"));
        // inferred 首位 + 全后缀兜底无重复。
        let mut seen = std::collections::HashSet::new();
        for f in &c {
            assert!(seen.insert(f.clone()), "duplicate candidate {f}");
        }
        let a_svg = IconRef::new("https://example.com/a.png", "svg");
        let c2 = hash_icon_candidate_filenames(&a_svg);
        assert!(c2[0].ends_with(".svg"));
        // 同 url 同 inferred 稳定（读/写一致）。
        let a_png_padded = IconRef::new("  https://example.com/a.png  ", "png");
        assert_eq!(c, hash_icon_candidate_filenames(&a_png_padded));
    }
}
