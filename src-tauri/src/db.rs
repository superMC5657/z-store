use crate::models::{AppDetail, HostTokenEntry, InstalledApp, UpdateRule};
use rusqlite::{params, Connection, Result};
use std::collections::HashMap;
use std::path::Path;

pub struct Database {
    conn: Connection,
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
        let _ = db.seed_initial_cache();
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn };
        db.init_schema()?;
        let _ = db.seed_initial_cache();
        Ok(db)
    }

    fn init_schema(&self) -> Result<()> {
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
            "#,
        )?;
        Ok(())
    }

    pub fn get_installed_apps(&self) -> Result<Vec<InstalledApp>> {
        let mut stmt = self.conn.prepare(
            "SELECT app_id, app_name, version, installed_at, install_method, install_path, asset_name, asset_sha256, uninstall_command FROM installed_apps ORDER BY installed_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(InstalledApp {
                app_id: row.get(0)?,
                app_name: row.get(1)?,
                version: row.get(2)?,
                installed_at: row.get(3)?,
                install_method: row.get(4)?,
                install_path: row.get(5)?,
                asset_name: row.get(6)?,
                asset_sha256: row.get(7)?,
                uninstall_command: row.get(8)?,
            })
        })?;

        let mut apps = Vec::new();
        for app in rows {
            apps.push(app?);
        }
        Ok(apps)
    }

    pub fn save_installed_app(&self, app: &InstalledApp) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO installed_apps (app_id, app_name, version, installed_at, install_method, install_path, asset_name, asset_sha256, uninstall_command)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(app_id) DO UPDATE SET
                app_name = excluded.app_name,
                version = excluded.version,
                installed_at = excluded.installed_at,
                install_method = excluded.install_method,
                install_path = excluded.install_path,
                asset_name = excluded.asset_name,
                asset_sha256 = excluded.asset_sha256,
                uninstall_command = excluded.uninstall_command;
            "#,
            params![
                app.app_id,
                app.app_name,
                app.version,
                app.installed_at,
                app.install_method,
                app.install_path,
                app.asset_name,
                app.asset_sha256,
                app.uninstall_command,
            ],
        )?;
        Ok(())
    }

    pub fn remove_installed_app(&self, app_id: &str) -> Result<bool> {
        let rows = self.conn.execute(
            "DELETE FROM installed_apps WHERE app_id = ?1",
            params![app_id],
        )?;
        Ok(rows > 0)
    }

    pub fn get_etag(&self, endpoint_url: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT etag FROM api_etag_cache WHERE endpoint_url = ?1")?;
        let mut rows = stmt.query(params![endpoint_url])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn get_cached_payload(&self, endpoint_url: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT payload_json FROM api_etag_cache WHERE endpoint_url = ?1")?;
        let mut rows = stmt.query(params![endpoint_url])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn save_etag(
        &self,
        endpoint_url: &str,
        etag: &str,
        payload_json: &str,
        timestamp: i64,
    ) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO api_etag_cache (endpoint_url, etag, payload_json, last_checked_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(endpoint_url) DO UPDATE SET
                etag = excluded.etag,
                payload_json = excluded.payload_json,
                last_checked_at = excluded.last_checked_at;
            "#,
            params![endpoint_url, etag, payload_json, timestamp],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM user_settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO user_settings (key, value)
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            "#,
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_all_settings(&self) -> Result<HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM user_settings")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let mut map = HashMap::new();
        for r in rows {
            let (k, v) = r?;
            map.insert(k, v);
        }
        Ok(map)
    }

    pub fn get_cached_app_detail(
        &self,
        id_or_repo: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<Option<AppDetail>> {
        let clean = id_or_repo.trim().to_lowercase();
        if clean.is_empty() {
            return Ok(None);
        }

        let mut stmt = self.conn.prepare(
            "SELECT detail_json, cached_at FROM app_details_cache WHERE LOWER(app_id) = ?1 OR LOWER(repo_key) = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![clean])?;
        if let Some(row) = rows.next()? {
            let json_str: String = row.get(0)?;
            let cached_at: i64 = row.get(1)?;
            if let Some(ttl) = ttl_seconds {
                if ttl > 0 {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64;
                    if now.saturating_sub(cached_at) >= ttl {
                        // 缓存已过期，返回 None 以促使远端触发 ETag 条件校验
                        return Ok(None);
                    }
                } else if ttl == 0 {
                    // ttl == 0 代表每次打开均需要向远端校验
                    return Ok(None);
                }
            }
            if let Ok(mut detail) = serde_json::from_str::<AppDetail>(&json_str) {
                detail.cached_at = Some(cached_at);
                return Ok(Some(detail));
            }
        }
        Ok(None)
    }

    /// 即使缓存过期，也返回已存储的详情副本（用于离线弱网或 GitHub API 故障时的降级呈现）
    pub fn get_cached_app_detail_fallback(&self, id_or_repo: &str) -> Result<Option<AppDetail>> {
        self.get_cached_app_detail(id_or_repo, None)
    }

    /// 当远端返回 304 Not Modified 时，快速刷新 cached_at 时间戳，零开销延长保鲜期
    pub fn touch_cached_app_detail(&self, id_or_repo: &str, new_cached_at: i64) -> Result<()> {
        let clean = id_or_repo.trim().to_lowercase();
        self.conn.execute(
            "UPDATE app_details_cache SET cached_at = ?1 WHERE LOWER(app_id) = ?2 OR LOWER(repo_key) = ?2",
            params![new_cached_at, clean],
        )?;
        Ok(())
    }

    pub fn save_cached_app_detail(
        &self,
        app_id: &str,
        repo_key: &str,
        detail: &AppDetail,
    ) -> Result<()> {
        let clean_id = app_id.trim().to_lowercase();
        let clean_repo = repo_key.trim().to_lowercase();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let json_str = serde_json::to_string(detail)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

        self.conn.execute(
            r#"
            INSERT INTO app_details_cache (app_id, repo_key, name, latest_version, detail_json, cached_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(app_id) DO UPDATE SET
                repo_key = excluded.repo_key,
                name = excluded.name,
                latest_version = excluded.latest_version,
                detail_json = excluded.detail_json,
                cached_at = excluded.cached_at;
            "#,
            params![
                clean_id,
                clean_repo,
                detail.name,
                detail.latest_version,
                json_str,
                now,
            ],
        )?;

        // 如果传入的 clean_repo 不为空且不等于 clean_id，且形如 owner/repo 或 host/owner/repo，
        // 同时以 clean_repo 为主键写入一条记录，确保后续按仓库坐标检索时同样能够直接命中
        if !clean_repo.is_empty() && clean_repo != clean_id {
            let _ = self.conn.execute(
                r#"
                INSERT INTO app_details_cache (app_id, repo_key, name, latest_version, detail_json, cached_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(app_id) DO UPDATE SET
                    repo_key = excluded.repo_key,
                    name = excluded.name,
                    latest_version = excluded.latest_version,
                    detail_json = excluded.detail_json,
                    cached_at = excluded.cached_at;
                "#,
                params![
                    clean_repo,
                    clean_repo,
                    detail.name,
                    detail.latest_version,
                    json_str,
                    now,
                ],
            );
        }

        Ok(())
    }

    pub fn clear_app_details_cache(&self) -> Result<()> {
        self.conn.execute("DELETE FROM app_details_cache", [])?;
        Ok(())
    }

    pub fn seed_initial_cache(&self) -> Result<()> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM app_details_cache", [], |r| r.get(0))
            .unwrap_or(0);

        if count == 0 {
            let seeds_str = include_str!("catalog_seeds.json");
            if let Ok(seeds) = serde_json::from_str::<Vec<AppDetail>>(seeds_str) {
                for detail in seeds {
                    let repo_key =
                        format!("github.com/{}/{}", detail.owner, detail.repo).to_lowercase();
                    let _ = self.save_cached_app_detail(&detail.id, &repo_key, &detail);
                }
            }
        }
        Ok(())
    }

    pub fn clear_cache(&self) -> Result<()> {
        self.conn.execute("DELETE FROM api_etag_cache", [])?;
        let _ = self.conn.execute("DELETE FROM app_details_cache", []);
        Ok(())
    }

    pub fn get_favorites(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT app_id FROM user_favorites ORDER BY favorited_at DESC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut favs = Vec::new();
        for r in rows {
            favs.push(r?);
        }
        Ok(favs)
    }

    pub fn toggle_favorite(&self, app_id: &str) -> Result<bool> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM user_favorites WHERE app_id = ?1)",
            params![app_id],
            |row| row.get(0),
        )?;

        if exists {
            self.conn.execute(
                "DELETE FROM user_favorites WHERE app_id = ?1",
                params![app_id],
            )?;
            Ok(false)
        } else {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            self.conn.execute(
                "INSERT INTO user_favorites (app_id, favorited_at) VALUES (?1, ?2)",
                params![app_id, now],
            )?;
            Ok(true)
        }
    }

    pub fn get_rule(&self, app_id: &str) -> Result<Option<UpdateRule>> {
        let mut stmt = self.conn.prepare(
            "SELECT app_id, skipped_version, is_frozen, is_hidden, updated_at FROM update_rules WHERE app_id = ?1",
        )?;
        let mut rows = stmt.query(params![app_id])?;
        if let Some(row) = rows.next()? {
            let is_frozen_int: i64 = row.get(2)?;
            let is_hidden_int: i64 = row.get(3)?;
            Ok(Some(UpdateRule {
                app_id: row.get(0)?,
                skipped_version: row.get(1)?,
                is_frozen: is_frozen_int != 0,
                is_hidden: is_hidden_int != 0,
                updated_at: row.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn get_all_rules(&self) -> Result<Vec<UpdateRule>> {
        let mut stmt = self.conn.prepare(
            "SELECT app_id, skipped_version, is_frozen, is_hidden, updated_at FROM update_rules ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let is_frozen_int: i64 = row.get(2)?;
            let is_hidden_int: i64 = row.get(3)?;
            Ok(UpdateRule {
                app_id: row.get(0)?,
                skipped_version: row.get(1)?,
                is_frozen: is_frozen_int != 0,
                is_hidden: is_hidden_int != 0,
                updated_at: row.get(4)?,
            })
        })?;

        let mut rules = Vec::new();
        for r in rows {
            rules.push(r?);
        }
        Ok(rules)
    }

    fn upsert_update_rule_field<T: rusqlite::ToSql>(
        &self,
        app_id: &str,
        field_name: &str,
        value: T,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let sql = format!(
            r#"
            INSERT INTO update_rules (app_id, {field}, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(app_id) DO UPDATE SET
                {field} = excluded.{field},
                updated_at = excluded.updated_at;
            "#,
            field = field_name
        );
        self.conn.execute(&sql, params![app_id, value, now])?;
        Ok(())
    }

    pub fn set_skip_version(&self, app_id: &str, version: Option<&str>) -> Result<()> {
        self.upsert_update_rule_field(app_id, "skipped_version", version)
    }

    pub fn set_frozen_status(&self, app_id: &str, is_frozen: bool) -> Result<()> {
        self.upsert_update_rule_field(app_id, "is_frozen", if is_frozen { 1 } else { 0 })
    }

    pub fn set_hidden_status(&self, app_id: &str, is_hidden: bool) -> Result<()> {
        self.upsert_update_rule_field(app_id, "is_hidden", if is_hidden { 1 } else { 0 })
    }

    pub fn remove_rule(&self, app_id: &str) -> Result<bool> {
        let rows = self.conn.execute(
            "DELETE FROM update_rules WHERE app_id = ?1",
            params![app_id],
        )?;
        Ok(rows > 0)
    }

    pub fn record_search_query(&self, query: &str) -> Result<()> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            r#"
            INSERT INTO search_history (query, searched_at)
            VALUES (?1, ?2)
            ON CONFLICT(query) DO UPDATE SET
                searched_at = excluded.searched_at;
            "#,
            params![q, now],
        )?;
        // 限制最多保留 20 条
        self.conn.execute(
            "DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY searched_at DESC LIMIT 20)",
            [],
        )?;
        Ok(())
    }

    pub fn get_search_history(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT query FROM search_history ORDER BY searched_at DESC LIMIT 20",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn clear_search_history(&self) -> Result<()> {
        self.conn.execute("DELETE FROM search_history", [])?;
        Ok(())
    }

    pub fn remove_search_query(&self, query: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM search_history WHERE query = ?1",
            params![query.trim()],
        )?;
        Ok(())
    }

    pub fn record_app_view(&self, app_id: &str) -> Result<()> {
        let id = app_id.trim();
        if id.is_empty() {
            return Ok(());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            r#"
            INSERT INTO view_history (app_id, viewed_at)
            VALUES (?1, ?2)
            ON CONFLICT(app_id) DO UPDATE SET
                viewed_at = excluded.viewed_at;
            "#,
            params![id, now],
        )?;
        // 限制最多保留 30 条
        self.conn.execute(
            "DELETE FROM view_history WHERE id NOT IN (SELECT id FROM view_history ORDER BY viewed_at DESC LIMIT 30)",
            [],
        )?;
        Ok(())
    }

    pub fn get_recently_viewed_app_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT app_id FROM view_history ORDER BY viewed_at DESC LIMIT 30",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn clear_view_history(&self) -> Result<()> {
        self.conn.execute("DELETE FROM view_history", [])?;
        Ok(())
    }

    pub fn get_host_tokens(&self) -> Result<Vec<HostTokenEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at FROM host_tokens ORDER BY host ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(HostTokenEntry {
                host: row.get(0)?,
                token: row.get(1)?,
                rate_limit_remaining: row.get(2)?,
                rate_limit_limit: row.get(3)?,
                rate_limit_reset: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;

        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn get_host_token(&self, host: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT token FROM host_tokens WHERE host = ?1")?;
        let mut rows = stmt.query_map(params![host.to_lowercase()], |row| row.get(0))?;
        if let Some(row) = rows.next() {
            let t: String = row?;
            if t.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(t))
            }
        } else {
            Ok(None)
        }
    }

    pub fn set_host_token(&self, host: &str, token: &str) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            r#"
            INSERT INTO host_tokens (host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at)
            VALUES (?1, ?2, NULL, NULL, NULL, ?3)
            ON CONFLICT(host) DO UPDATE SET
                token = excluded.token,
                updated_at = excluded.updated_at;
            "#,
            params![host.to_lowercase(), token.trim(), now],
        )?;
        Ok(())
    }

    pub fn remove_host_token(&self, host: &str) -> Result<bool> {
        let rows = self.conn.execute(
            "DELETE FROM host_tokens WHERE host = ?1",
            params![host.to_lowercase()],
        )?;
        Ok(rows > 0)
    }

    pub fn update_host_rate_limit(
        &self,
        host: &str,
        remaining: Option<u32>,
        limit: Option<u32>,
        reset: Option<i64>,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            r#"
            INSERT INTO host_tokens (host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at)
            VALUES (?1, '', ?2, ?3, ?4, ?5)
            ON CONFLICT(host) DO UPDATE SET
                rate_limit_remaining = excluded.rate_limit_remaining,
                rate_limit_limit = excluded.rate_limit_limit,
                rate_limit_reset = excluded.rate_limit_reset,
                updated_at = excluded.updated_at;
            "#,
            params![host.to_lowercase(), remaining, limit, reset, now],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_installed_apps_crud() {
        let db = Database::open_in_memory().unwrap();
        let app = InstalledApp {
            app_id: "rustdesk".to_string(),
            app_name: "RustDesk".to_string(),
            version: "v1.2.6".to_string(),
            installed_at: 1700000000,
            install_method: "msi".to_string(),
            install_path: "C:\\Program Files\\RustDesk".to_string(),
            asset_name: "rustdesk-1.2.6.msi".to_string(),
            asset_sha256: "abcdef1234567890".to_string(),
            uninstall_command: Some("msiexec /x".to_string()),
        };

        db.save_installed_app(&app).unwrap();
        let apps = db.get_installed_apps().unwrap();
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].app_id, "rustdesk");

        let removed = db.remove_installed_app("rustdesk").unwrap();
        assert!(removed);
        let apps_after = db.get_installed_apps().unwrap();
        assert_eq!(apps_after.len(), 0);
    }

    #[test]
    fn test_etag_cache() {
        let db = Database::open_in_memory().unwrap();
        let ep = "https://api.github.com/repos/rustdesk/rustdesk/releases/latest";
        db.save_etag(ep, "W/\"123456\"", "{\"tag_name\":\"v1.2.6\"}", 1700000000)
            .unwrap();

        let etag = db.get_etag(ep).unwrap();
        assert_eq!(etag, Some("W/\"123456\"".to_string()));

        let payload = db.get_cached_payload(ep).unwrap();
        assert!(payload.is_some());

        db.clear_cache().unwrap();
        assert_eq!(db.get_etag(ep).unwrap(), None);
    }

    #[test]
    fn test_settings_and_favorites() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting("theme", "dark").unwrap();
        assert_eq!(db.get_setting("theme").unwrap(), Some("dark".to_string()));

        let fav_added = db.toggle_favorite("rustdesk").unwrap();
        assert!(fav_added);
        assert_eq!(db.get_favorites().unwrap(), vec!["rustdesk".to_string()]);

        let fav_removed = db.toggle_favorite("rustdesk").unwrap();
        assert!(!fav_removed);
        assert_eq!(db.get_favorites().unwrap().len(), 0);
    }

    #[test]
    fn test_update_rules_crud() {
        let db = Database::open_in_memory().unwrap();

        // 1. Initial state: no rules
        assert!(db.get_rule("rustdesk").unwrap().is_none());
        assert_eq!(db.get_all_rules().unwrap().len(), 0);

        // 2. Set skip version
        db.set_skip_version("rustdesk", Some("v1.3.0")).unwrap();
        let rule = db.get_rule("rustdesk").unwrap().expect("rule exists");
        assert_eq!(rule.app_id, "rustdesk");
        assert_eq!(rule.skipped_version.as_deref(), Some("v1.3.0"));
        assert!(!rule.is_frozen);
        assert!(!rule.is_hidden);

        // 3. Freeze version
        db.set_frozen_status("rustdesk", true).unwrap();
        let rule = db.get_rule("rustdesk").unwrap().unwrap();
        assert!(rule.is_frozen);
        assert_eq!(rule.skipped_version.as_deref(), Some("v1.3.0"));

        // 4. Hide status
        db.set_hidden_status("rustdesk", true).unwrap();
        let rule = db.get_rule("rustdesk").unwrap().unwrap();
        assert!(rule.is_hidden);

        // 5. Add second app rule
        db.set_skip_version("localsend", Some("v1.14.1")).unwrap();
        let all = db.get_all_rules().unwrap();
        assert_eq!(all.len(), 2);

        // 6. Unfreeze and unhide
        db.set_frozen_status("rustdesk", false).unwrap();
        db.set_hidden_status("rustdesk", false).unwrap();
        let rule = db.get_rule("rustdesk").unwrap().unwrap();
        assert!(!rule.is_frozen);
        assert!(!rule.is_hidden);

        // 7. Remove rule
        let removed = db.remove_rule("rustdesk").unwrap();
        assert!(removed);
        assert!(db.get_rule("rustdesk").unwrap().is_none());
        assert_eq!(db.get_all_rules().unwrap().len(), 1);
    }

    #[test]
    fn test_search_and_view_history_crud() {
        let db = Database::open_in_memory().unwrap();

        // 1. Search history
        db.record_search_query("rustdesk").unwrap();
        db.record_search_query("localsend").unwrap();
        db.record_search_query("rustdesk").unwrap(); // upsert (should move to top)

        let queries = db.get_search_history().unwrap();
        assert_eq!(queries.len(), 2);
        assert_eq!(queries[0], "rustdesk");
        assert_eq!(queries[1], "localsend");

        db.remove_search_query("localsend").unwrap();
        let queries_after = db.get_search_history().unwrap();
        assert_eq!(queries_after.len(), 1);
        assert_eq!(queries_after[0], "rustdesk");

        db.clear_search_history().unwrap();
        assert!(db.get_search_history().unwrap().is_empty());

        // 2. View history
        db.record_app_view("rustdesk").unwrap();
        db.record_app_view("vlc").unwrap();
        db.record_app_view("rustdesk").unwrap(); // upsert to top

        let app_ids = db.get_recently_viewed_app_ids().unwrap();
        assert_eq!(app_ids.len(), 2);
        assert_eq!(app_ids[0], "rustdesk");
        assert_eq!(app_ids[1], "vlc");

        db.clear_view_history().unwrap();
        assert!(db.get_recently_viewed_app_ids().unwrap().is_empty());
    }

    #[test]
    fn test_host_tokens_crud() {
        let db = Database::open_in_memory().unwrap();

        // 1. Initially empty
        let tokens = db.get_host_tokens().unwrap();
        assert!(tokens.is_empty());

        // 2. Set token
        db.set_host_token("codeberg.org", "cb_token_123").unwrap();
        db.set_host_token("github.com", "gh_token_456").unwrap();

        let tokens = db.get_host_tokens().unwrap();
        assert_eq!(tokens.len(), 2);
        assert_eq!(db.get_host_token("codeberg.org").unwrap().as_deref(), Some("cb_token_123"));
        assert_eq!(db.get_host_token("github.com").unwrap().as_deref(), Some("gh_token_456"));

        // 3. Update rate limit
        db.update_host_rate_limit("codeberg.org", Some(2990), Some(3000), Some(1700000000)).unwrap();
        let tokens_after = db.get_host_tokens().unwrap();
        let cb = tokens_after.iter().find(|t| t.host == "codeberg.org").unwrap();
        assert_eq!(cb.rate_limit_remaining, Some(2990));

        // 4. Remove token
        let removed = db.remove_host_token("codeberg.org").unwrap();
        assert!(removed);
        assert!(db.get_host_token("codeberg.org").unwrap().is_none());
        assert_eq!(db.get_host_tokens().unwrap().len(), 1);

        // 5. Update rate limit without prior token (Anonymous/Public host entry)
        db.update_host_rate_limit("gitea.com", Some(55), Some(60), Some(1700000100)).unwrap();
        let tokens_new = db.get_host_tokens().unwrap();
        assert_eq!(tokens_new.len(), 2);
        let gitea = tokens_new.iter().find(|t| t.host == "gitea.com").unwrap();
        assert_eq!(gitea.rate_limit_remaining, Some(55));
        assert_eq!(gitea.rate_limit_limit, Some(60));
        assert!(db.get_host_token("gitea.com").unwrap().is_none());
    }

    #[test]
    fn test_app_details_cache_crud() {
        let db = Database::open_in_memory().unwrap();
        db.clear_app_details_cache().unwrap();

        // 1. Initial: empty
        assert!(db.get_cached_app_detail("rustdesk", None).unwrap().is_none());
        assert!(db.get_cached_app_detail("github.com/rustdesk/rustdesk", None).unwrap().is_none());

        // 2. Save detail
        let detail = AppDetail {
            id: "rustdesk".to_string(),
            name: "RustDesk".to_string(),
            owner: "rustdesk".to_string(),
            repo: "rustdesk".to_string(),
            icon: "https://github.com/rustdesk.png".to_string(),
            icon_bg: "linear-gradient(135deg, #f97316, #ea580c)".to_string(),
            description: "远程桌面软件".to_string(),
            stars: 70000,
            forks: 9000,
            license: "AGPL-3.0".to_string(),
            latest_version: "v1.3.1".to_string(),
            changelog: "修复已知问题".to_string(),
            is_verified: true,
            signature_fingerprint: None,
            readme_markdown: "# RustDesk".to_string(),
            releases: vec![],
            category: "system".to_string(),
            category_name: "系统实用".to_string(),
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            cached_at: None,
            is_stale_fallback: None,
        };

        db.save_cached_app_detail("rustdesk", "github.com/rustdesk/rustdesk", &detail).unwrap();

        // 3. Hit via app_id with TTL
        let cached_by_id = db.get_cached_app_detail("rustdesk", Some(1800)).unwrap().expect("hit by id");
        assert_eq!(cached_by_id.name, "RustDesk");
        assert_eq!(cached_by_id.latest_version, "v1.3.1");
        assert!(cached_by_id.cached_at.is_some());

        // 4. Hit via repo_key
        let cached_by_repo = db.get_cached_app_detail("github.com/rustdesk/rustdesk", Some(1800)).unwrap().expect("hit by repo_key");
        assert_eq!(cached_by_repo.id, "rustdesk");

        // 5. Hit with different casing
        let cached_casing = db.get_cached_app_detail("RustDesk", Some(1800)).unwrap().expect("hit with uppercase");
        assert_eq!(cached_casing.name, "RustDesk");
        let cached_repo_casing = db.get_cached_app_detail("GitHub.com/RustDesk/RustDesk", Some(1800)).unwrap().expect("hit with uppercase repo");
        assert_eq!(cached_repo_casing.name, "RustDesk");

        // 6. Test TTL expiration
        // Using ttl = 0 means expired / must revalidate
        assert!(db.get_cached_app_detail("rustdesk", Some(0)).unwrap().is_none());
        // Even if expired, fallback retrieves the cached copy
        let fallback = db.get_cached_app_detail_fallback("rustdesk").unwrap().expect("fallback hit");
        assert_eq!(fallback.name, "RustDesk");

        // 7. Test touch_cached_app_detail
        let fresh_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64 + 100;
        db.touch_cached_app_detail("rustdesk", fresh_now).unwrap();
        let touched = db.get_cached_app_detail("rustdesk", Some(1800)).unwrap().expect("touched hit");
        assert_eq!(touched.cached_at, Some(fresh_now));

        // 8. Update
        let mut updated_detail = detail.clone();
        updated_detail.latest_version = "v1.3.2".to_string();
        db.save_cached_app_detail("rustdesk", "github.com/rustdesk/rustdesk", &updated_detail).unwrap();
        let cached_updated = db.get_cached_app_detail("rustdesk", Some(1800)).unwrap().unwrap();
        assert_eq!(cached_updated.latest_version, "v1.3.2");

        // 9. Clear cache
        db.clear_app_details_cache().unwrap();
        assert!(db.get_cached_app_detail("rustdesk", None).unwrap().is_none());
    }
}
