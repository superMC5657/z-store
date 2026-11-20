use crate::github::models::{
    is_placeholder_description, is_placeholder_license, is_placeholder_version,
};
use crate::models::{AppCore, AppSummary};
use crate::AppState;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};

static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

/// 趋势流式补图世代：每次 `enrich_trend_repos` 调用 +1，过期在途结果只写库不发送。
static BOARD_GEN: AtomicU64 = AtomicU64::new(0);

/// 分配下一趋势补图世代。
fn next_board_gen() -> u64 {
    BOARD_GEN.fetch_add(1, Ordering::SeqCst) + 1
}

/// Star 列表补图世代：新查询第 1 页 +1，续拉页沿用当前值；过期在途结果只写库不发送。
static STARRED_GEN: AtomicU64 = AtomicU64::new(0);

/// 在线搜索回包：行 + 后端拍板的 search_id 回声。
/// 前端以此 sid 为准做图标门控（以后端为准，后端说什么前端认什么）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct OnlineSearchResult {
    pub rows: Vec<AppSummary>,
    pub sid: String,
    /// 关键词搜索联网失败、回退旧载荷时为 `true`；前端据此不把这批行当新鲜结果写入列表缓存。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_stale: bool,
    /// 本页 `repo_card_cache` 已确认无可安装资产（平台为空）的未收录行规范 id。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub confirmed_other_ids: Vec<String>,
    /// 本页私有仓库的规范 id（登出时前端据此清理内存私有卡）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub private_ids: Vec<String>,
}

impl OnlineSearchResult {
    fn rows_only(rows: Vec<AppSummary>, sid: String) -> Self {
        Self {
            rows,
            sid,
            is_stale: false,
            confirmed_other_ids: Vec::new(),
            private_ids: Vec::new(),
        }
    }
}

/// 根据上下文选择对应的全局世代计数器与期望世代值。
fn select_gen_lane(ctx: &crate::icons::IconFetchCtx) -> (&'static AtomicU64, u64) {
    match ctx {
        crate::icons::IconFetchCtx::Search { gen, .. } => (&SEARCH_GEN, *gen),
        crate::icons::IconFetchCtx::Trend { gen, .. } => (&BOARD_GEN, *gen),
        crate::icons::IconFetchCtx::Starred { gen } => (&STARRED_GEN, *gen),
        crate::icons::IconFetchCtx::Launchpad { gen } => {
            (&crate::commands::launchpad::LAUNCHPAD_ICON_GEN, *gen)
        }
    }
}

/// 将流式探测命中的图标按世代新鲜度合入 `app_icon_cycles`，仅当前世代才发射 `zstore://icon-ready`。
/// 新鲜命中按优先级收编选中，过期命中与 pinned 行仅补空槽。
async fn save_and_emit(
    handle: &AppHandle,
    job: &crate::icons::IconFetchJob,
    url: &str,
    level: i32,
    via: &str,
) {
    let (gen_counter, expected_gen) = select_gen_lane(&job.ctx);
    let state = handle.state::<AppState>();
    if let Ok(db) = state.db() {
        // 读旧行合并：保留已有槽位与 pinned 选择，过期命中仅补空槽。
        let mut cycle = db
            .get_icon_cycle(&job.id)
            .ok()
            .flatten()
            .unwrap_or_else(|| {
                let mut c = crate::db::AppIconCycle::new(&job.id, &job.owner, &job.repo);
                c.is_cataloged = false;
                c
            });
        let keep_cataloged = cycle.is_cataloged;
        let old_selected = cycle.selected_url.clone();
        let current_gen_value = gen_counter.load(Ordering::SeqCst);
        let fresh = current_gen_value == expected_gen;
        let was_pinned = merge_stream_hit(
            &mut cycle,
            level,
            url,
            keep_cataloged,
            crate::now_secs(),
            fresh,
        );
        // 未 pinned 且选中变化时清除旧 cache_file，等待按新地址重新缓存。
        if !was_pinned && cycle.selected_url != old_selected {
            cycle.cache_file = String::new();
        }
        let _ = db.with_immediate_transaction(|| {
            db.upsert_icon_cycle(&cycle)?;
            Ok(())
        });
        if fresh {
            let _ = db.sync_repo_card_icon(&job.id, &cycle.selected_url, false);
        }
    }
    // 仅当前世代才向前端发送事件，过期结果只写库。
    let current_emit_gen = gen_counter.load(Ordering::SeqCst);
    if current_emit_gen != expected_gen {
        return;
    }
    let ready = crate::icons::icon_ready_payload(job, url, level, via);
    crate::icons::emit_icon_ready(handle, &ready);
}

/// 合并流式命中图标：新鲜世代全量合并，过期世代仅补对应空槽而不改选中态。
fn merge_stream_hit(
    cycle: &mut crate::db::AppIconCycle,
    level: i32,
    url: &str,
    keep_cataloged: bool,
    now: i64,
    fresh: bool,
) -> bool {
    if fresh {
        crate::icons::merge_detail_icon(cycle, level, url, keep_cataloged, now)
    } else {
        crate::icons::fill_probe_slot(cycle, level, url);
        cycle.pinned
    }
}

/// 流式图标探测命中回调。
pub(crate) async fn emit_icon_job(
    handle: AppHandle,
    job: crate::icons::IconFetchJob,
    url: String,
    level: i32,
    via: String,
) {
    save_and_emit(&handle, &job, &url, level, &via).await;
}

/// 读取全部已隐藏应用的 ID 集合（fail-closed：读取失败时向上传播错误）。
pub(crate) fn hidden_rule_ids(
    state: &AppState,
) -> Result<std::collections::HashSet<String>, String> {
    let db = state.db()?;
    let rules = db
        .get_all_rules()
        .map_err(|e| format!("读取隐藏规则失败: {}", e))?;
    Ok(rules
        .into_iter()
        .filter(|r| r.is_hidden)
        .map(|r| r.app_id)
        .collect())
}

/// `api_etag_cache` 仓库载荷软 TTL（12 小时，对齐趋势 L2 周期）：未满 12h 零网络秒返，
/// 满 12h 后进入条件请求发 `If-None-Match`（`304` 零配额 `touch_etag` 续期）。
pub(crate) const ENRICH_ETAG_SOFT_TTL_SECS: i64 = 12 * 3600;

/// 一批行的本地回填快照：已解析确认图标 + `app_icon_cycles` + `repo_card_cache` + `app_details` 摘要
/// + `api_etag_cache`。加载阶段每表常数次分片查询；回填计算阶段零 SQL、零磁盘。
#[derive(Default)]
pub(crate) struct BackfillCtx {
    cycles: crate::icons::IconCycleIndex,
    icons: crate::icons::ResolvedIcons,
    cards: HashMap<String, crate::db::RepoCardSnapshot>,
    details: HashMap<String, crate::models::AppDetail>,
    etags: HashMap<String, crate::db::etag::EtagCacheEntry>,
}

/// `BackfillCtx` 的预读键集合。
#[derive(Default)]
pub(crate) struct PrefetchKeys {
    coords: Vec<crate::icons::IconCoord>,
    ids: Vec<String>,
    urls: Vec<String>,
}

impl PrefetchKeys {
    /// 行自身：确认图标坐标、单仓富卡 / 详情 id 与 `releases/latest` 载荷端点。
    fn add_item(&mut self, item: &AppSummary) {
        let c = &item.core;
        self.coords
            .push(crate::icons::IconCoord::new(&c.id, &c.owner, &c.repo));
        self.ids.push(c.id.clone());
        if let Some((exact, lower)) = release_latest_urls(item) {
            self.urls.push(exact);
            self.urls.push(lower);
        }
    }

    /// 命中收录库的行：收录投影后的确认图标坐标。
    fn add_curated(&mut self, catalog: &crate::github::CatalogService, item: &AppSummary) {
        if let Some(cat) = catalog.get_catalog_item(&item.core.id) {
            self.coords
                .push(crate::icons::IconCoord::new(cat.id, cat.owner, cat.repo));
        }
    }

    /// 仓库坐标：确认图标、单仓富卡 / 详情 id；`with_endpoint` 时含 `/repos/{o}/{r}` 端点。
    fn add_coord(&mut self, coord: &crate::icons::RepoCoord, with_endpoint: bool) {
        self.coords.push(crate::icons::IconCoord::new(
            &coord.id,
            &coord.owner,
            &coord.repo,
        ));
        self.ids.push(coord.id.clone());
        if with_endpoint {
            self.urls.push(crate::github::github_repo_endpoint(
                &coord.owner,
                &coord.repo,
            ));
        }
    }
}

/// `releases/latest` 端点的原大小写与小写形态（非 GitHub 源或坐标缺失为 `None`）。
fn release_latest_urls(item: &AppSummary) -> Option<(String, String)> {
    let is_github = item
        .core
        .forge
        .as_deref()
        .unwrap_or("github")
        .eq_ignore_ascii_case("github");
    let owner = item.core.owner.trim();
    let repo = item.core.repo.trim();
    if !is_github || owner.is_empty() || repo.is_empty() {
        return None;
    }
    let exact = crate::github::github_latest_release_endpoint(owner, repo);
    let lower =
        crate::github::github_latest_release_endpoint(&owner.to_lowercase(), &repo.to_lowercase());
    Some((exact, lower))
}

impl BackfillCtx {
    /// DB 阶段（持锁）：批量读各表并产出确认图标解析计划（`known` 中已解析的坐标不再规划）。
    fn load(
        db: &crate::db::Database,
        keys: &PrefetchKeys,
        known: Option<&crate::icons::ResolvedIcons>,
    ) -> (Self, crate::icons::IconPlanBatch) {
        let cycles = crate::icons::IconCycleIndex::load(db, &keys.coords);
        let batch = crate::icons::IconPlanBatch::new(&cycles, &keys.coords, known);
        let ctx = Self {
            cards: db
                .get_repo_card_snapshots_batch(&keys.ids)
                .unwrap_or_default(),
            details: db
                .get_app_detail_summaries_batch(&keys.ids, false)
                .unwrap_or_default(),
            etags: db.get_etag_entries_batch(&keys.urls).unwrap_or_default(),
            icons: known.cloned().unwrap_or_default(),
            cycles,
        };
        (ctx, batch)
    }

    /// 持锁调用方的同步版本：图标磁盘阶段就地执行（测试入口）。
    #[cfg(test)]
    pub(crate) fn load_inline(
        db: &crate::db::Database,
        keys: &PrefetchKeys,
        known: Option<&crate::icons::ResolvedIcons>,
    ) -> Self {
        let (mut ctx, batch) = Self::load(db, keys, known);
        let icons = batch.resolve_inline(db, &crate::get_app_data_dir().join("icons"));
        ctx.icons.extend(icons);
        ctx
    }

    /// 已解析确认图标（`None`：无确认图标）。
    fn confirmed_icon(&self, app_id: &str, owner: &str, repo: &str) -> Option<String> {
        self.icons
            .get(&crate::icons::IconCoord::new(app_id, owner, repo))
    }

    fn card(&self, raw_id: &str) -> Option<&crate::db::RepoCardSnapshot> {
        crate::forge::canonical_app_id(raw_id).and_then(|id| self.cards.get(&id))
    }

    fn detail(&self, app_id: &str) -> Option<&crate::models::AppDetail> {
        self.details.get(app_id.trim())
    }

    fn etag(&self, url: &str) -> Option<String> {
        self.etags
            .get(url)
            .map(|e| e.etag.trim())
            .filter(|e| !e.is_empty())
            .map(str::to_string)
    }

    fn payload(&self, url: &str) -> Option<String> {
        self.etags.get(url).map(|e| e.payload_json.clone())
    }

    /// 仅当 `api_etag_cache` 条目存在且在 `max_age_secs` 软 TTL 窗口内时返回载荷。
    fn fresh_etag_payload(&self, url: &str, now: i64, max_age_secs: i64) -> Option<String> {
        let entry = self.etags.get(url)?;
        if now >= entry.last_checked_at && now.saturating_sub(entry.last_checked_at) < max_age_secs
        {
            Some(entry.payload_json.clone())
        } else {
            None
        }
    }

    /// 抽取 `api_etag_cache` 条件请求参数 `(cached_etag, cached_payload, soft_fresh_payload)`。
    fn enrich_etag_inputs(
        &self,
        repo_url: &str,
        now: i64,
        is_force: bool,
    ) -> (Option<String>, Option<String>, Option<String>) {
        let cached_payload = self.payload(repo_url);
        if is_force {
            (None, cached_payload, None)
        } else {
            (
                self.etag(repo_url),
                cached_payload,
                self.fresh_etag_payload(repo_url, now, ENRICH_ETAG_SOFT_TTL_SECS),
            )
        }
    }
}

/// 异步三段预读：短锁批量读表（`before_load` 在同一临界区内先执行，如落库新 ETag）→
/// 释放锁后在阻塞线程池读图标文件并编码 → 仅有自愈认领时再取短锁回写 `cache_file`。
async fn prefetch_backfill(
    state: &AppState,
    keys: &PrefetchKeys,
    known: Option<&crate::icons::ResolvedIcons>,
    before_load: impl FnOnce(&crate::db::Database),
) -> BackfillCtx {
    let loaded = match state.db() {
        Ok(db) => {
            before_load(&db);
            Some(BackfillCtx::load(&db, keys, known))
        }
        Err(_) => None,
    };
    let Some((mut ctx, batch)) = loaded else {
        return BackfillCtx::default();
    };
    let icons = batch.resolve_offloaded(state).await;
    ctx.icons.extend(icons);
    ctx
}

/// 单个坐标的确认图标：短锁读 `app_icon_cycles`，释放锁后在阻塞线程池读图标文件。
async fn resolve_confirmed_icon_offloaded(
    state: &AppState,
    app_id: &str,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let mut keys = PrefetchKeys::default();
    keys.coords
        .push(crate::icons::IconCoord::new(app_id, owner, repo));
    prefetch_backfill(state, &keys, None, |_| {})
        .await
        .confirmed_icon(app_id, owner, repo)
}

/// 从本地快照回填未收录卡片（图标、富卡缓存、详情缓存与 Release 载荷）；需写入时返回待落库的 `AppIconCycle`。
fn backfill_uncataloged_card_in(
    ctx: &BackfillCtx,
    item: &mut AppSummary,
) -> Option<crate::db::AppIconCycle> {
    let staged =
        if let Some(ci) = ctx.confirmed_icon(&item.core.id, &item.core.owner, &item.core.repo) {
            item.core.icon = ci;
            None
        } else if !item.core.icon.trim().is_empty() {
            // 合并首屏图标到对应槽位，保留已有槽位与 pinned 选择。
            let icon = item.core.icon.trim().to_string();
            let level = crate::icons::level_for_detail_icon(&icon);
            let mut cycle = ctx.cycles.exact(&item.core.id).cloned().unwrap_or_else(|| {
                crate::db::AppIconCycle::new(&item.core.id, &item.core.owner, &item.core.repo)
            });
            crate::icons::merge_detail_icon(&mut cycle, level, &icon, false, crate::now_secs());
            Some(cycle)
        } else {
            None
        };
    backfill_from_repo_card(ctx, item);
    if let Some(cached) = ctx.detail(&item.core.id) {
        crate::github::CatalogService::apply_detail_to_summary_core(&mut item.core, cached);
    }
    backfill_release_from_etag_cache(ctx, item);
    staged
}

/// 单条回填（测试入口）：就地加载该行快照后回填。
#[cfg(test)]
fn backfill_uncataloged_card(
    db: &crate::db::Database,
    item: &mut AppSummary,
) -> Option<crate::db::AppIconCycle> {
    let mut keys = PrefetchKeys::default();
    keys.add_item(item);
    let ctx = BackfillCtx::load_inline(db, &keys, None);
    backfill_uncataloged_card_in(&ctx, item)
}

/// 零网络单仓富卡回填：只补入站行的空缺或占位字段（平台、真实版本、简介、协议、主页、远端图标）；
/// 平台与版本含 `get_platforms_lite` 预写的平台壳。平台态与完整卡片取自同一行快照。
fn backfill_from_repo_card(ctx: &BackfillCtx, item: &mut AppSummary) {
    let core = &mut item.core;
    let Some(snap) = ctx.card(&core.id) else {
        return;
    };
    let state = &snap.platform;
    if core.platforms.is_empty() && !state.platforms.is_empty() {
        core.platforms = state.platforms.clone();
    }
    if is_placeholder_version(&core.latest_version)
        && !is_placeholder_version(&state.latest_version)
    {
        core.latest_version = state.latest_version.clone();
    }
    let Some(card) = &snap.card else {
        return;
    };
    let c = &card.summary.core;
    if is_placeholder_description(&core.description) && !c.description.trim().is_empty() {
        core.description = c.description.clone();
    }
    if core
        .description_en
        .as_deref()
        .is_none_or(is_placeholder_description)
        && c.description_en.is_some()
    {
        core.description_en = c.description_en.clone();
    }
    if is_placeholder_license(&core.license) && !c.license.trim().is_empty() {
        core.license = c.license.clone();
    }
    if core.homepage.as_deref().is_none_or(|h| h.trim().is_empty()) && c.homepage.is_some() {
        core.homepage = c.homepage.clone();
    }
    if core.icon.trim().is_empty() && !c.icon.trim().is_empty() {
        core.icon = c.icon.clone();
    }
}

/// 回填后仍无平台且 `repo_card_cache` 已确认无可安装资产。
fn repo_card_confirmed_other(ctx: &BackfillCtx, item: &AppSummary) -> bool {
    item.core.platforms.is_empty()
        && ctx
            .card(&item.core.id)
            .is_some_and(|s| s.platform.confirmed_other)
}

/// 未收录行写入 `repo_card_cache` 的待写条目（已收录返回 `None`）。
fn stage_repo_card(
    catalog: &crate::github::CatalogService,
    item: &AppSummary,
    confirmed_other: bool,
    is_private: Option<bool>,
) -> Option<crate::db::RepoCardUpsert> {
    if catalog.is_cataloged(&item.core.id) {
        return None;
    }
    Some(crate::db::RepoCardUpsert {
        summary: item.clone(),
        confirmed_other,
        is_private,
    })
}

/// 待写条目均经 `stage_repo_card` 按内存目录过滤，DAO 跳过已收录查表。
fn flush_repo_cards(db: &crate::db::Database, staged: &[crate::db::RepoCardUpsert]) {
    if !staged.is_empty() {
        let _ = db.upsert_uncataloged_repo_cards_batch(staged);
    }
}

/// 从 `api_etag_cache` 中的 `releases/latest` 载荷回填缺失的平台与版本号。
fn backfill_release_from_etag_cache(ctx: &BackfillCtx, item: &mut AppSummary) {
    let need_platforms = item.core.platforms.is_empty();
    let need_version = is_placeholder_version(&item.core.latest_version);
    if !need_platforms && !need_version {
        return;
    }
    let Some((exact, lower)) = release_latest_urls(item) else {
        return;
    };
    let payload = ctx.payload(&exact).or_else(|| {
        if lower == exact {
            None
        } else {
            ctx.payload(&lower)
        }
    });
    let Some(payload) = payload else {
        return;
    };
    let Ok(release) =
        serde_json::from_str::<crate::github::models::GitHubReleaseResponse>(&payload)
    else {
        return;
    };
    if need_platforms {
        let platforms =
            crate::github::detail_assets::lite_platforms_for_github_assets(&release.assets, None);
        if !platforms.is_empty() {
            item.core.platforms = platforms;
        }
    }
    if need_version && !release.tag_name.trim().is_empty() {
        item.core.latest_version = release.tag_name.trim().to_string();
    }
}

/// 搜索命中收录库时投影精选元数据（中文简介、官方图标、分类、预置平台），保留更新的远端 Star/Fork；
/// 用户轮换过的确认图标优先。返回是否已投影（已投影行不走未收录回填）。
fn project_curated_hit_in(
    ctx: &BackfillCtx,
    catalog: &crate::github::CatalogService,
    item: &mut AppSummary,
) -> bool {
    let Some(cat_item) = catalog.get_catalog_item(&item.core.id) else {
        return false;
    };
    let stars = item.core.stars.max(cat_item.stars);
    let forks = item.core.forks.max(cat_item.forks);
    let mut projected = catalog.item_to_stamped_summary(&cat_item);
    projected.core.stars = stars;
    projected.core.forks = forks;
    if let Some(ci) = ctx.confirmed_icon(
        &projected.core.id,
        &projected.core.owner,
        &projected.core.repo,
    ) {
        projected.core.icon = ci;
    }
    *item = projected;
    true
}

#[cfg(test)]
fn project_curated_hit(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    item: &mut AppSummary,
) -> bool {
    let mut keys = PrefetchKeys::default();
    keys.add_curated(catalog, item);
    let ctx = BackfillCtx::load_inline(db, &keys, None);
    project_curated_hit_in(&ctx, catalog, item)
}

/// 单仓直查命中：卡片 + 平台已确认 Other + 私有标记 + 是否需后台流式补图。
struct DirectLookupHit {
    item: AppSummary,
    confirmed_other: bool,
    is_private: bool,
    needs_icon_stream: bool,
}

/// 派生搜索结果后台流式图标探测（按 `SEARCH_GEN` 协作取消）。
fn spawn_search_icon_stream(
    app_handle: &AppHandle,
    candidates: Vec<crate::icons::RepoCoord>,
    token: Option<String>,
    search_id: &str,
    stop_gen: u64,
) {
    if candidates.is_empty() {
        return;
    }
    let handle = app_handle.clone();
    let jobs: Vec<crate::icons::IconFetchJob> = candidates
        .into_iter()
        .map(|coord| {
            coord.into_job(crate::icons::IconFetchCtx::Search {
                search_id: search_id.to_string(),
                gen: stop_gen,
            })
        })
        .collect();
    let cfg = crate::config::get_project_config().limits.icon_fetch;
    let should_stop: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
        std::sync::Arc::new(move || SEARCH_GEN.load(Ordering::SeqCst) != stop_gen);
    tokio::spawn(crate::icons::fetch_icons_stream(
        handle,
        jobs,
        token,
        cfg,
        emit_icon_job,
        Some(should_stop),
    ));
}

/// GitHub 单仓直查：优先命中本地缓存，未命中再请求 `/repos/{owner}/{repo}` 并回填详情与平台。
/// 缺确认图标时由调用方异步流式补图；失败返回 `None` 以便回退关键词搜索。
async fn direct_github_lookup(
    state: &AppState,
    coord: &crate::forge::UniversalRepoCoord,
    is_force: bool,
) -> Option<DirectLookupHit> {
    let target = crate::icons::RepoCoord {
        id: coord.to_app_id(),
        owner: coord.owner.clone(),
        repo: coord.repo.clone(),
    };
    let repo_url = crate::github::github_repo_endpoint(&target.owner, &target.repo);
    // 短锁预读（批量读表）→ 无锁读图标文件 → 本地富卡命中判定；owned 值跨 `await`。
    let mut pre_keys = PrefetchKeys::default();
    pre_keys.add_coord(&target, true);
    let pre_ctx = prefetch_backfill(state, &pre_keys, None, |_| {}).await;
    let pre_confirmed = pre_ctx.confirmed_icon(&target.id, &target.owner, &target.repo);
    let now = crate::now_secs();
    let (cached_etag, cached_payload, soft_fresh_payload) =
        pre_ctx.enrich_etag_inputs(&repo_url, now, is_force);
    let local_hit = if is_force {
        None
    } else {
        resolve_local_enrich_hit_in(
            &pre_ctx,
            &state.catalog,
            &target,
            pre_confirmed.as_deref(),
            soft_fresh_payload.as_deref(),
            true,
        )
    };
    let from_repo_card = matches!(&local_hit, Some((_, LocalHitSource::RepoCard)));
    let (mut item, etag_write, touched_url, is_stale_hit) = match local_hit {
        Some((hit, _)) => (hit, None, None, false),
        None => {
            let token = crate::commands::resolve_active_github_token(state);
            let out = state
                .catalog
                .fetch_online_repo_with_etag_outcome(
                    &target.owner,
                    &target.repo,
                    token.as_deref(),
                    Some(pre_confirmed.clone().unwrap_or_default()),
                    cached_etag,
                    cached_payload.clone(),
                    false,
                )
                .await
                .ok()?;
            (out.item, out.etag_write, out.touched_url, out.is_stale)
        }
    };
    let payload_private = etag_write
        .as_ref()
        .map(|(_, _, text)| text.as_str())
        .or(cached_payload.as_deref())
        .and_then(crate::github::search::repo_json_is_private);
    let mut post_keys = PrefetchKeys::default();
    post_keys.add_item(&item);
    post_keys.add_curated(&state.catalog, &item);
    let ctx = prefetch_backfill(state, &post_keys, Some(&pre_ctx.icons), |db| {
        let now = crate::now_secs();
        if let Some((url, etag, text)) = &etag_write {
            let _ = db.save_etag(url, etag, text, now);
        }
        if let Some(url) = &touched_url {
            let _ = db.touch_etag(url, now);
        }
    })
    .await;
    let mut confirmed_other = false;
    let mut card_private = false;
    if !project_curated_hit_in(&ctx, &state.catalog, &mut item) {
        let cycle = backfill_uncataloged_card_in(&ctx, &mut item);
        confirmed_other = repo_card_confirmed_other(&ctx, &item);
        let staged_card = if from_repo_card || is_stale_hit {
            if from_repo_card {
                card_private = ctx
                    .card(&item.core.id)
                    .and_then(|s| s.card.as_ref())
                    .is_some_and(|c| c.is_private);
            }
            None
        } else {
            stage_repo_card(&state.catalog, &item, confirmed_other, payload_private)
        };
        if cycle.is_some() || staged_card.is_some() {
            if let Ok(db) = state.db() {
                if let Some(cycle) = &cycle {
                    flush_icon_cycle_staged(&db, std::slice::from_ref(cycle));
                }
                if let Some(up) = &staged_card {
                    flush_repo_cards(&db, std::slice::from_ref(up));
                }
            }
        }
    }
    state.catalog.stamp_summary(&mut item);
    let needs_icon_stream = !state.catalog.is_cataloged(&item.core.id)
        && !item.core.icon.contains("simpleicons.org")
        && item.core.icon.trim().is_empty();
    Some(DirectLookupHit {
        item,
        confirmed_other,
        is_private: payload_private.unwrap_or(card_private),
        needs_icon_stream,
    })
}

/// 批量写入待更新的 `AppIconCycle`（批量事务失败时回退逐条写入）。
fn flush_icon_cycle_staged(db: &crate::db::Database, staged: &[crate::db::AppIconCycle]) {
    if staged.is_empty() {
        return;
    }
    if db.upsert_icon_cycles_batch(staged).is_err() {
        for c in staged {
            let _ = db.upsert_icon_cycle(c);
        }
    }
}

#[tauri::command]
pub async fn search_apps(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> crate::AppResult<Vec<AppSummary>> {
    let hidden_ids: std::collections::HashSet<String> = hidden_rule_ids(&state)?;

    let results = state.catalog.search_local_catalog(&query);
    let filtered: Vec<AppSummary> = if hidden_ids.is_empty() {
        results
    } else {
        results
            .into_iter()
            .filter(|a| !hidden_ids.contains(&a.core.id))
            .collect()
    };
    let paged = crate::github::catalog_feed_score::paginate_optional(filtered, limit, offset);
    Ok(paged)
}

/// 在线搜索：支持多源/GitHub 单仓直查（第 1 页返回单条）与 GitHub 关键词分页搜索。
/// 非强制刷新走 ETag 条件请求并合并本地缓存，缺图标的未收录项后台流式补齐。
#[tauri::command(rename_all = "camelCase")]
pub async fn search_apps_online(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    query: String,
    search_id: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    force_refresh: Option<bool>,
) -> crate::AppResult<OnlineSearchResult> {
    let is_force = force_refresh.unwrap_or(false);
    let search_start = std::time::Instant::now();
    let current_gen = SEARCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let actual_search_id = search_id.unwrap_or_else(|| current_gen.to_string());
    let eff_page = crate::config::LimitsConfig::normalize_online_search_page(page);
    let hidden_ids: std::collections::HashSet<String> = hidden_rule_ids(&state)?;
    // 优先检查是否为多源或单仓仓库直查坐标
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&query) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            // 单仓直查在 page > 1 时返回空页。
            if eff_page > 1 {
                return Ok(OnlineSearchResult::rows_only(
                    Vec::new(),
                    actual_search_id.clone(),
                ));
            }
            let host_token = if let Ok(db) = state.db() {
                db.get_host_token(&coord.host).ok().flatten()
            } else {
                None
            };
            if let Ok(repo_info) =
                crate::forge::ForgeRegistry::fetch_repo(&coord, host_token.as_deref()).await
            {
                let release_res = crate::forge::ForgeRegistry::fetch_latest_release(
                    &coord,
                    host_token.as_deref(),
                )
                .await;
                let release_ok = release_res.is_ok();
                let (latest_ver, platforms) = match release_res {
                    Ok(r) => {
                        let plats = crate::github::detail_assets::platforms_from_assets(&r.assets);
                        (r.tag_name, plats)
                    }
                    Err(_) => ("latest".to_string(), Vec::new()),
                };
                let mut ev =
                    crate::z_log::WideEvent::new("search", "online ok").with_started(search_start);
                ev.field("query", crate::log_support::short_reason(&query))
                    .field("hits", 1)
                    .dev("mode", "forge")
                    .dev("forge", coord.forge.as_str())
                    .dev("force", is_force);
                ev.info();
                let app_id = coord.to_app_id();
                if hidden_ids.contains(&app_id) {
                    return Ok(OnlineSearchResult::rows_only(
                        Vec::new(),
                        actual_search_id.clone(),
                    ));
                }
                let icon =
                    resolve_confirmed_icon_offloaded(&state, &app_id, &coord.owner, &coord.repo)
                        .await
                        .unwrap_or_default();
                let mut row = AppSummary {
                    core: AppCore {
                        id: app_id,
                        name: repo_info.name,
                        description_en: repo_info.description.clone(),
                        owner: coord.owner,
                        repo: coord.repo,
                        icon,
                        icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                        description: repo_info
                            .description
                            .unwrap_or_else(|| "跨平台开源项目".to_string()),
                        stars: repo_info.stars,
                        forks: repo_info.forks,
                        license: "OpenSource".to_string(),
                        latest_version: latest_ver,
                        category: "external".to_string(),
                        category_name: "跨平台开源".to_string(),
                        is_verified: false,
                        forge: Some(coord.forge.as_str().to_string()),
                        forge_host: Some(coord.host),
                        homepage: repo_info.homepage.clone(),
                        platforms,
                        is_cataloged: None,
                        source: None,
                        status: None,
                        added_at: None,
                    },
                };
                let confirmed_other = release_ok && row.core.platforms.is_empty();
                let staged = stage_repo_card(&state.catalog, &row, confirmed_other, None);
                if let (Some(up), Ok(db)) = (&staged, state.db()) {
                    flush_repo_cards(&db, std::slice::from_ref(up));
                }
                state.catalog.stamp_summary(&mut row);
                let id = row.core.id.to_lowercase();
                let mut result = OnlineSearchResult::rows_only(vec![row], actual_search_id.clone());
                if confirmed_other && staged.is_some() {
                    result.confirmed_other_ids.push(id);
                }
                return Ok(result);
            }
        } else if query.contains('/')
            || query.starts_with("https://")
            || query.starts_with("gh:")
            || query.starts_with("github:")
        {
            // 单仓直查在 page > 1 时返回空页。
            if eff_page > 1 {
                return Ok(OnlineSearchResult::rows_only(
                    Vec::new(),
                    actual_search_id.clone(),
                ));
            }
            if let Some(hit) = direct_github_lookup(&state, &coord, is_force).await {
                if hidden_ids.contains(&hit.item.core.id) {
                    return Ok(OnlineSearchResult::rows_only(
                        Vec::new(),
                        actual_search_id.clone(),
                    ));
                }
                let mut ev =
                    crate::z_log::WideEvent::new("search", "online ok").with_started(search_start);
                ev.field("query", crate::log_support::short_reason(&query))
                    .field("hits", 1)
                    .dev("mode", "direct")
                    .dev("force", is_force);
                ev.info();
                if hit.needs_icon_stream {
                    let token = crate::commands::resolve_active_github_token(&state);
                    let icon_coord = crate::icons::RepoCoord {
                        id: hit.item.core.id.to_lowercase(),
                        owner: hit.item.core.owner.clone(),
                        repo: hit.item.core.repo.clone(),
                    };
                    spawn_search_icon_stream(
                        &app_handle,
                        vec![icon_coord],
                        token,
                        &actual_search_id,
                        current_gen,
                    );
                }
                let id = hit.item.core.id.to_lowercase();
                let mut result =
                    OnlineSearchResult::rows_only(vec![hit.item], actual_search_id.clone());
                if hit.confirmed_other {
                    result.confirmed_other_ids.push(id.clone());
                }
                if hit.is_private {
                    result.private_ids.push(id);
                }
                return Ok(result);
            }
        }
    }

    let token = crate::commands::resolve_active_github_token(&state);

    // 关键词搜索走 ETag 条件请求，await 期间不持 DB 锁。
    let endpoint = crate::github::search::online_search_endpoint(&query, page, per_page);
    let (cached_etag, cached_payload) = match (&endpoint, state.db()) {
        (Some(ep), Ok(db)) => {
            let etag = if is_force {
                None
            } else {
                db.get_etag(ep).ok().flatten()
            };
            (etag, db.get_cached_payload(ep).ok().flatten())
        }
        _ => (None, None),
    };
    let fetched = match state
        .catalog
        .search_github_online(
            &query,
            token.as_deref(),
            page,
            per_page,
            cached_etag.as_deref(),
            cached_payload.as_deref(),
            None,
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let mut ev =
                crate::z_log::WideEvent::new("search", "online failed").with_started(search_start);
            ev.field("query", crate::log_support::short_reason(&query))
                .field("reason", crate::log_support::short_reason(&e))
                .dev("page", eff_page)
                .dev("force", is_force);
            ev.warn();
            return Err(e.into());
        }
    };
    let search_stale = fetched.is_stale;
    let search_not_modified = fetched.touched_url.is_some();
    let private_set: std::collections::HashSet<String> = fetched.private_ids.into_iter().collect();
    let mut confirmed_other_set: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut results = fetched.summaries;
    let repo_seeds: Vec<(String, String)> = if search_stale {
        Vec::new()
    } else {
        fetched
            .repo_payloads
            .into_iter()
            .filter(|(id, _, _)| !state.catalog.is_cataloged(id))
            .map(|(_, url, json)| (url, json))
            .collect()
    };

    // 批量预读本地快照并在纯内存中回填，随后批量落库。
    let mut keys = PrefetchKeys::default();
    for item in &results {
        keys.add_item(item);
        keys.add_curated(&state.catalog, item);
    }
    let ctx = prefetch_backfill(&state, &keys, None, |db| {
        let now = crate::now_secs();
        if let Some((url, etag, text)) = &fetched.etag_write {
            let _ = db.save_etag(url, etag, text, now);
        }
        if let Some(url) = &fetched.touched_url {
            let _ = db.touch_etag(url, now);
        }
        if !repo_seeds.is_empty() {
            let _ = db.seed_repo_payloads_batch(&repo_seeds, now);
        }
    })
    .await;
    let mut staged: Vec<crate::db::AppIconCycle> = Vec::new();
    let mut cards: Vec<crate::db::RepoCardUpsert> = Vec::new();
    let mut has_confirmed: Vec<bool> = Vec::with_capacity(results.len());
    for item in &mut results {
        if project_curated_hit_in(&ctx, &state.catalog, item) {
            has_confirmed.push(true);
            continue;
        }
        has_confirmed.push(
            ctx.confirmed_icon(&item.core.id, &item.core.owner, &item.core.repo)
                .is_some(),
        );
        if let Some(cycle) = backfill_uncataloged_card_in(&ctx, item) {
            staged.push(cycle);
        }
        let id = item.core.id.to_lowercase();
        let confirmed_other = repo_card_confirmed_other(&ctx, item);
        if confirmed_other {
            confirmed_other_set.insert(id.clone());
        }
        let is_private = Some(private_set.contains(&id));
        if let Some(up) = stage_repo_card(&state.catalog, item, confirmed_other, is_private) {
            cards.push(up);
        }
    }
    // 回退旧载荷的 stale 结果不刷新单仓富卡新鲜度。
    if !search_stale || !staged.is_empty() {
        if let Ok(db) = state.db() {
            flush_icon_cycle_staged(&db, &staged);
            if !search_stale {
                flush_repo_cards(&db, &cards);
            }
        }
    }

    let probe_cap = crate::config::get_project_config()
        .limits
        .clamp_online_search_per_page(per_page);
    let candidates: Vec<crate::icons::RepoCoord> = {
        results
            .iter()
            .zip(has_confirmed.iter())
            .filter(|(item, confirmed)| {
                !state.catalog.is_cataloged(&item.core.id)
                    && !item.core.icon.contains("simpleicons.org")
                    && !**confirmed
            })
            .take(probe_cap)
            .map(|(item, _)| crate::icons::RepoCoord {
                id: item.core.id.to_lowercase(),
                owner: item.core.owner.clone(),
                repo: item.core.repo.clone(),
            })
            .collect()
    };

    let mut ev = crate::z_log::WideEvent::new("search", "online ok").with_started(search_start);
    ev.field("query", crate::log_support::short_reason(&query))
        .field("hits", results.len())
        .dev("mode", "keyword")
        .dev("page", eff_page)
        .dev("force", is_force)
        .dev("not_modified", search_not_modified)
        .dev("stale", search_stale)
        .dev("icon_jobs", candidates.len());
    ev.info();

    let filtered_results: Vec<AppSummary> = {
        let rows: Vec<AppSummary> = if hidden_ids.is_empty() {
            results
        } else {
            results
                .into_iter()
                .filter(|a| !hidden_ids.contains(&a.core.id))
                .collect()
        };
        rows.into_iter()
            .map(|mut row| {
                state.catalog.stamp_summary(&mut row);
                row
            })
            .collect()
    };

    spawn_search_icon_stream(
        &app_handle,
        candidates,
        token,
        &actual_search_id,
        current_gen,
    );

    let row_ids: Vec<String> = filtered_results
        .iter()
        .map(|r| r.core.id.to_lowercase())
        .collect();
    Ok(OnlineSearchResult {
        confirmed_other_ids: row_ids
            .iter()
            .filter(|id| confirmed_other_set.contains(*id))
            .cloned()
            .collect(),
        private_ids: row_ids
            .iter()
            .filter(|id| private_set.contains(*id))
            .cloned()
            .collect(),
        rows: filtered_results,
        sid: actual_search_id.clone(),
        is_stale: search_stale,
    })
}

/// 趋势未收录行 enrichment 入参：待查仓库坐标（与 TrendRepo.owner/repo 对齐）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrendEnrichRequest {
    pub owner: String,
    pub repo: String,
}

/// 校验趋势 enrich 仓库段：非空、非 `.`/`..` 且不含路径分隔符或空白控制字符。
fn valid_enrich_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg != "."
        && seg != ".."
        && !seg.contains(['/', '\\', ':', '?', '#'])
        && !seg.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// 规范化并截断趋势 enrich 目标列表（最多 40 项），非法坐标以 `None` 占位以保持位置对齐。
fn enrich_targets(repos: Vec<TrendEnrichRequest>) -> Vec<Option<crate::icons::RepoCoord>> {
    repos
        .into_iter()
        .take(40)
        .map(|r| {
            let owner = r.owner.trim().to_string();
            let repo = r.repo.trim().to_string();
            if !valid_enrich_segment(&owner) || !valid_enrich_segment(&repo) {
                return None;
            }
            let id = format!("{}/{}", owner.to_lowercase(), repo.to_lowercase());
            crate::forge::coord::canonical_app_id(&id)?;
            Some(crate::icons::RepoCoord { id, owner, repo })
        })
        .collect()
}

struct EnrichBatchJob {
    coord: crate::icons::RepoCoord,
    pre: Option<String>,
    cached_etag: Option<String>,
    cached_payload: Option<String>,
    fallback_detail: Option<AppSummary>,
}

/// 本地富卡命中来源（决定命中后是否回写 `repo_card_cache`：单仓富卡自身命中不刷新新鲜度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalHitSource {
    Catalog,
    RepoCard,
    Detail,
    Payload,
}

/// 趋势 enrich 本地缓存优先解析（零网络，测试入口：就地加载该坐标快照）。
#[cfg(test)]
pub(crate) fn resolve_local_enrich_hit(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    coord: &crate::icons::RepoCoord,
    pre_icon: Option<&str>,
    cached_payload: Option<&str>,
) -> Option<AppSummary> {
    resolve_local_enrich_hit_sourced(db, catalog, coord, pre_icon, cached_payload, true)
        .map(|(summary, _)| summary)
}

#[cfg(test)]
pub(crate) fn resolve_local_enrich_hit_sourced(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    coord: &crate::icons::RepoCoord,
    pre_icon: Option<&str>,
    cached_payload: Option<&str>,
    use_repo_card: bool,
) -> Option<(AppSummary, LocalHitSource)> {
    let mut keys = PrefetchKeys::default();
    keys.add_coord(coord, false);
    let ctx = BackfillCtx::load_inline(db, &keys, None);
    resolve_local_enrich_hit_in(
        &ctx,
        catalog,
        coord,
        pre_icon,
        cached_payload,
        use_repo_card,
    )
}

/// 按优先级从本地快照解析卡片：目录 → 新鲜 `repo_card_cache` → 详情缓存 → 仓库 JSON 载荷。
/// `use_repo_card = false` 时跳过 `repo_card_cache`（优先消费本次载荷）。
fn resolve_local_enrich_hit_in(
    ctx: &BackfillCtx,
    catalog: &crate::github::CatalogService,
    coord: &crate::icons::RepoCoord,
    pre_icon: Option<&str>,
    cached_payload: Option<&str>,
    use_repo_card: bool,
) -> Option<(AppSummary, LocalHitSource)> {
    let pre_icon = pre_icon.filter(|s| !s.trim().is_empty());
    if let Some(cat_item) = catalog.get_catalog_item(&coord.id) {
        let mut summary = catalog.item_to_stamped_summary(&cat_item);
        if let Some(ci) = pre_icon {
            summary.core.icon = ci.to_string();
        }
        return Some((summary, LocalHitSource::Catalog));
    }
    if use_repo_card {
        if let Some(card) = ctx.card(&coord.id).and_then(|s| s.card.as_ref()) {
            let age = crate::now_secs().saturating_sub(card.updated_at);
            if (0..crate::db::REPO_CARD_FRESH_TTL_SECS).contains(&age) {
                let mut summary = card.summary.clone();
                if let Some(ci) = pre_icon {
                    summary.core.icon = ci.to_string();
                }
                return Some((summary, LocalHitSource::RepoCard));
            }
        }
    }
    let detail = ctx.detail(&coord.id);
    if let Some(detail) = detail {
        let desc_ok = !detail.core.description.trim().is_empty()
            && !crate::github::models::is_placeholder_description(&detail.core.description);
        if desc_ok {
            let mut core = detail.core.clone();
            if let Some(ci) = pre_icon {
                core.icon = ci.to_string();
            } else if core.icon.trim().starts_with("data:") {
                core.icon.clear();
            }
            return Some((AppSummary { core }, LocalHitSource::Detail));
        }
    }
    if let Some(payload_json) = cached_payload {
        if let Ok(mut summary) = crate::github::CatalogService::parse_summary_from_repo_json(
            &coord.owner,
            &coord.repo,
            payload_json,
            pre_icon.map(|s| s.to_string()),
        ) {
            if let Some(detail) = detail {
                crate::github::CatalogService::apply_detail_to_summary_core(
                    &mut summary.core,
                    detail,
                );
            }
            return Some((summary, LocalHitSource::Payload));
        }
    }
    None
}

/// 单仓直查结果：卡片、待落库 ETag、304 待 touch 端点，以及是否为远端（含 `304`）成功结果（失败回退为 `false`）。
#[derive(Default)]
struct EnrichFetchOutcome {
    item: Option<AppSummary>,
    etag: Option<(String, String, String)>,
    touched_url: Option<String>,
    fetched: bool,
}

/// 批量直查趋势仓库详情（并发上限 5，单仓失败回退本地详情或 `None`）。
async fn fetch_enrich_batch(
    catalog: &crate::github::CatalogService,
    token: Option<String>,
    timeout_each: std::time::Duration,
    jobs: Vec<EnrichBatchJob>,
) -> Vec<EnrichFetchOutcome> {
    use futures_util::StreamExt;
    futures_util::stream::iter(jobs.into_iter().map(|job| {
        let token = token.clone();
        async move {
            if job.coord.owner.is_empty() || job.coord.repo.is_empty() {
                return EnrichFetchOutcome::default();
            }
            match tokio::time::timeout(
                timeout_each,
                catalog.fetch_online_repo_with_etag_outcome(
                    &job.coord.owner,
                    &job.coord.repo,
                    token.as_deref(),
                    job.pre,
                    job.cached_etag,
                    job.cached_payload,
                    // 首包只取仓库元数据快返；图标统一由后台 `fetch_icons_stream(Trend)` 补探一次。
                    false,
                ),
            )
            .await
            {
                Ok(Ok(out)) => EnrichFetchOutcome {
                    item: Some(out.item),
                    etag: out.etag_write,
                    touched_url: out.touched_url,
                    fetched: !out.is_stale,
                },
                Ok(Err(_)) | Err(_) => EnrichFetchOutcome {
                    item: job.fallback_detail,
                    etag: None,
                    touched_url: None,
                    fetched: false,
                },
            }
        }
    }))
    .buffered(5)
    .collect()
    .await
}

/// 批量丰富趋势榜未收录仓库卡片，并在后台流式补齐缺失图标（每次调用推进 `BOARD_GEN`）。
/// 最多处理前 40 项，单仓失败返回 `None` 以保持位置对齐。
#[tauri::command(rename_all = "camelCase")]
pub async fn enrich_trend_repos(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    repos: Vec<TrendEnrichRequest>,
    board: Option<String>,
    force_refresh: Option<bool>,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    let is_force = force_refresh.unwrap_or(false);
    let enrich_start = std::time::Instant::now();
    let board_name = board.unwrap_or_default().trim().to_lowercase();
    let cfg_icon = crate::config::get_project_config().limits.icon_fetch;
    let current_gen = next_board_gen();
    let slots = enrich_targets(repos);
    let requested = slots.len();
    let targets: Vec<crate::icons::RepoCoord> = slots.iter().flatten().cloned().collect();
    if targets.is_empty() {
        return Ok(vec![None; requested]);
    }
    let token = crate::commands::resolve_active_github_token(&state);
    let timeout_each = crate::config::api_timeout_or(std::time::Duration::from_secs(10));
    let catalog = &state.catalog;
    // 短锁预读本地富卡与 ETag（并发网络请求期间不持 DB 锁）。
    let mut pre_keys = PrefetchKeys::default();
    for coord in &targets {
        pre_keys.add_coord(coord, true);
    }
    let pre_ctx = prefetch_backfill(&state, &pre_keys, None, |_| {}).await;
    let pre_confirmed: Vec<Option<String>> = targets
        .iter()
        .map(|t| pre_ctx.confirmed_icon(&t.id, &t.owner, &t.repo))
        .collect();
    let mut local_hits: Vec<Option<AppSummary>> = vec![None; targets.len()];
    // 需写回 `repo_card_cache` 的结果下标（单仓富卡自身命中与失败回退不刷新新鲜度）。
    let mut card_writable: Vec<bool> = vec![false; targets.len()];
    let mut pre_etags: Vec<(Option<String>, Option<String>, Option<AppSummary>)> =
        vec![(None, None, None); targets.len()];
    let now = crate::now_secs();
    for (idx, coord) in targets.iter().enumerate() {
        let repo_url = crate::github::github_repo_endpoint(&coord.owner, &coord.repo);
        let (cached_etag, cached_payload, soft_fresh_payload) =
            pre_ctx.enrich_etag_inputs(&repo_url, now, is_force);
        if !is_force {
            if let Some((hit, source)) = resolve_local_enrich_hit_in(
                &pre_ctx,
                catalog,
                coord,
                pre_confirmed[idx].as_deref(),
                soft_fresh_payload.as_deref(),
                true,
            ) {
                card_writable[idx] =
                    matches!(source, LocalHitSource::Detail | LocalHitSource::Payload);
                local_hits[idx] = Some(hit);
                continue;
            }
        }
        let fallback_detail = pre_ctx.detail(&coord.id).map(|detail| {
            let mut core = detail.core.clone();
            if let Some(ref ci) = pre_confirmed[idx] {
                if !ci.trim().is_empty() {
                    core.icon = ci.clone();
                }
            } else if core.icon.trim().starts_with("data:") {
                core.icon.clear();
            }
            AppSummary { core }
        });
        pre_etags[idx] = (cached_etag, cached_payload, fallback_detail);
    }

    let pre_fast: Vec<Option<String>> = pre_confirmed
        .iter()
        .map(|p| Some(p.clone().unwrap_or_default()))
        .collect();
    let mut remote_indices: Vec<usize> = Vec::new();
    let mut batch_jobs: Vec<EnrichBatchJob> = Vec::new();
    for (idx, ((coord, pre), (cached_etag, cached_payload, fallback_detail))) in targets
        .clone()
        .into_iter()
        .zip(pre_fast)
        .zip(pre_etags)
        .enumerate()
    {
        if local_hits[idx].is_none() {
            remote_indices.push(idx);
            batch_jobs.push(EnrichBatchJob {
                coord,
                pre,
                cached_etag,
                cached_payload,
                fallback_detail,
            });
        }
    }
    let remote_results = if batch_jobs.is_empty() {
        Vec::new()
    } else {
        fetch_enrich_batch(catalog, token.clone(), timeout_each, batch_jobs).await
    };
    let mut results: Vec<Option<AppSummary>> = local_hits;
    let mut etags_to_save: Vec<(String, String, String)> = Vec::new();
    let mut etags_to_touch: Vec<String> = Vec::new();
    for (idx, outcome) in remote_indices.into_iter().zip(remote_results) {
        results[idx] = outcome.item;
        card_writable[idx] = outcome.fetched;
        if let Some(entry) = outcome.etag {
            etags_to_save.push(entry);
        }
        if let Some(url) = outcome.touched_url {
            etags_to_touch.push(url);
        }
    }

    // 落库新 ETag 并批量回填富卡与图标周期状态。
    let mut post_keys = PrefetchKeys::default();
    for item in results.iter().flatten() {
        post_keys.add_item(item);
    }
    let ctx = prefetch_backfill(&state, &post_keys, Some(&pre_ctx.icons), |db| {
        let now = crate::now_secs();
        for (url, etag, text) in &etags_to_save {
            let _ = db.save_etag(url, etag, text, now);
        }
        for url in &etags_to_touch {
            let _ = db.touch_etag(url, now);
        }
    })
    .await;
    let mut staged: Vec<crate::db::AppIconCycle> = Vec::new();
    let mut cards: Vec<crate::db::RepoCardUpsert> = Vec::new();
    for (idx, slot) in results.iter_mut().enumerate() {
        let Some(item) = slot.as_mut() else {
            continue;
        };
        if let Some(cycle) = backfill_uncataloged_card_in(&ctx, item) {
            staged.push(cycle);
        }
        if card_writable[idx] {
            let confirmed_other = repo_card_confirmed_other(&ctx, item);
            if let Some(up) = stage_repo_card(catalog, item, confirmed_other, None) {
                cards.push(up);
            }
        }
    }
    if !staged.is_empty() || !cards.is_empty() {
        if let Ok(db) = state.db() {
            flush_icon_cycle_staged(&db, &staged);
            flush_repo_cards(&db, &cards);
        }
    }

    // 为未收录且无确认图标的仓库派发后台流式补图。
    let jobs: Vec<crate::icons::IconFetchJob> = targets
        .into_iter()
        .zip(pre_confirmed)
        .filter(|(coord, pre)| !state.catalog.is_cataloged(&coord.id) && pre.is_none())
        .map(|(coord, _)| {
            coord.into_job(crate::icons::IconFetchCtx::Trend {
                board: board_name.clone(),
                gen: current_gen,
            })
        })
        .collect();
    if !jobs.is_empty() {
        let handle = app_handle.clone();
        let bg_token = token.clone();
        // 协作取消：切榜/重拉后旧世代 job 开探前即止（在飞探完仍走 emit，由 save_and_emit 收敛）。
        let stop_gen = current_gen;
        let should_stop: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
            std::sync::Arc::new(move || BOARD_GEN.load(Ordering::SeqCst) != stop_gen);
        tokio::spawn(crate::icons::fetch_icons_stream(
            handle,
            jobs,
            bg_token,
            cfg_icon,
            emit_icon_job,
            Some(should_stop),
        ));
    }

    // 收录态盖章，供前端判定徽标与收录入口。
    for row in results.iter_mut().flatten() {
        state.catalog.stamp_summary(row);
    }

    let hits = results.iter().filter(|r| r.is_some()).count();
    let missed = requested.saturating_sub(hits);
    if missed > 0 {
        let mut ev =
            crate::z_log::WideEvent::new("trends", "enrich partial").with_started(enrich_start);
        ev.field("requested", requested)
            .field("hits", hits)
            .field("missed", missed)
            .dev("board", &board_name)
            .dev("force", is_force);
        ev.warn();
    }
    // 按入参位置回填：非法坐标槽位保持 `None`。
    let mut valid_results = results.into_iter();
    Ok(slots
        .iter()
        .map(|slot| slot.as_ref().and_then(|_| valid_results.next().flatten()))
        .collect())
}

/// Star 列表单页组卡结果。
pub(crate) struct StarredCards {
    pub rows: Vec<AppSummary>,
    /// 无确认图标、需后台补图的坐标。
    pub need_icon: Vec<crate::icons::RepoCoord>,
    /// `repo_card_cache` 已确认无可安装资产的未收录行规范 id。
    pub confirmed_other_ids: Vec<String>,
    /// 私有仓库规范 id。
    pub private_ids: Vec<String>,
}

type StarredPayloadHit = (
    crate::github::developer_starred::StarredRepoPayload,
    AppSummary,
    Option<String>,
);

fn resolve_repo_payload_hits(
    pre_ctx: &BackfillCtx,
    catalog: &crate::github::CatalogService,
    items: Vec<crate::github::developer_starred::StarredRepoPayload>,
) -> (Vec<StarredPayloadHit>, PrefetchKeys) {
    let mut hits = Vec::with_capacity(items.len());
    let mut post_keys = PrefetchKeys::default();
    for item in items {
        let pre = pre_ctx.confirmed_icon(&item.coord.id, &item.coord.owner, &item.coord.repo);
        let Some((card, _)) = resolve_local_enrich_hit_in(
            pre_ctx,
            catalog,
            &item.coord,
            pre.as_deref(),
            Some(&item.payload),
            false,
        ) else {
            continue;
        };
        post_keys.add_item(&card);
        hits.push((item, card, pre));
    }
    (hits, post_keys)
}

fn build_starred_cards(
    ctx: &BackfillCtx,
    catalog: &crate::github::CatalogService,
    hits: Vec<StarredPayloadHit>,
) -> (
    StarredCards,
    Vec<crate::db::AppIconCycle>,
    Vec<crate::db::RepoCardUpsert>,
) {
    let mut rows = Vec::with_capacity(hits.len());
    let mut need_icon = Vec::new();
    let mut staged = Vec::new();
    let mut cards = Vec::new();
    let mut confirmed_other_ids = Vec::new();
    let mut private_ids = Vec::new();
    for (item, mut card, pre) in hits {
        if let Some(cycle) = backfill_uncataloged_card_in(ctx, &mut card) {
            staged.push(cycle);
        }
        if !catalog.is_cataloged(&card.core.id) {
            let id = card.core.id.to_lowercase();
            let confirmed_other = repo_card_confirmed_other(ctx, &card);
            if confirmed_other {
                confirmed_other_ids.push(id.clone());
            }
            if item.is_private {
                private_ids.push(id);
            }
            if let Some(up) =
                stage_repo_card(catalog, &card, confirmed_other, Some(item.is_private))
            {
                cards.push(up);
            }
        }
        catalog.stamp_summary(&mut card);
        if !catalog.is_cataloged(&card.core.id)
            && !card.core.icon.contains("simpleicons.org")
            && pre.is_none()
        {
            need_icon.push(item.coord);
        }
        rows.push(card);
    }
    (
        StarredCards {
            rows,
            need_icon,
            confirmed_other_ids,
            private_ids,
        },
        staged,
        cards,
    )
}

/// 基于仓库 JSON 载荷批量组卡（短锁读写库，阻塞线程池读取本地图标）。
pub(crate) async fn cards_from_repo_payloads_offloaded(
    state: &AppState,
    items: Vec<crate::github::developer_starred::StarredRepoPayload>,
    persist: bool,
    before_load: impl FnOnce(&crate::db::Database),
) -> StarredCards {
    let mut pre_keys = PrefetchKeys::default();
    for i in &items {
        pre_keys.add_coord(&i.coord, false);
    }
    let pre_ctx = prefetch_backfill(state, &pre_keys, None, before_load).await;
    let (hits, post_keys) = resolve_repo_payload_hits(&pre_ctx, &state.catalog, items);
    let ctx = prefetch_backfill(state, &post_keys, Some(&pre_ctx.icons), |_| {}).await;
    let (out, staged, cards) = build_starred_cards(&ctx, &state.catalog, hits);
    if !staged.is_empty() || (persist && !cards.is_empty()) {
        if let Ok(db) = state.db() {
            flush_icon_cycle_staged(&db, &staged);
            if persist {
                flush_repo_cards(&db, &cards);
            }
        }
    }
    out
}

/// 同步组卡（测试入口，图标磁盘阶段就地执行）。
#[cfg(test)]
pub(crate) fn cards_from_repo_payloads(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    items: Vec<crate::github::developer_starred::StarredRepoPayload>,
    persist: bool,
) -> StarredCards {
    let mut pre_keys = PrefetchKeys::default();
    for i in &items {
        pre_keys.add_coord(&i.coord, false);
    }
    let pre_ctx = BackfillCtx::load_inline(db, &pre_keys, None);
    let (hits, post_keys) = resolve_repo_payload_hits(&pre_ctx, catalog, items);
    let ctx = BackfillCtx::load_inline(db, &post_keys, Some(&pre_ctx.icons));
    let (out, staged, cards) = build_starred_cards(&ctx, catalog, hits);
    flush_icon_cycle_staged(db, &staged);
    if persist {
        flush_repo_cards(db, &cards);
    }
    out
}

/// 获取或推进 Star 列表补图世代（仅新查询第 1 页 +1）。
fn starred_icon_gen(new_query: bool) -> u64 {
    if new_query {
        STARRED_GEN.fetch_add(1, Ordering::SeqCst) + 1
    } else {
        STARRED_GEN.load(Ordering::SeqCst)
    }
}

/// 派生 Star 列表后台补图流；新查询推进世代以中止上一查询的在途探测。
pub(crate) fn spawn_starred_icon_stream(
    app_handle: &AppHandle,
    coords: Vec<crate::icons::RepoCoord>,
    token: Option<String>,
    new_query: bool,
) {
    // 先推进世代再判空：本页无需补图时也要让上一查询的流停下。
    let gen = starred_icon_gen(new_query);
    if coords.is_empty() {
        return;
    }
    let jobs: Vec<crate::icons::IconFetchJob> = coords
        .into_iter()
        .map(|coord| coord.into_job(crate::icons::IconFetchCtx::Starred { gen }))
        .collect();
    let cfg_icon = crate::config::get_project_config().limits.icon_fetch;
    let should_stop: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
        std::sync::Arc::new(move || STARRED_GEN.load(Ordering::SeqCst) != gen);
    tokio::spawn(crate::icons::fetch_icons_stream(
        app_handle.clone(),
        jobs,
        token,
        cfg_icon,
        emit_icon_job,
        Some(should_stop),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrich_targets_keeps_positions_and_rejects_dirty_segments() {
        let req = |owner: &str, repo: &str| TrendEnrichRequest {
            owner: owner.to_string(),
            repo: repo.to_string(),
        };
        let slots = enrich_targets(vec![
            req(" Owner ", " Repo "),
            req("", "repo"),
            req(".", "repo"),
            req("owner", ".."),
            req("own/er", "repo"),
            req("owner", "re po"),
            req("owner", "re\u{7}po"),
            req("gh:owner", "repo"),
            req("owner", "repo?x=1"),
            req("ok", "fine"),
        ]);
        assert_eq!(slots.len(), 10, "结果必须与入参逐位对齐");
        let first = slots[0].as_ref().expect("合法坐标保留");
        assert_eq!(
            (first.id.as_str(), first.owner.as_str(), first.repo.as_str()),
            ("owner/repo", "Owner", "Repo")
        );
        for (i, slot) in slots.iter().enumerate().take(9).skip(1) {
            assert!(slot.is_none(), "slot {i} 应被拒绝");
        }
        assert_eq!(slots[9].as_ref().map(|c| c.id.as_str()), Some("ok/fine"));
    }

    fn sample_summary(id: &str, owner: &str, repo: &str, icon: &str) -> AppSummary {
        AppSummary {
            core: AppCore {
                id: id.to_string(),
                name: "Demo".to_string(),
                description_en: None,
                owner: owner.to_string(),
                repo: repo.to_string(),
                icon: icon.to_string(),
                icon_bg: String::new(),
                description: String::new(),
                stars: 0,
                forks: 0,
                license: String::new(),
                latest_version: "latest".to_string(),
                category: "external".to_string(),
                category_name: String::new(),
                is_verified: false,
                forge: None,
                forge_host: None,
                homepage: None,
                platforms: Vec::new(),
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
            },
        }
    }

    #[test]
    fn backfill_uncataloged_card_keeps_twin_loop_semantics() {
        // 空图标无 staged 且保持原样 / L2品牌库 staged 构建 /
        // 非品牌库远端只标 L3 live / DB 命中直接覆盖且无 staged（M2回填走via=m2不占level）。
        let db = crate::db::Database::open_in_memory().unwrap();
        let mut empty = sample_summary("o/r", "o", "r", "");
        assert!(backfill_uncataloged_card(&db, &mut empty).is_none());
        assert!(empty.core.icon.is_empty());
        assert!(empty.core.platforms.is_empty());

        let mut l2 = sample_summary("s/i", "s", "i", "https://cdn.simpleicons.org/i");
        let c = backfill_uncataloged_card(&db, &mut l2).expect("l2 staged");
        assert_eq!(c.level, 2);
        assert_eq!(c.l2_url, "https://cdn.simpleicons.org/i");
        assert_eq!(c.selected_url, "https://cdn.simpleicons.org/i");
        assert_eq!(l2.core.icon, "https://cdn.simpleicons.org/i");

        let mut l3 = sample_summary(
            "t/r",
            "t",
            "r",
            "https://raw.githubusercontent.com/t/r/main/icon.png",
        );
        let c3 = backfill_uncataloged_card(&db, &mut l3).expect("l3 staged");
        assert_eq!(c3.level, 3);
        assert_eq!(
            c3.l3_url,
            "https://raw.githubusercontent.com/t/r/main/icon.png"
        );
        assert!(c3.l4_url.is_empty());
        assert_eq!(
            c3.selected_url,
            "https://raw.githubusercontent.com/t/r/main/icon.png"
        );

        let mut cycle = crate::db::AppIconCycle::new("c/r", "c", "r");
        cycle.is_cataloged = false;
        cycle.level = 2;
        cycle.l2_url = "https://example.com/c.png".to_string();
        cycle.selected_url = "https://example.com/c.png".to_string();
        cycle.updated_at = crate::now_secs();
        db.upsert_icon_cycle(&cycle).unwrap();
        let mut confirmed = sample_summary("c/r", "c", "r", "");
        assert!(backfill_uncataloged_card(&db, &mut confirmed).is_none());
        assert_eq!(confirmed.core.icon, "https://example.com/c.png");
    }

    fn release_json(tag: &str, asset: &str) -> String {
        serde_json::json!({
            "tag_name": tag,
            "body": null,
            "assets": [{
                "name": asset,
                "size": 50_000_000u64,
                "browser_download_url": format!("https://github.com/x/y/releases/download/{}/{}", tag, asset)
            }]
        })
        .to_string()
    }

    #[test]
    fn backfill_reads_cached_release_latest_when_no_app_detail() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.save_etag(
            "https://api.github.com/repos/acme/tool/releases/latest",
            "\"e1\"",
            &release_json("v2.3.4", "tool-setup-x64.exe"),
            crate::now_secs(),
        )
        .unwrap();
        // 收录外坐标大小写混合：精确未命中时回退小写端点。
        let mut card = sample_summary("acme/tool", "Acme", "Tool", "");
        backfill_uncataloged_card(&db, &mut card);
        assert_eq!(card.core.platforms, vec!["windows".to_string()]);
        assert_eq!(card.core.latest_version, "v2.3.4");

        // 已有平台与真实版本时不覆盖。
        let mut known = sample_summary("acme/tool", "acme", "tool", "");
        known.core.platforms = vec!["linux".to_string()];
        known.core.latest_version = "v9".to_string();
        backfill_uncataloged_card(&db, &mut known);
        assert_eq!(known.core.platforms, vec!["linux".to_string()]);
        assert_eq!(known.core.latest_version, "v9");

        // 非 GitHub forge 不读 GitHub 端点。
        let mut other = sample_summary("acme/tool", "acme", "tool", "");
        other.core.forge = Some("gitea".to_string());
        backfill_uncataloged_card(&db, &mut other);
        assert!(other.core.platforms.is_empty());

        // 损坏载荷静默跳过。
        db.save_etag(
            "https://api.github.com/repos/bad/json/releases/latest",
            "\"e2\"",
            "not-json",
            crate::now_secs(),
        )
        .unwrap();
        let mut bad = sample_summary("bad/json", "bad", "json", "");
        backfill_uncataloged_card(&db, &mut bad);
        assert!(bad.core.platforms.is_empty());
        assert_eq!(bad.core.latest_version, "latest");
    }

    #[test]
    fn backfill_prefers_app_detail_over_cached_release() {
        let db = crate::db::Database::open_in_memory().unwrap();
        db.save_etag(
            "https://api.github.com/repos/acme/tool/releases/latest",
            "\"e1\"",
            &release_json("v0.0.1", "tool-setup-x64.exe"),
            crate::now_secs(),
        )
        .unwrap();
        let mut core = sample_summary("acme/tool", "acme", "tool", "").core;
        core.description = "真实描述".to_string();
        core.latest_version = "v5.0.0".to_string();
        core.platforms = vec!["macos".to_string()];
        let detail = crate::models::AppDetail {
            core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        };
        db.save_app_detail("acme/tool", &detail).unwrap();
        let mut card = sample_summary("acme/tool", "acme", "tool", "");
        backfill_uncataloged_card(&db, &mut card);
        assert_eq!(card.core.platforms, vec!["macos".to_string()]);
        assert_eq!(card.core.latest_version, "v5.0.0");
    }

    fn curated_item() -> crate::github::models::CatalogItem {
        crate::github::models::CatalogItem {
            id: "acme/tool".to_string(),
            name: "精选工具".to_string(),
            owner: "acme".to_string(),
            repo: "tool".to_string(),
            icon: "https://official.example/tool.png".to_string(),
            icon_bg: "#111111".to_string(),
            description: "精选中文简介".to_string(),
            description_en: Some("Curated".to_string()),
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 100,
            forks: 50,
            is_verified: true,
            homepage: None,
            platforms: vec!["windows".to_string(), "linux".to_string()],
            identifiers: std::collections::HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        }
    }

    #[test]
    fn curated_projection_keeps_fresher_counts_and_skips_uncataloged() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::developer_starred::test_support::test_service();
        catalog.update_items(vec![curated_item()]);

        let mut hit = sample_summary("acme/tool", "acme", "tool", "");
        hit.core.description = "remote english".to_string();
        hit.core.stars = 250;
        hit.core.forks = 10;
        assert!(project_curated_hit(&db, &catalog, &mut hit));
        assert_eq!(hit.core.description, "精选中文简介");
        assert_eq!(hit.core.icon, "https://official.example/tool.png");
        assert_eq!(hit.core.category, "dev");
        assert_eq!(
            hit.core.platforms,
            vec!["windows".to_string(), "linux".to_string()]
        );
        assert_eq!(hit.core.stars, 250);
        assert_eq!(hit.core.forks, 50);
        assert_eq!(hit.core.is_cataloged, Some(true));

        let mut miss = sample_summary("other/repo", "other", "repo", "");
        assert!(!project_curated_hit(&db, &catalog, &mut miss));
        assert_eq!(miss.core.description, "");
    }

    #[test]
    fn trend_streaming_gen_bumps_exactly_once_per_call() {
        // 连续两次调用严格 +1。
        let a = super::next_board_gen();
        let b = super::next_board_gen();
        assert_eq!(b, a + 1);
    }

    #[test]
    fn select_gen_lane_selects_counter_by_ctx() {
        // 按上下文选择对应的全局世代计数器。
        let search = crate::icons::IconFetchCtx::Search {
            search_id: "s1".to_string(),
            gen: 7,
        };
        let (counter, gen) = super::select_gen_lane(&search);
        assert_eq!(gen, 7);
        assert!(std::ptr::eq(counter, &super::SEARCH_GEN));
        let trend = crate::icons::IconFetchCtx::Trend {
            board: "weekly".to_string(),
            gen: 3,
        };
        let (counter, gen) = super::select_gen_lane(&trend);
        assert_eq!(gen, 3);
        assert!(std::ptr::eq(counter, &super::BOARD_GEN));
        let starred = crate::icons::IconFetchCtx::Starred { gen: 5 };
        let (counter, gen) = super::select_gen_lane(&starred);
        assert_eq!(gen, 5);
        assert!(std::ptr::eq(counter, &super::STARRED_GEN));
        assert!(!std::ptr::eq(counter, &super::SEARCH_GEN));
    }

    #[test]
    fn emit_payload_carries_ctx_through_single_interface() {
        // 同一载荷构建口，Trend 上下文原样透传（id 小写归一，level/via 透传）。
        let job = crate::icons::IconFetchJob {
            id: "o/r".to_string(),
            owner: "O".to_string(),
            repo: "R".to_string(),
            ctx: crate::icons::IconFetchCtx::Trend {
                board: "weekly".to_string(),
                gen: 3,
            },
        };
        let p = crate::icons::icon_ready_payload(&job, "https://cdn.simpleicons.org/r", 2, "live");
        assert_eq!(p.id, "o/r");
        assert_eq!(p.level, 2);
        assert_eq!(p.via, "live");
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["context"]["kind"], "trend");
        assert_eq!(v["context"]["board"], "weekly");
        assert_eq!(v["context"]["gen"], 3);
    }

    fn stream_cycle(
        selected_level: i32,
        selected_url: &str,
        pinned: bool,
    ) -> crate::db::AppIconCycle {
        let mut c = crate::db::AppIconCycle::new("o/r", "o", "r");
        c.is_cataloged = false;
        c.level = selected_level;
        c.l2_url = "https://cdn.simpleicons.org/r".to_string();
        c.selected_url = selected_url.to_string();
        c.cache_file = "r.png".to_string();
        c.updated_at = 1000;
        c.pinned = pinned;
        c
    }

    #[test]
    fn stale_stream_hit_fills_slot_without_moving_selection() {
        // 不降级守卫：过期 L3 只补 l3 空槽（过期写库），level/selected/cache/updated_at 不动。
        let l3 = "https://raw.githubusercontent.com/o/r/main/icon.png";
        let mut c = stream_cycle(2, "https://cdn.simpleicons.org/r", false);
        let was_pinned = super::merge_stream_hit(&mut c, 3, l3, false, 2000, false);
        assert!(!was_pinned);
        assert_eq!(c.l3_url, l3);
        assert_eq!(c.level, 2);
        assert_eq!(c.selected_url, "https://cdn.simpleicons.org/r");
        assert_eq!(c.cache_file, "r.png");
        assert_eq!(c.updated_at, 1000);
    }

    #[test]
    fn fresh_stream_hit_merges_fully_like_merge_detail_icon() {
        // 新鲜命中全量合并：L3 收编选中。
        let l3 = "https://raw.githubusercontent.com/o/r/main/icon.png";
        let mut c = stream_cycle(2, "https://cdn.simpleicons.org/r", false);
        let was_pinned = super::merge_stream_hit(&mut c, 3, l3, false, 2000, true);
        assert!(!was_pinned);
        assert_eq!(c.level, 3);
        assert_eq!(c.l3_url, l3);
        assert_eq!(c.selected_url, l3);
        assert_eq!(c.updated_at, 2000);
    }

    #[test]
    fn stale_stream_hit_on_pinned_only_fills_slot() {
        // pinned 行新旧一致：过期 L4 只补槽，不改选中（返回 true）。
        let l4 = "https://raw.githubusercontent.com/o/r/main/logo.png";
        let mut c = stream_cycle(2, "https://cdn.simpleicons.org/r", true);
        let was_pinned = super::merge_stream_hit(&mut c, 4, l4, false, 2000, false);
        assert!(was_pinned);
        assert_eq!(c.l4_url, l4);
        assert_eq!(c.level, 2);
        assert_eq!(c.selected_url, "https://cdn.simpleicons.org/r");
        assert_eq!(c.updated_at, 1000);
    }

    #[test]
    fn stale_stream_hit_on_pinned_l5_keeps_badge() {
        // pinned L5（用户手动选空徽章）：过期命中只补槽，level=5 与双空选中态保持（锁徽章态）。
        let l4 = "https://raw.githubusercontent.com/o/r/main/logo.png";
        let mut c = crate::db::AppIconCycle::new("o/r", "o", "r");
        crate::icons::seal_empty_selection(&mut c);
        c.pinned = true;
        let was_pinned = super::merge_stream_hit(&mut c, 4, l4, false, 2000, false);
        assert!(was_pinned);
        assert_eq!(c.level, 5);
        assert!(c.selected_url.is_empty());
        assert!(c.cache_file.is_empty());
        assert_eq!(c.l4_url, l4);
    }

    #[test]
    fn backfill_uncataloged_card_hydrates_all_fields_from_details_cache_beyond_ttl() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let detail = crate::models::AppDetail {
            core: AppCore {
                id: "acme/rich".to_string(),
                name: "RichApp".to_string(),
                description_en: Some("Real English summary".to_string()),
                owner: "acme".to_string(),
                repo: "rich".to_string(),
                icon: "https://example.com/rich.png".to_string(),
                icon_bg: String::new(),
                description: "真实中文描述".to_string(),
                stars: 500,
                forks: 50,
                license: "Apache-2.0".to_string(),
                latest_version: "v2.4.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://rich.example.com".to_string()),
                platforms: vec!["windows".to_string(), "macos".to_string()],
                is_cataloged: Some(false),
                source: None,
                status: None,
                added_at: None,
            },
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        };
        db.save_app_detail("acme/rich", &detail).unwrap();
        // 模拟缓存已超过 2 小时（> 1800s TTL）
        db.touch_app_detail("acme/rich", crate::now_secs() - 7200)
            .unwrap();

        let mut card = sample_summary("acme/rich", "acme", "rich", "");
        card.core.description = "开源软件项目".to_string();
        card.core.license = "OpenSource".to_string();
        card.core.latest_version = "latest".to_string();

        let _ = backfill_uncataloged_card(&db, &mut card);
        assert_eq!(card.core.platforms, vec!["windows", "macos"]);
        assert_eq!(card.core.latest_version, "v2.4.0");
        assert_eq!(card.core.description, "真实中文描述");
        assert_eq!(
            card.core.description_en.as_deref(),
            Some("Real English summary")
        );
        assert_eq!(card.core.license, "Apache-2.0");
        assert_eq!(
            card.core.homepage.as_deref(),
            Some("https://rich.example.com")
        );
        assert_eq!(card.core.icon, "https://example.com/rich.png");
    }

    #[test]
    fn resolve_local_enrich_hit_serves_details_and_etag_cache_without_network() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new();

        // 1. 命中 app_details（非占位描述）+ 预确认图标
        let detail = crate::models::AppDetail {
            core: AppCore {
                id: "acme/from-detail".to_string(),
                name: "FromDetail".to_string(),
                description_en: Some("Detail EN".to_string()),
                owner: "acme".to_string(),
                repo: "from-detail".to_string(),
                icon: "data:image/png;base64,AAA".to_string(),
                icon_bg: String::new(),
                description: "详情真实描述".to_string(),
                stars: 321,
                forks: 12,
                license: "MIT".to_string(),
                latest_version: "v1.5.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://detail.example".to_string()),
                platforms: vec!["linux".to_string()],
                is_cataloged: Some(false),
                source: None,
                status: None,
                added_at: None,
            },
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        };
        db.save_app_detail("acme/from-detail", &detail).unwrap();
        let coord1 = crate::icons::RepoCoord {
            id: "acme/from-detail".to_string(),
            owner: "acme".to_string(),
            repo: "from-detail".to_string(),
        };
        let hit1 = resolve_local_enrich_hit(
            &db,
            &catalog,
            &coord1,
            Some("https://cdn.simpleicons.org/detail"),
            None,
        )
        .expect("should hit app_details");
        assert_eq!(hit1.core.stars, 321);
        assert_eq!(hit1.core.latest_version, "v1.5.0");
        assert_eq!(hit1.core.platforms, vec!["linux"]);
        assert_eq!(hit1.core.icon, "https://cdn.simpleicons.org/detail");

        // 2. app_details 为占位描述时，回退使用 api_etag_cache 仓库 JSON 并合并详情平台与版本
        let mut placeholder_detail = detail.clone();
        placeholder_detail.core.id = "acme/from-etag".to_string();
        placeholder_detail.core.repo = "from-etag".to_string();
        placeholder_detail.core.description = "GitHub 社区开源项目".to_string();
        db.save_app_detail("acme/from-etag", &placeholder_detail)
            .unwrap();
        let repo_json = r#"{
            "name": "FromEtag",
            "description": "Real description from ETag repo payload",
            "stargazers_count": 777,
            "forks_count": 88,
            "homepage": "https://etag.example",
            "license": { "spdx_id": "BSD-3-Clause" },
            "topics": ["developer", "terminal"]
        }"#;
        let coord2 = crate::icons::RepoCoord {
            id: "acme/from-etag".to_string(),
            owner: "acme".to_string(),
            repo: "from-etag".to_string(),
        };
        let hit2 = resolve_local_enrich_hit(&db, &catalog, &coord2, None, Some(repo_json))
            .expect("should hit api_etag_cache and merge detail platforms/version");
        assert_eq!(
            hit2.core.description,
            "Real description from ETag repo payload"
        );
        assert_eq!(hit2.core.stars, 777);
        assert_eq!(hit2.core.license, "BSD-3-Clause");
        assert_eq!(hit2.core.platforms, vec!["linux"]);
        assert_eq!(hit2.core.latest_version, "v1.5.0");
    }

    #[test]
    fn starred_icon_gen_advances_only_for_new_queries() {
        let first = super::starred_icon_gen(true);
        assert_eq!(super::starred_icon_gen(false), first);
        let second = super::starred_icon_gen(true);
        assert_eq!(second, first + 1);
        assert_eq!(super::starred_icon_gen(false), second);
    }

    #[test]
    fn starred_payload_cards_keep_order_and_stamp_uncataloged() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new();
        let body = serde_json::json!([
            {"name": "Zeta", "full_name": "acme/zeta", "description": "Zeta tool",
             "stargazers_count": 42u64, "forks_count": 3u64},
            {"name": "Alpha", "full_name": "acme/alpha", "description": "Alpha lib",
             "stargazers_count": 7u64}
        ])
        .to_string();
        let items = crate::github::developer_starred::parse_starred_payloads(&body).unwrap();
        let StarredCards {
            rows, need_icon, ..
        } = cards_from_repo_payloads(&db, &catalog, items, true);
        let ids: Vec<&str> = rows.iter().map(|r| r.core.id.as_str()).collect();
        assert_eq!(ids, vec!["acme/zeta", "acme/alpha"]);
        assert_eq!(rows[0].core.description, "Zeta tool");
        assert_eq!(rows[0].core.stars, 42);
        assert_eq!(rows[0].core.is_cataloged, Some(false));
        // 无确认图标的未收录行进入后台补图。
        assert_eq!(need_icon.len(), 2);

        // 已收录目录项不进入后台补图队列。
        let catalog_with_item = crate::github::CatalogService::new_empty();
        catalog_with_item.update_items(vec![crate::github::CatalogItem {
            id: "acme/zeta".to_string(),
            name: "Zeta".to_string(),
            description: "Zeta".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            icon: "https://example.com/zeta.png".to_string(),
            icon_bg: String::new(),
            stars: 10,
            forks: 1,
            license: "MIT".to_string(),
            default_version: "v1.0.0".to_string(),
            is_verified: true,
            owner: "acme".to_string(),
            repo: "zeta".to_string(),
            platforms: vec!["windows".to_string()],
            identifiers: Default::default(),
            aliases: vec![],
            install_dirs: vec![],
            publishers: vec![],
            search_subdirs: vec![],
            homepage: None,
            added_at: None,
        }]);
        let body2 = serde_json::json!([
            {"name": "Zeta", "full_name": "acme/zeta"},
            {"name": "Alpha", "full_name": "acme/alpha"}
        ])
        .to_string();
        let items2 = crate::github::developer_starred::parse_starred_payloads(&body2).unwrap();
        let StarredCards {
            rows: rows2,
            need_icon: need_icon2,
            ..
        } = cards_from_repo_payloads(&db, &catalog_with_item, items2, true);
        assert_eq!(rows2[0].core.is_cataloged, Some(true));
        assert_eq!(need_icon2.len(), 1);
        assert_eq!(need_icon2[0].id, "acme/alpha");
    }

    #[test]
    fn detail_writeback_updates_catalog_apps_and_preserves_official_icon() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let seed_items = vec![
            crate::github::CatalogItem {
                id: "acme/with-icon".to_string(),
                name: "WithIcon".to_string(),
                description: "desc".to_string(),
                description_en: None,
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                icon: "https://official.example/logo.png".to_string(),
                icon_bg: String::new(),
                stars: 10,
                forks: 1,
                license: "OpenSource".to_string(),
                default_version: "v1.0.0".to_string(),
                is_verified: true,
                owner: "acme".to_string(),
                repo: "with-icon".to_string(),
                platforms: vec![],
                identifiers: Default::default(),
                aliases: vec![],
                install_dirs: vec![],
                publishers: vec![],
                search_subdirs: vec![],
                homepage: None,
                added_at: None,
            },
            crate::github::CatalogItem {
                id: "acme/no-icon".to_string(),
                name: "NoIcon".to_string(),
                description: "desc".to_string(),
                description_en: None,
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                stars: 5,
                forks: 0,
                license: "unknown".to_string(),
                default_version: "latest".to_string(),
                is_verified: false,
                owner: "acme".to_string(),
                repo: "no-icon".to_string(),
                platforms: vec![],
                identifiers: Default::default(),
                aliases: vec![],
                install_dirs: vec![],
                publishers: vec![],
                search_subdirs: vec![],
                homepage: None,
                added_at: None,
            },
        ];
        db.seed_catalog_apps_if_empty(&seed_items).unwrap();

        let mut d1 = sample_summary(
            "acme/with-icon",
            "acme",
            "with-icon",
            "https://probed.example/other.png",
        );
        d1.core.stars = 999;
        d1.core.latest_version = "v2.0.0".to_string();
        d1.core.license = "MIT".to_string();
        d1.core.platforms = vec!["windows".to_string()];
        let detail1 = crate::models::AppDetail {
            core: d1.core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        };
        crate::repositories::DetailRepository::persist_detail_bundle(
            &db,
            "acme/with-icon",
            &detail1,
            None,
            &[],
        )
        .unwrap();

        let mut d2 = sample_summary(
            "acme/no-icon",
            "acme",
            "no-icon",
            "https://probed.example/filled.png",
        );
        d2.core.stars = 50;
        d2.core.latest_version = "v1.1.0".to_string();
        let detail2 = crate::models::AppDetail {
            core: d2.core,
            changelog: String::new(),
            readme_markdown: String::new(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        };
        crate::repositories::DetailRepository::persist_detail_bundle(
            &db,
            "acme/no-icon",
            &detail2,
            None,
            &[],
        )
        .unwrap();

        let catalog = crate::github::CatalogService::new_empty();
        catalog.sync_from_db(&db);

        let item1 = catalog.get_catalog_item("acme/with-icon").unwrap();
        assert_eq!(item1.stars, 999);
        assert_eq!(item1.default_version, "v2.0.0");
        assert_eq!(item1.license, "MIT");
        assert_eq!(item1.platforms, vec!["windows"]);
        assert_eq!(
            item1.icon, "https://official.example/logo.png",
            "existing catalog icon must not be overwritten by detail probe"
        );

        let item2 = catalog.get_catalog_item("acme/no-icon").unwrap();
        assert_eq!(item2.stars, 50);
        assert_eq!(item2.default_version, "v1.1.0");
        assert_eq!(
            item2.icon, "https://probed.example/filled.png",
            "empty catalog icon should be filled from detail HTTP icon"
        );
    }
}

#[cfg(test)]
mod repo_card_pipeline_tests {
    use super::*;

    #[test]
    fn starred_cards_persist_private_flag_and_report_confirmed_other() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new_empty();
        db.patch_repo_card_platforms("acme/zero", "acme", "zero", &[], None, true)
            .unwrap();
        let body = serde_json::json!([
            {"name": "secret", "full_name": "me/secret", "description": "Private tool",
             "stargazers_count": 1u64, "private": true},
            {"name": "zero", "full_name": "acme/zero", "description": "No releases",
             "stargazers_count": 9u64, "visibility": "public"}
        ])
        .to_string();
        let items = crate::github::developer_starred::parse_starred_payloads(&body).unwrap();
        let cards = cards_from_repo_payloads(&db, &catalog, items, true);
        assert_eq!(cards.private_ids, vec!["me/secret"]);
        assert_eq!(cards.confirmed_other_ids, vec!["acme/zero"]);

        let secret = db
            .get_repo_card("me/secret")
            .unwrap()
            .expect("card persisted");
        assert!(secret.is_private);
        assert_eq!(secret.summary.core.description, "Private tool");
        let zero = db
            .get_repo_card("acme/zero")
            .unwrap()
            .expect("preseed upgraded");
        assert!(zero.confirmed_other);
        assert_eq!(zero.summary.core.stars, 9);

        db.delete_private_repo_cards().unwrap();
        assert!(db.get_repo_card("me/secret").unwrap().is_none());
    }

    #[test]
    fn stale_starred_page_does_not_write_repo_cards() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new_empty();
        let body = serde_json::json!([{"name": "x", "full_name": "acme/x"}]).to_string();
        let items = crate::github::developer_starred::parse_starred_payloads(&body).unwrap();
        let cards = cards_from_repo_payloads(&db, &catalog, items, false);
        assert_eq!(cards.rows.len(), 1);
        assert!(db.get_repo_card("acme/x").unwrap().is_none());
    }

    #[test]
    fn backfill_fills_placeholders_from_repo_card_and_fresh_card_serves_enrich_hit() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new_empty();
        let mut full = AppSummary {
            core: AppCore {
                id: "acme/tool".to_string(),
                name: "tool".to_string(),
                description_en: Some("Real".to_string()),
                owner: "acme".to_string(),
                repo: "tool".to_string(),
                icon: "https://avatars.githubusercontent.com/u/3".to_string(),
                icon_bg: String::new(),
                description: "Real".to_string(),
                stars: 5,
                forks: 0,
                license: "MIT".to_string(),
                latest_version: "v3.0.0".to_string(),
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: Some("https://tool.example".to_string()),
                platforms: vec!["macos".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
            },
        };
        db.upsert_repo_card(&crate::db::RepoCardUpsert {
            summary: full.clone(),
            confirmed_other: false,
            is_private: None,
        })
        .unwrap();

        full.core.description = "开源软件项目".to_string();
        full.core.description_en = None;
        full.core.license = "OpenSource".to_string();
        full.core.latest_version = "latest".to_string();
        full.core.homepage = None;
        full.core.icon = String::new();
        full.core.platforms = vec![];
        backfill_uncataloged_card(&db, &mut full);
        assert_eq!(full.core.description, "Real");
        assert_eq!(full.core.description_en.as_deref(), Some("Real"));
        assert_eq!(full.core.license, "MIT");
        assert_eq!(full.core.latest_version, "v3.0.0");
        assert_eq!(full.core.homepage.as_deref(), Some("https://tool.example"));
        assert_eq!(full.core.platforms, vec!["macos"]);

        let coord = crate::icons::RepoCoord {
            id: "acme/tool".to_string(),
            owner: "acme".to_string(),
            repo: "tool".to_string(),
        };
        let (hit, source) =
            resolve_local_enrich_hit_sourced(&db, &catalog, &coord, None, None, true).unwrap();
        assert_eq!(source, LocalHitSource::RepoCard);
        assert_eq!(hit.core.stars, 5);
        assert!(
            resolve_local_enrich_hit_sourced(&db, &catalog, &coord, None, None, false).is_none()
        );
    }

    #[test]
    fn backfill_ctx_enforces_12h_soft_ttl_on_api_etag_cache() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let catalog = crate::github::CatalogService::new();
        let coord = crate::icons::RepoCoord {
            id: "acme/soft-ttl".to_string(),
            owner: "acme".to_string(),
            repo: "soft-ttl".to_string(),
        };
        let url = crate::github::github_repo_endpoint(&coord.owner, &coord.repo);
        let payload = r#"{
            "name": "soft-ttl",
            "description": "Cached repo payload",
            "stargazers_count": 42,
            "forks_count": 3
        }"#;
        let checked_at = 1_700_000_000i64;
        db.save_etag(&url, "W/\"e1\"", payload, checked_at).unwrap();

        let mut keys = super::PrefetchKeys::default();
        keys.add_coord(&coord, true);
        let ctx = super::BackfillCtx::load_inline(&db, &keys, None);
        assert_eq!(ctx.etag(&url).as_deref(), Some("W/\"e1\""));

        // 未满 12h：返回载荷并可零网络命中
        let fresh =
            ctx.fresh_etag_payload(&url, checked_at + 3600, super::ENRICH_ETAG_SOFT_TTL_SECS);
        assert!(fresh.is_some());
        let (hit, source) = super::resolve_local_enrich_hit_in(
            &ctx,
            &catalog,
            &coord,
            None,
            fresh.as_deref(),
            true,
        )
        .unwrap();
        assert_eq!(source, super::LocalHitSource::Payload);
        assert_eq!(hit.core.stars, 42);

        // 满 12h：soft TTL 返回 None，必须进入条件请求队列携带 ETag 校验 304
        assert!(ctx
            .fresh_etag_payload(
                &url,
                checked_at + super::ENRICH_ETAG_SOFT_TTL_SECS,
                super::ENRICH_ETAG_SOFT_TTL_SECS,
            )
            .is_none());
        // 时钟回拨（now < last_checked_at）：同样不复用软缓存
        assert!(ctx
            .fresh_etag_payload(&url, checked_at - 10, super::ENRICH_ETAG_SOFT_TTL_SECS)
            .is_none());
    }
}
