//! 业务日志公共辅助：host 脱敏 / 首行截断 / basename（chars 边界安全）。
//!
//! - `host_of`：只取 host（小写），未知返回 `unknown`；永不返回完整 URL/query。
//! - `short_reason`：取首行并按 chars 截断 160，避免多行 body 与宽字符切半。
//! - `file_base`：只取 basename（兼容 `/` 与 `\`），永不返回全路径。
//! - `http_err_reason`：reqwest 0.12 `Display` 会回显完整 URL（含 release
//!   资产签名 query），必须先剥离 URL 再取首行；不跨仓，自写。

/// 取 URL 的 host（小写）；解析失败返回 `unknown`。
pub fn host_of(url: &str) -> String {
    let s = url.trim();
    let after = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => s,
    };
    let end = after
        .find(['/', '?', '#'])
        .unwrap_or(after.len());
    let mut hostport = &after[..end];
    if let Some(at) = hostport.rfind('@') {
        hostport = &hostport[at + 1..];
    }
    let host: &str = if hostport.starts_with('[') {
        match hostport.find(']') {
            Some(e) => &hostport[..=e],
            None => hostport,
        }
    } else {
        match hostport.find(':') {
            Some(i) => &hostport[..i],
            None => hostport,
        }
    };
    let h = host.trim().trim_matches('.').to_lowercase();
    if h.is_empty() {
        "unknown".to_string()
    } else {
        h
    }
}

/// URL 脱敏与安全日志格式化：
/// 1. 保留完整协议、Host、端口与 Path 路径（例如 `https://api.github.com/repos/7zip/7zip/releases/latest`
///    或带镜像前缀的 `https://ghproxy.net/https://github.com/...`）；
/// 2. 对 Query 参数进行敏感词脱敏（如 token, signature, sig, key, secret, x-amz-*, credential 等）；
/// 3. 保留非敏感查询参数（如 `q=...`, `per_page=...`, `sort=...`），便于排查搜索与过滤请求。
pub fn sanitize_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let (base, query_part) = match trimmed.find('?') {
        Some(pos) => (&trimmed[..pos], Some(&trimmed[pos + 1..])),
        None => (trimmed, None),
    };

    let Some(query) = query_part else {
        return base.to_string();
    };

    if query.trim().is_empty() {
        return format!("{}?", base);
    }

    let is_sensitive_key = |key: &str| -> bool {
        let k = key.to_ascii_lowercase();
        k.contains("token")
            || k.contains("secret")
            || k.contains("sig")
            || k.contains("key")
            || k.contains("auth")
            || k.contains("credential")
            || k.contains("pass")
            || k.starts_with("x-amz-")
            || k.starts_with("x-goog-")
            || k.starts_with("x-ms-")
    };

    let mut sanitized_params = Vec::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        if let Some((k, _v)) = pair.split_once('=') {
            if is_sensitive_key(k) {
                sanitized_params.push(format!("{}=***", k));
            } else {
                sanitized_params.push(pair.to_string());
            }
        } else if is_sensitive_key(pair) {
            sanitized_params.push(format!("{}=***", pair));
        } else {
            sanitized_params.push(pair.to_string());
        }
    }

    let joined = sanitized_params.join("&");
    format!("{}?{}", base, joined)
}

/// 取首行并按 chars 截断至 160（字符边界安全）。
pub fn short_reason(msg: &str) -> String {
    let first = msg.lines().next().unwrap_or("").trim();
    if first.chars().count() <= 160 {
        first.to_string()
    } else {
        first.chars().take(160).collect()
    }
}

/// 只取 basename（兼容 `/` 与 `\`）；为空时回退 `package.bin`。
pub fn file_base(p: &str) -> String {
    let normalized = p.replace('\\', "/");
    let base = normalized.rsplit('/').next().unwrap_or("").trim();
    if base.is_empty() {
        return "package.bin".to_string();
    }
    base.chars().take(80).collect()
}

/// reqwest 错误脱敏：剥离完整 URL（含签名 query）后取首行。
/// 返回已脱敏短原因，调用方另用 `host_of` 记 host。
pub fn http_err_reason(e: &reqwest::Error) -> String {
    let raw = e.to_string();
    let cleaned = match e.url() {
        Some(u) => {
            let us = u.as_str();
            let host = host_of(us);
            raw.replacen(us, &format!("<{}>", host), 1)
        }
        None => raw,
    };
    // 纵深：若 Display 仍内嵌其他 http(s) URL，截掉其 query 部分。
    // 游标向后扫：已脱敏（`<?>` 结尾）或无 query 的 URL 原样跳过，避免空转。
    let mut out = cleaned;
    for prefix in ["https://", "http://"] {
        let mut search_from = 0;
        while let Some(rel) = out[search_from..].find(prefix) {
            let pos = search_from + rel;
            let rest = &out[pos..];
            let url_end = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')')
                .map(|i| pos + i)
                .unwrap_or(out.len());
            let url_slice = &out[pos..url_end];
            if url_slice.ends_with("?>") || !url_slice.contains('?') {
                search_from = url_end;
                continue;
            }
            let q = url_slice.find('?').unwrap();
            let replacement = format!("{}<?>", &url_slice[..q]);
            out.replace_range(pos..url_end, &replacement);
            search_from = pos + replacement.len();
        }
    }
    short_reason(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_host_of_strips_signed_query() {
        let url = "https://objects.githubusercontent.com/abc/file.msi?X-Amz-Signature=deadbeef&token=123";
        assert_eq!(
            host_of(url),
            "objects.githubusercontent.com"
        );
        assert_eq!(host_of("not a url :::"), "not a url");
        assert_eq!(host_of(""), "unknown");
    }

    #[test]
    fn test_short_reason_first_line_chars_safe() {
        let s = "第一行错误\n第二行body不应出现";
        assert_eq!(short_reason(s), "第一行错误");
        let long_cn: String = std::iter::repeat('汉').take(200).collect();
        assert_eq!(short_reason(&long_cn).chars().count(), 160);
    }

    #[test]
    fn test_file_base_never_full_path() {
        assert_eq!(file_base("C:\\Temp\\a\\setup.exe"), "setup.exe");
        assert_eq!(file_base("/tmp/dl/pkg.msi"), "pkg.msi");
        assert_eq!(file_base(""), "package.bin");
    }

    #[test]
    fn test_sanitize_url() {
        assert_eq!(
            sanitize_url("https://api.github.com/repos/7zip/7zip/releases/latest"),
            "https://api.github.com/repos/7zip/7zip/releases/latest"
        );
        assert_eq!(
            sanitize_url("https://api.github.com/search/repositories?q=rust&sort=stars&order=desc"),
            "https://api.github.com/search/repositories?q=rust&sort=stars&order=desc"
        );
        assert_eq!(
            sanitize_url("https://objects.githubusercontent.com/file.msi?X-Amz-Signature=deadbeef&token=123&normal=abc"),
            "https://objects.githubusercontent.com/file.msi?X-Amz-Signature=***&token=***&normal=abc"
        );
        assert_eq!(
            sanitize_url("https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1.0/app.exe"),
            "https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1.0/app.exe"
        );
        assert_eq!(sanitize_url(""), "");
    }
}
