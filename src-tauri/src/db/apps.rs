use super::{clean, Database};
use crate::models::InstalledApp;
use rusqlite::{params, Result};

const INSTALLED_COLS: &str = "app_id, app_name, version, installed_at, install_method, \
    install_path, asset_name, asset_sha256, uninstall_command";

fn row_to_installed(row: &rusqlite::Row<'_>) -> Result<InstalledApp> {
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
}

impl Database {
    pub fn get_installed_apps(&self) -> Result<Vec<InstalledApp>> {
        self.query_vec(
            &format!("SELECT {INSTALLED_COLS} FROM installed_apps ORDER BY installed_at DESC"),
            [],
            row_to_installed,
        )
    }

    /// 主键点查单个已安装应用。
    pub fn get_installed_app(&self, app_id: &str) -> Result<Option<InstalledApp>> {
        let id = clean(app_id);
        if id.is_empty() {
            return Ok(None);
        }
        Ok(self
            .query_vec(
                &format!("SELECT {INSTALLED_COLS} FROM installed_apps WHERE app_id = ?1 LIMIT 1"),
                params![id],
                row_to_installed,
            )?
            .into_iter()
            .next())
    }

    pub fn save_installed_app(&self, app: &InstalledApp) -> Result<()> {
        self.exec_write(
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
        let rows = self.exec_write(
            "DELETE FROM installed_apps WHERE app_id = ?1",
            params![clean(app_id)],
        )?;
        Ok(rows > 0)
    }
}
