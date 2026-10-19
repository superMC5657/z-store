use super::{clean, now_secs, Database, ValidatedTable};
use rusqlite::{params, Result};

impl Database {
    /// 收藏（合并式）：已存在返回 false，否则插入返回 true。
    /// `is_cataloged` 由调用方写时按内存目录判定一次后传入（零网络），缺列补齐/新建行默认 0 fail-closed、启动回填校准。
    pub fn add_favorite(&self, app_id: &str, is_cataloged: bool) -> Result<bool> {
        let id = clean(app_id);
        if id.is_empty() {
            return Ok(false);
        }
        let now = now_secs();
        let rows = self.exec_upsert(
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

    /// 收录标记回填写点（启动/迁移用）：仅更新标记，不碰 `favorited_at`。
    pub fn set_favorite_cataloged(&self, app_id: &str, is_cataloged: bool) -> Result<()> {
        self.exec_upsert(
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
            self.exec_upsert(
                "DELETE FROM user_favorites WHERE app_id = ?1",
                params![id],
            )?;
            Ok(false)
        } else {
            let now = now_secs();
            self.exec_upsert(
                "INSERT INTO user_favorites (app_id, favorited_at, is_cataloged) VALUES (?1, ?2, ?3)",
                params![id, now, is_cataloged as i32],
            )?;
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
            self.exec_upsert(
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
        self.exec_upsert("DELETE FROM search_history", [])?;
        Ok(())
    }

    pub fn remove_search_query(&self, query: &str) -> Result<()> {
        self.exec_upsert(
            "DELETE FROM search_history WHERE query = ?1",
            params![clean(query)],
        )?;
        Ok(())
    }

    pub fn record_app_view(&self, app_id: &str) -> Result<()> {
        let id = clean(app_id);
        if id.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        // 事务边界：插入 + prune 合并为 1 提交，失败整体回滚返回 Err。
        self.with_immediate_transaction(|| {
            self.exec_upsert(
                r#"
            INSERT INTO view_history (app_id, viewed_at)
            VALUES (?1, ?2)
            ON CONFLICT(app_id) DO UPDATE SET
                viewed_at = excluded.viewed_at;
            "#,
                params![id, now],
            )?;
            let limit = crate::config::get_project_config()
                .limits
                .view_history_limit;
            self.prune_history_table(ValidatedTable::ViewHistory, limit as u64)?;
            Ok(())
        })
    }

    pub fn get_recently_viewed_app_ids(&self) -> Result<Vec<String>> {
        let limit = crate::config::get_project_config()
            .limits
            .view_history_limit;
        self.query_vec(
            &format!(
                "SELECT app_id FROM view_history ORDER BY viewed_at DESC LIMIT {}",
                limit
            ),
            [],
            |row| row.get(0),
        )
    }

    pub fn clear_view_history(&self) -> Result<()> {
        self.exec_upsert("DELETE FROM view_history", [])?;
        Ok(())
    }
}
