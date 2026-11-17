use super::{dedup_clean_refs, clean, now_secs, Database};
use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppIconCycle {
    pub app_id: String,
    pub owner: String,
    pub repo: String,
    pub is_cataloged: bool,
    pub level: i32,
    pub l1_url: String,
    pub l2_url: String,
    pub l3_url: String,
    pub l4_url: String,
    pub selected_url: String,
    pub cache_file: String,
    pub updated_at: i64,
    /// 用户手动选择标记（手动轮换保护）：详情刷新只补备选槽，不改 level/selected_url。
    pub pinned: bool,
}

impl Default for AppIconCycle {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            owner: String::new(),
            repo: String::new(),
            is_cataloged: false,
            level: 1,
            l1_url: String::new(),
            l2_url: String::new(),
            l3_url: String::new(),
            l4_url: String::new(),
            selected_url: String::new(),
            cache_file: String::new(),
            updated_at: 0,
            pinned: false,
        }
    }
}

impl AppIconCycle {
    pub fn new(
        app_id: impl Into<String>,
        owner: impl Into<String>,
        repo: impl Into<String>,
    ) -> Self {
        Self {
            app_id: app_id.into(),
            owner: owner.into(),
            repo: repo.into(),
            ..Default::default()
        }
    }

    /// 获取特定级别对应的 URL (1..=4)。
    pub fn url_for_level(&self, level: i32) -> Option<&str> {
        match level {
            1 => Some(&self.l1_url),
            2 => Some(&self.l2_url),
            3 => Some(&self.l3_url),
            4 => Some(&self.l4_url),
            _ => None,
        }
    }

    /// 若 `url` 已存在于当前行的 `l1_url`..`l4_url` 槽位中，返回对应级别 (1..=4)。
    pub fn level_for_known_url(&self, url: &str) -> Option<i32> {
        let u = url.trim();
        if u.is_empty() {
            return None;
        }
        for level in 1..=4 {
            if let Some(slot_url) = self.url_for_level(level) {
                if slot_url.trim() == u {
                    return Some(level);
                }
            }
        }
        None
    }
}

const SELECT_CYCLE_COLS: &str = "app_id, owner, repo, is_cataloged, level, \
    l1_url, l2_url, l3_url, l4_url, selected_url, cache_file, updated_at, pinned";

fn row_to_cycle(row: &rusqlite::Row<'_>) -> Result<AppIconCycle> {
    Ok(AppIconCycle {
        app_id: row.get(0)?,
        owner: row.get(1)?,
        repo: row.get(2)?,
        is_cataloged: row.get::<_, i64>(3)? != 0,
        level: row.get(4)?,
        l1_url: row.get(5)?,
        l2_url: row.get(6)?,
        l3_url: row.get(7)?,
        l4_url: row.get(8)?,
        selected_url: row.get(9)?,
        cache_file: row.get(10)?,
        updated_at: row.get(11)?,
        pinned: row.get::<_, i64>(12)? != 0,
    })
}

impl Database {
    /// 查询指定 `app_id` 的图标轮换记录。
    pub fn get_icon_cycle(&self, app_id: &str) -> Result<Option<AppIconCycle>> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(None);
        }
        Ok(self
            .query_vec(
                &format!(
                    "SELECT {SELECT_CYCLE_COLS} FROM app_icon_cycles WHERE app_id = ?1 LIMIT 1"
                ),
                params![cleaned],
                row_to_cycle,
            )?
            .into_iter()
            .next())
    }

    /// 根据 `owner` 与 `repo` 索引查找图标轮换记录。
    pub fn get_icon_cycle_by_repo(&self, owner: &str, repo: &str) -> Result<Option<AppIconCycle>> {
        let o = clean(owner);
        let r = clean(repo);
        if o.is_empty() || r.is_empty() {
            return Ok(None);
        }
        Ok(self
            .query_vec(
                &format!(
                    "SELECT {SELECT_CYCLE_COLS} FROM app_icon_cycles WHERE owner = ?1 AND repo = ?2 LIMIT 1"
                ),
                params![o, r],
                row_to_cycle,
            )?
            .into_iter()
            .next())
    }

    /// 按 `app_id` 精确批量读取（`IN (...)` 分片），返回按 `app_id` 索引的映射。
    pub fn get_icon_cycles_batch(
        &self,
        app_ids: &[String],
    ) -> Result<HashMap<String, AppIconCycle>> {
        let keys = dedup_clean_refs(app_ids);
        let rows = self.query_in_chunks(
            &keys,
            |ph| format!("SELECT {SELECT_CYCLE_COLS} FROM app_icon_cycles WHERE app_id IN ({ph})"),
            row_to_cycle,
        )?;
        Ok(rows.into_iter().map(|c| (c.app_id.clone(), c)).collect())
    }

    /// 按 `owner` 批量读取（`IN (...)` 分片，走 `(owner, repo)` 索引前缀），供调用方在内存按
    /// `(owner, repo)` 精确匹配；同一 `(owner, repo)` 多行时按 `rowid` 先到者为准。
    pub fn get_icon_cycles_by_owners(&self, owners: &[String]) -> Result<Vec<AppIconCycle>> {
        let keys = dedup_clean_refs(owners);
        self.query_in_chunks(
            &keys,
            |ph| {
                format!(
                    "SELECT {SELECT_CYCLE_COLS} FROM app_icon_cycles WHERE owner IN ({ph}) ORDER BY rowid"
                )
            },
            row_to_cycle,
        )
    }

    /// 插入或更新图标轮换记录，主键冲突走 `ON CONFLICT(app_id) DO UPDATE SET`。
    pub fn upsert_icon_cycle(&self, cycle: &AppIconCycle) -> Result<()> {
        let clean_id = clean(&cycle.app_id);
        if clean_id.is_empty() {
            return Ok(());
        }
        let updated_at = if cycle.updated_at == 0 {
            now_secs()
        } else {
            cycle.updated_at
        };
        let is_cataloged_int = if cycle.is_cataloged { 1 } else { 0 };
        let pinned_int = if cycle.pinned { 1 } else { 0 };

        self.exec_write(
            r#"
            INSERT INTO app_icon_cycles (
                app_id, owner, repo, is_cataloged, level,
                l1_url, l2_url, l3_url, l4_url,
                selected_url, cache_file, updated_at, pinned
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(app_id) DO UPDATE SET
                owner = excluded.owner,
                repo = excluded.repo,
                is_cataloged = excluded.is_cataloged,
                level = excluded.level,
                l1_url = excluded.l1_url,
                l2_url = excluded.l2_url,
                l3_url = excluded.l3_url,
                l4_url = excluded.l4_url,
                selected_url = excluded.selected_url,
                cache_file = excluded.cache_file,
                updated_at = excluded.updated_at,
                pinned = excluded.pinned;
            "#,
            params![
                clean_id,
                clean(&cycle.owner),
                clean(&cycle.repo),
                is_cataloged_int,
                cycle.level,
                clean(&cycle.l1_url),
                clean(&cycle.l2_url),
                clean(&cycle.l3_url),
                clean(&cycle.l4_url),
                clean(&cycle.selected_url),
                clean(&cycle.cache_file),
                updated_at,
                pinned_int,
            ],
        )?;
        Ok(())
    }

    /// 单事务批量 upsert 图标轮换记录。
    pub fn upsert_icon_cycles_batch(&self, cycles: &[AppIconCycle]) -> Result<()> {
        if cycles.is_empty() {
            return Ok(());
        }
        self.with_immediate_transaction(|| {
            for c in cycles {
                self.upsert_icon_cycle(c)?;
            }
            Ok(())
        })
    }

    /// 更新当前图标轮换级别，并在对应级别 URL 非空时同步切换 `selected_url`（保留 `pinned`）。
    pub fn set_icon_cycle_level(&self, app_id: &str, level: i32) -> Result<()> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_write(
            r#"
            UPDATE app_icon_cycles
            SET level = ?1,
                selected_url = CASE ?1
                    WHEN 1 THEN CASE WHEN l1_url != '' THEN l1_url ELSE selected_url END
                    WHEN 2 THEN CASE WHEN l2_url != '' THEN l2_url ELSE selected_url END
                    WHEN 3 THEN CASE WHEN l3_url != '' THEN l3_url ELSE selected_url END
                    WHEN 4 THEN CASE WHEN l4_url != '' THEN l4_url ELSE selected_url END
                    ELSE selected_url
                END,
                updated_at = ?2
            WHERE app_id = ?3
            "#,
            params![level, now, cleaned],
        )?;
        Ok(())
    }

    /// 更新当前图标轮换级别及选中的 URL 和本地缓存文件路径（保留 `pinned`）。
    pub fn set_icon_cycle_selected(
        &self,
        app_id: &str,
        level: i32,
        selected_url: &str,
        cache_file: &str,
    ) -> Result<()> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_write(
            r#"
            UPDATE app_icon_cycles
            SET level = ?1,
                selected_url = ?2,
                cache_file = ?3,
                updated_at = ?4
            WHERE app_id = ?5
            "#,
            params![level, clean(selected_url), clean(cache_file), now, cleaned],
        )?;
        Ok(())
    }

    /// 删除指定 `app_id` 的图标轮换记录。
    pub fn delete_icon_cycle(&self, app_id: &str) -> Result<bool> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(false);
        }
        let rows = self.exec_write(
            "DELETE FROM app_icon_cycles WHERE app_id = ?1",
            params![cleaned],
        )?;
        Ok(rows > 0)
    }

    /// 查询 `icon_cache_meta` TTL 记录 `(remote_url, cached_at)`。
    pub fn get_icon_cache_record(&self, cache_key: &str) -> Result<Option<(String, i64)>> {
        let cleaned = clean(cache_key);
        if cleaned.is_empty() {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT remote_url, cached_at FROM icon_cache_meta WHERE cache_key = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![cleaned])?;
        if let Some(row) = rows.next()? {
            let url: String = row.get(0)?;
            let at: i64 = row.get(1)?;
            Ok(Some((url, at)))
        } else {
            Ok(None)
        }
    }
}
