use super::{now_secs, Database};
use rusqlite::{params, Result};

impl Database {
    /// 收藏（合并式）：已存在返回 false，否则插入返回 true。
    pub fn add_favorite(&self, app_id: &str) -> Result<bool> {
        let id = app_id.trim();
        if id.is_empty() {
            return Ok(false);
        }
        let now = now_secs();
        let rows = self.conn.execute(
            "INSERT OR IGNORE INTO user_favorites (app_id, favorited_at) VALUES (?1, ?2)",
            params![id, now],
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

    pub fn toggle_favorite(&self, app_id: &str) -> Result<bool> {
        let exists = self.record_exists(
            "SELECT 1 FROM user_favorites WHERE app_id = ?1",
            params![app_id],
        )?;

        if exists {
            self.conn.execute(
                "DELETE FROM user_favorites WHERE app_id = ?1",
                params![app_id],
            )?;
            Ok(false)
        } else {
            let now = now_secs();
            self.conn.execute(
                "INSERT INTO user_favorites (app_id, favorited_at) VALUES (?1, ?2)",
                params![app_id, now],
            )?;
            Ok(true)
        }
    }

    pub fn record_search_query(&self, query: &str) -> Result<()> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(());
        }
        let now = now_secs();
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
        self.conn.execute(
            &format!(
                "DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY searched_at DESC LIMIT {})",
                limit
            ),
            [],
        )?;
        Ok(())
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
        self.conn.execute("DELETE FROM search_history", [])?;
        Ok(())
    }

    pub fn remove_search_query(&self, query: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM search_history WHERE query = ?1",
            params![query.trim()],
        )?;
        Ok(())
    }

    pub fn record_app_view(&self, app_id: &str) -> Result<()> {
        let id = app_id.trim();
        if id.is_empty() {
            return Ok(());
        }
        let now = now_secs();
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
        self.conn.execute(
            &format!(
                "DELETE FROM view_history WHERE id NOT IN (SELECT id FROM view_history ORDER BY viewed_at DESC LIMIT {})",
                limit
            ),
            [],
        )?;
        Ok(())
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
        self.conn.execute("DELETE FROM view_history", [])?;
        Ok(())
    }
}
