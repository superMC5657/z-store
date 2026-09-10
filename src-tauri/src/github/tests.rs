use super::*;

#[test]
fn test_catalog_load_and_search() {
    let cat = CatalogService::new();
    assert!(cat.get_catalog_count() >= 20);

    let res = cat.search_apps("rustdesk");
    assert!(!res.is_empty());
    assert_eq!(res[0].id, "rustdesk");

    let res_zh = cat.search_apps("远程桌面");
    assert!(!res_zh.is_empty());
    assert_eq!(res_zh[0].id, "rustdesk");
}

#[test]
fn test_category_filter() {
    let cat = CatalogService::new();
    let media_apps = cat.filter_by_category("media").unwrap();
    assert!(media_apps.iter().any(|a| a.id == "vlc"));
}

#[tokio::test]
async fn test_fetch_developer_profile_fallback() {
    let cat = CatalogService::new();
    // 测试针对 catalog 中已知组织 localsend 的 profile 获取（网络不通时自动从 catalog 兜底）
    let profile = cat.fetch_developer_profile("localsend", None).await.unwrap();
    assert_eq!(profile.login, "localsend");
    assert!(!profile.repos.is_empty());
    assert!(profile.repos.iter().any(|r| r.in_catalog));
}

#[tokio::test]
async fn test_sync_starred_repos_empty_username_err() {
    let cat = CatalogService::new();
    let result = cat.sync_starred_repos(Some("   "), None).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("请提供 GitHub 用户名"));
}

#[test]
fn test_rewrite_readme_images() {
    let sample = r#"
# Demo Project
![Logo](./assets/logo.png)
<p align="center">
  <img src="docs/screenshot.svg" width="200" alt="demo" />
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/dark-banner.png" />
    <img src="doc/images/icons/Command Palette.png" alt="Command Palette" />
  </picture>
</p>
[Web Link](https://example.com/blob/main/test.png)
![GitHub Blob](https://github.com/rustdesk/rustdesk/blob/master/res/demo.png)
![External Shield](https://img.shields.io/badge/license-MIT-blue)
![User Uploaded](https://user-images.githubusercontent.com/71636191/171661982-demo.png)
![Attachment](https://github.com/user-attachments/assets/abcd-1234)
[![CI Status][ci-badge]][ci-link]

[ci-badge]: ./docs/ci-badge.svg
[ci-link]: https://github.com/rustdesk/rustdesk/actions
"#;
    let rewritten = CatalogService::rewrite_readme_images(sample, "rustdesk", "rustdesk");

    // 验证相对路径转为 raw + gh-proxy
    assert!(rewritten.contains("https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/assets/logo.png"));
    assert!(rewritten.contains("https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/docs/screenshot.svg"));

    // 验证带空格路径进行了安全 URL 编码
    assert!(rewritten.contains("https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/doc/images/icons/Command%20Palette.png"));

    // 验证 <source srcset="..."> 响应式标签重写
    assert!(rewritten.contains("srcset=\"https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/docs/dark-banner.png\""));

    // 验证 Markdown 引用式链接定义 [ci-badge]: ... 重写
    assert!(rewritten.contains("[ci-badge]: https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/docs/ci-badge.svg"));

    // 验证 GitHub Blob 网页链接转为 raw 直链并代理
    assert!(rewritten.contains("https://gh-proxy.com/https://raw.githubusercontent.com/rustdesk/rustdesk/master/res/demo.png"));

    // 验证外部 shields.io 保持原样
    assert!(rewritten.contains("https://img.shields.io/badge/license-MIT-blue"));

    // 验证 GitHub 资产/截图直链绝不能被套用 gh-proxy，保持直连
    assert!(rewritten.contains(
        "https://user-images.githubusercontent.com/71636191/171661982-demo.png"
    ));
    assert!(!rewritten.contains("gh-proxy.com/https://user-images.githubusercontent.com"));
    assert!(rewritten.contains("https://github.com/user-attachments/assets/abcd-1234"));
    assert!(!rewritten.contains("gh-proxy.com/https://github.com/user-attachments/assets"));
}

#[test]
fn test_extract_logo_from_readme() {
    let sample = r#"
<p align="center">
  <img src="./assets/logo.png" width="100" alt="RustDesk Logo" />
</p>
# RustDesk
"#;
    let (logo, stripped) =
        CatalogService::extract_and_strip_logo_from_readme(sample, "rustdesk", "rustdesk");
    assert!(logo.is_some());
    assert!(logo.unwrap().contains("assets/logo.png"));
    // 验证旧图标已被彻底剥离，不再残留在 README 内容中
    assert!(!stripped.contains("assets/logo.png"));
    assert!(stripped.contains("# RustDesk"));
}

#[tokio::test]
async fn test_sync_remote_catalog_local_file() {
    let cat = CatalogService::new();
    let cfg = crate::config::get_project_config();
    let target_path = cfg
        .catalog
        .resolve_local_path()
        .expect("catalog.json should be resolvable via config local_path");
    let target = target_path.to_str().unwrap();
    let (items, etag) = cat.sync_remote_catalog(target, None).await.unwrap();
    assert!(items.is_some());
    let list = items.unwrap();
    assert!(list.len() >= 20);
    assert!(etag.is_some());
    assert!(etag.unwrap().contains("local-"));

    // Test with same etag returns None (unmodified)
    let etag_val = format!(
        "W/\"local-{}\"",
        std::fs::metadata(&target_path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    );
    let (no_items, _) = cat.sync_remote_catalog(target, Some(&etag_val)).await.unwrap();
    assert!(no_items.is_none());
}

#[test]
fn test_catalog_platforms_loading_and_mapping() {
    let cat = CatalogService::new();
    let rustdesk = cat.get_catalog_item("rustdesk").expect("rustdesk exists in catalog");
    assert!(rustdesk.platforms.contains(&"windows".to_string()));
    assert!(rustdesk.platforms.contains(&"android".to_string()));
    assert!(rustdesk.platforms.contains(&"macos".to_string()));
    assert!(rustdesk.platforms.contains(&"linux".to_string()));
    assert!(rustdesk.platforms.contains(&"ios".to_string()));

    let summary = rustdesk.to_summary();
    assert_eq!(summary.platforms, rustdesk.platforms);

    // 校验所有收录项均有有效的 platforms（至少包含一个支持端）
    for item in cat.get_catalog_items() {
        assert!(!item.platforms.is_empty(), "app {} should have platforms", item.id);
        assert!(
            item.platforms.iter().all(|p| ["windows", "android", "macos", "linux", "ios"].contains(&p.as_str())),
            "app {} platforms should be valid: {:?}", item.id, item.platforms
        );
    }
}

