//! 统一图标补探深核（后端 probe+schedule 唯一深模块，只做探测与调度，永不触 DB/fs）。
//!
//! - 归口原 `commands::catalog_search::search_apps_online` 内联的后台快慢探
//!   （`spawn + stream::iter().buffer_unordered(pool).for_each + save_and_emit`），
//!   对外伪接口等价于 `fetch_icons_stream(jobs, token, cfg, emit)`，其中
//!   `jobs=[{id,owner,repo,ctx}]`，`ctx=Search{search_id,gen} | Trend{board,gen}`。
//! - 行为：并发池 `cfg.pool`（默认 5，与趋势 `buffered(5)` 对齐，D6）；
//!   快路径 SimpleIcons / 慢路径 Trees 超时经
//!   `network.api_timeout_seconds` 统一配置，未设置回退 1500ms/12s 历史值；
//!   快路径外层兜底 `api_timeout_or(8000ms)`、慢路径分支顺序 main→master、
//!   整批 `cfg.total_timeout_secs`（默认 15s）按页伸缩，均与原内联语义相同；
//!   世代防串（`SEARCH_GEN` 落库前 + emit 前双检查）由调用方 `emit` 回调
//!   （`catalog_search::save_and_emit`）负责，core 只做探测与调度，不触 DB。
//! - 单仓深核 `probe_single_live`（L2→L3）为流式与详情 cycle 共用的唯一探核：
//!   `fetch_icons_stream` 逐 job 调它；`icons_cycle_probe::ensure_cycle_levels` 的
//!   L2/L3 与 `fetch_anon_probe_bytes` 的匿名兜底亦经它（或其 L2/L3 拆分件），
//!   不再各写一套串行 naive 探。L4=README 与 L1=官方填充分居详情/cycle 适配器，
//!   不进本核。
//! - M2=DB落盘命中零网络，由调用方在进 core 前短锁预解析，不经本 core 探测。
//!   L4=README需网络，详情链专属，不受本核心约束，本 core 不探 README。
//!   level纯L(2=L2品牌库,3=L3仓库)；缓存正交用via(live|m2)表M2，pool=5/total伸缩。
//! - 缝：probe-vs-persist——core 永不触 DB/fs（无 `Database`/`std::fs` 引用）；
//!   `icons/` 落盘（`catalog_filename` vs `cycle_filename`）与镜像改写 stays behind
//!   （见 `commands::icons_cycle_probe` 适配器）。`compat_collect` buffered 趋势
//!   等齐路为 legacy 适配器（见 `commands::catalog_search::enrich_trend_repos_buffered`），
//!   本核不删它、不依赖它。
//! - D5/D6/D8：双池复用（icon client 隔离，CDN 恒丢 token）+ 有界池 5 +
//!   首包验图与跳过（HEAD→Range 首 32KB→magic→300B，见 `icon_probe::verify_image`）。
//!   Curated Catalog 永不分支：仅 L1 填充 + 文件名分流为例外（见 cycle 适配器）。


//! - 事件：调用方 `emit` 回调用本模块的 [`IconReadyPayload`]
//!   发 `zstore://icon-ready{key,id,icon,level,via,context}`
//!   （`key`=小写 `owner/repo`，`level`纯L: 2/3本core emit live，L4不经core；
//!   `via`=live|m2，M2落盘由调用方回填走via=m2）。

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

// 慢路径 Trees 分支回退顺序唯一定义见 [`crate::github::icon_probe::FALLBACK_PROBE_BRANCHES`]：
// 先 main 后 master（ZCode 类老仓默认分支仍为 master，只查 main 会零命中零 emit，首屏恒为 initials）。
// 实际探测分支由 [`crate::github::icon_probe::resolve_probe_branches`]
// 动态解析（先 GET repos 取 `default_branch` 5s 超时，再补 main/master，最多3分支，
// 与 `commands::icons_cycle_probe::probe_git_trees` 同源共用）；新代码一律用该动态解析，勿硬编码分支。

/// 单个图标补探任务：`id` 为小写 `owner/repo`（与原 `candidates` 构造一致）。
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

/// 新统一图标就绪事件载荷（`zstore://icon-ready`）。
/// `level`纯L(i32)：2=L2品牌库，3=L3仓库，4=L4 README（本core只发2/3 live，L4不经core）；
/// `via`=live|m2：live=远端探测，m2=DB落盘回填（M1为前端内存，与本载荷正交）。
/// level拒字符串，缓存只用via/M。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IconReadyPayload {
    /// 小写 `owner/repo`（见 [`icon_key`]）。
    pub key: String,
    /// 小写 `owner/repo`。
    pub id: String,
    pub icon: String,
    pub level: i32,
    /// live|m2（见模块文档）。
    #[serde(default = "default_icon_via")]
    pub via: String,
    pub context: IconFetchCtx,
}

/// `via`缺省（旧载荷兼容）按live计。
fn default_icon_via() -> String {
    "live".to_string()
}

/// 统一事件 key：小写 `owner/repo`（ADR-0010 `canonical_app_id` 的 GitHub 形态）。
/// 入站标识一律先经 `forge::canonical_app_id` 归一化，再拆 owner/repo 进本函数；
/// 本函数只做小写拼接，不做解析（解析 SSOT 在 `forge::RepositoryUrlParser`）。
pub fn icon_key(owner: &str, repo: &str) -> String {
    format!("{}/{}", owner.to_lowercase(), repo.to_lowercase())
}

/// 由任务 + 探测结果构建新统一事件载荷（`via`=live|m2，core探测一律live）。
pub fn icon_ready_payload(
    job: &IconFetchJob,
    url: &str,
    level: i32,
    via: &str,
) -> IconReadyPayload {
    IconReadyPayload {
        key: icon_key(&job.owner, &job.repo),
        id: job.id.clone(),
        icon: url.to_owned(),
        level,
        via: via.to_owned(),
        context: job.ctx.clone(),
    }
}

/// 新发统一事件 `zstore://icon-ready`（吞错，与旧事件 emit 语义一致）。
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

/// L3 单探深核（仓库 Git Trees，需鉴权头）：动态分支解析
/// （先 GET repos 取 `default_branch` 5s 超时，再补 main/master，最多3分支）后
/// 逐分支 `probe_trees`，首命中即停。无 headers（匿名）直接 `None`
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
/// 不做分支循环（`probe_repo_logo(None)` 本就忽略分支，循环属重复浪费，已删）。
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

/// 后台图标补探 stream（见模块文档）。
/// - `jobs`：待补探任务（含 `ctx`，世代防串由 `emit` 回调按 `ctx.gen` 执行）；空直接返回。
/// - `token`：慢路径 Trees 鉴权；无 token 只走快路径。
/// - `cfg`：`limits.icon_fetch`（`pool=5`，总量按页伸缩）。
/// - `emit`：命中回调（落库 + 发事件 + 世代双检查均在回调内，core 不触 DB）。
///   签名 `(handle, job, url, level, via)`，`level`纯L 2/3 live；L4不经本core探测，
///   M2回填走via=m2由调用方直发不经core。
pub async fn fetch_icons_stream<F, Fut>(
    handle: AppHandle,
    jobs: Vec<IconFetchJob>,
    token: Option<String>,
    cfg: crate::config::IconFetchConfig,
    emit: F,
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
    let client = crate::commands::icon_http_client();
    // 慢路径鉴权头：有 token 才跑 Trees，无 token 只走快路径。
    let slow_headers = token
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .map(|t| crate::github::http::token_headers(Some(t)));
    // 有界并发：单层 buffer_unordered(pool)（默认 5，与趋势 buffered(5) 对齐），
    // 快慢各一次 emit（快命中即返不等慢，慢仅快未命中且有 token 时跑）。
    let pool = cfg.pool.max(1);
    // 整批总量按 jobs 伸缩：
    // total = max(cfg.total_timeout_secs, ceil(jobs/pool) * timeout_each)，pool 保持 5。
    let jobs_len = jobs.len();
    let timeout_each = crate::config::api_timeout_or(
        std::time::Duration::from_secs(10),
    );
    let batch = futures_util::stream::iter(jobs.into_iter().map(|job| {
        let handle = handle.clone();
        let client = client.clone();
        let slow_headers = slow_headers.clone();
        let emit = emit.clone();
        async move {
            // 快慢分离深核单调：经 `probe_single_live`（L2→L3，快命中即返不等慢，
            // 慢仅快未命中且有 token 时跑）。超时/分支语义见该函数，不在此内联第二套。
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
    let batches = jobs_len.div_ceil(pool).max(1) as u64;
    let scaled_secs = batches.saturating_mul(timeout_each.as_secs().max(1));
    let total = std::time::Duration::from_secs(cfg.total_timeout_secs.max(1).max(scaled_secs));
    let _ = tokio::time::timeout(total, batch).await;
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
        // 新统一事件形状：`{key,id,icon,level,via,context}`，key=小写 owner/repo，level纯L，via=live|m2。
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
        assert_eq!(p.key, "o/r");
        assert_eq!(p.id, "o/r");
        assert_eq!(p.level, 2);
        assert_eq!(p.via, "live");
        let v = serde_json::to_value(&p).unwrap();
        for f in ["key", "id", "icon", "level", "via", "context"] {
            assert!(v.get(f).is_some(), "missing field {f}");
        }
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
    fn search_icon_branches_keep_master_fallback() {
        // 回归：慢路径 Trees 必须覆盖 master（ZCode 类老仓默认分支），顺序 main 优先。
        // 唯一定义见 `icon_probe::FALLBACK_PROBE_BRANCHES`（动态解析回退基线）。
        let branches = crate::github::icon_probe::FALLBACK_PROBE_BRANCHES;
        assert_eq!(branches, ["main", "master"]);
        assert!(branches.contains(&"master"));
    }
}
