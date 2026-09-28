use super::{now_secs, Database};
use crate::models::AppDetail;
use rusqlite::{params, Result};

impl Database {
    pub fn get_etag(&self, endpoint_url: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT etag FROM api_etag_cache WHERE endpoint_url = ?1")?;
        let mut rows = stmt.query(params![endpoint_url])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn get_cached_payload(&self, endpoint_url: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT payload_json FROM api_etag_cache WHERE endpoint_url = ?1")?;
        let mut rows = stmt.query(params![endpoint_url])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn save_etag(
        &self,
        endpoint_url: &str,
        etag: &str,
        payload_json: &str,
        timestamp: i64,
    ) -> Result<()> {
        self.exec_upsert(
            r#"
            INSERT INTO api_etag_cache (endpoint_url, etag, payload_json, last_checked_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(endpoint_url) DO UPDATE SET
                etag = excluded.etag,
                payload_json = excluded.payload_json,
                last_checked_at = excluded.last_checked_at;
            "#,
            params![endpoint_url, etag, payload_json, timestamp],
        )
    }

    pub fn get_cached_app_detail(
        &self,
        app_id: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<Option<AppDetail>> {
        let clean = app_id.trim();
        if clean.is_empty() {
            return Ok(None);
        }

        let mut stmt = self.conn.prepare(
            "SELECT detail_json, cached_at FROM app_details_cache WHERE app_id = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![clean])?;
        if let Some(row) = rows.next()? {
            let json_str: String = row.get(0)?;
            let cached_at: i64 = row.get(1)?;
            if let Some(ttl) = ttl_seconds {
                if ttl > 0 {
                    let now = now_secs();
                    if now.saturating_sub(cached_at) >= ttl {
                        // 缓存已过期，返回 None 以促使远端触发 ETag 条件校验
                        return Ok(None);
                    }
                } else if ttl == 0 {
                    // ttl == 0 代表每次打开均需要向远端校验
                    return Ok(None);
                }
            }
            if let Ok(mut detail) = serde_json::from_str::<AppDetail>(&json_str) {
                detail.cached_at = Some(cached_at);
                return Ok(Some(detail));
            }
        }
        Ok(None)
    }

    /// 即使缓存过期，也返回已存储的详情副本（用于离线弱网或 GitHub API 故障时的降级呈现）
    pub fn get_cached_app_detail_fallback(&self, app_id: &str) -> Result<Option<AppDetail>> {
        self.get_cached_app_detail(app_id, None)
    }

    /// 当远端返回 304 Not Modified 时，快速刷新 cached_at 时间戳，零开销延长保鲜期
    pub fn touch_cached_app_detail(&self, app_id: &str, new_cached_at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE app_details_cache SET cached_at = ?1 WHERE app_id = ?2",
            params![new_cached_at, app_id.trim()],
        )?;
        Ok(())
    }

    pub fn save_cached_app_detail(&self, app_id: &str, detail: &AppDetail) -> Result<()> {
        let clean_id = app_id.trim();
        let now = now_secs();
        let json_str = serde_json::to_string(detail)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

        self.exec_upsert(
            r#"
            INSERT INTO app_details_cache (app_id, name, latest_version, detail_json, cached_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(app_id) DO UPDATE SET
                name = excluded.name,
                latest_version = excluded.latest_version,
                detail_json = excluded.detail_json,
                cached_at = excluded.cached_at;
            "#,
            params![clean_id, detail.name, detail.latest_version, json_str, now,],
        )
    }

    /// 测试专用：清空详情缓存（生产路径只增量写入，从不全清）。
    #[cfg(test)]
    pub fn clear_app_details_cache(&self) -> Result<()> {
        self.conn.execute("DELETE FROM app_details_cache", [])?;
        Ok(())
    }

    pub fn get_icon_cache_url(&self, cache_key: &str) -> Result<Option<String>> {
        let clean = cache_key.trim();
        if clean.is_empty() {
            return Ok(None);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT remote_url FROM icon_cache_meta WHERE cache_key = ?1")?;
        let mut rows = stmt.query(params![clean])?;
        if let Some(row) = rows.next()? {
            let url: String = row.get(0)?;
            return Ok(Some(url));
        }
        Ok(None)
    }

    pub fn save_icon_cache_url(&self, cache_key: &str, remote_url: &str) -> Result<()> {
        let clean_key = cache_key.trim();
        let clean_url = remote_url.trim();
        if clean_key.is_empty() || clean_url.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_upsert(
            "INSERT INTO icon_cache_meta (cache_key, remote_url, cached_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(cache_key) DO UPDATE SET remote_url = excluded.remote_url, cached_at = excluded.cached_at",
            params![clean_key, clean_url, now],
        )
    }
}
