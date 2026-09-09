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
                repo_key TEXT NOT NULL,
                name TEXT NOT NULL,
                latest_version TEXT NOT NULL,
                detail_json TEXT NOT NULL,
                cached_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_app_details_cache_repo_key ON app_details_cache(repo_key);

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

            -- FR-8.3 所有权认证通过记录（verify_ownership 成功后持久化，与收录库标记合并生效）
            CREATE TABLE IF NOT EXISTS verified_apps (
                app_id TEXT PRIMARY KEY,
                verified_at INTEGER NOT NULL
            );

            -- FR-8.1 z-store.toml 原文缓存（与应用详情缓存共用 TTL 挡位 gears）
            CREATE TABLE IF NOT EXISTS store_meta_cache (
                app_id TEXT PRIMARY KEY,
                raw_toml TEXT NOT NULL,
                cached_at INTEGER NOT NULL
            );

            -- GitHub Star 列表本地持久化记录
            CREATE TABLE IF NOT EXISTS user_stars (
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                starred_at INTEGER NOT NULL,
                PRIMARY KEY (owner, repo)
            );

            -- FR-6.2 默认通知频率：daily（仅缺失时填充）
            INSERT OR IGNORE INTO user_settings (key, value) VALUES ('watch_notify_frequency', 'daily');
            "#,
        )?;
        // 存量库升级兜底：已存在 watched_apps 旧表时补齐通知时间列
        let _ = self.conn.execute(
            "ALTER TABLE watched_apps ADD COLUMN last_notified_at INTEGER",
            [],
        );
        Ok(())
    }
}
