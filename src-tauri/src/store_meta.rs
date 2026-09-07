//! `z-store.toml` 仓库元数据：拉取、解析与所有权校验（FR-8.1 / FR-8.3）。
//!
//! 开发者将 `z-store.toml` 置于仓库根目录，声明展示名、双语简介、
//! 分类、截图、iOS 渠道入口与资产覆盖规则（规范见 PRD 5.8 / 附录 B）。
//! 所有字段均为可选；仓库缺失该文件时返回 `None`（视为“无元数据”，
//! 调用方用仓库 API 数据兜底，而非报错）。

use serde::{Deserialize, Serialize};

/// `[app]` 段：应用展示元数据。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreAppMeta {
    #[serde(default, rename = "display-name")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default, rename = "summary-en")]
    pub summary_en: Option<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
}

/// `[store]` 段：商店展示与信任信息。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreSectionMeta {
    #[serde(default)]
    pub screenshots: Vec<String>,
    #[serde(default, rename = "signature-fingerprint")]
    pub signature_fingerprint: Option<String>,
}

/// `[ios]` 段：iOS 渠道跳转入口（iOS 设备按此展示 App Store / TestFlight）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreIosMeta {
    #[serde(default, rename = "app-store-id")]
    pub app_store_id: Option<String>,
    #[serde(default, rename = "testflight-url")]
    pub testflight_url: Option<String>,
}

/// `[assets.override] windows`：Windows 资产识别覆盖规则。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowsAssetsOverride {
    #[serde(default, rename = "portable-pattern")]
    pub portable_pattern: Option<String>,
    #[serde(default, rename = "silent-args")]
    pub silent_args: Option<String>,
}

/// `[assets.override]` 段容器。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetsOverrideSection {
    #[serde(default)]
    pub windows: Option<WindowsAssetsOverride>,
}

/// `[assets]` 段容器。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetsSection {
    #[serde(default, rename = "override")]
    pub override_rules: Option<AssetsOverrideSection>,
}

/// `z-store.toml` 根结构；随附在应用详情（`AppDetail.store_meta`）中下发。
/// 未知字段直接忽略，保证旧客户端可前向兼容新规范。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreMeta {
    #[serde(default)]
    pub app: StoreAppMeta,
    #[serde(default)]
    pub store: StoreSectionMeta,
    #[serde(default)]
    pub ios: StoreIosMeta,
    #[serde(default)]
    pub assets: AssetsSection,
}

/// 解析 `z-store.toml` 文本为 [`StoreMeta`]（纯函数，可单元测试）。
/// 所有字段可选，空文档解析为默认值；语法错误返回中文错误描述。
pub fn parse_store_toml(content: &str) -> Result<StoreMeta, String> {
    toml::from_str::<StoreMeta>(content).map_err(|e| format!("解析 z-store.toml 失败: {}", e))
}

/// 所有权校验（FR-8.3 MVP）：校验码原文出现在仓库 README
/// 或 `z-store.toml` 内容中任一处即视为通过。
/// 空校验码恒为 `false`（避免空串子串恒真导致误认证）。
pub fn is_verified_by_code(
    readme_markdown: &str,
    toml_content: Option<&str>,
    code: &str,
) -> bool {
    let needle = code.trim();
    if needle.is_empty() {
        return false;
    }
    if readme_markdown.contains(needle) {
        return true;
    }
    if let Some(toml) = toml_content {
        if toml.contains(needle) {
            return true;
        }
    }
    false
}

/// 拉取指定 GitHub 仓库根目录的 `z-store.toml` 原文。
/// 依次尝试 `main` / `master` 分支；若传入加速镜像前缀，
/// 按与 `MirrorManager::rewrite_download_url` 相同的规则（仅 GitHub
/// 链接加前缀）追加改写候选（直连优先）。
/// 文件不存在（404）或网络异常均返回 `None`（非错误）。
pub async fn fetch_store_toml_raw(
    owner: &str,
    repo: &str,
    host_token: Option<&str>,
    mirror_proxy: Option<&str>,
) -> Option<String> {
    let owner = owner.trim();
    let repo = repo.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    let mut candidates = Vec::new();
    for branch in ["main", "master"] {
        candidates.push(format!(
            "https://raw.githubusercontent.com/{}/{}/{}/z-store.toml",
            owner, repo, branch
        ));
    }
    if let Some(proxy) = mirror_proxy.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let base = proxy.trim_end_matches('/');
        let extra: Vec<String> = candidates
            .iter()
            .filter(|u| {
                (u.contains("githubusercontent.com")) && !u.starts_with(base)
            })
            .map(|u| format!("{}/{}", base, u))
            .collect();
        for u in extra {
            if !candidates.contains(&u) {
                candidates.push(u);
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;

    for url in candidates {
        let mut req = client
            .get(&url)
            .header("User-Agent", "ZStore-Client/0.1.0")
            .header("Accept", "text/plain");
        if let Some(tok) = host_token {
            let tok = tok.trim();
            if !tok.is_empty() {
                if let Ok(v) =
                    reqwest::header::HeaderValue::from_str(&format!("Bearer {}", tok))
                {
                    req = req.header(reqwest::header::AUTHORIZATION, v);
                }
            }
        }
        match tokio::time::timeout(std::time::Duration::from_secs(5), req.send()).await {
            Ok(Ok(resp)) if resp.status().is_success() => {
                if let Ok(text) = resp.text().await {
                    if !text.trim().is_empty() {
                        return Some(text);
                    }
                }
            }
            _ => continue,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRD_EXAMPLE: &str = r#"
[app]
display-name = "Z-Reader"
summary = "专为重度阅读者打造的沉浸式极简电子书器"
summary-en = "A minimalist, distraction-free ebook reader"
categories = ["reading", "utilities"]
aliases = ["阅读器", "电子书", "epub阅读", "reader"]
license = "GPL-3.0"
homepage = "https://example.com"

[store]
screenshots = ["docs/assets/screenshot-main.png", "docs/assets/screenshot-reader.png"]
signature-fingerprint = "E8:7A:B4:11:22:33"

[ios]
app-store-id = "id1628392102"
testflight-url = "https://testflight.apple.com/join/AbCdEf12"

[assets.override]
windows = { portable-pattern = "*portable*.zip", silent-args = "/VERYSILENT" }
"#;

    #[test]
    fn test_parse_prd_example() {
        let meta = parse_store_toml(PRD_EXAMPLE).expect("PRD 5.8 示例应当解析成功");
        assert_eq!(meta.app.display_name.as_deref(), Some("Z-Reader"));
        assert_eq!(
            meta.app.summary.as_deref(),
            Some("专为重度阅读者打造的沉浸式极简电子书器")
        );
        assert_eq!(
            meta.app.summary_en.as_deref(),
            Some("A minimalist, distraction-free ebook reader")
        );
        assert_eq!(meta.app.categories, vec!["reading", "utilities"]);
        assert_eq!(meta.app.aliases.len(), 4);
        assert_eq!(meta.app.license.as_deref(), Some("GPL-3.0"));
        assert_eq!(meta.app.homepage.as_deref(), Some("https://example.com"));
        assert_eq!(meta.store.screenshots.len(), 2);
        assert_eq!(
            meta.store.signature_fingerprint.as_deref(),
            Some("E8:7A:B4:11:22:33")
        );
        assert_eq!(meta.ios.app_store_id.as_deref(), Some("id1628392102"));
        assert_eq!(
            meta.ios.testflight_url.as_deref(),
            Some("https://testflight.apple.com/join/AbCdEf12")
        );
        let win = meta
            .assets
            .override_rules
            .as_ref()
            .and_then(|o| o.windows.as_ref())
            .expect("windows 覆盖规则");
        assert_eq!(win.portable_pattern.as_deref(), Some("*portable*.zip"));
        assert_eq!(win.silent_args.as_deref(), Some("/VERYSILENT"));
    }

    #[test]
    fn test_parse_partial_and_empty() {
        // 部分字段缺失：其余保持 None / 空，解析仍成功
        let meta = parse_store_toml("[app]\ndisplay-name = \"Demo\"\n").unwrap();
        assert_eq!(meta.app.display_name.as_deref(), Some("Demo"));
        assert!(meta.app.summary.is_none());
        assert!(meta.store.screenshots.is_empty());
        assert!(meta.ios.app_store_id.is_none());
        assert!(meta.assets.override_rules.is_none());

        // 空文档：全默认
        let empty = parse_store_toml("").unwrap();
        assert_eq!(empty, StoreMeta::default());

        // 未知字段前向兼容：直接忽略
        let future = parse_store_toml("[app]\ndisplay-name = \"X\"\n[future-section]\nfoo = 1\n").unwrap();
        assert_eq!(future.app.display_name.as_deref(), Some("X"));
    }

    #[test]
    fn test_parse_invalid_toml_errors() {
        let err = parse_store_toml("[app\nbroken = ").unwrap_err();
        assert!(err.contains("解析 z-store.toml 失败"));
    }

    #[test]
    fn test_is_verified_by_code() {
        let readme = "# Demo\n\n官网 https://example.com\n";
        let toml = "[app]\ndisplay-name = \"Demo\"\n";
        // 校验码出现在 README
        assert!(is_verified_by_code(readme, Some(toml), "example.com"));
        // 校验码出现在 z-store.toml
        assert!(is_verified_by_code(readme, Some(toml), "display-name"));
        // 两处都不存在
        assert!(!is_verified_by_code(readme, Some(toml), "zstore-verify-9f8e7d6c"));
        assert!(!is_verified_by_code(readme, None, "zstore-verify-9f8e7d6c"));
        // 空校验码恒为 false（避免 "".contains 特性误认证）
        assert!(!is_verified_by_code(readme, Some(toml), ""));
        assert!(!is_verified_by_code(readme, Some(toml), "   "));
    }
}
