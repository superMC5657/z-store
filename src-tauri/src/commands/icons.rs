use crate::AppState;
use tauri::State;

#[path = "icons_cycle.rs"]
pub mod icons_cycle;
pub use icons_cycle::*;

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn base64_encode(data: &[u8]) -> String {
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

        result.push(BASE64_ALPHABET[(b0 >> 2) as usize] as char);
        result.push(BASE64_ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            result.push(BASE64_ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(BASE64_ALPHABET[(b2 & 0x3f) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

/// B1-G10：图标魔数单一对照表——所有字节前缀魔数只在此一处定义。
/// `detect_image_mime` 与 `is_valid_image` 均经由 [`sniff_image_mime`] 同调，消除双实现漂移。
const MAGIC_PREFIXES: &[(&[u8], &str)] = &[
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x00\x00\x01\x00", "image/x-icon"),
    (b"BM", "image/bmp"),
];

/// 由 [`MAGIC_PREFIXES`] 及容器/文本分支嗅探 MIME；未知返回 `None`（由调用方决定回退）。
/// - WEBP：`RIFF....WEBP`（偏移 8 处 4 字节，需 len > 12，保持历史阈值）；
/// - AVIF：`....ftypavif/avis`（偏移 4/8，需 len >= 12）；
/// - SVG：去 UTF-8 BOM + 跳过前导 ASCII 空白后，以 `<?xml` / `<svg` 开头。
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    for &(magic, mime) in MAGIC_PREFIXES {
        if bytes.starts_with(magic) {
            return Some(mime);
        }
    }
    if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        return Some("image/avif");
    }
    // SVG 可能带有 UTF-8 BOM (\xef\xbb\xbf) 或前导空白/换行
    let trimmed = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let trimmed = match trimmed.iter().position(|&b| !b.is_ascii_whitespace()) {
        Some(idx) => &trimmed[idx..],
        None => trimmed,
    };
    if trimmed.starts_with(b"<?xml") || trimmed.starts_with(b"<svg") {
        return Some("image/svg+xml");
    }
    None
}

pub(crate) fn detect_image_mime(bytes: &[u8]) -> &'static str {
    sniff_image_mime(bytes).unwrap_or("image/png")
}

pub(crate) fn bytes_to_data_uri(bytes: &[u8]) -> String {
    let mime = detect_image_mime(bytes);
    let b64 = base64_encode(bytes);
    format!("data:{};base64,{}", mime, b64)
}

pub fn is_valid_image(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    sniff_image_mime(bytes).is_some()
}

/// B1-G10：mime<->ext 单一对照表（规范对）。`mime_to_ext` / `ext_to_mime` 均由此派生；
/// 历史别名（`image/apng`→`png`、`image/vnd.microsoft.icon`→`ico`、
/// `apng`→`image/apng`、`jpeg`→`image/jpeg`）保留为显式分支，行为与合表前一致。
const MIME_EXT_TABLE: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/x-icon", "ico"),
    ("image/svg+xml", "svg"),
    ("image/avif", "avif"),
    ("image/bmp", "bmp"),
];

pub(crate) fn mime_to_ext(mime: &str) -> &'static str {
    let clean = mime.trim().to_ascii_lowercase();
    if clean == "image/apng" {
        return "png";
    }
    if clean == "image/vnd.microsoft.icon" {
        return "ico";
    }
    for (m, e) in MIME_EXT_TABLE {
        if clean.as_str() == *m {
            return e;
        }
    }
    "png"
}

/// 仅测试调用（`commands::tests`），生产代码无调用；非 test 构建下允许死代码，保持 `cargo check` 零警告。
/// 签名保持不变，作为回滚线。
#[allow(dead_code)]
pub(crate) fn ext_to_mime(ext: &str) -> &'static str {
    let clean = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if clean == "apng" {
        return "image/apng";
    }
    if clean == "jpeg" {
        return "image/jpeg";
    }
    for (m, e) in MIME_EXT_TABLE {
        if clean.as_str() == *e {
            return m;
        }
    }
    "image/png"
}

/// 从 remote_url path 中提取真实扩展名（去掉 query/fragment，转小写，仅允许 png/jpg/jpeg/gif/webp/svg/ico/avif/apng/bmp，jpeg 统一为 jpg）。
/// 无有效扩展名时返回 None。
pub(crate) fn infer_icon_ext_from_url(remote_url: &str) -> Option<&'static str> {
    let raw = remote_url.trim();
    if raw.is_empty() {
        return None;
    }
    let path = if let Ok(parsed) = reqwest::Url::parse(raw) {
        parsed.path().to_string()
    } else {
        let no_hash = raw.split('#').next().unwrap_or(raw);
        let no_query = no_hash.split('?').next().unwrap_or(no_hash);
        no_query.to_string()
    };

    let segment = path.rsplit('/').next()?;
    let dot_idx = segment.rfind('.')?;
    let ext = &segment[dot_idx + 1..];
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "svg" => Some("svg"),
        "ico" => Some("ico"),
        "avif" => Some("avif"),
        "apng" => Some("apng"),
        "bmp" => Some("bmp"),
        _ => None,
    }
}

/// 图标缓存文件名消毒：仅保留字母数字及 `-`/`_`，用于构造本地图标缓存文件名。
/// 消毒后为空时，调用方回退到基于 remote_url 的 SHA-256 哈希命名。
pub(crate) fn sanitize_icon_segment(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

pub(crate) fn is_avatar_url(url: &str) -> bool {
    let u = url.trim();
    u.contains("avatars.githubusercontent.com") || u.contains("identicons.github.com")
}

/// B3-G11 标识解析 SSOT：统一经 `RepositoryUrlParser::parse` 取 owner/repo，不手写 split_once。
pub(crate) fn get_icon_stem(app_id: &str, remote_url: &str) -> String {
    match crate::forge::RepositoryUrlParser::parse(app_id) {
        Some(coord) if !coord.owner.is_empty() && !coord.repo.is_empty() => {
            let safe_o = sanitize_icon_segment(&coord.owner);
            let safe_r = sanitize_icon_segment(&coord.repo);
            if !safe_o.is_empty() && !safe_r.is_empty() {
                format!("{}_{}", safe_o, safe_r)
            } else {
                fallback_icon_stem(app_id, remote_url)
            }
        }
        _ => fallback_icon_stem(app_id, remote_url),
    }
}

/// B3-G11 标识解析 SSOT：回退亦先经 `canonical_app_id`（内部即 parse）归一化，不手写 split_once；
/// canonical 可解析时按 owner_repo 语义组 stem，避免 '/' 被消毒吞掉；否则消毒原始 id；全空则哈希 remote_url。
fn fallback_icon_stem(app_id: &str, remote_url: &str) -> String {
    if let Some(canon) = crate::forge::canonical_app_id(app_id) {
        if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&canon) {
            if !coord.owner.is_empty() && !coord.repo.is_empty() {
                let safe_o = sanitize_icon_segment(&coord.owner);
                let safe_r = sanitize_icon_segment(&coord.repo);
                if !safe_o.is_empty() && !safe_r.is_empty() {
                    return format!("{}_{}", safe_o, safe_r);
                }
            }
        }
        let safe_canon = sanitize_icon_segment(&canon);
        if !safe_canon.is_empty() {
            return safe_canon;
        }
    }
    let safe_id = sanitize_icon_segment(app_id);
    if safe_id.is_empty() {
        let hash = crate::sha256_digest_hex(remote_url.as_bytes());
        hash[..16].to_string()
    } else {
        safe_id
    }
}

/// 图标缓存路径：canonical id 解析出 owner/repo 命名空间时使用 `{owner}_{repo}.{ext}`，
/// 否则以消毒后的 id 命名；id 完全不可用时回退 remote_url 哈希。
/// 后缀根据 remote_url 路径推断；若无有效后缀，暂定 png，下载后按内容纠正。
/// 仅测试调用（`commands::tests`），生产代码无调用（生产内联 stem+推断后缀逻辑）；
/// 删除会破坏测试编译，故保留签名（回滚线），非 test 构建下允许死代码，保持 `cargo check` 零警告。
#[allow(dead_code)]
pub(crate) fn get_icon_cache_path(app_id: &str, remote_url: &str) -> std::path::PathBuf {
    let icons_dir = crate::get_app_data_dir().join("icons");
    let ext = infer_icon_ext_from_url(remote_url).unwrap_or("png");
    let stem = get_icon_stem(app_id, remote_url);
    icons_dir.join(format!("{}.{}", stem, ext))
}

/// H2：图标拉取专用 HTTP 客户端（超时 + 有限重定向，委托 `forge::http` SSOT，与 API client 隔离）。
pub(crate) fn icon_http_client() -> reqwest::Client {
    let secs = crate::config::get_project_config()
        .network
        .api_timeout_seconds;
    crate::forge::http::new_icon_client(secs).unwrap_or_default()
}

/// 图标下载与校验通用 helper（支持镜像重写、超时重试、格式与非空校验）。
pub async fn download_icon_bytes(
    client: &reqwest::Client,
    mirror_url: Option<&str>,
    url: &str,
) -> Result<Vec<u8>, String> {
    let url_trimmed = url.trim();
    if url_trimmed.is_empty() {
        return Err("图标链接不能为空".into());
    }

    let mut candidate_urls = Vec::new();
    if let Some(m) = mirror_url {
        let m_trimmed = m.trim();
        if !m_trimmed.is_empty() && m_trimmed != url_trimmed {
            candidate_urls.push(m_trimmed.to_string());
        }
    }
    candidate_urls.push(url_trimmed.to_string());

    let mut last_err = String::new();
    let icon_req = crate::z_log::new_req_id();
    let icon_sid = crate::z_log::new_session_id();
    let raw_icon_url = crate::log_support::sanitize_url(url_trimmed);

    for candidate in candidate_urls {
        let safe_url = crate::log_support::sanitize_url(&candidate);
        let icon_host = crate::log_support::host_of(&candidate);
        let is_mirror = candidate != url_trimmed;
        log::debug!(
            "http get icon sid={} req={} url='{}' mirror={}",
            icon_sid,
            icon_req,
            safe_url,
            is_mirror
        );
        let start_icon = std::time::Instant::now();
        match client
            .get(&candidate)
            .headers(crate::forge::http::icon_headers())
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes().await {
                        if !bytes.is_empty() && is_valid_image(&bytes) {
                            log::debug!(
                                "http resp icon ok sid={} req={} url='{}' status={} bytes={} elapsed_ms={}",
                                icon_sid,
                                icon_req,
                                safe_url,
                                status,
                                bytes.len(),
                                start_icon.elapsed().as_millis()
                            );
                            log::info!(
                                "http resp icon ok sid={} req={} host={} status={} bytes={} raw_url='{}' effective_url='{}' mirror={} elapsed_ms={}",
                                icon_sid,
                                icon_req,
                                icon_host,
                                status,
                                bytes.len(),
                                raw_icon_url,
                                safe_url,
                                is_mirror,
                                start_icon.elapsed().as_millis()
                            );
                            return Ok(bytes.to_vec());
                        } else if bytes.is_empty() {
                            last_err = "响应内容为空".to_string();
                        } else {
                            last_err = "响应内容不是有效图片格式".to_string();
                        }
                    } else {
                        last_err = "读取响应内容失败".to_string();
                    }
                } else {
                    log::debug!(
                        "http resp icon fail sid={} req={} url='{}' status={} elapsed_ms={}",
                        icon_sid,
                        icon_req,
                        safe_url,
                        status,
                        start_icon.elapsed().as_millis()
                    );
                    last_err = format!("HTTP 状态码: {}", resp.status());
                }
            }
            Err(e) => {
                log::debug!(
                    "http resp icon err sid={} req={} host={} reason={} elapsed_ms={}",
                    icon_sid,
                    icon_req,
                    icon_host,
                    crate::log_support::short_reason(&e.to_string()),
                    start_icon.elapsed().as_millis()
                );
                last_err = format!("请求失败: {}", e);
            }
        }
    }

    log::info!(
        "http resp icon fail sid={} req={} host={} raw_url='{}' reason={}",
        icon_sid,
        icon_req,
        crate::log_support::host_of(url_trimmed),
        raw_icon_url,
        crate::log_support::short_reason(&last_err)
    );
    Err(format!("拉取远程图标失败 ({}): {}", url_trimmed, last_err))
}

#[tauri::command]
pub async fn get_or_fetch_icon(
    state: State<'_, AppState>,
    app_id: Option<String>,
    remote_url: String,
) -> crate::AppResult<String> {
    let url_trimmed = remote_url.trim();
    if url_trimmed.is_empty() {
        return Err("图标链接不能为空".into());
    }

    if url_trimmed.starts_with("data:") {
        return Ok(url_trimmed.to_string());
    }

    let icons_dir = crate::get_app_data_dir().join("icons");
    if !icons_dir.exists() {
        let _ = std::fs::create_dir_all(&icons_dir);
    }

    let stem = get_icon_stem(app_id.as_deref().unwrap_or(""), url_trimmed);
    let inferred_ext = infer_icon_ext_from_url(url_trimmed).unwrap_or("png");

    let is_cataloged = app_id.as_deref().map_or(false, |id| {
        state.catalog.get_catalog_item(id.trim()).is_some()
    });

    // 1. 严格优先查找本地内部缓存（两表分流读取收敛至共享 helper）
    // 收录应用查 icon_cache_meta，非收录应用查 app_icon_cycles
    if let Ok(db) = state.db() {
        let noncatalog_cycle = if is_cataloged {
            None
        } else {
            app_id
                .as_deref()
                .and_then(|id| db.get_icon_cycle(id).ok().flatten())
        };
        if let Some(bytes) = icons_cycle::load_split_cached_bytes(
            &icons_dir,
            &db,
            &stem,
            inferred_ext,
            url_trimmed,
            is_cataloged,
            noncatalog_cycle.as_ref(),
        ) {
            return Ok(bytes_to_data_uri(&bytes));
        }
    }

    // 2. 本地缓存找不到或已过期，才去外部链接拉取
    let client = icon_http_client();
    let mirror_url = icons_cycle::mirror_url_for(&state, url_trimmed);

    let fetched_bytes = download_icon_bytes(&client, mirror_url.as_deref(), url_trimmed)
        .await
        .ok();

    let bytes = match fetched_bytes {
        Some(b) => b,
        _ => {
            // 缓存缺失且直取失败：匿名兜底探测（收敛至共享 helper，无 token 免鉴权级）。
            // 命中后按原请求缓存（文件存替代字节、DB 记录原 URL），后续同请求零网络命中。
            let raw_id = app_id.as_deref().unwrap_or("");
            let mut probe_bytes = None;
            if let Some(c) = crate::forge::RepositoryUrlParser::parse(raw_id) {
                if !c.owner.is_empty() && !c.repo.is_empty() {
                    probe_bytes =
                        icons_cycle::fetch_anon_probe_bytes(&client, &state, raw_id, &c.owner, &c.repo)
                            .await;
                }
            }
            match probe_bytes {
                Some(b) => b,
                None => {
                    return Err(format!("拉取远程图标失败 ({})", url_trimmed).into());
                }
            }
        }
    };

    // 3. 两表分流落盘（收敛至共享 helper；语义与原内联分支一致）：
    // icon_cache_meta 只写收录应用；非收录走 app_icon_cycles（文件复用 icons/ 目录，文件名带 _l{level} 后缀隔离）。
    let mime = detect_image_mime(&bytes);
    let real_ext = mime_to_ext(mime);
    let db_opt = state.db().ok();

    if is_cataloged {
        icons_cycle::persist_catalog_icon(
            &icons_dir,
            db_opt.as_ref().map(|v| &**v),
            &stem,
            real_ext,
            inferred_ext,
            url_trimmed,
            &bytes,
        );
    } else {
        let clean_id = app_id.as_deref().map(str::trim).unwrap_or("");
        let final_filename = if !clean_id.is_empty() {
            if let Some(ref db) = db_opt {
                let mut cycle = icons_cycle::load_or_new_cycle(db, clean_id);
                cycle.is_cataloged = false;

                // url 写入首个空的 l2/l3/l4，不写 l1_url
                let actual_level =
                    crate::db::icon_cycle::claim_cycle_url_slot(&mut cycle, url_trimmed);

                let filename =
                    crate::db::icon_cycle::cycle_filename(&stem, actual_level, real_ext);
                crate::db::icon_cycle::seal_cycle_selection(
                    &mut cycle,
                    actual_level,
                    url_trimmed,
                    filename.clone(),
                );
                let _ = db.upsert_icon_cycle(&cycle);

                filename
            } else {
                crate::db::icon_cycle::cycle_filename(&stem, 2, real_ext)
            }
        } else {
            crate::db::icon_cycle::cycle_filename(&stem, 2, real_ext)
        };

        let final_cache_file = icons_dir.join(&final_filename);
        let _ = std::fs::write(&final_cache_file, &bytes);
    }

    Ok(bytes_to_data_uri(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_image_detection() {
        assert!(is_valid_image(b"\x89PNG\r\n\x1a\n12345678"));
        assert!(is_valid_image(b"GIF89a12345"));
        assert!(is_valid_image(b"GIF87a12345"));
        assert!(is_valid_image(&[0xff, 0xd8, 0xff, 0x00, 0x11]));
        assert!(is_valid_image(b"RIFF\x00\x00\x00\x00WEBPVP8 ..."));
        assert!(is_valid_image(&[0x00, 0x00, 0x01, 0x00, 0x01]));
        assert!(is_valid_image(b"BM12345678"));
        assert!(is_valid_image(b"<svg viewBox='0 0 100 100'></svg>"));
        assert!(is_valid_image(b"<?xml version='1.0'?><svg></svg>"));
        assert!(is_valid_image(b"\xef\xbb\xbf<svg></svg>"));

        assert!(!is_valid_image(b""));
        assert!(!is_valid_image(b"<!DOCTYPE html><html><body>404 Not Found</body></html>"));
        assert!(!is_valid_image(b"{\"message\":\"Not Found\"}"));
        assert!(!is_valid_image(b"Hello World"));
    }

    #[test]
    fn test_bytes_to_data_uri() {
        let png_bytes = b"\x89PNG\r\n\x1a\n";
        let uri = bytes_to_data_uri(png_bytes);
        assert!(uri.starts_with("data:image/png;base64,"));

        let svg_bytes = b"<svg></svg>";
        let svg_uri = bytes_to_data_uri(svg_bytes);
        assert!(svg_uri.starts_with("data:image/svg+xml;base64,"));
    }
}
