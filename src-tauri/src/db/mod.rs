pub mod apps;
pub mod cache;
pub mod history;
pub mod icon_cycle;
pub mod rules;
pub mod schema;
pub mod settings;
pub mod tokens;
pub mod watch;

pub use icon_cycle::AppIconCycle;

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
    let clean_value = clean(value).to_lowercase();
    if WATCH_NOTIFY_FREQUENCY_VALID.contains(&clean_value.as_str()) {
        clean_value
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
        clean(value)
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

/// 输入清洗唯一落点：去首尾空白（db 内统一使用，避免 trim() 散写）。
#[inline]
pub(crate) fn clean(s: &str) -> &str {
    s.trim()
}

/// 历史裁剪表白名单（防 SQL 注入：表名/排序列仅允许白名单常量，limit 为整数格式化）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ValidatedTable {
    SearchHistory,
    ViewHistory,
}

impl ValidatedTable {
    fn table_name(self) -> &'static str {
        match self {
            Self::SearchHistory => "search_history",
            Self::ViewHistory => "view_history",
        }
    }

    fn order_col(self) -> &'static str {
        match self {
            Self::SearchHistory => "searched_at",
            Self::ViewHistory => "viewed_at",
        }
    }
}

/// SystemTime 唯一落点：返回当前 Unix 秒数（db 内统一使用，避免散落样板）。
pub(crate) fn now_secs() -> i64 {
    crate::now_secs()
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

    /// 显式事务边界（Top1+2 写包事务化）：
    /// `BEGIN IMMEDIATE` → 闭包内全部写 → `COMMIT`，失败 `ROLLBACK` 并返回 Err。
    /// 用 `&self` + `execute_batch` 实现以兼容现有 `&self` 写 API（调用方经 `state.db()` 互斥锁已独占，
    /// 无嵌套事务），WAL/`busy_timeout` 保持不变，不改 schema/API 形状。
    /// 调用方保持 `let _ =`/`ok()` 吞错语义：事务失败返回 Err，上层忽略并由下次搜索/详情重试。
    pub(crate) fn with_immediate_transaction<T>(
        &self,
        f: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let res = f();
        match res {
            Ok(v) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub(crate) fn exec_upsert<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<usize> {
        self.conn.execute(sql, params)
    }

    /// 历史裁剪唯一落点：白名单表名防注入，limit 为整数格式化（调用方需 `as u64` 传入配置值）。
    pub(crate) fn prune_history_table(
        &self,
        table: ValidatedTable,
        limit: u64,
    ) -> Result<()> {
        let sql = format!(
            "DELETE FROM {} WHERE id NOT IN (SELECT id FROM {} ORDER BY {} DESC LIMIT {})",
            table.table_name(),
            table.table_name(),
            table.order_col(),
            limit
        );
        self.exec_upsert(&sql, [])?;
        Ok(())
    }

    pub fn query_scalar_opt<T, P>(&self, sql: &str, params: P) -> Result<Option<T>>
    where
        T: rusqlite::types::FromSql,
        P: rusqlite::Params,
    {
        let mut stmt = self.conn.prepare(sql)?;
        let mut rows = stmt.query(params)?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn record_exists<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<bool> {
        let mut stmt = self.conn.prepare(sql)?;
        stmt.exists(params)
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
