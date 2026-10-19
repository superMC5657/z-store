//! 统一图标补探深核（后端 probe 唯一深模块，只做探测与调度，永不触 DB/fs）。
//!
//! - 探测与调度核：`fetch_icons_stream(jobs, token, cfg, emit, should_stop)`，
//!   其中 `jobs=[{id,owner,repo,ctx}]`，`ctx=Search{search_id,gen} | Trend{board,gen}`；
//!   `should_stop` 为调用方世代闭包（过期开探前即止，协作取消）。
//! - 行为：并发池 `cfg.pool`（默认 5，与趋势 `buffered(5)` 对齐，D6，ADR-0015）；
//!   快路径 SimpleIcons / 慢路径 Trees 超时经
//!   `network.api_timeout_seconds` 统一配置，未设置回退 1500ms/12s 缺省；
//!   快路径外层兜底 `api_timeout_or(8000ms)`、慢路径仅探 `default_branch`、
//!   整批 `cfg.total_timeout_secs`（默认 15s）按页伸缩（经缝内纯函数
//!   `scaled_total_timeout`）；
//!   世代防串由调用方 `emit` 回调（`catalog_search::save_and_emit`：合并时按新鲜度取全量/补槽 +
//!   emit 前查 gen，`should_stop` 开探前协作取消）负责，core 只做探测与调度，不触 DB。
//! - 单仓深核 `probe_single_live`（L2→L3）为流式与详情 cycle 共用的唯一探核：
//!   `fetch_icons_stream` 逐 job 调它；`icons_cycle_probe::ensure_cycle_levels` 的
//!   L2/L3 与 `fetch_anon_probe_bytes` 的匿名兜底亦经它（或其 L2/L3 拆分件）。
//!   L4=README 与 L1=官方填充分居详情/cycle 适配器，不进本核。
//! - M2=DB落盘命中零网络，由调用方在进 core 前短锁预解析，不经本 core 探测。
//!   L4=README需网络，详情链专属，不受本核心约束，本 core 不探 README。
//!   level纯L(2=L2品牌库,3=L3仓库)；缓存正交用via(live|m2)表M2，pool=5/total伸缩。
//! - 缝：probe-vs-persist——core 永不触 DB/fs（无 `Database`/`std::fs` 引用，
//!   纯探 + 调度）；持久化单一写入路径收为内部缝
//!   `commands::icons_cycle_probe::write_icon_file`（`catalog vs cycle` 分流 +
//!   `icons/` 落盘 + meta 同步），下载经 `download_icon_bytes_direct`，
//!   L5 空选经 `seal_empty_selection + empty_cycle_result`。
//!   趋势 enrich 走流式直路（首屏快返 + 后台 `fetch_icons_stream(Trend)` 逐张 emit，
//!   见 `commands::catalog_search`）；本核为流式探测与调度的唯一深核
//!  （搜索与趋势共用，见 ADR-0015 §6）。
//! - D5/D6/D8：双池复用（icon client 隔离，CDN 恒丢 token）+ 有界池 5 +
//!   首包验图与跳过（HEAD→Range 首 32KB→magic→300B，见 `icon_probe::verify_image`）。
//!   Curated Catalog 永不分支：仅 L1 填充为例外（见 cycle 适配器）。
//! - ADR-0010：`id` 一律小写 `owner/repo`（与 DB 主键同源，唯一实现见 `icon_key`）；
//!   ADR-0015：只发 `zstore://icon-ready{id,icon,level,via,context}`，level 纯L，via=live|m2。
//!
//! - 事件：调用方 `emit` 回调用本模块的 [`IconReadyPayload`]
//!   发 `zstore://icon-ready{id,icon,level,via,context}`
//!   （`id`=小写 `owner/repo`，`level`纯L: 2/3本core emit live，L4不经core；
//!   `via`=live|m2，M2落盘由调用方回填走via=m2）。

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

// 慢路径 Trees 探测分支见 [`crate::github::icon_probe::resolve_probe_branches`]：
// 取仓库 `default_branch`（解析失败即空，调用方跳过 L3）。
// 新代码一律用该动态解析，勿硬编码分支。

/// 单个图标补探任务：`id` 为小写 `owner/repo`。
#[derive(Debug, Clone)]
pub struct IconFetchJob {
    pub id: String,
    pub owner: String,
    pub repo: String,
    pub ctx: IconFetchCtx,
}

/// 补探上下文：搜索 `Search` 与趋势 `Trend` 共用（世代防串由调用方按 `gen` 执行）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum IconFetchCtx {
    Search { search_id: String, gen: u64 },
    Trend { board: String, gen: u64 },
}

/// 图标就绪事件载荷（`zstore://icon-ready`）。
/// `level`纯L(i32)：2=L2品牌库，3=L3仓库，4=L4 README（本core只发2/3 live，L4不经core）；
/// `via`=live|m2：live=远端探测，m2=DB落盘回填（M1为前端内存，与本载荷正交）。
/// level拒字符串，缓存只用via/M。
#[derive(Debug, Clone, serde::Serialize)]
pub struct IconReadyPayload {
    /// 小写 `owner/repo`（经 [`icon_key`] 归一，与 DB 主键同源）。
    pub id: String,
    pub icon: String,
    pub level: i32,
    /// live|m2（见模块文档）。
    pub via: String,
    pub context: IconFetchCtx,
}

/// FINAL Logo 口径（只做 Logo，不管正文插图）：
/// - `level_for_detail_icon`: 详情 `icon` → cycle 级别（2=simpleicons 字典，4=README 头部备选 Logo，3=仓库树）；
///   L4 仅 cycle 命中的头部备选 Logo（`/blob/` 或 `readme` 关键字），正文图永不经此（见下）；
/// - `is_body_image_url`: 正文大图判别薄委托，唯一实现见
///   [`crate::github::icon_probe::is_readme_body_image`]（ADR-0015 §3 单一探源，
///   README-body 上下文 path-segment 精确匹配；`preview-logo.png` 等合法 Logo 不判为正文），
///   命中即视为正文图，调用方跳过落库（不存、不计、不预热）。
pub(crate) fn level_for_detail_icon(icon_trimmed: &str) -> i32 {
    if icon_trimmed.contains("simpleicons.org") {
        2
    } else if icon_trimmed.contains("/blob/") || icon_trimmed.to_lowercase().contains("readme") {
        4
    } else {
        3
    }
}

pub(crate) fn is_body_image_url(url: &str) -> bool {
    crate::github::icon_probe::is_readme_body_image(url)
}

/// 事件 `id` 归一：小写 `owner/repo`（唯一实现见
/// [`crate::forge::canonical_app_id_from_parts`]；DB 主键/事件 id/前端归一键全同）。
/// 入站标识一律先经 `forge::canonical_app_id` 归一化，再拆 owner/repo 进本函数；
/// 本函数只做归一拼接，不做解析（解析 SSOT 在 `forge::RepositoryUrlParser`）。
pub fn icon_key(owner: &str, repo: &str) -> String {
    crate::forge::canonical_app_id_from_parts(owner, repo)
}

/// 由任务 + 探测结果构建事件载荷（`via`=live|m2，core探测一律live）。
pub fn icon_ready_payload(
    job: &IconFetchJob,
    url: &str,
    level: i32,
    via: &str,
) -> IconReadyPayload {
    IconReadyPayload {
        id: icon_key(&job.owner, &job.repo),
        icon: url.to_owned(),
        level,
        via: via.to_owned(),
        context: job.ctx.clone(),
    }
}

/// 发统一事件 `zstore://icon-ready`（吞错）。
pub fn emit_icon_ready(handle: &AppHandle, payload: &IconReadyPayload) {
    let _ = handle.emit("zstore://icon-ready", payload);
}

/// L2 单探深核（品牌库 SimpleIcons，免鉴权）：`icon_probe::probe_simple_icons`
/// 的超时外层薄包（外层兜底 8000ms 经 `api_timeout_seconds`，内层每 slug 1500ms
/// 经同配置）。命中返 URL，未命中返 `None`。cycle 适配器 L2 直调此件，不另写串行 naive 探。
pub(crate) async fn probe_l2_simple(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Option<String> {
    tokio::time::timeout(
        crate::config::api_timeout_or(std::time::Duration::from_millis(8000)),
        crate::github::icon_probe::probe_simple_icons(client, owner, repo),
    )
    .await
    .ok()
    .flatten()
    .map(|h| h.url)
    .filter(|u| !u.trim().is_empty())
}

/// L3 单探深核（仓库 Git Trees，需鉴权头）：仅 `default_branch`
/// （`resolve_probe_branches` 动态解析，失败/超时即空，直接跳过 L3）探
/// `probe_trees`，首命中即停。无 headers（匿名）直接 `None`
/// （保护匿名配额，与流式“无 token 只走快路径”同语义）。
/// cycle 适配器 L3 直调此件，不另写串行 naive 探。
pub(crate) async fn probe_l3_trees(
    client: &reqwest::Client,
    slow_headers: Option<&reqwest::header::HeaderMap>,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let hdrs = slow_headers?;
    let branches =
        crate::github::icon_probe::resolve_probe_branches(client, hdrs, owner, repo).await;
    for branch in &branches {
        if let Some(h) =
            crate::github::icon_probe::probe_trees(client, hdrs, owner, repo, branch).await
        {
            if !h.url.trim().is_empty() {
                return Some(h.url);
            }
        }
    }
    None
}

/// 匿名单探深核（无 token 免鉴权级）：只跑 L2，不跑 Trees（保护匿名配额），
/// 不做分支循环（`probe_repo_logo(None)` 本就忽略分支，循环属重复浪费）。
/// `get_or_fetch_icon` 直取失败兜底与 `fetch_anon_probe_bytes` 经此件，不另起第三套。
pub(crate) async fn probe_anon_simple(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Option<String> {
    probe_l2_simple(client, owner, repo).await
}

/// 单仓 live 探测深核（L2→L3，快命中即返不等慢）：
/// 流式 `fetch_icons_stream` 逐 job 调此件；cycle 适配器需一次性拿 (url, level)
/// 时亦调此件。`slow_headers=None`（匿名/无 token）只探 L2。
/// 返回 `(url, level)`（level 纯L 2/3，via 一律 live 由调用方填）；未命中 `None`。
/// core 只探测不触 DB/fs。
pub(crate) async fn probe_single_live(
    client: &reqwest::Client,
    slow_headers: Option<&reqwest::header::HeaderMap>,
    owner: &str,
    repo: &str,
) -> Option<(String, i32)> {
    if let Some(url) = probe_l2_simple(client, owner, repo).await {
        return Some((url, 2));
    }
    if let Some(url) = probe_l3_trees(client, slow_headers, owner, repo).await {
        return Some((url, 3));
    }
    None
}

/// 整批总量纯决策（可单测，无网络/DB/fs）：
///
/// `total = max(cfg_total, ceil(jobs/pool) * timeout_each)`，pool 保持 5（ADR-0015）。
/// 调用方 `fetch_icons_stream` 唯一调用点，不在命令层散算（probe-vs-persist 缝收敛）。
pub(crate) fn scaled_total_timeout(
    jobs_len: usize,
    pool: usize,
    timeout_each: std::time::Duration,
    cfg_total_secs: u64,
) -> std::time::Duration {
    let pool = pool.max(1);
    let batches = jobs_len.div_ceil(pool).max(1) as u64;
    let scaled_secs = batches.saturating_mul(timeout_each.as_secs().max(1));
    std::time::Duration::from_secs(cfg_total_secs.max(1).max(scaled_secs))
}

/// 后台图标补探 stream（见模块文档）。
/// - `jobs`：待补探任务（含 `ctx`，世代防串由 `emit` 回调按 `ctx.gen` 执行）；空直接返回。
/// - `token`：慢路径 Trees 鉴权；无 token 只走快路径。
/// - `cfg`：`limits.icon_fetch`（`pool=5`，总量按页伸缩）。
/// - `emit`：命中回调（落库 + 发事件 + 世代收敛均在回调内，core 不触 DB）。
///   签名 `(handle, job, url, level, via)`，`level`纯L 2/3 live；L4不经本core探测，
///   M2回填走via=m2由调用方直发不经core。
/// - `should_stop`：协作取消（调用方按世代闭包传入，如搜索 `SEARCH_GEN != gen`）；
///   每个 job 开探前查一次，过期直接返空不发网络；在飞探完仍走 `emit`
///   （由回调内 `save_and_emit` 按 gen 收敛）；不用 abort，不动事务，core 不碰 DB。
pub async fn fetch_icons_stream<F, Fut>(
    handle: AppHandle,
    jobs: Vec<IconFetchJob>,
    token: Option<String>,
    cfg: crate::config::IconFetchConfig,
    emit: F,
    should_stop: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
) where
    F: Fn(AppHandle, IconFetchJob, String, i32, String) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    if jobs.is_empty() {
        return;
    }
    log::debug!(
        "icon fetch start jobs={} pool={} total_timeout_secs={}",
        jobs.len(),
        cfg.pool,
        cfg.total_timeout_secs,
    );
    // L4=README需网络，详情链专属，不受本核心约束，本 core 不探 README。
    let client = crate::forge::http::new_icon_client(
        crate::config::get_project_config().network.api_timeout_seconds,
    )
    .unwrap_or_default();
    // 慢路径鉴权头：有 token 才跑 Trees，无 token 只走快路径。
    let slow_headers = token
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .map(|t| crate::github::http::token_headers(Some(t)));
    // 有界并发：单层 buffer_unordered(pool)（默认 5，与趋势 buffered(5) 对齐），
    // 快慢各一次 emit（快命中即返不等慢，慢仅快未命中且有 token 时跑）。
    let pool = cfg.pool.max(1);
    // 整批总量按 jobs 伸缩（纯决策收敛在缝内，pool 保持 5）：
    let jobs_len = jobs.len();
    // 截断观测：记 lane/scope/量级（只加日志，不改截断语义）。
    let scope_desc = jobs.first().map(|j| match &j.ctx {
        IconFetchCtx::Search { search_id, gen } => format!("search sid={search_id} gen={gen}"),
        IconFetchCtx::Trend { board, gen } => format!("trend board={board} gen={gen}"),
    });
    let timeout_each = crate::config::api_timeout_or(
        std::time::Duration::from_secs(10),
    );
    let batch = futures_util::stream::iter(jobs.into_iter().map(|job| {
        let handle = handle.clone();
        let client = client.clone();
        let slow_headers = slow_headers.clone();
        let emit = emit.clone();
        let should_stop = should_stop.clone();
        async move {
            // 协作取消：过期世代开探前即止，不发网络；
            // 在飞探完仍走 emit（由 `save_and_emit` 按 gen 收敛：过期写库攒槽、只拦发送）。
            if should_stop.as_ref().is_some_and(|stop| stop()) {
                return;
            }
            // 快慢分离深核单调：经 `probe_single_live`（L2→L3，快命中即返不等慢，
            // 慢仅快未命中且有 token 时跑）。超时/分支语义见该函数。
            if let Some((url, level)) =
                probe_single_live(&client, slow_headers.as_ref(), &job.owner, &job.repo).await
            {
                emit(handle, job, url, level, "live".to_string()).await;
            }
        }
    }))
    .buffer_unordered(pool)
    .for_each(|()| async {});
    // 整批总超时：超时即降级结束（剩余任务直接丢弃，不炸不重试）。
    let total = scaled_total_timeout(jobs_len, pool, timeout_each, cfg.total_timeout_secs);
    if tokio::time::timeout(total, batch).await.is_err() {
        log::debug!(
            "icon fetch truncated jobs={} scope={}",
            jobs_len,
            scope_desc.as_deref().unwrap_or("unknown"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_icon_key_is_lowercased_owner_repo() {
        assert_eq!(icon_key("SuperMC5657", "Z-Store"), "supermc5657/z-store");
        assert_eq!(icon_key("o", "r"), "o/r");
    }

    #[test]
    fn search_icon_ready_payload_shape() {
        // 事件形状：`{id,icon,level,via,context}`，id=小写 owner/repo，level纯L，via=live|m2。
        let job = IconFetchJob {
            id: "o/r".to_string(),
            owner: "O".to_string(),
            repo: "R".to_string(),
            ctx: IconFetchCtx::Search {
                search_id: "7".to_string(),
                gen: 7,
            },
        };
        let p = icon_ready_payload(&job, "https://cdn.simpleicons.org/r", 2, "live");
        assert_eq!(p.id, "o/r");
        assert_eq!(p.level, 2);
        assert_eq!(p.via, "live");
        let v = serde_json::to_value(&p).unwrap();
        for f in ["id", "icon", "level", "via", "context"] {
            assert!(v.get(f).is_some(), "missing field {f}");
        }
        assert!(v.get("key").is_none(), "unexpected key field must be gone");
        assert_eq!(v["context"]["kind"], "search");
        assert_eq!(v["context"]["search_id"], "7");
        // Trend 变体可序列化（锁形状）。
        let t = IconFetchCtx::Trend {
            board: "daily".to_string(),
            gen: 1,
        };
        assert_eq!(
            serde_json::to_value(&t).unwrap()["kind"],
            "trend"
        );
    }

    #[test]
    fn scaled_total_timeout_stretches_with_pages() {
        // 整批总量纯决策：total = max(cfg, ceil(jobs/pool) * each)，pool 保持 5（ADR-0015）。
        // 单页不拉长（cfg 15s 优先），多页按批伸缩，pool=0 兜底 1。
        let each = std::time::Duration::from_secs(10);
        assert_eq!(
            scaled_total_timeout(5, 5, each, 15),
            std::time::Duration::from_secs(15)
        );
        assert_eq!(
            scaled_total_timeout(12, 5, each, 15),
            std::time::Duration::from_secs(30)
        );
        assert_eq!(
            scaled_total_timeout(0, 5, each, 15),
            std::time::Duration::from_secs(15)
        );
        assert_eq!(
            scaled_total_timeout(5, 0, each, 15),
            std::time::Duration::from_secs(50)
        );
    }

    #[test]
    fn body_image_url_delegates_to_single_probe_source() {
        // ADR-0015 §3 单一探源：`is_body_image_url` 为 `icon_probe::is_readme_body_image` 薄委托，
        // path-segment 精确匹配；含关键词的合法 Logo 不得判为正文（detail.icon 不丢 logo）。
        let body = [
            "https://raw.githubusercontent.com/o/r/main/docs/screenshot.png",
            "https://raw.githubusercontent.com/o/r/main/assets/preview.png",
            "https://img.shields.io/badge/x-y-green",
            "https://raw.githubusercontent.com/o/r/main/assets/banner.svg?sanitize=true",
            "https://raw.githubusercontent.com/o/r/main/docs/cover.png#frag",
        ];
        for u in body {
            assert!(is_body_image_url(u), "expected body: {u}");
            assert!(
                crate::github::icon_probe::is_readme_body_image(u),
                "single source must agree: {u}"
            );
        }
        let logos = [
            "https://raw.githubusercontent.com/o/r/main/assets/preview-logo.png",
            "https://raw.githubusercontent.com/o/r/main/assets/demo-icon.svg",
            "https://cdn.simpleicons.org/foo",
            "https://raw.githubusercontent.com/o/r/main/assets/logo.png",
            "https://raw.githubusercontent.com/o/r/main/assets/discover.png",
            "https://raw.githubusercontent.com/o/r/main/assets/badger-icon.png",
        ];
        for u in logos {
            assert!(!is_body_image_url(u), "expected legit logo kept: {u}");
            assert!(
                !crate::github::icon_probe::is_readme_body_image(u),
                "single source must agree: {u}"
            );
        }
    }
}
