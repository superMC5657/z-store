//! 统一图标深模块：探测（SimpleIcons / Git Trees / README）、图片嗅探、
//! 轮换状态机（`AppIconCycle`）与本地磁盘缓存/LRU 持久化。

mod confirmed;
mod cycle;
mod fetch;
mod image_sniff;
mod lanes;
mod probe;
mod quota_throttle;
mod singleflight;

#[cfg(test)]
mod tests;

pub(crate) use confirmed::{
    apply_icon_cache_heals, plan_pending_icons, resolve_and_patch_icons, resolve_icons_offloaded,
    ConfirmedIconPlan, DeferredIcon, IconCoord, IconCycleIndex, IconPlanBatch, PendingIcon,
    ResolvedIcons,
};
#[cfg(test)]
pub(crate) use confirmed::{materialize_icons_inline, patch_core_icons};
pub use cycle::{
    adopt_probe_cache_file, apply_detail_icon_resolution, fill_probe_slot, first_available_level,
    hash_icon_filename, is_cycle_restore_fresh, is_fallback_for_level, is_icon_fresh,
    merge_detail_icon, next_cycle_level, owner_repo_for_new_cycle, pick_detail_icon_with_level,
    resolve_icon_coord, seal_cycle_selection, seal_empty_selection, source_for_level,
    DetailIconResolution, ProbeIconLevel, ICON_TTL_SECS,
};
pub use fetch::{
    emit_icon_ready, fetch_icons_stream, icon_key, icon_ready_payload, IconFetchCtx, IconFetchJob,
    IconReadyPayload, RepoCoord,
};
pub(crate) use fetch::{
    is_body_image_url, level_for_detail_icon, probe_anon_simple, probe_l2_simple, probe_l3_trees,
    probe_single_live,
};
pub use image_sniff::{
    detect_image_mime, infer_ext_from_url, is_valid_image, mime_to_ext, resolve_ext,
    sniff_image_mime, url_ext_allowed, url_path_ext,
};
#[cfg(test)]
pub(crate) use lanes::record_stream_hit_with;
pub(crate) use lanes::{
    spawn_icon_fetch_lane, spawn_launchpad_icon_stream, spawn_starred_icon_stream,
};
pub use lanes::{IconEventSink, IconLane};
pub(crate) use probe::{
    probe_repo_logo, remember_repo_default_branch, verify_custom_icon_d8, ProbedIcon,
};
pub(crate) use quota_throttle::QuotaThrottle;
pub(crate) use singleflight::Flights;

use crate::AppState;
use serde::{Deserialize, Serialize};

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 落盘扩展名全集（读侧兜底 + 写侧残留清理用）。
pub(crate) const KNOWN_ICON_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "apng", "bmp",
];

/// 图标轮换返回结构。
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

/// 图标 persist/read 坐标束：`url` 为备选 Logo 真地址，`ext` 为 URL 后缀暂定。
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

/// 标准 Base64（带 `=` 填充）：按 3 字节一组直接写入预分配字节缓冲。
pub(crate) fn base64_encode(data: &[u8]) -> String {
    let sextet = |n: u32, shift: u32| BASE64_ALPHABET[((n >> shift) & 0x3f) as usize];
    let mut out: Vec<u8> = Vec::with_capacity(data.len().div_ceil(3) * 4);
    let (triples, remainder) = data.as_chunks::<3>();
    for c in triples {
        let n = (u32::from(c[0]) << 16) | (u32::from(c[1]) << 8) | u32::from(c[2]);
        out.extend_from_slice(&[sextet(n, 18), sextet(n, 12), sextet(n, 6), sextet(n, 0)]);
    }
    match *remainder {
        [a] => {
            let n = u32::from(a) << 16;
            out.extend_from_slice(&[sextet(n, 18), sextet(n, 12), b'=', b'=']);
        }
        [a, b] => {
            let n = (u32::from(a) << 16) | (u32::from(b) << 8);
            out.extend_from_slice(&[sextet(n, 18), sextet(n, 12), sextet(n, 6), b'=']);
        }
        _ => {}
    }
    // 全部字节来自 ASCII 字母表与 `=`，校验必然通过。
    String::from_utf8(out).unwrap_or_default()
}

pub(crate) fn bytes_to_data_uri(bytes: &[u8]) -> String {
    let mime = detect_image_mime(bytes);
    let b64 = base64_encode(bytes);
    format!("data:{};base64,{}", mime, b64)
}

/// 图标文件 7 天新鲜度（mtime 口径；图标通道禁用 ETag 查表）。
pub(crate) fn is_icon_file_fresh(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    let Ok(elapsed) = std::time::SystemTime::now().duration_since(mtime) else {
        return false;
    };
    elapsed.as_secs() < (ICON_TTL_SECS as u64)
}

/// 有效图片文件读取唯一落点：存在 + 可读 + 非空 + 合法图片才返回字节。
pub(crate) fn read_valid_image_file(path: &std::path::Path) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    std::fs::read(path)
        .ok()
        .filter(|b| !b.is_empty() && is_valid_image(b))
}

async fn read_valid_image_file_async(path: std::path::PathBuf) -> Option<Vec<u8>> {
    tokio::task::spawn_blocking(move || read_valid_image_file(&path))
        .await
        .ok()
        .flatten()
}

/// hash 候选文件名唯一构造：`sha256(url)[0:16].{inferred_ext}` + `KNOWN_ICON_EXTS` 全后缀兜底。
pub(crate) fn hash_icon_candidate_filenames(icon: &IconRef<'_>) -> Vec<String> {
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

/// 按图标 URL 扫描 `icons/` 下的哈希候选文件，命中有效图片即返回 `(bytes, filename)`。
pub(crate) fn find_cached_icon_by_url(
    icons_dir: &std::path::Path,
    url: &str,
) -> Option<(Vec<u8>, String)> {
    let url_trimmed = url.trim();
    if url_trimmed.is_empty() {
        return None;
    }
    let ext = infer_ext_from_url(url_trimmed).unwrap_or("png");
    let icon_ref = IconRef::new(url_trimmed, ext);
    for fname in hash_icon_candidate_filenames(&icon_ref) {
        if let Some(bytes) = read_valid_image_file(&icons_dir.join(&fname)) {
            return Some((bytes, fname));
        }
    }
    None
}

/// 读取磁盘上已存在的有效图标字节（不限 7 天新鲜度，供网络波动/离线 SWR 兜底与自愈使用）。
fn read_any_cached_icon_file(
    icons_dir: &std::path::Path,
    icon: &IconRef<'_>,
    noncatalog_cycle: Option<&crate::db::AppIconCycle>,
) -> Option<(Vec<u8>, String, bool)> {
    let url_trimmed = icon.url.trim();
    if url_trimmed.is_empty() {
        return None;
    }
    if let Some(cycle) = noncatalog_cycle {
        let cf = cycle.cache_file.trim();
        if !cf.is_empty() && cycle.selected_url.trim() == url_trimmed {
            let p = icons_dir.join(cf);
            if let Some(b) = read_valid_image_file(&p) {
                let fresh = is_icon_file_fresh(&p);
                return Some((b, cf.to_string(), fresh));
            }
        }
    }
    if let Some((b, fname)) = find_cached_icon_by_url(icons_dir, url_trimmed) {
        let fresh = is_icon_file_fresh(&icons_dir.join(&fname));
        return Some((b, fname, fresh));
    }
    None
}

fn read_level_cache_file(icons_dir: &std::path::Path, icon: &IconRef<'_>) -> Option<Vec<u8>> {
    for fname in hash_icon_candidate_filenames(icon) {
        let p = icons_dir.join(&fname);
        if is_icon_file_fresh(&p) {
            if let Some(b) = read_valid_image_file(&p) {
                return Some(b);
            }
        }
    }
    None
}

/// 两表分流缓存读取唯一落点（hash 双探 + 7 天 TTL + ETag 禁用）。
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
        for filename in hash_icon_candidate_filenames(icon) {
            let cache_file = icons_dir.join(&filename);
            if !is_icon_file_fresh(&cache_file) {
                continue;
            }
            match db.get_icon_cache_record(&filename) {
                Ok(Some((recorded_url, at))) => {
                    if recorded_url.trim() == url_trimmed && is_icon_fresh(at, now) {
                        if let Some(b) = read_valid_image_file(&cache_file) {
                            return Some(b);
                        }
                    }
                }
                Ok(None) => {
                    if let Some(b) = read_valid_image_file(&cache_file) {
                        let _ = db.save_icon_cache_url(&filename, url_trimmed);
                        return Some(b);
                    }
                }
                Err(_) => {}
            }
        }
        None
    } else {
        if let Some(cycle) = noncatalog_cycle {
            if !cycle.cache_file.is_empty()
                && cycle.selected_url.trim() == url_trimmed
                && is_icon_fresh(cycle.updated_at, now)
            {
                let p = icons_dir.join(&cycle.cache_file);
                if is_icon_file_fresh(&p) {
                    if let Some(b) = read_valid_image_file(&p) {
                        return Some(b);
                    }
                }
            }
        }
        for filename in hash_icon_candidate_filenames(icon) {
            let cache_file = icons_dir.join(&filename);
            if !is_icon_file_fresh(&cache_file) {
                continue;
            }
            if let Some(b) = read_valid_image_file(&cache_file) {
                if let Some(cycle) = noncatalog_cycle {
                    if cycle.selected_url.trim() == url_trimmed
                        && cycle.cache_file.trim() != filename
                    {
                        let _ = db.set_icon_cycle_selected(
                            &cycle.app_id,
                            cycle.level,
                            url_trimmed,
                            &filename,
                        );
                    }
                }
                return Some(b);
            }
        }
        None
    }
}

fn cleanup_stale_cycle_variants(icons_dir: &std::path::Path, keep_filename: &str) {
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

/// 图标落盘后待同步到 `icon_cache_meta` 的变更（仅收录图标产生）。
#[derive(Debug, Default)]
pub(crate) struct IconMetaSync {
    /// 同 hash 其它后缀的旧键：删除。
    stale_keys: Vec<String>,
    /// `(最终文件名, 远端地址)`：写入。
    save: Option<(String, String)>,
}

/// 图标落盘阶段产物：最终文件名 + 待同步元数据。
#[derive(Debug)]
pub(crate) struct IconWrite {
    pub(crate) filename: String,
    meta: IconMetaSync,
}

/// 收录图标落盘：先写最终文件，写入成功后才清理同 hash 其它后缀的旧文件。
fn persist_catalog_icon_file(
    icons_dir: &std::path::Path,
    icon: &IconRef<'_>,
    real_ext: &str,
    bytes: &[u8],
) -> Option<IconWrite> {
    let url_trimmed = icon.url.trim();
    if url_trimmed.is_empty() {
        return None;
    }
    let final_filename = hash_icon_filename(url_trimmed, real_ext);
    if final_filename.is_empty() {
        return None;
    }
    std::fs::write(icons_dir.join(&final_filename), bytes).ok()?;

    let full = crate::sha256_digest_hex(url_trimmed.as_bytes());
    let hash_stem = &full[..16.min(full.len())];
    let initial_filename = format!("{}.{}", hash_stem, icon.ext);
    let mut stale_keys = Vec::new();
    if initial_filename != final_filename {
        let p = icons_dir.join(&initial_filename);
        if p.is_file() {
            let _ = std::fs::remove_file(&p);
        }
        stale_keys.push(initial_filename.clone());
    }
    for ext in KNOWN_ICON_EXTS {
        let alt = format!("{}.{}", hash_stem, ext);
        if alt != final_filename && alt != initial_filename {
            let p = icons_dir.join(&alt);
            if p.is_file() {
                let _ = std::fs::remove_file(&p);
            }
            stale_keys.push(alt);
        }
    }
    Some(IconWrite {
        filename: final_filename.clone(),
        meta: IconMetaSync {
            stale_keys,
            save: Some((final_filename, url_trimmed.to_string())),
        },
    })
}

/// 落盘阶段（不触 DB）：写图标文件并清理旧变体。
/// 写入失败返回 `None`，旧文件保持不动。
pub(crate) fn write_icon_files(
    icons_dir: &std::path::Path,
    icon: &IconRef<'_>,
    is_cataloged: bool,
    bytes: &[u8],
) -> Option<IconWrite> {
    let real_ext = mime_to_ext(detect_image_mime(bytes));
    if is_cataloged {
        return persist_catalog_icon_file(icons_dir, icon, real_ext, bytes);
    }
    let fname = hash_icon_filename(icon.url, real_ext);
    if fname.is_empty() {
        return None;
    }
    std::fs::write(icons_dir.join(&fname), bytes).ok()?;
    cleanup_stale_cycle_variants(icons_dir, &fname);
    Some(IconWrite {
        filename: fname,
        meta: IconMetaSync::default(),
    })
}

/// 元数据阶段（调用方短锁内）：把落盘结果同步到 `icon_cache_meta`。
pub(crate) fn apply_icon_write_meta(db: &crate::db::Database, write: &IconWrite) {
    for key in &write.meta.stale_keys {
        let _ = db.delete_icon_cache_url(key);
    }
    if let Some((key, url)) = &write.meta.save {
        let _ = db.save_icon_cache_url(key, url);
    }
}

/// 写侧单一写入路径：`icons/` 落盘 + `icon_cache_meta` 同步 + 节流配额 LRU。
/// 写入失败返回空串：不删除旧文件，也不写入指向不存在文件的元数据。
pub(crate) fn write_icon_file(
    icons_dir: &std::path::Path,
    db_opt: Option<&crate::db::Database>,
    icon: &IconRef<'_>,
    is_cataloged: bool,
    bytes: &[u8],
) -> String {
    let Some(write) = write_icon_files(icons_dir, icon, is_cataloged, bytes) else {
        return String::new();
    };
    if let Some(db) = db_opt {
        apply_icon_write_meta(db, &write);
    }
    note_icon_write(db_opt, icons_dir, bytes.len());
    write.filename
}

/// 运行期图标配额节流：每 25 次写入或距上次淘汰超过 5 分钟放行一次全目录扫描
/// （启动期另有一次全量淘汰，见 `lib.rs`）。
static ICON_QUOTA_THROTTLE: QuotaThrottle =
    QuotaThrottle::new(25, u64::MAX, Some(std::time::Duration::from_secs(300)));

/// 记一次图标写入。节流放行时只在当前上下文读取配额上限，目录扫描与删除交由阻塞
/// 线程池执行，不占用调用方可能持有的 DB 锁（无 Tokio 运行时则就地执行）。
fn note_icon_write(
    db_opt: Option<&crate::db::Database>,
    icons_dir: &std::path::Path,
    written: usize,
) {
    if !ICON_QUOTA_THROTTLE.record(written as u64) {
        return;
    }
    let limits = icon_quota_limits(db_opt);
    let dir = icons_dir.to_path_buf();
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn_blocking(move || prune_icon_dir(&dir, limits));
        }
        Err(_) => prune_icon_dir(&dir, limits),
    }
}

/// 图标配额上限 `(max_files, max_bytes)`：DB 设置优先，无 DB 回退基线常量。
fn icon_quota_limits(db_opt: Option<&crate::db::Database>) -> (u64, u64) {
    match db_opt {
        Some(db) => crate::db::cache::asset_quota_limits(db),
        None => (
            crate::db::cache::ASSET_CACHE_MAX_FILES as u64,
            crate::db::cache::ASSET_CACHE_MAX_BYTES,
        ),
    }
}

/// 配额 LRU 全量淘汰（只清文件不删 DB URL，保持缺失后重下自愈能力）。
pub(crate) fn enforce_icon_quota_lru(
    db_opt: Option<&crate::db::Database>,
    icons_dir: &std::path::Path,
) {
    prune_icon_dir(icons_dir, icon_quota_limits(db_opt));
}

/// 扫描 `icons/` 并按 mtime 最旧优先删除，直至文件数与总字节均落回上限内。
fn prune_icon_dir(icons_dir: &std::path::Path, (max_files, max_bytes): (u64, u64)) {
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
        let Ok(meta) = std::fs::metadata(&p) else {
            continue;
        };
        let len = meta.len();
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        total_bytes = total_bytes.saturating_add(len);
        entries.push((p, len, mtime));
    }
    if entries.len() <= max_files && total_bytes <= max_bytes {
        return;
    }
    entries.sort_by_key(|e| e.2);
    let mut files = entries.len();
    let mut bytes = total_bytes;
    for (p, len, _) in entries {
        if files <= max_files && bytes <= max_bytes {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            files = files.saturating_sub(1);
            bytes = bytes.saturating_sub(len);
        }
    }
}

/// 非收录 cycle 行加载或新建唯一落点（按 `canonical_lookup_id` 归一主键）。
pub(crate) fn load_or_new_cycle(
    db: &crate::db::Database,
    lookup_id: &str,
) -> crate::db::AppIconCycle {
    let canon_id = crate::forge::canonical_lookup_id(lookup_id);
    let eff_id = if canon_id.is_empty() {
        lookup_id.trim()
    } else {
        canon_id.as_str()
    };
    db.get_icon_cycle(eff_id).ok().flatten().unwrap_or_else(|| {
        let (owner, repo) = owner_repo_for_new_cycle(lookup_id);
        crate::db::AppIconCycle::new(eff_id, owner, repo)
    })
}

/// DB 落盘确认图标解析（零网络 M2 dataURI 直显；L1..L3 缺盘回退远端，L4 缺盘返回 `None`）。
pub(crate) fn resolve_confirmed_icon_from_db(
    db: &crate::db::Database,
    app_id: &str,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let repo_ref = crate::forge::coord::RepoRef::new(owner, repo);
    let cycle = crate::forge::coord::lookup_case_insensitive(db, app_id, &repo_ref)?;
    let plan = ConfirmedIconPlan::from_cycle(&cycle)?;
    let icons_dir = crate::get_app_data_dir().join("icons");
    // 自愈查找：cache_file 为空或失效但磁盘已有 selected_url 哈希有效图时自动补齐并直出 M2 dataURI。
    let (icon, heal) = confirmed::materialize_confirmed_icon(&icons_dir, &plan);
    if let Some(h) = heal {
        apply_icon_cache_heals(db, std::slice::from_ref(&h));
    }
    icon
}

/// 远端图标响应体上限：5 MiB（有界流式读取，超限中断）。
const MAX_ICON_BYTES: usize = 5 * 1024 * 1024;

/// 图标字节拉取与魔数校验唯一落点（token-less 隔离客户端）。
pub(crate) async fn download_icon_bytes(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    let url_trimmed = url.trim();
    if url_trimmed.is_empty() {
        return Err("图标链接不能为空".into());
    }

    let last_err = match client
        .get(url_trimmed)
        .headers(crate::forge::http::icon_headers())
        .send()
        .await
    {
        Ok(resp) => {
            if resp.status().is_success() {
                let ctype = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let ctype_log = if ctype.trim().is_empty() {
                    "-".to_string()
                } else {
                    ctype.trim().to_string()
                };
                match crate::forge::http::read_body_capped(resp, MAX_ICON_BYTES).await {
                    Ok(bytes) if !bytes.is_empty() && is_valid_image(&bytes) => {
                        return Ok(bytes);
                    }
                    Ok(bytes) if bytes.is_empty() => {
                        format!("响应内容为空(content-type={})", ctype_log)
                    }
                    Ok(_) => format!("响应内容不是有效图片格式(content-type={})", ctype_log),
                    Err(crate::forge::http::BodyReadError::TooLarge) => {
                        format!("响应内容超过 5 MiB 上限(content-type={})", ctype_log)
                    }
                    Err(crate::forge::http::BodyReadError::Transport(_)) => {
                        "读取响应内容失败".to_string()
                    }
                }
            } else {
                format!("HTTP 状态码: {}", resp.status())
            }
        }
        Err(e) => format!("请求失败: {}", e),
    };

    Err(format!("拉取远程图标失败 ({}): {}", url_trimmed, last_err))
}

fn new_configured_icon_client() -> reqwest::Client {
    crate::forge::http::new_icon_client(
        crate::config::get_project_config()
            .network
            .api_timeout_seconds,
    )
    .unwrap_or_default()
}

fn new_configured_api_client() -> reqwest::Client {
    crate::forge::http::new_api_client(
        crate::config::get_project_config()
            .network
            .api_timeout_seconds,
    )
    .unwrap_or_default()
}

fn ensure_icons_dir() -> std::path::PathBuf {
    let icons_dir = crate::get_app_data_dir().join("icons");
    if !icons_dir.exists() {
        let _ = std::fs::create_dir_all(&icons_dir);
    }
    icons_dir
}

/// 后台图标缓存单飞表：同一远端地址并发只下载、落盘一次，结果为落盘文件名。
static ICON_CACHE_FLIGHTS: std::sync::LazyLock<Flights<Option<String>>> =
    std::sync::LazyLock::new(Flights::new);

/// 单飞下载并落盘 `url`：同地址并发调用共享一次下载；文件写入在阻塞线程池执行，
/// DB 锁只覆盖 `icon_cache_meta` 同步。返回落盘文件名（失败为 `None`）。
async fn cache_icon_url_shared(
    db_arc: &std::sync::Mutex<crate::db::Database>,
    client: &reqwest::Client,
    icons_dir: &std::path::Path,
    url: &str,
    is_cataloged: bool,
) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let flight = ICON_CACHE_FLIGHTS.join(format!("{}|{}", icons_dir.display(), url));
    flight
        .cell()
        .get_or_init(|| async {
            let bytes = download_icon_bytes(client, url).await.ok()?;
            let written = bytes.len();
            let dir = icons_dir.to_path_buf();
            let owned_url = url.to_string();
            let ext = infer_ext_from_url(url).unwrap_or("png");
            let write = tokio::task::spawn_blocking(move || {
                write_icon_files(&dir, &IconRef::new(&owned_url, ext), is_cataloged, &bytes)
            })
            .await
            .ok()
            .flatten()?;
            let db = db_arc.lock().ok()?;
            apply_icon_write_meta(&db, &write);
            note_icon_write(Some(&db), icons_dir, written);
            Some(write.filename)
        })
        .await
        .clone()
}

/// 后台异步拉取选中图标并补齐磁盘 `icons/` 与 `cache_file`（详情落盘后自愈用）。
/// 同一 `selected_url` 的并发请求只下载一次，各自回写自身 cycle 的 `cache_file`。
pub(crate) fn spawn_cache_selected_icon(
    db_arc: std::sync::Arc<std::sync::Mutex<crate::db::Database>>,
    app_id: String,
    level: i32,
    selected_url: String,
    is_cataloged: bool,
) {
    tokio::spawn(async move {
        let client = new_configured_icon_client();
        let icons_dir = ensure_icons_dir();
        let Some(fname) =
            cache_icon_url_shared(&db_arc, &client, &icons_dir, &selected_url, is_cataloged).await
        else {
            return;
        };
        if let Ok(db) = db_arc.lock() {
            let _ = db.set_icon_cycle_selected(&app_id, level, &selected_url, &fname);
        }
    });
}

fn cycle_result(
    level: i32,
    url: String,
    remote_url: String,
    is_cataloged: bool,
) -> IconCycleResult {
    IconCycleResult {
        url,
        remote_url,
        level,
        source: source_for_level(level).to_string(),
        is_fallback: is_fallback_for_level(level),
        total_levels: 5,
        is_cataloged,
    }
}

fn empty_cycle_result(is_cataloged: bool) -> IconCycleResult {
    cycle_result(5, String::new(), String::new(), is_cataloged)
}

async fn fetch_anon_probe_bytes(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Option<(String, Vec<u8>)> {
    let probed_url = probe_anon_simple(client, owner, repo).await?;
    let bytes = download_icon_bytes(client, &probed_url).await.ok()?;
    Some((probed_url, bytes))
}

async fn probe_readme(
    api_client: &reqwest::Client,
    state: &AppState,
    token: Option<&str>,
    owner: &str,
    repo: &str,
    app_id: &str,
) -> String {
    if let Ok(db) = state.db() {
        if let Ok(Some(detail)) = db.get_app_detail(app_id, None) {
            if !detail.readme_markdown.trim().is_empty() {
                let (logo, _) = crate::github::CatalogService::extract_and_strip_logo_from_readme(
                    &detail.readme_markdown,
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

    let readme_url = crate::github::github_readme_endpoint(owner, repo);
    let mut headers = crate::forge::http::preset_headers(
        crate::forge::http::ApiPreset::GithubApi,
        token,
        crate::forge::http::AuthScheme::Bearer,
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github.raw"),
    );
    let req = api_client.get(&readme_url).headers(headers);

    if let Ok(Ok(resp)) = tokio::time::timeout(
        crate::config::api_timeout_or(std::time::Duration::from_secs(8)),
        req.send(),
    )
    .await
    {
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

#[allow(clippy::too_many_arguments)]
async fn ensure_cycle_levels(
    cycle: &mut crate::db::AppIconCycle,
    state: &AppState,
    owner: &str,
    repo: &str,
    app_id: &str,
    is_cataloged: bool,
    catalog_item: Option<&crate::github::CatalogItem>,
    token: Option<&str>,
) {
    let icon_client = new_configured_icon_client();
    let api_client = new_configured_api_client();

    if is_cataloged && cycle.l1_url.trim().is_empty() {
        if let Some(item) = catalog_item {
            let u = item.icon.trim();
            if u.starts_with("http://") || u.starts_with("https://") {
                cycle.l1_url = u.to_string();
            }
        }
    }

    let need_l2 = cycle.l2_url.trim().is_empty();
    let need_l3 =
        token.filter(|t| !t.trim().is_empty()).is_some() && cycle.l3_url.trim().is_empty();
    let need_l4 = cycle.l4_url.trim().is_empty();
    let slow_headers = token.filter(|t| !t.trim().is_empty()).map(|t| {
        crate::forge::http::preset_headers(
            crate::forge::http::ApiPreset::GithubApi,
            Some(t),
            crate::forge::http::AuthScheme::Token,
        )
    });

    let (probed_l2, probed_l3, probed_l4) = tokio::join!(
        async {
            if need_l2 {
                probe_l2_simple(&icon_client, owner, repo)
                    .await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        },
        async {
            if need_l3 {
                probe_l3_trees(&api_client, slow_headers.as_ref(), owner, repo)
                    .await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        },
        async {
            if need_l4 {
                probe_readme(&api_client, state, token, owner, repo, app_id).await
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

/// 获取并缓存远程图标为 M2 `data:` URI（7 天 TTL + SWR 兜底 + 匿名 SimpleIcons 兜底探测）。
pub async fn get_or_fetch_icon(
    state: &AppState,
    app_id: Option<String>,
    remote_url: String,
) -> crate::AppResult<String> {
    let url_trimmed = remote_url.trim();
    if url_trimmed.is_empty() {
        return Err("图标链接不能为空".into());
    }
    if url_trimmed
        .get(..5)
        .is_some_and(|p| p.eq_ignore_ascii_case("data:"))
    {
        // 仅图片 data URI 直通，其余 `data:` 一律拒绝。
        if url_trimmed
            .get(..11)
            .is_some_and(|p| p.eq_ignore_ascii_case("data:image/"))
        {
            return Ok(url_trimmed.to_string());
        }
        return Err("图标 data URI 不是图片".into());
    }

    let icons_dir = ensure_icons_dir();
    let requested_ext = infer_ext_from_url(url_trimmed).unwrap_or("png");
    let raw_app_id = app_id.as_deref().map(str::trim).unwrap_or("");
    let canonical_id = crate::forge::canonical_lookup_id(raw_app_id);
    let is_cataloged = !canonical_id.is_empty() && state.catalog.is_cataloged(&canonical_id);

    let mut noncatalog_cycle_cached: Option<crate::db::AppIconCycle> = None;
    if let Ok(db) = state.db() {
        let noncatalog_cycle = if is_cataloged || canonical_id.is_empty() {
            None
        } else {
            db.get_icon_cycle(&canonical_id).ok().flatten()
        };
        if let Some(bytes) = load_split_cached_bytes(
            &icons_dir,
            &db,
            &IconRef::new(url_trimmed, requested_ext),
            is_cataloged,
            noncatalog_cycle.as_ref(),
        ) {
            return Ok(bytes_to_data_uri(&bytes));
        }
        noncatalog_cycle_cached = noncatalog_cycle;
    }

    let client = new_configured_icon_client();
    let fetched_bytes = download_icon_bytes(&client, url_trimmed).await.ok();

    let (key_url_owned, bytes): (String, Vec<u8>) = match fetched_bytes {
        Some(b) => (url_trimmed.to_string(), b),
        None => {
            if let Some((stale_bytes, _, _)) = read_any_cached_icon_file(
                &icons_dir,
                &IconRef::new(url_trimmed, requested_ext),
                noncatalog_cycle_cached.as_ref(),
            ) {
                return Ok(bytes_to_data_uri(&stale_bytes));
            }
            let raw_id = app_id.as_deref().unwrap_or("");
            let mut probed: Option<(String, Vec<u8>)> = None;
            if let Some(c) = crate::forge::RepositoryUrlParser::parse(raw_id) {
                if !c.owner.is_empty() && !c.repo.is_empty() {
                    probed = fetch_anon_probe_bytes(&client, &c.owner, &c.repo).await;
                }
            }
            match probed {
                Some((true_url, b)) => (true_url, b),
                None => {
                    return Err(format!("拉取远程图标失败 ({})", url_trimmed).into());
                }
            }
        }
    };
    let key_url = key_url_owned.trim();
    let inferred_ext = infer_ext_from_url(key_url).unwrap_or("png");
    let db_opt = state.db().ok();

    if is_cataloged {
        write_icon_file(
            &icons_dir,
            db_opt.as_deref(),
            &IconRef::new(url_trimmed, requested_ext),
            true,
            &bytes,
        );
    } else if !canonical_id.is_empty() {
        if let Some(ref db) = db_opt {
            let mut cycle = load_or_new_cycle(db, raw_app_id);
            cycle.is_cataloged = false;
            let source_level = cycle
                .level_for_known_url(key_url)
                .unwrap_or_else(|| level_for_detail_icon(key_url));
            merge_detail_icon(&mut cycle, source_level, key_url, false, crate::now_secs());
            let filename = write_icon_file(
                &icons_dir,
                db_opt.as_deref(),
                &IconRef::new(key_url, inferred_ext),
                false,
                &bytes,
            );
            adopt_probe_cache_file(&mut cycle, key_url, filename);
            let _ = db.upsert_icon_cycle(&cycle);
        } else {
            let _ = write_icon_file(
                &icons_dir,
                None,
                &IconRef::new(key_url, inferred_ext),
                false,
                &bytes,
            );
        }
    } else {
        let _ = write_icon_file(
            &icons_dir,
            None,
            &IconRef::new(key_url, inferred_ext),
            false,
            &bytes,
        );
    }

    Ok(bytes_to_data_uri(&bytes))
}

async fn load_or_seed_cycle(
    state: &AppState,
    canonical_id: &str,
    owner: &str,
    repo: &str,
    is_cataloged: bool,
    catalog_item: Option<&crate::github::CatalogItem>,
    token: Option<&str>,
) -> crate::db::AppIconCycle {
    let existing = state
        .db()
        .ok()
        .and_then(|db| db.get_icon_cycle(canonical_id).ok().flatten());
    match existing {
        Some(mut c) => {
            ensure_cycle_levels(
                &mut c,
                state,
                owner,
                repo,
                canonical_id,
                is_cataloged,
                catalog_item,
                token,
            )
            .await;
            if !is_cataloged && c.level == 1 {
                c.level = first_available_level(&c).unwrap_or(2);
            }
            c
        }
        None => {
            let mut c = crate::db::AppIconCycle::new(canonical_id, owner, repo);
            c.is_cataloged = is_cataloged;
            ensure_cycle_levels(
                &mut c,
                state,
                owner,
                repo,
                canonical_id,
                is_cataloged,
                catalog_item,
                token,
            )
            .await;
            c.level = if is_cataloged {
                1
            } else {
                first_available_level(&c).unwrap_or(2)
            };
            c
        }
    }
}

fn seal_empty_level_selection(
    state: &AppState,
    canonical_id: &str,
    cycle: &mut crate::db::AppIconCycle,
) {
    seal_empty_selection(cycle);
    cycle.pinned = true;
    if let Ok(db) = state.db() {
        let _ = db.upsert_icon_cycle(cycle);
        let _ = db.sync_detail_icon(canonical_id, "");
        let _ = db.sync_repo_card_icon(canonical_id, "", true);
    }
}

async fn load_cycle_target_bytes(
    state: &AppState,
    icons_dir: &std::path::Path,
    target_url: &str,
    is_cataloged: bool,
    client: &reqwest::Client,
) -> Result<Vec<u8>, String> {
    let inferred_ext = infer_ext_from_url(target_url).unwrap_or("png");
    let icon = IconRef::new(target_url, inferred_ext);
    let mut cached_bytes = if !is_cataloged {
        read_level_cache_file(icons_dir, &icon)
    } else {
        None
    };
    if cached_bytes.is_none() && is_cataloged {
        if let Ok(db) = state.db() {
            cached_bytes = load_split_cached_bytes(icons_dir, &db, &icon, true, None);
        }
    }
    match cached_bytes {
        Some(b) => Ok(b),
        None => download_icon_bytes(client, target_url).await,
    }
}

fn persist_manual_selection(
    state: &AppState,
    icons_dir: &std::path::Path,
    canonical_id: &str,
    cycle: &mut crate::db::AppIconCycle,
    next_level: i32,
    target_url: String,
    bytes: &[u8],
) -> IconCycleResult {
    let db_opt = state.db().ok();
    let inferred_ext = infer_ext_from_url(&target_url).unwrap_or("png");
    let icon = IconRef::new(&target_url, inferred_ext);
    let final_filename = write_icon_file(icons_dir, db_opt.as_deref(), &icon, false, bytes);

    seal_cycle_selection(cycle, next_level, &target_url, final_filename);
    cycle.pinned = true;
    if let Some(db) = db_opt.as_ref() {
        let _ = db.upsert_icon_cycle(cycle);
        let sel = cycle.selected_url.trim();
        if !sel.starts_with("data:") {
            let _ = db.sync_detail_icon(canonical_id, sel);
            let _ = db.sync_repo_card_icon(canonical_id, sel, false);
        }
    }

    cycle_result(next_level, bytes_to_data_uri(bytes), target_url, false)
}

/// 循环切换应用图标 (L1..=L5；收录应用恒 L1)。
pub async fn cycle_app_icon(state: &AppState, app_id: String) -> crate::AppResult<IconCycleResult> {
    let (canonical_id, repo_ref) = resolve_icon_coord(&app_id)?;
    let catalog_item = state.catalog.get_catalog_item(&canonical_id);
    if catalog_item.is_some() {
        return restore_or_fetch_icon_cycle(state, app_id).await;
    }
    let token = state.active_github_token();
    let icons_dir = ensure_icons_dir();

    let mut cycle = load_or_seed_cycle(
        state,
        &canonical_id,
        &repo_ref.owner,
        &repo_ref.repo,
        false,
        None,
        token.as_deref(),
    )
    .await;

    let next_level = next_cycle_level(cycle.level, &cycle);
    if next_level == 5 {
        seal_empty_level_selection(state, &canonical_id, &mut cycle);
        return Ok(empty_cycle_result(false));
    }

    let target_url = cycle
        .url_for_level(next_level)
        .unwrap_or("")
        .trim()
        .to_string();
    if target_url.is_empty() {
        return Err("目标级别无有效图标链接".into());
    }

    if let Ok(db) = state.db() {
        let _ = db.upsert_icon_cycle(&cycle);
    }

    let client = new_configured_icon_client();
    let bytes = load_cycle_target_bytes(state, &icons_dir, &target_url, false, &client).await?;

    Ok(persist_manual_selection(
        state,
        &icons_dir,
        &canonical_id,
        &mut cycle,
        next_level,
        target_url,
        &bytes,
    ))
}

async fn restore_existing_cycle(
    state: &AppState,
    canonical_id: &str,
    cycle: crate::db::AppIconCycle,
    is_cataloged: bool,
) -> crate::AppResult<IconCycleResult> {
    let icons_dir = crate::get_app_data_dir().join("icons");

    if cycle.level == 5 {
        return Ok(empty_cycle_result(is_cataloged));
    }

    let lvl = if !cycle.is_cataloged && cycle.level == 1 {
        first_available_level(&cycle).unwrap_or(2)
    } else {
        cycle.level
    };
    let remote_url = cycle
        .url_for_level(lvl)
        .filter(|u| !u.trim().is_empty())
        .unwrap_or(&cycle.selected_url)
        .to_string();

    let inferred_ext = infer_ext_from_url(&remote_url).unwrap_or("png");

    if !cycle.cache_file.is_empty() {
        let now = crate::now_secs();
        let cache_path = icons_dir.join(&cycle.cache_file);
        let file_fresh = is_icon_file_fresh(&cache_path);
        if is_cycle_restore_fresh(&cycle, file_fresh, now) {
            if let Some(bytes) = read_valid_image_file_async(cache_path).await {
                return Ok(cycle_result(
                    lvl,
                    bytes_to_data_uri(&bytes),
                    remote_url,
                    is_cataloged,
                ));
            }
        }
    } else if !remote_url.is_empty() {
        for fname in hash_icon_candidate_filenames(&IconRef::new(&remote_url, inferred_ext)) {
            let p = icons_dir.join(&fname);
            if !is_icon_file_fresh(&p) {
                continue;
            }
            if let Some(bytes) = read_valid_image_file_async(p).await {
                if let Ok(db) = state.db() {
                    let _ = db.set_icon_cycle_selected(canonical_id, lvl, &remote_url, &fname);
                }
                return Ok(cycle_result(
                    lvl,
                    bytes_to_data_uri(&bytes),
                    remote_url,
                    is_cataloged,
                ));
            }
        }
    }

    if !remote_url.is_empty() {
        let client = new_configured_icon_client();
        if let Ok(bytes) = download_icon_bytes(&client, &remote_url).await {
            let icon = IconRef::new(&remote_url, inferred_ext);
            let filename = write_icon_file(
                &icons_dir,
                state.db().ok().as_deref(),
                &icon,
                is_cataloged,
                &bytes,
            );
            if let Ok(db) = state.db() {
                let _ = db.set_icon_cycle_selected(canonical_id, lvl, &remote_url, &filename);
            }
            return Ok(cycle_result(
                lvl,
                bytes_to_data_uri(&bytes),
                remote_url,
                is_cataloged,
            ));
        }

        if let Some((stale_bytes, fname, _)) = read_any_cached_icon_file(
            &icons_dir,
            &IconRef::new(&remote_url, inferred_ext),
            Some(&cycle),
        ) {
            if cycle.cache_file.trim().is_empty() {
                if let Ok(db) = state.db() {
                    let _ = db.set_icon_cycle_selected(canonical_id, lvl, &remote_url, &fname);
                }
            }
            return Ok(cycle_result(
                lvl,
                bytes_to_data_uri(&stale_bytes),
                remote_url,
                is_cataloged,
            ));
        }
    }

    Ok(cycle_result(lvl, String::new(), remote_url, is_cataloged))
}

async fn restore_cataloged_default(
    catalog_item: Option<&crate::github::CatalogItem>,
) -> crate::AppResult<IconCycleResult> {
    let icons_dir = crate::get_app_data_dir().join("icons");
    let default_url = catalog_item
        .map(|i| i.icon.trim().to_string())
        .unwrap_or_default();

    if !default_url.is_empty() {
        let inferred_ext = infer_ext_from_url(&default_url).unwrap_or("png");
        let candidates = hash_icon_candidate_filenames(&IconRef::new(&default_url, inferred_ext));
        let mut hit_bytes: Option<Vec<u8>> = None;
        for fname in &candidates {
            let p = icons_dir.join(fname);
            if !is_icon_file_fresh(&p) {
                continue;
            }
            if let Some(b) = read_valid_image_file_async(p).await {
                hit_bytes = Some(b);
                break;
            }
        }
        if hit_bytes.is_none() {
            let client = new_configured_icon_client();
            if let Ok(b) = download_icon_bytes(&client, &default_url).await {
                let icon = IconRef::new(&default_url, inferred_ext);
                let _ = write_icon_file(&icons_dir, None, &icon, true, &b);
                hit_bytes = Some(b);
            } else {
                for fname in &candidates {
                    let p = icons_dir.join(fname);
                    if let Some(b) = read_valid_image_file_async(p).await {
                        hit_bytes = Some(b);
                        break;
                    }
                }
            }
        }
        if let Some(bytes) = hit_bytes {
            return Ok(cycle_result(
                1,
                bytes_to_data_uri(&bytes),
                default_url,
                true,
            ));
        }
    }

    let lvl = if default_url.is_empty() { 5 } else { 1 };
    Ok(cycle_result(lvl, String::new(), default_url, true))
}

async fn probe_uncataloged_first_cycle(
    state: &AppState,
    canonical_id: &str,
    owner: &str,
    repo: &str,
) -> crate::AppResult<IconCycleResult> {
    let icons_dir = crate::get_app_data_dir().join("icons");
    let token = state.active_github_token();
    let mut temp_cycle = crate::db::AppIconCycle::new(canonical_id, owner, repo);
    temp_cycle.is_cataloged = false;
    ensure_cycle_levels(
        &mut temp_cycle,
        state,
        owner,
        repo,
        canonical_id,
        false,
        None,
        token.as_deref(),
    )
    .await;

    let Some(lvl) = first_available_level(&temp_cycle) else {
        return Ok(empty_cycle_result(false));
    };
    let remote_url = temp_cycle
        .url_for_level(lvl)
        .unwrap_or("")
        .trim()
        .to_string();
    let inferred_ext = infer_ext_from_url(&remote_url).unwrap_or("png");
    let icon = IconRef::new(&remote_url, inferred_ext);
    if let Some(bytes) = read_level_cache_file(&icons_dir, &icon) {
        let mut hit_fname = String::new();
        if !remote_url.trim().is_empty() {
            for c in hash_icon_candidate_filenames(&icon) {
                let p = icons_dir.join(&c);
                if is_icon_file_fresh(&p) && p.is_file() {
                    hit_fname = c;
                    break;
                }
            }
        }
        seal_cycle_selection(&mut temp_cycle, lvl, &remote_url, hit_fname);
        if let Ok(db) = state.db() {
            let _ = db.upsert_icon_cycle(&temp_cycle);
        }
        return Ok(cycle_result(
            lvl,
            bytes_to_data_uri(&bytes),
            remote_url,
            false,
        ));
    }

    if !remote_url.is_empty() {
        let client = new_configured_icon_client();
        if let Ok(bytes) = download_icon_bytes(&client, &remote_url).await {
            let fn_non =
                write_icon_file(&icons_dir, state.db().ok().as_deref(), &icon, false, &bytes);
            seal_cycle_selection(&mut temp_cycle, lvl, &remote_url, fn_non);
            if let Ok(db) = state.db() {
                let _ = db.upsert_icon_cycle(&temp_cycle);
            }
            return Ok(cycle_result(
                lvl,
                bytes_to_data_uri(&bytes),
                remote_url,
                false,
            ));
        }
    }

    temp_cycle.level = lvl;
    if let Ok(db) = state.db() {
        let _ = db.upsert_icon_cycle(&temp_cycle);
    }
    Ok(cycle_result(lvl, String::new(), remote_url, false))
}

/// 恢复或探测应用当前图标轮换态（收录应用恒 L1 官方图）。
pub async fn restore_or_fetch_icon_cycle(
    state: &AppState,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    let (canonical_id, repo_ref) = resolve_icon_coord(&app_id)?;
    let catalog_item = state.catalog.get_catalog_item(&canonical_id);
    let is_cataloged = catalog_item.is_some();

    let existing = state
        .db()
        .ok()
        .and_then(|db| db.get_icon_cycle(&canonical_id).ok().flatten());

    if is_cataloged {
        let default_url = catalog_item
            .as_ref()
            .map(|i| i.icon.trim().to_string())
            .unwrap_or_default();
        if let Some(mut cycle) = existing {
            if !cycle.is_cataloged
                || cycle.l1_url != default_url
                || (cycle.level != 1 && !default_url.is_empty())
            {
                cycle.is_cataloged = true;
                if cycle.l1_url != default_url {
                    cycle.cache_file = String::new();
                }
                cycle.l1_url = default_url.clone();
                cycle.selected_url = default_url.clone();
                cycle.level = if default_url.is_empty() { 5 } else { 1 };
                cycle.pinned = false;
                if let Ok(db) = state.db() {
                    let _ = db.upsert_icon_cycle(&cycle);
                }
            }
            return restore_existing_cycle(state, &canonical_id, cycle, true).await;
        }
        return restore_cataloged_default(catalog_item.as_ref()).await;
    }

    if let Some(cycle) = existing {
        return restore_existing_cycle(state, &canonical_id, cycle, false).await;
    }
    probe_uncataloged_first_cycle(state, &canonical_id, &repo_ref.owner, &repo_ref.repo).await
}
