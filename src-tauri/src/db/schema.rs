use super::Database;
use rusqlite::Result;

/// 当前 schema 版本（`PRAGMA user_version`）。
/// 破坏性迁移在 `run_migrations` 的 match 迁移链中按版本推进，已发布版本语义不可更改。
const CURRENT_USER_VERSION: i64 = 3;

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

            CREATE TABLE IF NOT EXISTS catalog_apps (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                description_en TEXT,
                category TEXT NOT NULL,
                category_name TEXT NOT NULL,
                aliases_json TEXT NOT NULL DEFAULT '[]',
                default_version TEXT NOT NULL DEFAULT '',
                added_at TEXT,
                license TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                is_verified INTEGER NOT NULL DEFAULT 0,
                homepage TEXT,
                platforms_json TEXT NOT NULL DEFAULT '[]',
                identifiers_json TEXT NOT NULL DEFAULT '{}',
                install_dirs_json TEXT NOT NULL DEFAULT '[]',
                search_subdirs_json TEXT NOT NULL DEFAULT '[]',
                publishers_json TEXT NOT NULL DEFAULT '[]',
                forge TEXT NOT NULL DEFAULT 'github',
                forge_host TEXT NOT NULL DEFAULT 'github.com',
                manifest_synced_at INTEGER NOT NULL DEFAULT 0,
                detail_synced_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_catalog_apps_category ON catalog_apps(category);
            CREATE INDEX IF NOT EXISTS idx_catalog_apps_stars ON catalog_apps(stars DESC);
            CREATE INDEX IF NOT EXISTS idx_catalog_apps_added_at ON catalog_apps(added_at DESC, stars DESC);
            CREATE INDEX IF NOT EXISTS idx_catalog_apps_owner_repo ON catalog_apps(owner, repo);

            CREATE TABLE IF NOT EXISTS app_details (
                app_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                description_en TEXT,
                icon TEXT NOT NULL DEFAULT '',
                icon_bg TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                license TEXT NOT NULL DEFAULT '',
                latest_version TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT 'external',
                category_name TEXT NOT NULL DEFAULT '跨平台开源',
                forge TEXT NOT NULL DEFAULT 'github',
                forge_host TEXT NOT NULL DEFAULT 'github.com',
                homepage TEXT,
                platforms_json TEXT NOT NULL DEFAULT '[]',
                changelog TEXT NOT NULL DEFAULT '',
                readme_markdown TEXT NOT NULL DEFAULT '',
                readme_variants_json TEXT,
                releases_json TEXT NOT NULL DEFAULT '[]',
                cached_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_app_details_cached_at ON app_details(cached_at DESC);

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
                app_id TEXT NOT NULL,
                viewed_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_view_history_app_viewed ON view_history(app_id, viewed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_view_history_viewed_at ON view_history(viewed_at DESC);

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

            -- 关注订阅表：daily 频率下 last_notified_at 保证每应用每天至多通知一次；
            -- dismissed_version/dismissed_at 记录用户已确认的提醒版本与确认时间，
            -- dismissed_version 与 last_notified_version 不同即为待处理提醒
            CREATE TABLE IF NOT EXISTS watched_apps (
                app_id TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL,
                last_notified_version TEXT,
                last_notified_at INTEGER,
                is_cataloged INTEGER NOT NULL DEFAULT 0,
                dismissed_version TEXT,
                dismissed_at INTEGER
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

            -- 默认关注通知频率：daily（仅缺失时填充）
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
            -- `local_collected` 与 `collected` 为存储同义值，查询统一兼容匹配；
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

            -- 本地亲和度推荐：用户 GitHub Star / Fork / 自有仓库特征信号表
            CREATE TABLE IF NOT EXISTS user_repo_signals (
                full_name TEXT NOT NULL,
                relation TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (full_name, relation)
            );

            CREATE INDEX IF NOT EXISTS idx_user_repo_signals_updated_at ON user_repo_signals(updated_at);

            -- 精选页冷启动：用户显式选择的兴趣分类（ADR-0023）
            CREATE TABLE IF NOT EXISTS user_interest_seeds (
                category TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );

            -- 精选页推荐负反馈：scope = 'app'（target 为规范应用标识）| 'category'（target 为分类 key）
            CREATE TABLE IF NOT EXISTS user_feed_feedback (
                target TEXT NOT NULL,
                scope TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (target, scope)
            );
            "#,
        )?;
        // 幂等补列：缺列时执行 `ADD COLUMN` 补齐 `is_cataloged`（默认 0 fail-closed，启动回填按目录校准），
        // 列存在即跳过，保证任意版本启动均可自愈。
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
        self.ensure_column(
            "watched_apps",
            "dismissed_version",
            "ALTER TABLE watched_apps ADD COLUMN dismissed_version TEXT",
        )?;
        self.ensure_column(
            "watched_apps",
            "dismissed_at",
            "ALTER TABLE watched_apps ADD COLUMN dismissed_at INTEGER",
        )?;
        self.run_migrations()
    }

    /// user_version 迁移链：读取当前版本并逐版执行迁移函数，完成后写入 `CURRENT_USER_VERSION`。
    /// 基底 DDL 与幂等补列先行执行；高版本库被低版本打开时不降级版本号、不执行迁移链，仅执行幂等基底 DDL 自愈。
    fn run_migrations(&self) -> Result<()> {
        let version = self.user_version()?;
        if version > CURRENT_USER_VERSION {
            log::warn!(
                target: "app",
                "db user_version={} > supported={} (skipping migrations)",
                version,
                CURRENT_USER_VERSION
            );
            return Ok(());
        }
        for v in version..CURRENT_USER_VERSION {
            match v {
                0 => self.migrate_v0_to_v1()?,
                1 => self.migrate_v1_to_v2()?,
                2 => self.migrate_v2_to_v3()?,
                other => {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                        Some(format!(
                            "迁移链存在空洞：v{other} 无对应迁移函数（user_version={version}, CURRENT_USER_VERSION={CURRENT_USER_VERSION}），请补齐 migrate_v{other}_to_v{}",
                            other + 1
                        )),
                    ));
                }
            }
        }
        if version < CURRENT_USER_VERSION {
            self.set_user_version(CURRENT_USER_VERSION)?;
        }
        Ok(())
    }

    /// v0 → v1 基线版本标记迁移。
    fn migrate_v0_to_v1(&self) -> Result<()> {
        Ok(())
    }

    /// v1 → v2：直接切换至 `catalog_apps` + `app_details` 双表体系，清理旧 `app_details_cache`。
    fn migrate_v1_to_v2(&self) -> Result<()> {
        self.conn
            .execute_batch("DROP TABLE IF EXISTS app_details_cache;")?;
        Ok(())
    }

    /// v2 → v3：解除 `view_history.app_id` 的 UNIQUE 约束，改为事件流水表并补齐索引。
    fn migrate_v2_to_v3(&self) -> Result<()> {
        self.with_immediate_transaction(|| {
            self.conn.execute_batch(
                r#"
                CREATE TABLE view_history_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    app_id TEXT NOT NULL,
                    viewed_at INTEGER NOT NULL
                );
                INSERT INTO view_history_new (id, app_id, viewed_at)
                SELECT id, app_id, viewed_at FROM view_history ORDER BY id ASC;
                DROP TABLE view_history;
                ALTER TABLE view_history_new RENAME TO view_history;
                CREATE INDEX IF NOT EXISTS idx_view_history_app_viewed ON view_history(app_id, viewed_at DESC);
                CREATE INDEX IF NOT EXISTS idx_view_history_viewed_at ON view_history(viewed_at DESC);
                "#,
            )
        })
    }

    /// 读 `PRAGMA user_version`（迁移链与 schema 迁移测试共用读口）。
    pub(crate) fn user_version(&self) -> Result<i64> {
        self.conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
    }

    /// 盖章 user_version（值为内部版本常量，无外部输入拼接面）。
    fn set_user_version(&self, v: i64) -> Result<()> {
        self.conn
            .execute_batch(&format!("PRAGMA user_version = {v};"))
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
        // 重复 init：版本号保持不变，不重跑已完成迁移
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);
    }

    #[test]
    fn legacy_v0_db_upgrades_column_and_stamps_version() {
        // 构造缺收录标记列且 user_version = 0 的数据库形态
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
            "v0 数据库应当执行 v0→v1 迁移并写入当前版本号"
        );
        let has_col: bool = db
            .query_scalar_opt(
                "SELECT 1 FROM pragma_table_info('user_favorites') WHERE name = 'is_cataloged'",
                [],
            )
            .unwrap()
            .unwrap_or(false);
        assert!(has_col, "缺列应当被幂等补齐");
        // 未标注行默认收录标记为 0（fail-closed）
        let entries = db.get_favorite_entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].app_id, "rustdesk/rustdesk");
        assert!(!entries[0].is_cataloged, "未标注行收录标记应当默认 0");
    }

    #[test]
    fn higher_version_db_stays_readonly_without_downgrade_stamp() {
        // 高版本数据库不降级 user_version、不跑迁移链，幂等基底 DDL 仍执行（缺表/缺列自愈）。
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 99;").unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), 99, "高版本库不得被降级盖章");
        // 幂等基底照常执行：新表可建、查询可用。
        let tables: i64 = db
            .query_scalar_opt(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('update_results', 'catalog_apps', 'app_details')",
                [],
            )
            .unwrap()
            .unwrap_or(0);
        assert_eq!(tables, 3, "幂等基底在高版本库上仍应补齐表结构");
    }

    #[test]
    fn v2_db_migrates_view_history_without_unique_constraint_and_preserves_rows() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE view_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                app_id TEXT UNIQUE NOT NULL,
                viewed_at INTEGER NOT NULL
            );
            INSERT INTO view_history (id, app_id, viewed_at) VALUES (221, 'acme/alpha', 1700000100);
            INSERT INTO view_history (id, app_id, viewed_at) VALUES (239, 'acme/beta', 1700000200);
            PRAGMA user_version = 2;
            "#,
        )
        .unwrap();
        let db = Database { conn };
        db.init_schema().unwrap();
        assert_eq!(db.user_version().unwrap(), CURRENT_USER_VERSION);

        // 迁移后可写入同 app_id 的多条浏览事件且旧数据完整保留
        assert!(db.record_app_view_at("acme/alpha", 1700000300).unwrap());
        let rows: i64 = db
            .query_scalar_opt("SELECT COUNT(*) FROM view_history", [])
            .unwrap()
            .unwrap_or(0);
        assert_eq!(rows, 3);
        let ids = db.get_recently_viewed_app_ids().unwrap();
        assert_eq!(ids, vec!["acme/alpha", "acme/beta"]);
    }
}
