//! 广场清单装载：无令牌条件同步、镜像回退与本地快照降级，以及卡片本地水合。

use super::{
    parse_manifest, parse_rfc3339_secs, partition_spotlight_and_recent, sanitize_manifest,
    validate_manifest_strict, LaunchpadEntry, LaunchpadFeedResponse, RawLaunchpadManifest,
};
use crate::db::Database;
use crate::AppState;
use std::sync::Mutex;

/// 清单装载结果（尚未分流与水合）。
#[derive(Debug)]
pub(crate) struct LaunchpadManifestLoad {
    pub manifest: RawLaunchpadManifest,
    pub cached_at: Option<i64>,
    pub is_stale: bool,
}

/// 一次广场清单读取的产物：响应体与仍缺图标、需后台补图的 GitHub 条目。
pub(crate) struct LaunchpadFeed {
    pub response: LaunchpadFeedResponse,
    pub missing_icons: Vec<crate::icons::RepoCoord>,
}

pub(super) fn with_db<T>(
    db: &Mutex<Database>,
    f: impl FnOnce(&Database) -> T,
) -> Result<T, String> {
    let guard = db.lock().map_err(|e| e.to_string())?;
    Ok(f(&guard))
}

fn parse_snapshot(payload: &str) -> Option<RawLaunchpadManifest> {
    parse_manifest(payload).ok().map(sanitize_manifest)
}

/// 读取本地广场快照（已规整）。
pub(crate) fn snapshot_manifest(db: &Database, source_url: &str) -> Option<RawLaunchpadManifest> {
    db.get_launchpad_feed_cache(source_url)
        .ok()
        .flatten()
        .and_then(|(payload, _)| parse_snapshot(&payload))
}

/// 本地广场快照是否已含该规范标识。
pub(crate) fn is_id_in_snapshot(db: &Database, source_url: &str, canonical_id: &str) -> bool {
    snapshot_manifest(db, source_url).is_some_and(|m| {
        m.items
            .iter()
            .any(|item| item.id.eq_ignore_ascii_case(canonical_id))
    })
}

/// 清单解析与镜像严格校验（UTF-8 + JSON 结构，仅镜像通道追加严格规范校验）。
fn parse_and_validate_manifest(
    body: Vec<u8>,
    source: crate::forge::http::ManifestSource,
) -> Result<RawLaunchpadManifest, String> {
    let text = String::from_utf8(body).map_err(|_| "开源广场清单不是合法 UTF-8".to_string())?;
    let manifest = parse_manifest(&text)?;
    if source == crate::forge::http::ManifestSource::Mirror {
        validate_manifest_strict(&manifest)?;
    }
    Ok(manifest)
}

/// 拉取并落盘广场清单（ETag 条件请求；首跳可重试失败经镜像回退一次；失败回退本地快照并置 `is_stale`）。
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

    let fetched = match crate::forge::http::fetch_manifest_with_mirror_fallback(
        client,
        crate::forge::http::ManifestRequest {
            url,
            cached_etag: cached_etag.as_deref(),
            mirror_prefix,
            max_bytes: crate::db::launchpad::LAUNCHPAD_FEED_CACHE_MAX_BYTES,
            label: "开源广场清单",
        },
        parse_and_validate_manifest,
    )
    .await
    {
        Ok(f) => f,
        Err(e) => return fallback(e),
    };

    let Some(raw_manifest) = fetched.payload else {
        let Some(manifest) = snapshot
            .as_ref()
            .and_then(|(payload, _)| parse_snapshot(payload))
        else {
            return fallback("304 但本地无可用开源广场快照".to_string());
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

    let manifest = sanitize_manifest(raw_manifest);
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

/// 本地水合清单条目（DB 阶段，持锁）：合并较新的讨论脉冲、写未收录富卡、盖章与 Star 状态，
/// 并为空图标条目规划确认图标延迟任务（与入参对齐，磁盘读取留待锁外）。
pub(crate) fn hydrate_entries_deferred(
    db: &Database,
    catalog: &crate::github::CatalogService,
    entries: &mut [LaunchpadEntry],
    logged_in: bool,
    manifest_generated_secs: i64,
) -> Vec<crate::icons::DeferredIcon> {
    let disc_keys: Vec<(String, u64)> = entries
        .iter()
        .filter_map(|e| {
            crate::db::launchpad::discussion_state_key(&e.discussion_repo, e.discussion_number)
        })
        .collect();
    let disc_states = db
        .get_launchpad_discussion_states_batch(&disc_keys)
        .unwrap_or_default();

    for entry in entries.iter_mut() {
        entry.viewer_has_upvoted = false;
        let Some(st) = crate::db::launchpad::discussion_state_key(
            &entry.discussion_repo,
            entry.discussion_number,
        )
        .and_then(|key| disc_states.get(&key)) else {
            continue;
        };
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

    for entry in entries.iter_mut() {
        catalog.stamp_summary(&mut entry.summary);
        let core = &mut entry.summary.core;
        let is_github = core.forge.as_deref().unwrap_or("github") == "github";
        entry.viewer_has_starred =
            logged_in && is_github && db.is_starred(&core.owner, &core.repo).unwrap_or(false);
        if entry.viewer_has_starred && core.stars == 0 {
            core.stars = 1;
        }
    }
    crate::repositories::card_hydrator::plan_blank_icons(
        db,
        entries.iter().map(|e| &e.summary.core),
    )
}

/// 叠加确认图标后仍缺图标的 GitHub 条目（交由后台补图）。
fn missing_icon_coords(entries: &[LaunchpadEntry]) -> Vec<crate::icons::RepoCoord> {
    entries
        .iter()
        .map(|e| &e.summary.core)
        .filter(|c| c.icon.trim().is_empty() && c.forge.as_deref().unwrap_or("github") == "github")
        .map(|c| crate::icons::RepoCoord {
            id: c.id.clone(),
            owner: c.owner.clone(),
            repo: c.repo.clone(),
        })
        .collect()
}

/// 同步水合（图标磁盘阶段就地执行，测试入口）：返回仍缺图标的 GitHub 项。
#[cfg(test)]
pub(crate) fn hydrate_entries(
    db: &Database,
    catalog: &crate::github::CatalogService,
    entries: &mut [LaunchpadEntry],
    logged_in: bool,
    manifest_generated_secs: i64,
) -> Vec<crate::icons::RepoCoord> {
    let jobs = hydrate_entries_deferred(db, catalog, entries, logged_in, manifest_generated_secs);
    crate::repositories::card_hydrator::overlay_planned_icons_inline(
        db,
        &jobs,
        entries.iter_mut().map(|e| &mut e.summary.core),
    );
    missing_icon_coords(entries)
}

/// 读取广场：装载清单、置顶分流、本地水合并在锁外叠加确认图标。
pub(crate) async fn load_feed(
    state: &AppState,
    force_refresh: bool,
) -> Result<LaunchpadFeed, String> {
    let cfg = &crate::config::get_project_config().launchpad;
    let url = cfg.default_source_url.trim().to_string();
    // 仅当启用了非 direct 加速镜像时，首跳可重试失败才经镜像回退一次。
    let mirror_prefix = state
        .mirror
        .lock()
        .ok()
        .and_then(|m| m.active_mirror_prefix());
    let load = load_launchpad_manifest(
        &state.db,
        &crate::forge::http::manifest_client(),
        &url,
        mirror_prefix.as_deref(),
        force_refresh,
    )
    .await?;

    let manifest_ts = load
        .manifest
        .generated_at
        .as_deref()
        .and_then(parse_rfc3339_secs)
        .unwrap_or(0);
    let (mut spotlight, mut items) =
        partition_spotlight_and_recent(&load.manifest, crate::now_secs());
    let logged_in = state.active_github_token().is_some();
    let jobs: Vec<_> = {
        let db = state.db()?;
        let mut jobs =
            hydrate_entries_deferred(&db, &state.catalog, &mut spotlight, logged_in, manifest_ts);
        jobs.extend(hydrate_entries_deferred(
            &db,
            &state.catalog,
            &mut items,
            logged_in,
            manifest_ts,
        ));
        jobs
    };
    crate::repositories::card_hydrator::overlay_planned_icons(
        state,
        jobs,
        spotlight
            .iter_mut()
            .chain(items.iter_mut())
            .map(|e| &mut e.summary.core),
    )
    .await;
    let mut missing_icons = missing_icon_coords(&spotlight);
    missing_icons.extend(missing_icon_coords(&items));

    let discussions_repo = load
        .manifest
        .discussions_repo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.discussions_repo.as_str())
        .to_string();
    Ok(LaunchpadFeed {
        response: LaunchpadFeedResponse {
            spotlight,
            items,
            discussions_repo,
            submit_issue_url: cfg.submit_issue_url.clone(),
            submit_web_url: cfg.submit_web_url.clone(),
            generated_at: load.manifest.generated_at.clone(),
            cached_at: load.cached_at,
            is_stale: load.is_stale,
        },
        missing_icons,
    })
}
