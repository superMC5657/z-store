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

pub(crate) fn detect_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        "image/x-icon"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        "image/avif"
    } else {
        // SVG 可能带有 UTF-8 BOM (\xef\xbb\xbf) 或前导空白/换行
        let trimmed = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
        let trimmed = match trimmed.iter().position(|&b| !b.is_ascii_whitespace()) {
            Some(idx) => &trimmed[idx..],
            None => trimmed,
        };
        if trimmed.starts_with(b"<?xml") || trimmed.starts_with(b"<svg") {
            "image/svg+xml"
        } else {
            "image/png"
        }
    }
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
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || (bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP")
        || bytes.starts_with(&[0x00, 0x00, 0x01, 0x00])
        || bytes.starts_with(b"BM")
        || (bytes.len() >= 12
            && &bytes[4..8] == b"ftyp"
            && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis"))
    {
        return true;
    }
    let trimmed = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let trimmed = match trimmed.iter().position(|&b| !b.is_ascii_whitespace()) {
        Some(idx) => &trimmed[idx..],
        None => trimmed,
    };
    trimmed.starts_with(b"<?xml") || trimmed.starts_with(b"<svg")
}

pub(crate) fn mime_to_ext(mime: &str) -> &'static str {
    let clean = mime.trim().to_ascii_lowercase();
    match clean.as_str() {
        "image/png" | "image/apng" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

pub(crate) fn ext_to_mime(ext: &str) -> &'static str {
    let clean = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    match clean.as_str() {
        "png" => "image/png",
        "apng" => "image/apng",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

#[allow(dead_code)]
pub(crate) fn detect_image_ext(bytes: &[u8]) -> &'static str {
    mime_to_ext(detect_image_mime(bytes))
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
/// 消毒后为空时，调用方回退到基于 remote_url 的 SHA-256 哈希命名（见 icon_hash_filename）。
pub(crate) fn sanitize_icon_segment(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

pub(crate) fn is_avatar_url(url: &str) -> bool {
    let u = url.trim();
    u.contains("avatars.githubusercontent.com") || u.contains("identicons.github.com")
}

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

fn fallback_icon_stem(app_id: &str, remote_url: &str) -> String {
    let safe_id = sanitize_icon_segment(app_id);
    if safe_id.is_empty() {
        let hash = crate::sha256_digest_hex(remote_url.as_bytes());
        hash[..16].to_string()
    } else {
        safe_id
    }
}

#[allow(dead_code)]
pub(crate) fn icon_hash_filename(remote_url: &str) -> String {
    let ext = infer_icon_ext_from_url(remote_url).unwrap_or("png");
    let hash = crate::sha256_digest_hex(remote_url.as_bytes());
    format!("{}.{}", &hash[..16], ext)
}

/// 图标缓存路径：canonical id 解析出 owner/repo 命名空间时使用 `{owner}_{repo}.{ext}`，
/// 否则以消毒后的 id 命名；id 完全不可用时回退 remote_url 哈希。
/// 后缀根据 remote_url 路径推断；若无有效后缀，暂定 png，下载后按内容纠正。
pub(crate) fn get_icon_cache_path(app_id: &str, remote_url: &str) -> std::path::PathBuf {
    let icons_dir = crate::get_app_data_dir().join("icons");
    let ext = infer_icon_ext_from_url(remote_url).unwrap_or("png");
    let stem = get_icon_stem(app_id, remote_url);
    icons_dir.join(format!("{}.{}", stem, ext))
}

#[allow(dead_code)]
fn fallback_icon_filename(app_id: &str, remote_url: &str) -> String {
    let ext = infer_icon_ext_from_url(remote_url).unwrap_or("png");
    let stem = fallback_icon_stem(app_id, remote_url);
    format!("{}.{}", stem, ext)
}

/// H2：图标拉取专用 HTTP 客户端（超时 + 有限重定向）。
pub(crate) fn icon_http_client() -> reqwest::Client {
    let api_timeout = std::time::Duration::from_secs(
        crate::config::get_project_config()
            .network
            .api_timeout_seconds,
    );
    reqwest::Client::builder()
        .timeout(api_timeout)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
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
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            .header(
                "Accept",
                "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            )
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
    let is_avatar = is_avatar_url(url_trimmed);

    let is_cataloged = app_id.as_deref().map_or(false, |id| {
        state.catalog.get_catalog_item(id.trim()).is_some()
    });

    // 1. 严格优先查找本地内部缓存！
    // 两表分流读取：收录应用查 icon_cache_meta，非收录应用查 app_icon_cycles
    if let Ok(db) = state.db() {
        if is_cataloged {
            let filename = format!("{}.{}", stem, inferred_ext);
            let cache_file = icons_dir.join(&filename);
            if cache_file.is_file() {
                if let Ok(meta) = std::fs::metadata(&cache_file) {
                    if meta.len() > 0 {
                        if let Ok(Some(recorded_url)) = db.get_icon_cache_url(&filename) {
                            if recorded_url.trim() == url_trimmed {
                                if let Ok(bytes) = std::fs::read(&cache_file) {
                                    if !bytes.is_empty() && is_valid_image(&bytes) {
                                        return Ok(bytes_to_data_uri(&bytes));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if let Some(ref id) = app_id {
            if let Ok(Some(cycle)) = db.get_icon_cycle(id) {
                if !cycle.cache_file.is_empty() && cycle.selected_url.trim() == url_trimmed {
                    let cache_file = icons_dir.join(&cycle.cache_file);
                    if cache_file.is_file() {
                        if let Ok(bytes) = std::fs::read(&cache_file) {
                            if !bytes.is_empty() && is_valid_image(&bytes) {
                                return Ok(bytes_to_data_uri(&bytes));
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. 本地缓存找不到或已过期，才去外部链接拉取
    let client = icon_http_client();
    let mirror_url = if !is_avatar {
        state.mirror.lock().ok().and_then(|m| {
            let rewritten = m.rewrite_download_url(url_trimmed);
            if rewritten != url_trimmed {
                Some(rewritten)
            } else {
                None
            }
        })
    } else {
        None
    };

    let fetched_bytes = download_icon_bytes(&client, mirror_url.as_deref(), url_trimmed)
        .await
        .ok();

    let bytes = match fetched_bytes {
        Some(b) => b,
        _ => {
            // 缓存缺失且直取失败：按图标探测逻辑找替代图标。
            // 此处无用户 token，只跑免鉴权级（Simple Icons），跳过 Trees 以保护匿名配额。
            // 命中后按原请求缓存（文件存替代字节、DB 记录原 URL），后续同请求零网络命中。
            let coord = crate::forge::RepositoryUrlParser::parse(app_id.as_deref().unwrap_or(""));
            let mut probed_url: Option<String> = None;
            if let Some(c) = coord {
                if !c.owner.is_empty() && !c.repo.is_empty() {
                    // 先拿确切默认分支（匿名一次调用，失败则退化 main/master 双试）。
                    let mut branches: Vec<String> = Vec::with_capacity(2);
                    let repo_api = format!("https://api.github.com/repos/{}/{}", c.owner, c.repo);
                    if let Ok(resp) = client.get(&repo_api).header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36").send().await {
                        if let Ok(v) = resp.json::<serde_json::Value>().await {
                            if let Some(b) = v.get("default_branch").and_then(|x| x.as_str()) {
                                branches.push(b.to_string());
                            }
                        }
                    }
                    branches.push("main".to_string());
                    branches.push("master".to_string());
                    for b in branches {
                        if let Some(p) = crate::github::icon_probe::probe_repo_logo(&client, None, &c.owner, &c.repo, &b).await {
                            log::info!("icon probe fallback hit app_id='{}' source={} url='{}'", app_id.as_deref().unwrap_or(""), p.source, crate::log_support::sanitize_url(&p.url));
                            probed_url = Some(p.url);
                            break;
                        }
                    }
                }
            }
            let mut probe_bytes = None;
            if let Some(purl) = probed_url {
                let probe_mirror = state.mirror.lock().ok().and_then(|m| {
                    let r = m.rewrite_download_url(&purl);
                    if r != purl {
                        Some(r)
                    } else {
                        None
                    }
                });
                probe_bytes = download_icon_bytes(&client, probe_mirror.as_deref(), &purl).await.ok();
            }
            match probe_bytes {
                Some(b) => b,
                None => {
                    return Err(format!("拉取远程图标失败 ({})", url_trimmed).into());
                }
            }
        }
    };

    // 3. 两表分流落盘：
    // icon_cache_meta 只写收录应用；非收录走 app_icon_cycles（文件复用 icons/ 目录，文件名带 _l{level} 后缀隔离）。
    let mime = detect_image_mime(&bytes);
    let real_ext = mime_to_ext(mime);

    if is_cataloged {
        let final_filename = format!("{}.{}", stem, real_ext);
        let final_cache_file = icons_dir.join(&final_filename);
        let _ = std::fs::write(&final_cache_file, &bytes);

        let initial_filename = format!("{}.{}", stem, inferred_ext);
        if initial_filename != final_filename {
            let initial_cache_file = icons_dir.join(&initial_filename);
            if initial_cache_file.exists() {
                let _ = std::fs::remove_file(&initial_cache_file);
            }
        }

        if let Ok(db) = state.db() {
            if initial_filename != final_filename {
                let _ = db.delete_icon_cache_url(&initial_filename);
            }
            let _ = db.save_icon_cache_url(&final_filename, url_trimmed);
        }
    } else {
        let level = if let Some(ref id) = app_id {
            state
                .db()
                .ok()
                .and_then(|db| db.get_icon_cycle(id).ok().flatten())
                .map(|c| c.level)
                .unwrap_or(1)
        } else {
            1
        };
        let final_filename = format!("{}_l{}.{}", stem, level, real_ext);
        let final_cache_file = icons_dir.join(&final_filename);
        let _ = std::fs::write(&final_cache_file, &bytes);

        if let Some(ref id) = app_id {
            let clean_id = id.trim();
            if !clean_id.is_empty() {
                if let Ok(db) = state.db() {
                    let mut cycle = db
                        .get_icon_cycle(clean_id)
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| {
                            let (owner, repo) = match crate::forge::RepositoryUrlParser::parse(clean_id) {
                                Some(c) => (c.owner, c.repo),
                                None => clean_id
                                    .split_once('/')
                                    .map(|(o, r)| (o.to_string(), r.to_string()))
                                    .unwrap_or_default(),
                            };
                            crate::db::AppIconCycle::new(clean_id, owner, repo)
                        });
                    cycle.is_cataloged = false;
                    cycle.level = level;
                    if cycle.l1_url.is_empty() {
                        cycle.l1_url = url_trimmed.to_string();
                    }
                    cycle.selected_url = url_trimmed.to_string();
                    cycle.cache_file = final_filename;
                    cycle.updated_at = crate::now_secs();
                    let _ = db.upsert_icon_cycle(&cycle);
                }
            }
        }
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
