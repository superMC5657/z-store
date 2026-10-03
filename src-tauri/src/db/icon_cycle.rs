use super::{clean, now_secs, Database};
use crate::forge::coord::RepoRef;
use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppIconCycle {
    pub app_id: String,
    pub owner: String,
    pub repo: String,
    pub is_cataloged: bool,
    pub level: i32,
    pub l1_url: String,
    pub l2_url: String,
    pub l3_url: String,
    pub l4_url: String,
    pub selected_url: String,
    pub cache_file: String,
    pub updated_at: i64,
}

impl Default for AppIconCycle {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            owner: String::new(),
            repo: String::new(),
            is_cataloged: false,
            level: 1,
            l1_url: String::new(),
            l2_url: String::new(),
            l3_url: String::new(),
            l4_url: String::new(),
            selected_url: String::new(),
            cache_file: String::new(),
            updated_at: 0,
        }
    }
}

impl AppIconCycle {
    pub fn new(app_id: impl Into<String>, owner: impl Into<String>, repo: impl Into<String>) -> Self {
        Self {
            app_id: app_id.into(),
            owner: owner.into(),
            repo: repo.into(),
            ..Default::default()
        }
    }

    /// 获取特定级别对应的 URL (1..=4)
    pub fn url_for_level(&self, level: i32) -> Option<&str> {
        match level {
            1 => Some(&self.l1_url),
            2 => Some(&self.l2_url),
            3 => Some(&self.l3_url),
            4 => Some(&self.l4_url),
            _ => None,
        }
    }
}

impl Database {
    /// 查询指定 app_id 的图标轮换记录
    pub fn get_icon_cycle(&self, app_id: &str) -> Result<Option<AppIconCycle>> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(None);
        }

        let mut stmt = self.conn.prepare(
            r#"
            SELECT
                app_id, owner, repo, is_cataloged, level,
                l1_url, l2_url, l3_url, l4_url,
                selected_url, cache_file, updated_at
            FROM app_icon_cycles
            WHERE app_id = ?1
            LIMIT 1
            "#,
        )?;
        let mut rows = stmt.query(params![cleaned])?;
        if let Some(row) = rows.next()? {
            let is_cataloged_int: i64 = row.get(3)?;
            Ok(Some(AppIconCycle {
                app_id: row.get(0)?,
                owner: row.get(1)?,
                repo: row.get(2)?,
                is_cataloged: is_cataloged_int != 0,
                level: row.get(4)?,
                l1_url: row.get(5)?,
                l2_url: row.get(6)?,
                l3_url: row.get(7)?,
                l4_url: row.get(8)?,
                selected_url: row.get(9)?,
                cache_file: row.get(10)?,
                updated_at: row.get(11)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// 根据 owner 与 repo 索引快速查找图标轮换记录
    pub fn get_icon_cycle_by_repo(&self, owner: &str, repo: &str) -> Result<Option<AppIconCycle>> {
        let o = clean(owner);
        let r = clean(repo);
        if o.is_empty() || r.is_empty() {
            return Ok(None);
        }

        let mut stmt = self.conn.prepare(
            r#"
            SELECT
                app_id, owner, repo, is_cataloged, level,
                l1_url, l2_url, l3_url, l4_url,
                selected_url, cache_file, updated_at
            FROM app_icon_cycles
            WHERE owner = ?1 AND repo = ?2
            LIMIT 1
            "#,
        )?;
        let mut rows = stmt.query(params![o, r])?;
        if let Some(row) = rows.next()? {
            let is_cataloged_int: i64 = row.get(3)?;
            Ok(Some(AppIconCycle {
                app_id: row.get(0)?,
                owner: row.get(1)?,
                repo: row.get(2)?,
                is_cataloged: is_cataloged_int != 0,
                level: row.get(4)?,
                l1_url: row.get(5)?,
                l2_url: row.get(6)?,
                l3_url: row.get(7)?,
                l4_url: row.get(8)?,
                selected_url: row.get(9)?,
                cache_file: row.get(10)?,
                updated_at: row.get(11)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// 插入或更新图标轮换记录，主键冲突走 ON CONFLICT(app_id) DO UPDATE SET
    pub fn upsert_icon_cycle(&self, cycle: &AppIconCycle) -> Result<()> {
        let clean_id = clean(&cycle.app_id);
        if clean_id.is_empty() {
            return Ok(());
        }
        let updated_at = if cycle.updated_at == 0 {
            now_secs()
        } else {
            cycle.updated_at
        };
        let is_cataloged_int = if cycle.is_cataloged { 1 } else { 0 };

        self.exec_upsert(
            r#"
            INSERT INTO app_icon_cycles (
                app_id, owner, repo, is_cataloged, level,
                l1_url, l2_url, l3_url, l4_url,
                selected_url, cache_file, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(app_id) DO UPDATE SET
                owner = excluded.owner,
                repo = excluded.repo,
                is_cataloged = excluded.is_cataloged,
                level = excluded.level,
                l1_url = excluded.l1_url,
                l2_url = excluded.l2_url,
                l3_url = excluded.l3_url,
                l4_url = excluded.l4_url,
                selected_url = excluded.selected_url,
                cache_file = excluded.cache_file,
                updated_at = excluded.updated_at;
            "#,
            params![
                clean_id,
                clean(&cycle.owner),
                clean(&cycle.repo),
                is_cataloged_int,
                cycle.level,
                clean(&cycle.l1_url),
                clean(&cycle.l2_url),
                clean(&cycle.l3_url),
                clean(&cycle.l4_url),
                clean(&cycle.selected_url),
                clean(&cycle.cache_file),
                updated_at,
            ],
        )?;
        Ok(())
    }

    /// 批量 upsert（Top1+2：12 条逐条提交 → 1 提交）：
    /// 事务边界：`BEGIN IMMEDIATE` → N 条 `upsert_icon_cycle` → `COMMIT`，失败整体 `ROLLBACK` 返回 Err。
    /// 调用方保持 `let _ =` 吞错语义，下次搜索重试；失败时调用方可回退逐条（见 commands/catalog 调用处）。
    pub fn upsert_icon_cycles_batch(&self, cycles: &[AppIconCycle]) -> Result<()> {
        if cycles.is_empty() {
            return Ok(());
        }
        self.with_immediate_transaction(|| {
            for c in cycles {
                self.upsert_icon_cycle(c)?;
            }
            Ok(())
        })
    }

    /// 更新当前图标轮换级别，并在对应级别 URL 非空时自动同步切换 selected_url
    pub fn set_icon_cycle_level(&self, app_id: &str, level: i32) -> Result<()> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_upsert(
            r#"
            UPDATE app_icon_cycles
            SET level = ?1,
                selected_url = CASE ?1
                    WHEN 1 THEN CASE WHEN l1_url != '' THEN l1_url ELSE selected_url END
                    WHEN 2 THEN CASE WHEN l2_url != '' THEN l2_url ELSE selected_url END
                    WHEN 3 THEN CASE WHEN l3_url != '' THEN l3_url ELSE selected_url END
                    WHEN 4 THEN CASE WHEN l4_url != '' THEN l4_url ELSE selected_url END
                    ELSE selected_url
                END,
                updated_at = ?2
            WHERE app_id = ?3
            "#,
            params![level, now, cleaned],
        )?;
        Ok(())
    }

    /// 更新当前图标轮换级别及选中的 URL 和本地缓存文件路径
    pub fn set_icon_cycle_selected(
        &self,
        app_id: &str,
        level: i32,
        selected_url: &str,
        cache_file: &str,
    ) -> Result<()> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_upsert(
            r#"
            UPDATE app_icon_cycles
            SET level = ?1,
                selected_url = ?2,
                cache_file = ?3,
                updated_at = ?4
            WHERE app_id = ?5
            "#,
            params![level, clean(selected_url), clean(cache_file), now, cleaned],
        )?;
        Ok(())
    }

    /// 删除指定 app_id 的图标轮换记录
    pub fn delete_icon_cycle(&self, app_id: &str) -> Result<bool> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(false);
        }
        let rows = self.exec_upsert(
            "DELETE FROM app_icon_cycles WHERE app_id = ?1",
            params![cleaned],
        )?;
        Ok(rows > 0)
    }

    // --- 便捷别名 (兼容 get / upsert / set_level 简洁调用) ---

    pub fn get(&self, app_id: &str) -> Result<Option<AppIconCycle>> {
        self.get_icon_cycle(app_id)
    }

    pub fn upsert(&self, cycle: &AppIconCycle) -> Result<()> {
        self.upsert_icon_cycle(cycle)
    }

    pub fn set_level(&self, app_id: &str, level: i32) -> Result<()> {
        self.set_icon_cycle_level(app_id, level)
    }
}

/// 模块级便捷函数：根据 app_id 读取图标轮换记录
pub fn get(db: &Database, app_id: &str) -> Result<Option<AppIconCycle>> {
    db.get_icon_cycle(app_id)
}

/// 模块级便捷函数：更新图标轮换级别
pub fn set_level(db: &Database, app_id: &str, level: i32) -> Result<()> {
    db.set_icon_cycle_level(app_id, level)
}

// --- 图标轮换决策 SSOT（Shotgun Surgery 收敛落点） ---
// cataloged vs 非 cataloged 分流、owner/repo 解析（RepoRef）、文件名方案、
// l2/l3/l4 槽位认领、级别推进、详情页图标层级决策 —— 各调用方只做薄委托，
// 不再各自重写分支。纯决策，无 fs/网络/AppState 依赖；零行为变更。

/// 级别→来源映射（原 commands::icons_cycle::source_for_level，本体已搬入此处）。
pub fn source_for_level(level: i32) -> &'static str {
    match level {
        1 => "official",
        2 => "simple-icons",
        3 => "trees",
        4 => "readme",
        _ => "none",
    }
}

/// 级别→是否兜底映射（L1 官方直出非兜底，其余皆兜底）。
pub fn is_fallback_for_level(level: i32) -> bool {
    level > 1
}

/// 入站应用标识解析 SSOT：`RepositoryUrlParser::parse` 优先，`split_once('/')` 回退。
/// 返回 `(canonical 小写 id, 原大小写 owner/repo)`；与原 resolve_app_coord 分支逐一对齐。
pub fn resolve_icon_coord(app_id: &str) -> Result<(String, RepoRef), String> {
    let trimmed = app_id.trim();
    if trimmed.is_empty() {
        return Err("应用标识不能为空".into());
    }

    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(trimmed) {
        if !coord.owner.is_empty() && !coord.repo.is_empty() {
            let canon = coord.to_app_id().to_lowercase();
            return Ok((canon, RepoRef::new(&coord.owner, &coord.repo)));
        }
    }

    if let Some((owner, repo)) = trimmed.split_once('/') {
        let o = owner.trim();
        let r = repo.trim().trim_end_matches(".git");
        if !o.is_empty() && !r.is_empty() && !o.contains('/') && !r.contains('/') {
            let canon = format!("{}/{}", o.to_lowercase(), r.to_lowercase());
            return Ok((canon, RepoRef::new(o, r)));
        }
    }

    Err(format!("无法识别的应用标识: {}", trimmed))
}

/// 获取周期记录中首个有效 URL 对应的级别（收录应用 1..=4，非收录应用 2..=4）。
pub fn first_available_level(cycle: &AppIconCycle) -> Option<i32> {
    let start = if cycle.is_cataloged { 1 } else { 2 };
    for lvl in start..=4 {
        if let Some(u) = cycle.url_for_level(lvl) {
            if !u.trim().is_empty() {
                return Some(lvl);
            }
        }
    }
    None
}

/// 计算下一个轮换级别：空档顺延，5→1/2 回绕。
/// Level 5 为"空"，始终有效；Level 1..=4 当对应 URL 为空时视为"空档"，顺延至下一级别。
/// 非收录应用绝不轮换到 Level 1（官方）。
pub fn next_cycle_level(curr_level: i32, cycle: &AppIconCycle) -> i32 {
    let mut cand = if !(1..=5).contains(&curr_level) {
        if cycle.is_cataloged { 1 } else { 2 }
    } else {
        (curr_level % 5) + 1
    };

    while cand != 5
        && ((!cycle.is_cataloged && cand == 1)
            || cycle.url_for_level(cand).unwrap_or("").trim().is_empty())
    {
        cand = (cand % 5) + 1;
    }
    cand
}

/// 新建 cycle 行的 owner/repo 推导（原 get_or_fetch_icon 内联，逐字对齐）：
/// parse 优先，否则原始 split_once（不过滤多段斜杠），全失败则空串。
pub fn owner_repo_for_new_cycle(lookup_id: &str) -> (String, String) {
    match crate::forge::RepositoryUrlParser::parse(lookup_id) {
        Some(c) => (c.owner, c.repo),
        None => lookup_id
            .split_once('/')
            .map(|(o, r)| (o.to_string(), r.to_string()))
            .unwrap_or_default(),
    }
}
/// 收录应用缓存文件名：`{stem}.{ext}`（走 icon_cache_meta 表）。
pub fn catalog_filename(stem: &str, ext: &str) -> String {
    format!("{}.{}", stem, ext)
}

/// 非收录应用缓存文件名：`{stem}_l{level}.{ext}`（走 app_icon_cycles 表，级别隔离）。
pub fn cycle_filename(stem: &str, level: i32, ext: &str) -> String {
    format!("{}_l{}.{}", stem, level, ext)
}

/// 非收录 url 槽位认领（原 get_or_fetch_icon 内联分支）：命中既有 l2/l3/l4 返回其级别，
/// 否则写入首个空槽；全满则沿用当前合法级别，兜底 L2。不写 l1_url。
pub fn claim_cycle_url_slot(cycle: &mut AppIconCycle, url_trimmed: &str) -> i32 {
    if cycle.l2_url.trim() == url_trimmed {
        2
    } else if cycle.l3_url.trim() == url_trimmed {
        3
    } else if cycle.l4_url.trim() == url_trimmed {
        4
    } else if cycle.l2_url.trim().is_empty() {
        cycle.l2_url = url_trimmed.to_string();
        2
    } else if cycle.l3_url.trim().is_empty() {
        cycle.l3_url = url_trimmed.to_string();
        3
    } else if cycle.l4_url.trim().is_empty() {
        cycle.l4_url = url_trimmed.to_string();
        4
    } else if (2..=4).contains(&cycle.level) {
        cycle.level
    } else {
        2
    }
}

/// 固化一次轮换选中态：level/selected_url/cache_file/updated_at 同步推进。
pub fn seal_cycle_selection(
    cycle: &mut AppIconCycle,
    level: i32,
    selected_url: &str,
    cache_file: String,
) {
    cycle.level = level;
    cycle.selected_url = selected_url.to_string();
    cycle.cache_file = cache_file;
    cycle.updated_at = crate::now_secs();
}

/// 在线单仓直查的 cycle 行构造（原 github::search::fetch_online_repo 内联）：
/// 非收录、L2 即确认图标；图标为空时返回 None（调用方跳过 upsert）。
pub fn record_online_icon(
    app_id: &str,
    owner: &str,
    repo: &str,
    icon: &str,
) -> Option<AppIconCycle> {
    if icon.trim().is_empty() {
        return None;
    }
    let mut cycle = AppIconCycle::new(app_id, owner, repo);
    cycle.is_cataloged = false;
    cycle.level = 2;
    cycle.l2_url = icon.to_string();
    cycle.selected_url = icon.to_string();
    cycle.updated_at = crate::now_secs();
    Some(cycle)
}

/// 详情页图标层级决策（原 github::detail 内联）：
/// 官方 http(s) 图标保持 → 探测命中 → README logo → 空（前端降级首字母徽章）。
pub fn pick_detail_icon(
    official_icon: &str,
    probed_url: Option<String>,
    readme_logo: Option<String>,
) -> String {
    if official_icon.starts_with("http://") || official_icon.starts_with("https://") {
        return official_icon.to_string();
    }
    if let Some(p) = probed_url {
        return p;
    }
    if let Some(logo) = readme_logo {
        return logo;
    }
    String::new()
}
