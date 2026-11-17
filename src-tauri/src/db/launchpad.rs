use super::{clean, now_secs, Database};
use rusqlite::{params, OptionalExtension, Result};
use std::collections::HashMap;

/// 开源广场清单快照单条至多 512 KiB，超限拒绝落盘。
pub const LAUNCHPAD_FEED_CACHE_MAX_BYTES: usize = 512 * 1024;
/// 快照最多保留的行数（默认源 + 少量自定义源）。
pub const LAUNCHPAD_FEED_CACHE_MAX_ROWS: usize = 3;
/// 讨论与脉冲状态缓存最多保留的行数（按 `synced_at DESC` 裁剪）。
pub const LAUNCHPAD_DISCUSSION_CACHE_MAX_ROWS: usize = 500;
/// 快照离线保留期：14 天。
pub const LAUNCHPAD_SNAPSHOT_RETENTION_SECS: i64 = 14 * 86400;

/// 单条广场讨论与源仓脉冲持久化状态（与 `catalog_apps` / `custom_apps` 物理隔离）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchpadDiscussionState {
    pub discussion_repo: String,
    pub discussion_number: u64,
    pub node_id: String,
    pub upvote_count: u64,
    pub comments_count: u64,
    pub viewer_has_upvoted: Option<bool>,
    pub stars: Option<u64>,
    pub forks: Option<u64>,
    pub latest_version: Option<String>,
    pub synced_at: i64,
    pub repo_synced_at: i64,
}

/// 讨论与脉冲写入载荷（支持局部或全量刷新）。
#[derive(Debug, Clone)]
pub struct LaunchpadDiscussionUpsert {
    pub discussion_repo: String,
    pub discussion_number: u64,
    pub node_id: Option<String>,
    pub upvote_count: u64,
    /// `true` 表示来自 GraphQL 或显式 `upvote_count` 字段的权威计数；
    /// `false` 表示匿名 REST `+1` Reaction 兜底或未取回讨论字段（只作下界，不将原生顶帖冲零）。
    pub authoritative_upvotes: bool,
    /// `Some(n)` 写入最新评论总数；`None` 保留库内或静态清单原值（局部失败不冲零）。
    pub comments_count: Option<u64>,
    /// `Some(b)` 写入本人顶帖态；`None` 保留库内原值（匿名刷新不抹除或伪造）。
    pub viewer_has_upvoted: Option<bool>,
    pub stars: Option<u64>,
    pub forks: Option<u64>,
    pub latest_version: Option<String>,
    pub synced_at: i64,
}

#[derive(Debug, Clone, Default)]
struct ManifestDiscussionBaseline {
    node_id: String,
    upvotes: u64,
    comments: u64,
}

fn resolve_node_id(
    incoming: Option<&str>,
    prev: Option<&LaunchpadDiscussionState>,
    baseline: Option<&ManifestDiscussionBaseline>,
) -> String {
    incoming
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| prev.map(|p| p.node_id.clone()).filter(|s| !s.is_empty()))
        .or_else(|| baseline.map(|b| b.node_id.clone()))
        .unwrap_or_default()
}

fn clean_version(v: Option<&str>) -> Option<String> {
    v.map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("latest"))
        .map(str::to_string)
}

fn norm_discussion_key(repo: &str, number: u64) -> Option<(String, i64)> {
    if number == 0 || number > i64::MAX as u64 {
        return None;
    }
    let key = clean(repo).to_ascii_lowercase();
    let mut parts = key.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some((key, number as i64))
}

fn row_to_discussion_state(row: &rusqlite::Row<'_>) -> Result<LaunchpadDiscussionState> {
    let number: i64 = row.get(1)?;
    let upvotes: i64 = row.get(3)?;
    let comments: i64 = row.get(4)?;
    let upvoted_raw: Option<i64> = row.get(5)?;
    let stars_raw: Option<i64> = row.get(6)?;
    let forks_raw: Option<i64> = row.get(7)?;
    let latest_version: Option<String> = row.get(8)?;
    Ok(LaunchpadDiscussionState {
        discussion_repo: row.get(0)?,
        discussion_number: number.max(0) as u64,
        node_id: row.get(2)?,
        upvote_count: upvotes.max(0) as u64,
        comments_count: comments.max(0) as u64,
        viewer_has_upvoted: upvoted_raw.map(|v| v != 0),
        stars: stars_raw.map(|v| v.max(0) as u64),
        forks: forks_raw.map(|v| v.max(0) as u64),
        latest_version: latest_version.filter(|v| !v.trim().is_empty()),
        synced_at: row.get(9)?,
        repo_synced_at: row.get(10)?,
    })
}

impl Database {
    /// 读取某清单源的最近快照，返回 `(payload_json, cached_at)`。
    pub fn get_launchpad_feed_cache(&self, source_url: &str) -> Result<Option<(String, i64)>> {
        let key = clean(source_url);
        if key.is_empty() {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT payload_json, cached_at FROM launchpad_feed_cache WHERE source_url = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some((row.get(0)?, row.get(1)?)))
        } else {
            Ok(None)
        }
    }

    /// 写入（覆盖）某清单源快照；载荷超过 `LAUNCHPAD_FEED_CACHE_MAX_BYTES` 时拒绝。
    pub fn save_launchpad_feed_cache(&self, source_url: &str, payload_json: &str) -> Result<()> {
        let key = clean(source_url);
        if key.is_empty() || payload_json.is_empty() {
            return Ok(());
        }
        if payload_json.len() > LAUNCHPAD_FEED_CACHE_MAX_BYTES {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "launchpad_feed_payload_too_large",
                ),
            )));
        }
        self.exec_write(
            r#"
            INSERT INTO launchpad_feed_cache (source_url, payload_json, payload_bytes, cached_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(source_url) DO UPDATE SET
                payload_json = excluded.payload_json,
                payload_bytes = excluded.payload_bytes,
                cached_at = excluded.cached_at
            "#,
            params![key, payload_json, payload_json.len() as i64, now_secs()],
        )?;
        Ok(())
    }

    /// 刷新快照时间戳（304 命中时调用，延长离线窗口而不重写载荷）。
    pub fn touch_launchpad_feed_cache(&self, source_url: &str) -> Result<()> {
        let key = clean(source_url);
        if key.is_empty() {
            return Ok(());
        }
        self.exec_write(
            "UPDATE launchpad_feed_cache SET cached_at = ?2 WHERE source_url = ?1",
            params![key, now_secs()],
        )?;
        Ok(())
    }

    /// 读取单条讨论脉冲缓存。
    pub fn get_launchpad_discussion_state(
        &self,
        discussion_repo: &str,
        discussion_number: u64,
    ) -> Result<Option<LaunchpadDiscussionState>> {
        let Some((repo_key, num)) = norm_discussion_key(discussion_repo, discussion_number) else {
            return Ok(None);
        };
        self.conn
            .query_row(
                r#"
                SELECT discussion_repo, discussion_number, node_id, upvote_count, comments_count,
                       viewer_has_upvoted, stars, forks, latest_version, synced_at, repo_synced_at
                FROM launchpad_discussion_cache
                WHERE discussion_repo = ?1 AND discussion_number = ?2
                LIMIT 1
                "#,
                params![repo_key, num],
                row_to_discussion_state,
            )
            .optional()
    }

    /// 批量读取讨论脉冲缓存，键为 `(小写 discussion_repo, discussion_number)`。
    pub fn get_launchpad_discussion_states_batch(
        &self,
        keys: &[(String, u64)],
    ) -> Result<HashMap<(String, u64), LaunchpadDiscussionState>> {
        let normalized: Vec<(String, i64)> = keys
            .iter()
            .filter_map(|(r, n)| norm_discussion_key(r, *n))
            .collect();
        if normalized.is_empty() {
            return Ok(HashMap::new());
        }
        let mut repos: Vec<&str> = normalized.iter().map(|(r, _)| r.as_str()).collect();
        repos.sort_unstable();
        repos.dedup();
        let placeholders = std::iter::repeat_n("?", repos.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT discussion_repo, discussion_number, node_id, upvote_count, comments_count, \
                    viewer_has_upvoted, stars, forks, latest_version, synced_at, repo_synced_at \
             FROM launchpad_discussion_cache WHERE discussion_repo IN ({placeholders})"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(repos), row_to_discussion_state)?;
        let wanted: std::collections::HashSet<(String, u64)> =
            normalized.into_iter().map(|(r, n)| (r, n as u64)).collect();
        let mut out = HashMap::with_capacity(wanted.len());
        for row in rows {
            let st = row?;
            let key = (st.discussion_repo.clone(), st.discussion_number);
            if wanted.contains(&key) {
                out.insert(key, st);
            }
        }
        Ok(out)
    }

    /// 从本地 `launchpad_feed_cache` 查找某讨论对应的静态基线（用于首次局部写时不从 0 起跳）。
    fn manifest_baseline_for_discussion(
        &self,
        repo_key: &str,
        number: u64,
    ) -> Option<ManifestDiscussionBaseline> {
        let payloads: Vec<String> = self
            .query_vec(
                "SELECT payload_json FROM launchpad_feed_cache ORDER BY cached_at DESC LIMIT ?1",
                params![LAUNCHPAD_FEED_CACHE_MAX_ROWS as i64],
                |row| row.get(0),
            )
            .ok()?;
        for raw in payloads {
            let Ok(manifest) = crate::launchpad::parse_manifest(&raw) else {
                continue;
            };
            for item in manifest.items {
                if item.discussion_number == number
                    && item.discussion_repo.trim().eq_ignore_ascii_case(repo_key)
                {
                    return Some(ManifestDiscussionBaseline {
                        node_id: item
                            .discussion_node_id
                            .unwrap_or_default()
                            .trim()
                            .to_string(),
                        upvotes: item.discussion_upvotes,
                        comments: item.discussion_comments_count,
                    });
                }
            }
        }
        None
    }

    fn prev_and_baseline(
        &self,
        repo_key: &str,
        number: u64,
        need_baseline: bool,
    ) -> Result<(
        Option<LaunchpadDiscussionState>,
        Option<ManifestDiscussionBaseline>,
    )> {
        let prev = self.get_launchpad_discussion_state(repo_key, number)?;
        let baseline = if prev.is_none() && need_baseline {
            self.manifest_baseline_for_discussion(repo_key, number)
        } else {
            None
        };
        Ok((prev, baseline))
    }

    /// 合并写入单条讨论与源仓脉冲状态。
    pub fn upsert_launchpad_discussion_state(&self, inc: &LaunchpadDiscussionUpsert) -> Result<()> {
        let Some((repo_key, num)) =
            norm_discussion_key(&inc.discussion_repo, inc.discussion_number)
        else {
            return Ok(());
        };
        let (prev, baseline) = self.prev_and_baseline(
            &repo_key,
            inc.discussion_number,
            !inc.authoritative_upvotes || inc.comments_count.is_none(),
        )?;
        let prev_ref = prev.as_ref();
        let base_ref = baseline.as_ref();
        let upvote_count = if inc.authoritative_upvotes {
            inc.upvote_count
        } else {
            let floor = prev_ref
                .map(|p| p.upvote_count)
                .or_else(|| base_ref.map(|b| b.upvotes))
                .unwrap_or(0);
            floor.max(inc.upvote_count)
        };
        let comments_count = inc
            .comments_count
            .or_else(|| prev_ref.map(|p| p.comments_count))
            .or_else(|| base_ref.map(|b| b.comments))
            .unwrap_or(0);
        let has_disc_update = inc.authoritative_upvotes || inc.comments_count.is_some();
        let has_repo_stats =
            inc.stars.is_some() || inc.forks.is_some() || inc.latest_version.is_some();
        let synced_at = if has_disc_update {
            inc.synced_at
        } else {
            prev_ref.map(|p| p.synced_at).unwrap_or(0)
        };
        let repo_synced_at = if has_repo_stats {
            inc.synced_at
        } else {
            prev_ref.map(|p| p.repo_synced_at).unwrap_or(0)
        };
        let st = LaunchpadDiscussionState {
            discussion_repo: repo_key,
            discussion_number: num as u64,
            node_id: resolve_node_id(inc.node_id.as_deref(), prev_ref, base_ref),
            upvote_count,
            comments_count,
            viewer_has_upvoted: inc
                .viewer_has_upvoted
                .or_else(|| prev_ref.and_then(|p| p.viewer_has_upvoted)),
            stars: inc.stars.or_else(|| prev_ref.and_then(|p| p.stars)),
            forks: inc.forks.or_else(|| prev_ref.and_then(|p| p.forks)),
            latest_version: clean_version(inc.latest_version.as_deref())
                .or_else(|| prev_ref.and_then(|p| p.latest_version.clone())),
            synced_at,
            repo_synced_at,
        };
        self.write_discussion_state(&st)
    }

    /// 顶帖变更即时落盘（保留库内或静态清单已有的评论数与源仓统计）。
    pub fn record_launchpad_upvote(
        &self,
        discussion_repo: &str,
        discussion_number: u64,
        node_id: &str,
        upvote_count: u64,
        viewer_has_upvoted: bool,
        now: i64,
    ) -> Result<()> {
        let Some((repo_key, num)) = norm_discussion_key(discussion_repo, discussion_number) else {
            return Ok(());
        };
        let (prev, baseline) = self.prev_and_baseline(&repo_key, discussion_number, true)?;
        let prev_ref = prev.as_ref();
        let base_ref = baseline.as_ref();
        let st = LaunchpadDiscussionState {
            discussion_repo: repo_key,
            discussion_number: num as u64,
            node_id: resolve_node_id(Some(node_id), prev_ref, base_ref),
            upvote_count,
            comments_count: prev_ref
                .map(|p| p.comments_count)
                .or_else(|| base_ref.map(|b| b.comments))
                .unwrap_or(0),
            viewer_has_upvoted: Some(viewer_has_upvoted),
            stars: prev_ref.and_then(|p| p.stars),
            forks: prev_ref.and_then(|p| p.forks),
            latest_version: prev_ref.and_then(|p| p.latest_version.clone()),
            synced_at: now,
            repo_synced_at: prev_ref.map(|p| p.repo_synced_at).unwrap_or(0),
        };
        self.write_discussion_state(&st)
    }

    /// 发表评论/回复成功后评论数 `+1` 即时落盘（保留库内或静态清单已有的顶帖态与计数）。
    pub fn record_launchpad_comment_added(
        &self,
        discussion_repo: &str,
        discussion_number: u64,
        node_id: Option<&str>,
        now: i64,
    ) -> Result<()> {
        let Some((repo_key, num)) = norm_discussion_key(discussion_repo, discussion_number) else {
            return Ok(());
        };
        let (prev, baseline) = self.prev_and_baseline(&repo_key, discussion_number, true)?;
        let prev_ref = prev.as_ref();
        let base_ref = baseline.as_ref();
        let st = LaunchpadDiscussionState {
            discussion_repo: repo_key,
            discussion_number: num as u64,
            node_id: resolve_node_id(node_id, prev_ref, base_ref),
            upvote_count: prev_ref
                .map(|p| p.upvote_count)
                .or_else(|| base_ref.map(|b| b.upvotes))
                .unwrap_or(0),
            comments_count: prev_ref
                .map(|p| p.comments_count)
                .or_else(|| base_ref.map(|b| b.comments))
                .unwrap_or(0)
                .saturating_add(1),
            viewer_has_upvoted: prev_ref.and_then(|p| p.viewer_has_upvoted),
            stars: prev_ref.and_then(|p| p.stars),
            forks: prev_ref.and_then(|p| p.forks),
            latest_version: prev_ref.and_then(|p| p.latest_version.clone()),
            synced_at: now,
            repo_synced_at: prev_ref.map(|p| p.repo_synced_at).unwrap_or(0),
        };
        self.write_discussion_state(&st)
    }

    /// Star / 取消 Star 时同步微调广场绑定讨论行的缓存星数，保证断网重启也不回退。
    pub fn adjust_launchpad_repo_stars(&self, owner: &str, repo: &str, delta: i64) -> Result<()> {
        if delta == 0 {
            return Ok(());
        }
        let target_id = format!(
            "{}/{}",
            clean(owner).to_ascii_lowercase(),
            clean(repo).to_ascii_lowercase()
        );
        let payloads: Vec<String> = self.query_vec(
            "SELECT payload_json FROM launchpad_feed_cache ORDER BY cached_at DESC LIMIT ?1",
            params![LAUNCHPAD_FEED_CACHE_MAX_ROWS as i64],
            |row| row.get(0),
        )?;
        let now = now_secs();
        for raw in payloads {
            let Ok(manifest) = crate::launchpad::parse_manifest(&raw) else {
                continue;
            };
            for item in manifest.items {
                let forge = item.forge.trim();
                let is_gh = forge.is_empty() || forge.eq_ignore_ascii_case("github");
                if !is_gh || item.discussion_number == 0 {
                    continue;
                }
                let item_id = crate::launchpad::canonical_id(&item.id).unwrap_or_default();
                if item_id != target_id {
                    continue;
                }
                let Some((repo_key, num)) =
                    norm_discussion_key(&item.discussion_repo, item.discussion_number)
                else {
                    continue;
                };
                let prev =
                    self.get_launchpad_discussion_state(&repo_key, item.discussion_number)?;
                let prev_ref = prev.as_ref();
                let base_stars = prev_ref.and_then(|p| p.stars).unwrap_or(item.stars);
                let next_stars = (base_stars as i128 + delta as i128).max(0) as u64;
                let st = LaunchpadDiscussionState {
                    discussion_repo: repo_key,
                    discussion_number: num as u64,
                    node_id: prev_ref
                        .map(|p| p.node_id.clone())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| item.discussion_node_id.unwrap_or_default()),
                    upvote_count: prev_ref
                        .map(|p| p.upvote_count)
                        .unwrap_or(item.discussion_upvotes),
                    comments_count: prev_ref
                        .map(|p| p.comments_count)
                        .unwrap_or(item.discussion_comments_count),
                    viewer_has_upvoted: prev_ref.and_then(|p| p.viewer_has_upvoted),
                    stars: Some(next_stars),
                    forks: prev_ref.and_then(|p| p.forks).or(Some(item.forks)),
                    latest_version: prev_ref
                        .and_then(|p| p.latest_version.clone())
                        .or_else(|| clean_version(Some(&item.latest_version))),
                    synced_at: prev_ref.map(|p| p.synced_at).unwrap_or(0),
                    repo_synced_at: now,
                };
                self.write_discussion_state(&st)?;
                return Ok(());
            }
        }
        Ok(())
    }

    /// 登出时清除本人顶帖态，保留公开讨论与星数计数。
    pub fn clear_launchpad_viewer_upvotes(&self) -> Result<()> {
        self.exec_write(
            "UPDATE launchpad_discussion_cache SET viewer_has_upvoted = NULL WHERE viewer_has_upvoted IS NOT NULL",
            [],
        )?;
        Ok(())
    }

    fn write_discussion_state(&self, st: &LaunchpadDiscussionState) -> Result<()> {
        self.exec_write(
            r#"
            INSERT INTO launchpad_discussion_cache (
                discussion_repo, discussion_number, node_id, upvote_count, comments_count,
                viewer_has_upvoted, stars, forks, latest_version, synced_at, repo_synced_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(discussion_repo, discussion_number) DO UPDATE SET
                node_id = excluded.node_id,
                upvote_count = excluded.upvote_count,
                comments_count = excluded.comments_count,
                viewer_has_upvoted = excluded.viewer_has_upvoted,
                stars = excluded.stars,
                forks = excluded.forks,
                latest_version = excluded.latest_version,
                synced_at = excluded.synced_at,
                repo_synced_at = excluded.repo_synced_at
            "#,
            params![
                st.discussion_repo,
                st.discussion_number as i64,
                st.node_id,
                st.upvote_count as i64,
                st.comments_count as i64,
                st.viewer_has_upvoted.map(i64::from),
                st.stars.map(|v| v as i64),
                st.forks.map(|v| v as i64),
                st.latest_version.as_deref(),
                st.synced_at,
                st.repo_synced_at,
            ],
        )?;
        Ok(())
    }

    /// 清扫超过 14 天离线窗口的快照与讨论脉冲行，并限制容量上限。
    pub fn prune_launchpad_feed_cache(&self, now: i64) -> Result<usize> {
        let cutoff = now.saturating_sub(LAUNCHPAD_SNAPSHOT_RETENTION_SECS);
        let expired = self.conn.execute(
            "DELETE FROM launchpad_feed_cache WHERE cached_at <= ?1",
            params![cutoff],
        )?;
        let overflow = self.conn.execute(
            r#"
            DELETE FROM launchpad_feed_cache
            WHERE source_url NOT IN (
                SELECT source_url FROM launchpad_feed_cache
                ORDER BY cached_at DESC, source_url ASC
                LIMIT ?1
            )
            "#,
            params![LAUNCHPAD_FEED_CACHE_MAX_ROWS as i64],
        )?;
        let disc_expired = self.conn.execute(
            "DELETE FROM launchpad_discussion_cache WHERE MAX(synced_at, repo_synced_at) <= ?1",
            params![cutoff],
        )?;
        let disc_overflow = self.conn.execute(
            r#"
            DELETE FROM launchpad_discussion_cache
            WHERE rowid NOT IN (
                SELECT rowid FROM launchpad_discussion_cache
                ORDER BY MAX(synced_at, repo_synced_at) DESC, discussion_repo ASC, discussion_number ASC
                LIMIT ?1
            )
            "#,
            params![LAUNCHPAD_DISCUSSION_CACHE_MAX_ROWS as i64],
        )?;
        Ok(expired + overflow + disc_expired + disc_overflow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_get_roundtrip_and_oversize_rejected() {
        let db = Database::open_in_memory().unwrap();
        db.save_launchpad_feed_cache("https://x/launchpad.json", "{\"version\":1}")
            .unwrap();
        let (payload, _) = db
            .get_launchpad_feed_cache("https://x/launchpad.json")
            .unwrap()
            .unwrap();
        assert_eq!(payload, "{\"version\":1}");

        let huge = "x".repeat(LAUNCHPAD_FEED_CACHE_MAX_BYTES + 1);
        assert!(db.save_launchpad_feed_cache("https://y", &huge).is_err());
        assert!(db.get_launchpad_feed_cache("https://y").unwrap().is_none());
    }

    #[test]
    fn prune_drops_expired_and_overflow_rows() {
        let db = Database::open_in_memory().unwrap();
        for (i, url) in ["a", "b", "c", "d"].iter().enumerate() {
            db.conn
                .execute(
                    "INSERT INTO launchpad_feed_cache (source_url, payload_json, payload_bytes, cached_at) VALUES (?1, '{}', 2, ?2)",
                    params![url, 1_000_000 + i as i64],
                )
                .unwrap();
        }
        db.conn
            .execute(
                "INSERT INTO launchpad_feed_cache (source_url, payload_json, payload_bytes, cached_at) VALUES ('old', '{}', 2, 1)",
                [],
            )
            .unwrap();
        let removed = db.prune_launchpad_feed_cache(1_000_010).unwrap();
        assert_eq!(removed, 2);
        assert!(db.get_launchpad_feed_cache("old").unwrap().is_none());
        assert!(db.get_launchpad_feed_cache("a").unwrap().is_none());
        assert!(db.get_launchpad_feed_cache("d").unwrap().is_some());
    }

    #[test]
    fn discussion_state_persists_partial_mutations_and_clears_viewer_flag_on_logout() {
        let db = Database::open_in_memory().unwrap();
        db.save_launchpad_feed_cache(
            "https://x/launchpad.json",
            r#"{"version":1,"items":[{"id":"acme/hyper","owner":"acme","repo":"hyper","forge":"github",
                "discussion_repo":"superMC5657/z-store-launchpad","discussion_number":3,
                "discussion_node_id":"D_3","discussion_comments_count":2,"discussion_upvotes":4,"stars":10}]}"#,
        )
        .unwrap();

        // 首次局部顶帖：从静态快照继承已有评论数 2
        db.record_launchpad_upvote("superMC5657/z-store-launchpad", 3, "", 5, true, 200)
            .unwrap();
        let st = db
            .get_launchpad_discussion_state("supermc5657/z-store-launchpad", 3)
            .unwrap()
            .unwrap();
        assert_eq!(
            (st.upvote_count, st.comments_count, st.viewer_has_upvoted),
            (5, 2, Some(true))
        );
        assert_eq!(st.node_id, "D_3");

        // 发表评论：保留顶帖计数 5 与本人已顶态，评论数 +1 → 3
        db.record_launchpad_comment_added("superMC5657/z-store-launchpad", 3, None, 210)
            .unwrap();
        // 匿名非权威刷新（REST +1=0）不冲零已落盘的原生顶帖 5，也不虚增 repo_synced_at
        db.upsert_launchpad_discussion_state(&LaunchpadDiscussionUpsert {
            discussion_repo: "superMC5657/z-store-launchpad".to_string(),
            discussion_number: 3,
            node_id: None,
            upvote_count: 0,
            authoritative_upvotes: false,
            comments_count: Some(4),
            viewer_has_upvoted: None,
            stars: None,
            forks: None,
            latest_version: None,
            synced_at: 220,
        })
        .unwrap();
        let st = db
            .get_launchpad_discussion_state("supermc5657/z-store-launchpad", 3)
            .unwrap()
            .unwrap();
        assert_eq!(
            (st.upvote_count, st.comments_count, st.viewer_has_upvoted),
            (5, 4, Some(true))
        );
        assert_eq!(st.repo_synced_at, 0);

        // 局部仓库统计更新但 discussion 字段缺失（comments_count: None）时，保留已有评论数 4 与顶帖 5
        db.upsert_launchpad_discussion_state(&LaunchpadDiscussionUpsert {
            discussion_repo: "superMC5657/z-store-launchpad".to_string(),
            discussion_number: 3,
            node_id: None,
            upvote_count: 0,
            authoritative_upvotes: false,
            comments_count: None,
            viewer_has_upvoted: None,
            stars: Some(25),
            forks: Some(3),
            latest_version: Some("v0.5.0".to_string()),
            synced_at: 230,
        })
        .unwrap();
        let st = db
            .get_launchpad_discussion_state("supermc5657/z-store-launchpad", 3)
            .unwrap()
            .unwrap();
        assert_eq!((st.upvote_count, st.comments_count), (5, 4));
        assert_eq!(
            (st.stars, st.forks, st.latest_version.as_deref()),
            (Some(25), Some(3), Some("v0.5.0"))
        );
        assert_eq!(st.synced_at, 220);
        assert_eq!(st.repo_synced_at, 230);

        // Star 微调 + 登出只清本人态
        db.adjust_launchpad_repo_stars("acme", "hyper", 1).unwrap();
        db.clear_launchpad_viewer_upvotes().unwrap();
        let st = db
            .get_launchpad_discussion_state("supermc5657/z-store-launchpad", 3)
            .unwrap()
            .unwrap();
        assert_eq!(st.stars, Some(26));
        assert_eq!(st.upvote_count, 5);
        assert_eq!(st.comments_count, 4);
        assert_eq!(st.viewer_has_upvoted, None);
    }
}
