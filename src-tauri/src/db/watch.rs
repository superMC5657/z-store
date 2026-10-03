use super::{
    clean, normalize_watch_notify_frequency, now_secs, Database, WATCH_NOTIFY_FREQUENCY_DEFAULT,
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
        let id = clean(app_id);
        if id.is_empty() {
            return Ok(false);
        }
        let now = now_secs();
        let rows = self.exec_upsert(
            "INSERT OR IGNORE INTO watched_apps (app_id, added_at, last_notified_version, last_notified_at) VALUES (?1, ?2, NULL, NULL)",
            params![id, now],
        )?;
        Ok(rows > 0)
    }

    pub fn unwatch_app(&self, app_id: &str) -> Result<bool> {
        let rows = self.exec_upsert(
            "DELETE FROM watched_apps WHERE app_id = ?1",
            params![clean(app_id)],
        )?;
        Ok(rows > 0)
    }

    pub fn get_watched_apps(&self) -> Result<Vec<crate::models::WatchedApp>> {
        self.query_vec(
            "SELECT app_id, added_at, last_notified_version FROM watched_apps ORDER BY added_at DESC",
            [],
            |row| {
                Ok(crate::models::WatchedApp {
                    app_id: row.get(0)?,
                    added_at: row.get(1)?,
                    last_notified_version: row.get(2)?,
                })
            },
        )
    }

    pub fn get_watch_last_notified_at(&self, app_id: &str) -> Result<Option<i64>> {
        self.query_scalar_opt(
            "SELECT last_notified_at FROM watched_apps WHERE app_id = ?1",
            params![clean(app_id)],
        )
    }

    pub fn set_watch_notified(&self, app_id: &str, version: &str, at: i64) -> Result<()> {
        self.exec_upsert(
            "UPDATE watched_apps SET last_notified_version = ?1, last_notified_at = ?2 WHERE app_id = ?3",
            params![version, at, clean(app_id)],
        )?;
        Ok(())
    }

    /// 首次建立基线（静默，不触发通知）：仅当从未记录过版本时写入当前版本。
    pub fn init_watch_baseline(&self, app_id: &str, version: &str) -> Result<()> {
        self.exec_upsert(
            "UPDATE watched_apps SET last_notified_version = ?1 WHERE app_id = ?2 AND last_notified_version IS NULL",
            params![version, clean(app_id)],
        )?;
        Ok(())
    }

    // ---------- FR-8.3 所有权认证 ----------

    pub fn is_verified_app(&self, app_id: &str) -> Result<bool> {
        self.record_exists(
            "SELECT 1 FROM verified_apps WHERE app_id = ?1",
            params![clean(app_id)],
        )
    }

    pub fn mark_verified_app(&self, app_id: &str) -> Result<()> {
        let id = clean(app_id);
        if id.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_upsert(
            "INSERT OR IGNORE INTO verified_apps (app_id, verified_at) VALUES (?1, ?2)",
            params![id, now],
        )?;
        Ok(())
    }

    pub fn set_starred(&self, owner: &str, repo: &str, is_starred: bool) -> Result<()> {
        let o = clean(owner).to_lowercase();
        let r = clean(repo).to_lowercase();
        if is_starred {
            if o.is_empty() || r.is_empty() {
                return Ok(());
            }
            let now = now_secs();
            self.exec_upsert(
                "INSERT OR REPLACE INTO user_stars (owner, repo, starred_at) VALUES (?1, ?2, ?3)",
                params![o, r, now],
            )?;
        } else {
            self.exec_upsert(
                "DELETE FROM user_stars WHERE owner = ?1 AND repo = ?2",
                params![o, r],
            )?;
        }
        Ok(())
    }

    pub fn is_starred(&self, owner: &str, repo: &str) -> Result<bool> {
        let o = clean(owner).to_lowercase();
        let r = clean(repo).to_lowercase();
        self.record_exists(
            "SELECT 1 FROM user_stars WHERE owner = ?1 AND repo = ?2 LIMIT 1",
            params![o, r],
        )
    }
}
