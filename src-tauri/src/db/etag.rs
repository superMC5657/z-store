//! `api_etag_cache` 持久化 DAO：HTTP 304 条件请求缓存与 LRU 淘汰。

use super::Database;
use rusqlite::{params, Result};

/// API ETag 缓存表最大保留行数（按 `last_checked_at DESC` LRU 淘汰）。
pub const API_ETAG_CACHE_MAX_ROWS: usize = 1000;

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
