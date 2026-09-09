use super::Database;
use crate::models::InstalledApp;
use rusqlite::{params, Result};

impl Database {
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
                icon: None,
                icon_bg: None,
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
}
