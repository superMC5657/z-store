//! `catalog_apps` 持久化 DAO：远端精选目录主表。

use super::{clean, now_secs, Database};
use crate::github::models::CatalogItem;
use crate::models::AppDetail;
use rusqlite::{params, Result};
use std::collections::HashMap;

fn parse_json_vec<T: serde::de::DeserializeOwned>(raw: &str) -> Vec<T> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_json_map(raw: &str) -> HashMap<String, Vec<String>> {
    if raw.trim().is_empty() {
        return HashMap::new();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

fn row_to_catalog_item(row: &rusqlite::Row<'_>) -> Result<CatalogItem> {
    let aliases_json: String = row.get(10)?;
    let stars_i64: i64 = row.get(14)?;
    let forks_i64: i64 = row.get(15)?;
    let is_verified_i64: i64 = row.get(16)?;
    let platforms_json: String = row.get(18)?;
    let identifiers_json: String = row.get(19)?;
    let install_dirs_json: String = row.get(20)?;
    let search_subdirs_json: String = row.get(21)?;
    let publishers_json: String = row.get(22)?;
    let alternatives_json: String = row.get(23)?;

    Ok(CatalogItem {
        id: row.get(0)?,
        name: row.get(1)?,
        owner: row.get(2)?,
        repo: row.get(3)?,
        icon: row.get(4)?,
        icon_bg: row.get(5)?,
        description: row.get(6)?,
        description_en: row.get(7)?,
        category: row.get(8)?,
        category_name: row.get(9)?,
        aliases: parse_json_vec(&aliases_json),
        alternatives: parse_json_vec(&alternatives_json),
        default_version: row.get(11)?,
        added_at: row.get(12)?,
        license: row.get(13)?,
        stars: stars_i64.max(0) as u64,
        forks: forks_i64.max(0) as u64,
        is_verified: is_verified_i64 != 0,
        homepage: row.get(17)?,
        platforms: parse_json_vec(&platforms_json),
        identifiers: parse_json_map(&identifiers_json),
        install_dirs: parse_json_vec(&install_dirs_json),
        search_subdirs: parse_json_vec(&search_subdirs_json),
        publishers: parse_json_vec(&publishers_json),
    })
}

const SELECT_CATALOG_COLS: &str =
    "id, name, owner, repo, icon, icon_bg, description, description_en, \
    category, category_name, aliases_json, default_version, added_at, license, stars, forks, \
    is_verified, homepage, platforms_json, identifiers_json, install_dirs_json, \
    search_subdirs_json, publishers_json, alternatives_json";

impl Database {
    fn insert_catalog_item_row(&self, item: &CatalogItem, now: i64) -> Result<()> {
        let canon_id = crate::forge::canonical_app_id(&item.id)
            .unwrap_or_else(|| clean(&item.id).to_lowercase());
        if canon_id.is_empty() {
            return Ok(());
        }
        let aliases_json = serde_json::to_string(&item.aliases).unwrap_or_else(|_| "[]".into());
        let platforms_json = serde_json::to_string(&item.platforms).unwrap_or_else(|_| "[]".into());
        let identifiers_json =
            serde_json::to_string(&item.identifiers).unwrap_or_else(|_| "{}".into());
        let install_dirs_json =
            serde_json::to_string(&item.install_dirs).unwrap_or_else(|_| "[]".into());
        let search_subdirs_json =
            serde_json::to_string(&item.search_subdirs).unwrap_or_else(|_| "[]".into());
        let publishers_json =
            serde_json::to_string(&item.publishers).unwrap_or_else(|_| "[]".into());
        let alternatives_json =
            serde_json::to_string(&item.alternatives).unwrap_or_else(|_| "[]".into());

        self.exec_write(
            r#"
            INSERT INTO catalog_apps (
                id, name, owner, repo, icon, icon_bg, description, description_en,
                category, category_name, aliases_json, alternatives_json, default_version, added_at,
                license, stars, forks, is_verified, homepage, platforms_json,
                identifiers_json, install_dirs_json, search_subdirs_json, publishers_json,
                forge, forge_host, manifest_synced_at, detail_synced_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?25, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19,
                ?20, ?21, ?22, ?23,
                'github', 'github.com', ?24, 0, ?24
            )
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                owner = excluded.owner,
                repo = excluded.repo,
                icon = excluded.icon,
                icon_bg = excluded.icon_bg,
                description = excluded.description,
                description_en = excluded.description_en,
                category = excluded.category,
                category_name = excluded.category_name,
                aliases_json = excluded.aliases_json,
                alternatives_json = excluded.alternatives_json,
                default_version = excluded.default_version,
                added_at = excluded.added_at,
                license = excluded.license,
                stars = excluded.stars,
                forks = excluded.forks,
                is_verified = excluded.is_verified,
                homepage = excluded.homepage,
                platforms_json = excluded.platforms_json,
                identifiers_json = excluded.identifiers_json,
                install_dirs_json = excluded.install_dirs_json,
                search_subdirs_json = excluded.search_subdirs_json,
                publishers_json = excluded.publishers_json,
                manifest_synced_at = excluded.manifest_synced_at,
                updated_at = excluded.updated_at;
            "#,
            params![
                canon_id,
                item.name,
                item.owner,
                item.repo,
                item.icon,
                item.icon_bg,
                item.description,
                item.description_en,
                item.category,
                item.category_name,
                aliases_json,
                item.default_version,
                item.added_at,
                item.license,
                item.stars as i64,
                item.forks as i64,
                if item.is_verified { 1 } else { 0 },
                item.homepage,
                platforms_json,
                identifiers_json,
                install_dirs_json,
                search_subdirs_json,
                publishers_json,
                now,
                alternatives_json,
            ],
        )?;
        Ok(())
    }

    /// 目录主表行数统计。
    pub fn count_catalog_apps(&self) -> Result<usize> {
        let count: i64 = self
            .query_scalar_opt("SELECT COUNT(*) FROM catalog_apps", [])?
            .unwrap_or(0);
        Ok(count.max(0) as usize)
    }

    /// 首次启动播种：仅当 `catalog_apps` 为空时将 `catalog.json` 种子写入数据库。
    /// 返回 `Ok(true)` 表示执行了播种，`Ok(false)` 表示表非空已跳过。
    pub fn seed_catalog_apps_if_empty(&self, items: &[CatalogItem]) -> Result<bool> {
        if self.count_catalog_apps()? > 0 || items.is_empty() {
            return Ok(false);
        }
        let now = now_secs();
        self.with_immediate_transaction(|| {
            if self.count_catalog_apps()? > 0 {
                return Ok(false);
            }
            for item in items {
                self.insert_catalog_item_row(item, now)?;
            }
            Ok(true)
        })
    }

    /// 在调用方已开启的事务内全量覆盖 `catalog_apps`（Repository 组合事务复用）。
    pub(crate) fn replace_catalog_apps_in_tx(&self, items: &[CatalogItem]) -> Result<()> {
        let now = now_secs();
        self.exec_write("DELETE FROM catalog_apps", [])?;
        for item in items {
            self.insert_catalog_item_row(item, now)?;
        }
        Ok(())
    }

    /// 清单同步权威覆盖：单事务内清空旧远端条目并写入最新收录清单全部条目。
    pub fn replace_catalog_apps(&self, items: &[CatalogItem]) -> Result<()> {
        self.with_immediate_transaction(|| self.replace_catalog_apps_in_tx(items))
    }

    /// 读取全部精选目录条目（按 stars 降序、id 升序稳定输出）。
    pub fn list_catalog_apps(&self) -> Result<Vec<CatalogItem>> {
        let sql = format!(
            "SELECT {} FROM catalog_apps ORDER BY stars DESC, id ASC",
            SELECT_CATALOG_COLS
        );
        self.query_vec(&sql, [], row_to_catalog_item)
    }

    /// 已收录规范 id 集合：远端精选 `catalog_apps` + 未归档本地库 `custom_apps`（只读 `id` 列）。
    pub fn list_cataloged_ids(&self) -> Result<std::collections::HashSet<String>> {
        let ids: Vec<String> = self.query_vec(
            "SELECT id FROM catalog_apps
             UNION
             SELECT id FROM custom_apps
             WHERE archived = 0 AND status IN ('collected', 'local_collected', 'submitted')",
            [],
            |row| row.get(0),
        )?;
        Ok(ids
            .into_iter()
            .map(|id| {
                crate::forge::canonical_app_id(&id).unwrap_or_else(|| id.trim().to_lowercase())
            })
            .collect())
    }

    /// 按 canonical id 精确查询单个目录项。
    pub fn get_catalog_app(&self, id: &str) -> Result<Option<CatalogItem>> {
        let cleaned =
            crate::forge::canonical_app_id(id).unwrap_or_else(|| clean(id).to_lowercase());
        if cleaned.is_empty() {
            return Ok(None);
        }
        let sql = format!(
            "SELECT {} FROM catalog_apps WHERE id = ?1 LIMIT 1",
            SELECT_CATALOG_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params![cleaned])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row_to_catalog_item(row)?))
        } else {
            Ok(None)
        }
    }

    /// 查询 canonical id 是否存在于 `catalog_apps`。
    pub fn exists_catalog_app(&self, id: &str) -> Result<bool> {
        let cleaned =
            crate::forge::canonical_app_id(id).unwrap_or_else(|| clean(id).to_lowercase());
        if cleaned.is_empty() {
            return Ok(false);
        }
        self.record_exists(
            "SELECT 1 FROM catalog_apps WHERE id = ?1 LIMIT 1",
            params![cleaned],
        )
    }

    /// 从应用详情回写更新 `catalog_apps` 对应行（stale 跳过；仅更新表内已存在行，不插入未收录应用）。
    pub fn update_catalog_app_from_detail(&self, detail: &AppDetail) -> Result<bool> {
        if detail.is_stale == Some(true) {
            return Ok(false);
        }
        let Some(key) = crate::forge::canonical_app_id(&detail.core.id) else {
            return Ok(false);
        };
        let Some(mut existing) = self.get_catalog_app(&key)? else {
            return Ok(false);
        };
        if !existing.merge_from_detail(detail) {
            return Ok(false);
        }

        let now = now_secs();
        let platforms_json =
            serde_json::to_string(&existing.platforms).unwrap_or_else(|_| "[]".into());
        let rows = self.exec_write(
            r#"
            UPDATE catalog_apps SET
                stars = ?1,
                forks = ?2,
                default_version = ?3,
                platforms_json = ?4,
                license = ?5,
                homepage = ?6,
                icon = ?7,
                detail_synced_at = ?8,
                updated_at = ?8
            WHERE id = ?9
            "#,
            params![
                existing.stars as i64,
                existing.forks as i64,
                existing.default_version,
                platforms_json,
                existing.license,
                existing.homepage,
                existing.icon,
                now,
                key,
            ],
        )?;
        Ok(rows > 0)
    }

    /// 平台懒回填持久化：仅当 `catalog_apps` 存在对应行、原有平台为空且推导出非空平台时补写 `platforms_json`（不覆盖已有收录平台）。
    pub fn update_catalog_app_platforms(&self, id: &str, platforms: &[String]) -> Result<bool> {
        if platforms.is_empty() {
            return Ok(false);
        }
        let Some(key) = crate::forge::canonical_app_id(id) else {
            return Ok(false);
        };
        let Some(existing) = self.get_catalog_app(&key)? else {
            return Ok(false);
        };
        if !existing.platforms.is_empty() {
            return Ok(false);
        }
        let platforms_json = serde_json::to_string(platforms).unwrap_or_else(|_| "[]".into());
        let now = now_secs();
        let rows = self.exec_write(
            "UPDATE catalog_apps SET platforms_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![platforms_json, now, key],
        )?;
        Ok(rows > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AppCore;

    fn sample_item(id: &str, stars: u64) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            name: "Demo".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
            icon: String::new(),
            icon_bg: "#000000".to_string(),
            description: "desc".to_string(),
            description_en: Some("desc en".to_string()),
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec!["alias1".to_string()],
            alternatives: Vec::new(),
            default_version: "v1.0.0".to_string(),
            added_at: Some("2026-10-01".to_string()),
            license: "MIT".to_string(),
            stars,
            forks: 10,
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
    fn seed_only_runs_when_empty_and_replace_overwrites_authoritatively() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.count_catalog_apps().unwrap(), 0);

        // 首次播种成功
        let seeded = db
            .seed_catalog_apps_if_empty(&[sample_item("o/a", 100), sample_item("o/b", 200)])
            .unwrap();
        assert!(seeded);
        assert_eq!(db.count_catalog_apps().unwrap(), 2);

        // 二次播种跳过，不覆盖现有数据
        let seeded_again = db
            .seed_catalog_apps_if_empty(&[sample_item("o/c", 999)])
            .unwrap();
        assert!(!seeded_again);
        assert!(db.get_catalog_app("o/c").unwrap().is_none());

        // 清单权威覆盖：删除下架项 o/a，保留并更新 o/b，新增 o/c
        let mut updated_b = sample_item("o/b", 300);
        updated_b.name = "Updated B".to_string();
        db.replace_catalog_apps(&[updated_b, sample_item("o/c", 50)])
            .unwrap();
        assert_eq!(db.count_catalog_apps().unwrap(), 2);
        assert!(db.get_catalog_app("o/a").unwrap().is_none());
        assert_eq!(
            db.get_catalog_app("o/b").unwrap().unwrap().name,
            "Updated B"
        );
        assert!(db.get_catalog_app("o/c").unwrap().is_some());
    }

    #[test]
    fn detail_writeback_updates_existing_catalog_row_only() {
        let db = Database::open_in_memory().unwrap();
        db.seed_catalog_apps_if_empty(&[sample_item("o/r", 100)])
            .unwrap();

        let detail = AppDetail {
            core: AppCore {
                id: "o/r".to_string(),
                name: "Demo".to_string(),
                description_en: Some("desc en".to_string()),
                owner: "o".to_string(),
                repo: "r".to_string(),
                icon: "https://example.com/new.png".to_string(),
                icon_bg: "#000000".to_string(),
                description: "desc".to_string(),
                stars: 555,
                forks: 44,
                license: "Apache-2.0".to_string(),
                latest_version: "v2.0.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: true,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://new.example.com".to_string()),
                platforms: vec!["windows".to_string(), "linux".to_string()],
                is_cataloged: Some(true),
                source: Some("remote".to_string()),
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: String::new(),
            readme_markdown: "# Demo".to_string(),
            readme_variants: None,
            releases: vec![],
            cached_at: Some(1700000000),
            is_stale: None,
            is_private: false,
        };

        assert!(db.update_catalog_app_from_detail(&detail).unwrap());
        let got = db.get_catalog_app("o/r").unwrap().unwrap();
        // 动态指标与缺失图标回填更新
        assert_eq!(got.stars, 555);
        assert_eq!(got.forks, 44);
        assert_eq!(got.default_version, "v2.0.0");
        assert_eq!(got.icon, "https://example.com/new.png");
        // 已有精校公共字段保持收录库优先，不被详情覆盖
        assert_eq!(got.license, "MIT");
        assert_eq!(got.homepage.as_deref(), Some("https://example.com"));
        assert_eq!(got.platforms, vec!["windows"]);

        // 原目录字段为空时允许详情回填补齐
        let mut empty_item = sample_item("o/empty", 10);
        empty_item.platforms = Vec::new();
        empty_item.homepage = None;
        empty_item.license = String::new();
        db.replace_catalog_apps(&[empty_item]).unwrap();
        let mut empty_detail = detail.clone();
        empty_detail.core.id = "o/empty".to_string();
        assert!(db.update_catalog_app_from_detail(&empty_detail).unwrap());
        let got_empty = db.get_catalog_app("o/empty").unwrap().unwrap();
        assert_eq!(got_empty.platforms, vec!["windows", "linux"]);
        assert_eq!(got_empty.license, "Apache-2.0");
        assert_eq!(
            got_empty.homepage.as_deref(),
            Some("https://new.example.com")
        );

        // 未收录应用不会插入 catalog_apps
        let mut uncataloged = detail.clone();
        uncataloged.core.id = "x/uncataloged".to_string();
        assert!(!db.update_catalog_app_from_detail(&uncataloged).unwrap());
        assert!(db.get_catalog_app("x/uncataloged").unwrap().is_none());
    }
}
