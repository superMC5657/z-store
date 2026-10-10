//! 统一图标补探核心（后端抽 core，不碰前端）。
//!
//! - 归口原 `commands::catalog_search::search_apps_online` 内联的后台快慢探
//!  （`spawn + stream::iter().buffer_unordered(pool).for_each + save_and_emit`），
//!   对外伪接口等价于 `fetch_icons_stream(jobs, token, cfg, emit)`，其中
//!   `jobs=[{id,owner,repo,ctx}]`，`ctx=Search{search_id,gen} | Trend{board,gen}`。
//! - 行为：并发池 `cfg.pool`（默认 5，与趋势 `buffered(5)` 对齐）；
//!   快路径 SimpleIcons / 慢路径 Trees 超时经
//!   `network.api_timeout_seconds` 统一配置，未设置回退 1500ms/12s 历史值；
//!   快路径外层兜底 `api_timeout_or(8000ms)`、慢路径分支顺序 main→master、
//!   整批 `cfg.total_timeout_secs`（默认 15s）按页伸缩，均与原内联语义相同；
//!   世代防串（`SEARCH_GEN` 落库前 + emit 前双检查）由调用方 `emit` 回调
//!   （`catalog_search::save_and_emit`）负责，core 只做探测与调度，不触 DB。
//! - M2=DB落盘命中零网络，由调用方在进 core 前短锁预解析，不经本 core 探测。
//!   L4=README需网络，详情链专属，不受本核心约束，本 core 不探 README。
//!   level纯L(2=L2品牌库,3=L3仓库)；缓存正交用via(live|m2)表M2，pool=5/total伸缩。


//! - 事件：调用方 `emit` 回调用本模块的 [`IconReadyPayload`]
//!   发 `zstore://icon-ready{key,id,icon,level,via,context}`
//!  （`key`=小写 `owner/repo`，`level`纯L: 2/3本core emit live，L4不经core；
//!   `via`=live|m2，M2落盘由调用方回填走via=m2）。

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

/// 慢路径 Trees 分支回退顺序：先 main 后 master（ZCode 类老仓默认分支仍为 master，
/// 只查 main 会零命中零 emit，首屏恒为 initials）。顺序即优先级，main 优先。
/// 搜索对齐趋势：实际探测分支由 [`crate::github::icon_probe::resolve_probe_branches`]
/// 动态解析（先 GET repos 取 `default_branch` 5s 超时，再补 main/master，最多3分支，
/// 与 `commands::icons_cycle_probe::probe_git_trees` 同源共用）；
/// 本常量仅为回退基线 + 存量单测断言保留（值与 `icon_probe::FALLBACK_PROBE_BRANCHES` 同源）。
#[allow(dead_code)]
pub(crate) const SEARCH_PROBE_BRANCHES: [&str; 2] =
    crate::github::icon_probe::FALLBACK_PROBE_BRANCHES;

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

/// 统一事件 key：小写 `owner/repo`。
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
    let timeout_each = crate::commands::catalog_search::api_timeout_or(
        std::time::Duration::from_secs(10),
    );
    let batch = futures_util::stream::iter(jobs.into_iter().map(|job| {
        let handle = handle.clone();
        let client = client.clone();
        let slow_headers = slow_headers.clone();
        let emit = emit.clone();
        async move {
            // 快慢分离：快路径 SimpleIcons（repo+owner 去重单循环，每 slug 超时与
            // 外层兜底均经 api_timeout_seconds 统一配置，未设置时回退 1500ms/8000ms 历史值），
            // 快命中立即回调并 emit，不等慢路径。
            let fast_url = tokio::time::timeout(
                crate::commands::catalog_search::api_timeout_or(std::time::Duration::from_millis(
                    8000,
                )),
                crate::github::icon_probe::probe_simple_icons(&client, &job.owner, &job.repo),
            )
            .await
            .ok()
            .flatten()
            .map(|h| h.url)
            .unwrap_or_default();

            if !fast_url.trim().is_empty() {
                emit(handle, job, fast_url, 2, "live".to_string()).await;
                return;
            }

            // 慢路径：快未命中且有 token 才跑 Trees；超时只弃慢不弃快。
            // 分支动态解析（先 GET repos 取 default_branch 5s 超时，
            // 再补 main/master，最多3分支），复用 `icon_probe::resolve_probe_branches`
            //（与 `icons_cycle_probe::probe_git_trees` 同源）；
            // main 未命中回退 master（ZCode 类老仓默认分支为 master）。
            if let Some(hdrs) = slow_headers.as_ref() {
                let branches = crate::github::icon_probe::resolve_probe_branches(
                    &client, hdrs, &job.owner, &job.repo,
                )
                .await;
                let mut hit = None;
                for branch in &branches {
                    if let Some(h) = crate::github::icon_probe::probe_trees(
                        &client,
                        hdrs,
                        &job.owner,
                        &job.repo,
                        branch,
                    )
                    .await
                    {
                        hit = Some(h);
                        break;
                    }
                }
                if let Some(hit) = hit {
                    emit(handle, job, hit.url, 3, "live".to_string()).await;
                }
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
        assert_eq!(SEARCH_PROBE_BRANCHES, ["main", "master"]);
        assert!(SEARCH_PROBE_BRANCHES.contains(&"master"));
    }
}
