use crate::models::UpdateRule;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_update_rules(state: State<'_, AppState>) -> crate::AppResult<Vec<UpdateRule>> {
    let db = state.db()?;
    Ok(db.get_all_rules()?)
}

#[tauri::command]
pub fn set_app_skip_version(
    state: State<'_, AppState>,
    app_id: String,
    version: Option<String>,
) -> crate::AppResult<bool> {
    // ADR-0010：入站归一化后全程使用 canonical id；未知标识直接拒绝，永不写入
    let app_id = crate::commands::require_app_id(&app_id)?;
    let db = state.db()?;
    db.set_skip_version(&app_id, version.as_deref())?;
    Ok(true)
}

#[tauri::command]
pub fn set_app_frozen(
    state: State<'_, AppState>,
    app_id: String,
    is_frozen: bool,
) -> crate::AppResult<bool> {
    // ADR-0010：入站归一化后全程使用 canonical id；未知标识直接拒绝，永不写入
    let app_id = crate::commands::require_app_id(&app_id)?;
    let db = state.db()?;
    db.set_frozen_status(&app_id, is_frozen)?;
    Ok(true)
}

#[tauri::command]
pub fn set_app_hidden(
    state: State<'_, AppState>,
    app_id: String,
    is_hidden: bool,
) -> crate::AppResult<bool> {
    // ADR-0010：入站归一化后全程使用 canonical id；未知标识直接拒绝，永不写入
    let app_id = crate::commands::require_app_id(&app_id)?;
    let db = state.db()?;
    db.set_hidden_status(&app_id, is_hidden)?;
    Ok(true)
}

#[tauri::command]
pub fn remove_update_rule(state: State<'_, AppState>, app_id: String) -> crate::AppResult<bool> {
    // ADR-0010：入站归一化后全程使用 canonical id；未知标识直接拒绝，永不写入
    let app_id = crate::commands::require_app_id(&app_id)?;
    let db = state.db()?;
    Ok(db.remove_rule(&app_id)?)
}

/// ADR-0010 入站归一化契约（finding 2.1-1, part A）：
/// 4 个 update-rule 命令必须先经 `crate::forge::canonical_app_id` 归一化——
/// 混合大小写 / URL 形态落 canonical 键，无法解析者直接拒绝、永不写入 SQLite。
/// Tauri `State` 命令体无法在单测中直调，故此处按“每命令存储路径”锁定契约：
/// 用与命令相同的归一化 + DB 调用序列断言 canonical 命中、raw 键无行、垃圾 id 无写入。
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

    #[test]
    fn remove_update_rule_removes_canonical_for_mixed_case_and_url_form() {
        for raw in [MIXED_CASE, URL_FORM] {
            let db = Database::open_in_memory().unwrap();
            db.set_skip_version(CANONICAL, Some("v1.0.0")).unwrap();
            let id = normalize(raw).expect("parseable id must normalize");
            assert_eq!(id, CANONICAL);
            assert!(db.remove_rule(&id).unwrap());
            assert!(db.get_rule(CANONICAL).unwrap().is_none());
        }
    }

    #[test]
    fn remove_update_rule_rejects_garbage() {
        assert!(normalize(GARBAGE).is_none());
        // 垃圾 id 永不触碰 SQLite：已存在的 canonical 规则不受影响
        let db = Database::open_in_memory().unwrap();
        db.set_skip_version(CANONICAL, Some("v1.0.0")).unwrap();
        assert!(db.get_rule(CANONICAL).unwrap().is_some());
        assert!(db.get_rule(GARBAGE).unwrap().is_none());
    }
}
