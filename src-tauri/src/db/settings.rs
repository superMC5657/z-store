use super::{normalize_detail_cache_ttl, Database};
use rusqlite::{params, Result};
use std::collections::HashMap;

impl Database {
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM user_settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO user_settings (key, value)
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            "#,
            params![key, value],
        )?;
        Ok(())
    }

    pub fn remove_setting(&self, key: &str) -> Result<()> {
        self.conn.execute("DELETE FROM user_settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn get_all_settings(&self) -> Result<HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM user_settings")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let mut map = HashMap::new();
        for r in rows {
            let (k, v) = r?;
            map.insert(k, v);
        }
        Ok(map)
    }

    /// 读取应用详情缓存保鲜期 TTL（分钟）。
    /// 优先从数据库设置读取（若用户历史自定义）；
    /// 缺省回退 config.toml 项目基线配置（默认 30 分钟）。
    /// 返回 0 表示每次打开均需向远端条件校验（见 get_cached_app_detail 的 ttl == 0 分支）。
    pub fn get_detail_cache_ttl_minutes(&self) -> i64 {
        self.get_setting("detail_cache_ttl_minutes")
            .ok()
            .flatten()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .map(normalize_detail_cache_ttl)
            .unwrap_or_else(|| crate::config::get_project_config().cache.detail_ttl_minutes)
    }
}
