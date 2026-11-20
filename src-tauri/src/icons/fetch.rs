//! 统一图标补探与流式调度（只做探测与调度，不触 DB/fs）。

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

/// 单个图标补探任务（`id` 为小写 `owner/repo`）。
#[derive(Debug, Clone)]
pub struct IconFetchJob {
    pub id: String,
    pub owner: String,
    pub repo: String,
    pub ctx: IconFetchCtx,
}

/// 待补探仓库坐标（`id` 归一小写 + `owner`/`repo`）。
#[derive(Debug, Clone)]
pub struct RepoCoord {
    pub id: String,
    pub owner: String,
    pub repo: String,
}

impl RepoCoord {
    /// 附加补探上下文成完整任务。
    pub fn into_job(self, ctx: IconFetchCtx) -> IconFetchJob {
        IconFetchJob {
            id: self.id,
            owner: self.owner,
            repo: self.repo,
            ctx,
        }
    }
}

/// 补探上下文（携带各调用方独立的世代计数器 `gen`）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum IconFetchCtx {
    Search { search_id: String, gen: u64 },
    Trend { board: String, gen: u64 },
    Starred { gen: u64 },
    Launchpad { gen: u64 },
}

/// 图标就绪事件载荷（`zstore://icon-ready`）。
/// `level` 为 2/3/4；`via` 为 `"live"` 或 `"m2"`。
#[derive(Debug, Clone, serde::Serialize)]
pub struct IconReadyPayload {
    /// 小写 `owner/repo`（与 DB 主键同源）。
    pub id: String,
    pub icon: String,
    pub level: i32,
    /// `"live"` 或 `"m2"`。
    pub via: String,
    pub context: IconFetchCtx,
}

/// 根据详情图标 URL 启发式推断轮换级别（2=SimpleIcons，4=README，3=仓库树）。
pub(crate) fn level_for_detail_icon(icon_trimmed: &str) -> i32 {
    let u = icon_trimmed.trim();
    let lower = u.to_lowercase();
    if lower.contains("simpleicons.org") {
        2
    } else if u.contains("/blob/")
        || u.contains("/HEAD/")
        || lower.contains("readme")
        || lower.contains("user-images.githubusercontent.com")
        || lower.contains("camo.githubusercontent.com")
        || lower.contains("github.com/user-attachments/assets/")
    {
        4
    } else {
        3
    }
}

pub(crate) fn is_body_image_url(url: &str) -> bool {
    super::probe::is_readme_body_image(url)
}

/// 将 owner/repo 归一化为小写图标键。
pub fn icon_key(owner: &str, repo: &str) -> String {
    crate::forge::canonical_app_id_from_parts(owner, repo)
}

/// 由任务与探测结果构建 `IconReadyPayload`。
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

/// 发送 `zstore://icon-ready` 事件。
pub fn emit_icon_ready(handle: &AppHandle, payload: &IconReadyPayload) {
    let _ = handle.emit("zstore://icon-ready", payload);
}

/// L2 探测：SimpleIcons 品牌库（免鉴权），超时取配置或回退 8s。
pub(crate) async fn probe_l2_simple(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Option<String> {
    tokio::time::timeout(
        crate::config::api_timeout_or(std::time::Duration::from_millis(8000)),
        super::probe::probe_simple_icons(client, owner, repo),
    )
    .await
    .ok()
    .flatten()
    .map(|h| h.url)
    .filter(|u| !u.trim().is_empty())
}

/// L3 探测：Git Trees 全库评分（需鉴权头，无 headers 直接返回 `None` 以保护匿名配额）。
pub(crate) async fn probe_l3_trees(
    client: &reqwest::Client,
    slow_headers: Option<&reqwest::header::HeaderMap>,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let hdrs = slow_headers?;
    let branches = super::probe::resolve_probe_branches(client, hdrs, owner, repo).await;
    for branch in &branches {
        if let Some(h) = super::probe::probe_trees(client, hdrs, owner, repo, branch).await {
            if !h.url.trim().is_empty() {
                return Some(h.url);
            }
        }
    }
    None
}

/// 匿名探测（仅走免鉴权 L2，不触碰 Trees API）。
pub(crate) async fn probe_anon_simple(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Option<String> {
    probe_l2_simple(client, owner, repo).await
}

/// 单仓 live 探测（L2 → L3，快路径命中即返回），`slow_headers` 为 `None` 时仅探 L2。
pub(crate) async fn probe_single_live(
    icon_client: &reqwest::Client,
    api_client: &reqwest::Client,
    slow_headers: Option<&reqwest::header::HeaderMap>,
    owner: &str,
    repo: &str,
) -> Option<(String, i32)> {
    if let Some(url) = probe_l2_simple(icon_client, owner, repo).await {
        return Some((url, 2));
    }
    if let Some(url) = probe_l3_trees(api_client, slow_headers, owner, repo).await {
        return Some((url, 3));
    }
    None
}

/// 计算整批补探的总超时上限（按批次数伸缩，下界为 `cfg_total_secs`）。
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

/// 并发流式补探任务图标，命中后交由 `emit` 回调持久化并推送事件；
/// 开探前检查 `should_stop` 实现世代协作取消。
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
    // SimpleIcons 走无鉴权 icon_client，Trees 走带 Token 的 api_client。
    let timeout_secs = crate::config::get_project_config()
        .network
        .api_timeout_seconds;
    let icon_client = crate::forge::http::new_icon_client(timeout_secs).unwrap_or_default();
    let api_client = crate::forge::http::new_api_client(timeout_secs).unwrap_or_default();
    let slow_headers = token.as_deref().filter(|t| !t.trim().is_empty()).map(|t| {
        crate::forge::http::preset_headers(
            crate::forge::http::ApiPreset::GithubApi,
            Some(t),
            crate::forge::http::AuthScheme::Token,
        )
    });
    let pool = cfg.pool.max(1);
    let jobs_len = jobs.len();
    let timeout_each = crate::config::api_timeout_or(std::time::Duration::from_secs(10));
    let batch = futures_util::stream::iter(jobs.into_iter().map(|job| {
        let handle = handle.clone();
        let icon_client = icon_client.clone();
        let api_client = api_client.clone();
        let slow_headers = slow_headers.clone();
        let emit = emit.clone();
        let should_stop = should_stop.clone();
        async move {
            // 过期世代在开探前跳过；在飞任务仍交由 emit 按 gen 决定是否推送。
            if should_stop.as_ref().is_some_and(|stop| stop()) {
                return;
            }
            if let Some((url, level)) = probe_single_live(
                &icon_client,
                &api_client,
                slow_headers.as_ref(),
                &job.owner,
                &job.repo,
            )
            .await
            {
                emit(handle, job, url, level, "live".to_string()).await;
            }
        }
    }))
    .buffer_unordered(pool)
    .for_each(|()| async {});
    let total = scaled_total_timeout(jobs_len, pool, timeout_each, cfg.total_timeout_secs);
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
        let t = IconFetchCtx::Trend {
            board: "daily".to_string(),
            gen: 1,
        };
        assert_eq!(serde_json::to_value(&t).unwrap()["kind"], "trend");
        let s = IconFetchCtx::Starred { gen: 2 };
        assert_eq!(serde_json::to_value(&s).unwrap()["kind"], "starred");
    }

    #[test]
    fn scaled_total_timeout_stretches_with_pages() {
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
                crate::icons::probe::is_readme_body_image(u),
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
                !crate::icons::probe::is_readme_body_image(u),
                "single source must agree: {u}"
            );
        }
    }

    #[test]
    fn level_for_detail_icon_classifies_l2_l3_l4_and_head_rewrites() {
        assert_eq!(
            level_for_detail_icon("https://cdn.simpleicons.org/rustdesk"),
            2
        );
        assert_eq!(
            level_for_detail_icon(
                "https://raw.githubusercontent.com/owner/repo/main/assets/icon.png"
            ),
            3
        );
        assert_eq!(
            level_for_detail_icon(
                "https://raw.githubusercontent.com/owner/repo/HEAD/docs/banner.png"
            ),
            4
        );
        assert_eq!(
            level_for_detail_icon("https://github.com/owner/repo/blob/main/logo.png"),
            4
        );
        assert_eq!(
            level_for_detail_icon("https://user-images.githubusercontent.com/1/2.png"),
            4
        );
        assert_eq!(
            level_for_detail_icon("https://camo.githubusercontent.com/abc/def"),
            4
        );
        assert_eq!(
            level_for_detail_icon("https://github.com/user-attachments/assets/1234-5678"),
            4
        );
    }
}
