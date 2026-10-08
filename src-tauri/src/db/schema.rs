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
                favorited_at INTEGER NOT NULL
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

            -- ADR-0007 默认挡位：应用详情缓存保鲜期 30 分钟（仅缺失时填充，不覆盖用户已存值）
            INSERT OR IGNORE INTO user_settings (key, value) VALUES ('detail_cache_ttl_minutes', '30');

            -- FR-6.2 关注订阅表：daily 频率下 last_notified_at 保证每应用每天至多通知一次
            CREATE TABLE IF NOT EXISTS watched_apps (
                app_id TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL,
                last_notified_version TEXT,
                last_notified_at INTEGER
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
                updated_at INTEGER NOT NULL
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
            "#,
        )?;
        Ok(())
    }
}
