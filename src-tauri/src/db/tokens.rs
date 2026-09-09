use super::Database;
use crate::models::HostTokenEntry;
use rusqlite::{params, Result};

impl Database {
    pub fn get_host_tokens(&self) -> Result<Vec<HostTokenEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at FROM host_tokens ORDER BY host ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(HostTokenEntry {
                host: row.get(0)?,
                token: row.get(1)?,
                rate_limit_remaining: row.get(2)?,
                rate_limit_limit: row.get(3)?,
                rate_limit_reset: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;

        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn get_host_token(&self, host: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT token FROM host_tokens WHERE host = ?1")?;
        let mut rows = stmt.query_map(params![host.to_lowercase()], |row| row.get(0))?;
        if let Some(row) = rows.next() {
            let t: String = row?;
            if t.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(t))
            }
        } else {
            Ok(None)
        }
    }

    pub fn set_host_token(&self, host: &str, token: &str) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            r#"
            INSERT INTO host_tokens (host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at)
            VALUES (?1, ?2, NULL, NULL, NULL, ?3)
            ON CONFLICT(host) DO UPDATE SET
                token = excluded.token,
                updated_at = excluded.updated_at;
            "#,
            params![host.to_lowercase(), token.trim(), now],
        )?;
        Ok(())
    }

    pub fn remove_host_token(&self, host: &str) -> Result<bool> {
        let rows = self.conn.execute(
            "DELETE FROM host_tokens WHERE host = ?1",
            params![host.to_lowercase()],
        )?;
        Ok(rows > 0)
    }

    pub fn update_host_rate_limit(
        &self,
        host: &str,
        remaining: Option<u32>,
        limit: Option<u32>,
        reset: Option<i64>,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            r#"
            INSERT INTO host_tokens (host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at)
            VALUES (?1, '', ?2, ?3, ?4, ?5)
            ON CONFLICT(host) DO UPDATE SET
                rate_limit_remaining = excluded.rate_limit_remaining,
                rate_limit_limit = excluded.rate_limit_limit,
                rate_limit_reset = excluded.rate_limit_reset,
                updated_at = excluded.updated_at;
            "#,
            params![host.to_lowercase(), remaining, limit, reset, now],
        )?;
        Ok(())
    }
}
