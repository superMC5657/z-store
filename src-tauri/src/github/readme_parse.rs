use std::sync::LazyLock;

static README_FILE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^readme(?:[._-](zh-cn|zh_cn|zh|cn|en-us|en_us|en|us))?\.(md|markdown)$")
        .expect("invalid README_FILE_RE regex")
});

static README_BARE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^readme\.(md|markdown)$").expect("invalid README_BARE_RE regex")
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
    let token = caps
        .get(1)
        .map(|m| m.as_str().to_ascii_lowercase());
    match token.as_deref() {
        None => Some("en-US"),
        Some("zh-cn") | Some("zh_cn") | Some("zh") | Some("cn") => Some("zh-CN"),
        Some("en-us") | Some("en_us") | Some("en") | Some("us") => Some("en-US"),
        // 正则已收敛后缀集合，兜底仍归 en-US，避免新增语言时炸流程。
        _ => Some("en-US"),
    }
}

/// 根目录路径列表过滤 → 去重（每语言最多 1 个）→ 固定 `zh-CN` 在前、`en-US` 在后，
/// 最多 2 项。含 `/` 的非根路径直接丢弃。
pub fn select_readme_candidates(paths: &[String]) -> Vec<(String, String)> {
    let mut zh_cands: Vec<String> = Vec::new();
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
            Some("en-US") if !en_cands.iter().any(|x| x == trimmed) => {
                en_cands.push(trimmed.to_string());
            }
            _ => {}
        }
    }
    // en-US 优先裸 README（README.md / README.markdown），再按短路径、字典序稳定选择。
    en_cands.sort_by(|a, b| {
        let bare_a = README_BARE_RE.is_match(a);
        let bare_b = README_BARE_RE.is_match(b);
        (!bare_a)
            .cmp(&(!bare_b))
            .then_with(|| a.len().cmp(&b.len()))
            .then_with(|| a.cmp(b))
    });
    zh_cands.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));

    let mut out = Vec::with_capacity(2);
    if let Some(first) = zh_cands.into_iter().next() {
        out.push(("zh-CN".to_string(), first));
    }
    if let Some(first) = en_cands.into_iter().next() {
        out.push(("en-US".to_string(), first));
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
        // zh 系后缀。
        assert_eq!(classify_readme_lang("README.zh-CN.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README_zh_cn.markdown"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("readme-zh.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("README.CN.md"), Some("zh-CN"));
        assert_eq!(classify_readme_lang("readme_cn.markdown"), Some("zh-CN"));
        // 非 README / 非法后缀一律 None。
        assert_eq!(classify_readme_lang("CONTRIBUTING.md"), None);
        assert_eq!(classify_readme_lang("README.txt"), None);
        assert_eq!(classify_readme_lang("README.zh-CN.txt"), None);
        assert_eq!(classify_readme_lang("docs.md"), None);
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

    #[test]
    fn test_app_detail_readme_variants_serde_backward_compat() {
        // 旧 detail_json（无 readme_variants 字段）必须可解析为 None，不炸 304/缓存命中路径。
        let legacy = serde_json::json!({
            "id": "o/r", "name": "r", "owner": "o", "repo": "r",
            "icon": "", "icon_bg": "", "description": "", "stars": 0u64,
            "forks": 0u64, "license": "MIT", "latest_version": "v1",
            "changelog": "", "is_verified": false, "readme_markdown": "# r",
            "releases": [], "category": "dev", "category_name": "开发工具",
            "platforms": []
        });
        let detail: crate::models::AppDetail =
            serde_json::from_value(legacy).expect("legacy detail must parse");
        assert!(detail.readme_variants.is_none());
    }
}
