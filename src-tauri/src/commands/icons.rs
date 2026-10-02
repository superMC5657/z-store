use crate::AppState;
use tauri::State;

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

pub(crate) const SUPPORTED_ICON_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "apng", "bmp",
];

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
    (u.contains("github.com/") && u.ends_with(".png"))
        || u.contains("avatars.githubusercontent.com")
        || u.contains("identicons.github.com")
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
/// 后缀根据 remote_url 路径推断；若无有效后缀，默认 .png 兼容旧缓存。
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
fn icon_http_client() -> reqwest::Client {
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

    // 1. 严格优先查找本地内部缓存！
    // 缓存校验（缺一即视为未命中，转网络重拉）：
    // a. 本地图片文件必须存在且非空；优先精确路径，若不存在则在 icons/ 目录下按同 stem 候选后缀查找（兼容旧 .png）；
    // b. 数据库中必有同 stem 或对应缓存键的记录，且记录的 remote_url 与当前请求的 url_trimmed 一致；
    //    无记录或记录不一致时强制触发网络重新拉取并刷新入库。
    let mut candidate_filenames = Vec::with_capacity(SUPPORTED_ICON_EXTENSIONS.len());
    candidate_filenames.push(format!("{}.{}", stem, inferred_ext));
    for &ext in SUPPORTED_ICON_EXTENSIONS {
        if ext != inferred_ext {
            let name = format!("{}.{}", stem, ext);
            if !candidate_filenames.contains(&name) {
                candidate_filenames.push(name);
            }
        }
    }

    if let Ok(db) = state.db() {
        for cand_name in &candidate_filenames {
            let cand_file = icons_dir.join(cand_name);
            if cand_file.is_file() {
                if let Ok(meta) = std::fs::metadata(&cand_file) {
                    if meta.len() > 0 {
                        let mut db_match = false;
                        if let Ok(Some(recorded_url)) = db.get_icon_cache_url(cand_name) {
                            if recorded_url.trim() == url_trimmed {
                                db_match = true;
                            }
                        }
                        if !db_match {
                            for other_name in &candidate_filenames {
                                if other_name != cand_name {
                                    if let Ok(Some(rec)) = db.get_icon_cache_url(other_name) {
                                        if rec.trim() == url_trimmed {
                                            db_match = true;
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        if db_match {
                            if let Ok(bytes) = std::fs::read(&cand_file) {
                                let mime = detect_image_mime(&bytes);
                                let b64 = base64_encode(&bytes);
                                return Ok(format!("data:{};base64,{}", mime, b64));
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. 本地缓存找不到或已过期，才去外部链接拉取

    let mut candidate_urls = Vec::new();
    if !is_avatar {
        if let Ok(mirror) = state.mirror.lock() {
            let rewritten = mirror.rewrite_download_url(url_trimmed);
            if rewritten != url_trimmed {
                candidate_urls.push(rewritten);
            }
        }
    }
    candidate_urls.push(url_trimmed.to_string());

    let client = icon_http_client();

    let mut fetched_bytes = None;
    let mut last_err = String::new();
    let icon_req = crate::z_log::new_req_id();
    let icon_sid = crate::z_log::new_session_id();
    let raw_icon_url = crate::log_support::sanitize_url(url_trimmed);

    for url in candidate_urls {
        let safe_url = crate::log_support::sanitize_url(&url);
        let icon_host = crate::log_support::host_of(&url);
        let is_mirror = url != url_trimmed;
        log::debug!(
            "http get icon sid={} req={} url='{}' mirror={}",
            icon_sid,
            icon_req,
            safe_url,
            is_mirror
        );
        let start_icon = std::time::Instant::now();
        match client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes().await {
                        if !bytes.is_empty() {
                            log::debug!("http resp icon ok sid={} req={} url='{}' status={} bytes={} elapsed_ms={}", icon_sid, icon_req, safe_url, status, bytes.len(), start_icon.elapsed().as_millis());
                            log::info!("http resp icon ok sid={} req={} host={} status={} bytes={} raw_url='{}' effective_url='{}' mirror={} elapsed_ms={}", icon_sid, icon_req, icon_host, status, bytes.len(), raw_icon_url, safe_url, is_mirror, start_icon.elapsed().as_millis());
                            fetched_bytes = Some(bytes);
                            break;
                        }
                    }
                } else {
                    log::debug!("http resp icon fail sid={} req={} url='{}' status={} elapsed_ms={}", icon_sid, icon_req, safe_url, status, start_icon.elapsed().as_millis());
                    last_err = format!("HTTP 状态码: {}", resp.status());
                }
            }
            Err(e) => {
                log::debug!("http resp icon err sid={} req={} host={} reason={} elapsed_ms={}", icon_sid, icon_req, icon_host, crate::log_support::short_reason(&e.to_string()), start_icon.elapsed().as_millis());
                last_err = format!("请求失败: {}", e);
            }
        }
    }

    let bytes = fetched_bytes.ok_or_else(|| {
        log::info!(
            "http resp icon fail sid={} req={} host={} raw_url='{}' reason={}",
            icon_sid,
            icon_req,
            crate::log_support::host_of(url_trimmed),
            raw_icon_url,
            crate::log_support::short_reason(&last_err)
        );
        format!("拉取远程图标失败 ({}): {}", url_trimmed, last_err)
    })?;

    // 3. 缓存在用户的配置目录里 (icons/)，同时持久化元数据至 SQLite 数据库
    // 写入时先按 URL 推断的路径写，写完后用 detect_image_mime 校核，若扩展名与内容不符（如 URL 无后缀或说谎），
    // 重命名为正确后缀文件并删除旧 .png 遗留，DB 的 cache_key 更新为最终文件名（清理旧 key 并保存）。
    let initial_filename = format!("{}.{}", stem, inferred_ext);
    let initial_cache_file = icons_dir.join(&initial_filename);
    let _ = std::fs::write(&initial_cache_file, &bytes);

    let mime = detect_image_mime(&bytes);
    let real_ext = mime_to_ext(mime);
    let final_filename = format!("{}.{}", stem, real_ext);
    let final_cache_file = icons_dir.join(&final_filename);

    if final_cache_file != initial_cache_file {
        if final_cache_file.exists() {
            let _ = std::fs::remove_file(&final_cache_file);
        }
        if std::fs::rename(&initial_cache_file, &final_cache_file).is_err() {
            let _ = std::fs::write(&final_cache_file, &bytes);
            let _ = std::fs::remove_file(&initial_cache_file);
        }
    }

    // 若最终格式不是 png，删除可能存在的旧 .png 遗留文件
    let old_png_filename = format!("{}.png", stem);
    if old_png_filename != final_filename {
        let old_png_path = icons_dir.join(&old_png_filename);
        if old_png_path.exists() {
            let _ = std::fs::remove_file(&old_png_path);
        }
    }

    if let Ok(db) = state.db() {
        if initial_filename != final_filename {
            let _ = db.delete_icon_cache_url(&initial_filename);
        }
        if old_png_filename != final_filename {
            let _ = db.delete_icon_cache_url(&old_png_filename);
        }
        let _ = db.save_icon_cache_url(&final_filename, url_trimmed);
    }

    let mime = detect_image_mime(&bytes);
    let b64 = base64_encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}
