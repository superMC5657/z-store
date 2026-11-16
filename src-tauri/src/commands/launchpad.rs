//! 开源广场（Launchpad）命令：清单同步水合（`get_launchpad_feed`）与 GitHub Discussions
//! 讨论/评论/顶帖（`get_launchpad_discussion`、`add_launchpad_comment`、`toggle_launchpad_upvote`）。
//!
//! 只读写 `launchpad_feed_cache`、`api_etag_cache` 与未收录 `repo_card_cache`；
//! 精选目录表（`catalog_apps` / `custom_apps`）永不写入。

use crate::db::Database;
use crate::launchpad::{LaunchpadEntry, LaunchpadFeedResponse, RawLaunchpadManifest};
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// 广场卡片后台补图世代：每次 `get_launchpad_feed` +1，上一轮在途补图停发。
pub(crate) static LAUNCHPAD_ICON_GEN: AtomicU64 = AtomicU64::new(0);

/// 清单装载结果（尚未分流与水合）。
#[derive(Debug)]
pub(crate) struct LaunchpadManifestLoad {
    pub manifest: RawLaunchpadManifest,
    pub cached_at: Option<i64>,
    pub is_stale: bool,
}

fn parse_snapshot(payload: &str) -> Option<RawLaunchpadManifest> {
    crate::launchpad::parse_manifest(payload)
        .ok()
        .map(crate::launchpad::sanitize_manifest)
}

fn with_db<T>(db: &Mutex<Database>, f: impl FnOnce(&Database) -> T) -> Result<T, String> {
    let guard = db.lock().map_err(|e| e.to_string())?;
    Ok(f(&guard))
}

/// 拉取并落盘清单：
/// - 有快照且非强刷时携带 `If-None-Match`，`304` 直接复用快照（不重写载荷）；
/// - `200` 校验后单事务写入 `launchpad_feed_cache` 与 `api_etag_cache`（镜像响应不落 ETag）；
/// - 拉取/解析/落盘失败回退快照并置 `is_stale`；无快照时返回错误供页内重试。
pub(crate) async fn load_launchpad_manifest(
    db: &Mutex<Database>,
    client: &reqwest::Client,
    url: &str,
    mirror_prefix: Option<&str>,
    force_refresh: bool,
) -> Result<LaunchpadManifestLoad, String> {
    let (snapshot, cached_etag) = with_db(db, |db| {
        let snap = db.get_launchpad_feed_cache(url).ok().flatten();
        let etag = if force_refresh || snap.is_none() {
            None
        } else {
            db.get_etag(url).ok().flatten()
        };
        (snap, etag)
    })?;

    let fallback = |reason: String| -> Result<LaunchpadManifestLoad, String> {
        log::warn!(target: "launchpad", "feed degraded: {}", crate::log_support::short_reason(&reason));
        match snapshot
            .as_ref()
            .and_then(|(payload, at)| parse_snapshot(payload).map(|m| (m, *at)))
        {
            Some((manifest, at)) => Ok(LaunchpadManifestLoad {
                manifest,
                cached_at: Some(at),
                is_stale: true,
            }),
            None => Err(reason),
        }
    };

    let fetched =
        match crate::launchpad::fetch_with_fallback(client, url, cached_etag.as_deref(), mirror_prefix)
            .await
        {
            Ok(f) => f,
            Err(e) => return fallback(e),
        };

    let Some(text) = fetched.text else {
        let Some((payload, _)) = snapshot.as_ref() else {
            return fallback("304 但本地无开源广场快照".to_string());
        };
        let Some(manifest) = parse_snapshot(payload) else {
            return fallback("开源广场快照损坏".to_string());
        };
        let now = crate::now_secs();
        let _ = with_db(db, |db| {
            let _ = db.touch_etag(url, now);
            let _ = db.touch_launchpad_feed_cache(url);
        });
        return Ok(LaunchpadManifestLoad {
            manifest,
            cached_at: Some(now),
            is_stale: false,
        });
    };

    let manifest = match crate::launchpad::parse_manifest(&text) {
        Ok(m) => crate::launchpad::sanitize_manifest(m),
        Err(e) => return fallback(e),
    };
    let payload = match serde_json::to_string(&manifest) {
        Ok(p) => p,
        Err(e) => return fallback(e.to_string()),
    };
    let now = crate::now_secs();
    let etag = fetched.etag.filter(|_| !fetched.via_mirror);
    let saved = with_db(db, |db| {
        db.with_immediate_transaction(|| {
            db.save_launchpad_feed_cache(url, &payload)?;
            match etag.as_deref() {
                Some(et) => db.save_etag(url, et, "", now)?,
                None => db.delete_etag(url)?,
            }
            Ok(())
        })
    })?;
    if let Err(e) = saved {
        return fallback(format!("开源广场快照落盘失败: {}", e));
    }
    Ok(LaunchpadManifestLoad {
        manifest,
        cached_at: Some(now),
        is_stale: false,
    })
}

/// 本地状态零网络叠加：未收录项非破坏写入 `repo_card_cache`，盖收录章、
/// 叠加已确认图标与本地 Star 态；返回仍缺图标的 GitHub 项（供后台补图）。
pub(crate) fn hydrate_entries(
    db: &Database,
    catalog: &crate::github::CatalogService,
    entries: &mut [LaunchpadEntry],
    logged_in: bool,
) -> Vec<crate::icons::RepoCoord> {
    let staged: Vec<crate::db::RepoCardUpsert> = entries
        .iter()
        .filter(|e| !catalog.is_cataloged(&e.summary.core.id))
        .map(|e| crate::db::RepoCardUpsert {
            summary: e.summary.clone(),
            confirmed_other: false,
            is_private: Some(false),
        })
        .collect();
    if !staged.is_empty() {
        if let Err(e) = db.upsert_repo_cards_batch(&staged) {
            log::debug!(target: "launchpad", "repo_card_cache upsert failed: {}", e);
        }
    }

    let mut missing_icons = Vec::new();
    for entry in entries.iter_mut() {
        catalog.stamp_summary(&mut entry.summary);
        let core = &mut entry.summary.core;
        let is_github = core.forge.as_deref().unwrap_or("github") == "github";
        if core.icon.trim().is_empty() {
            if let Some(icon) =
                crate::icons::resolve_confirmed_icon_from_db(db, &core.id, &core.owner, &core.repo)
            {
                core.icon = icon;
            } else if is_github {
                missing_icons.push(crate::icons::RepoCoord {
                    id: core.id.clone(),
                    owner: core.owner.clone(),
                    repo: core.repo.clone(),
                });
            }
        }
        entry.viewer_has_starred =
            logged_in && is_github && db.is_starred(&core.owner, &core.repo).unwrap_or(false);
    }
    missing_icons
}

fn spawn_launchpad_icon_stream(
    app_handle: &AppHandle,
    coords: Vec<crate::icons::RepoCoord>,
    token: Option<String>,
) {
    let gen = LAUNCHPAD_ICON_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if coords.is_empty() {
        return;
    }
    let jobs: Vec<crate::icons::IconFetchJob> = coords
        .into_iter()
        .map(|coord| coord.into_job(crate::icons::IconFetchCtx::Launchpad { gen }))
        .collect();
    let cfg_icon = crate::config::get_project_config().limits.icon_fetch;
    let should_stop: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
        std::sync::Arc::new(move || LAUNCHPAD_ICON_GEN.load(Ordering::SeqCst) != gen);
    tokio::spawn(crate::icons::fetch_icons_stream(
        app_handle.clone(),
        jobs,
        token,
        cfg_icon,
        crate::commands::catalog_search::emit_icon_job,
        Some(should_stop),
    ));
}

/// 开源广场清单：按需拉取（启动阶段不预取），失败降级本地快照。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_launchpad_feed(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> crate::AppResult<LaunchpadFeedResponse> {
    let cfg = &crate::config::get_project_config().launchpad;
    let url = cfg.default_source_url.trim().to_string();
    // 仅当启用了非 direct 加速镜像时，首跳可重试失败才经镜像回退一次。
    let mirror_prefix = state
        .mirror
        .lock()
        .ok()
        .and_then(|m| m.active_mirror_prefix());
    let client = state.catalog.http_client();
    let load = load_launchpad_manifest(
        &state.db,
        &client,
        &url,
        mirror_prefix.as_deref(),
        force_refresh.unwrap_or(false),
    )
    .await?;

    let (mut spotlight, mut items) =
        crate::launchpad::partition_spotlight_and_recent(&load.manifest, crate::now_secs());
    let token = state.active_github_token();
    let missing_icons = {
        let db = state.db()?;
        let mut coords = hydrate_entries(&db, &state.catalog, &mut spotlight, token.is_some());
        coords.extend(hydrate_entries(&db, &state.catalog, &mut items, token.is_some()));
        coords
    };
    spawn_launchpad_icon_stream(&app_handle, missing_icons, token);

    let discussions_repo = load
        .manifest
        .discussions_repo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.discussions_repo.as_str())
        .to_string();
    Ok(LaunchpadFeedResponse {
        spotlight,
        items,
        discussions_repo,
        submit_issue_url: cfg.submit_issue_url.clone(),
        submit_web_url: cfg.submit_web_url.clone(),
        generated_at: load.manifest.generated_at.clone(),
        cached_at: load.cached_at,
        is_stale: load.is_stale,
    })
}

fn require_token(state: &AppState, msg: &str) -> Result<String, String> {
    state.active_github_token().ok_or_else(|| msg.to_string())
}

/// 讨论详情：已登录走 GraphQL；未登录走匿名 REST 只读降级（不触发 GraphQL 401）。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_launchpad_discussion(
    state: State<'_, AppState>,
    discussion_repo: String,
    discussion_number: u64,
    cursor: Option<String>,
    force_refresh: Option<bool>,
) -> crate::AppResult<crate::launchpad::LaunchpadDiscussionDetail> {
    use crate::github::discussions as gd;
    let (owner, repo) = gd::validate_discussion_repo(&discussion_repo)?;
    let number = gd::validate_discussion_number(discussion_number)?;
    let client = crate::shared_http_client();
    let cursor = cursor.filter(|c| !c.trim().is_empty());
    if let Some(token) = state.active_github_token() {
        return gd::fetch_discussion_authed(
            &client,
            crate::github::GITHUB_API_BASE,
            &token,
            &owner,
            &repo,
            number,
            cursor.as_deref(),
        )
        .await
        .map_err(|e| crate::AppError::from(e.into_message()));
    }
    if cursor.is_some() {
        // 匿名通道只提供首页评论，续页需登录。
        let mut shell = gd::degraded_shell(&owner, &repo, number);
        shell.is_stale = false;
        return Ok(shell);
    }
    Ok(gd::fetch_discussion_anonymous(
        &state.db,
        &client,
        None,
        &owner,
        &repo,
        number,
        force_refresh.unwrap_or(false),
    )
    .await)
}

/// 发表评论或回复（需登录）；成功后清除匿名通道的讨论/评论缓存。
#[tauri::command(rename_all = "camelCase")]
pub async fn add_launchpad_comment(
    state: State<'_, AppState>,
    discussion_repo: String,
    discussion_number: u64,
    discussion_id: Option<String>,
    body: String,
    reply_to_id: Option<String>,
) -> crate::AppResult<crate::launchpad::LaunchpadDiscussionComment> {
    use crate::github::discussions as gd;
    let token = require_token(&state, "请先登录 GitHub 账号后再发表评论")?;
    let (owner, repo) = gd::validate_discussion_repo(&discussion_repo)?;
    let number = gd::validate_discussion_number(discussion_number)?;
    let comment = gd::add_comment(
        &crate::shared_http_client(),
        crate::github::GITHUB_API_BASE,
        &token,
        &owner,
        &repo,
        number,
        discussion_id.as_deref(),
        &body,
        reply_to_id.as_deref(),
    )
    .await?;
    if let Ok(db) = state.db() {
        let _ = db.delete_etag(&gd::rest_comments_url(&owner, &repo, number));
        let _ = db.delete_etag(&gd::rest_discussion_url(&owner, &repo, number));
    }
    Ok(comment)
}

/// `+1` 顶帖 / 取消顶帖（需登录）：原生 Upvote 优先，受限时回退 👍 Reaction。
#[tauri::command(rename_all = "camelCase")]
pub async fn toggle_launchpad_upvote(
    state: State<'_, AppState>,
    discussion_repo: String,
    discussion_number: u64,
    subject_id: Option<String>,
    currently_upvoted: bool,
) -> crate::AppResult<crate::launchpad::LaunchpadUpvoteResult> {
    use crate::github::discussions as gd;
    let token = require_token(&state, "请先登录 GitHub 账号后再顶帖")?;
    let (owner, repo) = gd::validate_discussion_repo(&discussion_repo)?;
    let number = gd::validate_discussion_number(discussion_number)?;
    let result = gd::toggle_upvote(
        &crate::shared_http_client(),
        crate::github::GITHUB_API_BASE,
        &token,
        &owner,
        &repo,
        number,
        subject_id.as_deref(),
        currently_upvoted,
    )
    .await?;
    if let Ok(db) = state.db() {
        let _ = db.delete_etag(&gd::rest_discussion_url(&owner, &repo, number));
    }
    Ok(result)
}

#[cfg(test)]
#[path = "launchpad_tests.rs"]
mod tests;
