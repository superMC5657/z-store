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
    /// 单事务原子落库：`app_details` + 回写 `catalog_apps` 与活跃本地库 `custom_apps` + 可选 `app_icon_cycles` + `api_etag_cache`，
    /// 未收录应用同事务更新 `repo_card_cache`（平台为空即确认 Other；私有标记取本次或缓存的仓库 JSON）。
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
            let _ = db.update_custom_app_from_detail(detail)?;
            if let Some(c) = cycle {
                db.upsert_icon_cycle(c)?;
            }
            for w in etag_writes {
                db.save_etag(&w.url, &w.etag, &w.payload, w.timestamp)?;
            }
            let card = crate::db::RepoCardUpsert {
                summary: AppSummary {
                    core: detail.core.clone(),
                },
                confirmed_other: detail.core.platforms.is_empty(),
                is_private: repo_private_flag(db, &detail.core, etag_writes),
            };
            // 已收录（精选或本地库）id 由 DAO 跳过。
            db.upsert_repo_card(&card)?;
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
        let cat_item = catalog.get_catalog_item(clean_id);
        crate::github::detail_assets::heal_cached_detail(&mut detail, cat_item.as_ref());
        catalog.stamp_detail(&mut detail);
        Some(detail)
    }

    /// DB-only 投影：`app_details` 子集转 `AppSummary`，叠加确认图标；
    /// 无详情行时回退 `repo_card_cache` 单仓富卡。
    pub fn cached_detail_summary(db: &Database, raw_id: &str) -> Option<AppSummary> {
        let clean_id = crate::forge::canonical_app_id(raw_id)?;
        let Some(mut detail) = db.get_app_detail(&clean_id, None).ok().flatten() else {
            return Self::repo_card_summary(db, &clean_id);
        };
        crate::github::detail_assets::heal_cached_detail(&mut detail, None);
        let platforms = detail.core.platforms.clone();
        let icon_trimmed = detail.core.icon.trim();
        let mut summary = AppSummary {
            core: AppCore {
                icon: if icon_trimmed.is_empty() || icon_trimmed.starts_with("data:") {
                    String::new()
                } else {
                    detail.core.icon.clone()
                },
                platforms,
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

    /// DB-only 投影：`repo_card_cache` 完整卡片叠加确认图标（收录态标注缺席，由调用方盖章）。
    pub fn repo_card_summary(db: &Database, clean_id: &str) -> Option<AppSummary> {
        let mut summary = db.get_repo_card(clean_id).ok().flatten()?.summary;
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

/// GitHub 仓库 JSON 私有标记：优先本次写入的 `/repos/{o}/{r}` 载荷，其次 `api_etag_cache` 旧载荷；
/// 非 GitHub 源或无载荷返回 `None`（保留库内原值）。
fn repo_private_flag(db: &Database, core: &AppCore, etag_writes: &[EtagWrite]) -> Option<bool> {
    let forge = core.forge.as_deref().unwrap_or("github");
    if !forge.eq_ignore_ascii_case("github") {
        return None;
    }
    let url = format!(
        "https://api.github.com/repos/{}/{}",
        urlencoding::encode(core.owner.trim()),
        urlencoding::encode(core.repo.trim())
    );
    let fresh = etag_writes
        .iter()
        .find(|w| w.url.eq_ignore_ascii_case(&url))
        .map(|w| w.payload.clone());
    let payload = fresh.or_else(|| db.get_cached_payload(&url).ok().flatten())?;
    crate::github::search::repo_json_is_private(&payload)
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

        // 5. 已收录应用不进入单仓富卡表
        assert!(db.get_repo_card("o/r").unwrap().is_none());
    }

    #[test]
    fn persist_detail_bundle_writes_uncataloged_repo_card_with_private_flag() {
        let db = Database::open_in_memory().unwrap();
        let mut detail = detail_payload("o/r");
        detail.core.platforms = vec![];
        let etags = vec![EtagWrite {
            url: "https://api.github.com/repos/o/r".to_string(),
            etag: "W/\"r\"".to_string(),
            payload: r#"{"name":"r","private":true}"#.to_string(),
            timestamp: 1700000000,
        }];
        DetailRepository::persist_detail_bundle(&db, "o/r", &detail, None, &etags).unwrap();
        let card = db
            .get_repo_card("o/r")
            .unwrap()
            .expect("uncataloged card persisted");
        assert!(card.confirmed_other);
        assert!(card.is_private);
        assert_eq!(card.summary.core.latest_version, "v2.5.0");
        assert_eq!(card.summary.core.icon, "https://fallback.example/icon.png");
    }

    #[test]
    fn cached_detail_summary_falls_back_to_repo_card() {
        let db = Database::open_in_memory().unwrap();
        let detail = detail_payload("o/r");
        db.upsert_repo_card(&crate::db::RepoCardUpsert {
            summary: AppSummary { core: detail.core },
            confirmed_other: false,
            is_private: None,
        })
        .unwrap();
        let summary =
            DetailRepository::cached_detail_summary(&db, "O/R").expect("repo card fallback");
        assert_eq!(summary.core.id, "o/r");
        assert_eq!(summary.core.stars, 888);
        assert_eq!(summary.core.platforms, vec!["windows", "linux"]);
        assert!(summary.core.is_cataloged.is_none());
    }

    #[test]
    fn project_detail_heals_misclassified_cached_releases_and_platforms() {
        let db = Database::open_in_memory().unwrap();
        let mut maccy_item = catalog_item("p0deje/maccy");
        maccy_item.owner = "p0deje".to_string();
        maccy_item.repo = "Maccy".to_string();
        maccy_item.name = "Maccy".to_string();
        maccy_item.platforms = vec!["macos".to_string()];
        db.seed_catalog_apps_if_empty(&[maccy_item]).unwrap();

        let mut poisoned_detail = detail_payload("p0deje/maccy");
        poisoned_detail.core.platforms = vec!["windows".to_string()];
        poisoned_detail.releases = vec![crate::models::ReleaseAsset {
            name: "Maccy.app.zip".to_string(),
            download_url: "https://github.com/p0deje/Maccy/releases/download/2.8.0/Maccy.app.zip"
                .to_string(),
            size_bytes: 5_288_775,
            sha256: None,
            os: "windows".to_string(),
            arch: "universal".to_string(),
            kind: "portable_zip".to_string(),
        }];
        db.save_app_detail("p0deje/maccy", &poisoned_detail)
            .unwrap();

        let svc = CatalogService::new_empty();
        svc.sync_from_db(&db);
        let projected =
            DetailRepository::project_detail(&db, &svc, "p0deje/maccy", Some(3600), false)
                .expect("should project cached detail");
        assert_eq!(projected.core.platforms, vec!["macos".to_string()]);
        assert_eq!(projected.releases.len(), 1);
        assert_eq!(projected.releases[0].os, "macos");
        assert_eq!(projected.releases[0].kind, "portable_zip");
    }

    #[test]
    fn persist_detail_bundle_also_updates_active_local_custom_app() {
        let db = Database::open_in_memory().unwrap();
        let mut local_item = catalog_item("o/local");
        local_item.repo = "local".to_string();
        local_item.homepage = Some("https://local.example.com".to_string());
        local_item.stars = 5;
        local_item.forks = 1;
        local_item.default_version = "v0.1.0".to_string();
        local_item.platforms = Vec::new();
        db.upsert_custom_app_payload(&local_item).unwrap();
        db.mark_custom_app_collected("o/local").unwrap();

        let mut detail = detail_payload("o/local");
        detail.core.repo = "local".to_string();
        DetailRepository::persist_detail_bundle(&db, "o/local", &detail, None, &[]).unwrap();

        let stored = db.get_custom_app("o/local").unwrap().unwrap();
        assert_eq!(stored.item.stars, 888);
        assert_eq!(stored.item.forks, 99);
        assert_eq!(stored.item.default_version, "v2.5.0");
        assert_eq!(stored.item.platforms, vec!["windows", "linux"]);
    }
}
