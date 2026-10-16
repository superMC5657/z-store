//! Lane A 本地自维护草稿 overlay（ADR-0017）：`custom_apps` 表 CRUD + 校验 + 转正。
//!
//! - `id` 为 canonical 小写形态（仅 GitHub `owner/repo`，经 `canonical_app_id()` 归一）；`payload_json` 存完整 `CatalogItem`；
//! - `status=draft/submitted`（已提交另存 `pr_url`）；`archived=1` 为转正归档标记
//!   （`sync_catalog` 命中 canonical id 即归档）；
//! - 二次确认由前端做，后端 `delete` 直接删。

use super::{clean, now_secs, Database};
use crate::github::models::CatalogItem;
use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};

pub const CUSTOM_APP_STATUS_DRAFT: &str = "draft";
pub const CUSTOM_APP_STATUS_SUBMITTED: &str = "submitted";

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

/// 校验档位（Q8 三态）：草稿允许不完整（暂存即存），提交 PR 时才强制全校验（D1 不破）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidateMode {
    /// 暂存档（`save_custom_app`）：仅校验 `id==canonical` 与 `owner/repo` 对齐；
    /// `license` 允许空 / `OpenSource` / `NOASSERTION` / 未知占位，`homepage` 允许空，
    /// `name`/`description`/`category` 允许不完整（Q8 草稿三态）。
    DraftLenient,
    /// 提交档（`mark_submitted` / 预填 PR 链接）：既有全量——必填 +
    /// `homepage` http(s) + OSI 白名单（D1）。
    SubmitStrict,
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

    /// 转正退役：远端 id 集合命中未归档草稿即 `archived=1`，返回转正提示。
    /// 远端 id 经 `canonical_app_id` 归一后比对（大小写漂移行治愈）。
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
        for bad in ["CC-BY-4.0", "Unknown", "NOASSERTION", "", "Proprietary"] {
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
        // 占位 license 草稿可暂存（lenient），但 mark 提交被拦；补真实 SPDX 后放行。
        let db = Database::open_in_memory().unwrap();
        let mut placeholder = draft_item("o/r", "o", "r");
        placeholder.license = "OpenSource".to_string();
        assert!(validate_custom_item(&placeholder, ValidateMode::DraftLenient, &strict_gate()).is_ok());
        db.upsert_custom_app_payload(&placeholder).unwrap();
        let err = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .expect_err("OpenSource draft must be blocked at submit");
        assert!(err.to_string().contains("OSI"), "unexpected: {err}");

        let fixed = draft_item("o/r", "o", "r");
        db.upsert_custom_app_payload(&fixed).unwrap();
        let submitted = db
            .mark_custom_app_submitted("o/r", "https://github.com/x/y/pull/1")
            .unwrap();
        assert_eq!(submitted.status, CUSTOM_APP_STATUS_SUBMITTED);
    }

    #[test]
    fn crud_roundtrip_keeps_status_on_resave() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.list_custom_apps(false).unwrap().is_empty());

        let saved = db.upsert_custom_app_payload(&draft_item("o/r", "o", "r")).unwrap();
        assert_eq!(saved.id, "o/r");
        assert_eq!(saved.status, CUSTOM_APP_STATUS_DRAFT);
        assert!(!saved.archived);

        // 二次暂存仅刷新 payload，不动 status。
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

        // 非法 pr_url 拒绝。
        assert!(db.mark_custom_app_submitted("o/r", "not-a-url").is_err());
        assert!(db.mark_custom_app_submitted("o/r", "").is_err());

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
        assert_eq!(visible, vec!["o/miss".to_string()]);
        let all = db.list_custom_apps(true).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().find(|e| e.id == "o/hit").unwrap().archived);

        // 已归档行拒绝重复提交，不复活。
        assert!(db.mark_custom_app_submitted("o/hit", "https://github.com/x/y/pull/2").is_err());
        // 空远端集合直接空回，不触库。
        assert!(db.retire_custom_apps_on_sync(&[]).unwrap().is_empty());
    }
}
