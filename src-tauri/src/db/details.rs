//! `app_details` 持久化 DAO：应用深度详情缓存表。

use super::{clean, dedup_clean_refs, now_secs, Database};
use crate::models::{AppCore, AppDetail, ReadmeVariant, ReleaseAsset};
use rusqlite::{params, Result};
use std::collections::HashMap;

/// 应用详情表最大保留行数（按 `cached_at DESC` LRU 淘汰，资产关联行豁免）。
pub const APP_DETAILS_CACHE_MAX_ROWS: usize = 500;

fn parse_platforms(raw: &str) -> Vec<String> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_releases(raw: &str) -> Vec<ReleaseAsset> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_readme_variants(raw: Option<String>) -> Option<Vec<ReadmeVariant>> {
    let text = raw?;
    if text.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<Vec<ReadmeVariant>>(&text)
        .ok()
        .filter(|v| !v.is_empty())
}

fn opt_non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

fn row_to_app_detail(row: &rusqlite::Row<'_>) -> Result<AppDetail> {
    let app_id: String = row.get(0)?;
    let name: String = row.get(1)?;
    let owner: String = row.get(2)?;
    let repo: String = row.get(3)?;
    let description: String = row.get(4)?;
    let description_en: Option<String> = row.get(5)?;
    let icon: String = row.get(6)?;
    let icon_bg: String = row.get(7)?;
    let stars_i64: i64 = row.get(8)?;
    let forks_i64: i64 = row.get(9)?;
    let license: String = row.get(10)?;
    let latest_version: String = row.get(11)?;
    let category: String = row.get(12)?;
    let category_name: String = row.get(13)?;
    let forge: Option<String> = opt_non_empty(row.get(14)?);
    let forge_host: Option<String> = opt_non_empty(row.get(15)?);
    let homepage: Option<String> = row.get(16)?;
    let platforms_json: String = row.get(17)?;
    let changelog: String = row.get(18)?;
    let readme_markdown: String = row.get(19)?;
    let readme_variants_json: Option<String> = row.get(20)?;
    let releases_json: String = row.get(21)?;
    let cached_at: i64 = row.get(22)?;

    Ok(AppDetail {
        core: AppCore {
            id: app_id,
            name,
            description_en,
            owner,
            repo,
            icon,
            icon_bg,
            description,
            stars: stars_i64.max(0) as u64,
            forks: forks_i64.max(0) as u64,
            license,
            latest_version,
            category,
            category_name,
            is_verified: false,
            forge,
            forge_host,
            homepage,
            platforms: parse_platforms(&platforms_json),
            is_cataloged: None,
            source: None,
            status: None,
            added_at: None,
            alternatives: Vec::new(),
        },
        changelog,
        readme_markdown,
        readme_variants: parse_readme_variants(readme_variants_json),
        releases: parse_releases(&releases_json),
        cached_at: Some(cached_at),
        is_stale: None,
    })
}

const SELECT_DETAIL_COLS: &str = "app_id, name, owner, repo, description, description_en, \
    icon, icon_bg, stars, forks, license, latest_version, category, category_name, \
    forge, forge_host, homepage, platforms_json, changelog, readme_markdown, \
    readme_variants_json, releases_json, cached_at";

impl Database {
    /// 读取 `app_details` 表中应用详情（`ttl_seconds` 为 `Some` 时执行 TTL 门控）。
    pub fn get_app_detail(
        &self,
        app_id: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<Option<AppDetail>> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(None);
        }

        let sql = format!(
            "SELECT {} FROM app_details WHERE app_id = ?1 LIMIT 1",
            SELECT_DETAIL_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params![cleaned])?;
        if let Some(row) = rows.next()? {
            let detail = row_to_app_detail(row)?;
            let cached_at = detail.cached_at.unwrap_or(0);
            if let Some(ttl) = ttl_seconds {
                if ttl > 0 {
                    let now = now_secs();
                    if now.saturating_sub(cached_at) >= ttl {
                        return Ok(None);
                    }
                } else if ttl == 0 {
                    return Ok(None);
                }
            }
            return Ok(Some(detail));
        }
        Ok(None)
    }

    /// 按 `app_id` 精确批量读取详情摘要（`IN (...)` 分片，无 TTL 门控）：不读取
    /// `readme_markdown` / `readme_variants_json` / `changelog`（返回值中为空）；
    /// `with_releases = false` 时同样跳过 `releases_json`。返回按库内 `app_id` 索引的映射。
    pub fn get_app_detail_summaries_batch(
        &self,
        app_ids: &[String],
        with_releases: bool,
    ) -> Result<HashMap<String, AppDetail>> {
        let keys = dedup_clean_refs(app_ids);
        let releases_col = if with_releases { "releases_json" } else { "''" };
        let rows = self.query_in_chunks(
            &keys,
            |ph| {
                format!(
                    "SELECT app_id, name, owner, repo, description, description_en, \
                     icon, icon_bg, stars, forks, license, latest_version, category, category_name, \
                     forge, forge_host, homepage, platforms_json, '', '', NULL, {releases_col}, cached_at \
                     FROM app_details WHERE app_id IN ({ph})"
                )
            },
            row_to_app_detail,
        )?;
        Ok(rows.into_iter().map(|d| (d.core.id.clone(), d)).collect())
    }

    /// 刷新 `app_details.cached_at` 时间戳（304 命中零开销延长保鲜期）。
    pub fn touch_app_detail(&self, app_id: &str, new_cached_at: i64) -> Result<()> {
        self.exec_write(
            "UPDATE app_details SET cached_at = ?1 WHERE app_id = ?2",
            params![new_cached_at, clean(app_id)],
        )?;
        Ok(())
    }

    /// 写入或更新 `app_details` 行。
    pub fn save_app_detail(&self, app_id: &str, detail: &AppDetail) -> Result<()> {
        let clean_id = clean(app_id);
        if clean_id.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        let platforms_json =
            serde_json::to_string(&detail.core.platforms).unwrap_or_else(|_| "[]".into());
        let releases_json = serde_json::to_string(&detail.releases).unwrap_or_else(|_| "[]".into());
        let readme_variants_json: Option<String> = detail
            .readme_variants
            .as_ref()
            .filter(|v| !v.is_empty())
            .and_then(|v| serde_json::to_string(v).ok());

        self.exec_write(
            r#"
            INSERT INTO app_details (
                app_id, name, owner, repo, description, description_en,
                icon, icon_bg, stars, forks, license, latest_version,
                category, category_name, forge, forge_host, homepage,
                platforms_json, changelog, readme_markdown,
                readme_variants_json, releases_json, cached_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20,
                ?21, ?22, ?23
            )
            ON CONFLICT(app_id) DO UPDATE SET
                name = excluded.name,
                owner = excluded.owner,
                repo = excluded.repo,
                description = excluded.description,
                description_en = excluded.description_en,
                icon = excluded.icon,
                icon_bg = excluded.icon_bg,
                stars = excluded.stars,
                forks = excluded.forks,
                license = excluded.license,
                latest_version = excluded.latest_version,
                category = excluded.category,
                category_name = excluded.category_name,
                forge = excluded.forge,
                forge_host = excluded.forge_host,
                homepage = excluded.homepage,
                platforms_json = excluded.platforms_json,
                changelog = excluded.changelog,
                readme_markdown = excluded.readme_markdown,
                readme_variants_json = excluded.readme_variants_json,
                releases_json = excluded.releases_json,
                cached_at = excluded.cached_at;
            "#,
            params![
                clean_id,
                detail.core.name,
                detail.core.owner,
                detail.core.repo,
                detail.core.description,
                detail.core.description_en,
                detail.core.icon,
                detail.core.icon_bg,
                detail.core.stars as i64,
                detail.core.forks as i64,
                detail.core.license,
                detail.core.latest_version,
                detail.core.category,
                detail.core.category_name,
                detail.core.forge.as_deref().unwrap_or("github"),
                detail.core.forge_host.as_deref().unwrap_or("github.com"),
                detail.core.homepage,
                platforms_json,
                detail.changelog,
                detail.readme_markdown,
                readme_variants_json,
                releases_json,
                now,
            ],
        )?;
        Ok(())
    }

    /// 详情 + 图标轮换原子落库（单提交）：不改 TTL/ETag 逻辑。
    pub fn save_detail_with_cycle_row(
        &self,
        app_id: &str,
        detail: &AppDetail,
        cycle: Option<&super::AppIconCycle>,
    ) -> Result<()> {
        self.with_immediate_transaction(|| {
            self.save_app_detail(app_id, detail)?;
            if let Some(c) = cycle {
                self.upsert_icon_cycle(c)?;
            }
            Ok(())
        })
    }

    /// 图标轮换写侧补齐：同步更新 `app_details.icon`，`cached_at` 保持不动。
    pub fn sync_detail_icon(&self, app_id: &str, new_icon: &str) -> Result<bool> {
        let clean_id = clean(app_id);
        if clean_id.is_empty() {
            return Ok(false);
        }
        let rows = self.exec_write(
            "UPDATE app_details SET icon = ?1 WHERE app_id = ?2",
            params![new_icon, clean_id],
        )?;
        Ok(rows > 0)
    }

    /// 多语言 README 变体按需回填：仅原地更新 `readme_variants_json`，不动 `cached_at`。
    pub fn update_detail_readme_variants(
        &self,
        app_id: &str,
        variants: &[ReadmeVariant],
    ) -> Result<bool> {
        let clean_id = clean(app_id);
        if clean_id.is_empty() || variants.is_empty() {
            return Ok(false);
        }
        let json = serde_json::to_string(variants)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let rows = self.exec_write(
            "UPDATE app_details SET readme_variants_json = ?1 WHERE app_id = ?2",
            params![json, clean_id],
        )?;
        Ok(rows > 0)
    }

    /// 按 `cached_at DESC` 保留最新 `max_rows` 条应用详情；
    /// 已安装、收藏、关注或最近浏览的 `app_id` 永不淘汰。
    pub fn prune_app_details(&self, max_rows: usize) -> Result<usize> {
        if max_rows == 0 {
            return Ok(0);
        }
        let deleted = self.conn.execute(
            r#"
            DELETE FROM app_details
            WHERE app_id NOT IN (
                SELECT app_id FROM app_details
                ORDER BY cached_at DESC, app_id ASC
                LIMIT ?1
            )
            AND app_id NOT IN (SELECT app_id FROM installed_apps)
            AND app_id NOT IN (SELECT app_id FROM user_favorites)
            AND app_id NOT IN (SELECT app_id FROM watched_apps)
            AND app_id NOT IN (SELECT app_id FROM view_history)
            "#,
            params![max_rows as i64],
        )?;
        Ok(deleted)
    }

    /// 测试专用：清空 `app_details` 表。
    #[cfg(test)]
    pub fn clear_app_details(&self) -> Result<()> {
        self.exec_write("DELETE FROM app_details", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_app_detail_summaries_batch_is_keyed_by_stored_id_and_skips_heavy_fields() {
        let db = Database::open_in_memory().unwrap();
        let detail = AppDetail {
            core: AppCore {
                id: "acme/tool".to_string(),
                name: "Tool".to_string(),
                description_en: None,
                owner: "acme".to_string(),
                repo: "tool".to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: String::new(),
                stars: 0,
                forks: 0,
                license: String::new(),
                latest_version: "v1.0.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: false,
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
            changelog: "big changelog".to_string(),
            readme_markdown: "big readme".to_string(),
            readme_variants: None,
            releases: Vec::new(),
            cached_at: Some(123),
            is_stale: None,
        };
        db.save_app_detail("acme/tool", &detail).unwrap();

        let hits = db
            .get_app_detail_summaries_batch(
                &[
                    " acme/tool ".to_string(),
                    "acme/tool".to_string(),
                    "nobody/here".to_string(),
                ],
                false,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        let got = &hits["acme/tool"];
        assert_eq!(got.core.latest_version, "v1.0.0");
        assert_eq!(got.core.platforms, vec!["windows"]);
        assert!(got.readme_markdown.is_empty());
        assert!(got.changelog.is_empty());
    }
}
