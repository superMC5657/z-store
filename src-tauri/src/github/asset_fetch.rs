//! 通用图片磁盘缓存下载网关。
//!
//! 可缓存图片的本地落盘查询与下载入口：命中返回本地路径，未命中下载后返回本地路径，失败回退原地址。

use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// 磁盘缓存有效期（秒）：30 天，命中且未过期直接复用。
const ASSET_TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// 单文件上限：5MB，超限丢弃并回退原地址。
const MAX_ASSET_BYTES: usize = 5 * 1024 * 1024;

/// 动态徽章域名：命中直接返回原地址，不下载。
fn is_dynamic_asset_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("shields.io")
        || lower.contains("shields")
        || lower.contains("camo")
        || lower.contains("badge")
        || lower.contains("workflow")
}

/// 去镜像前缀后的规范地址薄委托：同一资源的缓存键来源。
/// 唯一实现为 `db::cache::canonical_asset_url`（循环剥离嵌套代理包装，
/// 单层 `gh-proxy.com` 前缀为其特例，旧单测保持通过）。
pub fn normalize_asset_url(url: &str) -> String {
    crate::db::cache::canonical_asset_url(url)
}

/// 地址 path 末段扩展名薄委托（唯一实现见共享嗅探模块）。
fn url_path_ext(url: &str) -> Option<String> {
    crate::github::image_sniff::url_path_ext(url)
}

/// 扩展名白名单薄委托：无后缀放行到下载时验证，有后缀仅白名单通过。
fn url_ext_allowed(url: &str) -> bool {
    crate::github::image_sniff::url_ext_allowed(url)
}

/// 响应 content-type 是否为图片。
fn is_image_content_type(value: &str) -> bool {
    let base = value.split(';').next().unwrap_or(value);
    base.trim().to_ascii_lowercase().starts_with("image/")
}

/// 是否为可缓存候选：http(s) + 非动态，有后缀时校验扩展名白名单。
pub fn should_cache_asset(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.starts_with("data:") || trimmed.starts_with("asset://") {
        return false;
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return false;
    }
    if is_dynamic_asset_url(trimmed) {
        return false;
    }
    url_ext_allowed(trimmed)
}

/// 字节魔数嗅探薄委托（唯一实现见共享模块，含 bmp）。
fn sniff_asset_mime(bytes: &[u8]) -> Option<&'static str> {
    crate::github::image_sniff::sniff_image_mime(bytes)
}

/// 受支持的图片字节校验薄委托（含 bmp，多数口径）。
fn is_supported_image_bytes(bytes: &[u8]) -> bool {
    crate::github::image_sniff::is_supported_image_bytes(bytes)
}

/// 落盘扩展名薄委托：魔数优先，缺失时从 content-type 推断。
fn resolve_asset_ext(fresh: &DownloadedAsset) -> &'static str {
    crate::github::image_sniff::resolve_ext(&fresh.bytes, &fresh.content_type)
}

/// 缓存键：规范地址的 sha256 前 16 位。
fn cache_stem(normalized: &str) -> String {
    let full = crate::sha256_digest_hex(normalized.as_bytes());
    full[..16.min(full.len())].to_string()
}

/// 分片目录：`cache/assets/<前2位>/`。
fn shard_dir(stem: &str) -> std::path::PathBuf {
    crate::get_app_data_dir()
        .join("cache")
        .join("assets")
        .join(&stem[..2.min(stem.len())])
}

/// 分片内按 stem 查找已落盘文件（扩展名以嗅探结果为准，逐扩展名试探，含 bmp）。
fn find_cached_file(dir: &std::path::Path, stem: &str) -> Option<std::path::PathBuf> {
    for ext in ["png", "jpg", "gif", "webp", "svg", "avif", "ico", "bmp"] {
        let p = dir.join(format!("{}.{}", stem, ext));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// 文件新鲜度：mtime 在有效期内即命中。
fn is_file_fresh(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    let Ok(elapsed) = std::time::SystemTime::now().duration_since(mtime) else {
        return false;
    };
    elapsed.as_secs() < ASSET_TTL_SECS
}

/// 命中 touch：刷新 mtime 延长保鲜期。
fn touch_path(path: &std::path::Path) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

/// 同一哈希的并发下载共享单元。
fn inflight_map(
) -> &'static tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::OnceCell<String>>>> {
    static MAP: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::OnceCell<String>>>>> =
        OnceLock::new();
    MAP.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// 已有数据库文件时打开连接，不存在返回空。
fn open_asset_db() -> Option<crate::db::Database> {
    let path = crate::get_app_data_dir().join("z_store.db");
    if !path.is_file() {
        return None;
    }
    crate::db::Database::open(&path).ok()
}

/// 记录是否携带条件请求校验器。
fn has_validators(record: &crate::db::AssetCacheRecord) -> bool {
    record
        .etag
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        || record
            .last_modified
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

/// 下载产物：字节与响应头校验器。
struct DownloadedAsset {
    bytes: Vec<u8>,
    etag: Option<String>,
    last_modified: Option<String>,
    content_type: String,
}

/// 条件请求结果：未修改或新字节。
enum ConditionalResult {
    NotModified,
    Fresh(DownloadedAsset),
}

/// 共享新鲜命中确认（同步）：文件新鲜即 touch 并返回路径字符串，否则 `None`。
/// `get_cached_asset_url`（同步）与 `fetch_asset_inner` 的无记录/无校验器分支共用；
/// 有校验器分支仍走条件请求。同步无网络 IO，`markdown` 同步调用链保持同步（不改异步）。
/// 与 `find_cached_file`（按 stem 找文件）区分：本函数只做新鲜度门控。
fn find_cached(path: &std::path::Path) -> Option<String> {
    if is_file_fresh(path) {
        touch_path(path);
        return Some(path.to_string_lossy().to_string());
    }
    None
}

/// 同步缓存命中查询：命中未过期返回本地路径并 touch，否则返回原地址（不下载）。
pub fn get_cached_asset_url(url: &str) -> String {
    let trimmed = url.trim();
    if !should_cache_asset(trimmed) {
        return trimmed.to_string();
    }
    let normalized = normalize_asset_url(trimmed);
    let stem = cache_stem(&normalized);
    let dir = shard_dir(&stem);
    if let Some(path) = find_cached_file(&dir, &stem) {
        if let Some(hit) = find_cached(&path) {
            return hit;
        }
    }
    trimmed.to_string()
}

/// 下载网关：本地路径或原地址。
pub async fn fetch_or_cache_asset_url_inner(url: &str, app_id: &str) -> String {
    let trimmed = url.trim();
    if !should_cache_asset(trimmed) {
        return trimmed.to_string();
    }
    let normalized = normalize_asset_url(trimmed);
    let stem = cache_stem(&normalized);
    let cell = {
        let map = inflight_map();
        let mut guard = map.lock().await;
        if let Some(existing) = guard.get(&stem) {
            Arc::clone(existing)
        } else {
            let created = Arc::new(tokio::sync::OnceCell::new());
            guard.insert(stem.clone(), Arc::clone(&created));
            created
        }
    };
    let trimmed_owned = trimmed.to_string();
    let normalized_owned = normalized.clone();
    let stem_owned = stem.clone();
    let app_owned = app_id.trim().to_string();
    let result = cell
        .get_or_init(|| async move {
            fetch_asset_inner(&trimmed_owned, &normalized_owned, &stem_owned, &app_owned).await
        })
        .await
        .clone();
    {
        let map = inflight_map();
        let mut guard = map.lock().await;
        if let Some(existing) = guard.get(&stem) {
            if Arc::ptr_eq(existing, &cell) {
                guard.remove(&stem);
            }
        }
    }
    result
}

/// 单次获取内核：命中复用、过期条件请求、未命中下载落盘。
async fn fetch_asset_inner(trimmed: &str, normalized: &str, stem: &str, app: &str) -> String {
    let dir = shard_dir(stem);
    let existing = find_cached_file(&dir, stem);
    let record: Option<crate::db::AssetCacheRecord> = open_asset_db()
        .and_then(|d| d.get_asset(normalized).ok().flatten());
    let now = crate::now_secs();
    if let (Some(path), Some(rec)) = (existing.clone(), record.clone()) {
        if rec.expires_at > now {
            if let Some(hit) = find_cached(&path) {
                if !app.is_empty() {
                    if let Some(d) = open_asset_db() {
                        let _ = d.touch_asset(&rec.hash, app);
                    }
                }
                return hit;
            }
        }
        if has_validators(&rec) {
            let etag = rec.etag.clone();
            let last_modified = rec.last_modified.clone();
            let hash = rec.hash.clone();
            match fetch_remote_asset(
                normalized,
                etag.as_deref(),
                last_modified.as_deref(),
            )
            .await
            {
                Ok(ConditionalResult::NotModified) => {
                    let new_expires = crate::now_secs() + ASSET_TTL_SECS as i64;
                    if let Some(d) = open_asset_db() {
                        let _ = d.refresh_asset_revalidated(&hash, new_expires);
                    }
                    touch_path(&path);
                    return path.to_string_lossy().to_string();
                }
                Ok(ConditionalResult::Fresh(fresh)) => {
                    return store_fresh_asset(trimmed, normalized, stem, &dir, existing, fresh, app);
                }
                Err(reason) => {
                    log::debug!(
                        "asset cache revalidate failed app={} reason={}",
                        app,
                        crate::log_support::short_reason(&reason)
                    );
                    return path.to_string_lossy().to_string();
                }
            }
        } else if is_file_fresh(&path) {
            if let Some(hit) = find_cached(&path) {
                if !app.is_empty() {
                    if let Some(d) = open_asset_db() {
                        let _ = d.touch_asset(&rec.hash, app);
                    }
                }
                return hit;
            }
        }
    } else if let Some(path) = existing.clone() {
        if let Some(hit) = find_cached(&path) {
            return hit;
        }
    }
    let fetched = match fetch_remote_asset(normalized, None, None).await {
        Ok(ConditionalResult::Fresh(fresh)) => fresh,
        Ok(ConditionalResult::NotModified) => {
            if let Some(path) = existing {
                return path.to_string_lossy().to_string();
            }
            return trimmed.to_string();
        }
        Err(reason) => {
            log::debug!(
                "asset cache download failed app={} reason={}",
                app,
                crate::log_support::short_reason(&reason)
            );
            if let Some(path) = existing {
                return path.to_string_lossy().to_string();
            }
            return trimmed.to_string();
        }
    };
    store_fresh_asset(trimmed, normalized, stem, &dir, existing, fetched, app)
}

/// 新字节校验落盘并同步数据库记录。
#[allow(clippy::too_many_arguments)]
fn store_fresh_asset(
    trimmed: &str,
    normalized: &str,
    stem: &str,
    dir: &std::path::Path,
    existing: Option<std::path::PathBuf>,
    fresh: DownloadedAsset,
    app: &str,
) -> String {
    if !is_supported_image_bytes(&fresh.bytes) {
        return trimmed.to_string();
    }
    let ext = resolve_asset_ext(&fresh);
    let final_path = dir.join(format!("{}.{}", stem, ext));
    if persist_asset_bytes(&fresh.bytes, &final_path, stem).is_err() {
        if let Some(path) = existing {
            return path.to_string_lossy().to_string();
        }
        return trimmed.to_string();
    }
    if let Some(old) = existing {
        if old != final_path {
            let _ = std::fs::remove_file(&old);
        }
    }
    let content_type = if fresh.content_type.trim().is_empty() {
        sniff_asset_mime(&fresh.bytes).unwrap_or("image/png").to_string()
    } else {
        fresh.content_type
    };
    let expires_at = crate::now_secs() + ASSET_TTL_SECS as i64;
    if let Some(d) = open_asset_db() {
        if let Ok(saved) = d.save_asset(
            normalized,
            &content_type,
            fresh.bytes.len() as i64,
            fresh.etag.as_deref(),
            fresh.last_modified.as_deref(),
            expires_at,
        ) {
            if !app.is_empty() {
                let _ = d.touch_asset(&saved.hash, app);
            }
        }
    }
    log::debug!(
        "asset cache stored app={} bytes={} ext={}",
        app,
        fresh.bytes.len(),
        ext
    );
    final_path.to_string_lossy().to_string()
}

/// 条件下载：携带校验器，未修改返回空，成功返回字节与响应头。
async fn fetch_remote_asset(
    download_url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<ConditionalResult, String> {
    let secs = crate::config::get_project_config()
        .network
        .api_timeout_seconds;
    let client =
        crate::forge::http::new_icon_client(secs).unwrap_or_else(|_| reqwest::Client::new());
    if url_path_ext(download_url).is_none() {
        if let Ok(head) = client
            .head(download_url)
            .headers(crate::forge::http::icon_headers())
            .send()
            .await
        {
            if head.status().is_success() {
                if let Some(value) = head
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    if !is_image_content_type(value) {
                        return Err("non-image content-type".to_string());
                    }
                }
            }
        }
    }
    let mut request = client
        .get(download_url)
        .headers(crate::forge::http::icon_headers());
    if let Some(value) = etag.map(str::trim).filter(|s| !s.is_empty()) {
        request = request.header(reqwest::header::IF_NONE_MATCH, value);
    }
    if let Some(value) = last_modified.map(str::trim).filter(|s| !s.is_empty()) {
        request = request.header(reqwest::header::IF_MODIFIED_SINCE, value);
    }
    let resp = request.send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(ConditionalResult::NotModified);
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let etag_new = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let last_modified_new = resp
        .headers()
        .get(reqwest::header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let content_type_new = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_default();
    if let Some(len) = resp.content_length() {
        if len > MAX_ASSET_BYTES as u64 {
            return Err("asset too large".to_string());
        }
    }
    let mut buf = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let c = chunk.map_err(|e| e.to_string())?;
        if buf.len() + c.len() > MAX_ASSET_BYTES {
            return Err("asset too large".to_string());
        }
        buf.extend_from_slice(&c);
    }
    if buf.is_empty() {
        return Err("empty body".to_string());
    }
    Ok(ConditionalResult::Fresh(DownloadedAsset {
        bytes: buf,
        etag: etag_new,
        last_modified: last_modified_new,
        content_type: content_type_new,
    }))
}

/// 原子落盘：先写临时文件再 rename 入分片目录。
fn persist_asset_bytes(
    bytes: &[u8],
    final_path: &std::path::Path,
    stem: &str,
) -> Result<(), String> {
    let tmp_dir = crate::get_app_data_dir().join("cache").join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = tmp_dir.join(format!("{}.part", stem));
    std::fs::write(&tmp_path, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_mirror_prefix() {
        assert_eq!(
            normalize_asset_url("https://gh-proxy.com/https://raw.githubusercontent.com/o/r/main/a.png"),
            "https://raw.githubusercontent.com/o/r/main/a.png"
        );
        assert_eq!(
            normalize_asset_url("https://example.com/a.png"),
            "https://example.com/a.png"
        );
    }

    #[test]
    fn dynamic_urls_are_not_candidates() {
        assert!(!should_cache_asset("https://img.shields.io/badge/x-y-green"));
        assert!(!should_cache_asset(
            "https://camo.githubusercontent.com/abc"
        ));
        assert!(!should_cache_asset("https://example.com/badge.svg"));
        assert!(!should_cache_asset(
            "https://github.com/o/r/actions/workflows/ci.yml/badge.svg"
        ));
    }

    #[test]
    fn whitelist_gates_candidates() {
        assert!(should_cache_asset("https://example.com/a.png"));
        assert!(should_cache_asset(
            "https://raw.githubusercontent.com/o/r/main/a.avif"
        ));
        // bmp 纳入白名单（多数口径：icons 与 db 含、旧 asset 缺 → 含，见 image_sniff）。
        assert!(should_cache_asset("https://example.com/a.bmp"));
        assert!(should_cache_asset("https://example.com/a.apng"));
        assert!(!should_cache_asset("https://example.com/a.mp4"));
        assert!(should_cache_asset("https://example.com/noext"));
        assert!(should_cache_asset(
            "https://github.com/user-attachments/assets/56af271c-949d-454c-a3ea-16188c063414"
        ));
        assert!(!should_cache_asset("data:image/png;base64,xx"));
    }

    #[test]
    fn magic_accepts_whitelist_rejects_html() {
        assert!(is_supported_image_bytes(b"\x89PNG\r\n\x1a\nxxxxxxxx"));
        assert!(is_supported_image_bytes(b"\xff\xd8\xff\x00\x11"));
        assert!(is_supported_image_bytes(b"<svg></svg>"));
        // bmp 纳入支持（多数口径，见 image_sniff::bmp_supported_everywhere）。
        assert!(is_supported_image_bytes(b"BM12345678"));
        assert!(!is_supported_image_bytes(
            b"<!DOCTYPE html><html>404</html>"
        ));
        assert!(!is_supported_image_bytes(b""));
    }

    #[test]
    fn cache_stem_is_stable_and_sharded() {
        let a = cache_stem("https://example.com/a.png");
        let b = cache_stem("https://example.com/a.png");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(shard_dir(&a).ends_with(&a[..2]));
    }
}
