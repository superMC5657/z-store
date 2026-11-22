//! 广场讨论脉冲同步：已登录 GraphQL 批量查询，未登录匿名 REST 有界并发；结果落盘后批量回读。

use super::feed::{snapshot_manifest, with_db};
use super::{canonical_id, LaunchpadPulseItem, RawLaunchpadItem};
use crate::db::launchpad::discussion_state_key;
use crate::db::{Database, LaunchpadDiscussionUpsert, RepoCardUpsert};
use crate::github::discussions::{self as gd, PulseFetched, PulseTarget};
use std::collections::HashMap;
use std::sync::Mutex;

fn pulse_targets(
    items: Vec<RawLaunchpadItem>,
) -> (Vec<PulseTarget>, HashMap<String, RawLaunchpadItem>) {
    let mut targets = Vec::with_capacity(items.len());
    let mut raw_by_id = HashMap::with_capacity(items.len());
    for item in items {
        let Some(id) = canonical_id(&item.id) else {
            continue;
        };
        let forge = item.forge.trim();
        targets.push(PulseTarget {
            id: id.clone(),
            owner: item.owner.trim().to_string(),
            repo: item.repo.trim().to_string(),
            is_github: forge.is_empty() || forge.eq_ignore_ascii_case("github"),
            discussion_repo: item.discussion_repo.trim().to_string(),
            discussion_number: item.discussion_number,
        });
        raw_by_id.insert(id, item);
    }
    (targets, raw_by_id)
}

/// 单事务写入脉冲表、Star 状态与未收录富卡（源仓星数/版本变化时）。
fn persist_pulse(
    db: &Database,
    catalog: &crate::github::CatalogService,
    fetched: &[PulseFetched],
    raw_by_id: &HashMap<String, RawLaunchpadItem>,
    logged_in: bool,
    now: i64,
) {
    let mut card_upserts: Vec<RepoCardUpsert> = Vec::new();
    let tx = db.with_immediate_transaction(|| {
        for f in fetched {
            let has_state = f.comments_count.is_some()
                || f.authoritative_upvotes
                || f.stars.is_some()
                || f.forks.is_some()
                || f.latest_version.is_some();
            if f.target.discussion_number > 0 && !f.target.discussion_repo.is_empty() && has_state {
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
            let repo_changed = f.stars.is_some() || f.forks.is_some() || f.latest_version.is_some();
            if repo_changed && !catalog.is_cataloged(&f.target.id) {
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
                    card_upserts.push(RepoCardUpsert {
                        summary,
                        confirmed_other: false,
                        is_private: Some(false),
                    });
                }
            }
        }
        Ok(())
    });
    if let Err(e) = tx {
        log::warn!(target: "launchpad", "discussion pulse db tx failed: {}", e);
    }
    if !card_upserts.is_empty() {
        if let Err(e) = db.upsert_repo_cards_batch(&card_upserts) {
            log::warn!(target: "launchpad", "repo_card_cache pulse upsert failed: {}", e);
        }
    }
}

/// 以落盘后的合并状态（一次批量查询）投影脉冲项；库内缺席时退回本轮取回值。
fn project_pulse(
    db: &Database,
    fetched: Vec<PulseFetched>,
    logged_in: bool,
) -> Vec<LaunchpadPulseItem> {
    let keys: Vec<(String, u64)> = fetched
        .iter()
        .filter_map(|f| discussion_state_key(&f.target.discussion_repo, f.target.discussion_number))
        .collect();
    let stored_states = db
        .get_launchpad_discussion_states_batch(&keys)
        .unwrap_or_default();
    fetched
        .into_iter()
        .map(|f| {
            let stored =
                discussion_state_key(&f.target.discussion_repo, f.target.discussion_number)
                    .and_then(|k| stored_states.get(&k));
            let viewer_has_upvoted = if logged_in {
                stored
                    .and_then(|s| s.viewer_has_upvoted)
                    .or(f.viewer_has_upvoted)
            } else {
                Some(false)
            };
            LaunchpadPulseItem {
                discussion_node_id: stored
                    .map(|s| s.node_id.clone())
                    .filter(|s| !s.is_empty())
                    .or(f.node_id),
                discussion_upvotes: stored
                    .map(|s| s.upvote_count)
                    .or_else(|| f.authoritative_upvotes.then_some(f.upvote_count)),
                discussion_comments_count: stored.map(|s| s.comments_count).or(f.comments_count),
                viewer_has_upvoted,
                viewer_has_starred: logged_in.then_some(f.viewer_has_starred).flatten(),
                id: f.target.id,
                discussion_repo: f.target.discussion_repo,
                discussion_number: f.target.discussion_number,
                stars: f.stars,
                forks: f.forks,
                latest_version: f.latest_version,
            }
        })
        .collect()
}

/// 依据本地清单快照，从 GitHub Discussions（及同批 GitHub 源仓库）拉取广场卡片实时数据并落盘。
pub(crate) async fn sync_discussions(
    db: &Mutex<Database>,
    catalog: &crate::github::CatalogService,
    client: &reqwest::Client,
    api_base: &str,
    source_url: &str,
    token: Option<&str>,
    force_refresh: bool,
) -> Result<Vec<LaunchpadPulseItem>, String> {
    let (manifest, existing_states) = with_db(db, |db| {
        let manifest = snapshot_manifest(db, source_url);
        let states = manifest
            .as_ref()
            .map(|m| {
                let keys: Vec<(String, u64)> = m
                    .items
                    .iter()
                    .filter_map(|it| {
                        discussion_state_key(&it.discussion_repo, it.discussion_number)
                    })
                    .collect();
                db.get_launchpad_discussion_states_batch(&keys)
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        (manifest, states)
    })?;
    let Some(manifest) = manifest else {
        return Ok(Vec::new());
    };
    let (targets, raw_by_id) = pulse_targets(manifest.items);
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
        persist_pulse(db, catalog, &fetched, &raw_by_id, logged_in, now);
        project_pulse(db, fetched, logged_in)
    })
}
