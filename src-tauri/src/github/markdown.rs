use super::CatalogService;
use regex::Regex;
use std::sync::LazyLock;

static MD_IMG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!\[(.*?)\]\((\s*<)?([^\s\)>]+)(>)?(\s+.*?)?\)")
        .expect("invalid MD_IMG_RE regex")
});

static HTML_IMG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>"#)
        .expect("invalid HTML_IMG_RE regex")
});

static LOGO_HTML_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<img\s+[^>]*?src=["']([^"']+)["'][^>]*>"#)
        .expect("invalid LOGO_HTML_RE regex")
});

static GITHUB_BLOB_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)^https?://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/([^?#]+)(?:[?#].*)?$"#)
        .expect("invalid GITHUB_BLOB_RE regex")
});

static GITHUB_RAW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)^https?://github\.com/([^/]+)/([^/]+)/raw/([^/]+)/([^?#]+)(?:[?#].*)?$"#)
        .expect("invalid GITHUB_RAW_RE regex")
});

static HTML_SOURCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<source\s+([^>]*?)srcset=["']([^"']+)["']([^>]*?)>"#)
        .expect("invalid HTML_SOURCE_RE regex")
});

static MD_REF_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^(\s*\[[^\]]+\]:\s*)(\S+)(\s*.*)$"#)
        .expect("invalid MD_REF_LINK_RE regex")
});

impl CatalogService {
    pub fn clean_image_url(url: &str, owner: &str, repo: &str) -> String {
        Self::clean_image_url_with_mirror(url, owner, repo, "https://gh-proxy.com/")
    }

    pub fn clean_image_url_with_mirror(
        url: &str,
        owner: &str,
        repo: &str,
        mirror_prefix: &str,
    ) -> String {
        let trimmed = url.trim().trim_matches(|c| c == '<' || c == '>');
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with("mailto:")
            || trimmed.starts_with("data:")
            || trimmed.starts_with("javascript:")
        {
            return trimmed.to_string();
        }

        let prefix = if mirror_prefix.is_empty() || mirror_prefix.ends_with('/') {
            mirror_prefix.to_string()
        } else {
            format!("{}/", mirror_prefix)
        };

        // 1. GitHub 官方素材资产直链与第三方 CDN 必须保持直连，绝不能包装 gh-proxy 代理（gh-proxy 不支持会导致请求死锁或超时）
        if trimmed.starts_with("https://user-images.githubusercontent.com/")
            || trimmed.starts_with("http://user-images.githubusercontent.com/")
            || trimmed.starts_with("https://camo.githubusercontent.com/")
            || trimmed.starts_with("http://camo.githubusercontent.com/")
            || trimmed.starts_with("https://github.com/user-attachments/assets/")
            || trimmed.starts_with("http://github.com/user-attachments/assets/")
            || trimmed.starts_with("https://avatars.githubusercontent.com/")
            || (trimmed.contains("github.com/") && trimmed.contains("/assets/"))
        {
            // 如果历史数据已误带代理前缀，清洗剥离
            if let Some(rest) = trimmed.strip_prefix("https://gh-proxy.com/") {
                return rest.to_string();
            }
            return trimmed.to_string();
        }

        // 2. 如果已带有指定镜像前缀，不重复添加
        if !prefix.is_empty() && trimmed.starts_with(&prefix) {
            return trimmed.to_string();
        }

        // 3. GitHub Blob 页面链接转 Raw 直链：
        // 支持匹配任意 owner/repo 的 blob 地址（不区分大小写，自动剥离 ?raw=true）
        if let Some(caps) = GITHUB_BLOB_RE.captures(trimmed) {
            let b_owner = &caps[1];
            let b_repo = &caps[2];
            let b_branch = &caps[3];
            let b_path = &caps[4];
            let raw_url = format!(
                "https://raw.githubusercontent.com/{}/{}/{}/{}",
                b_owner, b_repo, b_branch, b_path
            );
            return if prefix.is_empty() {
                raw_url
            } else {
                format!("{}{}", prefix, raw_url)
            };
        }

        // 4. GitHub Raw 页面链接：
        if let Some(caps) = GITHUB_RAW_RE.captures(trimmed) {
            let r_owner = &caps[1];
            let r_repo = &caps[2];
            let r_branch = &caps[3];
            let r_path = &caps[4];
            let raw_url = format!(
                "https://raw.githubusercontent.com/{}/{}/{}/{}",
                r_owner, r_repo, r_branch, r_path
            );
            return if prefix.is_empty() {
                raw_url
            } else {
                format!("{}{}", prefix, raw_url)
            };
        }

        // 5. GitHub raw.githubusercontent.com 直链（支持加速代理）
        if trimmed.starts_with("https://raw.githubusercontent.com/")
            || trimmed.starts_with("http://raw.githubusercontent.com/")
        {
            return if prefix.is_empty() {
                trimmed.to_string()
            } else {
                format!("{}{}", prefix, trimmed)
            };
        }

        // 6. 其他已带 http:// 或 https:// 的外部绝对链接（shields.io, 外部 CDN 等保持直连）
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return trimmed.to_string();
        }

        // 7. 相对路径（如 ./assets/logo.png, docs/preview.jpg, /images/banner.svg, Command Palette.png）
        let clean_path = trimmed
            .trim_start_matches("./")
            .trim_start_matches('/');
        let clean_path = clean_path.trim_start_matches("../").trim_start_matches('/');

        // 对相对路径中可能未转义的空格及特殊字符进行安全 URL 编码
        let encoded_path = clean_path
            .split('/')
            .map(|seg| {
                if seg.contains('%') {
                    seg.replace(' ', "%20")
                } else {
                    urlencoding::encode(seg).into_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("/");

        let raw_url = format!(
            "https://raw.githubusercontent.com/{}/{}/HEAD/{}",
            owner, repo, encoded_path
        );
        if prefix.is_empty() {
            raw_url
        } else {
            format!("{}{}", prefix, raw_url)
        }
    }

    pub fn rewrite_readme_images(raw_markdown: &str, owner: &str, repo: &str) -> String {
        // 1. 重写 Markdown 语法图片: ![alt](url) 或 ![alt](url "title")
        let md_replaced = MD_IMG_RE.replace_all(raw_markdown, |caps: &regex::Captures| {
            let alt = &caps[1];
            let url = &caps[3];
            let title = caps.get(5).map(|m| m.as_str()).unwrap_or("");
            let rewritten_url = Self::clean_image_url(url, owner, repo);
            if title.is_empty() {
                format!("![{}]({})", alt, rewritten_url)
            } else {
                format!("![{}]({}{})", alt, rewritten_url, title)
            }
        });

        // 2. 重写 Markdown 引用式链接/图片定义: [ref]: url
        let ref_replaced = MD_REF_LINK_RE.replace_all(&md_replaced, |caps: &regex::Captures| {
            let prefix_part = &caps[1];
            let url = &caps[2];
            let suffix_part = &caps[3];
            let lower_url = url.to_lowercase();
            let is_img = lower_url.ends_with(".png")
                || lower_url.ends_with(".svg")
                || lower_url.ends_with(".jpg")
                || lower_url.ends_with(".jpeg")
                || lower_url.ends_with(".gif")
                || lower_url.ends_with(".webp")
                || lower_url.ends_with(".ico")
                || lower_url.ends_with(".avif")
                || lower_url.contains("/blob/")
                || lower_url.contains("/raw/")
                || (!url.starts_with("http://")
                    && !url.starts_with("https://")
                    && !url.starts_with('#')
                    && !url.starts_with("mailto:"));
            if is_img {
                let rewritten_url = Self::clean_image_url(url, owner, repo);
                format!("{}{}{}", prefix_part, rewritten_url, suffix_part)
            } else {
                format!("{}{}{}", prefix_part, url, suffix_part)
            }
        });

        // 3. 重写 HTML <img> 标签语法: <img ... src="url" ...>
        let html_replaced = HTML_IMG_RE.replace_all(&ref_replaced, |caps: &regex::Captures| {
            let before = &caps[1];
            let url = &caps[2];
            let after = &caps[3];
            let rewritten_url = Self::clean_image_url(url, owner, repo);
            format!(r#"<img {}src="{}"{}>"#, before, rewritten_url, after)
        });

        // 4. 重写 HTML <source ... srcset="url" ...> 标签（用于 <picture> 响应式/主题图）
        let source_replaced =
            HTML_SOURCE_RE.replace_all(&html_replaced, |caps: &regex::Captures| {
                let before = &caps[1];
                let srcset = &caps[2];
                let after = &caps[3];
                let rewritten_srcset = srcset
                    .split(',')
                    .map(|candidate| {
                        let parts: Vec<&str> = candidate.trim().split_whitespace().collect();
                        if parts.is_empty() {
                            candidate.to_string()
                        } else {
                            let cleaned = Self::clean_image_url(parts[0], owner, repo);
                            if parts.len() > 1 {
                                format!("{} {}", cleaned, parts[1..].join(" "))
                            } else {
                                cleaned
                            }
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    r#"<source {}srcset="{}"{}>"#,
                    before, rewritten_srcset, after
                )
            });

        source_replaced.into_owned()
    }

    pub fn extract_and_strip_logo_from_readme(
        raw_markdown: &str,
        owner: &str,
        repo: &str,
    ) -> (Option<String>, String) {
        let lines: Vec<&str> = raw_markdown.lines().collect();
        let head_count = lines.len().min(40);
        let head_text = lines[..head_count].join("\n");

        // 1. 优先在 HTML <img> 中寻找带有 logo/icon/brand/splash 的首部图片
        for caps in LOGO_HTML_RE.captures_iter(&head_text) {
            let full_tag = caps.get(0).unwrap().as_str();
            let src = &caps[1];
            let lower = src.to_lowercase();
            if lower.contains("badge")
                || lower.contains("shields.io")
                || lower.contains("workflow")
                || lower.contains("license")
            {
                continue;
            }
            if lower.contains("logo")
                || lower.contains("icon")
                || lower.contains("app")
                || lower.contains("brand")
                || lower.contains("splash")
                || lower.ends_with(".png")
                || lower.ends_with(".svg")
            {
                let cleaned_url = Self::clean_image_url(src, owner, repo);
                let mut stripped = raw_markdown.to_string();

                // 仅在明确为单独居中的 Logo 容器（如 <p align="center">\s*<img>\s*</p>）时才安全剥离容器
                let p_pattern = format!(
                    r#"(?is)<p\s+align=["']center["']>\s*{}\s*(?:<br\s*/?>)?\s*</p>"#,
                    regex::escape(full_tag)
                );
                if let Ok(p_re) = Regex::new(&p_pattern) {
                    if p_re.is_match(&stripped) {
                        stripped = p_re.replace(&stripped, "").to_string();
                        return (Some(cleaned_url), stripped);
                    }
                }
                let div_pattern = format!(
                    r#"(?is)<div\s+align=["']center["']>\s*{}\s*(?:<br\s*/?>)?\s*</div>"#,
                    regex::escape(full_tag)
                );
                if let Ok(div_re) = Regex::new(&div_pattern) {
                    if div_re.is_match(&stripped) {
                        stripped = div_re.replace(&stripped, "").to_string();
                        return (Some(cleaned_url), stripped);
                    }
                }

                // 若非纯粹居中容器（例如正文穿插图片或包含文字链接），只提取 Logo URL，绝对不破坏 README 原文内容
                return (Some(cleaned_url), raw_markdown.to_string());
            }
        }

        // 2. 其次在 Markdown ![alt](url) 中寻找
        for caps in MD_IMG_RE.captures_iter(&head_text) {
            let alt = caps[1].to_lowercase();
            let src = &caps[3];
            let lower_src = src.to_lowercase();
            if lower_src.contains("badge")
                || lower_src.contains("shields.io")
                || lower_src.contains("workflow")
                || lower_src.contains("license")
            {
                continue;
            }
            if alt.contains("logo")
                || alt.contains("icon")
                || alt.contains("app")
                || alt.contains("brand")
                || lower_src.contains("logo")
                || lower_src.contains("icon")
                || lower_src.ends_with(".png")
                || lower_src.ends_with(".svg")
            {
                let cleaned_url = Self::clean_image_url(src, owner, repo);
                // 同样保留 Markdown 原文完整性
                return (Some(cleaned_url), raw_markdown.to_string());
            }
        }

        (None, raw_markdown.to_string())
    }

    pub fn extract_logo_from_readme(
        raw_markdown: &str,
        owner: &str,
        repo: &str,
    ) -> Option<String> {
        Self::extract_and_strip_logo_from_readme(raw_markdown, owner, repo).0
    }
}
