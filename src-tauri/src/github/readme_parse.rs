use std::sync::LazyLock;

static README_FILE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)^readme(?:[._-](zh(?:[._-](?:cn|hans|tw|hk|hant))?|cn|chs|cht|chinese|en(?:[._-](?:us|gb))?|english|us))?\.(md|markdown)$",
    )
    .expect("invalid README_FILE_RE regex")
});

static README_BARE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^readme\.(md|markdown)$").expect("invalid README_BARE_RE regex")
});

static README_ZH_TRAD_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^readme[._-](?:zh[._-](?:tw|hk|hant)|cht)\.(?:md|markdown)$")
        .expect("invalid README_ZH_TRAD_RE regex")
});

#[derive(Debug, serde::Deserialize)]
pub(crate) struct ContentsEntry {
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default, rename = "type")]
    pub(crate) entry_type: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct GitTreeResponse {
    #[serde(default)]
    pub(crate) tree: Vec<GitTreeNode>,
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct GitTreeNode {
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default, rename = "type")]
    pub(crate) node_type: Option<String>,
}

/// 文件名归一化为 `zh-CN` / `en-US`；非 README 根文件返回 `None`。
/// 无语言后缀默认归为 `en-US`，除非文件名明确含 zh 系标记。
pub fn classify_readme_lang(file_name: &str) -> Option<&'static str> {
    let base = file_name.rsplit('/').next().unwrap_or(file_name).trim();
    if base.is_empty() || base.contains('/') {
        return None;
    }
    let caps = README_FILE_RE.captures(base)?;
    let token = caps.get(1).map(|m| m.as_str().to_ascii_lowercase());
    match token.as_deref() {
        None => Some("en-US"),
        Some(t)
            if t == "zh"
                || t == "cn"
                || t == "chs"
                || t == "cht"
                || t == "chinese"
                || t.starts_with("zh-")
                || t.starts_with("zh_")
                || t.starts_with("zh.") =>
        {
            Some("zh-CN")
        }
        Some(t)
            if t == "en"
                || t == "us"
                || t == "english"
                || t.starts_with("en-")
                || t.starts_with("en_")
                || t.starts_with("en.") =>
        {
            Some("en-US")
        }
        // 后缀集合白名单匹配，兜底归 en-US，避免新增语言时炸流程。
        _ => Some("en-US"),
    }
}

/// 从根目录路径列表筛选并排序 README 候选（最多 2 项：`zh-CN` 在前、`en-US` 在后）。
pub fn select_readme_candidates(paths: &[String]) -> Vec<(String, String)> {
    let mut zh_cands: Vec<String> = Vec::new();
    let mut bare_cands: Vec<String> = Vec::new();
    let mut en_cands: Vec<String> = Vec::new();
    for p in paths {
        let trimmed = p.trim();
        if trimmed.is_empty() || trimmed.contains('/') {
            continue;
        }
        match classify_readme_lang(trimmed) {
            Some("zh-CN") => {
                if !zh_cands.iter().any(|x| x == trimmed) {
                    zh_cands.push(trimmed.to_string());
                }
            }
            Some("en-US") => {
                if README_BARE_RE.is_match(trimmed) {
                    if !bare_cands.iter().any(|x| x == trimmed) {
                        bare_cands.push(trimmed.to_string());
                    }
                } else if !en_cands.iter().any(|x| x == trimmed) {
                    en_cands.push(trimmed.to_string());
                }
            }
            _ => {}
        }
    }
    // zh-CN 优先简体（zh / zh-CN / zh-Hans / cn / chs），其次繁体兜底（zh-TW / zh-HK / zh-Hant / cht）。
    zh_cands.sort_by(|a, b| {
        let trad_a = README_ZH_TRAD_RE.is_match(a);
        let trad_b = README_ZH_TRAD_RE.is_match(b);
        trad_a
            .cmp(&trad_b)
            .then_with(|| a.len().cmp(&b.len()))
            .then_with(|| a.cmp(b))
    });
    bare_cands.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
    en_cands.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));

    let zh = zh_cands.into_iter().next();
    let bare = bare_cands.into_iter().next();
    let en = en_cands.into_iter().next();

    let mut out = Vec::with_capacity(2);
    match (zh, bare, en) {
        (Some(z), Some(e), _) | (Some(z), None, Some(e)) => {
            out.push(("zh-CN".to_string(), z));
            out.push(("en-US".to_string(), e));
        }
        (Some(z), None, None) => {
            out.push(("zh-CN".to_string(), z));
        }
        (None, Some(b), Some(e)) => {
            out.push(("zh-CN".to_string(), b));
            out.push(("en-US".to_string(), e));
        }
        (None, Some(e), None) | (None, None, Some(e)) => {
            out.push(("en-US".to_string(), e));
        }
        (None, None, None) => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_readme_lang_mapping() {
        // 裸 README 兜底 en-US。
        assert_eq!(classify_readme_lang("README.md"), Some("en-US"));
        assert_eq!(classify_readme_lang("readme.markdown"), Some("en-US"));
        assert_eq!(classify_readme_lang("ReadMe.MD"), Some("en-US"));
        // en 系后缀。
        assert_eq!(classify_readme_lang("README.en.md"), Some("en-US"));
        assert_eq!(classify_readme_lang("README_en-US.markdown"), Some("en-US"));
        assert_eq!(classify_readme_lang("readme-us.md"), Some("en-US"));
        assert_eq!(classify_readme_lang("README.en_us.md"), Some("en-US"));
        assert_eq!(classify_readme_lang("README-english.md"), Some("en-US"));
        // zh 系后缀。
        assert_eq!(classify_readme_lang("README.zh-CN.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README_zh_cn.markdown"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README_zh-CN.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("readme-zh.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README-zh-Hans.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README.zh_hans.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README-chs.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README-chinese.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README-zh-TW.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README.zh-Hant.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README.CN.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("readme_cn.markdown"), Some("zh-CN"));
        // 非 README / 非法后缀一律 None。
        assert_eq!(classify_readme_lang("CONTRIBUTING.md"), None);
        assert_eq!(classify_readme_lang("README.txt"), None);
        assert_eq!(classify_readme_lang("README.zh-CN.txt"), None);
        assert_eq!(classify_readme_lang("README-ja.md"), None);
        assert_eq!(classify_readme_lang("docs.md"), None);
    }

    #[test]
    fn test_select_readme_candidates_prefers_simplified_chinese_over_traditional() {
        let paths = vec![
            "README.md".to_string(),
            "README-zh-TW.md".to_string(),
            "README-zh-Hans.md".to_string(),
        ];
        let selected = select_readme_candidates(&paths);
        assert_eq!(selected.len(), 2);
        assert_eq!(
            selected[0],
            ("zh-CN".to_string(), "README-zh-Hans.md".to_string())
        );
        assert_eq!(selected[1], ("en-US".to_string(), "README.md".to_string()));
    }

    #[test]
    fn test_select_readme_candidates_root_only_dedup_sorted() {
        let paths = vec![
            "README.en.md".to_string(),
            "README.md".to_string(),
            "README.zh-CN.md".to_string(),
            "README.zh.md".to_string(),
            "docs/README.md".to_string(),
            "CONTRIBUTING.md".to_string(),
        ];
        let selected = select_readme_candidates(&paths);
        // 去重后最多 2 项，zh-CN 在前。
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].0, "zh-CN");
        assert_eq!(selected[1].0, "en-US");
        // en-US 优先裸 README。
        assert_eq!(selected[1].1, "README.md");
        // 嵌套目录一律不收。
        assert!(!selected.iter().any(|(_, p)| p.contains('/')));
    }

    #[test]
    fn test_select_readme_candidates_bare_plus_explicit_en_maps_bare_to_zh() {
        let paths = vec!["README.md".to_string(), "README-en.md".to_string()];
        let selected = select_readme_candidates(&paths);
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0], ("zh-CN".to_string(), "README.md".to_string()));
        assert_eq!(
            selected[1],
            ("en-US".to_string(), "README-en.md".to_string())
        );
    }

    #[test]
    fn test_select_readme_candidates_empty_and_single() {
        let empty: Vec<String> = Vec::new();
        assert!(select_readme_candidates(&empty).is_empty());
        let nested = vec!["docs/README.md".to_string(), "src/readme.zh.md".to_string()];
        assert!(select_readme_candidates(&nested).is_empty());
        let single = vec!["README.md".to_string()];
        let out = select_readme_candidates(&single);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], ("en-US".to_string(), "README.md".to_string()));
    }
}
