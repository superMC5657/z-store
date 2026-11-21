//! `IconFetch` 四路世代通道：搜索 / 趋势 / Star 列表 / 开源广场各持独立世代计数器。
//!
//! 流式探测命中按 ADR-0015 双重世代新鲜度检查合入 `app_icon_cycles`（新鲜世代全量收编，
//! 过期世代只补空槽）并同步 `repo_card_cache` 图标；仅当前世代经 [`IconEventSink`] 发射
//! `zstore://icon-ready`。

use super::{IconFetchCtx, IconFetchJob, IconReadyPayload, RepoCoord};
use crate::db::Database;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);
static TREND_GEN: AtomicU64 = AtomicU64::new(0);
static STARRED_GEN: AtomicU64 = AtomicU64::new(0);
static LAUNCHPAD_GEN: AtomicU64 = AtomicU64::new(0);

/// 补图世代通道：每路世代独立推进，互不取消。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconLane {
    /// 在线搜索：每次 `search_apps_online` 推进。
    Search,
    /// 趋势榜：每次 `enrich_trend_repos` 推进。
    Trend,
    /// Star 列表：新查询第 1 页推进，续拉页沿用。
    Starred,
    /// 开源广场：每次 `get_launchpad_feed` 推进。
    Launchpad,
}

impl IconLane {
    fn counter(self) -> &'static AtomicU64 {
        match self {
            IconLane::Search => &SEARCH_GEN,
            IconLane::Trend => &TREND_GEN,
            IconLane::Starred => &STARRED_GEN,
            IconLane::Launchpad => &LAUNCHPAD_GEN,
        }
    }

    /// 推进并返回新世代（上一世代的在途探测随之停发）。
    pub fn advance(self) -> u64 {
        self.counter().fetch_add(1, Ordering::SeqCst) + 1
    }

    /// 当前世代。
    pub fn current(self) -> u64 {
        self.counter().load(Ordering::SeqCst)
    }

    /// 补探上下文所属通道与其携带的期望世代。
    pub fn of(ctx: &IconFetchCtx) -> (IconLane, u64) {
        match ctx {
            IconFetchCtx::Search { gen, .. } => (IconLane::Search, *gen),
            IconFetchCtx::Trend { gen, .. } => (IconLane::Trend, *gen),
            IconFetchCtx::Starred { gen } => (IconLane::Starred, *gen),
            IconFetchCtx::Launchpad { gen } => (IconLane::Launchpad, *gen),
        }
    }
}

/// `zstore://icon-ready` 事件接收端：生产注入 `AppHandle`，测试注入内存收集器。
pub trait IconEventSink: Send + Sync {
    fn icon_ready(&self, payload: &IconReadyPayload);
}

impl IconEventSink for AppHandle {
    fn icon_ready(&self, payload: &IconReadyPayload) {
        super::emit_icon_ready(self, payload);
    }
}

/// 合并流式命中图标：新鲜世代全量合并，过期世代仅补对应空槽而不改选中态；返回是否 pinned。
pub(super) fn merge_stream_hit(
    cycle: &mut crate::db::AppIconCycle,
    level: i32,
    url: &str,
    keep_cataloged: bool,
    now: i64,
    fresh: bool,
) -> bool {
    if fresh {
        super::merge_detail_icon(cycle, level, url, keep_cataloged, now)
    } else {
        super::fill_probe_slot(cycle, level, url);
        cycle.pinned
    }
}

/// 流式命中落库与发射（世代来源可注入）：落库前与发射前各检查一次世代，
/// 落库与发射之间世代被推进时仍只写库不发射。
pub(crate) fn record_stream_hit_with(
    db: &Mutex<Database>,
    job: &IconFetchJob,
    url: &str,
    level: i32,
    via: &str,
    current_gen: &dyn Fn() -> u64,
    sink: &dyn IconEventSink,
) {
    let (_, expected_gen) = IconLane::of(&job.ctx);
    if let Ok(db) = db.lock() {
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
        let fresh = current_gen() == expected_gen;
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
    if current_gen() != expected_gen {
        return;
    }
    sink.icon_ready(&super::icon_ready_payload(job, url, level, via));
}

/// 流式命中落库与发射：世代取自任务上下文所属通道。
pub(crate) fn record_stream_hit(
    db: &Mutex<Database>,
    job: &IconFetchJob,
    url: &str,
    level: i32,
    via: &str,
    sink: &dyn IconEventSink,
) {
    let (lane, _) = IconLane::of(&job.ctx);
    record_stream_hit_with(db, job, url, level, via, &|| lane.current(), sink);
}

/// `fetch_icons_stream` 命中回调（生产 adapter：库取自 `AppState`，事件发往前端）。
async fn emit_stream_hit(
    handle: AppHandle,
    job: IconFetchJob,
    url: String,
    level: i32,
    via: String,
) {
    let state = handle.state::<crate::AppState>();
    record_stream_hit(&state.db, &job, &url, level, &via, &handle);
}

/// 按上下文所属通道后台派发补图流：通道世代被推进后，未开探的任务即止。
pub(crate) fn spawn_icon_fetch_lane(
    handle: &AppHandle,
    ctx: IconFetchCtx,
    coords: Vec<RepoCoord>,
    token: Option<String>,
) {
    if coords.is_empty() {
        return;
    }
    let (lane, gen) = IconLane::of(&ctx);
    let jobs: Vec<IconFetchJob> = coords
        .into_iter()
        .map(|coord| coord.into_job(ctx.clone()))
        .collect();
    let cfg = crate::config::get_project_config().limits.icon_fetch;
    let should_stop: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
        std::sync::Arc::new(move || lane.current() != gen);
    tokio::spawn(super::fetch_icons_stream(
        handle.clone(),
        jobs,
        token,
        cfg,
        emit_stream_hit,
        Some(should_stop),
    ));
}

/// Star 列表补图：新查询推进世代（本页无需补图也推进，令上一查询的流停下），续拉页沿用。
pub(crate) fn spawn_starred_icon_stream(
    handle: &AppHandle,
    coords: Vec<RepoCoord>,
    token: Option<String>,
    new_query: bool,
) {
    let gen = if new_query {
        IconLane::Starred.advance()
    } else {
        IconLane::Starred.current()
    };
    spawn_icon_fetch_lane(handle, IconFetchCtx::Starred { gen }, coords, token);
}

/// 开源广场补图：每次刷新推进世代（无缺图也推进，令上一轮在途补图停发）。
pub(crate) fn spawn_launchpad_icon_stream(
    handle: &AppHandle,
    coords: Vec<RepoCoord>,
    token: Option<String>,
) {
    let gen = IconLane::Launchpad.advance();
    spawn_icon_fetch_lane(handle, IconFetchCtx::Launchpad { gen }, coords, token);
}
