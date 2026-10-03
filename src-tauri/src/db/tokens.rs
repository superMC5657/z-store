use super::{clean, now_secs, Database};
use crate::models::HostTokenEntry;
use rusqlite::{params, Result};

impl Database {
    pub fn get_host_tokens(&self) -> Result<Vec<HostTokenEntry>> {
        self.query_vec(
            "SELECT host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at FROM host_tokens ORDER BY host ASC",
            [],
            |row| {
                Ok(HostTokenEntry {
                    host: row.get(0)?,
                    token: row.get(1)?,
                    rate_limit_remaining: row.get(2)?,
                    rate_limit_limit: row.get(3)?,
                    rate_limit_reset: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
    }

    pub fn get_host_token(&self, host: &str) -> Result<Option<String>> {
        let val: Option<String> = self.query_scalar_opt(
            "SELECT token FROM host_tokens WHERE host = ?1",
            params![clean(host).to_lowercase()],
        )?;
        Ok(val.filter(|t| !clean(t).is_empty()))
    }

    pub fn set_host_token(&self, host: &str, token: &str) -> Result<()> {
        let now = now_secs();
        self.exec_upsert(
            r#"
            INSERT INTO host_tokens (host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at)
            VALUES (?1, ?2, NULL, NULL, NULL, ?3)
            ON CONFLICT(host) DO UPDATE SET
                token = excluded.token,
                updated_at = excluded.updated_at;
            "#,
            params![clean(host).to_lowercase(), clean(token), now],
        )?;
        Ok(())
    }

    pub fn remove_host_token(&self, host: &str) -> Result<bool> {
        let rows = self.exec_upsert(
            "DELETE FROM host_tokens WHERE host = ?1",
            params![clean(host).to_lowercase()],
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
        let now = now_secs();
        self.exec_upsert(
            r#"
            INSERT INTO host_tokens (host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at)
            VALUES (?1, '', ?2, ?3, ?4, ?5)
            ON CONFLICT(host) DO UPDATE SET
                rate_limit_remaining = excluded.rate_limit_remaining,
                rate_limit_limit = excluded.rate_limit_limit,
                rate_limit_reset = excluded.rate_limit_reset,
                updated_at = excluded.updated_at;
            "#,
            params![clean(host).to_lowercase(), remaining, limit, reset, now],
        )?;
        Ok(())
    }
}
