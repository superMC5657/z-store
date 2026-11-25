//! `repo_card_cache` 持久化 DAO：未收录应用的单仓轻量富卡缓存。

use super::{clean, now_secs, Database, BATCH_CHUNK};
use crate::github::models::{
    is_placeholder_description, is_placeholder_license, is_placeholder_version,
};
use crate::models::{AppCore, AppSummary};
use rusqlite::{params, OptionalExtension, Result};
use std::collections::{HashMap, HashSet};

/// 单仓富卡表最大保留行数（按 `last_accessed_at DESC` LRU 淘汰）。
pub const REPO_CARD_CACHE_MAX_ROWS: usize = 2000;
/// 单仓富卡新鲜窗口：12 小时内的完整卡片可免除 enrich / 平台推导网络请求。
pub const REPO_CARD_FRESH_TTL_SECS: i64 = 12 * 3600;

const DEFAULT_CATEGORY: &str = "external";
const DEFAULT_CATEGORY_NAME: &str = "跨平台开源";
const LOADING_NAME: &str = "加载中...";

/// 写入入参：完整仓库元数据（搜索 / 趋势 enrich / Star 列表 / 详情页）。
#[derive(Debug, Clone)]
pub struct RepoCardUpsert {
    pub summary: AppSummary,
    /// 平台为空且已确认无可安装资产（真实零发布或无匹配资产）。
    pub confirmed_other: bool,
    /// `None` 保留库内原值（新行默认公开）。
    pub is_private: Option<bool>,
}

/// 读出模型：收录态标注一律缺席，`is_verified = false`，空版本还原为 `latest`。
#[derive(Debug, Clone)]
pub struct StoredRepoCard {
    pub summary: AppSummary,
    pub confirmed_other: bool,
    pub is_private: bool,
    pub updated_at: i64,
    pub last_accessed_at: i64,
}

/// 平台快径读出（含 `updated_at = 0` 的平台预写行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoCardPlatformState {
    pub platforms: Vec<String>,
    pub latest_version: String,
    pub confirmed_other: bool,
    /// 平台信息的新鲜度基准：完整卡取 `updated_at`，预写行取 `last_accessed_at`。
    pub fresh_at: i64,
}

/// 单行只读快照：平台态（含预写壳）+ 完整卡片（`updated_at > 0` 才有）。
#[derive(Debug, Clone)]
pub struct RepoCardSnapshot {
    pub platform: RepoCardPlatformState,
    pub card: Option<StoredRepoCard>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CardRow {
    id: String,
    name: String,
    owner: String,
    repo: String,
    description: String,
    description_en: Option<String>,
    icon: String,
    icon_bg: String,
    stars: i64,
    forks: i64,
    license: String,
    latest_version: String,
    category: String,
    category_name: String,
    forge: String,
    forge_host: String,
    homepage: Option<String>,
    platforms: Vec<String>,
    confirmed_other: bool,
    is_private: bool,
    updated_at: i64,
    last_accessed_at: i64,
}

const SELECT_COLS: &str = "id, name, owner, repo, description, description_en, icon, icon_bg, \
    stars, forks, license, latest_version, category, category_name, forge, forge_host, homepage, \
    platforms_json, confirmed_other, is_private, updated_at, last_accessed_at";

fn row_to_card(row: &rusqlite::Row<'_>) -> Result<CardRow> {
    let platforms_json: String = row.get(17)?;
    Ok(CardRow {
        id: row.get(0)?,
        name: row.get(1)?,
        owner: row.get(2)?,
        repo: row.get(3)?,
        description: row.get(4)?,
        description_en: row.get(5)?,
        icon: row.get(6)?,
        icon_bg: row.get(7)?,
        stars: row.get(8)?,
        forks: row.get(9)?,
        license: row.get(10)?,
        latest_version: row.get(11)?,
        category: row.get(12)?,
        category_name: row.get(13)?,
        forge: row.get(14)?,
        forge_host: row.get(15)?,
        homepage: row.get(16)?,
        platforms: parse_platforms(&platforms_json),
        confirmed_other: row.get::<_, i64>(18)? != 0,
        is_private: row.get::<_, i64>(19)? != 0,
        updated_at: row.get(20)?,
        last_accessed_at: row.get(21)?,
    })
}

fn parse_platforms(raw: &str) -> Vec<String> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

fn clean_platforms(platforms: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in platforms {
        let t = p.trim();
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// 图标写库清洗：仅保留远端 `http(s)` 地址；`data:`、README 正文大图与其他形态剥空。
pub(crate) fn sanitize_card_icon(icon: &str) -> String {
    let t = icon.trim();
    if t.is_empty() {
        return String::new();
    }
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("data:") || crate::icons::is_body_image_url(t) {
        return String::new();
    }
    if lower.starts_with("https://") || lower.starts_with("http://") {
        t.to_string()
    } else {
        String::new()
    }
}

fn sanitize_description(s: &str) -> String {
    if is_placeholder_description(s) {
        String::new()
    } else {
        s.trim().to_string()
    }
}

/// 协议占位归一为空串；GitHub 源保留搜索回退写入的 `OpenSource` 原值。
fn sanitize_license(s: &str, forge: &str) -> String {
    let t = s.trim();
    if is_placeholder_license(t) && !(forge == "github" && t == "OpenSource") {
        String::new()
    } else {
        t.to_string()
    }
}

/// 版本占位（见 [`is_placeholder_version`]）归一为空串。
pub(crate) fn sanitize_card_version(s: &str) -> String {
    if is_placeholder_version(s) {
        String::new()
    } else {
        s.trim().to_string()
    }
}

fn is_generic_category(s: &str) -> bool {
    let t = s.trim();
    t.is_empty() || t == DEFAULT_CATEGORY
}

fn non_empty_or(inc: String, prev: Option<&String>) -> String {
    if inc.is_empty() {
        prev.cloned().unwrap_or_default()
    } else {
        inc
    }
}

/// 平台三态单调合并：返回 `(platforms, confirmed_other)`。
fn merge_platform_state(
    prev: Option<(&[String], bool)>,
    inc_platforms: &[String],
    inc_confirmed_other: bool,
) -> (Vec<String>, bool) {
    if !inc_platforms.is_empty() {
        return (inc_platforms.to_vec(), false);
    }
    let (prev_platforms, prev_confirmed) = prev.unwrap_or((&[], false));
    if !prev_platforms.is_empty() {
        return (prev_platforms.to_vec(), false);
    }
    (Vec::new(), inc_confirmed_other || prev_confirmed)
}

/// 非破坏单调合并：入站值清洗后与旧行逐字段合并；无效坐标返回 `None`。
fn merge_card(prev: Option<&CardRow>, inc: &RepoCardUpsert, now: i64) -> Option<CardRow> {
    let core = &inc.summary.core;
    let id = crate::forge::canonical_app_id(&core.id)?;
    let owner = core.owner.trim();
    let repo = core.repo.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    let forge = core
        .forge
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("github")
        .to_string();
    let forge_host = core
        .forge_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("github.com")
        .to_string();

    let inc_name = core.name.trim();
    let name = if inc_name.is_empty() || inc_name == LOADING_NAME {
        prev.map(|p| p.name.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| repo.to_string())
    } else {
        inc_name.to_string()
    };

    let description = non_empty_or(
        sanitize_description(&core.description),
        prev.map(|p| &p.description),
    );
    let description_en = core
        .description_en
        .as_deref()
        .map(sanitize_description)
        .filter(|s| !s.is_empty())
        .or_else(|| prev.and_then(|p| p.description_en.clone()))
        .filter(|s| !s.trim().is_empty());
    let license = non_empty_or(
        sanitize_license(&core.license, &forge),
        prev.map(|p| &p.license),
    );
    let latest_version = non_empty_or(
        sanitize_card_version(&core.latest_version),
        prev.map(|p| &p.latest_version),
    );

    let keep_prev_category = is_generic_category(&core.category)
        && prev.is_some_and(|p| !is_generic_category(&p.category));
    let (category, category_name, icon_bg) = match prev {
        Some(p) if keep_prev_category => (
            p.category.clone(),
            p.category_name.clone(),
            non_empty_or(String::new(), Some(&p.icon_bg)),
        ),
        _ => {
            let category = if is_generic_category(&core.category) {
                DEFAULT_CATEGORY.to_string()
            } else {
                core.category.trim().to_string()
            };
            let category_name = if core.category_name.trim().is_empty() {
                DEFAULT_CATEGORY_NAME.to_string()
            } else {
                core.category_name.trim().to_string()
            };
            let icon_bg = non_empty_or(core.icon_bg.trim().to_string(), prev.map(|p| &p.icon_bg));
            (category, category_name, icon_bg)
        }
    };

    let homepage = core
        .homepage
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| prev.and_then(|p| p.homepage.clone()));
    let icon = non_empty_or(sanitize_card_icon(&core.icon), prev.map(|p| &p.icon));

    let inc_stars = core.stars as i64;
    let stars = match prev {
        Some(p) if inc_stars == 0 && p.stars > 0 => p.stars,
        _ => inc_stars,
    };
    let inc_forks = core.forks as i64;
    let forks = match prev {
        Some(p) if inc_forks == 0 && p.forks > 0 => p.forks,
        _ => inc_forks,
    };

    let (platforms, confirmed_other) = merge_platform_state(
        prev.map(|p| (p.platforms.as_slice(), p.confirmed_other)),
        &clean_platforms(&core.platforms),
        inc.confirmed_other,
    );
    let is_private = inc
        .is_private
        .unwrap_or_else(|| prev.is_some_and(|p| p.is_private));

    Some(CardRow {
        id,
        name,
        owner: owner.to_string(),
        repo: repo.to_string(),
        description,
        description_en,
        icon,
        icon_bg,
        stars,
        forks,
        license,
        latest_version,
        category,
        category_name,
        forge,
        forge_host,
        homepage,
        platforms,
        confirmed_other,
        is_private,
        updated_at: now,
        last_accessed_at: now,
    })
}

fn card_to_platform_state(card: &CardRow) -> RepoCardPlatformState {
    RepoCardPlatformState {
        fresh_at: if card.updated_at > 0 {
            card.updated_at
        } else {
            card.last_accessed_at
        },
        platforms: card.platforms.clone(),
        latest_version: card.latest_version.clone(),
        confirmed_other: card.confirmed_other,
    }
}

fn card_to_snapshot(card: CardRow) -> RepoCardSnapshot {
    RepoCardSnapshot {
        platform: card_to_platform_state(&card),
        card: (card.updated_at > 0).then(|| card_to_stored(card)),
    }
}

fn card_to_stored(card: CardRow) -> StoredRepoCard {
    let latest_version = if card.latest_version.trim().is_empty() {
        "latest".to_string()
    } else {
        card.latest_version
    };
    StoredRepoCard {
        summary: AppSummary {
            core: AppCore {
                id: card.id,
                name: card.name,
                description_en: card.description_en,
                owner: card.owner,
                repo: card.repo,
                icon: card.icon,
                icon_bg: card.icon_bg,
                description: card.description,
                stars: card.stars.max(0) as u64,
                forks: card.forks.max(0) as u64,
                license: card.license,
                latest_version,
                category: card.category,
                category_name: card.category_name,
                is_verified: false,
                forge: Some(card.forge),
                forge_host: Some(card.forge_host),
                homepage: card.homepage,
                platforms: card.platforms,
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
        },
        confirmed_other: card.confirmed_other,
        is_private: card.is_private,
        updated_at: card.updated_at,
        last_accessed_at: card.last_accessed_at,
    }
}

/// 已收录判定 SQL 片段：远端精选或未归档本地库（`collected`/`local_collected`/`submitted`）。
const CATALOGED_IDS_SQL: &str = "SELECT lower(id) FROM catalog_apps \
    UNION SELECT lower(id) FROM custom_apps \
    WHERE archived = 0 AND status IN ('collected', 'local_collected', 'submitted')";

/// 规范 `id` 清洗并去重（保序）。
fn dedup_canonical_ids<'a>(raws: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    raws.into_iter()
        .filter_map(crate::forge::canonical_app_id)
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

impl Database {
    fn get_card_row(&self, id: &str) -> Result<Option<CardRow>> {
        let sql = format!("SELECT {SELECT_COLS} FROM repo_card_cache WHERE id = ?1 LIMIT 1");
        self.conn
            .query_row(&sql, params![id], row_to_card)
            .optional()
    }

    fn is_cataloged_card_id(&self, id: &str) -> Result<bool> {
        self.record_exists(
            "SELECT 1 FROM catalog_apps WHERE lower(id) = ?1
             UNION ALL
             SELECT 1 FROM custom_apps WHERE lower(id) = ?1 AND archived = 0
                AND status IN ('collected', 'local_collected', 'submitted')
             LIMIT 1",
            params![id],
        )
    }

    fn write_card_row(&self, card: &CardRow) -> Result<()> {
        let platforms_json = serde_json::to_string(&card.platforms).unwrap_or_else(|_| "[]".into());
        self.exec_write(
            r#"
            INSERT INTO repo_card_cache (
                id, name, owner, repo, description, description_en, icon, icon_bg,
                stars, forks, license, latest_version, category, category_name,
                forge, forge_host, homepage, platforms_json, confirmed_other, is_private,
                updated_at, last_accessed_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22
            )
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                owner = excluded.owner,
                repo = excluded.repo,
                description = excluded.description,
                description_en = excluded.description_en,
                icon = excluded.icon,
                icon_bg = excluded.icon_bg,
                stars = excluded.stars,
                forks = excluded.forks,
                license = excluded.license,
                latest_version = excluded.latest_version,
                category = excluded.category,
                category_name = excluded.category_name,
                forge = excluded.forge,
                forge_host = excluded.forge_host,
                homepage = excluded.homepage,
                platforms_json = excluded.platforms_json,
                confirmed_other = excluded.confirmed_other,
                is_private = excluded.is_private,
                updated_at = excluded.updated_at,
                last_accessed_at = excluded.last_accessed_at;
            "#,
            params![
                card.id,
                card.name,
                card.owner,
                card.repo,
                card.description,
                card.description_en,
                card.icon,
                card.icon_bg,
                card.stars,
                card.forks,
                card.license,
                card.latest_version,
                card.category,
                card.category_name,
                card.forge,
                card.forge_host,
                card.homepage,
                platforms_json,
                card.confirmed_other as i64,
                card.is_private as i64,
                card.updated_at,
                card.last_accessed_at,
            ],
        )?;
        Ok(())
    }

    /// 单条合并写（不开事务，可在外层事务内调用）；已收录或坐标无效返回 `false`。
    fn upsert_repo_card_at(&self, inc: &RepoCardUpsert, now: i64) -> Result<bool> {
        let Some(id) = crate::forge::canonical_app_id(&inc.summary.core.id) else {
            return Ok(false);
        };
        if self.is_cataloged_card_id(&id)? {
            return Ok(false);
        }
        let prev = self.get_card_row(&id)?;
        let Some(merged) = merge_card(prev.as_ref(), inc, now) else {
            return Ok(false);
        };
        self.write_card_row(&merged)?;
        Ok(true)
    }

    /// 按规范 `id` 批量预读已有行（含 `updated_at = 0` 的平台预写壳）。
    fn get_card_rows_batch(&self, ids: &[String]) -> Result<HashMap<String, CardRow>> {
        let rows = self.query_in_chunks(
            ids,
            |ph| format!("SELECT {SELECT_COLS} FROM repo_card_cache WHERE id IN ({ph})"),
            row_to_card,
        )?;
        Ok(rows.into_iter().map(|r| (r.id.clone(), r)).collect())
    }

    /// 本批规范 `id` 中已收录（远端精选或未归档本地库）的子集。
    fn cataloged_card_ids_batch(&self, ids: &[String]) -> Result<HashSet<String>> {
        // 同一分片在两个 `IN (...)` 中各绑定一次：分片取半，占位符总数仍不超过 `BATCH_CHUNK`。
        let mut out = HashSet::new();
        for chunk in ids.chunks(BATCH_CHUNK / 2) {
            let ph = vec!["?"; chunk.len()].join(", ");
            let sql = format!(
                "SELECT lower(id) FROM catalog_apps WHERE lower(id) IN ({ph}) \
                 UNION SELECT lower(id) FROM custom_apps WHERE lower(id) IN ({ph}) \
                 AND archived = 0 AND status IN ('collected', 'local_collected', 'submitted')"
            );
            let params = chunk.iter().chain(chunk.iter());
            out.extend(self.query_vec_uncached(
                &sql,
                rusqlite::params_from_iter(params),
                |row| row.get::<_, String>(0),
            )?);
        }
        Ok(out)
    }

    /// 批量合并写核心（不开事务）：常数次分片预读已有行与已收录集，再逐条合并写入。
    /// `skip_cataloged_check = true` 时调用方保证入参均未收录（已经内存目录过滤）。
    fn upsert_repo_cards_in(
        &self,
        items: &[RepoCardUpsert],
        now: i64,
        skip_cataloged_check: bool,
    ) -> Result<usize> {
        let ids = dedup_canonical_ids(items.iter().map(|inc| inc.summary.core.id.as_str()));
        if ids.is_empty() {
            return Ok(0);
        }
        let cataloged = if skip_cataloged_check {
            HashSet::new()
        } else {
            self.cataloged_card_ids_batch(&ids)?
        };
        let mut prev_rows = self.get_card_rows_batch(&ids)?;
        let mut written = 0usize;
        for inc in items {
            let Some(id) = crate::forge::canonical_app_id(&inc.summary.core.id) else {
                continue;
            };
            if cataloged.contains(&id) {
                continue;
            }
            let Some(merged) = merge_card(prev_rows.get(&id), inc, now) else {
                continue;
            };
            self.write_card_row(&merged)?;
            // 同批重复 id 依次合并：后者以前者写入结果为基线。
            prev_rows.insert(id, merged);
            written += 1;
        }
        Ok(written)
    }

    fn prune_repo_card_cache_if_over(&self) -> Result<()> {
        let count: i64 = self
            .query_scalar_opt("SELECT COUNT(*) FROM repo_card_cache", [])?
            .unwrap_or(0);
        if count as usize > REPO_CARD_CACHE_MAX_ROWS {
            self.prune_repo_card_cache(REPO_CARD_CACHE_MAX_ROWS)?;
        }
        Ok(())
    }

    /// 单条非破坏写入（不开事务，可嵌入详情落库等外层事务）。
    pub fn upsert_repo_card(&self, inc: &RepoCardUpsert) -> Result<bool> {
        let written = self.upsert_repo_card_at(inc, now_secs())?;
        if written {
            self.prune_repo_card_cache_if_over()?;
        }
        Ok(written)
    }

    /// 批量非破坏写入（单事务），返回实际写入行数；已收录 `id` 经一次分片查询过滤。
    pub fn upsert_repo_cards_batch(&self, items: &[RepoCardUpsert]) -> Result<usize> {
        self.upsert_repo_cards_batch_with(items, false)
    }

    /// 批量写入已经内存 `CatalogService` 判定为未收录的卡片（跳过已收录查表）。
    pub fn upsert_uncataloged_repo_cards_batch(&self, items: &[RepoCardUpsert]) -> Result<usize> {
        self.upsert_repo_cards_batch_with(items, true)
    }

    fn upsert_repo_cards_batch_with(
        &self,
        items: &[RepoCardUpsert],
        skip_cataloged_check: bool,
    ) -> Result<usize> {
        if items.is_empty() {
            return Ok(0);
        }
        let now = now_secs();
        self.with_immediate_transaction(|| {
            let written = self.upsert_repo_cards_in(items, now, skip_cataloged_check)?;
            if written > 0 {
                self.prune_repo_card_cache_if_over()?;
            }
            Ok(written)
        })
    }

    /// 平台/版本轻量补丁（来自 `get_platforms_lite`）：已有行按三态单调规则合并且保持 `updated_at`；
    /// 无行时预写 `updated_at = 0` 的平台壳（批量水合不可见，待完整元数据到达时继承）。
    pub fn patch_repo_card_platforms(
        &self,
        raw_id: &str,
        owner: &str,
        repo: &str,
        platforms: &[String],
        latest_version: Option<&str>,
        confirmed_other: bool,
    ) -> Result<()> {
        let Some(id) = crate::forge::canonical_app_id(raw_id) else {
            return Ok(());
        };
        let (owner, repo) = (clean(owner), clean(repo));
        if owner.is_empty() || repo.is_empty() || self.is_cataloged_card_id(&id)? {
            return Ok(());
        }
        let inc_platforms = clean_platforms(platforms);
        let inc_version = latest_version
            .map(sanitize_card_version)
            .unwrap_or_default();
        let now = now_secs();
        match self.get_card_row(&id)? {
            Some(mut prev) => {
                let (next_platforms, next_confirmed) = merge_platform_state(
                    Some((prev.platforms.as_slice(), prev.confirmed_other)),
                    &inc_platforms,
                    confirmed_other,
                );
                prev.platforms = next_platforms;
                prev.confirmed_other = next_confirmed;
                if !inc_version.is_empty() {
                    prev.latest_version = inc_version;
                }
                prev.last_accessed_at = now;
                self.write_card_row(&prev)?;
            }
            None => {
                if inc_platforms.is_empty() && !confirmed_other {
                    return Ok(());
                }
                let seed = CardRow {
                    id,
                    name: repo.to_string(),
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    category: DEFAULT_CATEGORY.to_string(),
                    category_name: DEFAULT_CATEGORY_NAME.to_string(),
                    forge: "github".to_string(),
                    forge_host: "github.com".to_string(),
                    confirmed_other: inc_platforms.is_empty() && confirmed_other,
                    platforms: inc_platforms,
                    latest_version: inc_version,
                    updated_at: 0,
                    last_accessed_at: now,
                    ..CardRow::default()
                };
                self.write_card_row(&seed)?;
                self.prune_repo_card_cache_if_over()?;
            }
        }
        Ok(())
    }

    /// 图标同步（流式补图 / 详情图标轮换）：清洗后为空且 `!allow_clear` 时不动；不改 `updated_at`。
    pub fn sync_repo_card_icon(
        &self,
        raw_id: &str,
        new_icon: &str,
        allow_clear: bool,
    ) -> Result<bool> {
        let Some(id) = crate::forge::canonical_app_id(raw_id) else {
            return Ok(false);
        };
        let icon = sanitize_card_icon(new_icon);
        if icon.is_empty() && !allow_clear {
            return Ok(false);
        }
        let rows = self.exec_write(
            "UPDATE repo_card_cache SET icon = ?1 WHERE id = ?2",
            params![icon, id],
        )?;
        Ok(rows > 0)
    }

    /// 读取完整卡片（`updated_at > 0`，平台预写壳不可见）。
    pub fn get_repo_card(&self, raw_id: &str) -> Result<Option<StoredRepoCard>> {
        let Some(id) = crate::forge::canonical_app_id(raw_id) else {
            return Ok(None);
        };
        Ok(self
            .get_card_row(&id)?
            .filter(|c| c.updated_at > 0)
            .map(card_to_stored))
    }

    /// 平台快径读出（含预写壳）。
    pub fn get_repo_card_platform_state(
        &self,
        raw_id: &str,
    ) -> Result<Option<RepoCardPlatformState>> {
        let Some(id) = crate::forge::canonical_app_id(raw_id) else {
            return Ok(None);
        };
        Ok(self.get_card_row(&id)?.as_ref().map(card_to_platform_state))
    }

    /// 批量只读快照（单次分片查询）：平台态含预写壳，完整卡片仅 `updated_at > 0`；按规范 `id` 索引。
    pub fn get_repo_card_snapshots_batch(
        &self,
        raw_ids: &[String],
    ) -> Result<HashMap<String, RepoCardSnapshot>> {
        let ids = dedup_canonical_ids(raw_ids.iter().map(String::as_str));
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        Ok(self
            .get_card_rows_batch(&ids)?
            .into_iter()
            .map(|(id, row)| (id, card_to_snapshot(row)))
            .collect())
    }

    /// 批量读取完整卡片并刷新命中行 `last_accessed_at`，返回按规范 `id` 索引的映射。
    pub fn get_repo_cards_batch_and_touch(
        &self,
        raw_ids: &[String],
        now: i64,
    ) -> Result<HashMap<String, StoredRepoCard>> {
        let ids = dedup_canonical_ids(raw_ids.iter().map(String::as_str));
        let mut out = HashMap::new();
        for chunk in ids.chunks(BATCH_CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let select = format!(
                "SELECT {SELECT_COLS} FROM repo_card_cache WHERE updated_at > 0 AND id IN ({placeholders})"
            );
            let rows = self.query_vec_uncached(
                &select,
                rusqlite::params_from_iter(chunk.iter()),
                row_to_card,
            )?;
            if rows.is_empty() {
                continue;
            }
            let hit_placeholders = vec!["?"; rows.len()].join(", ");
            let update = format!(
                "UPDATE repo_card_cache SET last_accessed_at = ? WHERE id IN ({hit_placeholders})"
            );
            let mut values: Vec<rusqlite::types::Value> = Vec::with_capacity(rows.len() + 1);
            values.push(now.into());
            values.extend(
                rows.iter()
                    .map(|r| rusqlite::types::Value::from(r.id.clone())),
            );
            self.exec_write_uncached(&update, rusqlite::params_from_iter(values))?;
            for mut row in rows {
                row.last_accessed_at = now;
                out.insert(row.id.clone(), card_to_stored(row));
            }
        }
        Ok(out)
    }

    /// 清除已转正 / 已入本地库的单仓富卡行。
    pub fn purge_cataloged_repo_cards(&self) -> Result<usize> {
        let sql = format!("DELETE FROM repo_card_cache WHERE id IN ({CATALOGED_IDS_SQL})");
        self.exec_write(&sql, [])
    }

    /// 列出 `repo_card_cache` 中所有私有仓库的规范 id。
    pub fn list_private_repo_card_ids(&self) -> Result<Vec<String>> {
        self.query_vec(
            "SELECT id FROM repo_card_cache WHERE is_private = 1",
            [],
            |row| row.get(0),
        )
    }

    /// 登出 / 凭据失效：删除私有仓库富卡。
    pub fn delete_private_repo_cards(&self) -> Result<usize> {
        self.exec_write("DELETE FROM repo_card_cache WHERE is_private = 1", [])
    }

    /// 按 `last_accessed_at DESC` 保留最近访问的 `max_rows` 行。
    pub fn prune_repo_card_cache(&self, max_rows: usize) -> Result<usize> {
        self.exec_write(
            r#"
            DELETE FROM repo_card_cache WHERE id NOT IN (
                SELECT id FROM repo_card_cache
                ORDER BY last_accessed_at DESC, id ASC
                LIMIT ?1
            )
            "#,
            params![max_rows as i64],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str) -> AppSummary {
        let (owner, repo) = id.split_once('/').unwrap();
        AppSummary {
            core: AppCore {
                id: id.to_string(),
                name: repo.to_string(),
                description_en: None,
                owner: owner.to_string(),
                repo: repo.to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: String::new(),
                stars: 0,
                forks: 0,
                license: String::new(),
                latest_version: "latest".to_string(),
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: vec![],
                is_cataloged: Some(false),
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
        }
    }

    fn full(id: &str) -> AppSummary {
        let mut s = summary(id);
        s.core.description = "A real tool".to_string();
        s.core.description_en = Some("A real tool".to_string());
        s.core.icon = "https://avatars.githubusercontent.com/u/1".to_string();
        s.core.icon_bg = "#123456".to_string();
        s.core.stars = 1200;
        s.core.forks = 30;
        s.core.license = "MIT".to_string();
        s.core.latest_version = "v1.2.3".to_string();
        s.core.category = "dev".to_string();
        s.core.category_name = "开发工具".to_string();
        s.core.homepage = Some("https://example.com".to_string());
        s
    }

    fn up(summary: AppSummary, confirmed_other: bool, is_private: Option<bool>) -> RepoCardUpsert {
        RepoCardUpsert {
            summary,
            confirmed_other,
            is_private,
        }
    }

    fn db() -> Database {
        Database::open_in_memory().unwrap()
    }

    #[test]
    fn data_and_body_image_icons_are_stripped_and_never_overwrite_remote_icon() {
        let db = db();
        let mut s = summary("Acme/Tool");
        s.core.icon = "  DATA:image/png;base64,AAAA ".to_string();
        db.upsert_repo_card(&up(s, false, None)).unwrap();
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        assert_eq!(card.summary.core.icon, "");
        assert_eq!(card.summary.core.id, "acme/tool");

        db.upsert_repo_card(&up(full("acme/tool"), false, None))
            .unwrap();
        let mut s = summary("acme/tool");
        s.core.icon = "data:image/svg+xml;base64,BBBB".to_string();
        db.upsert_repo_card(&up(s, false, None)).unwrap();
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        assert_eq!(
            card.summary.core.icon,
            "https://avatars.githubusercontent.com/u/1"
        );

        let mut s = summary("acme/tool");
        s.core.icon = "https://img.shields.io/badge/build-passing-green.svg".to_string();
        db.upsert_repo_card(&up(s, false, None)).unwrap();
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        assert_eq!(
            card.summary.core.icon,
            "https://avatars.githubusercontent.com/u/1"
        );
    }

    #[test]
    fn placeholders_never_overwrite_real_values() {
        let db = db();
        db.upsert_repo_card(&up(full("acme/tool"), false, None))
            .unwrap();
        for desc in [
            "开源软件项目",
            "GitHub 社区开源项目",
            "No description available",
            "  ",
        ] {
            let mut s = summary("acme/tool");
            s.core.name = "加载中...".to_string();
            s.core.description = desc.to_string();
            s.core.description_en = Some(desc.to_string());
            s.core.latest_version = "...".to_string();
            s.core.license = "unknown".to_string();
            s.core.homepage = Some("  ".to_string());
            db.upsert_repo_card(&up(s, false, None)).unwrap();
        }
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        let c = &card.summary.core;
        assert_eq!(c.name, "tool");
        assert_eq!(c.description, "A real tool");
        assert_eq!(c.description_en.as_deref(), Some("A real tool"));
        assert_eq!(c.latest_version, "v1.2.3");
        assert_eq!(c.license, "MIT");
        assert_eq!(c.category, "dev");
        assert_eq!(c.category_name, "开发工具");
        assert_eq!(c.icon_bg, "#123456");
        assert_eq!(c.homepage.as_deref(), Some("https://example.com"));
        assert_eq!(c.stars, 1200);
        assert!(!c.is_verified);
        assert_eq!(c.is_cataloged, None);
        assert_eq!(c.source, None);
    }

    #[test]
    fn empty_version_reads_back_as_latest() {
        let db = db();
        db.upsert_repo_card(&up(summary("acme/tool"), false, None))
            .unwrap();
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        assert_eq!(card.summary.core.latest_version, "latest");
    }

    #[test]
    fn platform_state_upgrades_monotonically() {
        let db = db();
        db.upsert_repo_card(&up(summary("acme/tool"), true, None))
            .unwrap();
        assert!(
            db.get_repo_card("acme/tool")
                .unwrap()
                .unwrap()
                .confirmed_other
        );

        // 未知空平台不冲掉已确认 Other
        db.upsert_repo_card(&up(summary("acme/tool"), false, None))
            .unwrap();
        assert!(
            db.get_repo_card("acme/tool")
                .unwrap()
                .unwrap()
                .confirmed_other
        );

        // 具体平台升级并清零 confirmed_other
        let mut s = summary("acme/tool");
        s.core.platforms = vec!["windows".to_string()];
        db.upsert_repo_card(&up(s, false, None)).unwrap();
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        assert_eq!(card.summary.core.platforms, vec!["windows"]);
        assert!(!card.confirmed_other);

        // 空平台（未知或确认 Other）都不降级具体平台
        db.upsert_repo_card(&up(summary("acme/tool"), false, None))
            .unwrap();
        db.upsert_repo_card(&up(summary("acme/tool"), true, None))
            .unwrap();
        db.patch_repo_card_platforms("acme/tool", "acme", "tool", &[], None, true)
            .unwrap();
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        assert_eq!(card.summary.core.platforms, vec!["windows"]);
        assert!(!card.confirmed_other);
    }

    #[test]
    fn preseeded_platform_rows_hidden_until_full_metadata_arrives() {
        let db = db();
        db.patch_repo_card_platforms(
            "acme/tool",
            "acme",
            "tool",
            &["macos".to_string()],
            Some("v2.0.0"),
            false,
        )
        .unwrap();
        assert!(db.get_repo_card("acme/tool").unwrap().is_none());
        assert!(db
            .get_repo_cards_batch_and_touch(&["acme/tool".to_string()], 10)
            .unwrap()
            .is_empty());
        let state = db
            .get_repo_card_platform_state("acme/tool")
            .unwrap()
            .unwrap();
        assert_eq!(state.platforms, vec!["macos"]);

        let mut s = full("acme/tool");
        s.core.latest_version = "latest".to_string();
        db.upsert_repo_card(&up(s, false, None)).unwrap();
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        assert_eq!(card.summary.core.platforms, vec!["macos"]);
        assert_eq!(card.summary.core.latest_version, "v2.0.0");
        assert!(card.updated_at > 0);
    }

    #[test]
    fn unknown_platform_patch_without_row_is_noop() {
        let db = db();
        db.patch_repo_card_platforms("acme/tool", "acme", "tool", &[], None, false)
            .unwrap();
        assert!(db
            .get_repo_card_platform_state("acme/tool")
            .unwrap()
            .is_none());
    }

    #[test]
    fn batch_touch_and_lru_prune_keep_recent_rows() {
        let db = db();
        let items: Vec<RepoCardUpsert> = ["a/one", "a/two", "a/three"]
            .iter()
            .map(|id| up(full(id), false, None))
            .collect();
        assert_eq!(db.upsert_repo_cards_batch(&items).unwrap(), 3);
        db.exec_write("UPDATE repo_card_cache SET last_accessed_at = 100", [])
            .unwrap();

        let hits = db
            .get_repo_cards_batch_and_touch(&["A/One".to_string(), "a/missing".to_string()], 500)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits["a/one"].last_accessed_at, 500);

        let deleted = db.prune_repo_card_cache(1).unwrap();
        assert_eq!(deleted, 2);
        assert!(db.get_repo_card("a/one").unwrap().is_some());
        assert!(db.get_repo_card("a/two").unwrap().is_none());
    }

    #[test]
    fn purge_and_skip_cataloged_ids() {
        let db = db();
        let items: Vec<RepoCardUpsert> = ["o/remote", "o/local", "o/draft", "o/free"]
            .iter()
            .map(|id| up(full(id), false, None))
            .collect();
        db.upsert_repo_cards_batch(&items).unwrap();
        db.exec_write(
            "INSERT INTO catalog_apps (id, name, owner, repo, category, category_name) VALUES ('o/remote', 'r', 'o', 'remote', 'dev', '开发')",
            [],
        )
        .unwrap();
        db.exec_write(
            "INSERT INTO custom_apps (id, payload_json, status, created_at, updated_at, archived) VALUES
                ('o/local', '{}', 'local_collected', 1, 1, 0),
                ('o/draft', '{}', 'draft', 1, 1, 0)",
            [],
        )
        .unwrap();
        assert_eq!(db.purge_cataloged_repo_cards().unwrap(), 2);
        assert!(db.get_repo_card("o/remote").unwrap().is_none());
        assert!(db.get_repo_card("o/local").unwrap().is_none());
        assert!(db.get_repo_card("o/draft").unwrap().is_some());
        assert!(db.get_repo_card("o/free").unwrap().is_some());

        // 已收录 id 不再写入
        assert!(!db
            .upsert_repo_card(&up(full("o/remote"), false, None))
            .unwrap());
        assert!(db.get_repo_card("o/remote").unwrap().is_none());
    }

    #[test]
    fn private_flag_preserved_on_partial_writes_and_purged() {
        let db = db();
        db.upsert_repo_card(&up(full("me/secret"), false, Some(true)))
            .unwrap();
        db.upsert_repo_card(&up(full("me/public"), false, None))
            .unwrap();
        db.upsert_repo_card(&up(summary("me/secret"), false, None))
            .unwrap();
        assert!(db.get_repo_card("me/secret").unwrap().unwrap().is_private);
        assert_eq!(db.delete_private_repo_cards().unwrap(), 1);
        assert!(db.get_repo_card("me/secret").unwrap().is_none());
        assert!(db.get_repo_card("me/public").unwrap().is_some());
    }

    #[test]
    fn icon_sync_respects_allow_clear() {
        let db = db();
        db.upsert_repo_card(&up(full("acme/tool"), false, None))
            .unwrap();
        let before = db.get_repo_card("acme/tool").unwrap().unwrap().updated_at;
        assert!(!db
            .sync_repo_card_icon("acme/tool", "data:image/png;base64,AA", false)
            .unwrap());
        assert!(db
            .sync_repo_card_icon("acme/tool", "https://example.com/logo.png", false)
            .unwrap());
        let card = db.get_repo_card("acme/tool").unwrap().unwrap();
        assert_eq!(card.summary.core.icon, "https://example.com/logo.png");
        assert_eq!(card.updated_at, before);
        assert!(db.sync_repo_card_icon("acme/tool", "", true).unwrap());
        assert_eq!(
            db.get_repo_card("acme/tool")
                .unwrap()
                .unwrap()
                .summary
                .core
                .icon,
            ""
        );
    }

    #[test]
    fn batch_upsert_skips_cataloged_and_merges_duplicate_ids_in_order() {
        let db = db();
        db.exec_write(
            "INSERT INTO catalog_apps (id, name, owner, repo, category, category_name) VALUES ('o/remote', 'r', 'o', 'remote', 'dev', '开发')",
            [],
        )
        .unwrap();
        let mut second = summary("O/Free");
        second.core.description = "second".to_string();
        let items = vec![
            up(full("o/remote"), false, None),
            up(full("o/free"), false, Some(true)),
            up(second, false, None),
        ];
        assert_eq!(db.upsert_repo_cards_batch(&items).unwrap(), 2);
        assert!(db.get_repo_card("o/remote").unwrap().is_none());
        let card = db.get_repo_card("o/free").unwrap().unwrap();
        // 同批后者以前者写入结果为基线：非占位描述覆盖，私有标记与 Star 保留。
        assert_eq!(card.summary.core.description, "second");
        assert_eq!(card.summary.core.stars, 1200);
        assert!(card.is_private);

        // 内存目录已判定未收录的入口跳过查表。
        assert_eq!(
            db.upsert_uncataloged_repo_cards_batch(&[up(full("o/other"), false, None)])
                .unwrap(),
            1
        );
    }

    #[test]
    fn snapshots_batch_exposes_platform_shells_and_full_cards() {
        let db = db();
        db.patch_repo_card_platforms(
            "acme/shell",
            "acme",
            "shell",
            &["linux".to_string()],
            Some("v1.0.0"),
            false,
        )
        .unwrap();
        db.upsert_repo_card(&up(full("acme/full"), true, None))
            .unwrap();
        let snaps = db
            .get_repo_card_snapshots_batch(&[
                "ACME/Shell".to_string(),
                "acme/full".to_string(),
                "acme/missing".to_string(),
            ])
            .unwrap();
        assert_eq!(snaps.len(), 2);
        let shell = &snaps["acme/shell"];
        assert_eq!(shell.platform.platforms, vec!["linux"]);
        assert!(shell.card.is_none());
        let full = &snaps["acme/full"];
        assert!(full.card.is_some());
        assert_eq!(
            full.platform,
            db.get_repo_card_platform_state("acme/full")
                .unwrap()
                .unwrap()
        );
    }
}
