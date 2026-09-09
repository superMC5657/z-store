use super::Database;
use crate::models::UpdateRule;
use rusqlite::{params, Result};

impl Database {
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
}
