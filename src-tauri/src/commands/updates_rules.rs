use crate::models::UpdateRule;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_update_rules(state: State<'_, AppState>) -> crate::AppResult<Vec<UpdateRule>> {
    let db = state.db()?;
    Ok(db.get_all_rules()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_app_skip_version(
    state: State<'_, AppState>,
    app_id: String,
    version: Option<String>,
) -> crate::AppResult<bool> {
    // 归一化 app_id；未知标识直接拒绝，避免写入无效行。
    let app_id = crate::commands::require_app_id(&app_id)?;
    let db = state.db()?;
    db.set_skip_version(&app_id, version.as_deref())?;
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_app_frozen(
    state: State<'_, AppState>,
    app_id: String,
    is_frozen: bool,
) -> crate::AppResult<bool> {
    // 归一化 app_id；未知标识直接拒绝，避免写入无效行。
    let app_id = crate::commands::require_app_id(&app_id)?;
    let db = state.db()?;
    db.set_frozen_status(&app_id, is_frozen)?;
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_app_hidden(
    state: State<'_, AppState>,
    app_id: String,
    is_hidden: bool,
) -> crate::AppResult<bool> {
    // 归一化 app_id；未知标识直接拒绝，避免写入无效行。
    let app_id = crate::commands::require_app_id(&app_id)?;
    let db = state.db()?;
    db.set_hidden_status(&app_id, is_hidden)?;
    Ok(true)
}

/// 3 个 update-rule 写命令的入站归一化契约测试。
#[cfg(test)]
mod update_rule_inbound_normalization_tests {
    use crate::db::Database;

    const MIXED_CASE: &str = "RustDesk/RustDesk";
    const URL_FORM: &str = "https://github.com/RustDesk/RustDesk";
    const CANONICAL: &str = "rustdesk/rustdesk";
    const GARBAGE: &str = "!!!not-an-id!!!";

    fn normalize(raw: &str) -> Option<String> {
        crate::forge::canonical_app_id(raw)
    }

    #[test]
    fn set_app_skip_version_stores_canonical_for_mixed_case_and_url_form() {
        for raw in [MIXED_CASE, URL_FORM] {
            let db = Database::open_in_memory().unwrap();
            // 与命令入口守卫完全相同的归一化步骤
            let id = normalize(raw).expect("parseable id must normalize");
            assert_eq!(id, CANONICAL);
            db.set_skip_version(&id, Some("v1.0.0")).unwrap();
            let rule = db
                .get_rule(CANONICAL)
                .unwrap()
                .expect("canonical row stored");
            assert_eq!(rule.app_id, CANONICAL);
            assert_eq!(rule.skipped_version.as_deref(), Some("v1.0.0"));
            assert!(
                db.get_rule(raw).unwrap().is_none(),
                "never stored under raw form: {}",
                raw
            );
        }
    }

    #[test]
    fn set_app_skip_version_rejects_garbage() {
        assert!(normalize(GARBAGE).is_none());
        assert!(normalize("").is_none());
        assert!(normalize("   ").is_none());
        // 守卫在触碰 SQLite 前返回 Err：零写入
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_all_rules().unwrap().is_empty());
        assert!(db.get_rule(GARBAGE).unwrap().is_none());
    }

    #[test]
    fn set_app_frozen_stores_canonical_for_mixed_case_and_url_form() {
        for raw in [MIXED_CASE, URL_FORM] {
            let db = Database::open_in_memory().unwrap();
            let id = normalize(raw).expect("parseable id must normalize");
            assert_eq!(id, CANONICAL);
            db.set_frozen_status(&id, true).unwrap();
            let rule = db
                .get_rule(CANONICAL)
                .unwrap()
                .expect("canonical row stored");
            assert!(rule.is_frozen);
            assert!(
                db.get_rule(raw).unwrap().is_none(),
                "never stored under raw form: {}",
                raw
            );
        }
    }

    #[test]
    fn set_app_frozen_rejects_garbage() {
        assert!(normalize(GARBAGE).is_none());
        assert!(normalize("not an id with spaces").is_none());
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_all_rules().unwrap().is_empty());
        assert!(db.get_rule(GARBAGE).unwrap().is_none());
    }

    #[test]
    fn set_app_hidden_stores_canonical_for_mixed_case_and_url_form() {
        for raw in [MIXED_CASE, URL_FORM] {
            let db = Database::open_in_memory().unwrap();
            let id = normalize(raw).expect("parseable id must normalize");
            assert_eq!(id, CANONICAL);
            db.set_hidden_status(&id, true).unwrap();
            let rule = db
                .get_rule(CANONICAL)
                .unwrap()
                .expect("canonical row stored");
            assert!(rule.is_hidden);
            assert!(
                db.get_rule(raw).unwrap().is_none(),
                "never stored under raw form: {}",
                raw
            );
        }
    }

    #[test]
    fn set_app_hidden_rejects_garbage() {
        assert!(normalize(GARBAGE).is_none());
        assert!(normalize("localsend").is_none());
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_all_rules().unwrap().is_empty());
        assert!(db.get_rule(GARBAGE).unwrap().is_none());
    }
}
