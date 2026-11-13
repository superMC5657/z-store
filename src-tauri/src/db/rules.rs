use super::{clean, now_secs, Database};
use crate::models::UpdateRule;
use rusqlite::{params, Result};

/// 不含任何生效策略的规则行条件。
const EMPTY_RULE: &str =
    "(skipped_version IS NULL OR TRIM(skipped_version) = '') AND is_frozen = 0 AND is_hidden = 0";

impl Database {
    pub fn get_rule(&self, app_id: &str) -> Result<Option<UpdateRule>> {
        let mut stmt = self.conn.prepare(
            "SELECT app_id, skipped_version, is_frozen, is_hidden, updated_at FROM update_rules WHERE app_id = ?1",
        )?;
        let mut rows = stmt.query(params![clean(app_id)])?;
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
        self.query_vec(
            &format!("SELECT app_id, skipped_version, is_frozen, is_hidden, updated_at FROM update_rules WHERE NOT ({EMPTY_RULE}) ORDER BY updated_at DESC"),
            [],
            |row| {
                let is_frozen_int: i64 = row.get(2)?;
                let is_hidden_int: i64 = row.get(3)?;
                Ok(UpdateRule {
                    app_id: row.get(0)?,
                    skipped_version: row.get(1)?,
                    is_frozen: is_frozen_int != 0,
                    is_hidden: is_hidden_int != 0,
                    updated_at: row.get(4)?,
                })
            },
        )
    }

    fn upsert_update_rule_field<T: rusqlite::ToSql>(
        &self,
        app_id: &str,
        field_name: &str,
        value: T,
    ) -> Result<()> {
        let now = now_secs();
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
        self.exec_write(&sql, params![clean(app_id), value, now])?;
        self.prune_empty_rule(app_id)
    }

    /// 跳过版本、锁定、隐藏都已撤销的规则不再约束任何行为，直接删除该行。
    fn prune_empty_rule(&self, app_id: &str) -> Result<()> {
        self.exec_write(
            &format!("DELETE FROM update_rules WHERE app_id = ?1 AND {EMPTY_RULE}"),
            params![clean(app_id)],
        )?;
        Ok(())
    }

    /// 锁定版本已包含跳过：已锁定的应用不再记录跳过版本，写入直接忽略。
    pub fn set_skip_version(&self, app_id: &str, version: Option<&str>) -> Result<()> {
        if version.is_some() && self.get_rule(app_id)?.is_some_and(|r| r.is_frozen) {
            return Ok(());
        }
        self.upsert_update_rule_field(app_id, "skipped_version", version)
    }

    /// 锁定时一并清掉跳过版本：锁定后不再检测更新，单独跳过某个版本没有意义。
    pub fn set_frozen_status(&self, app_id: &str, is_frozen: bool) -> Result<()> {
        self.upsert_update_rule_field(app_id, "is_frozen", if is_frozen { 1 } else { 0 })?;
        if is_frozen {
            self.exec_write(
                "UPDATE update_rules SET skipped_version = NULL WHERE app_id = ?1",
                params![clean(app_id)],
            )?;
        }
        Ok(())
    }

    pub fn set_hidden_status(&self, app_id: &str, is_hidden: bool) -> Result<()> {
        self.upsert_update_rule_field(app_id, "is_hidden", if is_hidden { 1 } else { 0 })
    }
}
