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
    /// 用户手动选择标记（02 手动轮换保护）：应用详情手动切换档位后置 true；
    /// 详情刷新（缓存生存时效到期/强制刷新）对 pinned 行只补备选槽位，
    /// 不改 level/selected_url；未 pinned 行仍按最强探测更新选中图。
    pub pinned: bool,
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
            pinned: false,
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
                selected_url, cache_file, updated_at, pinned
            FROM app_icon_cycles
            WHERE app_id = ?1
            LIMIT 1
            "#,
        )?;
        let mut rows = stmt.query(params![cleaned])?;
        if let Some(row) = rows.next()? {
            let is_cataloged_int: i64 = row.get(3)?;
            let pinned_int: i64 = row.get(12)?;
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
                pinned: pinned_int != 0,
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
                selected_url, cache_file, updated_at, pinned
            FROM app_icon_cycles
            WHERE owner = ?1 AND repo = ?2
            LIMIT 1
            "#,
        )?;
        let mut rows = stmt.query(params![o, r])?;
        if let Some(row) = rows.next()? {
            let is_cataloged_int: i64 = row.get(3)?;
            let pinned_int: i64 = row.get(12)?;
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
                pinned: pinned_int != 0,
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
        let pinned_int = if cycle.pinned { 1 } else { 0 };

        self.exec_upsert(
            r#"
            INSERT INTO app_icon_cycles (
                app_id, owner, repo, is_cataloged, level,
                l1_url, l2_url, l3_url, l4_url,
                selected_url, cache_file, updated_at, pinned
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
                updated_at = excluded.updated_at,
                pinned = excluded.pinned;
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
                pinned_int,
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

    /// 更新当前图标轮换级别，并在对应级别 URL 非空时自动同步切换 selected_url。
    /// pinned 标记保持不动（恢复路径不改变用户手动选择状态）。
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

    /// 更新当前图标轮换级别及选中的 URL 和本地缓存文件路径。
    /// pinned 标记保持不动（恢复路径不改变用户手动选择状态）。
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

    // --- 便捷别名 (get / upsert / set_level 简洁调用) ---

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

// --- 图标轮换决策 SSOT（Shotgun Surgery 收敛落点，C1 持久化唯一深口） ---
// cataloged vs 非 cataloged 分流、owner/repo 解析（RepoRef）、文件名方案、
// l2/l3/l4 槽位认领、级别推进、详情页图标层级决策 —— 各调用方只做薄委托，
// 不再各自重写分支。纯决策，无 fs/网络/AppState 依赖。
// 缝：probe-vs-persist——本文件永不做网络探测（无 client/token/probe 调用）；
// 探测一律在 `github::icon_fetch` 深核（`probe_single_live`/`fetch_icons_stream` 纯探，
// 永不触 DB/fs）；持久化单一写入路径在 `commands::icons_cycle_probe::write_icon_file`
//（`icons/` 落盘 + meta 同步；下载经 `download_icon_bytes_direct`，
// L5 空选经 `seal_empty_selection`）。
// Curated Catalog 永不分支，例外仅 L1 填充（`ensure_cycle_levels`）。
// ADR-0010：key 一律小写 `owner/repo`（唯一实现见
// `forge::canonical_app_id_from_parts`，`icon_key` 为其薄委托）。

/// 级别→来源映射。
/// L4=README现场扒
pub fn source_for_level(level: i32) -> &'static str {
    match level {
        1 => "official",
        2 => "simple-icons",
        3 => "trees",
        4 => "readme",
        _ => "none",
    }
}

/// 级别→是否兜底映射（图标L1=官方直出非兜底，其余皆兜底）。
pub fn is_fallback_for_level(level: i32) -> bool {
    level > 1
}

/// 入站应用标识解析 SSOT：`RepositoryUrlParser::parse` 优先，`split_once('/')` 回退。
/// 返回 `(canonical 小写 id, 原大小写 owner/repo)`。
/// ADR-0010：`canonical` 即 `forge::canonical_app_id` 的 GitHub 形态
/// （小写 `owner/repo`），与事件 id（见
/// `forge::canonical_app_id_from_parts`）同值；
/// 事件 `id`、DB 主键、前端归一键一律用此值，不透传脏 id。
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

/// 获取周期记录中首个有效 URL 对应的级别（收录 1..=4，非收录 2..=4 跳 L1）。
/// FINAL 锁死：收录恒 L1 禁切（调用方 cycle 直接返回）；非收录 `level==1` 视为脏数据跳过不动。
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

/// 新建 cycle 行的 owner/repo 推导：parse 优先，否则原始 split_once（不过滤多段斜杠），全失败则空串。
pub fn owner_repo_for_new_cycle(lookup_id: &str) -> (String, String) {
    match crate::forge::RepositoryUrlParser::parse(lookup_id) {
        Some(c) => (c.owner, c.repo),
        None => lookup_id
            .split_once('/')
            .map(|(o, r)| (o.to_string(), r.to_string()))
            .unwrap_or_default(),
    }
}

/// FINAL Logo 口径：图标 TTL 7 天（文件存在+DB有效即命中0请求，过期后台重下1次，前台不闪）。
/// 详情 TTL 60min 见 `commands::catalog_detail::detail_ttl_secs`；图标 ETag 禁用（仅详情用）。
pub const ICON_TTL_SECS: i64 = 7 * 24 * 60 * 60;

/// hash 文件名 SSOT（唯一文件名方案）：`sha256(url_trimmed)[0:16].{ext}`。
/// - `url` 为 cycle/详情命中的备选 Logo 真地址（L1–L4；README 正文图永不进此）；
/// - `ext` 为 sniff 纠正后的 `real_ext`（`mime_to_ext(detect(...))`），调用方保证小写无点；
/// - 空 url 返回空串（调用方跳过落盘）。
/// 读侧用 `KNOWN_ICON_EXTS` 全后缀兜底（见 probe 的 hash 候选构造）。
pub fn hash_icon_filename(url_trimmed: &str, ext: &str) -> String {
    let u = url_trimmed.trim();
    if u.is_empty() {
        return String::new();
    }
    let full = crate::sha256_digest_hex(u.as_bytes());
    let stem = &full[..16.min(full.len())];
    let clean_ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let clean_ext = if clean_ext.is_empty() { "png".to_string() } else { clean_ext };
    format!("{}.{}", stem, clean_ext)
}

/// 图标 DB 有效性：`cached_at/updated_at` 在 7 天内即有效（含未来时钟漂移宽容）。
pub fn is_icon_fresh(cached_at: i64, now: i64) -> bool {
    cached_at > 0 && now.saturating_sub(cached_at) < ICON_TTL_SECS
}

/// 恢复路径判鲜（03 过期刷新，SSOT）：与请求路径同口径，行 7 天有效 + 文件 7 天新鲜双检。
/// `file_fresh` 由调用方经 `is_icon_file_fresh` 传入（文件 mtime 口径）；
/// 任一过期即 false，调用方走下载分支重下，不直接返回旧图。
/// `pinned` 选择不受此判定影响（过期刷新落库经 `set_icon_cycle_selected`，pinned 保持不动）。
pub fn is_cycle_restore_fresh(cycle: &AppIconCycle, file_fresh: bool, now: i64) -> bool {
    !cycle.cache_file.trim().is_empty() && file_fresh && is_icon_fresh(cycle.updated_at, now)
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

/// L5 空选固化（首字母徽章，level 纯L=5）：level=5 + selected/cache 双空 + updated_at 推进。
/// cycle 命令层 L5 一律经此，不手写 `""` 散赋值（L5 `""` 泄漏收敛在缝内）；
/// 写侧 `detail_json.icon` 显式清空（`""`）由调用方内联直写，不经薄 helper。
/// FINAL：L5 清对应选中态（selected/cache 双空），`l1..l4` 备选 URL 保留供重选，
/// 同 hash 同 ext 的非选中文件保留不删（配额 LRU 按 mtime 淘汰）；`sync_detail_icon("")` 由调用方保证（见 cycle 命令层）。
pub fn seal_empty_selection(cycle: &mut AppIconCycle) {
    seal_cycle_selection(cycle, 5, "", String::new());
}

/// pinned 行备选槽补齐（02 详情刷新只补槽）：仅当探测 level 对应的 lN 槽为空时写入；
/// level/selected_url/cache_file/updated_at/pinned 一律不动。槽映射与详情落库一致
///（2=L2品牌库，3=L3仓库，4=L4 README；L1官方槽不由探测回填）。
pub fn fill_probe_slot(cycle: &mut AppIconCycle, level: i32, url_trimmed: &str) {
    let u = url_trimmed.trim();
    if u.is_empty() {
        return;
    }
    match level {
        2 => {
            if cycle.l2_url.trim().is_empty() {
                cycle.l2_url = u.to_string();
            }
        }
        3 => {
            if cycle.l3_url.trim().is_empty() {
                cycle.l3_url = u.to_string();
            }
        }
        4 => {
            if cycle.l4_url.trim().is_empty() {
                cycle.l4_url = u.to_string();
            }
        }
        _ => {}
    }
}

/// 详情刷新图标合并（02 pinned 保护，SSOT，调用方为详情落库）：
/// - pinned 行（用户已手动选择档位）：保持 level/selected_url/cache_file/updated_at，
///   仅把本次最强探测命中的备选 Logo 补进对应 lN 空槽；返回 true，调用方须把应用详情
///   `icon` 对齐 `selected_url`（L5 pinned 对齐为 `""`，保持徽章态）。
/// - 未 pinned 行：按最强探测收编（level/selected_url/对应槽/updated_at 推进，
///   pinned 保持 false）；返回 false，调用方保持探测 icon。
/// level 纯 L（2=L2品牌库，3=L3仓库，4=L4 README）；空 URL 直接返回 false，不建行语义由调用方保持。
pub fn merge_detail_icon(
    cycle: &mut AppIconCycle,
    level: i32,
    url_trimmed: &str,
    is_cataloged: bool,
    now: i64,
) -> bool {
    cycle.is_cataloged = is_cataloged;
    if cycle.pinned {
        fill_probe_slot(cycle, level, url_trimmed);
        return true;
    }
    let u = url_trimmed.trim();
    if u.is_empty() {
        return false;
    }
    // 未 pinned：与原详情落库同语义——level/selected_url/updated_at 推进，
    // 对应槽位无条件采用本次最强探测（pinned 保持 false）。
    cycle.level = level;
    if level == 3 {
        cycle.l3_url = u.to_string();
    } else if level == 4 {
        cycle.l4_url = u.to_string();
    } else if level == 2 {
        cycle.l2_url = u.to_string();
    }
    cycle.selected_url = u.to_string();
    cycle.updated_at = now;
    false
}

/// 探测命中合并后缓存文件认领（05 槽满不錯配选中图）：仅当行选中图即本次命中真地址时
/// 才认领新文件名，否则保持原 `(selected_url, cache_file)` 配对，避免选中图与槽位/文件分叉。
/// 空文件名永不认领。返回 true=已认领，false=保持原配对。
pub fn adopt_probe_cache_file(
    cycle: &mut AppIconCycle,
    key_url_trimmed: &str,
    filename: String,
) -> bool {
    if filename.trim().is_empty() {
        return false;
    }
    if cycle.selected_url.trim() == key_url_trimmed.trim() {
        cycle.cache_file = filename;
        return true;
    }
    false
}

/// icon_cache_meta 读侧 TTL 感知记录（图标通道 ETag 禁用后的 DB 有效性唯一依据）：
/// 返回 `(remote_url, cached_at)`；无行即 `None`（调用方视为未命中，后台重下1次）。
/// 配额 LRU 只清文件不删 DB URL，故此键 bedding 永不因 LRU 消失（文件缺失可经 URL 重下恢复）。
pub fn get_icon_cache_record(
    db: &Database,
    cache_key: &str,
) -> Result<Option<(String, i64)>> {
    let cleaned = clean(cache_key);
    if cleaned.is_empty() {
        return Ok(None);
    }
    let mut stmt = db.conn.prepare(
        "SELECT remote_url, cached_at FROM icon_cache_meta WHERE cache_key = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![cleaned])?;
    if let Some(row) = rows.next()? {
        let url: String = row.get(0)?;
        let at: i64 = row.get(1)?;
        Ok(Some((url, at)))
    } else {
        Ok(None)
    }
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
