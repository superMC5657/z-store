//! 通用图片磁盘缓存下载网关，命中或落盘后返回 `data:` URI，失败时回退原地址。

use crate::icons::is_valid_image;
use std::sync::{Arc, LazyLock, Mutex};

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

/// 规范地址薄委托：同一资源的缓存键来源。
/// 唯一实现为 `db::cache::canonical_asset_url`（嵌套包装归一，直链恒等）。
pub fn normalize_asset_url(url: &str) -> String {
    crate::db::cache::canonical_asset_url(url)
}

/// 地址 path 末段扩展名薄委托（唯一实现见共享嗅探模块）。
fn url_path_ext(url: &str) -> Option<String> {
    crate::icons::url_path_ext(url)
}

/// 扩展名白名单薄委托：无后缀放行到下载时验证，有后缀仅白名单通过。
fn url_ext_allowed(url: &str) -> bool {
    crate::icons::url_ext_allowed(url)
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
    crate::icons::sniff_image_mime(bytes)
}

/// 落盘扩展名薄委托：魔数优先，缺失时从 content-type 推断。
fn resolve_asset_ext(fresh: &DownloadedAsset) -> &'static str {
    crate::icons::resolve_ext(&fresh.bytes, &fresh.content_type)
}

/// 缓存键：规范地址的 sha256 前 16 位。
fn cache_stem(normalized: &str) -> String {
    let full = crate::sha256_digest_hex(normalized.as_bytes());
    full[..16.min(full.len())].to_string()
}

/// 分片目录：`cache/assets/<前2位>/`。
fn shard_dir(root: &std::path::Path, stem: &str) -> std::path::PathBuf {
    root.join("cache")
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

/// 共享数据库句柄（生产为 `AppState.db`）。
pub(crate) type SharedDb = Arc<Mutex<crate::db::Database>>;

/// 同一缓存键的并发下载单飞表（结果为 `data:` URI 或原地址）。
static ASSET_FLIGHTS: LazyLock<crate::icons::Flights<String>> =
    LazyLock::new(crate::icons::Flights::new);

/// 运行期配额节流：每 32 次落盘或累计 64 MiB 新增字节触发一次后台淘汰
/// （启动期另有一次全量淘汰，见 `lib.rs`）。
static ASSET_QUOTA_THROTTLE: crate::icons::QuotaThrottle =
    crate::icons::QuotaThrottle::new(32, 64 * 1024 * 1024, None);

/// 缓存根目录下已有数据库文件时打开连接，不存在返回空（测试注入路径用）。
#[cfg(test)]
fn open_asset_db(root: &std::path::Path) -> Option<crate::db::Database> {
    let path = root.join("z_store.db");
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

/// 已落盘图片转可渲染 `data:` URI（读取经魔数校验；文件缺失/损坏返回 `None`）。
fn read_cached_asset_data_uri(path: &std::path::Path) -> Option<String> {
    crate::icons::read_valid_image_file(path).map(|bytes| crate::icons::bytes_to_data_uri(&bytes))
}

/// 共享新鲜命中确认：文件新鲜且可读即 touch 并返回 `data:` URI，否则 `None`
/// （损坏文件落空后走重新下载）。与 `find_cached_file`（按 stem 找文件）区分：本函数只做新鲜度门控。
fn find_cached(path: &std::path::Path) -> Option<String> {
    if !is_file_fresh(path) {
        return None;
    }
    let uri = read_cached_asset_data_uri(path)?;
    touch_path(path);
    Some(uri)
}

/// 阻塞文件 IO 卸到阻塞线程池；任务 panic 视为 `None`。
async fn blocking<T, F>(f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(f).await.ok()
}

/// 单次获取的上下文：缓存根、可选数据库与规范化坐标。
struct AssetJob<'a> {
    root: &'a std::path::Path,
    db: Option<&'a SharedDb>,
    trimmed: &'a str,
    normalized: &'a str,
    stem: &'a str,
    app: &'a str,
}

impl AssetJob<'_> {
    /// 短锁执行一次 DB 操作；无库或锁中毒返回 `None`。
    fn with_db<T>(&self, f: impl FnOnce(&crate::db::Database) -> T) -> Option<T> {
        let guard = self.db?.lock().ok()?;
        Some(f(&guard))
    }

    fn touch_app(&self, hash: &str) {
        if !self.app.is_empty() {
            self.with_db(|d| {
                let _ = d.touch_asset(hash, self.app);
            });
        }
    }

    /// 新鲜命中（阻塞线程池读盘 + touch）。
    async fn fresh_hit(&self, path: &std::path::Path) -> Option<String> {
        let path = path.to_path_buf();
        blocking(move || find_cached(&path)).await.flatten()
    }

    /// 旧盘文件兜底：可读即返回 `data:` URI（可选先 touch 续期），否则回退原地址。
    async fn cached_or_original(&self, path: Option<std::path::PathBuf>, touch: bool) -> String {
        let read = match path {
            Some(p) => blocking(move || {
                if touch {
                    touch_path(&p);
                }
                read_cached_asset_data_uri(&p)
            })
            .await
            .flatten(),
            None => None,
        };
        read.unwrap_or_else(|| self.trimmed.to_string())
    }
}

/// 下载网关（生产入口）：复用共享 `AppState.db`，缓存根为应用数据目录。
pub async fn fetch_or_cache_asset_url_inner(db: &SharedDb, url: &str, app_id: &str) -> String {
    fetch_or_cache_asset_url_with(&crate::get_app_data_dir(), Some(db), url, app_id).await
}

/// 下载网关（缓存根可注入，测试用）：根目录下已有 `z_store.db` 时本次调用只打开一次并全程复用。
#[cfg(test)]
pub(crate) async fn fetch_or_cache_asset_url_in(
    root: &std::path::Path,
    url: &str,
    app_id: &str,
) -> String {
    let db = open_asset_db(root).map(|d| Arc::new(Mutex::new(d)));
    fetch_or_cache_asset_url_with(root, db.as_ref(), url, app_id).await
}

/// 下载网关内核：`data:` URI 或原地址。
pub(crate) async fn fetch_or_cache_asset_url_with(
    root: &std::path::Path,
    db: Option<&SharedDb>,
    url: &str,
    app_id: &str,
) -> String {
    let trimmed = url.trim();
    if !should_cache_asset(trimmed) {
        return trimmed.to_string();
    }
    let normalized = normalize_asset_url(trimmed);
    let stem = cache_stem(&normalized);
    let job = AssetJob {
        root,
        db,
        trimmed,
        normalized: &normalized,
        stem: &stem,
        app: app_id.trim(),
    };
    // 单飞键含缓存根，避免不同根（测试并发）互相复用结果；守卫析构即摘键（含取消）。
    let flight = ASSET_FLIGHTS.join(format!("{}|{}", root.to_string_lossy(), stem));
    flight
        .cell()
        .get_or_init(|| fetch_asset_inner(&job))
        .await
        .clone()
}

/// 单次获取内核：命中复用、过期条件请求、未命中下载落盘。
async fn fetch_asset_inner(job: &AssetJob<'_>) -> String {
    let dir = shard_dir(job.root, job.stem);
    let existing = {
        let dir = dir.clone();
        let stem = job.stem.to_string();
        blocking(move || find_cached_file(&dir, &stem))
            .await
            .flatten()
    };
    let record: Option<crate::db::AssetCacheRecord> = job
        .with_db(|d| d.get_asset(job.normalized).ok().flatten())
        .flatten();
    let now = crate::now_secs();
    if let (Some(path), Some(rec)) = (existing.clone(), record) {
        if rec.expires_at > now {
            if let Some(hit) = job.fresh_hit(&path).await {
                job.touch_app(&rec.hash);
                return hit;
            }
        }
        if has_validators(&rec) {
            match fetch_remote_asset(
                job.normalized,
                rec.etag.as_deref(),
                rec.last_modified.as_deref(),
            )
            .await
            {
                Ok(ConditionalResult::NotModified) => {
                    let new_expires = crate::now_secs() + ASSET_TTL_SECS as i64;
                    job.with_db(|d| {
                        let _ = d.refresh_asset_revalidated(&rec.hash, new_expires);
                    });
                    return job.cached_or_original(Some(path), true).await;
                }
                Ok(ConditionalResult::Fresh(fresh)) => {
                    return store_fresh_asset(job, &dir, existing, fresh).await;
                }
                Err(_reason) => {
                    // 离线/上游失败：过期旧文件仍优于裸连远端。
                    return job.cached_or_original(Some(path), false).await;
                }
            }
        } else if let Some(hit) = job.fresh_hit(&path).await {
            job.touch_app(&rec.hash);
            return hit;
        }
    } else if let Some(path) = existing.as_deref() {
        if let Some(hit) = job.fresh_hit(path).await {
            return hit;
        }
    }
    let fetched = match fetch_remote_asset(job.normalized, None, None).await {
        Ok(ConditionalResult::Fresh(fresh)) => fresh,
        Ok(ConditionalResult::NotModified) | Err(_) => {
            return job.cached_or_original(existing, false).await;
        }
    };
    store_fresh_asset(job, &dir, existing, fetched).await
}

/// 新字节校验落盘并同步数据库记录，返回 `data:` URI（落盘失败仍以内存字节渲染）。
/// 编码与文件写入在阻塞线程池执行，DB 只在落盘后短锁写入一次。
async fn store_fresh_asset(
    job: &AssetJob<'_>,
    dir: &std::path::Path,
    existing: Option<std::path::PathBuf>,
    fresh: DownloadedAsset,
) -> String {
    if !is_valid_image(&fresh.bytes) {
        return job.cached_or_original(existing, false).await;
    }
    let ext = resolve_asset_ext(&fresh);
    let final_path = dir.join(format!("{}.{}", job.stem, ext));
    let content_type = if fresh.content_type.trim().is_empty() {
        sniff_asset_mime(&fresh.bytes)
            .unwrap_or("image/png")
            .to_string()
    } else {
        fresh.content_type
    };
    let size = fresh.bytes.len();
    let persisted = {
        let root = job.root.to_path_buf();
        let stem = job.stem.to_string();
        let bytes = fresh.bytes;
        blocking(move || {
            let data_uri = crate::icons::bytes_to_data_uri(&bytes);
            let ok = persist_asset_bytes(&root, &bytes, &final_path, &stem).is_ok();
            if ok {
                if let Some(old) = existing {
                    if old != final_path {
                        let _ = std::fs::remove_file(&old);
                    }
                }
            }
            (data_uri, ok)
        })
        .await
    };
    let Some((data_uri, ok)) = persisted else {
        return job.trimmed.to_string();
    };
    if !ok {
        return data_uri;
    }
    let expires_at = crate::now_secs() + ASSET_TTL_SECS as i64;
    job.with_db(|d| {
        if let Ok(saved) = d.save_asset(
            job.normalized,
            &content_type,
            size as i64,
            fresh.etag.as_deref(),
            fresh.last_modified.as_deref(),
            expires_at,
        ) {
            if !job.app.is_empty() {
                let _ = d.touch_asset(&saved.hash, job.app);
            }
        }
    });
    if ASSET_QUOTA_THROTTLE.record(size as u64) {
        if let Some(db) = job.db {
            spawn_asset_quota_prune(Arc::clone(db), job.root.join("cache").join("assets"));
        }
    }
    data_uri
}

/// 后台配额淘汰：递归扫描在 DB 锁外完成，仅淘汰阶段短暂持锁。
fn spawn_asset_quota_prune(db: SharedDb, assets_dir: std::path::PathBuf) {
    tokio::task::spawn_blocking(move || {
        let scanned = crate::db::cache::scan_asset_files(&assets_dir);
        if let Ok(d) = db.lock() {
            let _ = d.enforce_asset_quota_lru_scanned(&assets_dir, scanned);
        }
    });
}

/// 读取响应头文本值（去空白，空值视为缺失）。
fn header_text(resp: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 条件下载：携带校验器，未修改返回空，成功返回字节与响应头。
/// 无扩展名地址在读取响应体前按 `Content-Type` 拒绝非图片；`Content-Length` 超限与
/// 流式累积超限同样在缓冲前中断。
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
    let content_type_new = header_text(&resp, reqwest::header::CONTENT_TYPE).unwrap_or_default();
    if url_path_ext(download_url).is_none()
        && !content_type_new.is_empty()
        && !is_image_content_type(&content_type_new)
    {
        return Err("non-image content-type".to_string());
    }
    let etag_new = header_text(&resp, reqwest::header::ETAG);
    let last_modified_new = header_text(&resp, reqwest::header::LAST_MODIFIED);
    let buf = crate::forge::http::read_body_capped(resp, MAX_ASSET_BYTES)
        .await
        .map_err(|e| match e {
            crate::forge::http::BodyReadError::TooLarge => "asset too large".to_string(),
            crate::forge::http::BodyReadError::Transport(e) => e.to_string(),
        })?;
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

/// 原子落盘：先写进程内唯一临时文件再 rename 入分片目录，避免并发写碰撞同一 `.part`。
fn persist_asset_bytes(
    root: &std::path::Path,
    bytes: &[u8],
    final_path: &std::path::Path,
    stem: &str,
) -> Result<(), String> {
    static TEMP_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp_dir = root.join("cache").join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let nonce = TEMP_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = tmp_dir.join(format!("{}.{}-{}.part", stem, std::process::id(), nonce));
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
    fn normalize_keeps_direct_url() {
        // 全链已直链：规范地址对直链恒等透传。
        assert_eq!(
            normalize_asset_url("https://raw.githubusercontent.com/o/r/main/a.png"),
            "https://raw.githubusercontent.com/o/r/main/a.png"
        );
        assert_eq!(
            normalize_asset_url("https://example.com/a.png"),
            "https://example.com/a.png"
        );
    }

    #[test]
    fn dynamic_urls_are_not_candidates() {
        assert!(!should_cache_asset(
            "https://img.shields.io/badge/x-y-green"
        ));
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
        // bmp 纳入白名单（见 crate::icons::image_sniff）。
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
        assert!(is_valid_image(b"\x89PNG\r\n\x1a\nxxxxxxxx"));
        assert!(is_valid_image(b"\xff\xd8\xff\x00\x11"));
        assert!(is_valid_image(b"<svg></svg>"));
        // bmp 纳入支持（见 crate::icons::image_sniff）。
        assert!(is_valid_image(b"BM12345678"));
        assert!(!is_valid_image(b"<!DOCTYPE html><html>404</html>"));
        assert!(!is_valid_image(b""));
    }

    /// 本地图片服务：按路径回 PNG / GIF。
    async fn serve_images() -> crate::test_support::TestServer {
        use crate::test_support::{serve, Reply};
        serve(|req| {
            if req.starts_with("GET /demo.gif") {
                Reply::ok(&b"GIF89a\x01\x00\x01\x00\x00\x00\x00;"[..])
                    .header("Content-Type", "image/gif")
            } else {
                Reply::ok(&b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"[..])
                    .header("Content-Type", "image/png")
            }
        })
        .await
    }

    #[tokio::test]
    async fn fetch_returns_data_uri_on_store_and_cache_hit() {
        let root = tempfile::tempdir().unwrap();
        let server = serve_images().await;
        let png = format!("{}/demo.png", server.base);
        let gif = format!("{}/demo.gif", server.base);

        let first = fetch_or_cache_asset_url_in(root.path(), &png, "o/r").await;
        assert!(first.starts_with("data:image/png;base64,"), "{first}");
        let gif_uri = fetch_or_cache_asset_url_in(root.path(), &gif, "o/r").await;
        assert!(gif_uri.starts_with("data:image/gif;base64,"), "{gif_uri}");
        let after_store = server.hits();

        // 30 天内二次命中：读盘返回同一 data: URI，零网络。
        let second = fetch_or_cache_asset_url_in(root.path(), &png, "o/r").await;
        assert_eq!(second, first);
        assert_eq!(server.hits(), after_store);
    }

    #[tokio::test]
    async fn shared_db_records_asset_and_serves_hits_without_network() {
        let root = tempfile::tempdir().unwrap();
        let server = serve_images().await;
        let png = format!("{}/shared.png", server.base);
        let db: SharedDb = Arc::new(Mutex::new(crate::db::Database::open_in_memory().unwrap()));

        let first = fetch_or_cache_asset_url_with(root.path(), Some(&db), &png, "o/r").await;
        assert!(first.starts_with("data:image/png;base64,"), "{first}");
        let rec = db
            .lock()
            .unwrap()
            .get_asset(&png)
            .unwrap()
            .expect("record saved");
        assert_eq!(rec.content_type, "image/png");
        let after_store = server.hits();

        let second = fetch_or_cache_asset_url_with(root.path(), Some(&db), &png, "o/r").await;
        assert_eq!(second, first);
        assert_eq!(server.hits(), after_store);
        let touched = db.lock().unwrap().get_asset(&png).unwrap().unwrap();
        assert!(
            touched.hits > rec.hits,
            "cache hit touches the shared record"
        );
    }

    #[tokio::test]
    async fn extensionless_non_image_is_rejected_with_single_get() {
        use crate::test_support::{serve, Reply};
        let root = tempfile::tempdir().unwrap();
        let server = serve(|_| {
            Reply::ok(&b"<!DOCTYPE html><html></html>"[..]).header("Content-Type", "text/html")
        })
        .await;
        let url = format!("{}/user-attachments/assets/abc", server.base);
        assert_eq!(
            fetch_or_cache_asset_url_in(root.path(), &url, "").await,
            url
        );
        let reqs = server.requests();
        assert_eq!(reqs.len(), 1, "no HEAD preflight");
        assert!(reqs[0].starts_with("GET "), "{}", reqs[0]);
    }

    #[tokio::test]
    async fn concurrent_requests_share_one_download_and_leave_no_flight() {
        let root = tempfile::tempdir().unwrap();
        let server = serve_images().await;
        let png = format!("{}/flight.png", server.base);
        let (a, b) = tokio::join!(
            fetch_or_cache_asset_url_in(root.path(), &png, ""),
            fetch_or_cache_asset_url_in(root.path(), &png, "")
        );
        assert_eq!(a, b);
        assert_eq!(server.hits(), 1);
        // 单飞完成后摘键：再次加入得到全新的未初始化单元。
        let key = format!("{}|{}", root.path().to_string_lossy(), cache_stem(&png));
        assert!(ASSET_FLIGHTS.join(key).cell().get().is_none());
    }

    #[tokio::test]
    async fn dynamic_and_failed_urls_fall_back_to_original() {
        let root = tempfile::tempdir().unwrap();
        let badge = "https://img.shields.io/badge/x-y-green";
        assert_eq!(
            fetch_or_cache_asset_url_in(root.path(), badge, "").await,
            badge
        );
        let dead = format!("http://{}/gone.png", crate::test_support::dead_addr());
        assert_eq!(
            fetch_or_cache_asset_url_in(root.path(), &dead, "").await,
            dead
        );
    }

    #[test]
    fn cache_stem_is_stable_and_sharded() {
        let a = cache_stem("https://example.com/a.png");
        let b = cache_stem("https://example.com/a.png");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(shard_dir(std::path::Path::new("x"), &a).ends_with(&a[..2]));
    }

    #[test]
    fn concurrent_persist_asset_bytes_uses_unique_part_files_without_collision() {
        let root = tempfile::tempdir().unwrap();
        let final_path = root.path().join("cache").join("assets").join("ab").join("ab12.png");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let mut handles = Vec::new();
        for i in 0..4u8 {
            let root_buf = root.path().to_path_buf();
            let final_buf = final_path.clone();
            let b = std::sync::Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                b.wait();
                persist_asset_bytes(&root_buf, &[i; 64], &final_buf, "ab12")
            }));
        }
        let mut ok_count = 0usize;
        for h in handles {
            if h.join().unwrap().is_ok() {
                ok_count += 1;
            }
        }
        assert!(ok_count >= 1);
        let written = std::fs::read(&final_path).unwrap();
        assert_eq!(written.len(), 64);
        assert!(written.iter().all(|&b| b == written[0]), "no torn writes");
        // No leftover .part temp files in cache/tmp.
        let tmp_entries: Vec<_> = std::fs::read_dir(root.path().join("cache").join("tmp"))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(tmp_entries.is_empty(), "leftover .part files: {:?}", tmp_entries);
    }
}
