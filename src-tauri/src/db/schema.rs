use super::Database;
use rusqlite::Result;

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

            -- Phase1A 趋势榜缓存（纯透存，后端不判 TTL；board 列供双档清扫区分 daily/其余）
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

            -- 本地自维护草稿 overlay：待收录草稿本地暂存（ADR-0017）。
            -- id 为 canonical 小写形态（`owner/repo` 或 `forge[:host]:owner/repo`）；
            -- payload_json 存完整 CatalogItem；status=draft/submitted（已提交另存 pr_url）；
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
        // 本库无版本号机制，沿用 `IF NOT EXISTS` 幂等风格：列存在即跳过。
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
        Ok(())
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
