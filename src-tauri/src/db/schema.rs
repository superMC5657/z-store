use super::Database;
use rusqlite::Result;

/// 当前 schema 版本（`PRAGMA user_version`）。
/// v0 = 机制引入前的现状形态（18 表 + ensure_column 幂等补列，未盖章）；
/// v1 = 机制采用版（形态与 v0 一致）。后续破坏性迁移（改类型/删列/重建表）
/// 在 `run_migrations` 的 match 续链迁移函数逐版推进，禁止改动既有版本语义。
const CURRENT_USER_VERSION: i64 = 1;

impl Database {
    pub(crate) fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS installed_apps (
                app_id TEXT PRIMARY KEY,
                app_name TEXT NOT NULL,
                version TEXT NOT NULL,
                installed_at INTEGER NOT NULL,
                install_method TEXT NOT NULL,
                install_path TEXT NOT NULL,
                asset_name TEXT NOT NULL,
                asset_sha256 TEXT NOT NULL,
                uninstall_command TEXT
            );

            CREATE TABLE IF NOT EXISTS api_etag_cache (
                endpoint_url TEXT PRIMARY KEY,
                etag TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                last_checked_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_details_cache (
                app_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                latest_version TEXT NOT NULL,
                detail_json TEXT NOT NULL,
                cached_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_favorites (
                app_id TEXT PRIMARY KEY,
                favorited_at INTEGER NOT NULL,
                is_cataloged INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS update_rules (
                app_id TEXT PRIMARY KEY,
                skipped_version TEXT,
                is_frozen INTEGER NOT NULL DEFAULT 0,
                is_hidden INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query TEXT UNIQUE NOT NULL,
                searched_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS view_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_id TEXT UNIQUE NOT NULL,
                viewed_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS host_tokens (
                host TEXT PRIMARY KEY,
                token TEXT NOT NULL,
                rate_limit_remaining INTEGER,
                rate_limit_limit INTEGER,
                rate_limit_reset INTEGER,
                updated_at INTEGER NOT NULL
            );

            -- ADR-0007 默认挡位：应用详情缓存保鲜期 60 分钟（仅缺失时填充，不覆盖用户已存值）
            INSERT OR IGNORE INTO user_settings (key, value) VALUES ('detail_cache_ttl_minutes', '60');

            -- FR-6.2 关注订阅表：daily 频率下 last_notified_at 保证每应用每天至多通知一次
            CREATE TABLE IF NOT EXISTS watched_apps (
                app_id TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL,
                last_notified_version TEXT,
                last_notified_at INTEGER,
                is_cataloged INTEGER NOT NULL DEFAULT 0
            );

            -- GitHub Star 列表本地持久化记录
            CREATE TABLE IF NOT EXISTS user_stars (
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                starred_at INTEGER NOT NULL,
                PRIMARY KEY (owner, repo)
            );

            -- 图标缓存来源与有效性追踪表
            CREATE TABLE IF NOT EXISTS icon_cache_meta (
                cache_key TEXT PRIMARY KEY,
                remote_url TEXT NOT NULL,
                cached_at INTEGER NOT NULL
            );

            -- 刷新图标轮换状态追踪表
            CREATE TABLE IF NOT EXISTS app_icon_cycles (
                app_id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                is_cataloged INTEGER NOT NULL DEFAULT 0,
                level INTEGER NOT NULL DEFAULT 1,
                l1_url TEXT NOT NULL DEFAULT '',
                l2_url TEXT NOT NULL DEFAULT '',
                l3_url TEXT NOT NULL DEFAULT '',
                l4_url TEXT NOT NULL DEFAULT '',
                selected_url TEXT NOT NULL DEFAULT '',
                cache_file TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_icon_cycles_owner_repo ON app_icon_cycles(owner, repo);

            -- FR-6.2 默认通知频率：daily（仅缺失时填充）
            INSERT OR IGNORE INTO user_settings (key, value) VALUES ('watch_notify_frequency', 'daily');

            -- 趋势榜缓存（纯透存，后端不判 TTL；board 列供双档清扫区分 daily/其余）
            CREATE TABLE IF NOT EXISTS trend_board_cache (
                cache_key TEXT PRIMARY KEY,
                board TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                payload_bytes INTEGER DEFAULT 0,
                cached_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_trend_board_cache_board ON trend_board_cache(board);

            CREATE TABLE IF NOT EXISTS asset_cache (
                url TEXT PRIMARY KEY,
                hash TEXT NOT NULL,
                local_path TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                etag TEXT,
                last_modified TEXT,
                last_used INTEGER NOT NULL,
                expires_at INTEGER NOT NULL DEFAULT 0,
                hits INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_asset_cache_last_used ON asset_cache(last_used);

            CREATE INDEX IF NOT EXISTS idx_asset_cache_expires_at ON asset_cache(expires_at);

            CREATE INDEX IF NOT EXISTS idx_asset_cache_hash ON asset_cache(hash);

            CREATE TABLE IF NOT EXISTS asset_refs (
                hash TEXT NOT NULL,
                app_id TEXT NOT NULL,
                last_seen INTEGER NOT NULL,
                PRIMARY KEY (hash, app_id)
            );

            -- 本地自维护条目 overlay：草稿暂存 + 本地收录（ADR-0017）。
            -- id 为 canonical 小写形态（仅 GitHub `owner/repo`）；
            -- payload_json 存完整 CatalogItem；status=draft/submitted/collected
            --（已提交另存 pr_url；collected 为本地收录态，可搜可装）；
            -- 旧数据的 local_collected 字面与 collected 同义，查询双匹配该残留值；
            -- archived=1 为转正（远端已收录）自动归档标记。
            CREATE TABLE IF NOT EXISTS custom_apps (
                id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                pr_url TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_custom_apps_archived ON custom_apps(archived);

            CREATE INDEX IF NOT EXISTS idx_custom_apps_status ON custom_apps(status);

            -- 更新中心持久化（update-results cache）：一次手动刷新对每个已安装应用的判定快照。
            -- has_update=1 行即 UpdatesView 列表；installed_version 供读取时与当前安装版本比对过期；
            -- changelog/icon/icon_bg 透存远端回包，get_cached_updates 零网络直显。
            CREATE TABLE IF NOT EXISTS update_results (
                app_id TEXT PRIMARY KEY,
                app_name TEXT NOT NULL,
                installed_version TEXT NOT NULL,
                latest_version TEXT NOT NULL,
                has_update INTEGER NOT NULL DEFAULT 0,
                changelog TEXT NOT NULL DEFAULT '',
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                checked_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_update_results_has_update ON update_results(has_update);
            "#,
        )?;
        // 收录标记列迁移（幂等）：存量库缺列时 `ADD COLUMN` 补齐（默认 0 fail-closed，启动回填再按目录校准）。
        // 版本机制之下保留在基底路径：列存在即跳过，任何版本启动都自愈。
        self.ensure_column(
            "user_favorites",
            "is_cataloged",
            "ALTER TABLE user_favorites ADD COLUMN is_cataloged INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_column(
            "watched_apps",
            "is_cataloged",
            "ALTER TABLE watched_apps ADD COLUMN is_cataloged INTEGER NOT NULL DEFAULT 0",
        )?;
        self.run_migrations()
    }

    /// user_version 迁移链：读当前版本 → 逐版执行迁移函数 → 盖章至 `CURRENT_USER_VERSION`。
    /// 基底 DDL 与幂等补列先行执行，v0（存量库/新库的未盖章态）→ v1 仅机制采用；
    /// 高版本库被旧构建打开时不降级盖章，仅跑幂等基底（只读兼容）。
    fn run_migrations(&self) -> Result<()> {
        let version = self.user_version()?;
        if version > CURRENT_USER_VERSION {
            log::warn!(
                "db user_version={} 高于当前支持的 {}，跳过迁移仅跑幂等基底",
                version,
                CURRENT_USER_VERSION
            );
            return Ok(());
        }
        for v in version..CURRENT_USER_VERSION {
            match v {
                0 => self.migrate_v0_to_v1()?,
                other => unreachable!("迁移链存在空洞：v{other} 无对应迁移函数"),
            }
        }
        if version < CURRENT_USER_VERSION {
            self.set_user_version(CURRENT_USER_VERSION)?;
        }
        Ok(())
    }

    /// v0 → v1：仅采用版本机制，无形态变更（18 表与收录标记列已由幂等基底补齐）。
    /// 后续破坏性迁移按 `migrate_vN_to_vN+1` 命名续链于此。
    fn migrate_v0_to_v1(&self) -> Result<()> {
        Ok(())
    }

    /// 读 `PRAGMA user_version`（迁移链与 schema 迁移测试共用读口）。
    pub(crate) fn user_version(&self) -> Result<i64> {
        self.conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
    }

    /// 盖章 user_version（值为内部版本常量，无外部输入拼接面）。
    fn set_user_version(&self, v: i64) -> Result<()> {
        self.conn.execute_batch(&format!("PRAGMA user_version = {v};"))
    }

    /// 轻量列迁移：缺列时执行 `ADD COLUMN`，列存在即跳过。
    /// `table`/`column`/`ddl` 均为内部常量，不拼接外部输入。
    fn ensure_column(&self, table: &str, column: &str, ddl: &str) -> Result<()> {
        let exists: bool = self
            .query_scalar_opt(
                "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2",
                rusqlite::params![table, column],
            )?
            .unwrap_or(false);
        if !exists {
            self.conn.execute(ddl, [])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod schema_migration_tests {
    use super::{Database, CURRENT_USER_VERSION};

    #[test]
    fn fresh_db_stamps_user_version_and_reinit_is_idempotent() {
        let db = Database::open_in_memory().expect("内存数据库应当可用");
        assert_eq!(
            db.user_version().unwrap(),
            CURRENT_USER_VERSION,
            "新库经 init_schema 应当盖章至当前版本"
        );
        // 重复 init（升级重开/测试挂载）：版本不回退、不重跑迁移
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);
    }

    #[test]
    fn legacy_v0_db_upgrades_column_and_stamps_version() {
        // 模拟机制引入前的存量库：user_favorites 缺收录标记列、user_version 未盖章（=0）
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE user_favorites (
                app_id TEXT PRIMARY KEY,
                favorited_at INTEGER NOT NULL
            );
            INSERT INTO user_favorites (app_id, favorited_at) VALUES ('rustdesk/rustdesk', 1700000000);
            "#,
        )
        .unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();

        assert_eq!(
            db.user_version().unwrap(),
            CURRENT_USER_VERSION,
            "存量库应当走 v0→v1 迁移并盖章"
        );
        let has_col: bool = db
            .query_scalar_opt(
                "SELECT 1 FROM pragma_table_info('user_favorites') WHERE name = 'is_cataloged'",
                [],
            )
            .unwrap()
            .unwrap_or(false);
        assert!(has_col, "存量库缺列应当被幂等补齐");
        // 存量行收录标记默认 0（fail-closed）
        let entries = db.get_favorite_entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].app_id, "rustdesk/rustdesk");
        assert!(!entries[0].is_cataloged, "存量行收录标记应当默认 0");
    }
}
