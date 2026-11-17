//! 目录仓储：`catalog_apps` 种子播种、清单权威同步、本地库合并读取与收录标记回填。

use crate::db::Database;
use crate::github::models::CatalogItem;
use rusqlite::Result;
use std::collections::HashSet;

pub struct CatalogRepository;

impl CatalogRepository {
    /// 首次启动播种：仅当 `catalog_apps` 为空时从配置种子 `catalog.json` 写入数据库。
    pub fn seed_from_config_if_empty(db: &Database) -> Result<bool> {
        if db.count_catalog_apps()? > 0 {
            return Ok(false);
        }
        let cfg = crate::config::get_project_config();
        let seed_items: Vec<CatalogItem> = cfg.catalog.load_catalog_items().unwrap_or_default();
        db.seed_catalog_apps_if_empty(&seed_items)
    }

    /// 同步收录清单权威覆盖（默认无 ETag 附加写）。
    pub fn apply_remote_manifest(db: &Database, items: &[CatalogItem]) -> Result<Vec<String>> {
        Self::apply_remote_manifest_with_etag(db, items, None)
    }

    /// 同步收录清单权威覆盖（单事务原子提交）：
    /// 1. 全量覆盖 `catalog_apps`；
    /// 2. 退役已转正的 `custom_apps` 草稿/本地收录；
    /// 3. 校准 `user_favorites` 与 `watched_apps` 的 `is_cataloged` 标记；
    /// 4. 如提供 `(url, etag, timestamp)`，在同事务提交成功后落盘 ETag，杜绝 ETag 先写但目录写库失败造成的假 304 漂移。
    pub fn apply_remote_manifest_with_etag(
        db: &Database,
        items: &[CatalogItem],
        etag_entry: Option<(&str, &str, i64)>,
    ) -> Result<Vec<String>> {
        db.with_immediate_transaction(|| {
            db.replace_catalog_apps_in_tx(items)?;
            let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
            let graduated = db.retire_custom_apps_in_tx(&ids)?;
            Self::backfill_cataloged_flags(db)?;
            if let Some((url, etag, now)) = etag_entry {
                db.save_etag(url, etag, "[]", now)?;
            }
            Ok(graduated)
        })
    }

    /// 读取远端精选目录与本地库 overlay（`catalog_apps` + `custom_apps` 未归档库内行）。
    pub fn load_remote_and_local(db: &Database) -> Result<(Vec<CatalogItem>, Vec<CatalogItem>)> {
        let remote = db.list_catalog_apps()?;
        let local = db.list_local_library_items()?;
        Ok((remote, local))
    }

    /// 全量校准收藏与关注记录的 `is_cataloged` 标记（零网络，单库口径）。
    /// 只读取 `id` 列（不反序列化 JSON 载荷）；仅写入标记发生变化的行。
    pub fn backfill_cataloged_flags(db: &Database) -> Result<()> {
        let cataloged_ids: HashSet<String> = db.list_cataloged_ids()?;

        let is_hit = |raw: &str| -> bool {
            crate::forge::canonical_app_id(raw)
                .map(|c| cataloged_ids.contains(&c))
                .unwrap_or(false)
        };

        for f in &db.get_favorite_entries()? {
            let hit = is_hit(&f.app_id);
            if hit != f.is_cataloged {
                db.set_favorite_cataloged(&f.app_id, hit)?;
            }
        }
        for w in &db.get_watched_apps()? {
            let hit = is_hit(&w.app_id);
            if hit != w.is_cataloged {
                db.set_watched_cataloged(&w.app_id, hit)?;
            }
        }
        Ok(())
    }

    /// 从数据库直接判断应用是否处于已收录状态（`catalog_apps` 或 `custom_apps` 本地库）。
    pub fn is_cataloged(db: &Database, id: &str) -> bool {
        let Some(canon) = crate::forge::canonical_app_id(id) else {
            return false;
        };
        if db.exists_catalog_app(&canon).unwrap_or(false) {
            return true;
        }
        if let Ok(Some(entry)) = db.get_custom_app(&canon) {
            return crate::db::custom_apps::is_local_library_status(&entry.status)
                && !entry.archived;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn item(id: &str) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            name: id.to_string(),
            owner: "o".to_string(),
            repo: id.split('/').nth(1).unwrap_or("r").to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: "desc".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 10,
            forks: 1,
            is_verified: true,
            homepage: Some("https://example.com".to_string()),
            platforms: vec!["windows".to_string()],
            identifiers: HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        }
    }

    #[test]
    fn apply_remote_manifest_overwrites_catalog_retires_drafts_and_backfills_flags() {
        let db = Database::open_in_memory().unwrap();
        db.seed_catalog_apps_if_empty(&[item("o/old")]).unwrap();
        db.add_favorite("o/old", true).unwrap();
        db.add_favorite("o/new", false).unwrap();

        let mut draft = item("o/new");
        draft.is_verified = false;
        db.upsert_custom_app_payload(&draft).unwrap();
        db.mark_custom_app_collected("o/new").unwrap();

        let graduated = CatalogRepository::apply_remote_manifest(&db, &[item("o/new")]).unwrap();
        assert_eq!(graduated, vec!["o/new".to_string()]);
        assert!(!db.exists_catalog_app("o/old").unwrap());
        assert!(db.exists_catalog_app("o/new").unwrap());
        assert!(db.get_custom_app("o/new").unwrap().unwrap().archived);

        let favs = db.get_favorite_entries().unwrap();
        let old_fav = favs.iter().find(|f| f.app_id == "o/old").unwrap();
        let new_fav = favs.iter().find(|f| f.app_id == "o/new").unwrap();
        assert!(!old_fav.is_cataloged);
        assert!(new_fav.is_cataloged);
    }

    #[test]
    fn apply_remote_manifest_with_etag_commits_etag_in_same_transaction() {
        let db = Database::open_in_memory().unwrap();
        let url = "https://example.com/catalog.json";
        CatalogRepository::apply_remote_manifest_with_etag(
            &db,
            &[item("o/app1")],
            Some((url, "W/\"etag-v2\"", 1700000000)),
        )
        .unwrap();

        assert!(db.exists_catalog_app("o/app1").unwrap());
        assert_eq!(db.get_etag(url).unwrap().as_deref(), Some("W/\"etag-v2\""));
    }
}
