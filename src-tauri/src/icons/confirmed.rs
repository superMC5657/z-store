//! 确认图标两阶段解析：DB 阶段读 `app_icon_cycles` 生成计划，磁盘阶段读文件并编码为 `data:` URI（不持 DB 锁）。

use crate::db::{AppIconCycle, Database};
use crate::forge::coord::{app_id_lookup_keys, repo_lookup_keys, RepoRef};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// 图标查询坐标：`app_id` 与仓库 `(owner, repo)` 组合键。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct IconCoord {
    pub app_id: String,
    pub owner: String,
    pub repo: String,
}

impl IconCoord {
    pub(crate) fn new(
        app_id: impl Into<String>,
        owner: impl Into<String>,
        repo: impl Into<String>,
    ) -> Self {
        Self {
            app_id: app_id.into(),
            owner: owner.into(),
            repo: repo.into(),
        }
    }

    pub(crate) fn from_clean_id(clean_id: &str) -> Option<Self> {
        let (owner, repo) = clean_id.split_once('/')?;
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        Some(Self::new(clean_id, owner, repo))
    }
}

/// DB 阶段产物：选中图标地址、本地缓存文件名与级别（`level == 5` 或无选中地址时不产生计划）。
/// 磁盘阶段命中自愈时复用同一结构体携带新认领的 `cache_file`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfirmedIconPlan {
    pub app_id: String,
    pub level: i32,
    pub selected_url: String,
    pub cache_file: String,
}

pub(crate) type IconCacheHeal = ConfirmedIconPlan;

impl ConfirmedIconPlan {
    pub(crate) fn from_cycle(cycle: &AppIconCycle) -> Option<Self> {
        if cycle.level == 5 {
            return None;
        }
        let selected = cycle.selected_url.trim();
        if selected.is_empty() {
            return None;
        }
        Some(Self {
            app_id: cycle.app_id.clone(),
            level: cycle.level,
            selected_url: selected.to_string(),
            cache_file: cycle.cache_file.trim().to_string(),
        })
    }

    fn with_cache_file(&self, cache_file: String) -> Self {
        Self {
            app_id: self.app_id.clone(),
            level: self.level,
            selected_url: self.selected_url.clone(),
            cache_file,
        }
    }
}

/// 单个图标的延迟解析任务：确认图标计划优先，计划落空时回退收录官方图标地址
/// （本地缓存命中出 `data:`，否则原样返回地址）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DeferredIcon {
    pub plan: Option<ConfirmedIconPlan>,
    pub fallback_url: Option<String>,
}

impl DeferredIcon {
    #[cfg(test)]
    pub(crate) fn confirmed(plan: Option<ConfirmedIconPlan>) -> Self {
        Self {
            plan,
            fallback_url: None,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.plan.is_none() && self.fallback_url.is_none()
    }
}

/// 磁盘阶段（零 DB）：M2 本地文件命中出 `data:` URI；L1..L3 缺盘回退远端地址；L4 缺盘为 `None`。
pub(crate) fn materialize_confirmed_icon(
    icons_dir: &Path,
    plan: &ConfirmedIconPlan,
) -> (Option<String>, Option<IconCacheHeal>) {
    if !plan.cache_file.is_empty() {
        if let Some(bytes) = super::read_valid_image_file(&icons_dir.join(&plan.cache_file)) {
            return (Some(super::bytes_to_data_uri(&bytes)), None);
        }
    }
    if let Some((bytes, fname)) = super::find_cached_icon_by_url(icons_dir, &plan.selected_url) {
        return (
            Some(super::bytes_to_data_uri(&bytes)),
            Some(plan.with_cache_file(fname)),
        );
    }
    if (1..=3).contains(&plan.level) {
        return (Some(plan.selected_url.clone()), None);
    }
    (None, None)
}

fn materialize_deferred(
    icons_dir: &Path,
    job: &DeferredIcon,
) -> (Option<String>, Option<IconCacheHeal>) {
    if let Some(plan) = &job.plan {
        let (icon, heal) = materialize_confirmed_icon(icons_dir, plan);
        if icon.is_some() {
            return (icon, heal);
        }
    }
    let Some(url) = job.fallback_url.as_deref().map(str::trim) else {
        return (None, None);
    };
    if url.is_empty() {
        return (None, None);
    }
    if let Some((bytes, _)) = super::find_cached_icon_by_url(icons_dir, url) {
        return (Some(super::bytes_to_data_uri(&bytes)), None);
    }
    (Some(url.to_string()), None)
}

/// 批量磁盘阶段（零 DB，同步）：返回与入参一一对齐的图标与待回写的自愈认领。
pub(crate) fn materialize_icons(
    icons_dir: &Path,
    jobs: &[DeferredIcon],
) -> (Vec<Option<String>>, Vec<IconCacheHeal>) {
    let mut heals = Vec::new();
    let icons = jobs
        .iter()
        .map(|job| {
            let (icon, heal) = materialize_deferred(icons_dir, job);
            heals.extend(heal);
            icon
        })
        .collect();
    (icons, heals)
}

/// 批量磁盘阶段卸到阻塞线程池（调用方此时不得持有 `db` 锁），自愈认领短锁写回。
pub(crate) async fn resolve_icons_offloaded(
    state: &crate::AppState,
    jobs: Vec<DeferredIcon>,
) -> Vec<Option<String>> {
    if jobs.iter().all(DeferredIcon::is_empty) {
        return vec![None; jobs.len()];
    }
    let len = jobs.len();
    let (icons, heals) = tokio::task::spawn_blocking(move || {
        let icons_dir = crate::get_app_data_dir().join("icons");
        materialize_icons(&icons_dir, &jobs)
    })
    .await
    .unwrap_or_else(|_| (vec![None; len], Vec::new()));
    if !heals.is_empty() {
        if let Ok(db) = state.db() {
            apply_icon_cache_heals(&db, &heals);
        }
    }
    icons
}

/// 自愈认领回写（短锁写阶段）。
pub(crate) fn apply_icon_cache_heals(db: &Database, heals: &[IconCacheHeal]) {
    for h in heals {
        let _ = db.set_icon_cycle_selected(&h.app_id, h.level, &h.selected_url, &h.cache_file);
    }
}

/// 一页坐标的 `app_icon_cycles` 批量快照：`app_id` 维度与 `(owner, repo)` 维度各一次分片查询，
/// 查找顺序与 [`crate::forge::coord::lookup_case_insensitive`] 一致。
#[derive(Debug, Clone, Default)]
pub(crate) struct IconCycleIndex {
    by_id: HashMap<String, AppIconCycle>,
    by_repo: HashMap<(String, String), AppIconCycle>,
}

impl IconCycleIndex {
    /// 查询失败时退化为空快照（等同未命中）。
    pub(crate) fn load(db: &Database, coords: &[IconCoord]) -> Self {
        let mut id_keys: Vec<String> = Vec::new();
        let mut owners: Vec<String> = Vec::new();
        for c in coords {
            id_keys.extend(app_id_lookup_keys(&c.app_id));
            id_keys.push(c.app_id.trim().to_string());
            for r in repo_lookup_keys(&c.app_id, &RepoRef::new(&c.owner, &c.repo)) {
                owners.push(r.owner);
            }
        }
        let by_id = db.get_icon_cycles_batch(&id_keys).unwrap_or_default();
        let mut by_repo: HashMap<(String, String), AppIconCycle> = HashMap::new();
        for c in db.get_icon_cycles_by_owners(&owners).unwrap_or_default() {
            by_repo
                .entry((c.owner.clone(), c.repo.clone()))
                .or_insert(c);
        }
        Self { by_id, by_repo }
    }

    /// 大小写不敏感查找（`app_id` 原值 → canonical → 小写 → `owner/repo` 原值 → 小写）。
    pub(crate) fn lookup(&self, coord: &IconCoord) -> Option<&AppIconCycle> {
        for key in app_id_lookup_keys(&coord.app_id) {
            if let Some(c) = self.by_id.get(&key) {
                return Some(c);
            }
        }
        for r in repo_lookup_keys(&coord.app_id, &RepoRef::new(&coord.owner, &coord.repo)) {
            if let Some(c) = self.by_repo.get(&(r.owner, r.repo)) {
                return Some(c);
            }
        }
        None
    }

    /// `app_id` 精确查找（等同 `Database::get_icon_cycle`）。
    pub(crate) fn exact(&self, app_id: &str) -> Option<&AppIconCycle> {
        self.by_id.get(app_id.trim())
    }

    pub(crate) fn plan(&self, coord: &IconCoord) -> Option<ConfirmedIconPlan> {
        self.lookup(coord).and_then(ConfirmedIconPlan::from_cycle)
    }

    /// 按快照规划一组延迟图标任务。
    pub(crate) fn plan_pending(&self, pendings: &[PendingIcon]) -> Vec<DeferredIcon> {
        pendings
            .iter()
            .map(|p| DeferredIcon {
                plan: p.coord.as_ref().and_then(|c| self.plan(c)),
                fallback_url: p.fallback_url.clone(),
            })
            .collect()
    }
}

/// 已解析的确认图标，按 [`IconCoord`] 原样索引。
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedIcons {
    map: HashMap<IconCoord, Option<String>>,
}

impl ResolvedIcons {
    pub(crate) fn contains(&self, coord: &IconCoord) -> bool {
        self.map.contains_key(coord)
    }

    /// 确认图标（`None`：无确认图标或尚未解析）。
    pub(crate) fn get(&self, coord: &IconCoord) -> Option<String> {
        self.map.get(coord).cloned().flatten()
    }

    pub(crate) fn extend(&mut self, other: ResolvedIcons) {
        self.map.extend(other.map);
    }
}

/// 一组坐标的确认图标解析计划（DB 阶段，需持 `db` 锁；未在 `known` 中的坐标才产生任务）。
pub(crate) struct IconPlanBatch {
    coords: Vec<IconCoord>,
    jobs: Vec<DeferredIcon>,
}

impl IconPlanBatch {
    pub(crate) fn new(
        index: &IconCycleIndex,
        coords: &[IconCoord],
        known: Option<&ResolvedIcons>,
    ) -> Self {
        let mut seen: HashSet<&IconCoord> = HashSet::new();
        let mut out_coords = Vec::new();
        let mut pendings = Vec::new();
        for c in coords {
            if !seen.insert(c) || known.is_some_and(|k| k.contains(c)) {
                continue;
            }
            pendings.push(PendingIcon::confirmed_coord(c.clone()));
            out_coords.push(c.clone());
        }
        let jobs = index.plan_pending(&pendings);
        Self {
            coords: out_coords,
            jobs,
        }
    }

    fn into_resolved(self, icons: Vec<Option<String>>) -> ResolvedIcons {
        ResolvedIcons {
            map: self.coords.into_iter().zip(icons).collect(),
        }
    }

    /// 同步磁盘阶段 + 自愈回写（测试入口）。
    #[cfg(test)]
    pub(crate) fn resolve_inline(self, db: &Database, icons_dir: &Path) -> ResolvedIcons {
        let icons = materialize_icons_inline(db, icons_dir, &self.jobs);
        self.into_resolved(icons)
    }

    /// 阻塞线程池磁盘阶段 + 自愈短锁回写（调用方不得持锁）。
    pub(crate) async fn resolve_offloaded(mut self, state: &crate::AppState) -> ResolvedIcons {
        let jobs = std::mem::take(&mut self.jobs);
        let icons = resolve_icons_offloaded(state, jobs).await;
        self.into_resolved(icons)
    }
}

/// 待规划的单个图标：确认图标坐标（可缺）+ 收录官方图标回退地址（可缺）。
#[derive(Debug, Clone, Default)]
pub(crate) struct PendingIcon {
    coord: Option<IconCoord>,
    fallback_url: Option<String>,
}

impl PendingIcon {
    /// 不解析图标（保持行内原值）。
    pub(crate) fn none() -> Self {
        Self::default()
    }

    /// 仅确认图标（`Some` 才覆盖行内原值）。
    pub(crate) fn confirmed(app_id: &str, owner: &str, repo: &str) -> Self {
        Self::confirmed_coord(IconCoord::new(app_id, owner, repo))
    }

    pub(crate) fn confirmed_coord(coord: IconCoord) -> Self {
        Self {
            coord: Some(coord),
            fallback_url: None,
        }
    }

    /// 规范 id 的确认图标，回退收录项官方图标：`owner/repo` 由 id 拆出，拆不出即不解析。
    pub(crate) fn for_clean_id(catalog: &crate::github::CatalogService, clean_id: &str) -> Self {
        let Some(coord) = IconCoord::from_clean_id(clean_id) else {
            return Self::none();
        };
        Self {
            coord: Some(coord),
            fallback_url: catalog
                .get_catalog_item(clean_id)
                .map(|c| c.icon.trim().to_string())
                .filter(|u| !u.is_empty()),
        }
    }
}

/// DB 阶段（持锁）：一次批量读 `app_icon_cycles`，产出与入参对齐的延迟解析任务。
pub(crate) fn plan_pending_icons(db: &Database, pendings: &[PendingIcon]) -> Vec<DeferredIcon> {
    let coords: Vec<IconCoord> = pendings.iter().filter_map(|p| p.coord.clone()).collect();
    IconCycleIndex::load(db, &coords).plan_pending(pendings)
}

/// 同步磁盘阶段 + 自愈回写（内联/测试入口）。
#[cfg(test)]
pub(crate) fn materialize_icons_inline(
    db: &Database,
    icons_dir: &Path,
    jobs: &[DeferredIcon],
) -> Vec<Option<String>> {
    let (icons, heals) = materialize_icons(icons_dir, jobs);
    apply_icon_cache_heals(db, &heals);
    icons
}

/// 解析结果写回：`Some` 才覆盖行内图标，`None` 保持原值。
pub(crate) fn patch_core_icons<'a>(
    cores: impl Iterator<Item = Option<&'a mut crate::models::AppCore>>,
    icons: Vec<Option<String>>,
) {
    for (core, icon) in cores.zip(icons) {
        if let (Some(core), Some(icon)) = (core, icon) {
            core.icon = icon;
        }
    }
}

/// 无锁卸载磁盘图标解析 → 自愈认领回写 → 写回 `AppCore::icon`。
pub(crate) async fn resolve_and_patch_icons<'a>(
    state: &crate::AppState,
    jobs: Vec<DeferredIcon>,
    cores: impl Iterator<Item = Option<&'a mut crate::models::AppCore>>,
) {
    let icons = resolve_icons_offloaded(state, jobs).await;
    patch_core_icons(cores, icons);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cycle(app_id: &str, owner: &str, repo: &str, selected: &str, level: i32) -> AppIconCycle {
        let mut c = AppIconCycle::new(app_id, owner, repo);
        c.selected_url = selected.to_string();
        c.level = level;
        c.updated_at = 1;
        c
    }

    #[test]
    fn index_lookup_matches_single_row_lookup() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_icon_cycle(&cycle("acme/tool", "acme", "tool", "https://a/1.png", 2))
            .unwrap();
        db.upsert_icon_cycle(&cycle("legacy-key", "Mixed", "Case", "https://a/2.png", 3))
            .unwrap();
        let coords = [
            IconCoord::new("ACME/Tool", "ACME", "Tool"),
            IconCoord::new("mixed/case", "Mixed", "Case"),
            IconCoord::new("none/here", "none", "here"),
        ];
        let index = IconCycleIndex::load(&db, &coords);
        for c in &coords {
            let single = crate::forge::coord::lookup_case_insensitive(
                &db,
                &c.app_id,
                &RepoRef::new(&c.owner, &c.repo),
            );
            assert_eq!(index.lookup(c).cloned(), single, "{}", c.app_id);
        }
        assert!(index.exact("acme/tool").is_some());
        assert!(index.exact("ACME/Tool").is_none());
    }

    #[test]
    fn plan_skips_level_five_and_empty_selection() {
        assert!(ConfirmedIconPlan::from_cycle(&cycle("a/b", "a", "b", "https://x", 5)).is_none());
        assert!(ConfirmedIconPlan::from_cycle(&cycle("a/b", "a", "b", "  ", 2)).is_none());
        let plan =
            ConfirmedIconPlan::from_cycle(&cycle("a/b", "a", "b", " https://x ", 2)).unwrap();
        assert_eq!(plan.selected_url, "https://x");
    }

    #[test]
    fn materialize_falls_back_to_remote_for_l1_to_l3_and_catalog_url() {
        let dir = std::env::temp_dir().join("z-store-test-confirmed-icons-empty");
        let remote = DeferredIcon::confirmed(ConfirmedIconPlan::from_cycle(&cycle(
            "a/b",
            "a",
            "b",
            "https://x/icon.png",
            2,
        )));
        let l4 = DeferredIcon {
            plan: ConfirmedIconPlan::from_cycle(&cycle("a/c", "a", "c", "https://x/r.png", 4)),
            fallback_url: Some(" https://official/icon.png ".to_string()),
        };
        let (icons, heals) = materialize_icons(&dir, &[remote, l4, DeferredIcon::default()]);
        assert_eq!(
            icons,
            vec![
                Some("https://x/icon.png".to_string()),
                Some("https://official/icon.png".to_string()),
                None
            ]
        );
        assert!(heals.is_empty());
    }
}
