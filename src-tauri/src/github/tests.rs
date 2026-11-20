use super::*;

#[test]
fn test_catalog_load_and_search() {
    let cat = CatalogService::new();
    assert!(cat.get_catalog_count() >= 20);

    let res = cat.search_local_catalog("rustdesk");
    assert!(!res.is_empty());
    assert_eq!(res[0].core.id, "rustdesk/rustdesk");

    let res_zh = cat.search_local_catalog("远程桌面");
    assert!(!res_zh.is_empty());
    assert_eq!(res_zh[0].core.id, "rustdesk/rustdesk");
}

#[tokio::test]
async fn test_fetch_developer_profile_fallback() {
    let cat = CatalogService::new();
    // 测试针对 catalog 中已知组织 localsend 的 profile 获取（网络不通时自动从 catalog 兜底）
    let profile = cat
        .fetch_developer_profile("localsend", None)
        .await
        .unwrap();
    assert_eq!(profile.login, "localsend");
    assert!(!profile.repos.is_empty());
    assert!(profile.repos.iter().any(|r| r.in_catalog));
}

#[tokio::test]
async fn test_fetch_starred_page_empty_username_err() {
    let cat = CatalogService::new();
    let result = cat
        .fetch_starred_page(Some("   "), None, 1, 20, None, None, None)
        .await;
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

    // 验证相对路径转为 raw 绝对地址
    assert!(rewritten
        .contains("https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/assets/logo.png"));
    assert!(rewritten
        .contains("https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/docs/screenshot.svg"));

    // 验证带空格路径进行了安全 URL 编码
    assert!(rewritten.contains("https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/doc/images/icons/Command%20Palette.png"));

    // 验证 <source srcset="..."> 响应式标签重写
    assert!(rewritten.contains(
        "srcset=\"https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/docs/dark-banner.png\""
    ));

    // 验证 Markdown 引用式链接定义 [ci-badge]: ... 重写
    assert!(rewritten.contains(
        "[ci-badge]: https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/docs/ci-badge.svg"
    ));

    // 验证 GitHub Blob 网页链接转为 raw 绝对地址
    assert!(rewritten
        .contains("https://raw.githubusercontent.com/rustdesk/rustdesk/master/res/demo.png"));

    // 验证外部 shields.io 保持原样
    assert!(rewritten.contains("https://img.shields.io/badge/license-MIT-blue"));

    // 验证 GitHub 资产/截图链接原样透传
    assert!(
        rewritten.contains("https://user-images.githubusercontent.com/71636191/171661982-demo.png")
    );
    assert!(rewritten.contains("https://github.com/user-attachments/assets/abcd-1234"));
}

#[test]
fn test_extract_and_strip_logo_from_readme() {
    let sample = r#"
<p align="center">
  <img src="./assets/logo.png" width="100" alt="RustDesk Logo" />
</p>
# RustDesk
"#;
    let (logo, stripped) =
        CatalogService::extract_and_strip_logo_from_readme(sample, "rustdesk", "rustdesk");
    assert!(logo.is_some());
    let logo_url = logo.unwrap();
    assert!(logo_url.contains("assets/logo.png"));
    // 头部备选 Logo 为直链。
    assert_eq!(
        logo_url,
        "https://raw.githubusercontent.com/rustdesk/rustdesk/HEAD/assets/logo.png"
    );
    // 头部 Logo 已从 README 正文剥离
    assert!(!stripped.contains("assets/logo.png"));
    assert!(stripped.contains("# RustDesk"));
}

#[test]
fn test_clean_image_url_rejects_local_paths() {
    // 本地盘路径一律拒收为空：Windows 盘符、编码形盘符、UNC、file/asset scheme、缓存目录特征。
    for dirty in [
        r"C:\Users\supermc\AppData\Roaming\com.zstore.app\cache\assets\31\313fde161a94b966.png",
        "c:/users/supermc/logo.png",
        "C%3A%5CUsers%5Csupermc%5CAppData%5CRoaming%5Ccom.zstore.app%5Ccache%5Cassets%5C31%5C313fde161a94b966.png",
        r"\\SERVER\share\logo.png",
        "file:///C:/Users/supermc/logo.png",
        "asset://localhost/C%3A/Users/supermc/logo.png",
        "https://example.com/com.zstore.app/logo.png",
    ] {
        assert_eq!(
            CatalogService::clean_image_url(dirty, "o", "r"),
            "",
            "dirty={dirty}"
        );
    }
    // 正常相对路径与远端地址不受影响。
    assert_eq!(
        CatalogService::clean_image_url("./assets/logo.png", "o", "r"),
        "https://raw.githubusercontent.com/o/r/HEAD/assets/logo.png"
    );
    assert_eq!(
        CatalogService::clean_image_url("https://example.com/logo.png", "o", "r"),
        "https://example.com/logo.png"
    );
}

#[test]
fn test_extract_skips_local_path_logo() {
    // 库里混入本地路径的正文：L4 候选为空，不入库、不下载。
    let sample = concat!(
        "<p align=\"center\">\n",
        "  <img src=\"C:\\Users\\supermc\\AppData\\Roaming\\com.zstore.app\\cache\\assets\\31\\logo.png\" width=\"100\" alt=\"Logo\" />\n",
        "</p>\n# Demo\n",
    );
    let (logo, _) = CatalogService::extract_and_strip_logo_from_readme(sample, "o", "r");
    assert!(logo.is_none());
}

#[tokio::test]
async fn test_fetch_remote_catalog_local_file() {
    let cat = CatalogService::new();
    let cfg = crate::config::get_project_config();
    let target_path = cfg
        .catalog
        .resolve_local_path()
        .expect("catalog.json should be resolvable via config local_path");
    let target = target_path.to_str().unwrap();
    let (items, etag) = cat.fetch_remote_catalog(target, None).await.unwrap();
    assert!(items.is_some());
    let list = items.unwrap();
    assert!(list.len() >= 20);
    assert!(etag.is_some());
    assert!(etag.unwrap().contains("local-"));

    // 使用相同 etag 进行测试应返回 None（数据未变更）
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
    let (no_items, _) = cat
        .fetch_remote_catalog(target, Some(&etag_val))
        .await
        .unwrap();
    assert!(no_items.is_none());
}

#[test]
fn test_catalog_platforms_loading_and_mapping() {
    let cat = CatalogService::new();
    let rustdesk = cat
        .get_catalog_item("rustdesk/rustdesk")
        .expect("rustdesk exists in catalog");
    assert!(rustdesk.platforms.contains(&"windows".to_string()));
    assert!(rustdesk.platforms.contains(&"android".to_string()));
    assert!(rustdesk.platforms.contains(&"macos".to_string()));
    assert!(rustdesk.platforms.contains(&"linux".to_string()));
    assert!(rustdesk.platforms.contains(&"ios".to_string()));

    let summary = rustdesk.to_summary();
    assert_eq!(summary.core.platforms, rustdesk.platforms);

    // 校验所有收录项均有有效的 platforms（至少包含一个支持端）
    for item in cat.get_catalog_items() {
        assert!(
            !item.platforms.is_empty(),
            "app {} should have platforms",
            item.id
        );
        assert!(
            item.platforms
                .iter()
                .all(|p| ["windows", "android", "macos", "linux", "ios"].contains(&p.as_str())),
            "app {} platforms should be valid: {:?}",
            item.id,
            item.platforms
        );
    }
}

#[test]
fn test_catalog_identifiers_and_fallback() {
    let cat = CatalogService::new();

    // 1. 测试从 catalog.json 加载的多端原生标识符
    let rustdesk = cat
        .get_catalog_item("rustdesk/rustdesk")
        .expect("rustdesk exists in catalog");
    assert_eq!(rustdesk.get_identifiers("windows"), vec!["rustdesk.exe"]);
    assert_eq!(
        rustdesk.get_identifiers("android"),
        vec!["com.carriez.flutter_rustdesk"]
    );
    assert_eq!(
        rustdesk.get_identifiers("macos"),
        vec!["RustDesk.app", "rustdesk"]
    );
    assert_eq!(rustdesk.get_identifiers("linux"), vec!["rustdesk"]);

    let ripgrep = cat
        .get_catalog_item("burntsushi/ripgrep")
        .expect("ripgrep exists in catalog");
    assert!(ripgrep
        .get_identifiers("windows")
        .contains(&"rg.exe".to_string()));
    assert_eq!(ripgrep.get_identifiers("linux"), vec!["rg"]);

    // 2. 校验声明支持 Windows 的收录应用均能成功获取 Windows 可执行识别名
    //    （清单中存在 macOS/Linux 专属应用，不应要求其提供 Windows 标识符）
    for item in cat.get_catalog_items() {
        if !item
            .platforms
            .iter()
            .any(|p| p.eq_ignore_ascii_case("windows"))
        {
            continue;
        }
        let win_exes = item.get_identifiers("windows");
        assert!(
            !win_exes.is_empty(),
            "app {} should have windows executables in identifiers",
            item.id
        );
        assert!(
            win_exes.iter().any(|e| e.ends_with(".exe")),
            "windows executable should end with .exe: {:?}",
            win_exes
        );
    }
}

mod catalog_mirror_fallback {
    use super::*;
    use crate::github::catalog_service::CatalogVia;
    use crate::test_support::{dead_addr, serve, Reply};

    const VALID_ITEM: &str = r#"[{"id":"o/r","name":"R","owner":"o","repo":"r","icon":"","icon_bg":"","description":"d","category":"dev","category_name":"开发工具","aliases":[],"default_version":"latest","license":"MIT","stars":1,"forks":0,"is_verified":true,"platforms":["windows"]}]"#;
    const BAD_ID_ITEM: &str = r#"[{"id":"<html>","name":"R","owner":"o","repo":"r","icon":"","icon_bg":"","description":"d","category":"dev","category_name":"开发工具","aliases":[],"default_version":"latest","license":"MIT","stars":1,"forks":0,"is_verified":true,"platforms":["windows"]}]"#;

    fn json(body: &'static str) -> Reply {
        Reply::ok(body).header("Content-Type", "application/json")
    }

    fn dead_url() -> String {
        format!("http://{}/catalog.json", dead_addr())
    }

    #[tokio::test]
    async fn primary_502_falls_back_to_mirror_and_validates() {
        let cat = CatalogService::new_empty();
        let primary = serve(|_| Reply::status("502 Bad Gateway")).await;
        let mirror = serve(|_| json(VALID_ITEM)).await;
        let url = format!("{}/catalog.json", primary.base);
        let f = cat
            .fetch_http_catalog(&url, None, Some(&mirror.base))
            .await
            .expect("mirror fallback should succeed");
        assert_eq!(f.via, CatalogVia::Mirror);
        assert_eq!(f.items.unwrap()[0].id, "o/r");
        // 镜像请求路径为 `{prefix}/{原始 URL}`。
        let line = mirror.requests()[0]
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        assert!(line.starts_with(&format!("GET /{} ", url)), "{line}");
    }

    #[tokio::test]
    async fn primary_connection_refused_falls_back_to_mirror() {
        let cat = CatalogService::new_empty();
        let mirror = serve(|_| json(VALID_ITEM)).await;
        let f = cat
            .fetch_http_catalog(&dead_url(), None, Some(&mirror.base))
            .await
            .unwrap();
        assert_eq!(f.via, CatalogVia::Mirror);
    }

    #[tokio::test]
    async fn primary_404_does_not_fall_back() {
        let cat = CatalogService::new_empty();
        let primary = serve(|_| Reply::status("404 Not Found")).await;
        let mirror = serve(|_| json(VALID_ITEM)).await;
        let err = cat
            .fetch_http_catalog(
                &format!("{}/catalog.json", primary.base),
                None,
                Some(&mirror.base),
            )
            .await
            .unwrap_err();
        assert!(err.contains("404"), "{err}");
        assert_eq!(mirror.hits(), 0);
    }

    #[tokio::test]
    async fn mirror_never_conditional_and_304_rejected() {
        let cat = CatalogService::new_empty();
        // 镜像回 304：未发条件请求却「未修改」，视为异常，不冻结目录。
        let mirror_304 = serve(|_| Reply::status("304 Not Modified")).await;
        let err = cat
            .fetch_http_catalog(&dead_url(), Some("W/\"etag\""), Some(&mirror_304.base))
            .await
            .unwrap_err();
        assert!(err.contains("304"), "{err}");

        // 镜像成功：请求不带 If-None-Match，结果不携带 ETag（不落库镜像校验器）。
        let mirror = serve(|_| json(VALID_ITEM).header("ETag", "\"mirror\"")).await;
        let f = cat
            .fetch_http_catalog(&dead_url(), Some("W/\"etag\""), Some(&mirror.base))
            .await
            .unwrap();
        assert_eq!(f.via, CatalogVia::Mirror);
        assert!(f.etag.is_none());
        assert!(!mirror.requests()[0]
            .to_ascii_lowercase()
            .contains("if-none-match"));
    }

    #[tokio::test]
    async fn mirror_empty_or_invalid_ids_rejected() {
        let cat = CatalogService::new_empty();
        let empty_mirror = serve(|_| json("[]")).await;
        let err = cat
            .fetch_http_catalog(&dead_url(), None, Some(&empty_mirror.base))
            .await
            .unwrap_err();
        assert!(err.contains("镜像清单校验失败"), "{err}");

        let bad_mirror = serve(|_| json(BAD_ID_ITEM)).await;
        let err = cat
            .fetch_http_catalog(&dead_url(), None, Some(&bad_mirror.base))
            .await
            .unwrap_err();
        assert!(err.contains("非法应用标识"), "{err}");
    }

    #[tokio::test]
    async fn custom_source_never_uses_mirror() {
        // 非官方默认源：即便传入镜像前缀，失败也不改写重试。
        let cat = CatalogService::new_empty();
        let mirror = serve(|_| json(VALID_ITEM)).await;
        let custom = dead_url();
        assert!(!crate::github::catalog_service::is_default_catalog_source(
            &custom
        ));
        let res = cat
            .fetch_remote_catalog_with_fallback(&custom, None, Some(&mirror.base))
            .await;
        assert!(res.is_err());
        assert_eq!(mirror.hits(), 0);
    }

    #[tokio::test]
    async fn primary_success_is_direct() {
        let cat = CatalogService::new_empty();
        let primary = serve(|_| json(VALID_ITEM)).await;
        let f = cat
            .fetch_http_catalog(&format!("{}/catalog.json", primary.base), None, None)
            .await
            .unwrap();
        assert_eq!(f.via, CatalogVia::Direct);
    }

    #[test]
    fn catalog_pool_rebuilds_on_proxy_signature_change_and_reuses_otherwise() {
        let cat = CatalogService::new_empty();
        let direct = crate::proxy::ProxySnapshot::direct();
        let proxied = crate::test_support::proxied_snapshot("http://127.0.0.1:7890");
        cat.http_client_for(&direct);
        cat.http_client_for(&direct);
        assert_eq!(
            cat.client.build_count(),
            1,
            "identical signature must reuse"
        );
        cat.http_client_for(&proxied);
        assert_eq!(cat.client.build_count(), 2, "proxy turned on must rebuild");
        cat.http_client_for(&direct);
        assert_eq!(cat.client.build_count(), 3, "proxy turned off must rebuild");
    }

    #[test]
    fn search_alternatives_hits_and_ranks_above_description_match() {
        let cat = CatalogService::new();
        for q in ["TeamViewer", "toDesk", "向日葵"] {
            let res = cat.search_local_catalog(q);
            assert!(!res.is_empty(), "query={q} should return rustdesk");
            assert_eq!(res[0].core.id, "rustdesk/rustdesk", "query={q}");
            assert!(
                res[0].core.alternatives.iter().any(|a| a == "TeamViewer"),
                "alternatives should be projected onto AppSummary"
            );
        }

        let notion = cat.search_local_catalog("Notion");
        assert!(
            notion
                .iter()
                .any(|a| a.core.id == "toeverything/affine" || a.core.id == "appflowy-io/appflowy"),
            "searching Notion should return open-source alternatives"
        );

        let postman = cat.search_local_catalog("Postman");
        assert!(
            postman
                .iter()
                .any(|a| a.core.id == "usebruno/bruno" || a.core.id == "hoppscotch/hoppscotch"),
            "searching Postman should return open-source API tools"
        );
    }
}
