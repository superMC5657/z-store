//! 图片嗅探唯一来源：魔数嗅探 + 扩展名白名单 + 落盘推断合一。
//!
//! 口径（单测锁定）：
//! - bmp 纳入嗅探 + 白名单 + 落盘；
//! - apng 归一为 png（与 `image/apng → png` 别名一致）；
//! - 未知回退为 `image/png`。

/// URL 扩展名白名单：无后缀放行到下载时验字节，有后缀仅此表通过。
/// `apng` 允许但推断时归一为 `png`（见 [`infer_ext_from_url`]）。
pub const IMAGE_EXT_WHITELIST: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp", "apng",
];

/// 字节前缀魔数对照：所有前缀魔数只在此一处定义。
const MAGIC_PREFIXES: &[(&[u8], &str)] = &[
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x00\x00\x01\x00", "image/x-icon"),
    (b"BM", "image/bmp"),
];

/// 由 [`MAGIC_PREFIXES`] 及容器/文本分支嗅探 MIME；未知返回 `None`（调用方决定回退）。
/// - WEBP：`RIFF....WEBP`（偏移 8 处 4 字节，需 len > 12）；
/// - AVIF：`....ftypavif/avis`（偏移 4/8，需 len >= 12）；
/// - SVG：去 UTF-8 BOM + 跳过前导 ASCII 空白后，以 `<?xml` / `<svg` 开头。
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
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

/// 嗅探失败回退 `image/png`（调用方无需判空）。
pub fn detect_image_mime(bytes: &[u8]) -> &'static str {
    sniff_image_mime(bytes).unwrap_or("image/png")
}

/// 受支持的图片字节校验：非空且魔数可识别（含 bmp）。
pub fn is_valid_image(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    sniff_image_mime(bytes).is_some()
}

/// mime 到扩展名的单一对照表（规范对）；别名显式分支。
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

/// MIME 转落盘扩展名：`Content-Type` 参数截断 + 小写归一；
/// 别名 `image/apng → png`、`image/vnd.microsoft.icon → ico`、`image/jpg → jpg`；
/// 未知回退 `png`。
pub fn mime_to_ext(mime: &str) -> &'static str {
    let base = mime.split(';').next().unwrap_or(mime);
    let clean = base.trim().to_ascii_lowercase();
    if clean == "image/apng" {
        return "png";
    }
    if clean == "image/vnd.microsoft.icon" {
        return "ico";
    }
    if clean == "image/jpg" {
        return "jpg";
    }
    for (m, e) in MIME_EXT_TABLE {
        if clean.as_str() == *m {
            return e;
        }
    }
    "png"
}

/// 地址 path 末段原始扩展名（小写）：无点/空返回 `None`。
pub fn url_path_ext(url: &str) -> Option<String> {
    let path = if let Ok(parsed) = reqwest::Url::parse(url) {
        parsed.path().to_string()
    } else {
        let no_hash = url.split('#').next().unwrap_or(url);
        no_hash.split('?').next().unwrap_or(no_hash).to_string()
    };
    let segment = path.rsplit('/').next().unwrap_or("");
    let dot = segment.rfind('.')?;
    let ext = segment[dot + 1..].trim().to_ascii_lowercase();
    if ext.is_empty() {
        return None;
    }
    Some(ext)
}

/// 扩展名白名单：无后缀放行到下载时验字节，有后缀仅白名单通过（含 bmp/apng）。
pub fn url_ext_allowed(url: &str) -> bool {
    match url_path_ext(url) {
        None => true,
        Some(ext) => IMAGE_EXT_WHITELIST.contains(&ext.as_str()),
    }
}

/// 地址后缀推断落盘扩展名：后缀优先（`jpeg → jpg`、`apng → png`），
/// 无后缀或非白名单返回 `None`（调用方回退 content-type 映射或默认 `png`）。
pub fn infer_ext_from_url(url: &str) -> Option<&'static str> {
    let raw = url.trim();
    if raw.is_empty() {
        return None;
    }
    let path = if let Ok(parsed) = reqwest::Url::parse(raw) {
        parsed.path().to_string()
    } else {
        let no_hash = raw.split('#').next().unwrap_or(raw);
        no_hash.split('?').next().unwrap_or(no_hash).to_string()
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
        "bmp" => Some("bmp"),
        "apng" => Some("png"),
        _ => None,
    }
}

/// 落盘扩展名：魔数优先，缺失时从 content-type 推断，未知回退 `png`。
pub fn resolve_ext(bytes: &[u8], content_type: &str) -> &'static str {
    if let Some(mime) = sniff_image_mime(bytes) {
        return mime_to_ext(mime);
    }
    let base = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if base.starts_with("image/") {
        return mime_to_ext(base.as_str());
    }
    "png"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bmp_supported_everywhere() {
        assert_eq!(sniff_image_mime(b"BM12345678"), Some("image/bmp"));
        assert!(is_valid_image(b"BM12345678"));
        assert_eq!(mime_to_ext("image/bmp"), "bmp");
        assert_eq!(infer_ext_from_url("https://example.com/a.bmp"), Some("bmp"));
        assert!(url_ext_allowed("https://example.com/a.bmp"));
        assert_eq!(resolve_ext(b"BMxx", ""), "bmp");
    }

    #[test]
    fn apng_normalized_to_png() {
        assert_eq!(mime_to_ext("image/apng"), "png");
        assert_eq!(mime_to_ext("image/apng; charset=utf-8"), "png");
        assert_eq!(infer_ext_from_url("https://example.com/a.apng"), Some("png"));
        assert!(url_ext_allowed("https://example.com/a.apng"));
    }

    #[test]
    fn whitelist_and_fallback_locked() {
        assert!(url_ext_allowed("https://example.com/a.png"));
        assert!(url_ext_allowed("https://example.com/a.jpeg"));
        assert!(url_ext_allowed("https://example.com/noext"));
        assert!(!url_ext_allowed("https://example.com/a.mp4"));
        assert!(!url_ext_allowed("https://example.com/a.exe"));
        assert_eq!(mime_to_ext("application/octet-stream"), "png");
        assert_eq!(resolve_ext(b"not-an-image", ""), "png");
        assert_eq!(mime_to_ext("image/jpeg"), "jpg");
        assert_eq!(infer_ext_from_url("https://example.com/x.jpeg"), Some("jpg"));
        assert!(!is_valid_image(b""));
        assert!(!is_valid_image(b"<!DOCTYPE html><html>404</html>"));
    }

    #[test]
    fn magic_branches_preserved() {
        assert_eq!(sniff_image_mime(b"\x89PNG\r\n\x1a\n12345678"), Some("image/png"));
        assert_eq!(sniff_image_mime(b"GIF89a12345"), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"GIF87a12345"), Some("image/gif"));
        assert_eq!(sniff_image_mime(&[0xff, 0xd8, 0xff, 0x00, 0x11]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(&[0x00, 0x00, 0x01, 0x00, 0x01]), Some("image/x-icon"));
        assert_eq!(sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 ..."), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"<svg viewBox='0 0 100 100'></svg>"), Some("image/svg+xml"));
        assert_eq!(sniff_image_mime(b"<?xml version='1.0'?><svg></svg>"), Some("image/svg+xml"));
        assert_eq!(sniff_image_mime(b"\xef\xbb\xbf<svg></svg>"), Some("image/svg+xml"));
        assert_eq!(sniff_image_mime(b"Hello World"), None);
        assert_eq!(detect_image_mime(b"Hello World"), "image/png");
    }
}
