use super::Database;
use rusqlite::{params, Result};

impl Database {
    /// 收藏（合并式）：已存在返回 false，否则插入返回 true。
    pub fn add_favorite(&self, app_id: &str) -> Result<bool> {
        let id = app_id.trim();
        if id.is_empty() {
            return Ok(false);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let rows = self.conn.execute(
            "INSERT OR IGNORE INTO user_favorites (app_id, favorited_at) VALUES (?1, ?2)",
            params![id, now],
        )?;
        Ok(rows > 0)
    }

    pub fn get_favorites(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT app_id FROM user_favorites ORDER BY favorited_at DESC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut favs = Vec::new();
        for r in rows {
            favs.push(r?);
        }
        Ok(favs)
    }

    pub fn toggle_favorite(&self, app_id: &str) -> Result<bool> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM user_favorites WHERE app_id = ?1)",
            params![app_id],
            |row| row.get(0),
        )?;

        if exists {
            self.conn.execute(
                "DELETE FROM user_favorites WHERE app_id = ?1",
                params![app_id],
            )?;
            Ok(false)
        } else {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            r#"
            INSERT INTO search_history (query, searched_at)
            VALUES (?1, ?2)
            ON CONFLICT(query) DO UPDATE SET
                searched_at = excluded.searched_at;
            "#,
            params![q, now],
        )?;
        let limit = crate::config::get_project_config().limits.search_history_limit;
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
        let limit = crate::config::get_project_config().limits.search_history_limit;
        let mut stmt = self.conn.prepare(
            &format!(
                "SELECT query FROM search_history ORDER BY searched_at DESC LIMIT {}",
                limit
            ),
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            r#"
            INSERT INTO view_history (app_id, viewed_at)
            VALUES (?1, ?2)
            ON CONFLICT(app_id) DO UPDATE SET
                viewed_at = excluded.viewed_at;
            "#,
            params![id, now],
        )?;
        let limit = crate::config::get_project_config().limits.view_history_limit;
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
        let limit = crate::config::get_project_config().limits.view_history_limit;
        let mut stmt = self.conn.prepare(
            &format!(
                "SELECT app_id FROM view_history ORDER BY viewed_at DESC LIMIT {}",
                limit
            ),
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn clear_view_history(&self) -> Result<()> {
        self.conn.execute("DELETE FROM view_history", [])?;
        Ok(())
    }
}
