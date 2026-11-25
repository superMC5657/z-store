use super::*;

mod backfill_tests {
    use super::*;

    fn sample_summary(id: &str, owner: &str, repo: &str, icon: &str) -> AppSummary {
        AppSummary {
            core: AppCore {
                id: id.to_string(),
                name: "Demo".to_string(),
                description_en: None,
                owner: owner.to_string(),
                repo: repo.to_string(),
                icon: icon.to_string(),
                icon_bg: String::new(),
                description: String::new(),
                stars: 0,
                forks: 0,
                license: String::new(),
                latest_version: "latest".to_string(),
                category: "external".to_string(),
                category_name: String::new(),
                is_verified: false,
                forge: None,
                forge_host: None,
                homepage: None,
                platforms: Vec::new(),
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
        }
    }

    #[test]
    fn backfill_uncataloged_card_keeps_twin_loop_semantics() {
        // 空图标无 staged 且保持原样 / L2品牌库 staged 构建 /
        // 非品牌库远端只标 L3 live / DB 命中直接覆盖且无 staged（M2回填走via=m2不占level）。
        let db = crate::db::Database::open_in_memory().unwrap();
        let mut empty = sample_summary("o/r", "o", "r", "");
        assert!(backfill_uncataloged_card(&db, &mut empty).is_none());
        assert!(empty.core.icon.is_empty());
        assert!(empty.core.platforms.is_empty());

        let mut l2 = sample_summary("s/i", "s", "i", "https://cdn.simpleicons.org/i");
        let c = backfill_uncataloged_card(&db, &mut l2).expect("l2 staged");
        assert_eq!(c.level, 2);
        assert_eq!(c.l2_url, "https://cdn.simpleicons.org/i");
        assert_eq!(c.selected_url, "https://cdn.simpleicons.org/i");
        assert_eq!(l2.core.icon, "https://cdn.simpleicons.org/i");

        let mut l3 = sample_summary(
            "t/r",
            "t",
            "r",
            "https://raw.githubusercontent.com/t/r/main/icon.png",
        );
        let c3 = backfill_uncataloged_card(&db, &mut l3).expect("l3 staged");
        assert_eq!(c3.level, 3);
        assert_eq!(
            c3.l3_url,
            "https://raw.githubusercontent.com/t/r/main/icon.png"
        );
        assert!(c3.l4_url.is_empty());
        assert_eq!(
            c3.selected_url,
            "https://raw.githubusercontent.com/t/r/main/icon.png"
        );

        let mut cycle = crate::db::AppIconCycle::new("c/r", "c", "r");
        cycle.is_cataloged = false;
        cycle.level = 2;
        cycle.l2_url = "https://example.com/c.png".to_string();
        cycle.selected_url = "https://example.com/c.png".to_string();
        cycle.updated_at = crate::now_secs();
        db.upsert_icon_cycle(&cycle).unwrap();
        let mut confirmed = sample_summary("c/r", "c", "r", "");
        assert!(backfill_uncataloged_card(&db, &mut confirmed).is_none());
        assert_eq!(confirmed.core.icon, "https://example.com/c.png");
    }

    fn release_json(tag: &str, asset: &str) -> String {
        serde_json::json!({
            "tag_name": tag,
            "body": null,
            "assets": [{
                "name": asset,
                "size": 50_000_000u64,
                "browser_download_url": format!("https://github.com/x/y/releases/download/{}/{}", tag, asset)
            }]
        })
        .to_string()
    }

    #[test]
    fn backfill_reads_cached_release_latest_when_no_app_detail() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.save_etag(
            "https://api.github.com/repos/acme/tool/releases/latest",
            "\"e1\"",
            &release_json("v2.3.4", "tool-setup-x64.exe"),
            crate::now_secs(),
        )
        .unwrap();
        // 收录外坐标大小写混合：精确未命中时回退小写端点。
        let mut card = sample_summary("acme/tool", "Acme", "Tool", "");
        backfill_uncataloged_card(&db, &mut card);
        assert_eq!(card.core.platforms, vec!["windows".to_string()]);
        assert_eq!(card.core.latest_version, "v2.3.4");

        // 已有平台与真实版本时不覆盖。
        let mut known = sample_summary("acme/tool", "acme", "tool", "");
        known.core.platforms = vec!["linux".to_string()];
        known.core.latest_version = "v9".to_string();
        backfill_uncataloged_card(&db, &mut known);
        assert_eq!(known.core.platforms, vec!["linux".to_string()]);
        assert_eq!(known.core.latest_version, "v9");

        // 非 GitHub forge 不读 GitHub 端点。
        let mut other = sample_summary("acme/tool", "acme", "tool", "");
        other.core.forge = Some("gitea".to_string());
        backfill_uncataloged_card(&db, &mut other);
        assert!(other.core.platforms.is_empty());

        // 损坏载荷静默跳过。
        db.save_etag(
            "https://api.github.com/repos/bad/json/releases/latest",
            "\"e2\"",
            "not-json",
            crate::now_secs(),
        )
        .unwrap();
        let mut bad = sample_summary("bad/json", "bad", "json", "");
        backfill_uncataloged_card(&db, &mut bad);
        assert!(bad.core.platforms.is_empty());
        assert_eq!(bad.core.latest_version, "latest");
    }

    #[test]
    fn backfill_prefers_app_detail_over_cached_release() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.save_etag(
            "https://api.github.com/repos/acme/tool/releases/latest",
            "\"e1\"",
            &release_json("v0.0.1", "tool-setup-x64.exe"),
            crate::now_secs(),
        )
        .unwrap();
        let mut core = sample_summary("acme/tool", "acme", "tool", "").core;
        core.description = "真实描述".to_string();
        core.latest_version = "v5.0.0".to_string();
        core.platforms = vec!["macos".to_string()];
        let detail = crate::models::AppDetail {
            core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
            is_private: false,
        };
        db.save_app_detail("acme/tool", &detail).unwrap();
        let mut card = sample_summary("acme/tool", "acme", "tool", "");
        backfill_uncataloged_card(&db, &mut card);
        assert_eq!(card.core.platforms, vec!["macos".to_string()]);
        assert_eq!(card.core.latest_version, "v5.0.0");
    }

    fn curated_item() -> crate::github::models::CatalogItem {
        crate::github::models::CatalogItem {
            id: "acme/tool".to_string(),
            name: "精选工具".to_string(),
            owner: "acme".to_string(),
            repo: "tool".to_string(),
            icon: "https://official.example/tool.png".to_string(),
            icon_bg: "#111111".to_string(),
            description: "精选中文简介".to_string(),
            description_en: Some("Curated".to_string()),
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 100,
            forks: 50,
            is_verified: true,
            homepage: None,
            platforms: vec!["windows".to_string(), "linux".to_string()],
            identifiers: std::collections::HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        }
    }

    #[test]
    fn write_through_projects_curated_stages_uncataloged_and_respects_skip() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new_empty();
        catalog.update_items(vec![curated_item()]);
        db.patch_repo_card_platforms("acme/zero", "acme", "zero", &[], None, true)
            .unwrap();
        let mut curated = sample_summary("acme/tool", "acme", "tool", "");
        curated.core.stars = 999;
        let rows = vec![
            RemoteRow {
                summary: curated,
                card: CardWrite::Upsert { is_private: None },
                project_curated: true,
            },
            RemoteRow {
                summary: sample_summary("acme/zero", "acme", "zero", ""),
                card: CardWrite::Upsert {
                    is_private: Some(true),
                },
                project_curated: true,
            },
            RemoteRow {
                summary: sample_summary(
                    "acme/skip",
                    "acme",
                    "skip",
                    "https://cdn.simpleicons.org/skip",
                ),
                card: CardWrite::Skip,
                project_curated: true,
            },
        ];
        let out = write_through_inline(&db, &catalog, rows, None);
        assert_eq!(out.len(), 3, "rows keep input order");

        // 收录行投影精选元数据并保留更大的远端计数，不写单仓富卡。
        assert_eq!(out[0].summary.core.description, "精选中文简介");
        assert_eq!(out[0].summary.core.stars, 999);
        assert_eq!(out[0].summary.core.is_cataloged, Some(true));
        assert!(out[0].had_confirmed_icon);
        assert!(!out[0].needs_icon_probe(&catalog));
        assert!(db.get_repo_card("acme/tool").unwrap().is_none());

        // 未收录行：确认 Other、写富卡（含私有标记）、盖章、需补探。
        assert!(out[1].confirmed_other);
        assert_eq!(out[1].summary.core.is_cataloged, Some(false));
        assert!(out[1].needs_icon_probe(&catalog));
        assert_eq!(out[1].icon_coord().id, "acme/zero");
        let card = db
            .get_repo_card("acme/zero")
            .unwrap()
            .expect("card upserted");
        assert!(card.is_private);

        // Skip 行不写富卡，但首屏图标仍并入图标轮换；SimpleIcons 图标不再补探。
        assert!(db.get_repo_card("acme/skip").unwrap().is_none());
        let cycle = db
            .get_icon_cycle("acme/skip")
            .unwrap()
            .expect("cycle staged");
        assert_eq!(cycle.l2_url, "https://cdn.simpleicons.org/skip");
        assert!(!out[2].needs_icon_probe(&catalog));
    }

    #[test]
    fn recently_viewed_hydrates_catalog_and_cached_rows_and_skips_unknown() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new_empty();
        catalog.update_items(vec![curated_item()]);
        db.upsert_repo_card(&crate::db::RepoCardUpsert {
            summary: sample_summary("acme/cached", "acme", "cached", ""),
            confirmed_other: false,
            is_private: None,
        })
        .unwrap();
        for id in ["ghost/none", "acme/cached", "acme/tool"] {
            db.record_app_view(id).unwrap();
        }
        let (rows, jobs) = recently_viewed_deferred(&db, &catalog, 30).unwrap();
        assert_eq!(jobs.len(), rows.len(), "icon jobs align with rows");
        let ids: Vec<&str> = rows.iter().map(|(s, _)| s.core.id.as_str()).collect();
        assert!(ids.contains(&"acme/tool") && ids.contains(&"acme/cached"));
        assert!(
            !ids.contains(&"ghost/none"),
            "rows without local cache are skipped"
        );
        for (summary, viewed_at) in &rows {
            assert!(*viewed_at > 0);
            let expected = summary.core.id == "acme/tool";
            assert_eq!(summary.core.is_cataloged, Some(expected));
        }
    }

    #[test]
    fn curated_projection_keeps_fresher_counts_and_skips_uncataloged() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::developer_starred::test_support::test_service();
        catalog.update_items(vec![curated_item()]);

        let mut hit = sample_summary("acme/tool", "acme", "tool", "");
        hit.core.description = "remote english".to_string();
        hit.core.stars = 250;
        hit.core.forks = 10;
        assert!(project_curated_hit(&db, &catalog, &mut hit));
        assert_eq!(hit.core.description, "精选中文简介");
        assert_eq!(hit.core.icon, "https://official.example/tool.png");
        assert_eq!(hit.core.category, "dev");
        assert_eq!(
            hit.core.platforms,
            vec!["windows".to_string(), "linux".to_string()]
        );
        assert_eq!(hit.core.stars, 250);
        assert_eq!(hit.core.forks, 50);
        assert_eq!(hit.core.is_cataloged, Some(true));

        let mut miss = sample_summary("other/repo", "other", "repo", "");
        assert!(!project_curated_hit(&db, &catalog, &mut miss));
        assert_eq!(miss.core.description, "");
    }

    #[test]
    fn backfill_uncataloged_card_hydrates_all_fields_from_details_cache_beyond_ttl() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let detail = crate::models::AppDetail {
            core: AppCore {
                id: "acme/rich".to_string(),
                name: "RichApp".to_string(),
                description_en: Some("Real English summary".to_string()),
                owner: "acme".to_string(),
                repo: "rich".to_string(),
                icon: "https://example.com/rich.png".to_string(),
                icon_bg: String::new(),
                description: "真实中文描述".to_string(),
                stars: 500,
                forks: 50,
                license: "Apache-2.0".to_string(),
                latest_version: "v2.4.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://rich.example.com".to_string()),
                platforms: vec!["windows".to_string(), "macos".to_string()],
                is_cataloged: Some(false),
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
            is_private: false,
        };
        db.save_app_detail("acme/rich", &detail).unwrap();
        // 模拟缓存已超过 2 小时（> 1800s TTL）
        db.touch_app_detail("acme/rich", crate::now_secs() - 7200)
            .unwrap();

        let mut card = sample_summary("acme/rich", "acme", "rich", "");
        card.core.description = "开源软件项目".to_string();
        card.core.license = "OpenSource".to_string();
        card.core.latest_version = "latest".to_string();

        let _ = backfill_uncataloged_card(&db, &mut card);
        assert_eq!(card.core.platforms, vec!["windows", "macos"]);
        assert_eq!(card.core.latest_version, "v2.4.0");
        assert_eq!(card.core.description, "真实中文描述");
        assert_eq!(
            card.core.description_en.as_deref(),
            Some("Real English summary")
        );
        assert_eq!(card.core.license, "Apache-2.0");
        assert_eq!(
            card.core.homepage.as_deref(),
            Some("https://rich.example.com")
        );
        assert_eq!(card.core.icon, "https://example.com/rich.png");
    }

    #[test]
    fn resolve_local_enrich_hit_serves_details_and_etag_cache_without_network() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new();

        // 1. 命中 app_details（非占位描述）+ 预确认图标
        let detail = crate::models::AppDetail {
            core: AppCore {
                id: "acme/from-detail".to_string(),
                name: "FromDetail".to_string(),
                description_en: Some("Detail EN".to_string()),
                owner: "acme".to_string(),
                repo: "from-detail".to_string(),
                icon: "data:image/png;base64,AAA".to_string(),
                icon_bg: String::new(),
                description: "详情真实描述".to_string(),
                stars: 321,
                forks: 12,
                license: "MIT".to_string(),
                latest_version: "v1.5.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://detail.example".to_string()),
                platforms: vec!["linux".to_string()],
                is_cataloged: Some(false),
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
            is_private: false,
        };
        db.save_app_detail("acme/from-detail", &detail).unwrap();
        let coord1 = crate::icons::RepoCoord {
            id: "acme/from-detail".to_string(),
            owner: "acme".to_string(),
            repo: "from-detail".to_string(),
        };
        let hit1 = resolve_local_enrich_hit(
            &db,
            &catalog,
            &coord1,
            Some("https://cdn.simpleicons.org/detail"),
            None,
        )
        .expect("should hit app_details");
        assert_eq!(hit1.core.stars, 321);
        assert_eq!(hit1.core.latest_version, "v1.5.0");
        assert_eq!(hit1.core.platforms, vec!["linux"]);
        assert_eq!(hit1.core.icon, "https://cdn.simpleicons.org/detail");

        // 2. app_details 为占位描述时，回退使用 api_etag_cache 仓库 JSON 并合并详情平台与版本
        let mut placeholder_detail = detail.clone();
        placeholder_detail.core.id = "acme/from-etag".to_string();
        placeholder_detail.core.repo = "from-etag".to_string();
        placeholder_detail.core.description = "GitHub 社区开源项目".to_string();
        db.save_app_detail("acme/from-etag", &placeholder_detail)
            .unwrap();
        let repo_json = r#"{
            "name": "FromEtag",
            "description": "Real description from ETag repo payload",
            "stargazers_count": 777,
            "forks_count": 88,
            "homepage": "https://etag.example",
            "license": { "spdx_id": "BSD-3-Clause" },
            "topics": ["developer", "terminal"]
        }"#;
        let coord2 = crate::icons::RepoCoord {
            id: "acme/from-etag".to_string(),
            owner: "acme".to_string(),
            repo: "from-etag".to_string(),
        };
        let hit2 = resolve_local_enrich_hit(&db, &catalog, &coord2, None, Some(repo_json))
            .expect("should hit api_etag_cache and merge detail platforms/version");
        assert_eq!(
            hit2.core.description,
            "Real description from ETag repo payload"
        );
        assert_eq!(hit2.core.stars, 777);
        assert_eq!(hit2.core.license, "BSD-3-Clause");
        assert_eq!(hit2.core.platforms, vec!["linux"]);
        assert_eq!(hit2.core.latest_version, "v1.5.0");
    }

    #[test]
    fn starred_payload_cards_keep_order_and_stamp_uncataloged() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new();
        let body = serde_json::json!([
            {"name": "Zeta", "full_name": "acme/zeta", "description": "Zeta tool",
             "stargazers_count": 42u64, "forks_count": 3u64},
            {"name": "Alpha", "full_name": "acme/alpha", "description": "Alpha lib",
             "stargazers_count": 7u64}
        ])
        .to_string();
        let items = crate::github::developer_starred::parse_starred_payloads(&body).unwrap();
        let StarredCards {
            rows, need_icon, ..
        } = cards_from_repo_payloads(&db, &catalog, items, true);
        let ids: Vec<&str> = rows.iter().map(|r| r.core.id.as_str()).collect();
        assert_eq!(ids, vec!["acme/zeta", "acme/alpha"]);
        assert_eq!(rows[0].core.description, "Zeta tool");
        assert_eq!(rows[0].core.stars, 42);
        assert_eq!(rows[0].core.is_cataloged, Some(false));
        // 无确认图标的未收录行进入后台补图。
        assert_eq!(need_icon.len(), 2);

        // 已收录目录项不进入后台补图队列。
        let catalog_with_item = crate::github::CatalogService::new_empty();
        catalog_with_item.update_items(vec![crate::github::CatalogItem {
            id: "acme/zeta".to_string(),
            name: "Zeta".to_string(),
            description: "Zeta".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            icon: "https://example.com/zeta.png".to_string(),
            icon_bg: String::new(),
            stars: 10,
            forks: 1,
            license: "MIT".to_string(),
            default_version: "v1.0.0".to_string(),
            is_verified: true,
            owner: "acme".to_string(),
            repo: "zeta".to_string(),
            platforms: vec!["windows".to_string()],
            identifiers: Default::default(),
            aliases: vec![],
            alternatives: Vec::new(),
            install_dirs: vec![],
            publishers: vec![],
            search_subdirs: vec![],
            homepage: None,
            added_at: None,
        }]);
        let body2 = serde_json::json!([
            {"name": "Zeta", "full_name": "acme/zeta"},
            {"name": "Alpha", "full_name": "acme/alpha"}
        ])
        .to_string();
        let items2 = crate::github::developer_starred::parse_starred_payloads(&body2).unwrap();
        let StarredCards {
            rows: rows2,
            need_icon: need_icon2,
            ..
        } = cards_from_repo_payloads(&db, &catalog_with_item, items2, true);
        assert_eq!(rows2[0].core.is_cataloged, Some(true));
        assert_eq!(need_icon2.len(), 1);
        assert_eq!(need_icon2[0].id, "acme/alpha");
    }

    #[test]
    fn detail_writeback_updates_catalog_apps_and_preserves_official_icon() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let seed_items = vec![
            crate::github::CatalogItem {
                id: "acme/with-icon".to_string(),
                name: "WithIcon".to_string(),
                description: "desc".to_string(),
                description_en: None,
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                icon: "https://official.example/logo.png".to_string(),
                icon_bg: String::new(),
                stars: 10,
                forks: 1,
                license: "OpenSource".to_string(),
                default_version: "v1.0.0".to_string(),
                is_verified: true,
                owner: "acme".to_string(),
                repo: "with-icon".to_string(),
                platforms: vec![],
                identifiers: Default::default(),
                aliases: vec![],
                alternatives: Vec::new(),
                install_dirs: vec![],
                publishers: vec![],
                search_subdirs: vec![],
                homepage: None,
                added_at: None,
            },
            crate::github::CatalogItem {
                id: "acme/no-icon".to_string(),
                name: "NoIcon".to_string(),
                description: "desc".to_string(),
                description_en: None,
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                stars: 5,
                forks: 0,
                license: "unknown".to_string(),
                default_version: "latest".to_string(),
                is_verified: false,
                owner: "acme".to_string(),
                repo: "no-icon".to_string(),
                platforms: vec![],
                identifiers: Default::default(),
                aliases: vec![],
                alternatives: Vec::new(),
                install_dirs: vec![],
                publishers: vec![],
                search_subdirs: vec![],
                homepage: None,
                added_at: None,
            },
        ];
        db.seed_catalog_apps_if_empty(&seed_items).unwrap();

        let mut d1 = sample_summary(
            "acme/with-icon",
            "acme",
            "with-icon",
            "https://probed.example/other.png",
        );
        d1.core.stars = 999;
        d1.core.latest_version = "v2.0.0".to_string();
        d1.core.license = "MIT".to_string();
        d1.core.platforms = vec!["windows".to_string()];
        let detail1 = crate::models::AppDetail {
            core: d1.core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
            is_private: false,
        };
        crate::repositories::DetailRepository::persist_detail_bundle(
            &db,
            "acme/with-icon",
            &detail1,
            None,
            &[],
        )
        .unwrap();

        let mut d2 = sample_summary(
            "acme/no-icon",
            "acme",
            "no-icon",
            "https://probed.example/filled.png",
        );
        d2.core.stars = 50;
        d2.core.latest_version = "v1.1.0".to_string();
        let detail2 = crate::models::AppDetail {
            core: d2.core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
            is_private: false,
        };
        crate::repositories::DetailRepository::persist_detail_bundle(
            &db,
            "acme/no-icon",
            &detail2,
            None,
            &[],
        )
        .unwrap();

        let catalog = crate::github::CatalogService::new_empty();
        catalog.sync_from_db(&db);

        let item1 = catalog.get_catalog_item("acme/with-icon").unwrap();
        assert_eq!(item1.stars, 999);
        assert_eq!(item1.default_version, "v2.0.0");
        assert_eq!(item1.license, "MIT");
        assert_eq!(item1.platforms, vec!["windows"]);
        assert_eq!(
            item1.icon, "https://official.example/logo.png",
            "existing catalog icon must not be overwritten by detail probe"
        );

        let item2 = catalog.get_catalog_item("acme/no-icon").unwrap();
        assert_eq!(item2.stars, 50);
        assert_eq!(item2.default_version, "v1.1.0");
        assert_eq!(
            item2.icon, "https://probed.example/filled.png",
            "empty catalog icon should be filled from detail HTTP icon"
        );
    }
}

mod repo_card_pipeline_tests {
    use super::*;

    #[test]
    fn starred_cards_persist_private_flag_and_report_confirmed_other() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new_empty();
        db.patch_repo_card_platforms("acme/zero", "acme", "zero", &[], None, true)
            .unwrap();
        let body = serde_json::json!([
            {"name": "secret", "full_name": "me/secret", "description": "Private tool",
             "stargazers_count": 1u64, "private": true},
            {"name": "zero", "full_name": "acme/zero", "description": "No releases",
             "stargazers_count": 9u64, "visibility": "public"}
        ])
        .to_string();
        let items = crate::github::developer_starred::parse_starred_payloads(&body).unwrap();
        let cards = cards_from_repo_payloads(&db, &catalog, items, true);
        assert_eq!(cards.private_ids, vec!["me/secret"]);
        assert_eq!(cards.confirmed_other_ids, vec!["acme/zero"]);

        let secret = db
            .get_repo_card("me/secret")
            .unwrap()
            .expect("card persisted");
        assert!(secret.is_private);
        assert_eq!(secret.summary.core.description, "Private tool");
        let zero = db
            .get_repo_card("acme/zero")
            .unwrap()
            .expect("preseed upgraded");
        assert!(zero.confirmed_other);
        assert_eq!(zero.summary.core.stars, 9);

        db.delete_private_repo_cards().unwrap();
        assert!(db.get_repo_card("me/secret").unwrap().is_none());
    }

    #[test]
    fn stale_starred_page_does_not_write_repo_cards() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new_empty();
        let body = serde_json::json!([{"name": "x", "full_name": "acme/x"}]).to_string();
        let items = crate::github::developer_starred::parse_starred_payloads(&body).unwrap();
        let cards = cards_from_repo_payloads(&db, &catalog, items, false);
        assert_eq!(cards.rows.len(), 1);
        assert!(db.get_repo_card("acme/x").unwrap().is_none());
    }

    #[test]
    fn backfill_fills_placeholders_from_repo_card_and_fresh_card_serves_enrich_hit() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new_empty();
        let mut full = AppSummary {
            core: AppCore {
                id: "acme/tool".to_string(),
                name: "tool".to_string(),
                description_en: Some("Real".to_string()),
                owner: "acme".to_string(),
                repo: "tool".to_string(),
                icon: "https://avatars.githubusercontent.com/u/3".to_string(),
                icon_bg: String::new(),
                description: "Real".to_string(),
                stars: 5,
                forks: 0,
                license: "MIT".to_string(),
                latest_version: "v3.0.0".to_string(),
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://tool.example".to_string()),
                platforms: vec!["macos".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
        };
        db.upsert_repo_card(&crate::db::RepoCardUpsert {
            summary: full.clone(),
            confirmed_other: false,
            is_private: None,
        })
        .unwrap();

        full.core.description = "开源软件项目".to_string();
        full.core.description_en = None;
        full.core.license = "OpenSource".to_string();
        full.core.latest_version = "latest".to_string();
        full.core.homepage = None;
        full.core.icon = String::new();
        full.core.platforms = vec![];
        backfill_uncataloged_card(&db, &mut full);
        assert_eq!(full.core.description, "Real");
        assert_eq!(full.core.description_en.as_deref(), Some("Real"));
        assert_eq!(full.core.license, "MIT");
        assert_eq!(full.core.latest_version, "v3.0.0");
        assert_eq!(full.core.homepage.as_deref(), Some("https://tool.example"));
        assert_eq!(full.core.platforms, vec!["macos"]);

        let coord = crate::icons::RepoCoord {
            id: "acme/tool".to_string(),
            owner: "acme".to_string(),
            repo: "tool".to_string(),
        };
        let (hit, source) =
            resolve_local_enrich_hit_sourced(&db, &catalog, &coord, None, None, true).unwrap();
        assert_eq!(source, LocalHitSource::RepoCard);
        assert_eq!(hit.core.stars, 5);
        assert!(
            resolve_local_enrich_hit_sourced(&db, &catalog, &coord, None, None, false).is_none()
        );
    }

    #[test]
    fn backfill_ctx_enforces_12h_soft_ttl_on_api_etag_cache() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new();
        let coord = crate::icons::RepoCoord {
            id: "acme/soft-ttl".to_string(),
            owner: "acme".to_string(),
            repo: "soft-ttl".to_string(),
        };
        let url = crate::github::github_repo_endpoint(&coord.owner, &coord.repo);
        let payload = r#"{
            "name": "soft-ttl",
            "description": "Cached repo payload",
            "stargazers_count": 42,
            "forks_count": 3
        }"#;
        let checked_at = 1_700_000_000i64;
        db.save_etag(&url, "W/\"e1\"", payload, checked_at).unwrap();

        let mut keys = super::PrefetchKeys::default();
        keys.add_coord(&coord, true);
        let ctx = super::BackfillCtx::load_inline(&db, &keys, None);
        assert_eq!(ctx.etag(&url).as_deref(), Some("W/\"e1\""));

        // 未满 12h：返回载荷并可零网络命中
        let fresh =
            ctx.fresh_etag_payload(&url, checked_at + 3600, super::ENRICH_ETAG_SOFT_TTL_SECS);
        assert!(fresh.is_some());
        let (hit, source) = super::resolve_local_enrich_hit_in(
            &ctx,
            &catalog,
            &coord,
            None,
            fresh.as_deref(),
            true,
        )
        .unwrap();
        assert_eq!(source, super::LocalHitSource::Payload);
        assert_eq!(hit.core.stars, 42);

        // 满 12h：soft TTL 返回 None，必须进入条件请求队列携带 ETag 校验 304
        assert!(ctx
            .fresh_etag_payload(
                &url,
                checked_at + super::ENRICH_ETAG_SOFT_TTL_SECS,
                super::ENRICH_ETAG_SOFT_TTL_SECS,
            )
            .is_none());
        // 时钟回拨（now < last_checked_at）：同样不复用软缓存
        assert!(ctx
            .fresh_etag_payload(&url, checked_at - 10, super::ENRICH_ETAG_SOFT_TTL_SECS)
            .is_none());
    }
}

mod cached_summary_tests {
    fn batch_detail(id: &str, icon: &str) -> crate::models::AppDetail {
        crate::models::AppDetail {
            core: crate::models::AppCore {
                id: id.to_string(),
                name: "Demo App".to_string(),
                description_en: None,
                owner: "demo".to_string(),
                repo: "app".to_string(),
                icon: icon.to_string(),
                icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                description: "演示应用".to_string(),
                stars: 7,
                forks: 3,
                license: "MIT".to_string(),
                latest_version: "v1.2.3".to_string(),
                is_verified: false,
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: vec!["windows".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
            is_private: false,
        }
    }

    #[test]
    fn cached_batch_hit_projects_detail_with_platforms() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.save_app_detail(
            "demo/app",
            &batch_detail("demo/app", "https://example.com/icon.png"),
        )
        .unwrap();
        let hit = super::cached_detail_summary(&db, "demo/app").expect("缓存行应当命中");
        assert_eq!(hit.core.id, "demo/app");
        assert_eq!(hit.core.name, "Demo App");
        assert_eq!(hit.core.icon, "https://example.com/icon.png");
        assert_eq!(hit.core.platforms, vec!["windows".to_string()]);
        assert_eq!(hit.core.latest_version, "v1.2.3");
    }

    #[test]
    fn cached_batch_miss_and_invalid_id_yield_none() {
        let db = crate::db::Database::open_in_memory().unwrap();
        assert!(super::cached_detail_summary(&db, "ghost/nobody").is_none());
        assert!(super::cached_detail_summary(&db, "not an id !!!").is_none());
        assert!(super::cached_detail_summary(&db, "   ").is_none());
    }

    #[test]
    fn cached_batch_blanks_data_icon_without_confirmed() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.save_app_detail(
            "demo/app",
            &batch_detail("demo/app", "data:image/png;base64,AAA"),
        )
        .unwrap();
        let hit = super::cached_detail_summary(&db, "demo/app").expect("缓存行应当命中");
        assert_eq!(hit.core.icon, "", "无确认图标时 data: 详情图标必须置空");
    }
}

mod repo_card_hydration_tests {
    use super::*;
    use crate::db::{Database, RepoCardUpsert};

    fn test_state() -> AppState {
        AppState {
            db: std::sync::Arc::new(std::sync::Mutex::new(Database::open_in_memory().unwrap())),
            catalog: crate::github::CatalogService::new_empty(),
            mirror: std::sync::Mutex::new(crate::mirror::MirrorManager::new()),
            github_token: std::sync::Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            startup_catalog_synced: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn card(id: &str, platforms: &[&str], confirmed_other: bool) -> RepoCardUpsert {
        let (owner, repo) = id.split_once('/').unwrap();
        RepoCardUpsert {
            summary: AppSummary {
                core: AppCore {
                    id: id.to_string(),
                    name: repo.to_string(),
                    description_en: None,
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    icon: "https://avatars.githubusercontent.com/u/9".to_string(),
                    icon_bg: String::new(),
                    description: "Real tool".to_string(),
                    stars: 42,
                    forks: 1,
                    license: "MIT".to_string(),
                    latest_version: "v1.0.0".to_string(),
                    category: "external".to_string(),
                    category_name: "跨平台开源".to_string(),
                    is_verified: false,
                    forge: Some("github".to_string()),
                    forge_host: Some("github.com".to_string()),
                    homepage: None,
                    platforms: platforms.iter().map(|p| p.to_string()).collect(),
                    is_cataloged: Some(false),
                    source: None,
                    status: None,
                    added_at: None,
                    alternatives: Vec::new(),
                },
            },
            confirmed_other,
            is_private: Some(false),
        }
    }

    fn curated(id: &str) -> crate::github::CatalogItem {
        let (owner, repo) = id.split_once('/').unwrap();
        crate::github::CatalogItem {
            id: id.to_string(),
            name: "精选".to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: "https://official.example/logo.png".to_string(),
            icon_bg: String::new(),
            description: "精选简介".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v9".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 1,
            forks: 1,
            is_verified: true,
            homepage: None,
            platforms: vec!["windows".to_string()],
            identifiers: Default::default(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        }
    }

    #[test]
    fn hydrate_repo_cards_keeps_order_prefers_catalog_and_touches_rows() {
        let state = test_state();
        state.catalog.update_items(vec![curated("acme/curated")]);
        let db = state.db().unwrap();
        db.upsert_repo_cards_batch(&[card("acme/a", &["linux"], false), card("acme/b", &[], true)])
            .unwrap();
        db.exec_write("UPDATE repo_card_cache SET last_accessed_at = 5", [])
            .unwrap();
        let mut cycle = crate::db::AppIconCycle::new("acme/b", "acme", "b");
        cycle.level = 2;
        cycle.l2_url = "https://cdn.simpleicons.org/b".to_string();
        cycle.selected_url = "https://cdn.simpleicons.org/b".to_string();
        cycle.updated_at = crate::now_secs();
        db.upsert_icon_cycle(&cycle).unwrap();

        let ids = vec![
            "acme/b".to_string(),
            "bad id".to_string(),
            "acme/curated".to_string(),
            "acme/missing".to_string(),
            "ACME/A".to_string(),
        ];
        let out = hydrate_repo_cards(&db, &state.catalog, &ids, 1_000);
        assert_eq!(out.len(), 5);
        let b = out[0].as_ref().unwrap();
        assert_eq!(b.summary.core.id, "acme/b");
        assert!(b.confirmed_other);
        assert_eq!(b.summary.core.icon, "https://cdn.simpleicons.org/b");
        assert_eq!(b.summary.core.is_cataloged, Some(false));
        assert!(out[1].is_none());
        let curated = out[2].as_ref().unwrap();
        assert_eq!(curated.summary.core.description, "精选简介");
        assert_eq!(curated.summary.core.is_cataloged, Some(true));
        assert!(out[3].is_none());
        assert_eq!(
            out[4].as_ref().unwrap().summary.core.platforms,
            vec!["linux"]
        );

        let touched = db.get_repo_card("acme/a").unwrap().unwrap();
        assert_eq!(touched.last_accessed_at, 1_000);
        // 收录章只在线上投影，不写回表。
        assert_eq!(touched.summary.core.is_cataloged, None);
    }

    #[test]
    fn cached_or_catalog_summary_falls_back_to_catalog_without_cache_rows() {
        let state = test_state();
        let mut remote = curated("acme/curated");
        remote.platforms = vec!["windows".to_string(), "macos".to_string()];
        state.catalog.update_items(vec![remote]);
        let mut local = curated("acme/local");
        local.name = "本地库".to_string();
        local.is_verified = false;
        local.platforms = vec!["linux".to_string()];
        state.catalog.set_collected_items(vec![local]);
        let db = state.db().unwrap();
        let icons_dir = std::env::temp_dir().join("z-store-test-no-icons");

        let remote_hit =
            resolve_cached_or_catalog_summary(&db, &state.catalog, &icons_dir, "ACME/Curated")
                .expect("remote catalog fallback");
        assert_eq!(remote_hit.core.id, "acme/curated");
        assert_eq!(remote_hit.core.name, "精选");
        assert_eq!(remote_hit.core.platforms, vec!["windows", "macos"]);
        assert_eq!(remote_hit.core.is_cataloged, Some(true));
        assert_eq!(remote_hit.core.icon, "https://official.example/logo.png");

        let local_hit =
            resolve_cached_or_catalog_summary(&db, &state.catalog, &icons_dir, "acme/local")
                .expect("local catalog fallback");
        assert_eq!(local_hit.core.name, "本地库");
        assert_eq!(local_hit.core.platforms, vec!["linux"]);
        assert_eq!(local_hit.core.is_cataloged, Some(true));

        assert!(
            resolve_cached_or_catalog_summary(&db, &state.catalog, &icons_dir, "acme/missing")
                .is_none()
        );
        assert!(
            resolve_cached_or_catalog_summary(&db, &state.catalog, &icons_dir, "bad id").is_none()
        );
    }

    #[test]
    fn resolve_collection_apps_preserves_order_and_hydrates_all_tiers() {
        let state = test_state();
        state.catalog.update_items(vec![curated("acme/curated")]);
        let mut local = curated("acme/local");
        local.name = "Local Pick".to_string();
        local.is_verified = false;
        state.catalog.set_collected_items(vec![local]);

        let db = state.db().unwrap();
        db.upsert_repo_cards_batch(&[card("acme/cached-card", &["linux"], false)])
            .unwrap();

        let mut detail = crate::models::AppDetail {
            core: card("acme/cached-detail", &["macos"], false).summary.core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
            is_private: false,
        };
        detail.core.name = "Cached Detail App".to_string();
        db.save_app_detail("acme/cached-detail", &detail).unwrap();

        let input = vec![
            "bad-id".to_string(),
            "ACME/Curated".to_string(),
            "acme/cached-card".to_string(),
            "acme/curated".to_string(), // duplicate should be dropped
            "acme/cached-detail".to_string(),
            "codeberg:FreeTubeApp/FreeTube".to_string(),
            "acme/local".to_string(),
        ];
        let out = resolve_collection_apps_sync(&db, &state.catalog, &input, 2_000);
        assert_eq!(
            out.iter().map(|s| s.core.id.as_str()).collect::<Vec<_>>(),
            vec![
                "acme/curated",
                "acme/cached-card",
                "acme/cached-detail",
                "codeberg:freetubeapp/freetube",
                "acme/local",
            ]
        );
        assert_eq!(out[0].core.is_cataloged, Some(true));
        assert_eq!(out[1].core.is_cataloged, Some(false));
        assert_eq!(out[1].core.platforms, vec!["linux"]);
        assert_eq!(out[2].core.is_cataloged, Some(false));
        assert_eq!(out[2].core.name, "Cached Detail App");
        assert_eq!(out[2].core.platforms, vec!["macos"]);
        assert_eq!(out[3].core.is_cataloged, Some(false));
        assert_eq!(out[3].core.name, "freetube");
        assert_eq!(out[3].core.forge.as_deref(), Some("codeberg"));
        assert_eq!(out[3].core.forge_host.as_deref(), Some("codeberg.org"));
        assert!(out[3].core.platforms.is_empty());
        assert_eq!(out[4].core.is_cataloged, Some(true));
        assert_eq!(out[4].core.name, "Local Pick");
    }
}

mod recent_uncataloged_tests {
    use crate::db::Database;
    use crate::models::{AppCore, AppDetail};

    fn uncataloged_detail(id: &str, icon: &str) -> AppDetail {
        AppDetail {
            core: AppCore {
                id: id.to_string(),
                name: "Oh My Pi".to_string(),
                description_en: Some("Raspberry Pi tool".to_string()),
                owner: "oh-my-pi".to_string(),
                repo: "oh-my-pi".to_string(),
                icon: icon.to_string(),
                icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                description: "树莓派工具".to_string(),
                stars: 123,
                forks: 45,
                license: "MIT".to_string(),
                latest_version: "v2.0.0".to_string(),
                is_verified: false,
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://example.com".to_string()),
                platforms: vec!["windows".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
            is_private: false,
        }
    }

    #[test]
    fn test_uncataloged_detail_falls_back_to_summary() {
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail(
            "oh-my-pi/oh-my-pi",
            &uncataloged_detail("oh-my-pi/oh-my-pi", "https://example.com/icon.png"),
        )
        .unwrap();
        db.record_app_view("oh-my-pi/oh-my-pi").unwrap();
        let ids = db.get_recently_viewed_app_ids().unwrap();
        assert!(ids.contains(&"oh-my-pi/oh-my-pi".to_string()));
        let summary =
            super::recent_detail_summary(&db, "oh-my-pi/oh-my-pi").expect("未收录详情应当回退命中");
        assert_eq!(summary.core.id, "oh-my-pi/oh-my-pi");
        assert_eq!(summary.core.name, "Oh My Pi");
        assert_eq!(summary.core.icon, "https://example.com/icon.png");
        assert_eq!(summary.core.platforms, vec!["windows".to_string()]);
        assert_eq!(
            summary.core.homepage.as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn test_uncataloged_icon_and_case_alias_hit() {
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail(
            "oh-my-pi/oh-my-pi",
            &uncataloged_detail(
                "oh-my-pi/oh-my-pi",
                "https://avatars.githubusercontent.com/u/123?v=4",
            ),
        )
        .unwrap();
        // 大小写变体经回退键命中同一行
        let summary =
            super::recent_detail_summary(&db, "Oh-My-Pi/Oh-My-Pi").expect("大小写变体应当回退命中");
        assert_eq!(
            summary.core.icon,
            "https://avatars.githubusercontent.com/u/123?v=4",
        );
        assert_eq!(summary.core.owner, "oh-my-pi");
        // 无任何缓存的 id 直接跳过（不合成占位）
        assert!(super::recent_detail_summary(&db, "ghost/nobody").is_none());
    }

    fn placeholder_detail(id: &str) -> AppDetail {
        let mut d = uncataloged_detail(id, "https://example.com/icon.png");
        d.core.description = "GitHub 社区开源项目".to_string();
        d.core.description_en = Some("GitHub 社区开源项目".to_string());
        d
    }

    #[test]
    fn test_placeholder_summary_blanked_when_no_repo_real() {
        // 无 ETag repo 真值时，占位必须转空（前端走“暂无简介”而不显示占位文案）。
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail("demo/placeholder", &placeholder_detail("demo/placeholder"))
            .unwrap();
        let summary =
            super::recent_detail_summary(&db, "demo/placeholder").expect("占位详情应当回退命中");
        assert_eq!(summary.core.description, "", "占位中文简介应当置空");
        assert_eq!(
            summary.core.description_en.as_deref(),
            Some(""),
            "占位英文简介应当置空为 Some(\"\")（保留前端 enrich 治愈机会）"
        );
    }

    #[test]
    fn test_placeholder_summary_backfilled_from_etag_repo_real() {
        // ETag 有 repo 真值时，占位应当回填真值而非置空。
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail("demo/placeholder", &placeholder_detail("demo/placeholder"))
            .unwrap();
        db.save_etag(
            "https://api.github.com/repos/oh-my-pi/oh-my-pi",
            "etag-demo",
            r#"{"description": "Real repo description"}"#,
            crate::now_secs(),
        )
        .unwrap();
        // detail 行 owner/repo 为 oh-my-pi/oh-my-pi（见 uncataloged_detail），
        // id 键 demo/placeholder 经 fallback 命中同一行后按 owner/repo 查 ETag。
        let summary =
            super::recent_detail_summary(&db, "demo/placeholder").expect("占位详情应当回退命中");
        assert_eq!(summary.core.description, "Real repo description");
        assert_eq!(
            summary.core.description_en.as_deref(),
            Some("Real repo description")
        );
    }

    #[test]
    fn test_non_placeholder_description_preserved() {
        // 非占位人工简介不得被覆盖。
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        db.save_app_detail(
            "oh-my-pi/oh-my-pi",
            &uncataloged_detail("oh-my-pi/oh-my-pi", "https://example.com/icon.png"),
        )
        .unwrap();
        db.save_etag(
            "https://api.github.com/repos/oh-my-pi/oh-my-pi",
            "etag-demo",
            r#"{"description": "Real repo description"}"#,
            crate::now_secs(),
        )
        .unwrap();
        let summary =
            super::recent_detail_summary(&db, "oh-my-pi/oh-my-pi").expect("非占位详情应当回退命中");
        assert_eq!(
            summary.core.description, "树莓派工具",
            "人工简介优先，不覆盖"
        );
        assert_eq!(
            summary.core.description_en.as_deref(),
            Some("Raspberry Pi tool")
        );
    }
}
