//! 详情仓储：统一协调 `app_details`、`catalog_apps` 回写、`app_icon_cycles` 与 `api_etag_cache` 原子提交。

use crate::db::{AppIconCycle, Database};
use crate::github::CatalogService;
use crate::models::{AppCore, AppDetail, AppSummary};
use rusqlite::Result;

/// 待落盘的 ETag 条件请求记录。
#[derive(Debug, Clone)]
pub struct EtagWrite {
    pub url: String,
    pub etag: String,
    pub payload: String,
    pub timestamp: i64,
}

pub struct DetailRepository;

impl DetailRepository {
    /// 单事务原子落库：`app_details` + 回写 `catalog_apps` + 可选 `app_icon_cycles` + `api_etag_cache`。
    pub fn persist_detail_bundle(
        db: &Database,
        app_id: &str,
        detail: &AppDetail,
        cycle: Option<&AppIconCycle>,
        etag_writes: &[EtagWrite],
    ) -> Result<()> {
        db.with_immediate_transaction(|| {
            db.save_app_detail(app_id, detail)?;
            let _ = db.update_catalog_app_from_detail(detail)?;
            if let Some(c) = cycle {
                db.upsert_icon_cycle(c)?;
            }
            for w in etag_writes {
                db.save_etag(&w.url, &w.etag, &w.payload, w.timestamp)?;
            }
            Ok(())
        })
    }

    /// 304 命中时保鲜：刷新 `app_details.cached_at` 并按需回写 `catalog_apps` 最新统计与 `api_etag_cache`。
    pub fn refresh_on_not_modified(
        db: &Database,
        app_id: &str,
        detail: &AppDetail,
        now: i64,
        etag_writes: &[EtagWrite],
    ) -> Result<()> {
        db.with_immediate_transaction(|| {
            db.touch_app_detail(app_id, now)?;
            let _ = db.update_catalog_app_from_detail(detail)?;
            for w in etag_writes {
                db.save_etag(&w.url, &w.etag, &w.payload, w.timestamp)?;
            }
            Ok(())
        })
    }

    /// 从 `app_details` 读取详情并叠加目录精校元数据与收录标记。
    pub fn project_detail(
        db: &Database,
        catalog: &CatalogService,
        clean_id: &str,
        ttl_seconds: Option<i64>,
        mark_stale: bool,
    ) -> Option<AppDetail> {
        let mut detail = db.get_app_detail(clean_id, ttl_seconds).ok().flatten()?;
        detail.core.id = clean_id.to_string();
        if mark_stale {
            detail.is_stale = Some(true);
        }
        if let Some(cat_item) = catalog.get_catalog_item(clean_id) {
            cat_item.overlay_detail_core(&mut detail.core);
        }
        catalog.stamp_detail(&mut detail);
        Some(detail)
    }

    /// DB-only 投影：`app_details` 子集转 `AppSummary`，叠加确认图标。
    pub fn cached_detail_summary(db: &Database, raw_id: &str) -> Option<AppSummary> {
        let clean_id = crate::forge::canonical_app_id(raw_id)?;
        let detail = db.get_app_detail(&clean_id, None).ok().flatten()?;
        let icon_trimmed = detail.core.icon.trim();
        let mut summary = AppSummary {
            core: AppCore {
                icon: if icon_trimmed.is_empty() || icon_trimmed.starts_with("data:") {
                    String::new()
                } else {
                    detail.core.icon.clone()
                },
                is_cataloged: None,
                source: None,
                status: None,
                ..detail.core.clone()
            },
        };
        if let Some(ci) = crate::icons::resolve_confirmed_icon_from_db(
            db,
            &summary.core.id,
            &summary.core.owner,
            &summary.core.repo,
        ) {
            summary.core.icon = ci;
        }
        Some(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::models::CatalogItem;
    use std::collections::HashMap;

    fn catalog_item(id: &str) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            name: "Curated Name".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
            icon: "https://official.example/icon.png".to_string(),
            icon_bg: "#111111".to_string(),
            description: "Curated Desc".to_string(),
            description_en: Some("Curated Desc EN".to_string()),
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            added_at: Some("2026-10-01".to_string()),
            license: "MIT".to_string(),
            stars: 10,
            forks: 1,
            is_verified: true,
            homepage: Some("https://example.com".to_string()),
            platforms: vec![],
            identifiers: HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        }
    }

    fn detail_payload(id: &str) -> AppDetail {
        AppDetail {
            core: AppCore {
                id: id.to_string(),
                name: "Repo Name".to_string(),
                description_en: Some("Repo EN".to_string()),
                owner: "o".to_string(),
                repo: "r".to_string(),
                icon: "https://fallback.example/icon.png".to_string(),
                icon_bg: "#222222".to_string(),
                description: "Repo Desc".to_string(),
                stars: 888,
                forks: 99,
                license: "Apache-2.0".to_string(),
                latest_version: "v2.5.0".to_string(),
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://updated.example.com".to_string()),
                platforms: vec!["windows".to_string(), "linux".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
            },
            changelog: "## v2.5.0".to_string(),
            readme_markdown: "# Readme".to_string(),
            readme_variants: None,
            releases: vec![],
            cached_at: Some(1700000000),
            is_stale: None,
        }
    }

    #[test]
    fn persist_detail_bundle_writes_details_syncs_catalog_and_projects_curated_overlay() {
        let db = Database::open_in_memory().unwrap();
        db.seed_catalog_apps_if_empty(&[catalog_item("o/r")])
            .unwrap();

        let detail = detail_payload("o/r");
        let etags = vec![EtagWrite {
            url: "https://api.github.com/repos/o/r/releases/latest".to_string(),
            etag: "W/\"v2\"".to_string(),
            payload: "{}".to_string(),
            timestamp: 1700000000,
        }];
        DetailRepository::persist_detail_bundle(&db, "o/r", &detail, None, &etags).unwrap();

        // 1. app_details 表保存完整详情
        let stored_detail = db.get_app_detail("o/r", None).unwrap().unwrap();
        assert_eq!(stored_detail.readme_markdown, "# Readme");
        assert_eq!(stored_detail.core.latest_version, "v2.5.0");

        // 2. catalog_apps 同步更新保鲜字段，保留官方图标
        let cat = db.get_catalog_app("o/r").unwrap().unwrap();
        assert_eq!(cat.stars, 888);
        assert_eq!(cat.forks, 99);
        assert_eq!(cat.default_version, "v2.5.0");
        assert_eq!(cat.platforms, vec!["windows", "linux"]);
        assert_eq!(cat.icon, "https://official.example/icon.png");

        // 3. api_etag_cache 在同事务落盘
        assert_eq!(
            db.get_etag("https://api.github.com/repos/o/r/releases/latest")
                .unwrap()
                .as_deref(),
            Some("W/\"v2\"")
        );

        // 4. 详情页载入投影：读取 app_details 并叠加 catalog_apps 精校元数据
        let svc = CatalogService::new_empty();
        svc.sync_from_db(&db);
        let projected = DetailRepository::project_detail(&db, &svc, "o/r", Some(3600), false)
            .expect("should project detail from app_details + catalog_apps");
        assert_eq!(projected.core.name, "Curated Name");
        assert_eq!(projected.core.icon, "https://official.example/icon.png");
        assert_eq!(projected.core.stars, 888);
        assert_eq!(projected.core.is_cataloged, Some(true));
        assert_eq!(projected.core.source.as_deref(), Some("remote"));
    }
}
