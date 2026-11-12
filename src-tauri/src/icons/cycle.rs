//! 图标轮换状态机与详情页图标级别决策 SSOT（纯领域逻辑，无 fs/网络/DB 写）。

use crate::db::AppIconCycle;
use crate::forge::coord::RepoRef;

/// Logo 缓存 TTL：7 天（图标通道禁用 ETag，命中 0 请求直接读盘）。
pub const ICON_TTL_SECS: i64 = 7 * 24 * 60 * 60;

/// 级别→来源映射（L4 = README 头部提取）。
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

/// 入站应用标识解析唯一出口：委托 `RepositoryUrlParser::parse`，返回 `(canonical 小写 id, 原大小写 RepoRef)`。
pub fn resolve_icon_coord(app_id: &str) -> Result<(String, RepoRef), String> {
    let trimmed = app_id.trim();
    if trimmed.is_empty() {
        return Err("应用标识不能为空".into());
    }

    let coord = crate::forge::RepositoryUrlParser::parse(trimmed)
        .ok_or_else(|| format!("无法识别的应用标识: {}", trimmed))?;
    let canon = coord.to_app_id().to_lowercase();
    Ok((canon, RepoRef::new(&coord.owner, &coord.repo)))
}

/// 获取周期记录中首个有效 URL 对应的级别（收录 1..=4，非收录 2..=4 跳 L1）。
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

/// 计算下一个轮换级别：空档顺延，5→1/2 回绕；非收录应用绝不轮换到 Level 1。
pub fn next_cycle_level(curr_level: i32, cycle: &AppIconCycle) -> i32 {
    let mut cand = if !(1..=5).contains(&curr_level) {
        if cycle.is_cataloged {
            1
        } else {
            2
        }
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

/// 新建 cycle 行的 owner/repo 推导：parse 优先，否则原始 `split_once`，全失败返回空串。
pub fn owner_repo_for_new_cycle(lookup_id: &str) -> (String, String) {
    match crate::forge::RepositoryUrlParser::parse(lookup_id) {
        Some(c) => (c.owner, c.repo),
        None => lookup_id
            .split_once('/')
            .map(|(o, r)| (o.to_string(), r.to_string()))
            .unwrap_or_default(),
    }
}

/// hash 文件名 SSOT：`sha256(url_trimmed)[0:16].{ext}`；空 url 返回空串。
pub fn hash_icon_filename(url_trimmed: &str, ext: &str) -> String {
    let u = url_trimmed.trim();
    if u.is_empty() {
        return String::new();
    }
    let full = crate::sha256_digest_hex(u.as_bytes());
    let stem = &full[..16.min(full.len())];
    let clean_ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let clean_ext = if clean_ext.is_empty() {
        "png".to_string()
    } else {
        clean_ext
    };
    format!("{}.{}", stem, clean_ext)
}

/// 图标 DB 有效性：`cached_at/updated_at` 在 7 天内即有效。
pub fn is_icon_fresh(cached_at: i64, now: i64) -> bool {
    cached_at > 0 && now.saturating_sub(cached_at) < ICON_TTL_SECS
}

/// 恢复路径判鲜：行 7 天有效 + 文件 7 天新鲜双检。
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
pub fn seal_empty_selection(cycle: &mut AppIconCycle) {
    seal_cycle_selection(cycle, 5, "", String::new());
}

/// pinned 行备选槽补齐：仅当探测 level 对应的 `lN` 槽为空时写入。
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
        4 if cycle.l4_url.trim().is_empty() => {
            cycle.l4_url = u.to_string();
        }
        _ => {}
    }
}

/// 详情刷新图标合并（pinned 保护）：
/// - pinned 行仅补备选槽并返回 `true`，调用方须将详情图标对齐 `selected_url`；
/// - 未 pinned 行按最强探测收编（`level`/`selected_url`/对应槽/`updated_at` 推进）并返回 `false`。
pub fn merge_detail_icon(
    cycle: &mut AppIconCycle,
    level: i32,
    url_trimmed: &str,
    is_cataloged: bool,
    now: i64,
) -> bool {
    let prev_selected = cycle.selected_url.trim().to_string();
    cycle.is_cataloged = is_cataloged;
    if is_cataloged {
        cycle.pinned = false;
        if level == 1 {
            let u = url_trimmed.trim();
            if !u.is_empty() {
                cycle.level = 1;
                cycle.l1_url = u.to_string();
                cycle.selected_url = u.to_string();
                if prev_selected != u {
                    cycle.cache_file.clear();
                }
                cycle.updated_at = now;
            }
            return false;
        } else if !cycle.l1_url.trim().is_empty() || cycle.level == 1 {
            fill_probe_slot(cycle, level, url_trimmed);
            return false;
        }
    } else if cycle.pinned {
        fill_probe_slot(cycle, level, url_trimmed);
        return true;
    }
    let u = url_trimmed.trim();
    if u.is_empty() {
        return false;
    }
    cycle.level = level;
    if level == 1 {
        cycle.l1_url = u.to_string();
    } else if level == 3 {
        cycle.l3_url = u.to_string();
    } else if level == 4 {
        cycle.l4_url = u.to_string();
    } else if level == 2 {
        cycle.l2_url = u.to_string();
    }
    cycle.selected_url = u.to_string();
    if prev_selected != u {
        cycle.cache_file.clear();
    }
    cycle.updated_at = now;
    false
}

/// 探测命中合并后缓存文件认领：仅当行选中图即本次命中真地址时才认领新文件名。
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

/// 远端探测命中档位（仅 L2 品牌库 / L3 仓库文件树）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeIconLevel {
    L2SimpleIcons,
    L3Trees,
}

impl ProbeIconLevel {
    pub fn from_source(source: &str) -> Self {
        if source.trim() == "simple-icons" {
            Self::L2SimpleIcons
        } else {
            Self::L3Trees
        }
    }

    pub fn as_i32(self) -> i32 {
        match self {
            Self::L2SimpleIcons => 2,
            Self::L3Trees => 3,
        }
    }
}

/// 详情页图标来源与备选槽决策结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailIconResolution {
    pub icon: String,
    pub level: Option<i32>,
    pub extra_l4_url: Option<String>,
}

/// 详情页图标带级别决策（官方 L1 → SimpleIcons L2 → Trees L3 → README L4 → 空）。
pub fn pick_detail_icon_with_level(
    official_icon: &str,
    probed: Option<(ProbeIconLevel, String)>,
    readme_logo: Option<String>,
) -> DetailIconResolution {
    let clean_l4 = readme_logo
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let official_trimmed = official_icon.trim();
    if official_trimmed.starts_with("http://") || official_trimmed.starts_with("https://") {
        return DetailIconResolution {
            icon: official_trimmed.to_string(),
            level: Some(1),
            extra_l4_url: clean_l4,
        };
    }
    if let Some((lvl, url)) = probed {
        let u = url.trim().to_string();
        if !u.is_empty() {
            return DetailIconResolution {
                icon: u,
                level: Some(lvl.as_i32()),
                extra_l4_url: clean_l4,
            };
        }
    }
    if let Some(logo) = clean_l4 {
        return DetailIconResolution {
            icon: logo,
            level: Some(4),
            extra_l4_url: None,
        };
    }
    DetailIconResolution {
        icon: String::new(),
        level: None,
        extra_l4_url: None,
    }
}

/// 将详情页图标决策结果合并入 `AppIconCycle`，必要时补齐 `l4_url` 备选槽。
pub fn apply_detail_icon_resolution(
    cycle: &mut AppIconCycle,
    icon_trimmed: &str,
    resolution: Option<&DetailIconResolution>,
    fallback_level: i32,
    is_cataloged: bool,
    now: i64,
) -> bool {
    let level = resolution
        .and_then(|r| r.level)
        .filter(|&lvl| (1..=4).contains(&lvl))
        .or_else(|| cycle.level_for_known_url(icon_trimmed))
        .unwrap_or(fallback_level);
    let was_pinned = merge_detail_icon(cycle, level, icon_trimmed, is_cataloged, now);
    if let Some(extra_l4) = resolution
        .and_then(|r| r.extra_l4_url.as_deref())
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        fill_probe_slot(cycle, 4, extra_l4);
    }
    was_pinned
}
