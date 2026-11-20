pub mod affinity;
pub mod apps;
pub mod cache;
pub mod catalog;
pub mod custom_apps;
pub mod details;
pub mod etag;
pub mod history;
pub mod icon_cycle;
pub mod launchpad;
pub mod repo_cards;
pub mod rules;
pub mod schema;
pub mod settings;
pub mod update_results;
pub mod watch;

pub use affinity::{
    FeedFeedback, FeedbackScope, RawAffinitySignals, RepoRelation, UncatalogedSignalBrief,
    UserRepoSignal,
};
pub use cache::AssetCacheRecord;
pub use custom_apps::CustomAppEntry;
pub use details::APP_DETAILS_CACHE_MAX_ROWS;
pub use etag::API_ETAG_CACHE_MAX_ROWS;
pub use icon_cycle::AppIconCycle;
pub use launchpad::{LaunchpadDiscussionState, LaunchpadDiscussionUpsert};
pub use repo_cards::{
    RepoCardPlatformState, RepoCardSnapshot, RepoCardUpsert, StoredRepoCard,
    REPO_CARD_CACHE_MAX_ROWS, REPO_CARD_FRESH_TTL_SECS,
};
pub use settings::*;
pub use update_results::UpdateCheckRow;

#[cfg(test)]
mod tests;

use rusqlite::{Connection, Result};
use std::collections::HashSet;
use std::path::Path;

pub struct Database {
    pub(crate) conn: Connection,
}

/// 连接级预编译语句 LRU 容量：覆盖各 DAO 的静态高频 SQL；动态 `IN (...)` 语句走 `*_uncached` 不入缓存。
const STATEMENT_CACHE_CAPACITY: usize = 256;

/// 单批 `IN (...)` 查询的最大占位符数（低于 SQLite 默认上限 999）。
pub(crate) const BATCH_CHUNK: usize = 400;

/// 输入清洗唯一落点：去首尾空白（db 内统一使用，避免 trim() 散写）。
#[inline]
pub(crate) fn clean(s: &str) -> &str {
    s.trim()
}

/// 去空、去重（保序），返回借用切片。
pub(crate) fn dedup_non_empty<'a>(keys: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen: HashSet<&'a str> = HashSet::new();
    keys.into_iter()
        .filter(|k| !k.is_empty() && seen.insert(k))
        .collect()
}

/// 去首尾空白、去空、去重（保序），返回借用切片。
pub(crate) fn dedup_clean_refs(keys: &[String]) -> Vec<&str> {
    dedup_non_empty(keys.iter().map(|k| clean(k)))
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
    /// 静态 SQL 查询：语句经 `prepare_cached` 复用（LRU 容量见 [`STATEMENT_CACHE_CAPACITY`]）。
    pub(crate) fn query_vec<T, P, F>(&self, sql: &str, params: P, f: F) -> Result<Vec<T>>
    where
        P: rusqlite::Params,
        F: FnMut(&rusqlite::Row<'_>) -> Result<T>,
    {
        let mut stmt = self.conn.prepare_cached(sql)?;
        let rows = stmt.query_map(params, f)?;
        rows.collect()
    }

    /// 动态 SQL 查询（占位符个数随入参变化的 `IN (...)`）：不进语句缓存，避免挤出静态语句。
    pub(crate) fn query_vec_uncached<T, P, F>(&self, sql: &str, params: P, f: F) -> Result<Vec<T>>
    where
        P: rusqlite::Params,
        F: FnMut(&rusqlite::Row<'_>) -> Result<T>,
    {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, f)?;
        rows.collect()
    }

    /// 按 [`BATCH_CHUNK`] 分片执行 `IN (...)` 查询：`sql_for` 接收占位符串（如 `?, ?, ?`）返回整句。
    pub(crate) fn query_in_chunks<K, T, F>(
        &self,
        keys: &[K],
        sql_for: impl Fn(&str) -> String,
        mut f: F,
    ) -> Result<Vec<T>>
    where
        K: rusqlite::ToSql,
        F: FnMut(&rusqlite::Row<'_>) -> Result<T>,
    {
        let mut out = Vec::new();
        for chunk in keys.chunks(BATCH_CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = sql_for(&placeholders);
            out.extend(self.query_vec_uncached(
                &sql,
                rusqlite::params_from_iter(chunk.iter()),
                &mut f,
            )?);
        }
        Ok(out)
    }

    /// 以 `BEGIN IMMEDIATE` 包裹一组写操作，失败时回滚并返回错误。
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

    /// 统一写入口（静态 SQL）：INSERT/UPDATE/DELETE 经 `prepare_cached` 复用编译后的语句。
    pub(crate) fn exec_write<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<usize> {
        self.conn.prepare_cached(sql)?.execute(params)
    }

    /// 动态 SQL 写入（占位符个数随入参变化的 `IN (...)`）：不进语句缓存。
    pub(crate) fn exec_write_uncached<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> Result<usize> {
        self.conn.execute(sql, params)
    }

    /// 历史裁剪唯一落点：白名单表名防注入，limit 为整数格式化（调用方需 `as u64` 传入配置值）。
    /// 先比对行数，仅超限时才执行排序 + `NOT IN` 子查询删除（常态写入只付一次计数）。
    pub(crate) fn prune_history_table(&self, table: ValidatedTable, limit: u64) -> Result<()> {
        let count: i64 = self
            .query_scalar_opt(&format!("SELECT COUNT(*) FROM {}", table.table_name()), [])?
            .unwrap_or(0);
        if count.max(0) as u64 <= limit {
            return Ok(());
        }
        let sql = format!(
            "DELETE FROM {} WHERE id NOT IN (SELECT id FROM {} ORDER BY {} DESC, id DESC LIMIT {})",
            table.table_name(),
            table.table_name(),
            table.order_col(),
            limit
        );
        self.exec_write(&sql, [])?;
        Ok(())
    }

    /// 首行首列；无行为 None。列可能为 NULL 时 `T` 须取 `Option<_>` 再 `flatten`，
    /// 否则 NULL 会报 `InvalidColumnType`。
    pub fn query_scalar_opt<T, P>(&self, sql: &str, params: P) -> Result<Option<T>>
    where
        T: rusqlite::types::FromSql,
        P: rusqlite::Params,
    {
        let mut stmt = self.conn.prepare_cached(sql)?;
        let mut rows = stmt.query(params)?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn record_exists<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<bool> {
        let mut stmt = self.conn.prepare_cached(sql)?;
        stmt.exists(params)
    }

    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
        let _ = conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        );
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }
}
