//! 本地自维护草稿与收录申请 commands：草稿 CRUD、本地收录与 Issue 预填。
//! 草稿 `is_verified` 恒为 `false`；仅已收录条目允许进入 Issue 预填流程。

use crate::config::LicenseGateConfig;
use crate::db::custom_apps::{ValidateMode, CUSTOM_APP_STATUS_SUBMITTED};
use crate::db::CustomAppEntry;
use crate::github::models::CatalogItem;
use crate::AppState;
use tauri::State;

/// 生态清单仓库收录申请 Issue 页。
pub const CATALOG_REPO_ISSUES_URL: &str =
    "https://github.com/superMC5657/z-store-catalog/issues/new";

/// 预填正文中的本地校验说明。
const PR_BODY_CHECK_NOTE: &str =
    "本地校验：已通过提交档 `validate_custom_item(strict)`（canonical id / 必填字段 / OSI 协议），payload 见下方 JSON。";

/// 生成单条收录申请 Issue 预填链接。
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
        payload = pr_single_payload_json(&normalize_pr_item(item)),
    );
    format!(
        "{}?title={}&body={}",
        CATALOG_REPO_ISSUES_URL,
        urlencoding::encode(&title),
        urlencoding::encode(&body),
    )
}

/// 规范化 Issue 预填条目：裁剪空字段、剔除启发式本地字段并置 `is_verified = true`（不改磁盘草稿）。
fn normalize_pr_item(item: &CatalogItem) -> CatalogItem {
    let mut out = item.clone();
    if out
        .homepage
        .as_deref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(false)
    {
        out.homepage = None;
    }
    if out
        .description_en
        .as_deref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(false)
    {
        out.description_en = None;
    }
    // Prefill-only: maintainer merges as verified upstream; local store keeps false.
    out.is_verified = true;
    // Template has no heuristic dirs: drop prefilled guesses outright.
    out.install_dirs.clear();
    out.search_subdirs.clear();
    out.publishers.clear();
    // Upstream curation date is maintained by catalog repo maintainers upon merge;
    // strip projected local added_at so it never leaks into Issue/PR payloads.
    out.added_at = None;
    out
}

/// identifiers 标准键优先级（与 catalog.json 磁盘顺序对齐）。
fn pr_identifier_rank(key: &str) -> usize {
    match key {
        "windows" => 0,
        "linux" => 1,
        "macos" => 2,
        "android" => 3,
        "ios" => 4,
        _ => 99,
    }
}

fn pr_json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s.replace('"', "\\\"")))
}

fn pr_inline_str_array(arr: &[String]) -> String {
    let parts: Vec<String> = arr.iter().map(|s| pr_json_string(s)).collect();
    format!("[{}]", parts.join(", "))
}

fn pr_ordered_identifier_keys(map: &std::collections::HashMap<String, Vec<String>>) -> Vec<String> {
    let mut keys: Vec<String> = map
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, _)| k.clone())
        .collect();
    keys.sort_by(|a, b| {
        pr_identifier_rank(a)
            .cmp(&pr_identifier_rank(b))
            .then_with(|| a.cmp(b))
    });
    keys
}

/// 格式化单条 Issue payload JSON（2 空格缩进，短字符串数组内联，省略空字段）。
fn pr_single_payload_json(item: &CatalogItem) -> String {
    pr_item_json_with_indent(item, "")
}

fn pr_item_json_with_indent(item: &CatalogItem, base: &str) -> String {
    let field = format!("{base}  ");
    let inner = format!("{base}    ");
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("{base}{{"));
    // 按清单标准字段顺序输出。
    let mut fields: Vec<String> = Vec::new();
    fields.push(format!(
        "{field}\"id\": {comma}",
        field = field,
        comma = pr_json_string(&item.id)
    ));
    fields.push(format!(
        "{field}\"name\": {v}",
        field = field,
        v = pr_json_string(&item.name)
    ));
    fields.push(format!(
        "{field}\"owner\": {v}",
        field = field,
        v = pr_json_string(&item.owner)
    ));
    fields.push(format!(
        "{field}\"repo\": {v}",
        field = field,
        v = pr_json_string(&item.repo)
    ));
    if !item.icon.trim().is_empty() {
        fields.push(format!(
            "{field}\"icon\": {v}",
            field = field,
            v = pr_json_string(&item.icon)
        ));
    }
    if !item.icon_bg.trim().is_empty() {
        fields.push(format!(
            "{field}\"icon_bg\": {v}",
            field = field,
            v = pr_json_string(&item.icon_bg)
        ));
    }
    if !item.description.trim().is_empty() {
        fields.push(format!(
            "{field}\"description\": {v}",
            field = field,
            v = pr_json_string(&item.description)
        ));
    }
    if let Some(desc_en) = item
        .description_en
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        fields.push(format!(
            "{field}\"description_en\": {v}",
            field = field,
            v = pr_json_string(desc_en)
        ));
    }
    fields.push(format!(
        "{field}\"category\": {v}",
        field = field,
        v = pr_json_string(&item.category)
    ));
    fields.push(format!(
        "{field}\"category_name\": {v}",
        field = field,
        v = pr_json_string(&item.category_name)
    ));
    if !item.aliases.is_empty() {
        fields.push(format!(
            "{field}\"aliases\": {v}",
            field = field,
            v = pr_inline_str_array(&item.aliases)
        ));
    }
    fields.push(format!(
        "{field}\"default_version\": {v}",
        field = field,
        v = pr_json_string(&item.default_version)
    ));
    fields.push(format!(
        "{field}\"license\": {v}",
        field = field,
        v = pr_json_string(&item.license)
    ));
    if item.stars != 0 {
        fields.push(format!(
            "{field}\"stars\": {v}",
            field = field,
            v = item.stars
        ));
    }
    if item.forks != 0 {
        fields.push(format!(
            "{field}\"forks\": {v}",
            field = field,
            v = item.forks
        ));
    }
    fields.push(format!(
        "{field}\"is_verified\": {v}",
        field = field,
        v = if item.is_verified { "true" } else { "false" }
    ));
    if let Some(homepage) = item.homepage.as_deref().filter(|s| !s.trim().is_empty()) {
        fields.push(format!(
            "{field}\"homepage\": {v}",
            field = field,
            v = pr_json_string(homepage)
        ));
    }
    if !item.platforms.is_empty() {
        fields.push(format!(
            "{field}\"platforms\": {v}",
            field = field,
            v = pr_inline_str_array(&item.platforms)
        ));
    }
    let id_keys = pr_ordered_identifier_keys(&item.identifiers);
    if !id_keys.is_empty() {
        let mut block: Vec<String> = Vec::new();
        block.push(format!("{field}\"identifiers\": {{"));
        for (i, k) in id_keys.iter().enumerate() {
            let comma = if i + 1 < id_keys.len() { "," } else { "" };
            let arr = item.identifiers.get(k).cloned().unwrap_or_default();
            block.push(format!(
                "{inner}{k}: {v}{comma}",
                inner = inner,
                k = pr_json_string(k),
                v = pr_inline_str_array(&arr),
                comma = comma
            ));
        }
        block.push(format!("{field}}}"));
        fields.push(block.join("\n"));
    }
    for (i, f) in fields.iter().enumerate() {
        let comma = if i + 1 < fields.len() { "," } else { "" };
        lines.push(format!("{f}{comma}"));
    }
    lines.push(format!("{base}}}"));
    lines.join("\n")
}

pub fn ensure_collected_for_pr(entry: &CustomAppEntry) -> Result<(), String> {
    if entry.status == CUSTOM_APP_STATUS_SUBMITTED {
        return Err(format!("已提交行不可重复提交: {}", entry.id));
    }
    if !crate::db::custom_apps::is_collected_status(&entry.status) {
        return Err("须先收录进本地再提交 Issue".to_string());
    }
    Ok(())
}

/// 过滤本地库合并视图条目（仅未归档的已收录及已提交行）。
#[cfg(test)]
pub fn collected_overlay_items(entries: Vec<CustomAppEntry>) -> Vec<CatalogItem> {
    entries
        .into_iter()
        .filter(|e| crate::db::custom_apps::is_local_library_status(&e.status) && !e.archived)
        .map(|e| e.item)
        .collect()
}

/// 重载本地收录 overlay 并回填收藏/关注的收录标记（复用调用方 `db` 锁）。
fn sync_catalog_overlay(state: &AppState, db: &crate::db::Database) {
    state.catalog.sync_collected_from_db(db);
    crate::commands::history::backfill_cataloged_flags_in(db);
}

fn sync_custom_app_cache_and_cycle(db: &crate::db::Database, item: &CatalogItem) {
    let clean_id = crate::forge::canonical_lookup_id(&item.id);
    let icon_trimmed = item.icon.trim();
    if !icon_trimmed.is_empty() {
        let mut cycle = db
            .get_icon_cycle(&clean_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| crate::db::AppIconCycle::new(&clean_id, &item.owner, &item.repo));
        cycle.is_cataloged = true;
        if cycle.l1_url != icon_trimmed {
            cycle.cache_file = String::new();
        }
        cycle.l1_url = icon_trimmed.to_string();
        cycle.selected_url = icon_trimmed.to_string();
        cycle.level = 1;
        cycle.pinned = false;
        let _ = db.upsert_icon_cycle(&cycle);

        let _ = db.sync_detail_icon(&clean_id, icon_trimmed);
    }
}

fn reset_custom_app_cycle_uncataloged(db: &crate::db::Database, id: &str) {
    let clean_id = crate::forge::canonical_lookup_id(id);
    if let Ok(Some(mut cycle)) = db.get_icon_cycle(&clean_id) {
        cycle.is_cataloged = false;
        cycle.l1_url = String::new();
        cycle.cache_file = String::new();
        let _ = db.upsert_icon_cycle(&cycle);
    }
}

/// 草稿列表（默认仅未归档；`include_archived=true` 含转正归档行）。
#[tauri::command(rename_all = "camelCase")]
pub fn list_custom_apps(
    state: State<'_, AppState>,
    include_archived: Option<bool>,
) -> crate::AppResult<Vec<CustomAppEntry>> {
    let db = state.db().map_err(crate::AppError::from)?;
    Ok(db.list_custom_apps(include_archived.unwrap_or(false))?)
}

/// 暂存本地草稿（宽松校验，强制 `is_verified = false`）。
/// 新建行默认 `status=draft`；已存在行保留原状态与 `pr_url`。
#[tauri::command]
pub fn save_custom_app(
    state: State<'_, AppState>,
    item: CatalogItem,
) -> crate::AppResult<CustomAppEntry> {
    let canonical = crate::db::custom_apps::validate_custom_item(
        &item,
        ValidateMode::DraftLenient,
        &crate::db::custom_apps::resolve_license_gate(),
    )
    .map_err(crate::AppError::new)?;
    let mut normalized = item;
    normalized.id = canonical;
    normalized.is_verified = false;
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.upsert_custom_app_payload(&normalized)?;
    if crate::db::custom_apps::is_local_library_status(&entry.status) {
        sync_custom_app_cache_and_cycle(&db, &entry.item);
    }
    sync_catalog_overlay(&state, &db);
    Ok(entry)
}

/// 删除指定草稿或收录条目（返回是否命中）。
#[tauri::command]
pub fn delete_custom_app(state: State<'_, AppState>, id: String) -> crate::AppResult<bool> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let hit = db.delete_custom_app(&key)?;
    if hit {
        reset_custom_app_cycle_uncataloged(&db, &key);
    }
    sync_catalog_overlay(&state, &db);
    Ok(hit)
}

/// 将草稿标记为本地已收录（严格校验，`is_verified` 保持 `false`）。
#[tauri::command(rename_all = "camelCase")]
pub fn collect_local_app(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.mark_custom_app_collected(&key)?;
    sync_custom_app_cache_and_cycle(&db, &entry.item);
    // 已收录条目由目录视图承接，清理单仓富卡旧缓存。
    let _ = db.purge_cataloged_repo_cards();
    sync_catalog_overlay(&state, &db);
    Ok(entry)
}

/// 将本地已收录条目退回草稿（仅未归档的已收录行可退回）。
#[tauri::command(rename_all = "camelCase")]
pub fn revert_collected_to_draft(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.revert_collected_to_draft(&key)?;
    reset_custom_app_cycle_uncataloged(&db, &key);
    sync_catalog_overlay(&state, &db);
    Ok(entry)
}

/// 撤回已提交标记：`submitted` → `collected` 并清空 `pr_url`。
#[tauri::command(rename_all = "camelCase")]
pub fn withdraw_submitted(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.withdraw_submitted(&key)?;
    sync_catalog_overlay(&state, &db);
    Ok(entry)
}

/// 标记为已提交并记录 `pr_url`（仅允许 `collected` 行，已归档或已提交行拒绝）。
#[tauri::command(rename_all = "camelCase")]
pub fn mark_submitted(
    state: State<'_, AppState>,
    id: String,
    pr_url: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db
        .get_custom_app(&key)?
        .ok_or_else(|| crate::AppError::new(format!("草稿不存在: {}", key)))?;
    ensure_collected_for_pr(&entry).map_err(crate::AppError::new)?;
    let entry = db.mark_custom_app_submitted(&key, &pr_url)?;
    sync_catalog_overlay(&state, &db);
    Ok(entry)
}

/// 校验并加载待生成 Issue 预填的已收录条目。
fn load_pr_entry(
    db: &crate::db::Database,
    id: &str,
    gate: &LicenseGateConfig,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(id);
    let entry = db
        .get_custom_app(&key)?
        .ok_or_else(|| crate::AppError::new(format!("草稿不存在: {}", key)))?;
    ensure_collected_for_pr(&entry).map_err(crate::AppError::new)?;
    crate::db::custom_apps::validate_custom_item(&entry.item, ValidateMode::SubmitStrict, gate)
        .map_err(|reason| {
            crate::AppError::new(format!("草稿 {} 提交校验未通过：{}", key, reason))
        })?;
    Ok(entry)
}

/// 生成单条收录申请 Issue 预填链接（仅已收录且通过严格校验的条目可用）。
#[tauri::command]
pub fn get_custom_app_pr_url(state: State<'_, AppState>, id: String) -> crate::AppResult<String> {
    let db = state.db().map_err(crate::AppError::from)?;
    let gate = crate::db::custom_apps::resolve_license_gate();
    let entry = load_pr_entry(&db, &id, &gate)?;
    Ok(build_single_pr_url(&entry))
}

/// 生成单条收录申请 Issue 的 JSON payload（校验口径与预填链接一致）。
#[tauri::command]
pub fn get_custom_app_pr_payload(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<String> {
    let db = state.db().map_err(crate::AppError::from)?;
    let gate = crate::db::custom_apps::resolve_license_gate();
    let entry = load_pr_entry(&db, &id, &gate)?;
    Ok(pr_single_payload_json(&normalize_pr_item(&entry.item)))
}

/// 开源许可白名单查询结果（编译时配置唯一源头）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LicenseAllowlist {
    pub enabled: bool,
    pub allowed: Vec<String>,
}

/// 查询编译时开源许可白名单与门禁开关。
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
    use crate::db::custom_apps::CUSTOM_APP_STATUS_COLLECTED;
    use std::collections::HashMap;

    fn entry(id: &str) -> CustomAppEntry {
        entry_with_license(id, "MIT")
    }

    fn entry_with_license(id: &str, license: &str) -> CustomAppEntry {
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
                added_at: None,
                license: license.to_string(),
                stars: 0,
                forks: 0,
                is_verified: false,
                homepage: Some("https://example.com".to_string()),
                install_dirs: vec![],
                search_subdirs: vec![],
                publishers: vec![],
                platforms: Vec::new(),
                identifiers: HashMap::new(),
            },
            status: "draft".to_string(),
            pr_url: None,
            created_at: 1,
            updated_at: 2,
            archived: false,
        }
    }

    #[test]
    fn license_allowlist_mirrors_compiled_gate() {
        let allowlist = get_license_allowlist();
        assert!(allowlist.enabled);
        assert_eq!(allowlist.allowed.len(), 37);
        assert_eq!(allowlist.allowed.first().map(String::as_str), Some("MIT"));
        assert!(allowlist.allowed.iter().any(|s| s == "GPL-3.0"));
    }

    #[test]
    fn pr_url_carries_canonical_id_and_payload() {
        let url = build_single_pr_url(&entry("o/r"));
        assert!(url.starts_with(CATALOG_REPO_ISSUES_URL));
        // 标题/正文均经 URL 编码，canonical id 与关键字段可还原。
        assert!(url.contains("o%2Fr"));
        assert!(url.contains("MIT"));
        assert!(url.contains("payload_json"));
    }

    #[test]
    fn single_pr_url_carries_check_note() {
        let url = build_single_pr_url(&entry("o/r"));
        assert!(url.starts_with(CATALOG_REPO_ISSUES_URL));
        // 校验说明随正文预填（URL 编码后仍可还原关键字）。
        assert!(url.contains("validate_custom_item"));
        // 静默门禁：正文无门禁注记行（审计只走日志）。
        assert!(!url.contains("门禁"));
    }

    #[test]
    fn pr_payload_marks_verified_true_while_stored_stays_false() {
        // Prefill body carries is_verified=true (matches catalog.json all-true);
        // stored entry payload stays false (local drafts never pose as verified).
        let e = entry("o/r");
        assert!(!e.item.is_verified);
        let decoded = urlencoding::decode(&build_single_pr_url(&e))
            .expect("prefill url decodes")
            .into_owned();
        assert!(decoded.contains("\"is_verified\": true"));
        assert!(!e.item.is_verified);
    }

    fn collected_entry(id: &str) -> CustomAppEntry {
        let mut e = entry(id);
        e.status = CUSTOM_APP_STATUS_COLLECTED.to_string();
        e
    }

    #[test]
    fn pr_gate_blocks_draft_and_submitted() {
        // Issue 门禁：draft 提示先收录；submitted 只读，明确文案（不走收录门禁）。
        let mut draft = entry("o/r");
        let err = ensure_collected_for_pr(&draft).expect_err("draft must be gated");
        assert_eq!(err, "须先收录进本地再提交 Issue");
        draft.status = CUSTOM_APP_STATUS_COLLECTED.to_string();
        assert!(ensure_collected_for_pr(&draft).is_ok());

        let mut submitted = entry("o/r");
        submitted.status = CUSTOM_APP_STATUS_SUBMITTED.to_string();
        let err = ensure_collected_for_pr(&submitted).expect_err("submitted must be gated");
        assert_eq!(err, "已提交行不可重复提交: o/r");
        submitted.status = CUSTOM_APP_STATUS_COLLECTED.to_string();
        assert!(ensure_collected_for_pr(&submitted).is_ok());
    }

    #[test]
    fn overlay_includes_collected_and_submitted_excludes_archived() {
        // overlay 含本地库成员：collected 系 + submitted；draft/archived 均被过滤。
        let mut archived = collected_entry("o/arch");
        archived.archived = true;
        let mut submitted = entry("o/sub");
        submitted.status = "submitted".to_string();
        let items = collected_overlay_items(vec![
            entry("o/draft"),
            submitted,
            collected_entry("o/keep"),
            archived,
        ]);
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.id == "o/keep"));
        assert!(items.iter().any(|i| i.id == "o/sub"));
        assert!(!items.iter().any(|i| i.id == "o/draft"));
        assert!(!items.iter().any(|i| i.id == "o/arch"));
    }

    #[test]
    fn overlay_accepts_legacy_local_collected_literal_and_rejects_draft() {
        // 兼容存储同义值 `local_collected`。
        let mut legacy = entry("o/legacy");
        legacy.status = "local_collected".to_string();
        let mut reverted = entry("o/reverted");
        reverted.status = "draft".to_string();
        let items =
            collected_overlay_items(vec![legacy, reverted.clone(), collected_entry("o/keep")]);
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.id == "o/legacy"));
        assert!(items.iter().any(|i| i.id == "o/keep"));
        assert!(!items.iter().any(|i| i.id == "o/reverted"));
        let mut gate_legacy = entry("o/legacy");
        gate_legacy.status = "local_collected".to_string();
        assert!(ensure_collected_for_pr(&gate_legacy).is_ok());
        assert!(ensure_collected_for_pr(&reverted).is_err());
    }

    fn full_entry(id: &str) -> CustomAppEntry {
        let mut e = entry(id);
        e.item.icon = "https://example.com/icon.png".to_string();
        e.item.icon_bg = crate::github::http::DEFAULT_ICON_BG.to_string();
        e.item.stars = 42;
        e.item.forks = 7;
        e.item.aliases = vec!["demo".to_string(), "o/r".to_string()];
        e.item.description_en = Some("demo en".to_string());
        e.item.platforms = vec![
            "windows".to_string(),
            "macos".to_string(),
            "linux".to_string(),
        ];
        let mut ids = HashMap::new();
        ids.insert(
            "macos".to_string(),
            vec!["Demo.app".to_string(), "demo".to_string()],
        );
        ids.insert("windows".to_string(), vec!["Demo.exe".to_string()]);
        ids.insert("linux".to_string(), vec!["demo".to_string()]);
        e.item.identifiers = ids;
        // 预填启发式猜测：Issue 模板直接丢弃，不进 payload。
        e.item.install_dirs = vec!["r".to_string()];
        e.item.search_subdirs = vec!["bin".to_string()];
        e.item.publishers = vec!["O".to_string()];
        e
    }

    #[test]
    fn pr_payload_matches_vscodium_template_style() {
        // 验证字段顺序、2 空格缩进与数组内联格式，且剔除启发式字段。
        let payload = pr_single_payload_json(&normalize_pr_item(&full_entry("o/r").item));
        let v: serde_json::Value = serde_json::from_str(&payload).expect("payload parses");
        assert!(v.get("install_dirs").is_none());
        assert!(v.get("search_subdirs").is_none());
        assert!(v.get("publishers").is_none());
        assert_eq!(v.get("is_verified"), Some(&serde_json::Value::Bool(true)));
        // 非空字符串数组单行内联：同一行内含左右括号，无内部换行。
        for key in ["aliases", "platforms"] {
            let line = payload
                .lines()
                .find(|l| l.trim_start().starts_with(&format!("\"{key}\":")))
                .unwrap_or_else(|| panic!("{key} line exists"));
            assert!(line.contains('[') && line.contains(']'), "{key} inline");
        }
        // identifiers 对象展开：外层换行，内层数组仍内联。
        assert!(payload.contains("\"identifiers\": {"));
        let win_line = payload
            .lines()
            .find(|l| l.trim_start().starts_with("\"windows\":"))
            .expect("windows line exists");
        assert!(win_line.contains('[') && win_line.contains(']'));
        // 空数组/空对象直接省略（而非 [] 换行）。
        let empty_payload = pr_single_payload_json(&normalize_pr_item(&entry("o/r").item));
        let empty_v: serde_json::Value =
            serde_json::from_str(&empty_payload).expect("empty payload parses");
        assert!(empty_v.get("aliases").is_none());
        assert!(empty_v.get("platforms").is_none());
        assert!(empty_v.get("identifiers").is_none());
        assert!(!empty_payload.contains("\"aliases\""));
        assert!(!empty_payload.contains("\"platforms\""));
        assert!(!empty_payload.contains("\"identifiers\""));
        // Empty-string fields omitted (same as frontend toOrderedPrPayload): empty icon/icon_bg emit nothing.
        assert!(empty_v.get("icon").is_none());
        assert!(empty_v.get("icon_bg").is_none());
        assert!(!empty_payload.contains("\"icon\""));
        assert!(!empty_payload.contains("\"icon_bg\""));
        // Zero stars/forks omitted (no finite truthy value).
        assert!(empty_v.get("stars").is_none());
        assert!(empty_v.get("forks").is_none());
        assert!(!empty_payload.contains("\"stars\""));
        assert!(!empty_payload.contains("\"forks\""));
        // Non-empty description keeps.
        assert!(empty_v.get("description").is_some());
        let order = [
            "\"id\"",
            "\"name\"",
            "\"owner\"",
            "\"repo\"",
            "\"icon\"",
            "\"icon_bg\"",
            "\"description\"",
            "\"category\"",
            "\"category_name\"",
            "\"aliases\"",
            "\"default_version\"",
            "\"license\"",
            "\"stars\"",
            "\"forks\"",
            "\"is_verified\"",
            "\"homepage\"",
            "\"platforms\"",
            "\"identifiers\"",
        ];
        let mut last = 0usize;
        for key in order {
            let pos = payload
                .find(key)
                .unwrap_or_else(|| panic!("{key} in payload"));
            assert!(pos >= last, "{key} keeps standard order");
            last = pos;
        }
        // identifiers 内键按标准优先级 windows→linux→macos（限定在 identifiers 块内，避免 platforms 行干扰）。
        let ids_start = payload
            .find("\"identifiers\": {")
            .expect("identifiers block");
        let ids_block = &payload[ids_start..];
        let win = ids_block.find("\"windows\"").expect("windows key");
        let lin = ids_block.find("\"linux\"").expect("linux key");
        let mac = ids_block.find("\"macos\"").expect("macos key");
        assert!(win < lin && lin < mac);
    }

    #[test]
    fn normalize_pr_item_strips_projected_added_at() {
        let mut item = full_entry("o/r").item;
        item.added_at = Some("2026-10-23".to_string());
        let normalized = normalize_pr_item(&item);
        assert_eq!(normalized.added_at, None);
        let payload = pr_single_payload_json(&normalized);
        assert!(!payload.contains("added_at"));
    }
}
