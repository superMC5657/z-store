use super::{
    normalize_watch_notify_frequency, Database, WATCH_NOTIFY_FREQUENCY_DEFAULT,
};
use rusqlite::{params, Result};

impl Database {
    // ---------- FR-6.2 关注订阅 ----------

    /// 读取关注通知频率（`startup`|`daily`），非法/缺失回退 `daily`。
    pub fn get_watch_notify_frequency(&self) -> String {
        self.get_setting("watch_notify_frequency")
            .ok()
            .flatten()
            .map(|v| normalize_watch_notify_frequency(&v))
            .unwrap_or_else(|| WATCH_NOTIFY_FREQUENCY_DEFAULT.to_string())
    }

    pub fn watch_app(&self, app_id: &str) -> Result<bool> {
        let id = app_id.trim();
        if id.is_empty() {
            return Ok(false);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let rows = self.conn.execute(
            "INSERT OR IGNORE INTO watched_apps (app_id, added_at, last_notified_version, last_notified_at) VALUES (?1, ?2, NULL, NULL)",
            params![id, now],
        )?;
        Ok(rows > 0)
    }

    pub fn unwatch_app(&self, app_id: &str) -> Result<bool> {
        let rows = self
            .conn
            .execute("DELETE FROM watched_apps WHERE app_id = ?1", params![app_id.trim()])?;
        Ok(rows > 0)
    }

    pub fn get_watched_apps(&self) -> Result<Vec<crate::models::WatchedApp>> {
        let mut stmt = self.conn.prepare(
            "SELECT app_id, added_at, last_notified_version FROM watched_apps ORDER BY added_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(crate::models::WatchedApp {
                app_id: row.get(0)?,
                added_at: row.get(1)?,
                last_notified_version: row.get(2)?,
            })
        })?;
        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn get_watch_last_notified_at(&self, app_id: &str) -> Result<Option<i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT last_notified_at FROM watched_apps WHERE app_id = ?1")?;
        let mut rows = stmt.query(params![app_id.trim()])?;
        if let Some(row) = rows.next()? {
            Ok(row.get(0)?)
        } else {
            Ok(None)
        }
    }

    pub fn set_watch_notified(&self, app_id: &str, version: &str, at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE watched_apps SET last_notified_version = ?1, last_notified_at = ?2 WHERE app_id = ?3",
            params![version, at, app_id.trim()],
        )?;
        Ok(())
    }

    /// 首次建立基线（静默，不触发通知）：仅当从未记录过版本时写入当前版本。
    pub fn init_watch_baseline(&self, app_id: &str, version: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE watched_apps SET last_notified_version = ?1 WHERE app_id = ?2 AND last_notified_version IS NULL",
            params![version, app_id.trim()],
        )?;
        Ok(())
    }

    // ---------- FR-8.3 所有权认证 ----------

    pub fn is_verified_app(&self, app_id: &str) -> Result<bool> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM verified_apps WHERE app_id = ?1)",
            params![app_id.trim()],
            |row| row.get(0),
        )?;
        Ok(exists)
    }

    pub fn mark_verified_app(&self, app_id: &str) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            "INSERT OR IGNORE INTO verified_apps (app_id, verified_at) VALUES (?1, ?2)",
            params![app_id.trim(), now],
        )?;
        Ok(())
    }

    pub fn set_starred(&self, owner: &str, repo: &str, is_starred: bool) -> Result<()> {
        let o = owner.trim().to_lowercase();
        let r = repo.trim().to_lowercase();
        if is_starred {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            self.conn.execute(
                "INSERT OR REPLACE INTO user_stars (owner, repo, starred_at) VALUES (?1, ?2, ?3)",
                params![o, r, now],
            )?;
        } else {
            self.conn.execute(
                "DELETE FROM user_stars WHERE owner = ?1 AND repo = ?2",
                params![o, r],
            )?;
        }
        Ok(())
    }

    pub fn is_starred(&self, owner: &str, repo: &str) -> Result<bool> {
        let o = owner.trim().to_lowercase();
        let r = repo.trim().to_lowercase();
        let mut stmt = self
            .conn
            .prepare("SELECT 1 FROM user_stars WHERE owner = ?1 AND repo = ?2 LIMIT 1")?;
        let exists = stmt.exists(params![o, r])?;
        Ok(exists)
    }

    pub fn get_user_stars(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT owner, repo FROM user_stars ORDER BY starred_at DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}
