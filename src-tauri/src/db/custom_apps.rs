//! 本地自维护草稿 overlay（ADR-0017）：`custom_apps` 表 CRUD + 校验 + 转正。
//!
//! - `id` 为 canonical 小写形态（仅 GitHub `owner/repo`，经 `canonical_app_id()` 归一）；`payload_json` 存完整 `CatalogItem`；
//! - `status=draft/submitted/collected`（已提交另存 `pr_url`；`collected` 与 `submitted`
//!   同为库内成员，可搜可装、与远端精选同行为；`collected` 是 Issue 提交前置门禁，
//!   `submitted` 表示 已提交 Issue）；`archived=1` 为转正归档标记
//!   （`sync_catalog` 命中 canonical id 即归档，权威交给远端）；
//! - 旧数据的 `local_collected` 字面与 `collected` 同义，收录判定/列表查询双匹配该残留值；
//! - 二次确认由前端做，后端 `delete` 直接删。

use super::{clean, now_secs, Database};
use crate::github::models::CatalogItem;
use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};

pub const CUSTOM_APP_STATUS_DRAFT: &str = "draft";
pub const CUSTOM_APP_STATUS_SUBMITTED: &str = "submitted";
/// 本地收录态：已收录进本地（可搜可装，与远端精选同行为；Issue 提交前置门禁）。
pub const CUSTOM_APP_STATUS_COLLECTED: &str = "collected";
/// Same value as `CUSTOM_APP_STATUS_COLLECTED` (kept for on-disk `local_collected` comparison).
pub const LOCAL_COLLECTED: &str = CUSTOM_APP_STATUS_COLLECTED;
/// Same value as `CUSTOM_APP_STATUS_COLLECTED` (full-name form, kept for on-disk comparison).
pub const CUSTOM_APP_STATUS_LOCAL_COLLECTED: &str = CUSTOM_APP_STATUS_COLLECTED;

/// 自维护草稿条目：DB 行 + 反序列化后的完整 `CatalogItem`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomAppEntry {
    pub id: String,
    pub item: CatalogItem,
    pub status: String,
    pub pr_url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
}

/// 转正提示：远端清单已收录、本地自动归档的草稿。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraduationNotice {
    pub id: String,
    pub message: String,
}

/// D1 纯粹开源：默认仅接受 OSI 认证开源协议（SPDX，大写归一后比对）。
/// 名单一源于 `crate::config::DEFAULT_LICENSE_ALLOWLIST`（ADR-0018 可配）；
/// 目录现存 `CC-BY-4.0`（非 OSI）、`NOASSERTION`/`Unknown` 默认一律拒绝。
use crate::config::LicenseGateConfig;

/// 协议归一（纯函数）：去空白 → 大写 → 空格/下划线折 `-` → 尾 `+` 视为或后续版本。
fn normalize_license(raw: &str) -> String {
    let mut s = raw
        .trim()
        .to_ascii_uppercase()
        .replace([' ', '_'], "-");
    if s.ends_with('+') {
        s.pop();
        if !s.ends_with("-OR-LATER") {
            s.push_str("-OR-LATER");
        }
    }
    s
}

/// 是否命中许可名单（ADR-0018）：两侧均经 `normalize_license` 归一后比对，
/// config 子集大小写/空格形态同样命中。
pub fn is_allowed_license(license: &str, allowed: &[String]) -> bool {
    let norm = normalize_license(license);
    allowed
        .iter()
        .any(|a| normalize_license(a) == norm)
}

/// 门禁唯一源（编译时 config）：行为只由 `config.toml [license_gate]` 在编译发行时
/// 确定；无运行时覆盖、无用户提醒，静默生效。
pub fn resolve_license_gate() -> LicenseGateConfig {
    crate::config::get_project_config().license_gate.clone()
}

/// 校验档位（Q8 三态）：草稿允许不完整（暂存即存），提交 Issue 时才强制全校验（D1 不破）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidateMode {
    /// 暂存档（`save_custom_app`）：仅校验 `id==canonical` 与 `owner/repo` 对齐；
    /// `license` 允许空 / `OpenSource` / `NOASSERTION` / 未知占位，`homepage` 允许空，
    /// `name`/`description`/`category` 允许不完整（Q8 草稿三态）。
    DraftLenient,
    /// 提交档（`mark_submitted` / 预填 Issue 链接）：既有全量——必填 +
    /// `homepage` http(s) + OSI 白名单（D1）。
    SubmitStrict,
    /// 收录档（`collect_custom_app`）：与 `SubmitStrict` 同口径——
    /// 必填 + `homepage` http(s) + OSI 白名单（D1），仅语义区分收录与提交。
    CollectStrict,
}

/// 草稿校验（纯函数，可单测）：通过返回 canonical id，失败返回中文原因。
/// - 两档共用：仅支持 GitHub `owner/repo`（含冒号 `:` 的 forge 形态一律拒绝）；
///   `id` 必须已是 canonical 小写形态（`canonical_app_id(id) == id`）；
///   `id` 必须与 `owner/repo` 对齐（要求相等）；
/// - 提交档另查：必填 `name`/`description`/`category`/`homepage`/`license`；
///   `homepage` 必须为 http(s) URL；`license` 必须命中许可名单（门禁开时默认 D1，
///   见 `LicenseGateConfig`；门禁关闭放行任意非空并记 WARN 审计）。
pub fn validate_custom_item(
    item: &CatalogItem,
    mode: ValidateMode,
    gate: &LicenseGateConfig,
) -> Result<String, String> {
    // PM#2 收口：草稿箱仅支持 GitHub owner/repo，forge 形态（含冒号）直接拒绝。
    // 通用 forge 解析基础设施（ForgeType/coord）保留，此处只做入口收口。
    if item.id.contains(':') {
        return Err(format!(
            "仅支持 GitHub owner/repo，forge 形态 id 暂不收录：'{}'",
            item.id
        ));
    }
    if item.owner.trim().is_empty() || item.repo.trim().is_empty() {
        return Err("仓库坐标 owner/repo 不可为空".to_string());
    }
    if item.owner.contains('/') || item.repo.contains('/') {
        return Err("仓库坐标 owner/repo 不可包含 '/'".to_string());
    }
    if item.owner.contains(char::is_whitespace) || item.repo.contains(char::is_whitespace) {
        return Err("仓库坐标 owner/repo 不可包含空白字符".to_string());
    }
    let canonical = crate::forge::canonical_app_id(&item.id)
        .ok_or_else(|| format!("无法识别的应用标识: {}", item.id))?;
    if canonical != item.id {
        return Err(format!(
            "草稿 id 必须为 canonical 小写形态，应为 '{}'，当前为 '{}'",
            canonical, item.id
        ));
    }
    let coord_suffix = crate::forge::canonical_app_id_from_parts(&item.owner, &item.repo);
    let aligned = canonical == coord_suffix
        || canonical.ends_with(&format!(":{}", coord_suffix))
        || canonical.ends_with(&format!("/{}", coord_suffix));
    if !aligned {
        return Err(format!(
            "草稿 id 必须与仓库坐标一致：id='{}'，owner/repo='{}'",
            item.id, coord_suffix
        ));
    }
    if mode == ValidateMode::DraftLenient {
        return Ok(canonical);
    }
    if item.name.trim().is_empty() {
        return Err("应用名称 name 不可为空".to_string());
    }
    if item.description.trim().is_empty() {
        return Err("应用描述 description 不可为空".to_string());
    }
    if item.category.trim().is_empty() {
        return Err("功能分类 category 不可为空".to_string());
    }
    let homepage = item.homepage.as_deref().unwrap_or("").trim();
    if homepage.is_empty() {
        return Err("官方主页 homepage 不可为空".to_string());
    }
    if !(homepage.starts_with("http://") || homepage.starts_with("https://")) {
        return Err("官方主页 homepage 必须为 http(s) 链接".to_string());
    }
    if item.license.trim().is_empty() {
        return Err("开源协议 license 不可为空".to_string());
    }
    if !gate.enabled {
        // 门禁关闭：仅本地放行（官方生态仓仍以 OSI 为准），记 WARN 供审计。
        log::warn!(
            "license gate DISABLED id='{}' license='{}' (local-only bypass, non-official)",
            item.id,
            item.license
        );
        return Ok(canonical);
    }
    if !is_allowed_license(&item.license, &gate.allowed) {
        return Err(format!(
            "仅收录 OSI 认证开源协议（D1），当前 license='{}' 不符合",
            item.license
        ));
    }
    Ok(canonical)
}

/// 提交链接校验（纯函数）：非空且为 https 链接。
pub fn validate_pr_url(pr_url: &str) -> Result<String, String> {
    let clean_url = pr_url.trim().to_string();
    if clean_url.is_empty() {
        return Err("提交链接 pr_url 不可为空".to_string());
    }
    if !clean_url.starts_with("https://") {
        return Err("提交链接 pr_url 必须为 https 链接".to_string());
    }
    Ok(clean_url)
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> Result<CustomAppEntry> {
    let payload: String = row.get(1)?;
    let item: CatalogItem = serde_json::from_str(&payload).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            Box::new(e),
        )
    })?;
    let status: String = row.get(2)?;
    let archived_int: i64 = row.get(6)?;
    Ok(CustomAppEntry {
        id: row.get(0)?,
        item,
        status,
        pr_url: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        archived: archived_int != 0,
    })
}

/// 库内成员判定（overlay/详情/安装回退口径）：`status` 为 collected 系或 `submitted`；
/// 归档另由调用方判定（`!archived`）。
pub fn is_local_library_entry(entry: &CustomAppEntry) -> bool {
    is_local_library_status(&entry.status) && !entry.archived
}

/// Collected-state check (pure status, no archived): `status==collected`, on-disk `local_collected` also counts.
/// This is the "can submit an Issue / can revert" gate; `submitted` is excluded here (it has its own gates).
pub fn is_collected_status(status: &str) -> bool {
    status == CUSTOM_APP_STATUS_COLLECTED || status == "local_collected"
}

/// 库内成员判定（纯状态）：collected 系或 `submitted`（已提交 Issue仍在本地库）。
/// 与 `is_collected_status` 的区别：本函数答「是否在库」，后者答「能否提交 Issue/退回」。
pub fn is_local_library_status(status: &str) -> bool {
    is_collected_status(status) || status == CUSTOM_APP_STATUS_SUBMITTED
}

impl Database {
    /// 草稿列表：默认仅未归档（`include_archived=true` 含转正归档行），按更新时间倒序。
    pub fn list_custom_apps(&self, include_archived: bool) -> Result<Vec<CustomAppEntry>> {
        let sql = if include_archived {
            "SELECT id, payload_json, status, pr_url, created_at, updated_at, archived FROM custom_apps ORDER BY updated_at DESC"
        } else {
            "SELECT id, payload_json, status, pr_url, created_at, updated_at, archived FROM custom_apps WHERE archived = 0 ORDER BY updated_at DESC"
        };
        self.query_vec(sql, [], row_to_entry)
    }

    /// 按 canonical id 取单条草稿（空 id 直接 None，不触库）。
    pub fn get_custom_app(&self, id: &str) -> Result<Option<CustomAppEntry>> {
        let cleaned = clean(id);
        if cleaned.is_empty() {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, payload_json, status, pr_url, created_at, updated_at, archived FROM custom_apps WHERE id = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![cleaned])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row_to_entry(row)?))
        } else {
            Ok(None)
        }
    }

    /// 草稿暂存（upsert）：新建行 `status=draft`；已存在行仅刷新 payload + updated_at，
    /// `status`/`pr_url`/`created_at`/`archived` 保持不动。
    /// 调用方须先过 `validate_custom_item`（暂存走 `DraftLenient`，提交门禁后移到提交时）。
    pub fn upsert_custom_app_payload(&self, item: &CatalogItem) -> Result<CustomAppEntry> {
        let now = now_secs();
        let payload = serde_json::to_string(item).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(e))
        })?;
        self.exec_upsert(
            r#"
            INSERT INTO custom_apps (id, payload_json, status, pr_url, created_at, updated_at, archived)
            VALUES (?1, ?2, 'draft', NULL, ?3, ?3, 0)
            ON CONFLICT(id) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at;
            "#,
            params![item.id, payload, now],
        )?;
        self.get_custom_app(&item.id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    /// 草稿删除（后端直接删，二次确认由前端做）：返回是否命中。
    /// 未归档 `submitted` 可删（`status`/`pr_url` 经 `list`/`get` 透出后手动清理）；
    /// 已归档行同样直接删（转正归档手动清理，现有语义不变）。
    pub fn delete_custom_app(&self, id: &str) -> Result<bool> {
        let rows = self.exec_upsert(
            "DELETE FROM custom_apps WHERE id = ?1",
            params![clean(id)],
        )?;
        Ok(rows > 0)
    }

    /// 标记已提交：`status=submitted` + 落 `pr_url`；已归档（转正）行拒绝，不复活。
    /// 提交时强制提交档全校验（`SubmitStrict`：必填 + homepage http(s) + OSI 白名单 D1），
    /// 占位 license（`OpenSource` 等）草稿在此被拦下，先补真实 SPDX 再提交。
    /// 已提交行只读：二次 `mark` 直接拒绝（明确文案，不走收录门禁）。
    pub fn mark_custom_app_submitted(
        &self,
        id: &str,
        pr_url: &str,
    ) -> Result<CustomAppEntry, MarkSubmittedError> {
        let clean_url = validate_pr_url(pr_url).map_err(MarkSubmittedError::Invalid)?;
        let cleaned = clean(id);
        if cleaned.is_empty() {
            return Err(MarkSubmittedError::Invalid("应用标识不可为空".to_string()));
        }
        let existing = self
            .get_custom_app(cleaned)
            .map_err(MarkSubmittedError::Db)?;
        let entry = existing.ok_or_else(|| {
            MarkSubmittedError::Invalid(format!("草稿不存在: {}", cleaned))
        })?;
        if entry.archived {
            return Err(MarkSubmittedError::Invalid(format!(
                "草稿已转正归档，无需重复提交: {}",
                cleaned
            )));
        }
        if entry.status == CUSTOM_APP_STATUS_SUBMITTED {
            return Err(MarkSubmittedError::Invalid(format!(
                "已提交行不可重复提交: {}",
                cleaned
            )));
        }
        // Issue 提交前置门禁（与命令层 `ensure_collected_for_pr` 同口径）：仅收录行放行（with on-disk `local_collected` 字面）。
        if !is_collected_status(&entry.status) {
            return Err(MarkSubmittedError::Invalid(
                "须先收录进本地再提交 Issue".to_string(),
            ));
        }
        if let Err(reason) = validate_custom_item(
            &entry.item,
            ValidateMode::SubmitStrict,
            &resolve_license_gate(),
        ) {
            return Err(MarkSubmittedError::Invalid(format!(
                "草稿提交校验未通过：{}",
                reason
            )));
        }
        let now = now_secs();
        self.exec_upsert(
            "UPDATE custom_apps SET status = 'submitted', pr_url = ?1, updated_at = ?2 WHERE id = ?3",
            params![clean_url, now, cleaned],
        )
        .map_err(MarkSubmittedError::Db)?;
        self.get_custom_app(cleaned)
            .map_err(MarkSubmittedError::Db)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
            .map_err(MarkSubmittedError::Db)
    }

    /// 标记本地收录：`status=collected`（`archived` 不动，已归档行拒绝不复活）。
    /// 收录时强制收录档全校验（`CollectStrict`，与 `SubmitStrict` 同口径）；
    /// 入库保持 `is_verified=false`（已收录仍不冒充已验证，纠正后落盘）。
    /// 已提交行只读：重收录直接拒绝（明确文案，不降级回 `collected`）。
    pub fn mark_custom_app_collected(
        &self,
        id: &str,
    ) -> Result<CustomAppEntry, MarkCollectedError> {
        let cleaned = clean(id);
        if cleaned.is_empty() {
            return Err(MarkCollectedError::Invalid("应用标识不可为空".to_string()));
        }
        let existing = self
            .get_custom_app(cleaned)
            .map_err(MarkCollectedError::Db)?;
        let entry = existing.ok_or_else(|| {
            MarkCollectedError::Invalid(format!("草稿不存在: {}", cleaned))
        })?;
        if entry.archived {
            return Err(MarkCollectedError::Invalid(format!(
                "草稿已转正归档，无需重复收录: {}",
                cleaned
            )));
        }
        if entry.status == CUSTOM_APP_STATUS_SUBMITTED {
            return Err(MarkCollectedError::Invalid(format!(
                "已提交行不可重复收录: {}",
                cleaned
            )));
        }
        if let Err(reason) = validate_custom_item(
            &entry.item,
            ValidateMode::CollectStrict,
            &resolve_license_gate(),
        ) {
            return Err(MarkCollectedError::Invalid(format!(
                "本地收录校验未通过：{}",
                reason
            )));
        }
        let mut item = entry.item.clone();
        item.is_verified = false;
        let payload = serde_json::to_string(&item).map_err(|e| {
            MarkCollectedError::Db(rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
        })?;
        let now = now_secs();
        self.exec_upsert(
            "UPDATE custom_apps SET payload_json = ?1, status = 'collected', updated_at = ?2 WHERE id = ?3",
            params![payload, now, cleaned],
        )
        .map_err(MarkCollectedError::Db)?;
        self.get_custom_app(cleaned)
            .map_err(MarkCollectedError::Db)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
            .map_err(MarkCollectedError::Db)
    }

    /// 退回草稿：`status=collected` → `draft`（未归档限定；已提交/已归档不退回，只读）。
    /// `pr_url` 清空，`is_verified=false` 落盘保持（草稿永不冒充已验证）。
    pub fn revert_collected_to_draft(
        &self,
        id: &str,
    ) -> Result<CustomAppEntry, RevertCollectedError> {
        let cleaned = clean(id);
        if cleaned.is_empty() {
            return Err(RevertCollectedError::Invalid("应用标识不可为空".to_string()));
        }
        let existing = self
            .get_custom_app(cleaned)
            .map_err(RevertCollectedError::Db)?;
        let entry = existing.ok_or_else(|| {
            RevertCollectedError::Invalid(format!("草稿不存在: {}", cleaned))
        })?;
        if entry.archived {
            return Err(RevertCollectedError::Invalid(format!(
                "草稿已转正归档，不可退回草稿: {}",
                cleaned
            )));
        }
        if entry.status == CUSTOM_APP_STATUS_SUBMITTED {
            return Err(RevertCollectedError::Invalid(format!(
                "已提交行不可退回草稿: {}",
                cleaned
            )));
        }
        if !is_collected_status(&entry.status) {
            return Err(RevertCollectedError::Invalid(format!(
                "仅已收录行可退回草稿: {}",
                cleaned
            )));
        }
        let mut item = entry.item.clone();
        item.is_verified = false;
        let payload = serde_json::to_string(&item).map_err(|e| {
            RevertCollectedError::Db(rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
        })?;
        let now = now_secs();
        self.exec_upsert(
            "UPDATE custom_apps SET payload_json = ?1, status = 'draft', pr_url = NULL, updated_at = ?2 WHERE id = ?3",
            params![payload, now, cleaned],
        )
        .map_err(RevertCollectedError::Db)?;
        self.get_custom_app(cleaned)
            .map_err(RevertCollectedError::Db)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
            .map_err(RevertCollectedError::Db)
    }

    /// 标记为未提交：`submitted` → `collected`（未归档限定），`pr_url` 清空，payload 原样保留。
    /// Issue 需在 GitHub 侧自行关闭（后端零网络）；撤下后可重新走收录/提交链路。
    pub fn withdraw_submitted(&self, id: &str) -> Result<CustomAppEntry, WithdrawSubmittedError> {
        let cleaned = clean(id);
        if cleaned.is_empty() {
            return Err(WithdrawSubmittedError::Invalid(
                "应用标识不可为空".to_string(),
            ));
        }
        let existing = self
            .get_custom_app(cleaned)
            .map_err(WithdrawSubmittedError::Db)?;
        let entry = existing
            .ok_or_else(|| WithdrawSubmittedError::Invalid(format!("草稿不存在: {}", cleaned)))?;
        if entry.archived {
            return Err(WithdrawSubmittedError::Invalid(format!(
                "已转正归档行不可标记为未提交: {}",
                cleaned
            )));
        }
        if entry.status != CUSTOM_APP_STATUS_SUBMITTED {
            return Err(WithdrawSubmittedError::Invalid(format!(
                "仅已提交行可标记为未提交: {}",
                cleaned
            )));
        }
        let now = now_secs();
        self.exec_upsert(
            "UPDATE custom_apps SET status = 'collected', pr_url = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, cleaned],
        )
        .map_err(WithdrawSubmittedError::Db)?;
        self.get_custom_app(cleaned)
            .map_err(WithdrawSubmittedError::Db)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
            .map_err(WithdrawSubmittedError::Db)
    }

    /// 本地库列表：未归档的 collected 系 + `submitted`（overlay/发现页/搜索唯一口径，
    /// on-disk residual `local_collected` 字面同匹配；归档行权威交给远端，不参与）。
    pub fn list_local_library_apps(&self) -> Result<Vec<CustomAppEntry>> {
        self.query_vec(
            "SELECT id, payload_json, status, pr_url, created_at, updated_at, archived FROM custom_apps WHERE status IN ('collected', 'local_collected', 'submitted') AND archived = 0 ORDER BY updated_at DESC",
            [],
            row_to_entry,
        )
    }

    /// 本地库 payload 列表：`list_local_library_apps` 的 `CatalogItem` 投影（合并视图输入）。
    pub fn list_local_library_items(&self) -> Result<Vec<CatalogItem>> {
        Ok(self
            .list_local_library_apps()?
            .into_iter()
            .map(|e| e.item)
            .collect())
    }

    /// 按 id 取本地库行：仅未归档的 collected 系/`submitted` 命中（详情/安装回退口径，
    /// on-disk residual `local_collected` 字面同匹配）。
    pub fn get_collected_custom_item(&self, id: &str) -> Result<Option<CustomAppEntry>> {
        Ok(self
            .get_custom_app(id)?
            .filter(|e| is_local_library_status(&e.status) && !e.archived))
    }

    /// 转正退役：远端 id 集合命中未归档草稿即 `archived=1`，返回转正提示。
    /// `draft`/`collected`/`submitted` 未归档行均命中归档（`submitted` 转正同样归档，
    /// `status`/`pr_url` 保留可查）；远端 id 经 `canonical_app_id` 归一后比对（大小写漂移行治愈）。
    pub fn retire_custom_apps_on_sync(
        &self,
        remote_ids: &[String],
    ) -> Result<Vec<GraduationNotice>> {
        let mut remote_set = std::collections::HashSet::new();
        for raw in remote_ids {
            if let Some(canon) = crate::forge::canonical_app_id(raw) {
                remote_set.insert(canon);
            } else {
                let lower = raw.trim().to_lowercase();
                if !lower.is_empty() {
                    remote_set.insert(lower);
                }
            }
        }
        if remote_set.is_empty() {
            return Ok(Vec::new());
        }
        let staged_ids: Vec<String> = self
            .query_vec(
                "SELECT id FROM custom_apps WHERE archived = 0",
                [],
                |row| row.get(0),
            )?
            .into_iter()
            .filter(|id: &String| remote_set.contains(id))
            .collect();
        if staged_ids.is_empty() {
            return Ok(Vec::new());
        }
        let now = now_secs();
        self.with_immediate_transaction(|| {
            for id in &staged_ids {
                self.exec_upsert(
                    "UPDATE custom_apps SET archived = 1, updated_at = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
            }
            Ok(())
        })?;
        Ok(staged_ids
            .into_iter()
            .map(|id| GraduationNotice {
                message: format!("{} 已被远端精选收录库收录，本地草稿自动归档", id),
                id,
            })
            .collect())
    }
}

/// `mark_custom_app_submitted` 错误：校验失败与 DB 失败分层（命令层分别转中文串）。
#[derive(Debug)]
pub enum MarkSubmittedError {
    Invalid(String),
    Db(rusqlite::Error),
}

impl std::fmt::Display for MarkSubmittedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(msg) => write!(f, "{}", msg),
            Self::Db(e) => write!(f, "{}", e),
        }
    }
}

impl From<MarkSubmittedError> for crate::AppError {
    fn from(e: MarkSubmittedError) -> Self {
        match e {
            MarkSubmittedError::Invalid(msg) => Self::Message(msg),
            MarkSubmittedError::Db(err) => Self::Database(err),
        }
    }
}

/// `mark_custom_app_collected` 错误：校验失败与 DB 失败分层（命令层分别转中文串）。
#[derive(Debug)]
pub enum MarkCollectedError {
    Invalid(String),
    Db(rusqlite::Error),
}

impl std::fmt::Display for MarkCollectedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(msg) => write!(f, "{}", msg),
            Self::Db(e) => write!(f, "{}", e),
        }
    }
}

impl From<MarkCollectedError> for crate::AppError {
    fn from(e: MarkCollectedError) -> Self {
        match e {
            MarkCollectedError::Invalid(msg) => Self::Message(msg),
            MarkCollectedError::Db(err) => Self::Database(err),
        }
    }
}

/// `revert_collected_to_draft` 错误：校验失败与 DB 失败分层（命令层分别转中文串）。
#[derive(Debug)]
pub enum RevertCollectedError {
    Invalid(String),
    Db(rusqlite::Error),
}

impl std::fmt::Display for RevertCollectedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(msg) => write!(f, "{}", msg),
            Self::Db(e) => write!(f, "{}", e),
        }
    }
}

impl From<RevertCollectedError> for crate::AppError {
    fn from(e: RevertCollectedError) -> Self {
        match e {
            RevertCollectedError::Invalid(msg) => Self::Message(msg),
            RevertCollectedError::Db(err) => Self::Database(err),
        }
    }
}

/// `withdraw_submitted` 错误：校验失败与 DB 失败分层（命令层分别转中文串）。
#[derive(Debug)]
pub enum WithdrawSubmittedError {
    Invalid(String),
    Db(rusqlite::Error),
}

impl std::fmt::Display for WithdrawSubmittedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(msg) => write!(f, "{}", msg),
            Self::Db(e) => write!(f, "{}", e),
        }
    }
}

impl From<WithdrawSubmittedError> for crate::AppError {
    fn from(e: WithdrawSubmittedError) -> Self {
        match e {
            WithdrawSubmittedError::Invalid(msg) => Self::Message(msg),
            WithdrawSubmittedError::Db(err) => Self::Database(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn draft_item(id: &str, owner: &str, repo: &str) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            name: "Demo App".to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: String::new(),
            icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
            description: "本地自维护草稿".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v0.1.0".to_string(),
            license: "MIT".to_string(),
            stars: 0,
            forks: 0,
            is_verified: false,
            homepage: Some("https://example.com/demo".to_string()),
            identifiers: HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec!["windows".to_string()],
        }
    }

    fn strict_gate() -> LicenseGateConfig {
        LicenseGateConfig::default()
    }

    fn disabled_gate() -> LicenseGateConfig {
        LicenseGateConfig {
            enabled: false,
            allowed: Vec::new(),
        }
    }

    fn subset_gate() -> LicenseGateConfig {
        LicenseGateConfig {
            enabled: true,
            allowed: vec!["MIT".to_string()],
        }
    }

    #[test]
    fn gate_disabled_permits_nonempty_license() {
        // 门禁关闭：放行任意非空 license（仅本地，WARN 审计），空仍拒绝。
        let mut item = draft_item("o/r", "o", "r");
        item.license = "OpenSource".to_string();
        assert!(
            validate_custom_item(&item, ValidateMode::SubmitStrict, &disabled_gate()).is_ok()
        );
        item.license = "  ".to_string();
        assert!(
            validate_custom_item(&item, ValidateMode::SubmitStrict, &disabled_gate()).is_err()
        );
    }

    #[test]
    fn gate_custom_subset_restricts_range() {
        // 自定义子集：MIT 放行，GPL-3.0 与 OpenSource 同拒。
        let mut item = draft_item("o/r", "o", "r");
        assert!(validate_custom_item(&item, ValidateMode::SubmitStrict, &subset_gate()).is_ok());
        item.license = "GPL-3.0".to_string();
        assert!(validate_custom_item(&item, ValidateMode::SubmitStrict, &subset_gate()).is_err());
        item.license = "OpenSource".to_string();
        assert!(validate_custom_item(&item, ValidateMode::SubmitStrict, &subset_gate()).is_err());
    }

    #[test]
    fn resolve_license_gate_reads_compile_time_config() {
        // 编译时唯一源：门禁只由 config.toml 基线确定（默认开 + 37 项全量）。
        let gate = resolve_license_gate();
        assert!(gate.enabled);
        assert_eq!(gate.allowed.len(), 37);
        assert_eq!(gate.allowed.first().map(String::as_str), Some("MIT"));
    }

    #[test]
    fn validate_accepts_canonical_draft() {
        assert_eq!(
            validate_custom_item(&draft_item("o/r", "o", "r"), ValidateMode::SubmitStrict, &strict_gate())
                .as_deref(),
            Ok("o/r")
        );
    }

    #[test]
    fn validate_rejects_forge_prefixed_id_github_only() {
        // PM#2 收口：草稿箱仅支持 GitHub owner/repo，forge 前缀 id（含冒号）两档同拒。
        let item = draft_item("codeberg:o/r", "O", "R");
        for mode in [ValidateMode::DraftLenient, ValidateMode::SubmitStrict] {
            let err =
                validate_custom_item(&item, mode, &strict_gate()).expect_err("forge id must be rejected");
            assert!(
                err.contains("仅支持 GitHub owner/repo"),
                "unexpected reason: {err}"
            );
        }
        // 非 canonical（大写）forge id 同样拒绝（先命中 GitHub-only 门禁）。
        let upper = draft_item("Codeberg:O/R", "O", "R");
        assert!(validate_custom_item(&upper, ValidateMode::SubmitStrict, &strict_gate()).is_err());
    }

    #[test]
    fn validate_rejects_non_canonical_and_mismatched_id() {
        // 大写 id 非 canonical（两档同拒：身份不可错）。
        assert!(
            validate_custom_item(&draft_item("O/R", "o", "r"), ValidateMode::DraftLenient, &strict_gate())
                .is_err()
        );
        assert!(
            validate_custom_item(&draft_item("O/R", "o", "r"), ValidateMode::SubmitStrict, &strict_gate())
                .is_err()
        );
        // id 与 owner/repo 脱节（两档同拒）。
        assert!(
            validate_custom_item(&draft_item("o/other", "o", "r"), ValidateMode::DraftLenient, &strict_gate())
                .is_err()
        );
        assert!(
            validate_custom_item(&draft_item("o/other", "o", "r"), ValidateMode::SubmitStrict, &strict_gate())
                .is_err()
        );
        // 未知标识（两档同拒）。
        assert!(
            validate_custom_item(&draft_item("nope", "o", "r"), ValidateMode::SubmitStrict, &strict_gate())
                .is_err()
        );
    }

    #[test]
    fn validate_rejects_missing_required_fields() {
        let mut item = draft_item("o/r", "o", "r");
        item.name = "  ".to_string();
        assert!(validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_err());
        let mut item = draft_item("o/r", "o", "r");
        item.description = String::new();
        assert!(validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_err());
        let mut item = draft_item("o/r", "o", "r");
        item.category = String::new();
        assert!(validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_err());
        let mut item = draft_item("o/r", "o", "r");
        item.homepage = None;
        assert!(validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_err());
        let mut item = draft_item("o/r", "o", "r");
        item.homepage = Some("example.com/no-scheme".to_string());
        assert!(validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_err());
    }

    #[test]
    fn validate_rejects_non_osi_license() {
        // D1：CC-BY（非 OSI）、Unknown/NOASSERTION、闭源空 license 一律拒绝。
        // `unknown`（#21 显式未知哨兵值）与旧 `FLOSS` 占位同按名单外拒绝。
        for bad in ["CC-BY-4.0", "Unknown", "unknown", "FLOSS", "NOASSERTION", "", "Proprietary"] {
            let mut item = draft_item("o/r", "o", "r");
            item.license = bad.to_string();
            assert!(
                validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_err(),
                "license={bad} must be rejected"
            );
        }
        // OSI 常见形态放行（含小写与 `+` 后缀归一）。
        for good in ["MIT", "mit", "Apache-2.0", "GPL-3.0", "GPL-3.0+", "AGPL-3.0", "MPL-2.0", "Unlicense"] {
            let mut item = draft_item("o/r", "o", "r");
            item.license = good.to_string();
            assert!(
                validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_ok(),
                "license={good} must be accepted"
            );
        }
    }

    #[test]
    fn draft_lenient_tolerates_placeholders_but_keeps_identity() {
        // Q8 草稿三态：占位 license / 空 homepage / 不完整字段暂存放行（D1 门禁后移到提交时）。
        for placeholder in ["", "OpenSource", "opensource", "NOASSERTION", "Unknown", "Proprietary"] {
            let mut item = draft_item("o/r", "o", "r");
            item.license = placeholder.to_string();
            item.homepage = None;
            item.name = String::new();
            assert_eq!(
                validate_custom_item(&item, ValidateMode::DraftLenient, &strict_gate()).as_deref(),
                Ok("o/r"),
                "license={placeholder} must pass draft-lenient",
            );
            assert!(
                validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_err(),
                "license={placeholder} must fail submit-strict",
            );
        }
    }

    #[test]
    fn submit_strict_rejects_opensource_accepts_mit() {
        // 验收三元组：draft 存 OpenSource 通过、submit 同值拒绝、Submit MIT 通过。
        let mut opensource = draft_item("o/r", "o", "r");
        opensource.license = "OpenSource".to_string();
        assert!(validate_custom_item(&opensource, ValidateMode::DraftLenient, &strict_gate()).is_ok());
        let err = validate_custom_item(&opensource, ValidateMode::SubmitStrict, &strict_gate())
            .expect_err("OpenSource must fail submit-strict");
        assert!(err.contains("OSI"), "unexpected reason: {err}");
        let mit = draft_item("o/r", "o", "r");
        assert!(validate_custom_item(&mit, ValidateMode::SubmitStrict, &strict_gate()).is_ok());
    }

    #[test]
    fn mark_submitted_enforces_submit_strict() {
        // 占位 license 草稿可暂存（lenient），但收录/提交均被拦；补真实 SPDX 后收录再提交放行。
        let db = Database::open_in_memory().unwrap();
        let mut placeholder = draft_item("o/r", "o", "r");
        placeholder.license = "OpenSource".to_string();
        assert!(validate_custom_item(&placeholder, ValidateMode::DraftLenient, &strict_gate()).is_ok());
        db.upsert_custom_app_payload(&placeholder).unwrap();
        // 草稿直交提交被门禁拦（先收录）。
        let gate_err = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .expect_err("draft must be gated before submit");
        assert_eq!(gate_err.to_string(), "须先收录进本地再提交 Issue");
        // 占位 license 同样过不了收录档。
        assert!(db.mark_custom_app_collected("o/r").is_err());

        let fixed = draft_item("o/r", "o", "r");
        db.upsert_custom_app_payload(&fixed).unwrap();
        // 收录后提交放行（提交档二次校验同口径）。
        db.mark_custom_app_collected("o/r").unwrap();
        let submitted = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .unwrap();
        assert_eq!(submitted.status, CUSTOM_APP_STATUS_SUBMITTED);
    }

    #[test]
    fn mark_submitted_requires_collected_gate() {
        // 门禁：draft 直交提交走收录门禁；已提交二次提交明确拒绝（只读）。
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/r", "o", "r"))
            .unwrap();
        let err = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .expect_err("draft must be gated");
        assert_eq!(err.to_string(), "须先收录进本地再提交 Issue");

        db.mark_custom_app_collected("o/r").unwrap();
        db.mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .unwrap();
        // 已提交行不可重复提交（只读，明确文案）。
        let again = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/2")
            .expect_err("submitted must stay read-only");
        assert_eq!(again.to_string(), "已提交行不可重复提交: o/r");
    }

    #[test]
    fn submitted_deletable_and_archived_cleanup() {
        // 未归档 submitted 可删（状态透出后手动清理）；已归档按现有语义同样直接删。
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/r", "o", "r"))
            .unwrap();
        db.mark_custom_app_collected("o/r").unwrap();
        let submitted = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .unwrap();
        assert_eq!(submitted.status, CUSTOM_APP_STATUS_SUBMITTED);
        // 查询透出 status/pr_url（无需新增轮询）。
        let fetched = db.get_custom_app("o/r").unwrap().unwrap();
        assert_eq!(fetched.status, CUSTOM_APP_STATUS_SUBMITTED);
        assert_eq!(
            fetched.pr_url.as_deref(),
            Some("https://github.com/x/y/pull/1")
        );
        assert!(db.delete_custom_app("o/r").unwrap());
        assert!(db.get_custom_app("o/r").unwrap().is_none());

        // 转正归档后同样可手动清理（现有语义不变）。
        db.upsert_custom_app_payload(&draft_item("o/s", "o", "s"))
            .unwrap();
        db.mark_custom_app_collected("o/s").unwrap();
        db.mark_custom_app_submitted("o/s", "https://github.com/x/y/pull/1")
            .unwrap();
        db.retire_custom_apps_on_sync(&["o/s".to_string()])
            .unwrap();
        let archived = db.get_custom_app("o/s").unwrap().unwrap();
        assert!(archived.archived);
        assert_eq!(archived.status, CUSTOM_APP_STATUS_SUBMITTED);
        assert!(db.delete_custom_app("o/s").unwrap());
        assert!(db.get_custom_app("o/s").unwrap().is_none());
    }

    #[test]
    fn submitted_second_mark_and_recollect_blocked() {
        // 二次提交/重收录硬拦，明确文案。
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/r", "o", "r"))
            .unwrap();
        db.mark_custom_app_collected("o/r").unwrap();
        db.mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .unwrap();
        let again = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/2")
            .expect_err("second submit must be blocked");
        assert!(
            again.to_string().contains("已提交行不可重复提交"),
            "unexpected: {again}"
        );
        let recollect = db
            .mark_custom_app_collected("o/r")
            .expect_err("recollect submitted must be blocked");
        assert!(
            recollect.to_string().contains("已提交行不可重复收录"),
            "unexpected: {recollect}"
        );
        // same truth, same gate.
        assert!(db.mark_custom_app_collected("o/r").is_err());
    }

    #[test]
    fn crud_roundtrip_keeps_status_on_resave() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.list_custom_apps(false).unwrap().is_empty());

        let saved = db.upsert_custom_app_payload(&draft_item("o/r", "o", "r")).unwrap();
        assert_eq!(saved.id, "o/r");
        assert_eq!(saved.status, CUSTOM_APP_STATUS_DRAFT);
        assert!(!saved.archived);

        // 收录后提交：二次暂存仅刷新 payload，不动 status。
        db.mark_custom_app_collected("o/r").unwrap();
        // 非法 pr_url 在收录态即拒绝。
        assert!(db.mark_custom_app_submitted("o/r", "not-a-url").is_err());
        assert!(db.mark_custom_app_submitted("o/r", "").is_err());
        db.mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .unwrap();
        let mut v2 = draft_item("o/r", "o", "r");
        v2.description = "更新后的描述".to_string();
        let resaved = db.upsert_custom_app_payload(&v2).unwrap();
        assert_eq!(resaved.status, CUSTOM_APP_STATUS_SUBMITTED);
        assert_eq!(
            resaved.pr_url.as_deref(),
            Some("https://github.com/x/y/pull/1")
        );
        assert_eq!(resaved.item.description, "更新后的描述");

        assert!(db.delete_custom_app("o/r").unwrap());
        assert!(!db.delete_custom_app("o/r").unwrap());
        assert!(db.get_custom_app("o/r").unwrap().is_none());
    }

    #[test]
    fn retire_on_sync_archives_only_hits() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/hit", "o", "hit"))
            .unwrap();
        db.upsert_custom_app_payload(&draft_item("o/miss", "o", "miss"))
            .unwrap();
        // submitted 未归档行同样命中归档（转正按 remote_ids 命中）。
        db.upsert_custom_app_payload(&draft_item("o/sub", "o", "sub"))
            .unwrap();
        db.mark_custom_app_collected("o/sub").unwrap();
        db.mark_custom_app_submitted("o/sub", "https://github.com/x/y/pull/1")
            .unwrap();

        // 大小写漂移的远端 id 同样命中（归一后比对）。
        let notices = db
            .retire_custom_apps_on_sync(&["O/Hit".to_string(), "o/other".to_string()])
            .unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].id, "o/hit");

        // 默认列表不再含转正行，加旗可见且 archived=true。
        let visible: Vec<String> = db
            .list_custom_apps(false)
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect();
        assert!(visible.contains(&"o/miss".to_string()));
        assert!(visible.contains(&"o/sub".to_string()));
        let all = db.list_custom_apps(true).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().find(|e| e.id == "o/hit").unwrap().archived);
        // submitted 未归档行命中远端即归档，status/pr_url 保留可查。
        let sub_notices = db
            .retire_custom_apps_on_sync(&["o/sub".to_string()])
            .unwrap();
        assert_eq!(sub_notices.len(), 1);
        assert_eq!(sub_notices[0].id, "o/sub");
        let sub_archived = db.get_custom_app("o/sub").unwrap().unwrap();
        assert!(sub_archived.archived);
        assert_eq!(sub_archived.status, CUSTOM_APP_STATUS_SUBMITTED);

        // 已归档行拒绝重复提交，不复活。
        assert!(db.mark_custom_app_submitted("o/hit", "https://github.com/x/y/pull/2").is_err());
        assert!(db.mark_custom_app_submitted("o/sub", "https://github.com/x/y/pull/2").is_err());
        // 空远端集合直接空回，不触库。
        assert!(db.retire_custom_apps_on_sync(&[]).unwrap().is_empty());
    }

    #[test]
    fn collect_strict_matches_submit_strict() {
        // 收录档与提交档同口径：占位 license 两档同拒，MIT 两档同放。
        for bad in ["OpenSource", "NOASSERTION", ""] {
            let mut item = draft_item("o/r", "o", "r");
            item.license = bad.to_string();
            assert!(
                validate_custom_item(&item, ValidateMode::CollectStrict, &strict_gate()).is_err(),
                "license={bad} must fail collect-strict"
            );
            assert!(
                validate_custom_item(&item, ValidateMode::SubmitStrict, &strict_gate()).is_err()
            );
        }
        let mit = draft_item("o/r", "o", "r");
        assert!(validate_custom_item(&mit, ValidateMode::CollectStrict, &strict_gate()).is_ok());
        assert!(validate_custom_item(&mit, ValidateMode::SubmitStrict, &strict_gate()).is_ok());
        // constants share the same value.
        assert_eq!(CUSTOM_APP_STATUS_COLLECTED, "collected");
        assert_eq!(LOCAL_COLLECTED, CUSTOM_APP_STATUS_COLLECTED);
        assert_eq!(
            CUSTOM_APP_STATUS_LOCAL_COLLECTED,
            CUSTOM_APP_STATUS_COLLECTED
        );
    }

    #[test]
    fn mark_custom_app_collected_sets_status_and_keeps_verified_false() {
        let db = Database::open_in_memory().unwrap();
        let mut item = draft_item("o/r", "o", "r");
        item.is_verified = true;
        db.upsert_custom_app_payload(&item).unwrap();
        let collected = db.mark_custom_app_collected("o/r").unwrap();
        assert_eq!(collected.status, CUSTOM_APP_STATUS_COLLECTED);
        assert!(!collected.archived);
        assert!(!collected.item.is_verified);
        // same truth, idempotent re-collect.
        let again = db.mark_custom_app_collected("o/r").unwrap();
        assert_eq!(again.status, CUSTOM_APP_STATUS_COLLECTED);
        // 本地库列表含该 collected 行。
        assert_eq!(db.list_local_library_apps().unwrap().len(), 1);
        assert_eq!(db.list_local_library_items().unwrap().len(), 1);
        assert!(db.get_collected_custom_item("o/r").unwrap().is_some());
        // 二次暂存不洗状态。
        let resaved = db.upsert_custom_app_payload(&draft_item("o/r", "o", "r")).unwrap();
        assert_eq!(resaved.status, CUSTOM_APP_STATUS_COLLECTED);
    }

    #[test]
    fn mark_custom_app_collected_rejects_placeholder_and_archived() {
        let db = Database::open_in_memory().unwrap();
        let mut placeholder = draft_item("o/r", "o", "r");
        placeholder.license = "OpenSource".to_string();
        db.upsert_custom_app_payload(&placeholder).unwrap();
        assert!(db.mark_custom_app_collected("o/r").is_err());
        assert!(db.mark_custom_app_collected("o/r").is_err());
        assert!(db.get_collected_custom_item("o/r").unwrap().is_none());

        let db2 = Database::open_in_memory().unwrap();
        db2.upsert_custom_app_payload(&draft_item("o/h", "o", "h"))
            .unwrap();
        db2.retire_custom_apps_on_sync(&["o/h".to_string()])
            .unwrap();
        assert!(db2.mark_custom_app_collected("o/h").is_err());
    }

    #[test]
    fn revert_collected_to_draft_roundtrip() {
        // 收录往返：draft → collected → draft，pr_url 清空、is_verified 保持 false。
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/r", "o", "r"))
            .unwrap();
        let collected = db.mark_custom_app_collected("o/r").unwrap();
        assert_eq!(collected.status, CUSTOM_APP_STATUS_COLLECTED);

        let reverted = db.revert_collected_to_draft("o/r").unwrap();
        assert_eq!(reverted.status, CUSTOM_APP_STATUS_DRAFT);
        assert!(!reverted.archived);
        assert!(reverted.pr_url.is_none());
        assert!(!reverted.item.is_verified);
        assert!(db.get_collected_custom_item("o/r").unwrap().is_none());

        // 退回后可再次收录（往返闭环）。
        let recollected = db.mark_custom_app_collected("o/r").unwrap();
        assert_eq!(recollected.status, CUSTOM_APP_STATUS_COLLECTED);
    }

    #[test]
    fn revert_collected_rejects_non_collected() {
        let db = Database::open_in_memory().unwrap();
        // 不存在行拒绝。
        assert!(db.revert_collected_to_draft("o/missing").is_err());
        // 草稿态不可退回（仅已收录行可退）。
        db.upsert_custom_app_payload(&draft_item("o/d", "o", "d"))
            .unwrap();
        let err = db
            .revert_collected_to_draft("o/d")
            .expect_err("draft must not revert");
        assert!(err.to_string().contains("仅已收录行可退回草稿"));

        // 已提交行只读，不退回。
        db.upsert_custom_app_payload(&draft_item("o/s", "o", "s"))
            .unwrap();
        db.mark_custom_app_collected("o/s").unwrap();
        db.mark_custom_app_submitted("o/s", "https://github.com/x/y/pull/1")
            .unwrap();
        let err = db
            .revert_collected_to_draft("o/s")
            .expect_err("submitted must stay read-only");
        assert!(err.to_string().contains("已提交行不可退回草稿"));

        // 已归档行不复活。
        db.upsert_custom_app_payload(&draft_item("o/h", "o", "h"))
            .unwrap();
        db.mark_custom_app_collected("o/h").unwrap();
        db.retire_custom_apps_on_sync(&["o/h".to_string()])
            .unwrap();
        let err = db
            .revert_collected_to_draft("o/h")
            .expect_err("archived must not revert");
        assert!(err.to_string().contains("已转正归档"));
    }

    #[test]
    fn revert_persists_draft_and_drops_from_local_library() {
        // 回归：退回必须落盘（status=draft），重启后不再进本地库列表/overlay。
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/r", "o", "r"))
            .unwrap();
        db.mark_custom_app_collected("o/r").unwrap();
        assert_eq!(db.list_local_library_apps().unwrap().len(), 1);
        assert!(is_local_library_entry(
            &db.get_custom_app("o/r").unwrap().unwrap()
        ));

        let reverted = db.revert_collected_to_draft("o/r").unwrap();
        assert_eq!(reverted.status, CUSTOM_APP_STATUS_DRAFT);
        // 落盘断言：重读仍为 draft，不再是收录态。
        let stored = db.get_custom_app("o/r").unwrap().unwrap();
        assert_eq!(stored.status, CUSTOM_APP_STATUS_DRAFT);
        assert!(!is_local_library_entry(&stored));
        assert!(!is_collected_status(&stored.status));
        assert!(db.get_collected_custom_item("o/r").unwrap().is_none());
        assert!(db.list_local_library_apps().unwrap().is_empty());
        assert!(db.list_local_library_items().unwrap().is_empty());
        // 未归档列表仍含该行（draft 态，可在草稿 Tab 查看），归档位不动。
        assert!(db.list_custom_apps(false).unwrap().iter().any(|e| e.id == "o/r"));
    }

    #[test]
    fn local_library_includes_submitted_and_excludes_archived() {
        // 库内成员 = collected 系 + submitted；草稿不在库，归档行退出（权威交给远端）。
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/draft", "o", "draft"))
            .unwrap();
        db.upsert_custom_app_payload(&draft_item("o/collected", "o", "collected"))
            .unwrap();
        db.mark_custom_app_collected("o/collected").unwrap();
        db.upsert_custom_app_payload(&draft_item("o/sub", "o", "sub"))
            .unwrap();
        db.mark_custom_app_collected("o/sub").unwrap();
        db.mark_custom_app_submitted("o/sub", "https://github.com/x/y/pull/1")
            .unwrap();
        db.upsert_custom_app_payload(&draft_item("o/arch", "o", "arch"))
            .unwrap();
        db.mark_custom_app_collected("o/arch").unwrap();
        db.retire_custom_apps_on_sync(&["o/arch".to_string()])
            .unwrap();

        let ids: Vec<String> = db
            .list_local_library_apps()
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(ids.len(), 2, "unexpected library members: {ids:?}");
        assert!(ids.contains(&"o/collected".to_string()));
        assert!(ids.contains(&"o/sub".to_string()));
        assert!(!ids.contains(&"o/draft".to_string()));
        assert!(!ids.contains(&"o/arch".to_string()));
        assert_eq!(db.list_local_library_items().unwrap().len(), 2);

        // 单行取件同口径（详情/安装回退）。
        let sub = db
            .get_collected_custom_item("o/sub")
            .unwrap()
            .expect("submitted stays in library");
        assert_eq!(sub.status, CUSTOM_APP_STATUS_SUBMITTED);
        assert!(db.get_collected_custom_item("o/draft").unwrap().is_none());
        assert!(db.get_collected_custom_item("o/arch").unwrap().is_none());

        // 门禁仍按 collected 系：submitted 不可重收录、不可退回草稿。
        assert!(db.mark_custom_app_collected("o/sub").is_err());
        assert!(db.revert_collected_to_draft("o/sub").is_err());
    }

    #[test]
    fn withdraw_submitted_keeps_payload_and_allows_resubmit() {
        // 撤下：submitted → collected，pr_url 清空，payload 不变，可再次提交。
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/r", "o", "r"))
            .unwrap();
        db.mark_custom_app_collected("o/r").unwrap();
        let before = db.get_custom_app("o/r").unwrap().unwrap();
        let submitted = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .unwrap();
        assert_eq!(submitted.status, CUSTOM_APP_STATUS_SUBMITTED);

        let withdrawn = db.withdraw_submitted("o/r").unwrap();
        assert_eq!(withdrawn.status, CUSTOM_APP_STATUS_COLLECTED);
        assert!(withdrawn.pr_url.is_none());
        assert!(!withdrawn.archived);
        assert_eq!(
            serde_json::to_string(&withdrawn.item).unwrap(),
            serde_json::to_string(&before.item).unwrap(),
            "payload must stay untouched"
        );

        // 落盘断言：重读同口径（不只看返回值）。
        let stored = db.get_custom_app("o/r").unwrap().unwrap();
        assert_eq!(stored.status, CUSTOM_APP_STATUS_COLLECTED);
        assert!(stored.pr_url.is_none());

        // 回到库内待提交态：仍在本地库且可重新提交。
        assert!(db.get_collected_custom_item("o/r").unwrap().is_some());
        let resubmitted = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/2")
            .unwrap();
        assert_eq!(resubmitted.status, CUSTOM_APP_STATUS_SUBMITTED);
        assert_eq!(
            resubmitted.pr_url.as_deref(),
            Some("https://github.com/x/y/pull/2")
        );
    }

    #[test]
    fn withdraw_submitted_rejects_archived_and_non_submitted() {
        let db = Database::open_in_memory().unwrap();
        // 不存在行拒绝。
        assert!(db.withdraw_submitted("o/missing").is_err());
        // 草稿态不可撤下。
        db.upsert_custom_app_payload(&draft_item("o/draft", "o", "draft"))
            .unwrap();
        let err = db
            .withdraw_submitted("o/draft")
            .expect_err("draft cannot withdraw");
        assert!(err.to_string().contains("仅已提交行可标记为未提交"));
        // 已收录未提交不可撤下。
        db.upsert_custom_app_payload(&draft_item("o/collected", "o", "collected"))
            .unwrap();
        db.mark_custom_app_collected("o/collected").unwrap();
        let err = db
            .withdraw_submitted("o/collected")
            .expect_err("collected cannot withdraw");
        assert!(err.to_string().contains("仅已提交行可标记为未提交"));
        // 已归档 submitted 拒绝，状态不复活。
        db.upsert_custom_app_payload(&draft_item("o/arch", "o", "arch"))
            .unwrap();
        db.mark_custom_app_collected("o/arch").unwrap();
        db.mark_custom_app_submitted("o/arch", "https://github.com/x/y/pull/1")
            .unwrap();
        db.retire_custom_apps_on_sync(&["o/arch".to_string()])
            .unwrap();
        let err = db
            .withdraw_submitted("o/arch")
            .expect_err("archived cannot withdraw");
        assert!(err.to_string().contains("已转正归档"));
        let stored = db.get_custom_app("o/arch").unwrap().unwrap();
        assert!(stored.archived);
        assert_eq!(stored.status, CUSTOM_APP_STATUS_SUBMITTED);
    }

    #[test]
    fn collected_helpers_accept_legacy_local_collected_literal() {
        // on-disk `local_collected` 字面与 `collected` 同义：判定/列表both match。
        assert!(is_collected_status("collected"));
        assert!(is_collected_status("local_collected"));
        assert!(!is_collected_status("draft"));
        // 库内谓词另含 submitted；Issue/退回门禁谓词仍拒绝 submitted。
        assert!(is_local_library_status("collected"));
        assert!(is_local_library_status("local_collected"));
        assert!(is_local_library_status("submitted"));
        assert!(!is_local_library_status("draft"));
        assert!(!is_collected_status("submitted"));
        let db = Database::open_in_memory().unwrap();
        db.upsert_custom_app_payload(&draft_item("o/l", "o", "l"))
            .unwrap();
        db.exec_upsert(
            "UPDATE custom_apps SET status = 'local_collected' WHERE id = 'o/l'",
            [],
        )
        .unwrap();
        let stored = db.get_custom_app("o/l").unwrap().unwrap();
        assert!(is_local_library_entry(&stored));
        assert!(db.get_collected_custom_item("o/l").unwrap().is_some());
        assert_eq!(db.list_local_library_apps().unwrap().len(), 1);
        // on-disk literal can also revert and persist.
        let reverted = db.revert_collected_to_draft("o/l").unwrap();
        assert_eq!(reverted.status, CUSTOM_APP_STATUS_DRAFT);
        assert!(db.list_local_library_apps().unwrap().is_empty());
    }

    /// 草稿校验契约（parity）：与前端 `PendingView.validationParity.test.ts` 共用
    /// `tests/fixtures/draft-validation-cases.json`，断言 ok 与首个阻断字段一致
    /// （UI 即时镜像 ↔ 权威门禁不漂移；新增规则先加样例）。
    #[derive(serde::Deserialize)]
    struct ParityFixture {
        gate: ParityGate,
        cases: Vec<ParityCase>,
    }

    #[derive(serde::Deserialize, Clone)]
    struct ParityGate {
        enabled: bool,
        allowed: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct ParityCase {
        name: String,
        mode: String,
        item: ParityItem,
        #[serde(default)]
        gate: Option<ParityGate>,
        expect: ParityExpect,
    }

    #[derive(serde::Deserialize)]
    struct ParityItem {
        id: String,
        owner: String,
        repo: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        category: String,
        #[serde(default)]
        homepage: Option<String>,
        #[serde(default)]
        license: String,
    }

    #[derive(serde::Deserialize)]
    struct ParityExpect {
        ok: bool,
        #[serde(default)]
        field: Option<String>,
    }

    /// 错误消息 → 首个阻断字段桶（顺序与 `validate_custom_item` 检查顺序一致）。
    fn parity_blocked_field(message: &str) -> &'static str {
        if message.starts_with("仅支持 GitHub owner/repo")
            || message.starts_with("仓库坐标")
            || message.starts_with("无法识别的应用标识")
            || message.starts_with("草稿 id")
        {
            "identity"
        } else if message.starts_with("应用名称") {
            "name"
        } else if message.starts_with("应用描述") {
            "description"
        } else if message.starts_with("功能分类") {
            "category"
        } else if message.starts_with("官方主页") {
            "homepage"
        } else if message.starts_with("开源协议") || message.starts_with("仅收录 OSI") {
            "license"
        } else {
            "unknown"
        }
    }

    fn parity_item(item: &ParityItem) -> CatalogItem {
        let mut base = draft_item(&item.id, &item.owner, &item.repo);
        base.name = item.name.clone();
        base.description = item.description.clone();
        base.category = item.category.clone();
        base.homepage = item.homepage.clone();
        base.license = item.license.clone();
        base
    }

    #[test]
    fn draft_validation_matches_shared_parity_cases() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/draft-validation-cases.json"
        ));
        let fixture: ParityFixture = serde_json::from_str(raw).expect("parity fixture parses");
        assert!(!fixture.cases.is_empty(), "parity fixture must not be empty");
        for case in &fixture.cases {
            let gate_cfg = case.gate.clone().unwrap_or_else(|| fixture.gate.clone());
            let gate = LicenseGateConfig {
                enabled: gate_cfg.enabled,
                allowed: gate_cfg.allowed,
            };
            let mode = match case.mode.as_str() {
                "draft" => ValidateMode::DraftLenient,
                "submit" => ValidateMode::SubmitStrict,
                other => panic!("unknown parity mode: {other}"),
            };
            let outcome = validate_custom_item(&parity_item(&case.item), mode, &gate);
            match (outcome, case.expect.ok) {
                (Ok(_), true) => {}
                (Err(message), false) => {
                    assert_eq!(
                        parity_blocked_field(&message),
                        case.expect.field.as_deref().unwrap_or(""),
                        "case '{}' unexpected error: {}",
                        case.name,
                        message
                    );
                }
                (Ok(_), false) => panic!("case '{}' expected failure but passed", case.name),
                (Err(message), true) => {
                    panic!("case '{}' expected ok, got: {}", case.name, message)
                }
            }
        }
    }
}
