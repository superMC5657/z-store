use crate::AppState;
use tauri::State;

const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
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

pub fn detect_image_mime(bytes: &[u8]) -> &'static str {
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

/// 图标缓存文件名消毒：仅保留字母数字及 `-`/`_`，用于构造本地图标缓存文件名。
/// 消毒后为空时，调用方回退到基于 remote_url 的 SHA-256 哈希命名（见 icon_hash_filename）。
pub fn sanitize_icon_segment(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

pub fn is_avatar_url(url: &str) -> bool {
    let u = url.trim();
    (u.contains("github.com/") && u.ends_with(".png"))
        || u.contains("avatars.githubusercontent.com")
        || u.contains("identicons.github.com")
}

pub fn icon_hash_filename(remote_url: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(remote_url.as_bytes());
    let hash = hex::encode(hasher.finalize());
    format!("{}.png", &hash[..16])
}

/// 图标缓存路径：canonical id 解析出 owner/repo 命名空间时使用 `{owner}_{repo}.png`，
/// 否则以消毒后的 id 命名；id 完全不可用时回退 remote_url 哈希。
pub fn get_icon_cache_path(app_id: &str, remote_url: &str) -> std::path::PathBuf {
    let icons_dir = crate::get_app_data_dir().join("icons");
    let filename = match crate::forge::RepositoryUrlParser::parse(app_id) {
        Some(coord) if !coord.owner.is_empty() && !coord.repo.is_empty() => {
            let safe_o = sanitize_icon_segment(&coord.owner);
            let safe_r = sanitize_icon_segment(&coord.repo);
            if !safe_o.is_empty() && !safe_r.is_empty() {
                format!("{}_{}.png", safe_o, safe_r)
            } else {
                fallback_icon_filename(app_id, remote_url)
            }
        }
        _ => fallback_icon_filename(app_id, remote_url),
    };
    icons_dir.join(filename)
}

fn fallback_icon_filename(app_id: &str, remote_url: &str) -> String {
    let safe_id = sanitize_icon_segment(app_id);
    if safe_id.is_empty() {
        icon_hash_filename(remote_url)
    } else {
        format!("{}.png", safe_id)
    }
}

#[tauri::command]
pub async fn get_or_fetch_icon(
    state: State<'_, AppState>,
    app_id: Option<String>,
    remote_url: String,
) -> Result<String, String> {
    let url_trimmed = remote_url.trim();
    if url_trimmed.is_empty() {
        return Err("图标链接不能为空".to_string());
    }

    if url_trimmed.starts_with("data:") {
        return Ok(url_trimmed.to_string());
    }

    let icons_dir = crate::get_app_data_dir().join("icons");
    if !icons_dir.exists() {
        let _ = std::fs::create_dir_all(&icons_dir);
    }

    let cache_file = get_icon_cache_path(app_id.as_deref().unwrap_or(""), url_trimmed);

    let cache_key = cache_file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();

    let is_avatar = is_avatar_url(url_trimmed);

    // 1. 严格优先查找本地内部缓存！
    // 缓存校验：
    // a. 本地图片文件必须存在且非空；
    // b. 数据库中记录的 remote_url 与当前请求的 url_trimmed 一致；
    // c. 若数据库中尚无记录（例如老版本升级前遗留的历史缓存文件）：
    //    若当前请求为头像，允许命中本地已有缓存并顺带入库；
    //    若当前请求为已升级的官方独立图标（非头像），则视为旧版头像缓存过期，强制触发网络重新拉取！
    let db_cached_url = if !cache_key.is_empty() {
        state
            .db
            .lock()
            .ok()
            .and_then(|db| db.get_icon_cache_url(&cache_key).ok().flatten())
    } else {
        None
    };

    let cache_valid = if cache_file.is_file() {
        if let Some(ref recorded_url) = db_cached_url {
            recorded_url.trim() == url_trimmed
        } else {
            is_avatar
        }
    } else {
        false
    };

    if cache_valid {
        if let Ok(meta) = std::fs::metadata(&cache_file) {
            if meta.len() > 0 {
                if let Ok(bytes) = std::fs::read(&cache_file) {
                    if db_cached_url.is_none() && !cache_key.is_empty() {
                        if let Ok(db) = state.db.lock() {
                            let _ = db.save_icon_cache_url(&cache_key, url_trimmed);
                        }
                    }
                    let mime = detect_image_mime(&bytes);
                    let b64 = base64_encode(&bytes);
                    return Ok(format!("data:{};base64,{}", mime, b64));
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

    let api_timeout = std::time::Duration::from_secs(
        crate::config::get_project_config().network.api_timeout_seconds,
    );
    let client = reqwest::Client::builder()
        .timeout(api_timeout)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut fetched_bytes = None;
    let mut last_err = String::new();

    for url in candidate_urls {
        let safe_url = crate::log_support::sanitize_url(&url);
        log::debug!("http get icon url='{}'", safe_url);
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
                            log::debug!("http resp icon ok url='{}' status={} bytes={} elapsed_ms={}", safe_url, status, bytes.len(), start_icon.elapsed().as_millis());
                            fetched_bytes = Some(bytes);
                            break;
                        }
                    }
                } else {
                    last_err = format!("HTTP 状态码: {}", resp.status());
                }
            }
            Err(e) => {
                last_err = format!("请求失败: {}", e);
            }
        }
    }

    let bytes = fetched_bytes.ok_or_else(|| {
        format!("拉取远程图标失败 ({}): {}", url_trimmed, last_err)
    })?;

    // 3. 缓存在用户的配置目录里 (icons/)，同时持久化元数据至 SQLite 数据库
    let _ = std::fs::write(&cache_file, &bytes);
    if !cache_key.is_empty() {
        if let Ok(db) = state.db.lock() {
            let _ = db.save_icon_cache_url(&cache_key, url_trimmed);
        }
    }

    let mime = detect_image_mime(&bytes);
    let b64 = base64_encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}
