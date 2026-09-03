use crate::models::InstalledApp;
use rusqlite::{params, Connection, Result};
use std::collections::HashMap;
use std::path::Path;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
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

            CREATE TABLE IF NOT EXISTS user_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_favorites (
                app_id TEXT PRIMARY KEY,
                favorited_at INTEGER NOT NULL
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

    pub fn clear_cache(&self) -> Result<()> {
        self.conn.execute("DELETE FROM api_etag_cache", [])?;
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
}
