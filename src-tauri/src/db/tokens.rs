use super::{clean, now_secs, Database};
use rusqlite::{params, Result};

impl Database {
    pub fn get_host_token(&self, host: &str) -> Result<Option<String>> {
        let val: Option<String> = self.query_scalar_opt(
            "SELECT token FROM host_tokens WHERE host = ?1",
            params![clean(host).to_lowercase()],
        )?;
        Ok(val.filter(|t| !clean(t).is_empty()))
    }

    pub fn update_host_rate_limit(
        &self,
        host: &str,
        remaining: Option<u32>,
        limit: Option<u32>,
        reset: Option<i64>,
    ) -> Result<()> {
        let now = now_secs();
        self.exec_write(
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
