pub mod affinity;
pub mod apps;
pub mod cache;
pub mod custom_apps;
pub mod history;
pub mod icon_cycle;
pub mod rules;
pub mod schema;
pub mod settings;
pub mod update_results;
pub mod watch;

pub use affinity::{RawAffinitySignals, RepoRelation, UserRepoSignal};
pub use cache::AssetCacheRecord;
pub use custom_apps::CustomAppEntry;
pub use icon_cycle::AppIconCycle;
pub use settings::*;
pub use update_results::UpdateCheckRow;

#[cfg(test)]
mod tests;

use rusqlite::{Connection, Result};
use std::path::Path;

pub struct Database {
    pub(crate) conn: Connection,
}

impl Database {
    /// 打开默认数据目录下的 `z_store.db`（文件不存在时返回 `None`）。
    pub(crate) fn open_default_opt() -> Option<Self> {
        let db_path = crate::get_app_data_dir().join("z_store.db");
        if db_path.is_file() {
            Self::open(&db_path).ok()
        } else {
            None
        }
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
    /// 用 `&self` + `execute_batch` 实现以保持 `&self` 写 API（调用方经 `state.db()` 互斥锁已独占，
    /// 无嵌套事务），WAL/`busy_timeout` 沿用连接既有配置，不改 schema/API 形状。
    /// 调用方保持 `let _ =`/`ok()` 吞错语义：事务失败返回 Err，上层忽略并由下次搜索/详情重试。
    pub(crate) fn with_immediate_transaction<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let res = f();
        match res {
            Ok(v) => {
                // COMMIT 失败（如延迟约束/IO 错误）时事务仍处于打开态：
                // 先尽力 ROLLBACK，避免后续写落在隐式事务里。
                if let Err(e) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(e);
                }
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// 统一写入口：INSERT/UPDATE/DELETE/DDL 均走 `conn.execute`。
    pub(crate) fn exec_write<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<usize> {
        self.conn.execute(sql, params)
    }

    /// 历史裁剪唯一落点：白名单表名防注入，limit 为整数格式化（调用方需 `as u64` 传入配置值）。
    pub(crate) fn prune_history_table(&self, table: ValidatedTable, limit: u64) -> Result<()> {
        let sql = format!(
            "DELETE FROM {} WHERE id NOT IN (SELECT id FROM {} ORDER BY {} DESC LIMIT {})",
            table.table_name(),
            table.table_name(),
            table.order_col(),
            limit
        );
        self.exec_write(&sql, [])?;
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
