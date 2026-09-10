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

impl Database {
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
