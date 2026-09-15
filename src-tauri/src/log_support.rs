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
        .find(|c| c == '/' || c == '?' || c == '#')
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
}
