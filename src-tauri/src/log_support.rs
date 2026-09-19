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
///    或带镜像前缀的 `https://gh-proxy.net/https://github.com/...`）；路径段永不动
///    （`vscode` 内的 `code` 子串永不触发）；
/// 2. Query 键值脱敏（query-key-only）：只看 `=` 前的键名，值含敏感词永不触发；
///    键边界镜像 Wave1（`redact_kv_values`）：起始或前一字节为 `? & ;` 才视为键，
///    此处按 `&` / `;` 切分并原样保留分隔形态；
/// 3. `code` 系精确匹配（`code` / `device_code` / `user_code` / `api_key` 系），避免
///    `vscode` 子串误杀；其余短键（`sig` / `key` / `auth` / `pass`）按分隔符分词匹配，
///    长键（`token` / `secret` / `credential` / `signature` / `password`）子串匹配；
/// 4. 保留非敏感查询参数（如 `q=...`, `per_page=...`, `sort=...`），便于排查搜索与过滤请求。
/// 全分支 ASCII 字节判定，字符边界安全，永不 panic；签名稳定（调用方 20+ 处不动）。
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
        let k = key.trim().to_ascii_lowercase();
        if k.is_empty() {
            return false;
        }
        // 精确键（含 Wave1 六键 + 常见单键）：`vscode` 等子串宿主永不命中。
        match k.as_str() {
            "code" | "device_code" | "user_code" | "api_key" | "api-key" | "apikey"
            | "token" | "secret" | "sig" | "signature" | "key" | "auth" | "credential"
            | "pass" | "password" => return true,
            _ => {}
        }
        // 长键子串：足够长，无碰撞风险。
        if k.contains("token")
            || k.contains("secret")
            || k.contains("credential")
            || k.contains("password")
            || k.contains("signature")
            || k.contains("apikey")
            || k.contains("api_key")
            || k.contains("api-key")
            || k.contains("device_code")
            || k.contains("user_code")
        {
            return true;
        }
        // 服务端签名头透传进 query 时：`x-amz-` / `x-goog-` / `x-ms-` 前缀。
        if k.starts_with("x-amz-") || k.starts_with("x-goog-") || k.starts_with("x-ms-") {
            return true;
        }
        // 短键收敛为分隔符分词匹配：`design` / `monkey` / `author` / `bypass` 不触发，
        // 而 `auth-token` / `client_key` / `my_sig` 照常脱敏。
        for part in k.split(['_', '-', '.', ':', '[', ']']) {
            if matches!(part, "sig" | "key" | "auth" | "pass") {
                return true;
            }
        }
        false
    };

    // 手工扫描：按 `&` / `;` 切分并原样保留分隔符（均为 ASCII，索引恒为字符边界）。
    let mut out = String::with_capacity(trimmed.len());
    out.push_str(base);
    out.push('?');
    let mut emitted = false;
    let mut pending_sep: Option<char> = None;
    let mut start = 0;
    loop {
        let rest = &query[start..];
        let (seg, sep, next) = match rest.find(['&', ';']) {
            Some(r) => (&rest[..r], rest.as_bytes()[r] as char, start + r + 1),
            None => (rest, '\0', query.len() + 1),
        };
        if !seg.is_empty() {
            if emitted {
                out.push(pending_sep.unwrap_or('&'));
            }
            if let Some((k, _v)) = seg.split_once('=') {
                if is_sensitive_key(k) {
                    out.push_str(k);
                    out.push_str("=***");
                } else {
                    out.push_str(seg);
                }
            } else if is_sensitive_key(seg) {
                out.push_str(seg);
                out.push_str("=***");
            } else {
                out.push_str(seg);
            }
            emitted = true;
            pending_sep = None;
        }
        if next > query.len() {
            break;
        }
        if sep != '\0' && pending_sep.is_none() {
            pending_sep = Some(sep);
        }
        start = next;
    }
    out
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

    #[test]
    fn test_sanitize_url_keeps_search_params() {
        // 搜索类非敏感参数原样保留；签名/令牌按 query-key 脱敏；gh-proxy 前缀原样保留。
        assert_eq!(
            sanitize_url("https://api.github.com/search/repositories?q=vscode&sort=stars&per_page=20"),
            "https://api.github.com/search/repositories?q=vscode&sort=stars&per_page=20"
        );
        assert_eq!(
            sanitize_url("https://objects.githubusercontent.com/file.msi?X-Amz-Signature=deadbeef&normal=abc"),
            "https://objects.githubusercontent.com/file.msi?X-Amz-Signature=***&normal=abc"
        );
        assert_eq!(
            sanitize_url("https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1.0/app.exe"),
            "https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1.0/app.exe"
        );
    }

    #[test]
    fn test_sanitize_url_vscode_path_vs_code_param() {
        // 路径段 `vscode` 永不触发；真正的 `code` 查询键必须脱敏；值含敏感词不触发。
        assert_eq!(
            sanitize_url("https://api.github.com/repos/microsoft/vscode/releases/latest"),
            "https://api.github.com/repos/microsoft/vscode/releases/latest"
        );
        assert_eq!(
            sanitize_url("https://github.com/microsoft/vscode/releases/download/v1.0/VSCode.exe?code=secret"),
            "https://github.com/microsoft/vscode/releases/download/v1.0/VSCode.exe?code=***"
        );
        assert_eq!(
            sanitize_url("https://example.com/vscode/update?code=secret&q=vscode&sort=stars"),
            "https://example.com/vscode/update?code=***&q=vscode&sort=stars"
        );
        assert_eq!(
            sanitize_url("https://example.com/dl?token=topsecret&sig=abc123&q=mytoken"),
            "https://example.com/dl?token=***&sig=***&q=mytoken"
        );
        // Wave1 边界镜像：`;` 同为 query 分隔符，分隔形态原样保留。
        assert_eq!(
            sanitize_url("https://example.com/f?q=a;code=secret"),
            "https://example.com/f?q=a;code=secret".replace("code=secret", "code=***")
        );
    }
}
