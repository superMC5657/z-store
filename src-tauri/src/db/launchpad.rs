use super::{clean, now_secs, Database};
use rusqlite::{params, Result};

/// 开源广场清单快照单条至多 512 KiB，超限拒绝落盘。
pub const LAUNCHPAD_FEED_CACHE_MAX_BYTES: usize = 512 * 1024;
/// 快照最多保留的行数（默认源 + 少量自定义源）。
pub const LAUNCHPAD_FEED_CACHE_MAX_ROWS: usize = 3;
/// 快照离线保留期：14 天。
pub const LAUNCHPAD_SNAPSHOT_RETENTION_SECS: i64 = 14 * 86400;

impl Database {
    /// 读取某清单源的最近快照，返回 `(payload_json, cached_at)`。
    pub fn get_launchpad_feed_cache(&self, source_url: &str) -> Result<Option<(String, i64)>> {
        let key = clean(source_url);
        if key.is_empty() {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT payload_json, cached_at FROM launchpad_feed_cache WHERE source_url = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some((row.get(0)?, row.get(1)?)))
        } else {
            Ok(None)
        }
    }

    /// 写入（覆盖）某清单源快照；载荷超过 `LAUNCHPAD_FEED_CACHE_MAX_BYTES` 时拒绝。
    pub fn save_launchpad_feed_cache(&self, source_url: &str, payload_json: &str) -> Result<()> {
        let key = clean(source_url);
        if key.is_empty() || payload_json.is_empty() {
            return Ok(());
        }
        if payload_json.len() > LAUNCHPAD_FEED_CACHE_MAX_BYTES {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "launchpad_feed_payload_too_large",
                ),
            )));
        }
        self.exec_write(
            r#"
            INSERT INTO launchpad_feed_cache (source_url, payload_json, payload_bytes, cached_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(source_url) DO UPDATE SET
                payload_json = excluded.payload_json,
                payload_bytes = excluded.payload_bytes,
                cached_at = excluded.cached_at
            "#,
            params![key, payload_json, payload_json.len() as i64, now_secs()],
        )?;
        Ok(())
    }

    /// 刷新快照时间戳（304 命中时调用，延长离线窗口而不重写载荷）。
    pub fn touch_launchpad_feed_cache(&self, source_url: &str) -> Result<()> {
        let key = clean(source_url);
        if key.is_empty() {
            return Ok(());
        }
        self.exec_write(
            "UPDATE launchpad_feed_cache SET cached_at = ?2 WHERE source_url = ?1",
            params![key, now_secs()],
        )?;
        Ok(())
    }

    /// 清扫超过 14 天离线窗口的快照，并只保留最近 3 行。
    pub fn prune_launchpad_feed_cache(&self, now: i64) -> Result<usize> {
        let cutoff = now.saturating_sub(LAUNCHPAD_SNAPSHOT_RETENTION_SECS);
        let expired = self.conn.execute(
            "DELETE FROM launchpad_feed_cache WHERE cached_at <= ?1",
            params![cutoff],
        )?;
        let overflow = self.conn.execute(
            r#"
            DELETE FROM launchpad_feed_cache
            WHERE source_url NOT IN (
                SELECT source_url FROM launchpad_feed_cache
                ORDER BY cached_at DESC, source_url ASC
                LIMIT ?1
            )
            "#,
            params![LAUNCHPAD_FEED_CACHE_MAX_ROWS as i64],
        )?;
        Ok(expired + overflow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_get_roundtrip_and_oversize_rejected() {
        let db = Database::open_in_memory().unwrap();
        db.save_launchpad_feed_cache("https://x/launchpad.json", "{\"version\":1}")
            .unwrap();
        let (payload, _) = db
            .get_launchpad_feed_cache("https://x/launchpad.json")
            .unwrap()
            .unwrap();
        assert_eq!(payload, "{\"version\":1}");

        let huge = "x".repeat(LAUNCHPAD_FEED_CACHE_MAX_BYTES + 1);
        assert!(db.save_launchpad_feed_cache("https://y", &huge).is_err());
        assert!(db.get_launchpad_feed_cache("https://y").unwrap().is_none());
    }

    #[test]
    fn prune_drops_expired_and_overflow_rows() {
        let db = Database::open_in_memory().unwrap();
        for (i, url) in ["a", "b", "c", "d"].iter().enumerate() {
            db.conn
                .execute(
                    "INSERT INTO launchpad_feed_cache (source_url, payload_json, payload_bytes, cached_at) VALUES (?1, '{}', 2, ?2)",
                    params![url, 1_000_000 + i as i64],
                )
                .unwrap();
        }
        db.conn
            .execute(
                "INSERT INTO launchpad_feed_cache (source_url, payload_json, payload_bytes, cached_at) VALUES ('old', '{}', 2, 1)",
                [],
            )
            .unwrap();
        let removed = db.prune_launchpad_feed_cache(1_000_010).unwrap();
        assert_eq!(removed, 2);
        assert!(db.get_launchpad_feed_cache("old").unwrap().is_none());
        assert!(db.get_launchpad_feed_cache("a").unwrap().is_none());
        assert!(db.get_launchpad_feed_cache("d").unwrap().is_some());
    }
}
