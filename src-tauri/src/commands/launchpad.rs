//! 开源广场（Launchpad）命令：清单同步水合（`get_launchpad_feed`）、实时讨论脉冲同步
//! （`sync_launchpad_discussions`）与 GitHub Discussions 讨论/评论/顶帖
//! （`get_launchpad_discussion`、`add_launchpad_comment`、`toggle_launchpad_upvote`）。
//!
//! 只读写 `launchpad_feed_cache`、`launchpad_discussion_cache`、`api_etag_cache`、`user_stars`
//! 与未收录 `repo_card_cache`；精选目录表（`catalog_apps` / `custom_apps`）永不写入。

use crate::db::{Database, LaunchpadDiscussionUpsert};
use crate::launchpad::{
    LaunchpadEntry, LaunchpadFeedResponse, LaunchpadPulseItem, RawLaunchpadManifest,
};
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

fn discussion_lookup_key(repo: &str, number: u64) -> Option<(String, u64)> {
    if number == 0 {
        return None;
    }
    let key = repo.trim().to_ascii_lowercase();
    (!key.is_empty()).then_some((key, number))
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

    let fetched = match crate::launchpad::fetch_with_fallback(
        client,
        url,
        cached_etag.as_deref(),
        mirror_prefix,
    )
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

/// 本地状态零网络叠加：先合并 `launchpad_discussion_cache` 中比清单更新的讨论计数、本人顶帖态与源仓统计，
/// 再将未收录项非破坏写入 `repo_card_cache`，盖收录章、叠加已确认图标与本地 Star 态；
/// 返回仍缺图标的 GitHub 项（供后台补图）。
pub(crate) fn hydrate_entries(
    db: &Database,
    catalog: &crate::github::CatalogService,
    entries: &mut [LaunchpadEntry],
    logged_in: bool,
    manifest_generated_secs: i64,
) -> Vec<crate::icons::RepoCoord> {
    let disc_keys: Vec<(String, u64)> = entries
        .iter()
        .filter_map(|e| discussion_lookup_key(&e.discussion_repo, e.discussion_number))
        .collect();
    let disc_states = db
        .get_launchpad_discussion_states_batch(&disc_keys)
        .unwrap_or_default();

    for entry in entries.iter_mut() {
        entry.viewer_has_upvoted = false;
        if let Some(key) = discussion_lookup_key(&entry.discussion_repo, entry.discussion_number) {
            if let Some(st) = disc_states.get(&key) {
                if entry.discussion_node_id.is_none() && !st.node_id.is_empty() {
                    entry.discussion_node_id = Some(st.node_id.clone());
                }
                if st.synced_at >= manifest_generated_secs {
                    entry.discussion_upvotes = st.upvote_count;
                    entry.discussion_comments_count = st.comments_count;
                }
                if st.repo_synced_at >= manifest_generated_secs {
                    if let Some(stars) = st.stars {
                        entry.summary.core.stars = stars;
                    }
                    if let Some(forks) = st.forks {
                        entry.summary.core.forks = forks;
                    }
                    if let Some(ver) = &st.latest_version {
                        entry.summary.core.latest_version = ver.clone();
                    }
                }
                entry.viewer_has_upvoted = logged_in && st.viewer_has_upvoted.unwrap_or(false);
            }
        }
    }

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
        if entry.viewer_has_starred && core.stars == 0 {
            core.stars = 1;
        }
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

    let manifest_ts = load
        .manifest
        .generated_at
        .as_deref()
        .and_then(crate::launchpad::parse_rfc3339_secs)
        .unwrap_or(0);
    let (mut spotlight, mut items) =
        crate::launchpad::partition_spotlight_and_recent(&load.manifest, crate::now_secs());
    let token = state.active_github_token();
    let missing_icons = {
        let db = state.db()?;
        let mut coords = hydrate_entries(
            &db,
            &state.catalog,
            &mut spotlight,
            token.is_some(),
            manifest_ts,
        );
        coords.extend(hydrate_entries(
            &db,
            &state.catalog,
            &mut items,
            token.is_some(),
            manifest_ts,
        ));
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

/// 根据 GitHub Discussions（及同批 GitHub 源仓库）拉取广场卡片最新实时数据并落盘。
pub(crate) async fn sync_launchpad_discussions_core(
    db: &Mutex<Database>,
    catalog: &crate::github::CatalogService,
    client: &reqwest::Client,
    api_base: &str,
    source_url: &str,
    token: Option<&str>,
    force_refresh: bool,
) -> Result<Vec<LaunchpadPulseItem>, String> {
    use crate::github::discussions as gd;

    let (manifest_opt, existing_states) = with_db(db, |db| {
        let m = db
            .get_launchpad_feed_cache(source_url)
            .ok()
            .flatten()
            .and_then(|(payload, _)| parse_snapshot(&payload));
        let states = m
            .as_ref()
            .map(|manifest| {
                let keys: Vec<(String, u64)> = manifest
                    .items
                    .iter()
                    .filter_map(|it| discussion_lookup_key(&it.discussion_repo, it.discussion_number))
                    .collect();
                db.get_launchpad_discussion_states_batch(&keys)
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        (m, states)
    })?;
    let Some(manifest) = manifest_opt else {
        return Ok(Vec::new());
    };

    let mut targets: Vec<gd::PulseTarget> = Vec::with_capacity(manifest.items.len());
    let mut raw_by_id: std::collections::HashMap<String, crate::launchpad::RawLaunchpadItem> =
        std::collections::HashMap::with_capacity(manifest.items.len());
    for item in manifest.items {
        let Some(id) = crate::launchpad::canonical_id(&item.id) else {
            continue;
        };
        let forge = item.forge.trim();
        let is_github = forge.is_empty() || forge.eq_ignore_ascii_case("github");
        targets.push(gd::PulseTarget {
            id: id.clone(),
            owner: item.owner.trim().to_string(),
            repo: item.repo.trim().to_string(),
            is_github,
            discussion_repo: item.discussion_repo.trim().to_string(),
            discussion_number: item.discussion_number,
        });
        raw_by_id.insert(id, item);
    }
    if targets.is_empty() {
        return Ok(Vec::new());
    }

    let now = crate::now_secs();
    let fetched = match token {
        Some(tok) => gd::fetch_pulse_batch_authed(
            gd::DiscussionClient {
                client,
                api_base,
                token: tok,
            },
            &targets,
        )
        .await
        .map_err(gd::GqlError::into_message)?,
        None => {
            gd::fetch_pulse_anonymous(
                db,
                client,
                Some(api_base),
                &targets,
                &existing_states,
                force_refresh,
                now,
            )
            .await
        }
    };
    if fetched.is_empty() {
        return Ok(Vec::new());
    }

    let logged_in = token.is_some();
    with_db(db, |db| {
        let mut card_upserts: Vec<crate::db::RepoCardUpsert> = Vec::new();
        if let Err(e) = db.with_immediate_transaction(|| {
            for f in &fetched {
                let has_state = f.comments_count.is_some()
                    || f.authoritative_upvotes
                    || f.stars.is_some()
                    || f.forks.is_some()
                    || f.latest_version.is_some();
                if f.target.discussion_number > 0 && !f.target.discussion_repo.is_empty() && has_state
                {
                    db.upsert_launchpad_discussion_state(&LaunchpadDiscussionUpsert {
                        discussion_repo: f.target.discussion_repo.clone(),
                        discussion_number: f.target.discussion_number,
                        node_id: f.node_id.clone(),
                        upvote_count: f.upvote_count,
                        authoritative_upvotes: f.authoritative_upvotes,
                        comments_count: f.comments_count,
                        viewer_has_upvoted: f.viewer_has_upvoted,
                        stars: f.stars,
                        forks: f.forks,
                        latest_version: f.latest_version.clone(),
                        synced_at: now,
                    })?;
                }
                if logged_in && f.target.is_github {
                    if let Some(starred) = f.viewer_has_starred {
                        let _ = db.set_starred(&f.target.owner, &f.target.repo, starred);
                    }
                }
                if !catalog.is_cataloged(&f.target.id)
                    && (f.stars.is_some() || f.forks.is_some() || f.latest_version.is_some())
                {
                    if let Some(raw) = raw_by_id.get(&f.target.id) {
                        let mut summary = raw.to_summary(&f.target.id);
                        if let Some(s) = f.stars {
                            summary.core.stars = s;
                        }
                        if let Some(fk) = f.forks {
                            summary.core.forks = fk;
                        }
                        if let Some(ver) = &f.latest_version {
                            summary.core.latest_version = ver.clone();
                        }
                        card_upserts.push(crate::db::RepoCardUpsert {
                            summary,
                            confirmed_other: false,
                            is_private: Some(false),
                        });
                    }
                }
            }
            Ok(())
        }) {
            log::warn!(target: "launchpad", "discussion pulse db tx failed: {}", e);
        }
        if !card_upserts.is_empty() {
            if let Err(e) = db.upsert_repo_cards_batch(&card_upserts) {
                log::warn!(target: "launchpad", "repo_card_cache pulse upsert failed: {}", e);
            }
        }

        let mut out = Vec::with_capacity(fetched.len());
        for f in fetched {
            let stored = (f.target.discussion_number > 0)
                .then(|| {
                    db.get_launchpad_discussion_state(
                        &f.target.discussion_repo,
                        f.target.discussion_number,
                    )
                    .ok()
                    .flatten()
                })
                .flatten();
            let upvotes = stored
                .as_ref()
                .map(|s| s.upvote_count)
                .or_else(|| f.authoritative_upvotes.then_some(f.upvote_count));
            let comments = stored
                .as_ref()
                .map(|s| s.comments_count)
                .or(f.comments_count);
            let node_id = stored
                .as_ref()
                .map(|s| s.node_id.clone())
                .filter(|s| !s.is_empty())
                .or(f.node_id);
            let viewer_upvoted = if logged_in {
                stored
                    .as_ref()
                    .and_then(|s| s.viewer_has_upvoted)
                    .or(f.viewer_has_upvoted)
            } else {
                Some(false)
            };
            out.push(LaunchpadPulseItem {
                id: f.target.id,
                discussion_repo: f.target.discussion_repo,
                discussion_number: f.target.discussion_number,
                discussion_node_id: node_id,
                discussion_upvotes: upvotes,
                discussion_comments_count: comments,
                viewer_has_upvoted: viewer_upvoted,
                stars: f.stars,
                forks: f.forks,
                latest_version: f.latest_version,
                viewer_has_starred: logged_in.then_some(f.viewer_has_starred).flatten(),
            });
        }
        out
    })
}

/// 开源广场实时讨论脉冲：从 GitHub Discussions 批量拉取最新顶帖数、评论数、本人顶帖态与源仓星数并落盘。
#[tauri::command(rename_all = "camelCase")]
pub async fn sync_launchpad_discussions(
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> crate::AppResult<Vec<LaunchpadPulseItem>> {
    let source_url = crate::config::get_project_config()
        .launchpad
        .default_source_url
        .trim()
        .to_string();
    let client = crate::shared_http_client();
    let token = state.active_github_token();
    let items = sync_launchpad_discussions_core(
        &state.db,
        &state.catalog,
        &client,
        crate::github::GITHUB_API_BASE,
        &source_url,
        token.as_deref(),
        force_refresh.unwrap_or(false),
    )
    .await
    .inspect_err(|e| {
        log::warn!(
            target: "launchpad",
            "discussion pulse sync failed: {}",
            crate::log_support::short_reason(e)
        );
    })?;
    Ok(items)
}

fn require_token(state: &AppState, msg: &str) -> Result<String, String> {
    state.active_github_token().ok_or_else(|| msg.to_string())
}

/// 讨论详情：已登录走 GraphQL；未登录走匿名 REST 只读降级（不触发 GraphQL 401）；首页读取结果即时回写本地脉冲表。
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
    let repo_coord = format!("{owner}/{repo}");
    let client = crate::shared_http_client();
    let cursor = cursor.filter(|c| !c.trim().is_empty());
    let is_first_page = cursor.is_none();
    if let Some(token) = state.active_github_token() {
        let detail = gd::fetch_discussion_authed(
            gd::DiscussionClient {
                client: &client,
                api_base: crate::github::GITHUB_API_BASE,
                token: &token,
            },
            gd::DiscussionRef {
                owner: &owner,
                repo: &repo,
                number,
            },
            cursor.as_deref(),
        )
        .await
        .map_err(|e| crate::AppError::from(e.into_message()))?;
        if is_first_page {
            if let Ok(db) = state.db() {
                let _ = db.upsert_launchpad_discussion_state(&LaunchpadDiscussionUpsert {
                    discussion_repo: repo_coord,
                    discussion_number: number,
                    node_id: (!detail.id.is_empty()).then(|| detail.id.clone()),
                    upvote_count: detail.upvote_count,
                    authoritative_upvotes: true,
                    comments_count: Some(detail.comments_total),
                    viewer_has_upvoted: Some(detail.viewer_has_upvoted),
                    stars: None,
                    forks: None,
                    latest_version: None,
                    synced_at: crate::now_secs(),
                });
            }
        }
        return Ok(detail);
    }
    if !is_first_page {
        // 匿名通道只提供首页评论，续页需登录。
        let mut shell = gd::degraded_shell(&owner, &repo, number);
        shell.is_stale = false;
        return Ok(shell);
    }
    let (mut detail, authoritative_upvotes) = gd::fetch_discussion_anonymous(
        &state.db,
        &client,
        None,
        &owner,
        &repo,
        number,
        force_refresh.unwrap_or(false),
    )
    .await;
    if !detail.is_stale && !detail.id.is_empty() {
        if let Ok(db) = state.db() {
            let _ = db.upsert_launchpad_discussion_state(&LaunchpadDiscussionUpsert {
                discussion_repo: repo_coord.clone(),
                discussion_number: number,
                node_id: Some(detail.id.clone()),
                upvote_count: detail.upvote_count,
                authoritative_upvotes,
                comments_count: Some(detail.comments_total),
                viewer_has_upvoted: None,
                stars: None,
                forks: None,
                latest_version: None,
                synced_at: crate::now_secs(),
            });
            if let Ok(Some(st)) = db.get_launchpad_discussion_state(&repo_coord, number) {
                detail.upvote_count = st.upvote_count;
            }
        }
    }
    Ok(detail)
}

/// 发表评论或回复（需登录）；成功后即时更新本地脉冲缓存并清除匿名通道的讨论/评论缓存。
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
    let repo_coord = format!("{owner}/{repo}");
    let http = crate::shared_http_client();
    let comment = gd::add_comment(
        gd::DiscussionClient {
            client: &http,
            api_base: crate::github::GITHUB_API_BASE,
            token: &token,
        },
        gd::DiscussionRef {
            owner: &owner,
            repo: &repo,
            number,
        },
        discussion_id.as_deref(),
        &body,
        reply_to_id.as_deref(),
    )
    .await?;
    if let Ok(db) = state.db() {
        let _ = db.record_launchpad_comment_added(
            &repo_coord,
            number,
            discussion_id.as_deref(),
            crate::now_secs(),
        );
        let _ = db.delete_etag(&gd::rest_comments_url(&owner, &repo, number));
        let _ = db.delete_etag(&gd::rest_discussion_url(&owner, &repo, number));
    }
    Ok(comment)
}

/// `+1` 顶帖 / 取消顶帖（需登录）：原生 Upvote 优先，受限时回退 👍 Reaction；结果即时写入本地脉冲表。
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
    let repo_coord = format!("{owner}/{repo}");
    let http = crate::shared_http_client();
    let result = gd::toggle_upvote(
        gd::DiscussionClient {
            client: &http,
            api_base: crate::github::GITHUB_API_BASE,
            token: &token,
        },
        gd::DiscussionRef {
            owner: &owner,
            repo: &repo,
            number,
        },
        subject_id.as_deref(),
        currently_upvoted,
    )
    .await?;
    if let Ok(db) = state.db() {
        let _ = db.record_launchpad_upvote(
            &repo_coord,
            number,
            &result.subject_id,
            result.upvote_count,
            result.viewer_has_upvoted,
            crate::now_secs(),
        );
        let _ = db.delete_etag(&gd::rest_discussion_url(&owner, &repo, number));
    }
    Ok(result)
}

#[cfg(test)]
#[path = "launchpad_tests.rs"]
mod tests;
