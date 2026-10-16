//! Lane A 本地自维护草稿 commands（ADR-0017）：CRUD + 转正 + 合并视图 + 预填 PR 链路。
//!
//! - `list_custom_apps` / `save_custom_app` / `delete_custom_app` /
//!   `mark_submitted` / `retire_on_sync` / `get_merged_catalog_view` /
//!   `get_custom_app_pr_url`；
//! - 二次确认由前端做，后端 `delete_custom_app` 直接删；
//! - `save_custom_app` 暂存档校验（`DraftLenient`，草稿允许不完整）+ `is_verified` 强制
//!   false（草稿永不冒充已验证收录）；提交档全校验（`SubmitStrict`，D1 不破）后移到
//!   `mark_submitted` / 预填 PR 链接。

use crate::config::LicenseGateConfig;
use crate::db::custom_apps::ValidateMode;
use crate::db::{CustomAppEntry, GraduationNotice};
use crate::github::models::CatalogItem;
use crate::github::CatalogService;
use crate::AppState;
use tauri::State;

/// 独立生态清单仓库收录申请预填页（ADR-0009）：收录 PR 目标。
/// 纯 URL 打开即可用，无需 token/OAuth（Lane D 一键 PR 链路入口）。
pub const CATALOG_REPO_ISSUES_URL: &str =
    "https://github.com/superMC5657/z-store-catalog/issues/new";

/// 本地校验说明（预填正文共用）：取链接前已过提交档 `validate_custom_item(strict)` 全校验。
const PR_BODY_CHECK_NOTE: &str =
    "本地校验：已通过提交档 `validate_custom_item(strict)`（canonical id / 必填字段 / OSI 协议），payload 见下方 JSON。";

/// 单条收录申请预填链接（纯函数，可单测）：标题带 canonical id，正文携带关键字段 +
/// 完整 JSON + 校验说明，用户在浏览器中确认后提交 Issue → maintainer 转 PR（预填 PR 链路）。
/// 首版单条单 PR（Q6=A/Q8=A/Q10=C 分期）；无需 token，纯 URL 打开。
pub fn build_single_pr_url(entry: &CustomAppEntry) -> String {
    let item = &entry.item;
    let title = format!("[收录申请] {}", entry.id);
    let homepage = item.homepage.as_deref().unwrap_or("").trim();
    let body = format!(
        "## 收录申请（本地自维护草稿预填）\n\n\
- 应用：{name} (`{id}`)\n\
- 仓库：{owner}/{repo}\n\
- 主页：{homepage}\n\
- 协议：{license}\n\
- 分类：{category}（{category_name}）\n\
- 版本：{version}\n\
- 状态：{status}\n\n\
{check_note}\n\n\
### payload_json\n\n```json\n{payload}\n```\n",
        name = item.name,
        id = entry.id,
        owner = item.owner,
        repo = item.repo,
        homepage = homepage,
        license = item.license,
        category = item.category,
        category_name = item.category_name,
        version = item.default_version,
        status = entry.status,
        check_note = PR_BODY_CHECK_NOTE,
        payload = serde_json::to_string_pretty(item).unwrap_or_default(),
    );
    format!(
        "{}?title={}&body={}",
        CATALOG_REPO_ISSUES_URL,
        urlencoding::encode(&title),
        urlencoding::encode(&body),
    )
}

/// 收录申请预填链接（纯函数，可单测）：`build_single_pr_url` 别名（Lane A 历史入口，语义不变）。
pub fn build_catalog_pr_url(entry: &CustomAppEntry) -> String {
    build_single_pr_url(entry)
}

/// 批量收录申请预填链接（纯函数，可单测，二期开关）：
/// 选中多条合并为一个 JSON 数组，经一个预填 URL 提交（批量合一 PR）。
/// 每条校验状态经提交档 `validate_custom_item(strict)` 逐条标注；
/// 空集合返回空数组占位页，不 panic。
pub fn build_batch_pr_url(entries: &[CustomAppEntry], gate: &LicenseGateConfig) -> String {
    let title = if entries.len() <= 1 {
        "[批量收录申请]".to_string()
    } else {
        format!("[批量收录申请] {} 项", entries.len())
    };
    let mut checklist = String::new();
    for entry in entries {
        let check = match crate::db::custom_apps::validate_custom_item(
            &entry.item,
            ValidateMode::SubmitStrict,
            gate,
        ) {
            Ok(_) => "校验通过".to_string(),
            Err(reason) => format!("校验失败：{}", reason),
        };
        checklist.push_str(&format!("- `{}`：{}\n", entry.id, check));
    }
    if checklist.is_empty() {
        checklist.push_str("- （暂无条目）\n");
    }
    let items: Vec<&CatalogItem> = entries.iter().map(|e| &e.item).collect();
    let payload = serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".to_string());
    let body = format!(
        "## 批量收录申请（本地自维护草稿预填，共 {count} 项）\n\n\
{checklist}\n\
{check_note}\n\n\
### payload_json\n\n```json\n{payload}\n```\n",
        count = entries.len(),
        checklist = checklist,
        check_note = PR_BODY_CHECK_NOTE,
        payload = payload,
    );
    format!(
        "{}?title={}&body={}",
        CATALOG_REPO_ISSUES_URL,
        urlencoding::encode(&title),
        urlencoding::encode(&body),
    )
}

/// 草稿列表（默认仅未归档；`include_archived=true` 含转正归档行）。
#[tauri::command]
pub fn list_custom_apps(
    state: State<'_, AppState>,
    include_archived: Option<bool>,
) -> crate::AppResult<Vec<CustomAppEntry>> {
    let db = state.db().map_err(crate::AppError::from)?;
    Ok(db.list_custom_apps(include_archived.unwrap_or(false))?)
}

/// 草稿暂存（暂存档校验：仅 `id==canonical` 且与 `owner/repo` 对齐；
/// `license` 占位（`OpenSource` 等）/ 空 `homepage` / 不完整字段均放行，Q8 草稿三态）。
/// 仅支持 GitHub `owner/repo`：forge 形态 id（含冒号 `:`）直接拒绝（PM#2 收口，
/// 通用 forge 基础设施保留，入口在此与 `validate_custom_item` 双层收口）。
/// 新建行 `status=draft`；已存在行仅刷新 payload（`status`/`pr_url` 保持）。
#[tauri::command]
pub fn save_custom_app(
    state: State<'_, AppState>,
    item: CatalogItem,
) -> crate::AppResult<CustomAppEntry> {
    if item.id.contains(':') {
        return Err(crate::AppError::new(format!(
            "仅支持 GitHub owner/repo，forge 形态 id 暂不收录：'{}'",
            item.id
        )));
    }
    let canonical = crate::db::custom_apps::validate_custom_item(
        &item,
        ValidateMode::DraftLenient,
        &LicenseGateConfig::default(),
    )
    .map_err(crate::AppError::new)?;
    let mut normalized = item;
    normalized.id = canonical;
    normalized.is_verified = false;
    let db = state.db().map_err(crate::AppError::from)?;
    Ok(db.upsert_custom_app_payload(&normalized)?)
}

/// 草稿删除（后端直接删，二次确认由前端做）：返回是否命中。
#[tauri::command]
pub fn delete_custom_app(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<bool> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    Ok(db.delete_custom_app(&key)?)
}

/// 标记已提交：`status=submitted` + 落 `pr_url`；已转正归档行拒绝。
/// 提交档全校验在 db 层强制（占位 license 草稿被拦，先补真实 SPDX 再提交）。
#[tauri::command]
pub fn mark_submitted(
    state: State<'_, AppState>,
    id: String,
    pr_url: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    Ok(db.mark_custom_app_submitted(&key, &pr_url)?)
}

/// 转正退役：远端 id 集合命中未归档草稿即 `archived=1`，返回转正提示。
/// `remote_ids=None` 时以当前内存目录 id 为准（`sync_catalog` 成功路径会自动调用）。
#[tauri::command]
pub fn retire_on_sync(
    state: State<'_, AppState>,
    remote_ids: Option<Vec<String>>,
) -> crate::AppResult<Vec<GraduationNotice>> {
    let ids: Vec<String> = match remote_ids {
        Some(v) => v,
        None => state
            .catalog
            .get_catalog_items()
            .into_iter()
            .map(|i| i.id)
            .collect(),
    };
    let db = state.db().map_err(crate::AppError::from)?;
    Ok(db.retire_custom_apps_on_sync(&ids)?)
}

/// 合并目录视图：内存远端目录 + 未归档草稿 overlay（远端优先去重，
/// `is_cataloged` 恒 true，来源经 `source` 区分 `remote`/`custom`）。
#[tauri::command]
pub fn get_merged_catalog_view(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<crate::github::catalog_service::MergedCatalogEntry>> {
    let remote = state.catalog.get_catalog_items();
    let custom: Vec<CatalogItem> = match state.db() {
        Ok(db) => db
            .list_custom_apps(false)
            .map(|v| v.into_iter().map(|e| e.item).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Ok(CatalogService::merge_catalog_overlay_view(
        &remote, &custom,
    ))
}

/// 收录申请预填链接：由草稿 payload 生成清单仓库 Issue 预填 URL（预填 PR 链路入口）。
/// 取链接前强制提交档全校验（占位 license 草稿在此被拦，前端指到 license 字段补 SPDX）。
#[tauri::command]
pub fn get_custom_app_pr_url(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<String> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.get_custom_app(&key)?.ok_or_else(|| {
        crate::AppError::new(format!("草稿不存在: {}", key))
    })?;
    let gate = crate::db::custom_apps::resolve_license_gate();
    crate::db::custom_apps::validate_custom_item(&entry.item, ValidateMode::SubmitStrict, &gate)
        .map_err(crate::AppError::new)?;
    Ok(build_single_pr_url(&entry))
}

/// 批量收录申请预填链接（二期开关）：多条草稿合并为一个 JSON 数组，经一个预填 URL
/// 提交（批量合一 PR）；任一条缺席即整批拒绝，不静默丢条；任一条提交档校验不过
/// 即整批拒绝（附 id，指到待补字段）。
#[tauri::command]
pub fn get_custom_apps_batch_pr_url(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<String> {
    let db = state.db().map_err(crate::AppError::from)?;
    let gate = crate::db::custom_apps::resolve_license_gate();
    let mut entries = Vec::with_capacity(ids.len());
    for id in &ids {
        let key = crate::forge::canonical_lookup_id(id);
        let entry = db.get_custom_app(&key)?.ok_or_else(|| {
            crate::AppError::new(format!("草稿不存在: {}", key))
        })?;
        if let Err(reason) = crate::db::custom_apps::validate_custom_item(
            &entry.item,
            ValidateMode::SubmitStrict,
            &gate,
        ) {
            return Err(crate::AppError::new(format!(
                "草稿 {} 提交校验未通过：{}",
                key, reason
            )));
        }
        entries.push(entry);
    }
    Ok(build_batch_pr_url(&entries, &gate))
}

/// 许可名单只读查询结果（ADR-0018）：名单唯一源头为后端编译时配置，
/// 前端 SubmitStrict 校验（提交/预填 PR 前）经此拉取；加载失败前端放行暂存、
/// 提交提示重试，绝不在前端回退一份写死名单。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LicenseAllowlist {
    pub enabled: bool,
    pub allowed: Vec<String>,
}

/// 许可名单只读查询（ADR-0018 唯一源头）：返回编译时名单 + 门禁开关。
#[tauri::command]
pub fn get_license_allowlist() -> LicenseAllowlist {
    let gate = crate::db::custom_apps::resolve_license_gate();
    LicenseAllowlist {
        enabled: gate.enabled,
        allowed: gate.allowed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn entry(id: &str) -> CustomAppEntry {
        entry_with_license(id, "MIT")
    }

    fn entry_with_license(id: &str, license: &str) -> CustomAppEntry {
        // owner/repo 由 id 派生，保证对齐（校验失败只可能来自被测字段本身）。
        let (owner, repo) = id.split_once('/').unwrap_or(("o", id));
        CustomAppEntry {
            id: id.to_string(),
            item: CatalogItem {
                id: id.to_string(),
                name: "Demo".to_string(),
                owner: owner.to_string(),
                repo: repo.to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: "demo".to_string(),
                description_en: None,
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                aliases: vec![],
                default_version: "v0.1.0".to_string(),
                license: license.to_string(),
                stars: 0,
                forks: 0,
                is_verified: false,
                homepage: Some("https://example.com".to_string()),
                identifiers: HashMap::new(),
                install_dirs: vec![],
                search_subdirs: vec![],
                publishers: vec![],
                platforms: Vec::new(),
            },
            status: "draft".to_string(),
            pr_url: None,
            created_at: 1,
            updated_at: 2,
            archived: false,
        }
    }

    fn strict_gate() -> LicenseGateConfig {
        LicenseGateConfig::default()
    }

    #[test]
    fn license_allowlist_mirrors_compiled_gate() {
        // ADR-0018 唯一源头：只读命令返回编译时门禁（默认开 + 37 项全量）。
        let allowlist = get_license_allowlist();
        assert!(allowlist.enabled);
        assert_eq!(allowlist.allowed.len(), 37);
        assert_eq!(allowlist.allowed.first().map(String::as_str), Some("MIT"));
        assert!(allowlist.allowed.iter().any(|s| s == "GPL-3.0"));
    }

    #[test]
    fn pr_url_carries_canonical_id_and_payload() {
        let url = build_catalog_pr_url(&entry("o/r"));
        assert!(url.starts_with(CATALOG_REPO_ISSUES_URL));
        // 标题/正文均经 URL 编码，canonical id 与关键字段可还原。
        assert!(url.contains("o%2Fr"));
        assert!(url.contains("MIT"));
        assert!(url.contains("payload_json"));
    }

    #[test]
    fn single_pr_url_matches_legacy_alias_and_carries_check_note() {
        let e = entry("o/r");
        assert_eq!(build_catalog_pr_url(&e), build_single_pr_url(&e));
        let url = build_single_pr_url(&e);
        assert!(url.starts_with(CATALOG_REPO_ISSUES_URL));
        // 校验说明随正文预填（URL 编码后仍可还原关键字）。
        assert!(url.contains("validate_custom_item"));
        // 静默门禁：正文无门禁注记行（审计只走日志）。
        assert!(!url.contains("门禁"));
    }

    #[test]
    fn batch_pr_url_merges_ids_into_one_json_array() {
        let url = build_batch_pr_url(&[entry("o/a"), entry("o/b")], &strict_gate());
        assert!(url.starts_with(CATALOG_REPO_ISSUES_URL));
        assert!(url.contains("o%2Fa"));
        assert!(url.contains("o%2Fb"));
        assert!(url.contains("payload_json"));
        assert!(url.contains("validate_custom_item"));
    }

    #[test]
    fn batch_pr_url_empty_does_not_panic() {
        let url = build_batch_pr_url(&[], &strict_gate());
        assert!(url.starts_with(CATALOG_REPO_ISSUES_URL));
    }

    #[test]
    fn batch_checklist_marks_opensource_as_failed() {
        // 批量清单逐条走提交档：占位 license 标校验失败（D1 门禁在提交时）。
        let url = build_batch_pr_url(
            &[
                entry_with_license("o/a", "MIT"),
                entry_with_license("o/b", "OpenSource"),
            ],
            &strict_gate(),
        );
        let decoded = urlencoding::decode(&url)
            .expect("prefill url decodes")
            .into_owned();
        assert!(decoded.contains("`o/a`：校验通过"));
        assert!(decoded.contains("`o/b`：校验失败"));
        assert!(decoded.contains("OSI"));
    }
}
