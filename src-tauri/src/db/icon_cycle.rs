use super::{now_secs, Database};
use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};

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
        }
    }
}

impl AppIconCycle {
    pub fn new(app_id: impl Into<String>, owner: impl Into<String>, repo: impl Into<String>) -> Self {
        Self {
            app_id: app_id.into(),
            owner: owner.into(),
            repo: repo.into(),
            ..Default::default()
        }
    }

    /// 获取特定级别对应的 URL (1..=4)
    pub fn url_for_level(&self, level: i32) -> Option<&str> {
        match level {
            1 => Some(&self.l1_url),
            2 => Some(&self.l2_url),
            3 => Some(&self.l3_url),
            4 => Some(&self.l4_url),
            _ => None,
        }
    }
}

impl Database {
    /// 查询指定 app_id 的图标轮换记录
    pub fn get_icon_cycle(&self, app_id: &str) -> Result<Option<AppIconCycle>> {
        let clean = app_id.trim();
        if clean.is_empty() {
            return Ok(None);
        }

        let mut stmt = self.conn.prepare(
            r#"
            SELECT
                app_id, owner, repo, is_cataloged, level,
                l1_url, l2_url, l3_url, l4_url,
                selected_url, cache_file, updated_at
            FROM app_icon_cycles
            WHERE app_id = ?1
            LIMIT 1
            "#,
        )?;
        let mut rows = stmt.query(params![clean])?;
        if let Some(row) = rows.next()? {
            let is_cataloged_int: i64 = row.get(3)?;
            Ok(Some(AppIconCycle {
                app_id: row.get(0)?,
                owner: row.get(1)?,
                repo: row.get(2)?,
                is_cataloged: is_cataloged_int != 0,
                level: row.get(4)?,
                l1_url: row.get(5)?,
                l2_url: row.get(6)?,
                l3_url: row.get(7)?,
                l4_url: row.get(8)?,
                selected_url: row.get(9)?,
                cache_file: row.get(10)?,
                updated_at: row.get(11)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// 根据 owner 与 repo 索引快速查找图标轮换记录
    pub fn get_icon_cycle_by_repo(&self, owner: &str, repo: &str) -> Result<Option<AppIconCycle>> {
        let o = owner.trim();
        let r = repo.trim();
        if o.is_empty() || r.is_empty() {
            return Ok(None);
        }

        let mut stmt = self.conn.prepare(
            r#"
            SELECT
                app_id, owner, repo, is_cataloged, level,
                l1_url, l2_url, l3_url, l4_url,
                selected_url, cache_file, updated_at
            FROM app_icon_cycles
            WHERE owner = ?1 AND repo = ?2
            LIMIT 1
            "#,
        )?;
        let mut rows = stmt.query(params![o, r])?;
        if let Some(row) = rows.next()? {
            let is_cataloged_int: i64 = row.get(3)?;
            Ok(Some(AppIconCycle {
                app_id: row.get(0)?,
                owner: row.get(1)?,
                repo: row.get(2)?,
                is_cataloged: is_cataloged_int != 0,
                level: row.get(4)?,
                l1_url: row.get(5)?,
                l2_url: row.get(6)?,
                l3_url: row.get(7)?,
                l4_url: row.get(8)?,
                selected_url: row.get(9)?,
                cache_file: row.get(10)?,
                updated_at: row.get(11)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// 插入或更新图标轮换记录，主键冲突走 ON CONFLICT(app_id) DO UPDATE SET
    pub fn upsert_icon_cycle(&self, cycle: &AppIconCycle) -> Result<()> {
        let clean_id = cycle.app_id.trim();
        if clean_id.is_empty() {
            return Ok(());
        }
        let updated_at = if cycle.updated_at == 0 {
            now_secs()
        } else {
            cycle.updated_at
        };
        let is_cataloged_int = if cycle.is_cataloged { 1 } else { 0 };

        self.exec_upsert(
            r#"
            INSERT INTO app_icon_cycles (
                app_id, owner, repo, is_cataloged, level,
                l1_url, l2_url, l3_url, l4_url,
                selected_url, cache_file, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
                updated_at = excluded.updated_at;
            "#,
            params![
                clean_id,
                cycle.owner.trim(),
                cycle.repo.trim(),
                is_cataloged_int,
                cycle.level,
                cycle.l1_url.trim(),
                cycle.l2_url.trim(),
                cycle.l3_url.trim(),
                cycle.l4_url.trim(),
                cycle.selected_url.trim(),
                cycle.cache_file.trim(),
                updated_at,
            ],
        )
    }

    /// 更新当前图标轮换级别，并在对应级别 URL 非空时自动同步切换 selected_url
    pub fn set_icon_cycle_level(&self, app_id: &str, level: i32) -> Result<()> {
        let clean = app_id.trim();
        if clean.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.conn.execute(
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
            params![level, now, clean],
        )?;
        Ok(())
    }

    /// 更新当前图标轮换级别及选中的 URL 和本地缓存文件路径
    pub fn set_icon_cycle_selected(
        &self,
        app_id: &str,
        level: i32,
        selected_url: &str,
        cache_file: &str,
    ) -> Result<()> {
        let clean = app_id.trim();
        if clean.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.conn.execute(
            r#"
            UPDATE app_icon_cycles
            SET level = ?1,
                selected_url = ?2,
                cache_file = ?3,
                updated_at = ?4
            WHERE app_id = ?5
            "#,
            params![level, selected_url.trim(), cache_file.trim(), now, clean],
        )?;
        Ok(())
    }

    /// 删除指定 app_id 的图标轮换记录
    pub fn delete_icon_cycle(&self, app_id: &str) -> Result<bool> {
        let clean = app_id.trim();
        if clean.is_empty() {
            return Ok(false);
        }
        let rows = self.conn.execute(
            "DELETE FROM app_icon_cycles WHERE app_id = ?1",
            params![clean],
        )?;
        Ok(rows > 0)
    }

    // --- 便捷别名 (兼容 get / upsert / set_level 简洁调用) ---

    pub fn get(&self, app_id: &str) -> Result<Option<AppIconCycle>> {
        self.get_icon_cycle(app_id)
    }

    pub fn upsert(&self, cycle: &AppIconCycle) -> Result<()> {
        self.upsert_icon_cycle(cycle)
    }

    pub fn set_level(&self, app_id: &str, level: i32) -> Result<()> {
        self.set_icon_cycle_level(app_id, level)
    }
}

/// 模块级便捷函数：根据 app_id 读取图标轮换记录
pub fn get(db: &Database, app_id: &str) -> Result<Option<AppIconCycle>> {
    db.get_icon_cycle(app_id)
}

/// 模块级便捷函数：插入或更新图标轮换记录
pub fn upsert(db: &Database, cycle: &AppIconCycle) -> Result<()> {
    db.upsert_icon_cycle(cycle)
}

/// 模块级便捷函数：更新图标轮换级别
pub fn set_level(db: &Database, app_id: &str, level: i32) -> Result<()> {
    db.set_icon_cycle_level(app_id, level)
}

/// 模块级便捷函数：删除指定图标轮换记录
pub fn delete(db: &Database, app_id: &str) -> Result<bool> {
    db.delete_icon_cycle(app_id)
}
