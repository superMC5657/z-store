//! 本地自维护草稿 commands（ADR-0017）：CRUD + 转正 + 合并视图 + 预填 Issue 链路。
//!
//! - `list_custom_apps` / `save_custom_app` / `delete_custom_app` /
//!   `collect_local_app`（本地收录唯一命令面，草稿链路与视图共用） /
//!   `revert_collected_to_draft`（规范名） / `withdraw_submitted` /
//!   `mark_submitted` / `retire_on_sync` / `get_merged_catalog_view` /
//!   `get_custom_app_pr_url`；
//! - 二次确认由前端做，后端 `delete_custom_app` 直接删；
//! - `save_custom_app` 暂存档校验（`DraftLenient`，草稿允许不完整）+ `is_verified` 强制
//!   false（草稿永不冒充已验证收录）；收录档（`CollectStrict`，与 `SubmitStrict` 同口径）
//!   经 `collect_local_app` 置 `status=collected`，Issue 链路首行门禁仅收录行放行，
//!   提交档全校验（`SubmitStrict`，D1 不破）保留二次校验。

use crate::config::LicenseGateConfig;
use crate::db::custom_apps::{
    ValidateMode, CUSTOM_APP_STATUS_SUBMITTED,
};
use crate::db::{CustomAppEntry, GraduationNotice};
use crate::github::models::CatalogItem;
use crate::github::CatalogService;
use crate::AppState;
use tauri::State;

/// 独立生态清单仓库收录申请预填页（ADR-0009）：收录 Issue 目标。
/// 纯 URL 打开即可用，无需 token/OAuth（Issue-link entry）。
pub const CATALOG_REPO_ISSUES_URL: &str =
    "https://github.com/superMC5657/z-store-catalog/issues/new";

/// 本地校验说明（预填正文共用）：取链接前已过提交档 `validate_custom_item(strict)` 全校验。
const PR_BODY_CHECK_NOTE: &str =
    "本地校验：已通过提交档 `validate_custom_item(strict)`（canonical id / 必填字段 / OSI 协议），payload 见下方 JSON。";

/// 单条收录申请预填链接（纯函数，可单测）：标题带 canonical id，正文携带关键字段 +
/// 完整 JSON + 校验说明，用户在浏览器中确认后提交 Issue → maintainer 转 PR（预填 Issue 链路）。
/// 首版单条单 Issue（Q6=A/Q8=A/Q10=C 分期）；无需 token，纯 URL 打开。
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

/// 收录申请预填链接（纯函数，可单测）：`build_single_pr_url` same-shape entry(same semantics)。
pub fn build_catalog_pr_url(entry: &CustomAppEntry) -> String {
    build_single_pr_url(entry)
}

/// 批量收录申请预填链接（纯函数，可单测，二期开关）：
/// 选中多条合并为一个 JSON 数组，经一个预填 URL 提交（批量合一 Issue）。
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
    let items: Vec<CatalogItem> = entries.iter().map(|e| normalize_pr_item(&e.item)).collect();
    let payload = pr_batch_payload_json(&items);
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

/// Issue 提交前置门禁（纯函数，可单测）：仅 `status==collected` 行允许走 Issue 链路；
/// 草稿行首行即拦（提示先收录），已提交行只读（明确文案，不走收录门禁）。
/// `status`/`pr_url` 经 `list_custom_apps`/`get` 透出，无需新增轮询。
/// Issue payload normalize: trim-empty homepage/description_en to None so
/// they are omitted like catalog.json; install_dirs/search_subdirs/publishers
/// are prefill heuristics and dropped outright to match the vscodium template
/// (homepage → platforms → identifiers); field order is enforced by the manual
/// formatter below, not by struct order. Preset is_verified=true on the
/// prefill clone only (matches catalog.json all-true); stored payload on disk
/// stays false, batch shares this helper.
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

fn pr_ordered_identifier_keys(
    map: &std::collections::HashMap<String, Vec<String>>,
) -> Vec<String> {
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

/// 单条 Issue payload JSON（模板风格 2 空格：字符串数组单行内联，
/// identifiers 对象展开且内层数组内联，空数组/空对象直接省略）。
fn pr_single_payload_json(item: &CatalogItem) -> String {
    pr_item_json_with_indent(item, "")
}

/// 批量 Issue payload JSON 数组（内层对象同单条模板风格，整体 2 空格）。
fn pr_batch_payload_json(items: &[CatalogItem]) -> String {
    if items.is_empty() {
        return "[]".to_string();
    }
    let bodies: Vec<String> = items
        .iter()
        .map(|it| pr_item_json_with_indent(it, "  "))
        .collect();
    format!("[\n{}\n]", bodies.join(",\n"))
}

fn pr_item_json_with_indent(item: &CatalogItem, base: &str) -> String {
    let field = format!("{base}  ");
    let inner = format!("{base}    ");
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("{base}{{"));
    // 标准顺序：id → … → description_en? → category → … → aliases? →
    // default_version → license → stars → forks → is_verified → homepage? →
    // platforms? → identifiers?（install_dirs/search_subdirs/publishers 已丢弃）。
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
    if let Some(desc_en) = item.description_en.as_deref().filter(|s| !s.trim().is_empty()) {
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
        fields.push(format!("{field}\"stars\": {v}", field = field, v = item.stars));
    }
    if item.forks != 0 {
        fields.push(format!("{field}\"forks\": {v}", field = field, v = item.forks));
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

/// 本地库 overlay 输入过滤（纯函数，可单测）：未归档的 collected 系 + `submitted` 行进入
/// 合并视图（远端优先去重由 `merge_catalog_overlay_view` 执行，on-disk residual `local_collected` 字面）。
pub fn collected_overlay_items(entries: Vec<CustomAppEntry>) -> Vec<CatalogItem> {
    entries
        .into_iter()
        .filter(|e| crate::db::custom_apps::is_local_library_status(&e.status) && !e.archived)
        .map(|e| e.item)
        .collect()
}

/// 本地收录变更后的目录同步：重读 overlay（远端优先合并视图立即生效）
/// 并回填收藏/关注收录标记（写时口径与启动回填同源）。
fn sync_catalog_overlay(state: &AppState) {
    if let Ok(db) = state.db() {
        state.catalog.sync_collected_from_db(&db);
    }
    crate::commands::history::backfill_cataloged_flags(state);
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
    let entry = db.upsert_custom_app_payload(&normalized)?;
    drop(db);
    sync_catalog_overlay(&state);
    Ok(entry)
}

/// 草稿删除（后端直接删，二次确认由前端做）：返回是否命中。
/// 未归档 `submitted` 可删；已归档行同样直接删（转正归档手动清理，现有语义不变）。
#[tauri::command]
pub fn delete_custom_app(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<bool> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let hit = db.delete_custom_app(&key)?;
    drop(db);
    sync_catalog_overlay(&state);
    Ok(hit)
}

/// 本地收录：`status=collected`（收录档全校验，`is_verified=false` 入库约束保持）。
/// 未收录行经此进入本地精选（可搜可装），Issue 链路前置门禁要求先收录；
/// 草稿链路与视图直调共用此唯一命令面。
#[tauri::command(rename_all = "camelCase")]
pub fn collect_local_app(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.mark_custom_app_collected(&key)?;
    drop(db);
    sync_catalog_overlay(&state);
    Ok(entry)
}

/// 本地收录退回草稿：`status=collected` → `draft`（未归档限定；已提交/已归档不退回，只读）。
/// `pr_url` 清空，`is_verified=false` 保持（草稿永不冒充已验证）。
#[tauri::command(rename_all = "camelCase")]
pub fn revert_collected_to_draft(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.revert_collected_to_draft(&key)?;
    drop(db);
    sync_catalog_overlay(&state);
    Ok(entry)
}

/// 标记为未提交：`submitted` → `collected`，`pr_url` 清空，payload 不变；Issue 需在 GitHub 自行关闭。
/// 已归档行与未提交行拒绝（分别提示归档、仅已提交行可标记为未提交）。
#[tauri::command(rename_all = "camelCase")]
pub fn withdraw_submitted(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.withdraw_submitted(&key)?;
    drop(db);
    sync_catalog_overlay(&state);
    Ok(entry)
}

/// 标记已提交：`status=submitted` + 落 `pr_url`；已转正归档行拒绝。
/// 首行收录门禁：仅 `status==collected` 行允许提交 Issue（否则 `须先收录进本地再提交 Issue`）；
/// 已提交行只读：二次 `mark` 明确拒绝（`已提交行不可重复提交`）；
/// 提交档全校验在 db 层保留二次校验（占位 license 草稿被拦，先补真实 SPDX 再提交）。
#[tauri::command(rename_all = "camelCase")]
pub fn mark_submitted(
    state: State<'_, AppState>,
    id: String,
    pr_url: String,
) -> crate::AppResult<CustomAppEntry> {
    let key = crate::forge::canonical_lookup_id(&id);
    let db = state.db().map_err(crate::AppError::from)?;
    let entry = db.get_custom_app(&key)?.ok_or_else(|| {
        crate::AppError::new(format!("草稿不存在: {}", key))
    })?;
    ensure_collected_for_pr(&entry).map_err(crate::AppError::new)?;
    let entry = db.mark_custom_app_submitted(&key, &pr_url)?;
    drop(db);
    sync_catalog_overlay(&state);
    Ok(entry)
}

/// 转正退役：远端 id 集合命中未归档草稿即 `archived=1`，返回转正提示。
/// `draft`/`collected`/`submitted` 未归档行均命中归档（`submitted` 转正同样归档）；
/// `remote_ids=None` 时以当前内存目录 id 为准（`sync_catalog` 成功路径会自动调用）。
#[tauri::command(rename_all = "camelCase")]
pub fn retire_on_sync(
    state: State<'_, AppState>,
    remote_ids: Option<Vec<String>>,
) -> crate::AppResult<Vec<GraduationNotice>> {
    let ids: Vec<String> = match remote_ids {
        Some(v) => v,
        None => state
            .catalog
            .get_remote_catalog_items()
            .into_iter()
            .map(|i| i.id)
            .collect(),
    };
    let db = state.db().map_err(crate::AppError::from)?;
    let notices = db.retire_custom_apps_on_sync(&ids)?;
    drop(db);
    sync_catalog_overlay(&state);
    Ok(notices)
}

/// 合并目录视图：内存远端目录 + 本地库 overlay（未归档的 collected 系 + `submitted`，
/// 远端优先去重，`is_cataloged` 恒 true，来源经 `source` 区分 `remote`/`custom`）。
#[tauri::command]
pub fn get_merged_catalog_view(
    state: State<'_, AppState>,
) -> crate::AppResult<Vec<crate::github::catalog_service::MergedCatalogEntry>> {
    let remote = state.catalog.get_remote_catalog_items();
    let custom = state.catalog.get_collected_items();
    Ok(CatalogService::merge_catalog_overlay_view(
        &remote, &custom,
    ))
}

/// Issue 链路通用取件（单条）：canonical 归一 → 取行 → 收录门禁 → 提交档二次全校验。
/// 四个 Issue 入口（单条/批量 × URL/payload）共用此门禁。
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

/// 批量 Issue 链路通用取件：逐条同口径门禁，任一条缺席/未收录/校验不过即整批拒绝，
/// 不静默丢条（错误已带 id，指到待补字段）。
fn load_pr_entries(
    db: &crate::db::Database,
    ids: &[String],
    gate: &LicenseGateConfig,
) -> crate::AppResult<Vec<CustomAppEntry>> {
    let mut entries = Vec::with_capacity(ids.len());
    for id in ids {
        entries.push(load_pr_entry(db, id, gate)?);
    }
    Ok(entries)
}

/// 收录申请预填链接：由草稿 payload 生成清单仓库 Issue 预填 URL（预填 Issue 链路入口）。
/// 首行收录门禁：仅 `status==collected` 行允许取链接；取链接前保留提交档二次全校验
///（占位 license 草稿在此被拦，前端指到 license 字段补 SPDX）。
#[tauri::command]
pub fn get_custom_app_pr_url(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<String> {
    let db = state.db().map_err(crate::AppError::from)?;
    let gate = crate::db::custom_apps::resolve_license_gate();
    let entry = load_pr_entry(&db, &id, &gate)?;
    Ok(build_single_pr_url(&entry))
}

/// 收录申请预填 payload（单条）：与 `get_custom_app_pr_url` 同口径门禁，
/// 只返回原始 JSON 文本（前端自行渲染/复制，不在前端拼模板）。
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

/// 批量收录申请预填链接（二期开关）：多条草稿合并为一个 JSON 数组，经一个预填 URL
/// 提交（批量合一 Issue）；任一条缺席即整批拒绝，不静默丢条；首行逐条收录门禁
///（任一条非 collected 即整批 `须先收录进本地再提交 Issue`）；任一条提交档二次校验不过
/// 即整批拒绝（附 id，指到待补字段）。
#[tauri::command]
pub fn get_custom_apps_batch_pr_url(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<String> {
    let db = state.db().map_err(crate::AppError::from)?;
    let gate = crate::db::custom_apps::resolve_license_gate();
    let entries = load_pr_entries(&db, &ids, &gate)?;
    Ok(build_batch_pr_url(&entries, &gate))
}

/// 批量收录申请预填 payload（原始 JSON 数组）：与 `get_custom_apps_batch_pr_url`
/// 同口径门禁，逐条归一化后按模板顺序输出。
#[tauri::command]
pub fn get_custom_apps_batch_pr_payload(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<String> {
    let db = state.db().map_err(crate::AppError::from)?;
    let gate = crate::db::custom_apps::resolve_license_gate();
    let entries = load_pr_entries(&db, &ids, &gate)?;
    let items: Vec<CatalogItem> = entries
        .iter()
        .map(|e| normalize_pr_item(&e.item))
        .collect();
    Ok(pr_batch_payload_json(&items))
}

/// 许可名单只读查询结果（ADR-0018）：名单唯一源头为后端编译时配置，
/// 前端 SubmitStrict 校验（提交/预填 Issue 前）经此拉取；加载失败前端放行暂存、
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
    use crate::db::custom_apps::CUSTOM_APP_STATUS_COLLECTED;
    use std::collections::HashMap;

    fn entry(id: &str) -> CustomAppEntry {
        entry_with_license(id, "MIT")
    }

    fn entry_with_license(id: &str, license: &str) -> CustomAppEntry {
        // CatalogItem literal follows catalog.json disk order, behavior unchanged.
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

        let batch = vec![entry("o/a"), entry("o/b")];
        let decoded = urlencoding::decode(&build_batch_pr_url(&batch, &strict_gate()))
            .expect("prefill url decodes")
            .into_owned();
        let payload = decoded
            .split("```json\n")
            .nth(1)
            .and_then(|s| s.split("\n```").next())
            .expect("payload block exists");
        let items: Vec<serde_json::Value> =
            serde_json::from_str(payload).expect("payload parses");
        assert_eq!(items.len(), 2);
        for v in &items {
            assert_eq!(v.get("is_verified"), Some(&serde_json::Value::Bool(true)));
        }
        assert!(batch.iter().all(|x| !x.item.is_verified));
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
        // On-disk residual `local_collected` 字面：同样进入 overlay；退回 draft 后不再进入。
        let mut legacy = entry("o/legacy");
        legacy.status = "local_collected".to_string();
        let mut reverted = entry("o/reverted");
        reverted.status = "draft".to_string();
        let items = collected_overlay_items(vec![
            legacy,
            reverted.clone(),
            collected_entry("o/keep"),
        ]);
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.id == "o/legacy"));
        assert!(items.iter().any(|i| i.id == "o/keep"));
        assert!(!items.iter().any(|i| i.id == "o/reverted"));
        // Issue 门禁同样on-disk literal。
        let mut gate_legacy = entry("o/legacy");
        gate_legacy.status = "local_collected".to_string();
        assert!(ensure_collected_for_pr(&gate_legacy).is_ok());
        assert!(ensure_collected_for_pr(&reverted).is_err());
    }

    fn pr_payload_of(url: &str) -> String {
        let decoded = urlencoding::decode(url)
            .expect("prefill url decodes")
            .into_owned();
        decoded
            .split("```json\n")
            .nth(1)
            .and_then(|s| s.split("\n```").next())
            .expect("payload block exists")
            .to_string()
    }

    fn full_entry(id: &str) -> CustomAppEntry {
        let mut e = entry(id);
        e.item.icon = "https://example.com/icon.png".to_string();
        e.item.icon_bg = crate::github::http::DEFAULT_ICON_BG.to_string();
        e.item.stars = 42;
        e.item.forks = 7;
        e.item.aliases = vec!["demo".to_string(), "o/r".to_string()];
        e.item.description_en = Some("demo en".to_string());
        e.item.platforms = vec!["windows".to_string(), "macos".to_string(), "linux".to_string()];
        let mut ids = HashMap::new();
        ids.insert("macos".to_string(), vec!["Demo.app".to_string(), "demo".to_string()]);
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
        // 模板（vscodium）：字段止于 homepage→platforms→identifiers，
        // 无 install_dirs/search_subdirs/publishers；aliases/platforms 单行内联，
        // identifiers 对象展开，整体 2 空格。
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
        // 字段顺序沿用既有标准顺序。
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
            let pos = payload.find(key).unwrap_or_else(|| panic!("{key} in payload"));
            assert!(pos >= last, "{key} keeps standard order");
            last = pos;
        }
        // identifiers 内键按标准优先级 windows→linux→macos（限定在 identifiers 块内，避免 platforms 行干扰）。
        let ids_start = payload.find("\"identifiers\": {").expect("identifiers block");
        let ids_block = &payload[ids_start..];
        let win = ids_block.find("\"windows\"").expect("windows key");
        let lin = ids_block.find("\"linux\"").expect("linux key");
        let mac = ids_block.find("\"macos\"").expect("macos key");
        assert!(win < lin && lin < mac);
    }

    #[test]
    fn pr_batch_payload_uses_same_template_style() {
        let items = vec![
            normalize_pr_item(&full_entry("o/a").item),
            normalize_pr_item(&full_entry("o/b").item),
        ];
        let payload = pr_batch_payload_json(&items);
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&payload).expect("batch payload parses");
        assert_eq!(parsed.len(), 2);
        for v in &parsed {
            assert!(v.get("install_dirs").is_none());
            assert!(v.get("search_subdirs").is_none());
            assert!(v.get("publishers").is_none());
            assert_eq!(v.get("is_verified"), Some(&serde_json::Value::Bool(true)));
        }
        // 批量内层对象同单条模板风格：数组内联、identifiers 展开。
        assert!(payload.contains("\"aliases\": ["));
        assert!(payload.contains("\"platforms\": ["));
        assert!(payload.contains("\"identifiers\": {"));
        // 空集合保持 [] 占位，不 panic。
        assert_eq!(pr_batch_payload_json(&[]), "[]");
        // 预填 URL 携带同风格 payload。
        let url = build_batch_pr_url(&[full_entry("o/a"), full_entry("o/b")], &strict_gate());
        let body_payload = pr_payload_of(&url);
        let body_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&body_payload).expect("url payload parses");
        assert_eq!(body_parsed.len(), 2);
        assert!(body_parsed[0].get("install_dirs").is_none());
    }
}
