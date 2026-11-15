use crate::models::{AppCore, AppSummary};
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};

static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

/// 趋势流式世代：`enrich_trend_repos` 每次调用 +1（切榜/重拉均+1，
/// 类比 `SEARCH_GEN` 每次 `search_apps_online` +1）。
/// 后台 `fetch_icons_stream(Trend{board,gen})` 的世代防串用（合并时按新鲜度取全量/补槽 +
/// emit 前查 gen，过期写库攒槽、过期 return 只拦发送），
/// 用户切榜后旧榜在途探测结果直接抛弃发送（与搜索防串词同语义）。
static BOARD_GEN: AtomicU64 = AtomicU64::new(0);

/// 流式世代分配：每次调用恰好 +1。唯一调用点为 `enrich_trend_repos`。
fn next_board_gen() -> u64 {
    BOARD_GEN.fetch_add(1, Ordering::SeqCst) + 1
}

/// Star 列表补图世代：每次新查询（第 1 页）+1，续拉页沿用当前值。
/// 换查询后上一查询的在途补图开探前即止、命中只落库不发送；与趋势/搜索世代互不影响。
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

// 网络超时统一经 `config::api_timeout_or` 单一来源（统一配置中枢同一键）；
// 本模块一律直调 `crate::config`。

/// emit 世代通道选择（纯选择器，可单测）：`ctx` 决定查哪一个全局世代计数器 + 期望 gen。
/// 搜索、趋势与 Star 列表共用同一套落库/emit，仅世代计数器不同。
fn select_gen_lane(ctx: &crate::icons::IconFetchCtx) -> (&'static AtomicU64, u64) {
    match ctx {
        crate::icons::IconFetchCtx::Search { gen, .. } => (&SEARCH_GEN, *gen),
        crate::icons::IconFetchCtx::Trend { gen, .. } => (&BOARD_GEN, *gen),
        crate::icons::IconFetchCtx::Starred { gen } => (&STARRED_GEN, *gen),
    }
}

/// 图标命中落库 + 前端 emit 唯一实现（读旧行合并后 `upsert_icon_cycle` + 单发新事件，搜索/趋势同源）。
/// level纯L：经 `merge_stream_hit` 按来源入槽（`level=2`进 `l2_url`，`level=3`进 `l3_url`），
/// 新鲜命中全量合并，过期命中仅补空槽不降级；02 pinned 行只补槽不改选中；via=live|m2，远端探测走live，DB落盘回填走m2。
/// - 只发统一 `zstore://icon-ready{id,icon,level,via,context}`（`context` 原样透传 `job.ctx`，
///   载荷经 core `icons::icon_ready_payload` 构建）；
/// - 世代防串：合并时按新鲜度取全量/补槽 + emit 前查 `select_gen_lane(ctx)`（搜索查 SEARCH_GEN，
///   趋势查 BOARD_GEN；过期写库攒槽，过期 return 只拦发送；切榜/重搜抛弃过时在途结果，同语义）；
/// - 单条显式事务边界（单语句隐式事务显式化，仍 1 提交，emit 不延迟）；
///   失败 `ROLLBACK` 返回 Err，内部吞错下次补探重试。
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
        // 05 多槽合并：先读旧行再合并（M6），保留已有槽位与 02 pinned 选择；
        // 新鲜命中按本次命中收编，过期命中仅补对应空槽不降级（见 `merge_stream_hit`）；
        // pinned 行仅补对应空槽，不改选中图。
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
        // 05 悬空配对修复：未 pinned 且选中变化时旧 cache_file 失效（等真地址下载认领）；
        // pinned 行不动（merge 已保持 selected/cache 配对）；过期补槽不改选中，此处恒为假。
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
    // emit 前查 gen：过期只拦发送，不拦上面的入库（过期写库攒槽）。
    let current_emit_gen = gen_counter.load(Ordering::SeqCst);
    if current_emit_gen != expected_gen {
        return;
    }
    // 单发：新统一事件（载荷 schema 归 core 所有，见 `icons`）。
    let ready = crate::icons::icon_ready_payload(job, url, level, via);
    crate::icons::emit_icon_ready(handle, &ready);
}

/// 流式命中合并（不降级守卫，纯函数可单测）：新鲜 gen 沿用 `merge_detail_icon` 全量合并；
/// 过期 gen 仅补对应空槽（`fill_probe_slot`），不动 level/selected/cache/updated_at；
/// pinned 行两者一致（merge 内已是补槽语义，返回 true）。
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
        // 过期分支只补空槽：`keep_cataloged` 即行内原值（调用方传入 `cycle.is_cataloged`），无需回写。
        crate::icons::fill_probe_slot(cycle, level, url);
        cycle.pinned
    }
}

/// `icons::fetch_icons_stream` 的命中回调（搜索/趋势同一口）。
/// 世代防串由 `save_and_emit` 内合并新鲜度 + emit 前检查执行（计数器经 `ctx` 选择）。
/// `via`=live|m2 透传（core探测一律live，M2回填走m2不占level）。
async fn emit_icon_job(
    handle: AppHandle,
    job: crate::icons::IconFetchJob,
    url: String,
    level: i32,
    via: String,
) {
    save_and_emit(&handle, &job, &url, level, &via).await;
}

/// 隐藏规则 id 集合（本地收敛 `search_apps` / `get_category_apps` 重复块）。
pub(crate) fn hidden_rule_ids(state: &AppState) -> std::collections::HashSet<String> {
    if let Ok(db) = state.db() {
        db.get_all_rules()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.is_hidden)
            .map(|r| r.app_id)
            .collect()
    } else {
        std::collections::HashSet::new()
    }
}

/// 未收录卡片回填：确认图标覆盖 → 待写 icon_cycle 构建 → 详情缓存 platforms join。
/// level纯L，via正交：DB落盘命中为M2回填走via=m2不占level；远端只标L2/L3 live。
/// level 经 `level_for_detail_icon` 判定入对应槽（2=品牌库，4=README 头部，3=仓库树），via正交：
/// 返回 `Some(cycle)` 时由调用方收进 `staged` 批量落库；无事可写返回 `None`。
/// 纯同步无 `await`（调用方单临界区内复用 db 锁，批量 upsert 仍在调用点）。
fn backfill_uncataloged_card(
    db: &crate::db::Database,
    item: &mut AppSummary,
) -> Option<crate::db::AppIconCycle> {
    let staged = if let Some(ci) = crate::icons::resolve_confirmed_icon_from_db(
        db,
        &item.core.id,
        &item.core.owner,
        &item.core.repo,
    ) {
        item.core.icon = ci;
        None
    } else if !item.core.icon.trim().is_empty() {
        // 05 首屏回填收敛到 merge（与流式 save_and_emit 同口径）：先读旧行再合并，
        // 保留流式已攒槽位与 pinned 选择；level 经 level_for_detail_icon 判定入槽。
        let icon = item.core.icon.trim().to_string();
        let level = crate::icons::level_for_detail_icon(&icon);
        let mut cycle = db
            .get_icon_cycle(&item.core.id)
            .ok()
            .flatten()
            .unwrap_or_else(|| {
                crate::db::AppIconCycle::new(&item.core.id, &item.core.owner, &item.core.repo)
            });
        crate::icons::merge_detail_icon(&mut cycle, level, &icon, false, crate::now_secs());
        Some(cycle)
    } else {
        None
    };
    backfill_from_repo_card(db, item);
    // 全字段本地详情回填：只要 app_details 有该应用记录，
    // 即经共享 `apply_detail_to_summary_core` 回填 platforms、真实版本、非占位描述、协议、主页与图标。
    if let Ok(Some(cached)) = db.get_app_detail(&item.core.id, None) {
        crate::github::CatalogService::apply_detail_to_summary_core(&mut item.core, &cached);
    }
    backfill_release_from_etag_cache(db, item);
    staged
}

fn is_placeholder_license(v: &str) -> bool {
    let t = v.trim();
    t.is_empty()
        || t == "..."
        || t.eq_ignore_ascii_case("unknown")
        || t.eq_ignore_ascii_case("noassertion")
        || t == "OpenSource"
}

/// 零网络单仓富卡回填：只补入站行的空缺或占位字段（平台、真实版本、简介、协议、主页、远端图标）；
/// 平台与版本含 `get_platforms_lite` 预写的平台壳。
fn backfill_from_repo_card(db: &crate::db::Database, item: &mut AppSummary) {
    let core = &mut item.core;
    if let Ok(Some(state)) = db.get_repo_card_platform_state(&core.id) {
        if core.platforms.is_empty() && !state.platforms.is_empty() {
            core.platforms = state.platforms;
        }
        if is_placeholder_version(&core.latest_version)
            && !is_placeholder_version(&state.latest_version)
        {
            core.latest_version = state.latest_version;
        }
    }
    let Ok(Some(card)) = db.get_repo_card(&core.id) else {
        return;
    };
    let c = card.summary.core;
    let is_placeholder = crate::github::detail_fetch::is_placeholder_description;
    if is_placeholder(&core.description) && !c.description.trim().is_empty() {
        core.description = c.description;
    }
    if core.description_en.as_deref().is_none_or(is_placeholder) && c.description_en.is_some() {
        core.description_en = c.description_en;
    }
    if is_placeholder_license(&core.license) && !c.license.trim().is_empty() {
        core.license = c.license;
    }
    if core.homepage.as_deref().is_none_or(|h| h.trim().is_empty()) && c.homepage.is_some() {
        core.homepage = c.homepage;
    }
    if core.icon.trim().is_empty() && !c.icon.trim().is_empty() {
        core.icon = c.icon;
    }
}

/// 回填后仍无平台且 `repo_card_cache` 已确认无可安装资产。
fn repo_card_confirmed_other(db: &crate::db::Database, item: &AppSummary) -> bool {
    item.core.platforms.is_empty()
        && db
            .get_repo_card_platform_state(&item.core.id)
            .ok()
            .flatten()
            .is_some_and(|s| s.confirmed_other)
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

fn flush_repo_cards(db: &crate::db::Database, staged: &[crate::db::RepoCardUpsert]) {
    if !staged.is_empty() {
        let _ = db.upsert_repo_cards_batch(staged);
    }
}

/// 版本号是否仍为占位（空串或 `latest`），需要从缓存的 Release 补齐。
fn is_placeholder_version(v: &str) -> bool {
    let t = v.trim();
    t.is_empty() || t.eq_ignore_ascii_case("latest")
}

/// 零网络 Release 回填：`app_details` 未提供平台或真实版本时，读 `api_etag_cache` 中
/// `get_platforms_lite` 落下的 `releases/latest` 载荷，推导平台并取 `tag_name`。
/// `get_platforms_lite` 只写条件请求缓存、不写 `app_details`，因此重启后靠这里复原已知平台。
/// 端点按原大小写与小写各查一次（收录坐标保留大小写，外部合成坐标为小写）。
fn backfill_release_from_etag_cache(db: &crate::db::Database, item: &mut AppSummary) {
    let need_platforms = item.core.platforms.is_empty();
    let need_version = is_placeholder_version(&item.core.latest_version);
    if !need_platforms && !need_version {
        return;
    }
    let is_github = item
        .core
        .forge
        .as_deref()
        .unwrap_or("github")
        .eq_ignore_ascii_case("github");
    let owner = item.core.owner.trim();
    let repo = item.core.repo.trim();
    if !is_github || owner.is_empty() || repo.is_empty() {
        return;
    }
    let exact = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );
    let lower = exact.to_lowercase();
    let payload = db.get_cached_payload(&exact).ok().flatten().or_else(|| {
        if lower == exact {
            None
        } else {
            db.get_cached_payload(&lower).ok().flatten()
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
fn project_curated_hit(
    db: &crate::db::Database,
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
    if let Some(ci) = crate::icons::resolve_confirmed_icon_from_db(
        db,
        &projected.core.id,
        &projected.core.owner,
        &projected.core.repo,
    ) {
        projected.core.icon = ci;
    }
    *item = projected;
    true
}

/// 单仓直查命中：卡片 + 平台已确认 Other + 私有标记。
struct DirectLookupHit {
    item: AppSummary,
    confirmed_other: bool,
    is_private: bool,
}

/// GitHub 单仓直查（`owner/repo`、`https://github.com/...`、`gh:...`）：
/// 非强刷先查本地富卡（收录库 / 新鲜单仓富卡 / 详情缓存 / 仓库 ETag 载荷），未命中再走 `/repos/{o}/{r}` 条件请求；
/// 返回前统一回填详情与 `releases/latest` 平台、确认图标并盖收录章，未收录行写入 `repo_card_cache`。
/// 失败返回 `None`，由调用方回退关键词搜索。
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
    let repo_url = format!(
        "https://api.github.com/repos/{}/{}",
        urlencoding::encode(&target.owner),
        urlencoding::encode(&target.repo)
    );
    // 短锁预读（同步无 `await`）：确认图标、ETag、旧载荷与本地富卡命中，owned 值跨 `await`。
    let (pre_confirmed, cached_etag, cached_payload, local_hit) = match state.db() {
        Ok(db) => {
            let pre = crate::icons::resolve_confirmed_icon_from_db(
                &db,
                &target.id,
                &target.owner,
                &target.repo,
            );
            let etag = if is_force {
                None
            } else {
                db.get_etag(&repo_url).ok().flatten()
            };
            let payload = db.get_cached_payload(&repo_url).ok().flatten();
            let hit = if is_force {
                None
            } else {
                resolve_local_enrich_hit_sourced(
                    &db,
                    &state.catalog,
                    &target,
                    pre.as_deref(),
                    payload.as_deref(),
                    true,
                )
            };
            (pre, etag, payload, hit)
        }
        Err(_) => (None, None, None, None),
    };
    let from_repo_card = matches!(&local_hit, Some((_, LocalHitSource::RepoCard)));
    let (mut item, etag_write) = match local_hit {
        Some((hit, _)) => (hit, None),
        None => {
            let token = crate::commands::resolve_active_github_token(state);
            state
                .catalog
                .fetch_online_repo_with_etag(
                    &target.owner,
                    &target.repo,
                    token.as_deref(),
                    pre_confirmed,
                    cached_etag,
                    cached_payload.clone(),
                    true,
                )
                .await
                .ok()?
        }
    };
    let payload_private = etag_write
        .as_ref()
        .map(|(_, _, text)| text.as_str())
        .or(cached_payload.as_deref())
        .and_then(crate::github::search::repo_json_is_private);
    let mut confirmed_other = false;
    let mut card_private = false;
    if let Ok(db) = state.db() {
        if let Some((url, etag, text)) = &etag_write {
            let _ = db.save_etag(url, etag, text, crate::now_secs());
        }
        if !project_curated_hit(&db, &state.catalog, &mut item) {
            if let Some(cycle) = backfill_uncataloged_card(&db, &mut item) {
                flush_icon_cycle_staged(&db, std::slice::from_ref(&cycle));
            }
            confirmed_other = repo_card_confirmed_other(&db, &item);
            if from_repo_card {
                card_private = db
                    .get_repo_card(&item.core.id)
                    .ok()
                    .flatten()
                    .is_some_and(|c| c.is_private);
            } else if let Some(up) =
                stage_repo_card(&state.catalog, &item, confirmed_other, payload_private)
            {
                flush_repo_cards(&db, std::slice::from_ref(&up));
            }
        }
    }
    state.catalog.stamp_summary(&mut item);
    Some(DirectLookupHit {
        item,
        confirmed_other,
        is_private: payload_private.unwrap_or(card_private),
    })
}

/// icon_cycle 待写批量落库（`search_apps_online` / `enrich_trend_repos` 双调用点收敛）：
/// 事务边界：`BEGIN IMMEDIATE` → N 条 `upsert_icon_cycles_batch` → `COMMIT`；
/// 失败整体 `ROLLBACK` 并回退逐条（保持 `let _ =` 吞错 + 下次重试语义）。
/// 空 staged 直接跳过；纯同步无 `await`（调用方单临界区内复用 db 锁）。
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
    let hidden_ids: std::collections::HashSet<String> = hidden_rule_ids(&state);

    // 本地收录叠加搜索（含本地，可搜与远端同行为）：目录模块统一合并远端 + 本地收录。
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

/// 在线搜索（可翻页）：`page`/`per_page` 均为 None=默认行为（第 1 页 20 条）。
/// - `per_page` 默认复用 `limits.online_search_page_size`，钳制 1-50；
/// - `page` 默认 1（0 归一为 1）；`owner/repo` 直查短路只回第 1 页 1 条，page>1 回空（与 mock 同语义）。
/// - 关键词搜索与 GitHub 单仓直查均走 `api_etag_cache` 条件请求（`304` 零配额），失败时有旧载荷则回退；
///   命中收录库的行投影精选元数据，未收录行回填详情与 `releases/latest` 平台；
/// - `force_refresh=true`（显式重试）跳过 ETag 预读与本地富卡快径，直探远端。
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
    // 单次 search_apps 只记一行 INFO `search done`（行为链 sid 关联），此处为唯一 INFO。
    let search_start = std::time::Instant::now();
    let current_gen = SEARCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let actual_search_id = search_id.unwrap_or_else(|| current_gen.to_string());
    // 直查单条：page>1 直接回空（与 mock/前端翻页契约对齐，避免翻页重复首条）。
    let eff_page = crate::config::LimitsConfig::normalize_online_search_page(page);
    // 1. 优先检查是否为多源 (Codeberg, Gitea, 自建源) 仓库 URL 或 short syntax
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&query) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            // 直查单条：page>1 回空（mock 同语义）。
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
                let icon = if let Ok(db) = state.db() {
                    crate::icons::resolve_confirmed_icon_from_db(
                        &db,
                        &app_id,
                        &coord.owner,
                        &coord.repo,
                    )
                    .unwrap_or_default()
                } else {
                    String::new()
                };
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
            // 直查单条：page>1 回空（mock 同语义）。
            if eff_page > 1 {
                return Ok(OnlineSearchResult::rows_only(
                    Vec::new(),
                    actual_search_id.clone(),
                ));
            }
            if let Some(hit) = direct_github_lookup(&state, &coord, is_force).await {
                let mut ev =
                    crate::z_log::WideEvent::new("search", "online ok").with_started(search_start);
                ev.field("query", crate::log_support::short_reason(&query))
                    .field("hits", 1)
                    .dev("mode", "direct")
                    .dev("force", is_force);
                ev.info();
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
    let hidden_ids: std::collections::HashSet<String> = hidden_rule_ids(&state);

    // 关键词搜索走 `api_etag_cache` 条件请求：非强刷时短锁预读 ETag 与旧载荷，`await` 期间零 DB。
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

    // 循环外一次取 `db` 锁复用（单临界区同步无 `await`）：ETag 落库/保鲜 + 收录投影 + 未收录回填，
    // icon_cycle 写包事务化（`BEGIN IMMEDIATE` → N 条 → `COMMIT`，失败回退逐条）。
    if let Ok(db) = state.db() {
        let now = crate::now_secs();
        if let Some((url, etag, text)) = &fetched.etag_write {
            let _ = db.save_etag(url, etag, text, now);
        }
        if let Some(url) = &fetched.touched_url {
            let _ = db.touch_etag(url, now);
        }
        let mut staged: Vec<crate::db::AppIconCycle> = Vec::new();
        let mut cards: Vec<crate::db::RepoCardUpsert> = Vec::new();
        for item in &mut results {
            if project_curated_hit(&db, &state.catalog, item) {
                continue;
            }
            if let Some(cycle) = backfill_uncataloged_card(&db, item) {
                staged.push(cycle);
            }
            let id = item.core.id.to_lowercase();
            let confirmed_other = repo_card_confirmed_other(&db, item);
            if confirmed_other {
                confirmed_other_set.insert(id.clone());
            }
            let is_private = Some(private_set.contains(&id));
            if let Some(up) = stage_repo_card(&state.catalog, item, confirmed_other, is_private) {
                cards.push(up);
            }
        }
        flush_icon_cycle_staged(&db, &staged);
        // 回退旧载荷的 stale 结果不刷新单仓富卡新鲜度。
        if !search_stale {
            flush_repo_cards(&db, &cards);
        }
    }

    // 后台图标补探量随分页 `per_page` 伸缩：None=默认 20 条，其余为钳制后 1-50。
    let probe_cap = crate::config::get_project_config()
        .limits
        .clamp_online_search_per_page(per_page);
    // 搜索对齐趋势：已确认（`selected_url` 非空）不进 jobs，
    // 复用 `icons::resolve_confirmed_icon_from_db` + `icons::icon_key`，
    // 抄趋势 `filter pre.is_none()` 语义，省重复探。
    let pre_confirmed: Vec<Option<String>> = if let Ok(db) = state.db() {
        results
            .iter()
            .map(|item| {
                crate::icons::resolve_confirmed_icon_from_db(
                    &db,
                    &crate::icons::icon_key(&item.core.owner, &item.core.repo),
                    &item.core.owner,
                    &item.core.repo,
                )
            })
            .collect()
    } else {
        results.iter().map(|_| None).collect()
    };
    let candidates: Vec<crate::icons::RepoCoord> = {
        // 本地收录同样视为已收录（目录模块统一判定）：跳过图标补探。
        results
            .iter()
            .zip(pre_confirmed.iter())
            .filter(|(item, pre)| {
                !state.catalog.is_cataloged(&item.core.id)
                    && !item.core.icon.contains("simpleicons.org")
                    && pre.is_none()
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
        // 收录态盖章（未收录即 is_cataloged=false），避免前端重复 join 目录。
        rows.into_iter()
            .map(|mut row| {
                state.catalog.stamp_summary(&mut row);
                row
            })
            .collect()
    };

    if !candidates.is_empty() {
        let handle = app_handle.clone();
        let sid = actual_search_id.clone();
        let bg_token = token.clone();
        // 搜索与趋势统一走流式路（见 ADR-0015 §7）：
        // pool=5 buffer_unordered、快命中即返不等慢、慢仅快未命中且有 token 时跑、
        // 整批总量按页伸缩、逐张到达 emit。
        let jobs: Vec<crate::icons::IconFetchJob> = candidates
            .into_iter()
            .map(|coord| {
                coord.into_job(crate::icons::IconFetchCtx::Search {
                    search_id: sid.clone(),
                    gen: current_gen,
                })
            })
            .collect();
        let cfg = crate::config::get_project_config().limits.icon_fetch;
        // 协作取消：重搜后旧世代 job 开探前即止（在飞探完仍走 emit，由 save_and_emit 收敛）。
        let stop_gen = current_gen;
        let should_stop: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
            std::sync::Arc::new(move || SEARCH_GEN.load(Ordering::SeqCst) != stop_gen);
        tokio::spawn(crate::icons::fetch_icons_stream(
            handle,
            jobs,
            bg_token,
            cfg,
            emit_icon_job,
            Some(should_stop),
        ));
    }

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

/// 趋势 enrich 目标整形：take(40) 兜底截断 + trim + 小写 id。
/// FE 单次批量 40 上限，此处截断不静默吃超量。
fn enrich_targets(repos: Vec<TrendEnrichRequest>) -> Vec<crate::icons::RepoCoord> {
    repos
        .into_iter()
        .take(40)
        .map(|r| {
            let owner = r.owner.trim().to_string();
            let repo = r.repo.trim().to_string();
            let id = format!("{}/{}", owner.to_lowercase(), repo.to_lowercase());
            crate::icons::RepoCoord { id, owner, repo }
        })
        .collect()
}

/// 趋势 enrich 确认图标短锁预解析：同步无 `await`，锁即取即放；
/// fetch 内零查询零直连。`db=None`（锁失败）时全 `None`，回退兜底不 panic。
fn enrich_pre_confirmed(
    db: Option<&crate::db::Database>,
    targets: &[crate::icons::RepoCoord],
) -> Vec<Option<String>> {
    match db {
        Some(db) => targets
            .iter()
            .map(|t| crate::icons::resolve_confirmed_icon_from_db(db, &t.id, &t.owner, &t.repo))
            .collect(),
        None => targets.iter().map(|_| None).collect(),
    }
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

/// 趋势 enrich 本地缓存优先解析（单锁同步，零网络）：
/// 按顺序检查 `CatalogService`、新鲜 `repo_card_cache`、`app_details`（非占位描述）与 `api_etag_cache`。
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

/// `resolve_local_enrich_hit` 的带来源版本；`use_repo_card = false` 时跳过单仓富卡
/// （Star 列表每页携带完整仓库 JSON，优先采用本次载荷）。
pub(crate) fn resolve_local_enrich_hit_sourced(
    db: &crate::db::Database,
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
        if let Ok(Some(card)) = db.get_repo_card(&coord.id) {
            let age = crate::now_secs().saturating_sub(card.updated_at);
            if (0..crate::db::REPO_CARD_FRESH_TTL_SECS).contains(&age) {
                let mut summary = card.summary;
                if let Some(ci) = pre_icon {
                    summary.core.icon = ci.to_string();
                }
                return Some((summary, LocalHitSource::RepoCard));
            }
        }
    }
    if let Ok(Some(detail)) = db.get_app_detail(&coord.id, None) {
        let desc_ok = !detail.core.description.trim().is_empty()
            && !crate::github::detail_fetch::is_placeholder_description(&detail.core.description);
        if desc_ok {
            let mut core = detail.core;
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
            if let Ok(Some(detail)) = db.get_app_detail(&coord.id, None) {
                crate::github::CatalogService::apply_detail_to_summary_core(
                    &mut summary.core,
                    &detail,
                );
            }
            return Some((summary, LocalHitSource::Payload));
        }
    }
    None
}

/// 单仓直查结果：卡片、待落库 ETag，以及是否为远端（含 `304`）成功结果（失败回退为 `false`）。
#[derive(Default)]
struct EnrichFetchOutcome {
    item: Option<AppSummary>,
    etag: Option<(String, String, String)>,
    fetched: bool,
}

/// 趋势 enrich 单仓批量直查：并发上限 5（`buffered` 保序，返回与入参一一对齐，fetch 内零 DB 直连）；
/// 不内联探图（`probe_icons=false`）；单仓 `api_timeout_or(10s)` 熔断；单仓失败回退 `fallback_detail` 或 `None`。
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
                catalog.fetch_online_repo_with_etag(
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
                Ok(Ok((item, etag_to_save))) => EnrichFetchOutcome {
                    item: Some(item),
                    etag: etag_to_save,
                    fetched: true,
                },
                Ok(Err(_)) | Err(_) => EnrichFetchOutcome {
                    item: job.fallback_detail,
                    etag: None,
                    fetched: false,
                },
            }
        }
    }))
    .buffered(5)
    .collect()
    .await
}

/// 趋势未收录行 enrichment：批量复用搜索单仓直查
/// （`fetch_online_repo` → `fallback_summary`，图标 initials 回退/分类猜测沿用，platforms 未知置空 []）。
/// 配额/鉴权沿用既有链路（`resolve_active_github_token` + 内层 `notify_rate_limit`）。
/// - 并发上限 5（`buffered` 保序，返回与入参一一对齐）；单仓 `api_timeout_or(10s)` 熔断；
/// - 单仓失败落 `None`（前端保留旧小行，榜单永不因此变空）；
///   入参上限 40（FE 单次批量 40 上限，整批失败即整批缺席；BE 侧 take(40) 截断，buffered(5) 不变）。
/// - 趋势流式：首屏 `fallback_summary(probe=false)` 空壳快返（图标置空，
///   确认图标仍经 `pre_confirmed` 短锁回填，platforms 经详情缓存 join 照旧），
///   另起 `tokio::spawn(fetch_icons_stream(ctx=Trend{board,board_gen}))` 流式
///   `emit_icon_ready` 逐张到达补齐（弱网首屏先出裸行/初始富卡，图标逐个补齐，
///   空永不覆盖实由前端 `iconStore.admitIconHit` + 后端合并新鲜度与 emit 前查保证）；
/// - 世代：每次调用 `BOARD_GEN+1`（切榜/重拉均+1，类比 `SEARCH_GEN`），
///   落库/emit 世代防串见唯一 `save_and_emit`（合并新鲜度 + emit 前查 gen，计数器经 `ctx` 选择）。
/// - `force_refresh` 为手动刷新按钮透传位（前端统一调用签名）；
///   网络默认允许：默认即走批量直查 + 后台 `fetch_icons_stream`，与显式手动刷新同路。
#[tauri::command(rename_all = "camelCase")]
pub async fn enrich_trend_repos(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    repos: Vec<TrendEnrichRequest>,
    board: Option<String>,
    force_refresh: Option<bool>,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    // 手动刷新与默认同路：批量直查本就每次走网络，此处仅记录触发来源供诊断。
    let is_force = force_refresh.unwrap_or(false);
    let enrich_start = std::time::Instant::now();
    let board_name = board.unwrap_or_default().trim().to_lowercase();
    let cfg_icon = crate::config::get_project_config().limits.icon_fetch;
    // 世代：每次调用 +1（切榜/重拉均触发新调用，类比 SEARCH_GEN）。
    let current_gen = next_board_gen();
    // 首屏 probe=false 空壳快返 + 后台 fetch_icons_stream。
    let targets = enrich_targets(repos);
    let requested = targets.len();
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let token = crate::commands::resolve_active_github_token(&state);
    let timeout_each = crate::config::api_timeout_or(std::time::Duration::from_secs(10));
    // `State` 非 Copy：取共享引用供 FnMut 闭包多次捕获（`&CatalogService: Copy + Send`）。
    let catalog = &state.catalog;
    // 单次短锁预读：确认图标 + 本地富卡命中（CatalogService / app_details / api_etag_cache）+ ETag 预读，
    // 确保 fetch_enrich_batch 并发期间零 DB 查询、零 DB 直连（遵 ADR-0015）。
    let mut pre_confirmed: Vec<Option<String>> = vec![None; targets.len()];
    let mut local_hits: Vec<Option<AppSummary>> = vec![None; targets.len()];
    // 需写回 `repo_card_cache` 的结果下标（单仓富卡自身命中与失败回退不刷新新鲜度）。
    let mut card_writable: Vec<bool> = vec![false; targets.len()];
    let mut pre_etags: Vec<(Option<String>, Option<String>, Option<AppSummary>)> =
        vec![(None, None, None); targets.len()];
    if let Ok(db) = state.db() {
        pre_confirmed = enrich_pre_confirmed(Some(&db), &targets);
        for (idx, coord) in targets.iter().enumerate() {
            let repo_url = format!(
                "https://api.github.com/repos/{}/{}",
                urlencoding::encode(&coord.owner),
                urlencoding::encode(&coord.repo)
            );
            let cached_etag = if is_force {
                None
            } else {
                db.get_etag(&repo_url).ok().flatten()
            };
            let cached_payload = db.get_cached_payload(&repo_url).ok().flatten();
            if !is_force {
                if let Some((hit, source)) = resolve_local_enrich_hit_sourced(
                    &db,
                    catalog,
                    coord,
                    pre_confirmed[idx].as_deref(),
                    cached_payload.as_deref(),
                    true,
                ) {
                    card_writable[idx] =
                        matches!(source, LocalHitSource::Detail | LocalHitSource::Payload);
                    local_hits[idx] = Some(hit);
                    continue;
                }
            }
            let fallback_detail = db
                .get_app_detail(&coord.id, None)
                .ok()
                .flatten()
                .map(|detail| {
                    let mut core = detail.core;
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
    for (idx, outcome) in remote_indices.into_iter().zip(remote_results) {
        results[idx] = outcome.item;
        card_writable[idx] = outcome.fetched;
        if let Some(entry) = outcome.etag {
            etags_to_save.push(entry);
        }
    }

    // 循环外一次取 db 锁复用：落库新 ETag + 回填详情字段 + 写包事务化（与 search_apps_online 同一模式）。
    if let Ok(db) = state.db() {
        let now = crate::now_secs();
        for (url, etag, text) in &etags_to_save {
            let _ = db.save_etag(url, etag, text, now);
        }
        let mut staged: Vec<crate::db::AppIconCycle> = Vec::new();
        let mut cards: Vec<crate::db::RepoCardUpsert> = Vec::new();
        for (idx, slot) in results.iter_mut().enumerate() {
            let Some(item) = slot.as_mut() else {
                continue;
            };
            if let Some(cycle) = backfill_uncataloged_card(&db, item) {
                staged.push(cycle);
            }
            if card_writable[idx] {
                let confirmed_other = repo_card_confirmed_other(&db, item);
                if let Some(up) = stage_repo_card(catalog, item, confirmed_other, None) {
                    cards.push(up);
                }
            }
        }
        flush_icon_cycle_staged(&db, &staged);
        flush_repo_cards(&db, &cards);
    }

    // 后台流式：未收录且无确认图标的仓全部入 `fetch_icons_stream(Trend)`（首包不探图，此处是唯一一次探测），
    // 快命中即返不等慢、逐张到达 `emit_icon_ready`（含 GitHub 失败的裸行仓，
    // 前端缓冲等 enrich 重试/详情治愈时合并，空永不覆盖实）；收录仓沿用收录库官方图标。
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

    // 收录态盖章：趋势富卡/裸行一律携带显式 is_cataloged（未收录即 false），
    // 前端只读卡片字段判定徽标与“移入收录”入口。
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
    Ok(results)
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

/// 仓库 JSON 批量本地组卡（零网络，保序）：收录命中出收录卡，详情缓存命中出详情卡，
/// 否则解析仓库 JSON（与搜索单仓直查同形）。所有行统一盖收录章。
/// `persist = true`（非 stale 页）时未收录行连同私有标记写入 `repo_card_cache`。
pub(crate) fn cards_from_repo_payloads(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    items: Vec<crate::github::developer_starred::StarredRepoPayload>,
    persist: bool,
) -> StarredCards {
    let coords: Vec<crate::icons::RepoCoord> = items.iter().map(|i| i.coord.clone()).collect();
    let pre_confirmed = enrich_pre_confirmed(Some(db), &coords);
    let mut rows = Vec::with_capacity(items.len());
    let mut need_icon = Vec::new();
    let mut staged = Vec::new();
    let mut cards = Vec::new();
    let mut confirmed_other_ids = Vec::new();
    let mut private_ids = Vec::new();
    for (item, pre) in items.into_iter().zip(pre_confirmed) {
        let Some((mut card, _)) = resolve_local_enrich_hit_sourced(
            db,
            catalog,
            &item.coord,
            pre.as_deref(),
            Some(&item.payload),
            false,
        ) else {
            continue;
        };
        if let Some(cycle) = backfill_uncataloged_card(db, &mut card) {
            staged.push(cycle);
        }
        if !catalog.is_cataloged(&card.core.id) {
            let id = card.core.id.to_lowercase();
            let confirmed_other = repo_card_confirmed_other(db, &card);
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
    flush_icon_cycle_staged(db, &staged);
    if persist {
        flush_repo_cards(db, &cards);
    }
    StarredCards {
        rows,
        need_icon,
        confirmed_other_ids,
        private_ids,
    }
}

/// Star 列表补图世代：新查询（第 1 页）推进 `STARRED_GEN`，续拉页沿用当前值，
/// 同一查询的各页互不打断。
fn starred_icon_gen(new_query: bool) -> u64 {
    if new_query {
        STARRED_GEN.fetch_add(1, Ordering::SeqCst) + 1
    } else {
        STARRED_GEN.load(Ordering::SeqCst)
    }
}

/// Star 列表卡片后台补图（`IconFetchCtx::Starred`）：新查询即令上一查询的在途补图停止；
/// 续拉页不推进世代，前一页的补图照常送达。
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
        *catalog.items.write().unwrap() = vec![curated_item()];

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
        // 回归：每次调用恰好 BOARD_GEN+1（经 next_board_gen 唯一调用点，
        // 唯一调用方为 `enrich_trend_repos` 流式直路）。
        // 连续两次调用必须严格 +1/+1。
        let a = super::next_board_gen();
        let b = super::next_board_gen();
        assert_eq!(b, a + 1);
    }

    #[test]
    fn select_gen_lane_selects_counter_by_ctx() {
        // 同一 emit 口：Search 查 SEARCH_GEN，Trend 查 BOARD_GEN；期望 gen 原样回显。
        // 趋势落库/emit 世代收敛仍查 BOARD_GEN（合并新鲜度 + emit 前查 gen，行为一致）。
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
        // 新鲜命中沿用全量合并：L3 收编选中（与 `merge_detail_icon` 同语义）。
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

        // 已收录目录项不再进入后台补图队列。
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
}
