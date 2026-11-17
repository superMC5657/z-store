//! `api_etag_cache` 持久化 DAO：HTTP 304 条件请求缓存与 LRU 淘汰。

use super::{dedup_non_empty, Database};
use rusqlite::{params, Result};
use std::collections::HashMap;

/// API ETag 缓存表最大保留行数（按 `last_checked_at DESC` LRU 淘汰）。
pub const API_ETAG_CACHE_MAX_ROWS: usize = 3000;

impl Database {
    pub fn get_etag(&self, endpoint_url: &str) -> Result<Option<String>> {
        self.query_scalar_opt(
            "SELECT etag FROM api_etag_cache WHERE endpoint_url = ?1",
            params![endpoint_url],
        )
    }

    pub fn get_cached_payload(&self, endpoint_url: &str) -> Result<Option<String>> {
        self.query_scalar_opt(
            "SELECT payload_json FROM api_etag_cache WHERE endpoint_url = ?1",
            params![endpoint_url],
        )
    }

    /// 单次读取端点的 `(etag, payload_json)`。
    pub fn get_etag_and_payload(&self, endpoint_url: &str) -> Result<Option<(String, String)>> {
        Ok(self
            .query_vec(
                "SELECT etag, payload_json FROM api_etag_cache WHERE endpoint_url = ?1",
                params![endpoint_url],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .into_iter()
            .next())
    }

    /// 端点是否存在 ETag 缓存行。
    pub fn has_etag_entry(&self, endpoint_url: &str) -> Result<bool> {
        self.record_exists(
            "SELECT 1 FROM api_etag_cache WHERE endpoint_url = ?1",
            params![endpoint_url],
        )
    }

    /// 批量读取 `(etag, payload_json)`，按端点索引（`IN (...)` 分片，未命中端点缺席）。
    pub fn get_etags_and_payloads_batch(
        &self,
        urls: &[String],
    ) -> Result<HashMap<String, (String, String)>> {
        let keys = dedup_non_empty(urls.iter().map(String::as_str));
        let rows = self.query_in_chunks(
            &keys,
            |ph| {
                format!(
                    "SELECT endpoint_url, etag, payload_json FROM api_etag_cache \
                     WHERE endpoint_url IN ({ph})"
                )
            },
            |row| Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?))),
        )?;
        Ok(rows.into_iter().collect())
    }

    pub fn save_etag(
        &self,
        endpoint_url: &str,
        etag: &str,
        payload_json: &str,
        timestamp: i64,
    ) -> Result<()> {
        self.exec_write(
            r#"
            INSERT INTO api_etag_cache (endpoint_url, etag, payload_json, last_checked_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(endpoint_url) DO UPDATE SET
                etag = excluded.etag,
                payload_json = excluded.payload_json,
                last_checked_at = excluded.last_checked_at;
            "#,
            params![endpoint_url, etag, payload_json, timestamp],
        )?;
        Ok(())
    }

    /// 刷新指定端点 ETag 缓存的 `last_checked_at`（`304 Not Modified` 命中时保鲜 LRU 顺序）。
    pub fn touch_etag(&self, endpoint_url: &str, timestamp: i64) -> Result<()> {
        self.exec_write(
            "UPDATE api_etag_cache SET last_checked_at = ?2 WHERE endpoint_url = ?1",
            params![endpoint_url, timestamp],
        )?;
        Ok(())
    }

    /// 删除指定端点的 ETag 缓存记录（如分页收缩时清理不再存在的尾页缓存）。
    pub fn delete_etag(&self, endpoint_url: &str) -> Result<()> {
        self.exec_write(
            "DELETE FROM api_etag_cache WHERE endpoint_url = ?1",
            params![endpoint_url],
        )?;
        Ok(())
    }

    /// 按端点精确前缀清理 ETag 缓存（如退出登录时清理账号专属 `/user/` 端点缓存）。
    pub fn delete_etags_by_prefix(&self, prefix: &str) -> Result<()> {
        if prefix.is_empty() {
            return Ok(());
        }
        self.exec_write(
            "DELETE FROM api_etag_cache WHERE substr(endpoint_url, 1, length(?1)) = ?1",
            params![prefix],
        )?;
        Ok(())
    }

    /// 按 `last_checked_at DESC` 保留最新 `max_rows` 条 ETag 缓存，清理超限陈旧行。
    pub fn prune_api_etag_cache(&self, max_rows: usize) -> Result<usize> {
        if max_rows == 0 {
            return Ok(0);
        }
        let deleted = self.conn.execute(
            r#"
            DELETE FROM api_etag_cache
            WHERE endpoint_url NOT IN (
                SELECT endpoint_url FROM api_etag_cache
                ORDER BY last_checked_at DESC, endpoint_url ASC
                LIMIT ?1
            )
            "#,
            params![max_rows as i64],
        )?;
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_etags_and_payloads_batch_returns_stored_entries() {
        let db = Database::open_in_memory().unwrap();
        db.save_etag("https://api/x", "W/1", "{\"a\":1}", 1)
            .unwrap();
        let hits = db
            .get_etags_and_payloads_batch(&[
                "https://api/x".to_string(),
                "https://api/x".to_string(),
                "https://api/y".to_string(),
            ])
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits["https://api/x"],
            ("W/1".to_string(), "{\"a\":1}".to_string())
        );
    }
}
