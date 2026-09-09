use serde::Deserialize;
use std::collections::HashMap;

/// 用户数据导入：允许合入设置项的白名单（仅主题/语言/缓存保鲜期/关注通知频率）。
pub const IMPORT_SETTINGS_ALLOWLIST: &[&str] = &[
    "theme",
    "language",
    "detail_cache_ttl_minutes",
    "watch_notify_frequency",
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

/// 解析并清洗导入 JSON（纯函数）：版本必须为 1；非法 ID 与非白名单
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
                let t = s.trim().to_string();
                if validate_app_id(&t) && !out.contains(&t) {
                    out.push(t);
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
