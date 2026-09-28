pub mod apps;
pub mod cache;
pub mod history;
pub mod rules;
pub mod schema;
pub mod settings;
pub mod tokens;
pub mod watch;

#[cfg(test)]
mod tests;

use rusqlite::{Connection, Result};
use std::path::Path;

pub struct Database {
    pub(crate) conn: Connection,
}

/// ADR-0007：应用详情缓存保鲜期（TTL）默认推荐值（分钟，优先读取 config.toml）。
pub fn default_detail_cache_ttl_minutes() -> i64 {
    crate::config::get_project_config().cache.detail_ttl_minutes
}
/// ADR-0007：TTL 有效挡位（分钟）：0=每次实时校验，10/30/60/360/1440。
pub const DETAIL_CACHE_TTL_VALID_MINUTES: [i64; 6] = [0, 10, 30, 60, 360, 1440];

/// FR-6.2：关注通知频率默认值（每天至多通知一次）。
pub const WATCH_NOTIFY_FREQUENCY_DEFAULT: &str = "daily";
/// FR-6.2：关注通知频率有效值：`startup`（每次启动检查即通知）/`daily`。
pub const WATCH_NOTIFY_FREQUENCY_VALID: [&str; 2] = ["startup", "daily"];

/// 将任意输入归一化到关注通知频率有效值；非法值回退默认 `daily`。
pub fn normalize_watch_notify_frequency(value: &str) -> String {
    let clean = value.trim().to_lowercase();
    if WATCH_NOTIFY_FREQUENCY_VALID.contains(&clean.as_str()) {
        clean
    } else {
        WATCH_NOTIFY_FREQUENCY_DEFAULT.to_string()
    }
}

/// 将任意输入归一化到 TTL 有效挡位；非法值回退 config.toml 默认值。
/// 调用方应在持久化前用此函数清洗，保证库中只存有效挡位。
pub fn normalize_detail_cache_ttl(minutes: i64) -> i64 {
    if DETAIL_CACHE_TTL_VALID_MINUTES.contains(&minutes) {
        minutes
    } else {
        default_detail_cache_ttl_minutes()
    }
}

/// 设置项写入侧统一清洗：仅对存在有效值集的键归一化，其余原样透传。
/// 持久化前必须经此函数（ADR-0007 TTL 挡位 / FR-6.2 通知频率）。
pub fn normalize_setting_value(key: &str, value: &str) -> String {
    if key == "detail_cache_ttl_minutes" {
        value
            .trim()
            .parse::<i64>()
            .map(normalize_detail_cache_ttl)
            .unwrap_or_else(|_| default_detail_cache_ttl_minutes())
            .to_string()
    } else if key == "watch_notify_frequency" {
        normalize_watch_notify_frequency(value)
    } else {
        value.to_string()
    }
}

/// SystemTime 唯一落点：返回当前 Unix 秒数（db 内统一使用，避免散落样板）。
pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

impl Database {
    pub(crate) fn query_vec<T, P, F>(&self, sql: &str, params: P, f: F) -> Result<Vec<T>>
    where
        P: rusqlite::Params,
        F: FnMut(&rusqlite::Row<'_>) -> Result<T>,
    {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, f)?;
        rows.collect()
    }

    pub(crate) fn exec_upsert<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<()> {
        self.conn.execute(sql, params)?;
        Ok(())
    }

    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
        let _ = conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        );
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }
}
