//! 商业软件「开源平替」元数据映射与去重并集工具。
//!
//! 严格遵循 D1 纯粹开源边界：商业闭源软件名仅作为搜索关键词与平替提示标签
//! 附着在已通过 D1 门禁的开源应用元数据上，绝不作为可安装条目写入目录。

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use super::models::CatalogItem;

const BUILTIN_ALTERNATIVES_JSON: &str = include_str!("../../../src/data/builtin-alternatives.json");

fn builtin_map() -> &'static HashMap<String, Vec<String>> {
    static MAP: OnceLock<HashMap<String, Vec<String>>> = OnceLock::new();
    MAP.get_or_init(|| {
        serde_json::from_str::<HashMap<String, Vec<String>>>(BUILTIN_ALTERNATIVES_JSON)
            .expect("src/data/builtin-alternatives.json 必须为合法的 JSON 字典")
            .into_iter()
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v))
            .collect()
    })
}

/// 内置高频商业/闭源软件 → 精选开源平替规范 ID（小写 `owner/repo`）映射。
///
/// 当远端 `catalog.json` 尚未补充 `alternatives` 字段时，客户端以此表无缝补齐；
/// 上游逐条补充后通过 [`resolved_alternatives`] 自动去重并集生效。
pub fn builtin_alternatives_for(canonical_id: &str) -> &'static [String] {
    let key = canonical_id.trim().to_ascii_lowercase();
    builtin_map().get(key.as_str()).map_or(&[], Vec::as_slice)
}

/// 合并显式 `alternatives` 切片与内置映射，按大小写不敏感去重并保留首次出现格式。
pub fn resolved_alternatives_for(explicit: &[String], canonical_id: &str) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for raw in explicit.iter().map(String::as_str).chain(
        builtin_alternatives_for(canonical_id)
            .iter()
            .map(String::as_str),
    ) {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    }
    out
}

/// 合并目录条目显式 `CatalogItem.alternatives` 与内置映射，按大小写不敏感去重并保留首次出现格式。
pub fn resolved_alternatives(item: &CatalogItem) -> Vec<String> {
    resolved_alternatives_for(&item.alternatives, &item.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_alternatives_merges_and_deduplicates_case_insensitively() {
        let explicit = vec![
            "teamviewer".to_string(),
            "  ".to_string(),
            "Splashtop".to_string(),
            "SPLASHTOP".to_string(),
        ];
        let merged = resolved_alternatives_for(&explicit, "RustDesk/RustDesk");
        assert_eq!(
            merged,
            vec![
                "teamviewer".to_string(),
                "Splashtop".to_string(),
                "AnyDesk".to_string(),
                "ToDesk".to_string(),
                "向日葵".to_string(),
            ]
        );
    }

    #[test]
    fn builtin_alternatives_covers_core_categories() {
        assert!(builtin_alternatives_for("rustdesk/rustdesk")
            .iter()
            .any(|s| s == "TeamViewer"));
        assert!(builtin_alternatives_for("toeverything/affine")
            .iter()
            .any(|s| s == "Notion"));
        assert!(builtin_alternatives_for("usebruno/bruno")
            .iter()
            .any(|s| s == "Postman"));
        assert!(builtin_alternatives_for("keepassxreboot/keepassxc")
            .iter()
            .any(|s| s == "1Password"));
        assert!(builtin_alternatives_for("dbeaver/dbeaver")
            .iter()
            .any(|s| s == "Navicat"));
        assert!(builtin_alternatives_for("agalwood/motrix")
            .iter()
            .any(|s| s == "IDM"));
        assert!(builtin_alternatives_for("moonlight-stream/moonlight-qt")
            .iter()
            .any(|s| s == "Parsec"));
        assert!(builtin_alternatives_for("unknown/nonexistent").is_empty());
    }
}
