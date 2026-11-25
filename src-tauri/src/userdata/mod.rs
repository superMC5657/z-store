//! 用户数据备份导入：校验、允许合入白名单与单事务 SQLite 合入。

#[cfg(test)]
mod tests;

use serde::Deserialize;
use std::collections::HashMap;

/// 允许导出的设置项白名单（刻意排除 `github_token` 等凭据以防跨设备泄露）。
pub const IMPORT_SETTINGS_ALLOWLIST: &[&str] = &[
    "theme",
    "language",
    "ui_scale",
    "font_size",
    "portable_dir",
    "download_dir",
    "active_mirror",
    "launch_on_startup",
    "update_frequency",
    "detail_cache_ttl_minutes",
    "catalog_source_url",
    "watch_notify_frequency",
    "show_custom",
    "showCustom",
];

/// 校验应用 ID 形态（纯函数）：非空、仅含常规仓库坐标字符。
/// 接受 `owner/repo`、`gh:owner/repo`、`cb:owner/repo` 等收录库 ID 形态。
pub fn validate_app_id(app_id: &str) -> bool {
    let id = app_id.trim();
    if id.is_empty() || id.len() > 200 {
        return false;
    }
    if id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '/' | ':' | '.' | '-' | '_' | '+'))
    {
        return false;
    }
    id.chars().any(|c| c.is_alphanumeric())
}

#[derive(Debug, Clone, Deserialize)]
struct ImportPayload {
    version: i32,
    #[serde(default)]
    favorites: Vec<serde_json::Value>,
    #[serde(default)]
    watched: Vec<serde_json::Value>,
    #[serde(default)]
    settings: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportPlan {
    pub favorites: Vec<String>,
    pub watched: Vec<String>,
    pub settings: Vec<(String, String)>,
}

/// 导入后需在 DB 锁外同步到运行期状态的副作用项。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ImportSideEffects {
    pub active_mirror: Option<String>,
    pub launch_on_startup: Option<bool>,
}

/// 解析并清洗导入 JSON（纯函数）：版本必须为 1；非法或无法归一的 ID 与非白名单
/// 设置项直接丢弃；`settings` 值统一转字符串。
pub fn parse_import_payload(json: &str) -> Result<ImportPlan, String> {
    let payload: ImportPayload =
        serde_json::from_str(json).map_err(|e| format!("导入数据不是有效的 JSON: {}", e))?;
    if payload.version != 1 {
        return Err(format!(
            "不支持的导入数据版本: {}（仅支持 version 1）",
            payload.version
        ));
    }

    let clean_ids = |vals: &[serde_json::Value]| -> Vec<String> {
        let mut out = Vec::new();
        for v in vals {
            if let Some(s) = v.as_str() {
                let t = s.trim();
                if validate_app_id(t) {
                    if let Some(canon) = crate::forge::canonical_app_id(t) {
                        if !out.contains(&canon) {
                            out.push(canon);
                        }
                    }
                }
            }
        }
        out
    };

    let mut settings = Vec::new();
    for (k, v) in &payload.settings {
        if !IMPORT_SETTINGS_ALLOWLIST.contains(&k.as_str()) {
            continue;
        }
        let s = match v {
            serde_json::Value::String(s) => s.trim().to_string(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        if !s.is_empty() {
            settings.push((k.clone(), s));
        }
    }

    Ok(ImportPlan {
        favorites: clean_ids(&payload.favorites),
        watched: clean_ids(&payload.watched),
        settings,
    })
}

/// 解析、校验并在单事务内合并导入用户备份数据（fail-fast，任一设置项校验失败或写入失败整体回滚），
/// 同时返回需在锁外同步的运行期副作用（镜像切换与开机自启）。
pub(crate) fn import_backup_with_effects(
    db: &crate::db::Database,
    is_cataloged: impl Fn(&str) -> bool,
    json: &str,
) -> Result<(crate::models::ImportUserDataResult, ImportSideEffects), String> {
    let plan = parse_import_payload(json)?;
    for (key, value) in &plan.settings {
        crate::commands::settings::validate_setting_value(key, value)?;
    }

    let mut effects = ImportSideEffects::default();
    let result = db
        .with_immediate_transaction(|| {
            let mut favorites_added = 0usize;
            let mut watched_added = 0usize;
            let mut settings_applied = 0usize;

            for id in &plan.favorites {
                if db.add_favorite(id, is_cataloged(id))? {
                    favorites_added += 1;
                }
            }
            for id in &plan.watched {
                if db.watch_app(id, is_cataloged(id))? {
                    watched_added += 1;
                }
            }
            for (key, value) in &plan.settings {
                let normalized = crate::db::normalize_setting_value(key, value);
                db.set_setting(key, &normalized)?;
                if key == "active_mirror" {
                    effects.active_mirror = Some(normalized);
                } else if key == "launch_on_startup" {
                    effects.launch_on_startup = Some(normalized == "true" || normalized == "1");
                }
                settings_applied += 1;
            }

            Ok(crate::models::ImportUserDataResult {
                favorites_added,
                watched_added,
                settings_applied,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok((result, effects))
}

/// 解析、校验并在单事务内合并导入用户备份数据（fail-fast，任一步失败整体回滚）。
pub fn import_backup(
    db: &crate::db::Database,
    is_cataloged: impl Fn(&str) -> bool,
    json: &str,
) -> Result<crate::models::ImportUserDataResult, String> {
    import_backup_with_effects(db, is_cataloged, json).map(|(result, _)| result)
}
