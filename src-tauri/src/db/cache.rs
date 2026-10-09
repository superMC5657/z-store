use super::{clean, now_secs, Database};
use crate::models::AppDetail;
use rusqlite::{params, Result};

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

    pub fn save_etag(
        &self,
        endpoint_url: &str,
        etag: &str,
        payload_json: &str,
        timestamp: i64,
    ) -> Result<()> {
        self.exec_upsert(
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

    pub fn get_cached_app_detail(
        &self,
        app_id: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<Option<AppDetail>> {
        let cleaned = clean(app_id);
        if cleaned.is_empty() {
            return Ok(None);
        }

        let mut stmt = self.conn.prepare(
            "SELECT detail_json, cached_at FROM app_details_cache WHERE app_id = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![cleaned])?;
        if let Some(row) = rows.next()? {
            let json_str: String = row.get(0)?;
            let cached_at: i64 = row.get(1)?;
            if let Some(ttl) = ttl_seconds {
                if ttl > 0 {
                    let now = now_secs();
                    if now.saturating_sub(cached_at) >= ttl {
                        // 缓存已过期，返回 None 以促使远端触发 ETag 条件校验
                        return Ok(None);
                    }
                } else if ttl == 0 {
                    // ttl == 0 代表每次打开均需要向远端校验
                    return Ok(None);
                }
            }
            if let Ok(mut detail) = serde_json::from_str::<AppDetail>(&json_str) {
                detail.cached_at = Some(cached_at);
                return Ok(Some(detail));
            }
        }
        Ok(None)
    }

    /// 即使缓存过期，也返回已存储的详情副本（用于离线弱网或 GitHub API 故障时的降级呈现）
    pub fn get_cached_app_detail_fallback(&self, app_id: &str) -> Result<Option<AppDetail>> {
        self.get_cached_app_detail(app_id, None)
    }

    /// 当远端返回 304 Not Modified 时，快速刷新 cached_at 时间戳，零开销延长保鲜期
    pub fn touch_cached_app_detail(&self, app_id: &str, new_cached_at: i64) -> Result<()> {
        self.exec_upsert(
            "UPDATE app_details_cache SET cached_at = ?1 WHERE app_id = ?2",
            params![new_cached_at, clean(app_id)],
        )?;
        Ok(())
    }

    pub fn save_cached_app_detail(&self, app_id: &str, detail: &AppDetail) -> Result<()> {
        let clean_id = clean(app_id);
        let now = now_secs();
        let json_str = serde_json::to_string(detail)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

        self.exec_upsert(
            r#"
            INSERT INTO app_details_cache (app_id, name, latest_version, detail_json, cached_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(app_id) DO UPDATE SET
                name = excluded.name,
                latest_version = excluded.latest_version,
                detail_json = excluded.detail_json,
                cached_at = excluded.cached_at;
            "#,
            params![clean_id, detail.name, detail.latest_version, json_str, now,],
        )?;
        Ok(())
    }

    /// 详情 + 图标原子落库（Top1+2：原 2 提交 → 1 提交）：
    /// 事务边界：`BEGIN IMMEDIATE` → `save_cached_app_detail` + 可选 `upsert_icon_cycle` → `COMMIT`，
    /// 失败整体 `ROLLBACK` 返回 Err，调用方保持 `let _ =` 吞错并可回退逐条（见 commands/catalog 调用处）。
    /// 不改 TTL/ETag 逻辑（`cached_at` 仍取 `now_secs()`，与原单条一致）。
    pub fn save_detail_with_icon(
        &self,
        app_id: &str,
        detail: &AppDetail,
        cycle: Option<&super::AppIconCycle>,
    ) -> Result<()> {
        self.with_immediate_transaction(|| {
            self.save_cached_app_detail(app_id, detail)?;
            if let Some(c) = cycle {
                self.upsert_icon_cycle(c)?;
            }
            Ok(())
        })
    }

    /// 图标轮换写侧补齐：`cycle_app_icon` 选中态落库后同步 `detail_json.icon`，
    /// 使不 join 轮换表的读者与 `history::apply_confirmed_icon` 读侧一致。
    /// - 无详情行则跳过不建行（返回 `Ok(false)`）；
    /// - 仅重写 `detail_json.icon`，`cached_at` 保持不动（不延长 TTL：
    ///   轮换是本地用户偏好而非远端新鲜抓取，touch 会把偏好误导为新鲜度、
    ///   推迟下次 ETag 条件校验并污染 stale 语义）；
    /// - 调用方保证传入已归一化的 remote_url（`data:` 永不进盘；avatar/空已按既有规则置空）。
    pub fn sync_detail_icon(&self, app_id: &str, new_icon: &str) -> Result<bool> {
        let clean_id = clean(app_id);
        if clean_id.is_empty() {
            return Ok(false);
        }
        let existing: Option<String> = self.query_scalar_opt(
            "SELECT detail_json FROM app_details_cache WHERE app_id = ?1",
            params![clean_id],
        )?;
        let Some(json_str) = existing else {
            return Ok(false);
        };
        let mut v: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let Some(obj) = v.as_object_mut() else {
            return Ok(false);
        };
        obj.insert(
            "icon".to_string(),
            serde_json::Value::String(new_icon.to_string()),
        );
        let new_json = serde_json::to_string(&v)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        // 注意：只碰 detail_json，cached_at 不动（见上）。
        let rows = self.exec_upsert(
            "UPDATE app_details_cache SET detail_json = ?1 WHERE app_id = ?2",
            params![new_json, clean_id],
        )?;
        Ok(rows > 0)
    }

    /// 测试专用：清空详情缓存（生产路径只增量写入，从不全清）。
    #[cfg(test)]
    pub fn clear_app_details_cache(&self) -> Result<()> {
        self.exec_upsert("DELETE FROM app_details_cache", [])?;
        Ok(())
    }

    pub fn get_icon_cache_url(&self, cache_key: &str) -> Result<Option<String>> {
        let cleaned = clean(cache_key);
        if cleaned.is_empty() {
            return Ok(None);
        }
        self.query_scalar_opt(
            "SELECT remote_url FROM icon_cache_meta WHERE cache_key = ?1",
            params![cleaned],
        )
    }

    pub fn save_icon_cache_url(&self, cache_key: &str, remote_url: &str) -> Result<()> {
        let clean_key = clean(cache_key);
        let clean_url = clean(remote_url);
        if clean_key.is_empty() || clean_url.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_upsert(
            "INSERT INTO icon_cache_meta (cache_key, remote_url, cached_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(cache_key) DO UPDATE SET remote_url = excluded.remote_url, cached_at = excluded.cached_at",
            params![clean_key, clean_url, now],
        )?;
        Ok(())
    }

    /// 内容扩展名与推断不一致纠正时，删除推断错误的缓存键。
    pub fn delete_icon_cache_url(&self, cache_key: &str) -> Result<()> {
        let clean_key = clean(cache_key);
        if clean_key.is_empty() {
            return Ok(());
        }
        self.exec_upsert(
            "DELETE FROM icon_cache_meta WHERE cache_key = ?1",
            params![clean_key],
        )?;
        Ok(())
    }
}

/// Phase1A 趋势榜缓存上限：单条 payload 至多 512 KiB，超限拒绝落库。
pub const TREND_BOARD_CACHE_MAX_BYTES: usize = 512 * 1024;

impl Database {
    /// 获取趋势榜缓存（纯透存：命中即返，不判 TTL；key 仅 trim，不做大小写归一）。
    pub fn get_trend_board_cache(&self, cache_key: &str) -> Result<Option<(String, i64)>> {
        let key = clean(cache_key);
        if key.is_empty() {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT payload_json, cached_at FROM trend_board_cache WHERE cache_key = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            let payload: String = row.get(0)?;
            let cached_at: i64 = row.get(1)?;
            Ok(Some((payload, cached_at)))
        } else {
            Ok(None)
        }
    }

    /// 保存趋势榜缓存（全列 UPSERT 覆盖；空 key/board/payload 静默跳过，超限拒绝并报错）。
    pub fn save_trend_board_cache(
        &self,
        cache_key: &str,
        board: &str,
        payload: &str,
    ) -> Result<()> {
        let key = clean(cache_key);
        let board_clean = clean(board);
        if key.is_empty() || board_clean.is_empty() || payload.is_empty() {
            return Ok(());
        }
        if payload.len() > TREND_BOARD_CACHE_MAX_BYTES {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "trend_board_payload_too_large",
                ),
            )));
        }
        let now = now_secs();
        self.exec_upsert(
            r#"
            INSERT INTO trend_board_cache (cache_key, board, payload_json, payload_bytes, cached_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(cache_key) DO UPDATE SET
                board = excluded.board,
                payload_json = excluded.payload_json,
                payload_bytes = excluded.payload_bytes,
                cached_at = excluded.cached_at;
            "#,
            params![key, board_clean, payload, payload.len() as i64, now],
        )?;
        Ok(())
    }

    /// 双档清扫：`daily` 挡过期 3600s，其余挡 43200s；未来时间戳天然保留（早于阈值比较恒为假）。
    pub fn prune_expired_trend_board_cache(&self, now: i64) -> Result<usize> {
        let daily_cutoff = now.saturating_sub(3600);
        let other_cutoff = now.saturating_sub(43200);
        let deleted = self.conn.execute(
            "DELETE FROM trend_board_cache WHERE (board = 'daily' AND cached_at <= ?1) OR (board <> 'daily' AND cached_at <= ?2)",
            params![daily_cutoff, other_cutoff],
        )?;
        Ok(deleted)
    }
}
