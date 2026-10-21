use super::{clean, now_secs, Database};
use crate::models::UpdateItem;
use rusqlite::{params, Result};

/// 更新中心持久化行：一次 `check_for_updates(force=true)` 对每个已安装应用的判定快照。
/// - `installed_version` 为检查时刻的本地版本（下次读取时若与当前安装版本不一致视为过期）；
/// - `has_update` 为当时 `should_include_update` 判定结果；
/// - `changelog/icon/icon_bg` 为当时远端回包透存，供 `get_cached_updates` 零网络直显。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCheckRow {
    pub app_id: String,
    pub app_name: String,
    pub installed_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub changelog: String,
    pub icon: Option<String>,
    pub icon_bg: Option<String>,
    pub checked_at: i64,
}

impl Database {
    /// 单行 upsert（调用方批量场景优先用 `save_update_checks_batch` 合并为 1 提交）。
    pub fn save_update_check(&self, row: &UpdateCheckRow) -> Result<()> {
        let clean_id = clean(&row.app_id);
        if clean_id.is_empty() {
            return Ok(());
        }
        let checked_at = if row.checked_at == 0 {
            now_secs()
        } else {
            row.checked_at
        };
        self.exec_write(
            r#"
            INSERT INTO update_results (
                app_id, app_name, installed_version, latest_version,
                has_update, changelog, icon, icon_bg, checked_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(app_id) DO UPDATE SET
                app_name = excluded.app_name,
                installed_version = excluded.installed_version,
                latest_version = excluded.latest_version,
                has_update = excluded.has_update,
                changelog = excluded.changelog,
                icon = excluded.icon,
                icon_bg = excluded.icon_bg,
                checked_at = excluded.checked_at;
            "#,
            params![
                clean_id,
                row.app_name.trim(),
                row.installed_version.trim(),
                row.latest_version.trim(),
                if row.has_update { 1 } else { 0 },
                row.changelog.clone(),
                row.icon.clone().unwrap_or_default(),
                row.icon_bg.clone().unwrap_or_default(),
                checked_at,
            ],
        )?;
        Ok(())
    }

    /// 批量 upsert（`check_for_updates(force=true)` 写包事务化）：
    /// `BEGIN IMMEDIATE` → N 行 `save_update_check` → `COMMIT`，失败整体 `ROLLBACK`。
    /// 调用方保持 `let _ =` 吞错 + 下次刷新重试语义。
    pub fn save_update_checks_batch(&self, rows: &[UpdateCheckRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        self.with_immediate_transaction(|| {
            for r in rows {
                self.save_update_check(r)?;
            }
            Ok(())
        })
    }

    /// 更新中心列表读（DB-only，无网络）：仅 `has_update=1` 行，按 `app_id` 排序。
    /// 规则过滤（frozen/hidden/skip）与版本重校验由命令层执行，此处只做形状投影。
    pub fn get_cached_updates(&self) -> Result<Vec<UpdateItem>> {
        self.query_vec(
            r#"
            SELECT app_id, app_name, installed_version, latest_version,
                   changelog, icon, icon_bg
            FROM update_results WHERE has_update = 1 ORDER BY app_id ASC
            "#,
            [],
            |row| {
                let icon_str: String = row.get(5)?;
                let icon_bg_str: String = row.get(6)?;
                Ok(UpdateItem {
                    app_id: row.get(0)?,
                    app_name: row.get(1)?,
                    current_version: row.get(2)?,
                    latest_version: row.get(3)?,
                    changelog: row.get(4)?,
                    icon: if icon_str.is_empty() {
                        None
                    } else {
                        Some(icon_str)
                    },
                    icon_bg: if icon_bg_str.is_empty() {
                        None
                    } else {
                        Some(icon_bg_str)
                    },
                })
            },
        )
    }

    /// 轻量探测 DB 快径（`fetch_app_latest_version_lightweight` 非 force 臂）：
    /// 返回该应用上次检查的远端版本对（不区分 `has_update`，调用方仍做版本比较）。
    pub fn get_cached_update_version(&self, app_id: &str) -> Result<Option<(String, String)>> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT latest_version, changelog FROM update_results WHERE app_id = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![cleaned])?;
        if let Some(row) = rows.next()? {
            let latest: String = row.get(0)?;
            let changelog: String = row.get(1)?;
            Ok(Some((latest, changelog)))
        } else {
            Ok(None)
        }
    }

    /// 安装/卸载/版本变更失效：删除该应用的更新判定行（无行即空操作）。
    /// 调用方（安装/卸载/取消管理/导入）在版本写成功后 best-effort 调用，`let _ =` 吞错。
    pub fn remove_update_result(&self, app_id: &str) -> Result<bool> {
        let rows = self.exec_write(
            "DELETE FROM update_results WHERE app_id = ?1",
            params![clean(app_id)],
        )?;
        Ok(rows > 0)
    }

    /// 卸载收敛：删除不在当前已安装集合中的过期行（`check_for_updates(force=true)` 尾部调用）。
    /// 空集合直接跳过（避免 `NOT IN ()` 误删全表）；调用方保持 `let _ =` 吞错。
    pub fn prune_update_results_not_in(&self, keep_ids: &[String]) -> Result<usize> {
        if keep_ids.is_empty() {
            return Ok(0);
        }
        let placeholders = keep_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM update_results WHERE app_id NOT IN ({placeholders})"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.execute(rusqlite::params_from_iter(keep_ids.iter()))?;
        Ok(rows)
    }
}

#[cfg(test)]
mod update_results_tests {
    use super::*;

    fn row(id: &str, installed: &str, latest: &str, has_update: bool) -> UpdateCheckRow {
        UpdateCheckRow {
            app_id: id.to_string(),
            app_name: format!("{id}-name"),
            installed_version: installed.to_string(),
            latest_version: latest.to_string(),
            has_update,
            changelog: "notes".to_string(),
            icon: Some("icon".to_string()),
            icon_bg: Some("bg".to_string()),
            checked_at: 1700000000,
        }
    }

    #[test]
    fn upsert_and_read_filters_has_update() {
        let db = Database::open_in_memory().unwrap();
        db.save_update_check(&row("o/a", "v1.0.0", "v1.1.0", true))
            .unwrap();
        db.save_update_check(&row("o/b", "v2.0.0", "v2.0.0", false))
            .unwrap();
        // 单行版本快径不区分 has_update。
        assert_eq!(
            db.get_cached_update_version("o/a").unwrap(),
            Some(("v1.1.0".to_string(), "notes".to_string()))
        );
        assert_eq!(
            db.get_cached_update_version("o/b").unwrap(),
            Some(("v2.0.0".to_string(), "notes".to_string()))
        );
        // 列表仅 has_update=1。
        let list = db.get_cached_updates().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].app_id, "o/a");
        assert_eq!(list[0].current_version, "v1.0.0");
        assert_eq!(list[0].latest_version, "v1.1.0");
        // 覆盖更新为无更新后列表置空。
        db.save_update_check(&row("o/a", "v1.1.0", "v1.1.0", false))
            .unwrap();
        assert!(db.get_cached_updates().unwrap().is_empty());
    }

    #[test]
    fn batch_is_atomic_and_prune_keeps_installed() {
        let db = Database::open_in_memory().unwrap();
        db.save_update_checks_batch(&[
            row("o/a", "v1.0.0", "v1.1.0", true),
            row("o/b", "v1.0.0", "v1.1.0", true),
            row("o/gone", "v1.0.0", "v1.1.0", true),
        ])
        .unwrap();
        assert_eq!(db.get_cached_updates().unwrap().len(), 3);
        let pruned = db
            .prune_update_results_not_in(&["o/a".to_string(), "o/b".to_string()])
            .unwrap();
        assert_eq!(pruned, 1);
        assert!(db.get_cached_update_version("o/gone").unwrap().is_none());
        // 空集合跳过不误删。
        assert_eq!(db.prune_update_results_not_in(&[]).unwrap(), 0);
        assert_eq!(db.get_cached_updates().unwrap().len(), 2);
    }

    #[test]
    fn remove_is_idempotent_and_empty_id_noop() {
        let db = Database::open_in_memory().unwrap();
        db.save_update_check(&row("o/a", "v1.0.0", "v1.1.0", true))
            .unwrap();
        assert!(db.remove_update_result("o/a").unwrap());
        assert!(!db.remove_update_result("o/a").unwrap());
        assert!(!db.remove_update_result("   ").unwrap());
        assert!(db.save_update_check(&row("   ", "v1", "v2", true)).is_ok());
    }
}
