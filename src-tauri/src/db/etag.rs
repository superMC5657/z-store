//! `api_etag_cache` 持久化 DAO：HTTP 304 条件请求缓存与 LRU 淘汰。

use super::{dedup_non_empty, Database};
use rusqlite::{params, Result};
use std::collections::HashMap;

/// API ETag 缓存表最大保留行数（按 `last_checked_at DESC` LRU 淘汰）。
pub const API_ETAG_CACHE_MAX_ROWS: usize = 3000;

/// 单条 `api_etag_cache` 完整记录（供软 TTL 判断与条件请求复用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EtagCacheEntry {
    pub etag: String,
    pub payload_json: String,
    pub last_checked_at: i64,
}

impl Database {
    pub fn get_etag(&self, endpoint_url: &str) -> Result<Option<String>> {
        self.query_scalar_opt(
            "SELECT etag FROM api_etag_cache WHERE endpoint_url = ?1",
            params![endpoint_url],
        )
    }

    pub fn get_cached_payload(&self, endpoint_url: &str) -> Result<Option<String>> {
        self.query_scalar_opt(
            "SELECT payload_json FROM api_etag_cache WHERE endpoint_url = ?1",
            params![endpoint_url],
        )
    }

    /// 单次读取端点的 `(etag, payload_json)`。
    pub fn get_etag_and_payload(&self, endpoint_url: &str) -> Result<Option<(String, String)>> {
        Ok(self
            .query_vec(
                "SELECT etag, payload_json FROM api_etag_cache WHERE endpoint_url = ?1",
                params![endpoint_url],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .into_iter()
            .next())
    }

    /// 端点是否存在 ETag 缓存行。
    pub fn has_etag_entry(&self, endpoint_url: &str) -> Result<bool> {
        self.record_exists(
            "SELECT 1 FROM api_etag_cache WHERE endpoint_url = ?1",
            params![endpoint_url],
        )
    }

    /// 单次读取端点的 `(etag, payload_json, last_checked_at)`。
    pub fn get_etag_entry(&self, endpoint_url: &str) -> Result<Option<EtagCacheEntry>> {
        Ok(self
            .query_vec(
                "SELECT etag, payload_json, last_checked_at FROM api_etag_cache WHERE endpoint_url = ?1",
                params![endpoint_url],
                |row| {
                    Ok(EtagCacheEntry {
                        etag: row.get(0)?,
                        payload_json: row.get(1)?,
                        last_checked_at: row.get(2)?,
                    })
                },
            )?
            .into_iter()
            .next())
    }

    /// 批量读取完整 `EtagCacheEntry`，按端点索引（`IN (...)` 分片，未命中端点缺席）。
    pub fn get_etag_entries_batch(
        &self,
        urls: &[String],
    ) -> Result<HashMap<String, EtagCacheEntry>> {
        let keys = dedup_non_empty(urls.iter().map(String::as_str));
        let rows = self.query_in_chunks(
            &keys,
            |ph| {
                format!(
                    "SELECT endpoint_url, etag, payload_json, last_checked_at FROM api_etag_cache \
                     WHERE endpoint_url IN ({ph})"
                )
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    EtagCacheEntry {
                        etag: row.get(1)?,
                        payload_json: row.get(2)?,
                        last_checked_at: row.get(3)?,
                    },
                ))
            },
        )?;
        Ok(rows.into_iter().collect())
    }

    /// 批量读取 `(etag, payload_json)`，按端点索引（`IN (...)` 分片，未命中端点缺席）。
    pub fn get_etags_and_payloads_batch(
        &self,
        urls: &[String],
    ) -> Result<HashMap<String, (String, String)>> {
        Ok(self
            .get_etag_entries_batch(urls)?
            .into_iter()
            .map(|(k, v)| (k, (v.etag, v.payload_json)))
            .collect())
    }

    pub fn save_etag(
        &self,
        endpoint_url: &str,
        etag: &str,
        payload_json: &str,
        timestamp: i64,
    ) -> Result<()> {
        self.exec_write(
            r#"
            INSERT INTO api_etag_cache (endpoint_url, etag, payload_json, last_checked_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(endpoint_url) DO UPDATE SET
                etag = excluded.etag,
                payload_json = excluded.payload_json,
                last_checked_at = excluded.last_checked_at;
            "#,
            params![endpoint_url, etag, payload_json, timestamp],
        )?;
        Ok(())
    }

    /// 跨链路播种单仓 JSON：仅当端点缺席或现有 `etag == ''` 时写入，绝不覆盖非空 HTTP ETag。
    pub fn seed_repo_payload_if_absent_or_untagged(
        &self,
        endpoint_url: &str,
        payload_json: &str,
        timestamp: i64,
    ) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO api_etag_cache (endpoint_url, etag, payload_json, last_checked_at)
            VALUES (?1, '', ?2, ?3)
            ON CONFLICT(endpoint_url) DO UPDATE SET
                payload_json = excluded.payload_json,
                last_checked_at = excluded.last_checked_at
            WHERE api_etag_cache.etag = '';
            "#,
            params![endpoint_url, payload_json, timestamp],
        )?;
        Ok(())
    }

    /// 批量播种单仓 JSON（单事务边界，供搜索/Star 列表反哺趋势 enrich 复用，绝不覆盖非空 ETag）。
    pub fn seed_repo_payloads_batch(
        &self,
        entries: &[(String, String)],
        timestamp: i64,
    ) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        self.with_immediate_transaction(|| {
            let mut stmt = self.conn.prepare_cached(
                r#"
                INSERT INTO api_etag_cache (endpoint_url, etag, payload_json, last_checked_at)
                VALUES (?1, '', ?2, ?3)
                ON CONFLICT(endpoint_url) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    last_checked_at = excluded.last_checked_at
                WHERE api_etag_cache.etag = '';
                "#,
            )?;
            for (url, payload) in entries {
                if url.is_empty() || payload.is_empty() {
                    continue;
                }
                stmt.execute(params![url, payload, timestamp])?;
            }
            Ok(())
        })
    }

    /// 刷新指定端点 ETag 缓存的 `last_checked_at`（`304 Not Modified` 命中时保鲜 LRU 顺序）。
    pub fn touch_etag(&self, endpoint_url: &str, timestamp: i64) -> Result<()> {
        self.exec_write(
            "UPDATE api_etag_cache SET last_checked_at = ?2 WHERE endpoint_url = ?1",
            params![endpoint_url, timestamp],
        )?;
        Ok(())
    }

    /// 删除指定端点的 ETag 缓存记录（如分页收缩时清理不再存在的尾页缓存）。
    pub fn delete_etag(&self, endpoint_url: &str) -> Result<()> {
        self.exec_write(
            "DELETE FROM api_etag_cache WHERE endpoint_url = ?1",
            params![endpoint_url],
        )?;
        Ok(())
    }

    /// 按端点精确前缀清理 ETag 缓存（如退出登录时清理账号专属 `/user/` 端点缓存）。
    pub fn delete_etags_by_prefix(&self, prefix: &str) -> Result<()> {
        if prefix.is_empty() {
            return Ok(());
        }
        self.exec_write(
            "DELETE FROM api_etag_cache WHERE substr(endpoint_url, 1, length(?1)) = ?1",
            params![prefix],
        )?;
        Ok(())
    }

    /// 扫描 `api_etag_cache` 中 `/repos/{owner}/{repo}` 载荷标记为私有的仓库规范 id。
    pub fn list_private_repo_etag_ids(&self) -> Result<Vec<String>> {
        let rows: Vec<(String, String)> = self.query_vec(
            "SELECT endpoint_url, payload_json FROM api_etag_cache \
             WHERE substr(LOWER(endpoint_url), 1, 29) = 'https://api.github.com/repos/' \
               AND (payload_json LIKE '%\"private\"%' OR payload_json LIKE '%\"visibility\"%')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut ids = Vec::new();
        for (url, payload) in rows {
            if crate::github::search::repo_json_is_private(&payload) != Some(true) {
                continue;
            }
            let Some(rest) = url.get(29..) else {
                continue;
            };
            let rest = rest.split('?').next().unwrap_or(rest);
            let mut parts = rest.split('/');
            let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            if !owner.is_empty() && !repo.is_empty() {
                ids.push(crate::forge::canonical_app_id_from_parts(owner, repo));
            }
        }
        Ok(ids)
    }

    /// 清理指定仓库 id 对应的 `/repos/{owner}/{repo}` 及其子路径/查询参数 ETag 缓存（大小写不敏感）。
    /// 仅匹配精确端点、`/{owner}/{repo}/...` 与 `/{owner}/{repo}?...`，不误删同名长前缀仓库。
    pub fn delete_repo_etags_for_ids(&self, ids: &[String]) -> Result<usize> {
        let mut deleted = 0usize;
        let mut seen = std::collections::HashSet::new();
        for raw_id in ids {
            let Some((owner, repo)) = raw_id.trim().split_once('/') else {
                continue;
            };
            let owner = owner.trim();
            let repo = repo.trim();
            if owner.is_empty() || repo.is_empty() || owner.contains(':') || repo.contains('/') {
                continue;
            }
            let exact = crate::github::github_repo_endpoint(owner, repo).to_lowercase();
            if !seen.insert(exact.clone()) {
                continue;
            }
            let slash_prefix = format!("{}/", exact);
            let query_prefix = format!("{}?", exact);
            deleted += self.exec_write(
                "DELETE FROM api_etag_cache \
                 WHERE LOWER(endpoint_url) = ?1 \
                    OR substr(LOWER(endpoint_url), 1, length(?2)) = ?2 \
                    OR substr(LOWER(endpoint_url), 1, length(?3)) = ?3",
                params![exact, slash_prefix, query_prefix],
            )?;
        }
        Ok(deleted)
    }

    /// 按 `last_checked_at DESC` 保留最新 `max_rows` 条 ETag 缓存，清理超限陈旧行。
    pub fn prune_api_etag_cache(&self, max_rows: usize) -> Result<usize> {
        if max_rows == 0 {
            return Ok(0);
        }
        let deleted = self.conn.execute(
            r#"
            DELETE FROM api_etag_cache
            WHERE endpoint_url NOT IN (
                SELECT endpoint_url FROM api_etag_cache
                ORDER BY last_checked_at DESC, endpoint_url ASC
                LIMIT ?1
            )
            "#,
            params![max_rows as i64],
        )?;
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_etags_and_payloads_batch_returns_stored_entries() {
        let db = Database::open_in_memory().unwrap();
        db.save_etag("https://api/x", "W/1", "{\"a\":1}", 1)
            .unwrap();
        let hits = db
            .get_etags_and_payloads_batch(&[
                "https://api/x".to_string(),
                "https://api/x".to_string(),
                "https://api/y".to_string(),
            ])
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits["https://api/x"],
            ("W/1".to_string(), "{\"a\":1}".to_string())
        );
        let entry = db.get_etag_entry("https://api/x").unwrap().unwrap();
        assert_eq!(entry.etag, "W/1");
        assert_eq!(entry.payload_json, "{\"a\":1}");
        assert_eq!(entry.last_checked_at, 1);
    }

    #[test]
    fn seed_repo_payloads_never_overwrites_non_empty_etag() {
        let db = Database::open_in_memory().unwrap();
        let tagged = "https://api.github.com/repos/a/tagged";
        let untagged = "https://api.github.com/repos/a/untagged";
        let absent = "https://api.github.com/repos/a/absent";

        db.save_etag(tagged, "W/\"e1\"", "{\"stars\":10}", 100)
            .unwrap();
        db.seed_repo_payload_if_absent_or_untagged(untagged, "{\"stars\":1}", 50)
            .unwrap();

        db.seed_repo_payloads_batch(
            &[
                (tagged.to_string(), "{\"stars\":99}".to_string()),
                (untagged.to_string(), "{\"stars\":2}".to_string()),
                (absent.to_string(), "{\"stars\":3}".to_string()),
            ],
            200,
        )
        .unwrap();

        let tagged_entry = db.get_etag_entry(tagged).unwrap().unwrap();
        assert_eq!(tagged_entry.etag, "W/\"e1\"");
        assert_eq!(tagged_entry.payload_json, "{\"stars\":10}");
        assert_eq!(tagged_entry.last_checked_at, 100);

        let untagged_entry = db.get_etag_entry(untagged).unwrap().unwrap();
        assert_eq!(untagged_entry.etag, "");
        assert_eq!(untagged_entry.payload_json, "{\"stars\":2}");
        assert_eq!(untagged_entry.last_checked_at, 200);

        let absent_entry = db.get_etag_entry(absent).unwrap().unwrap();
        assert_eq!(absent_entry.etag, "");
        assert_eq!(absent_entry.payload_json, "{\"stars\":3}");
        assert_eq!(absent_entry.last_checked_at, 200);
    }
}
