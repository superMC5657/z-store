use super::{clean, now_secs, Database, ValidatedTable};
use rusqlite::{params, Result};

/// 同应用写入 `view_history` 的防抖窗口（秒）：窗口内重复打开不新增流水行。
pub const VIEW_HISTORY_DEBOUNCE_SECS: i64 = 30;

impl Database {
    /// 收藏（合并式）：已存在返回 false，否则插入返回 true。
    /// `is_cataloged` 由调用方写时按内存目录判定一次后传入（零网络），缺列补齐/新建行默认 0 fail-closed、启动回填校准。
    pub fn add_favorite(&self, app_id: &str, is_cataloged: bool) -> Result<bool> {
        let id = clean(app_id);
        if id.is_empty() {
            return Ok(false);
        }
        let now = now_secs();
        let rows = self.exec_write(
            "INSERT OR IGNORE INTO user_favorites (app_id, favorited_at, is_cataloged) VALUES (?1, ?2, ?3)",
            params![id, now, is_cataloged as i32],
        )?;
        Ok(rows > 0)
    }

    pub fn get_favorites(&self) -> Result<Vec<String>> {
        self.query_vec(
            "SELECT app_id FROM user_favorites ORDER BY favorited_at DESC",
            [],
            |row| row.get(0),
        )
    }

    /// 收藏条目（含收录标记）：与 `get_favorites` 同序，形状见 `FavoriteEntry`。
    pub fn get_favorite_entries(&self) -> Result<Vec<crate::models::FavoriteEntry>> {
        self.query_vec(
            "SELECT app_id, is_cataloged, favorited_at FROM user_favorites ORDER BY favorited_at DESC",
            [],
            |row| {
                Ok(crate::models::FavoriteEntry {
                    app_id: row.get(0)?,
                    is_cataloged: row.get::<_, i64>(1)? != 0,
                    favorited_at: row.get(2)?,
                })
            },
        )
    }

    /// 收录标记回填写点：仅更新标记，不修改 `favorited_at`。
    pub fn set_favorite_cataloged(&self, app_id: &str, is_cataloged: bool) -> Result<()> {
        self.exec_write(
            "UPDATE user_favorites SET is_cataloged = ?1 WHERE app_id = ?2",
            params![is_cataloged as i32, clean(app_id)],
        )?;
        Ok(())
    }

    pub fn toggle_favorite(&self, app_id: &str, is_cataloged: bool) -> Result<bool> {
        let id = clean(app_id);
        let exists = self.record_exists(
            "SELECT 1 FROM user_favorites WHERE app_id = ?1",
            params![id],
        )?;

        if exists {
            self.exec_write("DELETE FROM user_favorites WHERE app_id = ?1", params![id])?;
            crate::notify_affinity_updated();
            Ok(false)
        } else {
            let now = now_secs();
            self.exec_write(
                "INSERT INTO user_favorites (app_id, favorited_at, is_cataloged) VALUES (?1, ?2, ?3)",
                params![id, now, is_cataloged as i32],
            )?;
            crate::notify_affinity_updated();
            Ok(true)
        }
    }

    pub fn record_search_query(&self, query: &str) -> Result<()> {
        let q = clean(query);
        if q.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        // 事务边界：插入 + prune 合并为 1 提交，失败整体回滚返回 Err。
        self.with_immediate_transaction(|| {
            self.exec_write(
                r#"
            INSERT INTO search_history (query, searched_at)
            VALUES (?1, ?2)
            ON CONFLICT(query) DO UPDATE SET
                searched_at = excluded.searched_at;
            "#,
                params![q, now],
            )?;
            let limit = crate::config::get_project_config()
                .limits
                .search_history_limit;
            self.prune_history_table(ValidatedTable::SearchHistory, limit as u64)?;
            Ok(())
        })
    }

    pub fn get_search_history(&self) -> Result<Vec<String>> {
        let limit = crate::config::get_project_config()
            .limits
            .search_history_limit;
        self.query_vec(
            &format!(
                "SELECT query FROM search_history ORDER BY searched_at DESC LIMIT {}",
                limit
            ),
            [],
            |row| row.get(0),
        )
    }

    pub fn clear_search_history(&self) -> Result<()> {
        self.exec_write("DELETE FROM search_history", [])?;
        Ok(())
    }

    pub fn remove_search_query(&self, query: &str) -> Result<()> {
        self.exec_write(
            "DELETE FROM search_history WHERE query = ?1",
            params![clean(query)],
        )?;
        Ok(())
    }

    pub fn record_app_view(&self, app_id: &str) -> Result<()> {
        self.record_app_view_at(app_id, now_secs())?;
        Ok(())
    }

    /// 记录一次应用浏览事件（不去重，30 秒内同应用防抖跳过；返回是否实际落库）。
    pub fn record_app_view_at(&self, app_id: &str, now: i64) -> Result<bool> {
        let id = clean(app_id);
        if id.is_empty() {
            return Ok(false);
        }
        // 事务边界：30s 防抖检查 + 插入 + prune 合并为 1 提交，失败整体回滚返回 Err。
        self.with_immediate_transaction(|| {
            let last_ts: Option<i64> = self.query_scalar_opt(
                "SELECT viewed_at FROM view_history WHERE app_id = ?1 ORDER BY viewed_at DESC, id DESC LIMIT 1",
                params![id],
            )?;
            if let Some(prev) = last_ts {
                if now >= prev && (now - prev) < VIEW_HISTORY_DEBOUNCE_SECS {
                    return Ok(false);
                }
            }
            self.exec_write(
                "INSERT INTO view_history (app_id, viewed_at) VALUES (?1, ?2)",
                params![id, now],
            )?;
            let limit = crate::config::get_project_config()
                .limits
                .view_history_limit;
            self.prune_history_table(ValidatedTable::ViewHistory, limit as u64)?;
            Ok(true)
        })
    }

    /// 按最近浏览时间降序返回去重后的 `(app_id, latest_viewed_at)` 列表。
    pub fn get_recently_viewed_entries(&self, limit: usize) -> Result<Vec<(String, i64)>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        self.query_vec(
            r#"
            SELECT app_id, MAX(viewed_at) AS latest_viewed_at
            FROM view_history
            GROUP BY app_id
            ORDER BY latest_viewed_at DESC, MAX(id) DESC
            LIMIT ?1
            "#,
            params![limit as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }

    pub fn get_recently_viewed_app_ids(&self) -> Result<Vec<String>> {
        let limit = crate::config::get_project_config()
            .limits
            .view_history_limit;
        Ok(self
            .get_recently_viewed_entries(limit)?
            .into_iter()
            .map(|(id, _)| id)
            .collect())
    }
}
