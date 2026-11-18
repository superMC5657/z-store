use super::{
    clean, normalize_watch_notify_frequency, now_secs, Database, WATCH_NOTIFY_FREQUENCY_DEFAULT,
};
use rusqlite::{params, Result};

impl Database {
    // ---------- 关注订阅 ----------

    /// 读取关注通知频率（`startup`|`daily`），非法/缺失回退 `daily`。
    pub fn get_watch_notify_frequency(&self) -> String {
        self.get_setting("watch_notify_frequency")
            .ok()
            .flatten()
            .map(|v| normalize_watch_notify_frequency(&v))
            .unwrap_or_else(|| WATCH_NOTIFY_FREQUENCY_DEFAULT.to_string())
    }

    pub fn watch_app(&self, app_id: &str, is_cataloged: bool) -> Result<bool> {
        let id = clean(app_id);
        if id.is_empty() {
            return Ok(false);
        }
        let now = now_secs();
        let rows = self.exec_write(
            "INSERT OR IGNORE INTO watched_apps (app_id, added_at, last_notified_version, last_notified_at, is_cataloged) VALUES (?1, ?2, NULL, NULL, ?3)",
            params![id, now, is_cataloged as i32],
        )?;
        if rows > 0 {
            crate::notify_affinity_updated();
        }
        Ok(rows > 0)
    }

    pub fn unwatch_app(&self, app_id: &str) -> Result<bool> {
        let rows = self.exec_write(
            "DELETE FROM watched_apps WHERE app_id = ?1",
            params![clean(app_id)],
        )?;
        if rows > 0 {
            crate::notify_affinity_updated();
        }
        Ok(rows > 0)
    }

    pub fn get_watched_apps(&self) -> Result<Vec<crate::models::WatchedApp>> {
        self.query_vec(
            "SELECT app_id, added_at, last_notified_version, is_cataloged FROM watched_apps ORDER BY added_at DESC",
            [],
            |row| {
                Ok(crate::models::WatchedApp {
                    app_id: row.get(0)?,
                    added_at: row.get(1)?,
                    last_notified_version: row.get(2)?,
                    is_cataloged: row.get::<_, i64>(3)? != 0,
                })
            },
        )
    }

    /// 收录标记回填写点：仅更新标记，不修改通知基线字段。
    pub fn set_watched_cataloged(&self, app_id: &str, is_cataloged: bool) -> Result<()> {
        self.exec_write(
            "UPDATE watched_apps SET is_cataloged = ?1 WHERE app_id = ?2",
            params![is_cataloged as i32, clean(app_id)],
        )?;
        Ok(())
    }

    /// 上次发出提醒的时间；从未提醒（列为 NULL）或未关注均为 None。
    pub fn get_watch_last_notified_at(&self, app_id: &str) -> Result<Option<i64>> {
        Ok(self
            .query_scalar_opt::<Option<i64>, _>(
                "SELECT last_notified_at FROM watched_apps WHERE app_id = ?1",
                params![clean(app_id)],
            )?
            .flatten())
    }

    pub fn set_watch_notified(&self, app_id: &str, version: &str, at: i64) -> Result<()> {
        self.exec_write(
            "UPDATE watched_apps SET last_notified_version = ?1, last_notified_at = ?2 WHERE app_id = ?3",
            params![version, at, clean(app_id)],
        )?;
        Ok(())
    }

    /// 待处理的关注提醒（最近通知在前）：该版本确实发出过提醒（`last_notified_at` 非空，
    /// 静默基线不写该列故不计入）且用户尚未确认。提醒在重启后仍可读回，直至确认或取消关注。
    pub fn get_pending_watch_notifications(
        &self,
    ) -> Result<Vec<crate::models::WatchUpdatedPayload>> {
        self.query_vec(
            "SELECT app_id, last_notified_version FROM watched_apps \
             WHERE last_notified_at IS NOT NULL \
               AND last_notified_version IS NOT NULL \
               AND last_notified_version IS NOT dismissed_version \
             ORDER BY last_notified_at DESC, app_id",
            [],
            |row| {
                Ok(crate::models::WatchUpdatedPayload {
                    app_id: row.get(0)?,
                    version: row.get(1)?,
                })
            },
        )
    }

    /// 确认当前提醒：记下已确认版本与时间，更新的 Release 到来时会再次提醒。
    pub fn dismiss_watch_notification(&self, app_id: &str) -> Result<bool> {
        let rows = self.exec_write(
            "UPDATE watched_apps SET dismissed_version = last_notified_version, dismissed_at = ?2 \
             WHERE app_id = ?1 AND last_notified_at IS NOT NULL \
               AND last_notified_version IS NOT dismissed_version",
            params![clean(app_id), now_secs()],
        )?;
        Ok(rows > 0)
    }

    /// 已确认的关注提醒（最近确认在前）：确认的正是当前最新提醒版本。
    /// 之后若有更新的 Release，该应用回到待处理列表，不再出现在此。
    pub fn get_dismissed_watch_notifications(
        &self,
    ) -> Result<Vec<crate::models::WatchDismissedEntry>> {
        self.query_vec(
            "SELECT app_id, dismissed_version, COALESCE(dismissed_at, last_notified_at) AS at \
             FROM watched_apps \
             WHERE last_notified_at IS NOT NULL \
               AND dismissed_version IS NOT NULL \
               AND dismissed_version = last_notified_version \
             ORDER BY at DESC, app_id",
            [],
            |row| {
                Ok(crate::models::WatchDismissedEntry {
                    app_id: row.get(0)?,
                    version: row.get(1)?,
                    dismissed_at: row.get(2)?,
                })
            },
        )
    }

    /// 撤销确认：该提醒回到待处理列表。
    pub fn restore_watch_notification(&self, app_id: &str) -> Result<bool> {
        let rows = self.exec_write(
            "UPDATE watched_apps SET dismissed_version = NULL, dismissed_at = NULL \
             WHERE app_id = ?1 AND dismissed_version IS NOT NULL",
            params![clean(app_id)],
        )?;
        Ok(rows > 0)
    }

    /// 首次建立基线（静默，不触发通知）：仅当从未记录过版本时写入当前版本。
    pub fn init_watch_baseline(&self, app_id: &str, version: &str) -> Result<()> {
        self.exec_write(
            "UPDATE watched_apps SET last_notified_version = ?1 WHERE app_id = ?2 AND last_notified_version IS NULL",
            params![version, clean(app_id)],
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
            self.exec_write(
                "INSERT OR REPLACE INTO user_stars (owner, repo, starred_at) VALUES (?1, ?2, ?3)",
                params![o, r, now],
            )?;
        } else {
            self.exec_write(
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
