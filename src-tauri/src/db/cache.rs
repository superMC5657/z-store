use super::{clean, now_secs, Database};
use crate::models::AppDetail;
use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};

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

    /// 详情 + 图标原子落库（单提交）：
    /// 事务内先写详情再写可选图标行，失败整体回滚，调用方保持 `let _ =` 吞错并可回退逐条。
    /// 不改 TTL/ETag 逻辑（`cached_at` 仍取 `now_secs()`）。
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

    /// 图标轮换写侧补齐：`cycle_app_icon` 选中态落库后同步 `detail_json.icon`
    ///（读侧经轮换表 join 读确认图标，此处保持一致）。
    /// - 无详情行则跳过不建行（返回 `Ok(false)`）；
    /// - 仅重写 `detail_json.icon`，`cached_at` 保持不动（轮换是本地用户偏好，不延长 TTL）；
    /// - 调用方保证传入已归一化的 remote_url（`data:` 永不进盘）。
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

/// 榜缓存二级落盘单条至多 512 KiB，超限拒绝。
pub const TREND_BOARD_CACHE_MAX_BYTES: usize = 512 * 1024;

impl Database {
    /// 榜缓存二级落盘读。
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

    /// 榜缓存二级落盘写。
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

    /// 榜缓存二级落盘清扫。
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

/// 图片磁盘缓存配额上限：2000 文件。
pub const ASSET_CACHE_MAX_FILES: usize = 2000;
/// 图片磁盘缓存配额上限：500MB。
pub const ASSET_CACHE_MAX_BYTES: u64 = 500 * 1024 * 1024;

/// 读取当前生效的图片缓存配额（文件数，字节数）。
/// 优先使用数据库设置，缺省回退 config.toml 基线。
fn asset_quota_limits(db: &Database) -> (u64, u64) {
    let files = db.get_asset_cache_max_files() as u64;
    let bytes = db.get_asset_cache_max_mb().saturating_mul(1024 * 1024);
    let files = if files > 0 {
        files
    } else {
        ASSET_CACHE_MAX_FILES as u64
    };
    let bytes = if bytes > 0 {
        bytes
    } else {
        ASSET_CACHE_MAX_BYTES
    };
    (files, bytes)
}

/// 图片磁盘缓存记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetCacheRecord {
    pub url: String,
    pub hash: String,
    pub local_path: String,
    pub content_type: String,
    pub size: i64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_used: i64,
    pub expires_at: i64,
    pub hits: i64,
}

/// 图片缓存用量统计。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetUsageStats {
    pub total_entries: i64,
    pub total_bytes: i64,
    pub total_hits: i64,
}

/// 去除代理包装，还原待哈希的原始地址。
pub fn canonical_asset_url(url: &str) -> String {
    let mut current = url.trim().to_string();
    loop {
        let Some(scheme_pos) = current.find("://") else {
            break;
        };
        let after_scheme = &current[scheme_pos + 3..];
        let Some(slash_pos) = after_scheme.find('/') else {
            break;
        };
        let remainder = &after_scheme[slash_pos + 1..];
        if remainder.starts_with("http://") || remainder.starts_with("https://") {
            current = remainder.to_string();
        } else {
            break;
        }
    }
    current
}

/// 计算地址对应的缓存哈希。
pub fn asset_hash_for_url(url: &str) -> String {
    let canonical = canonical_asset_url(url);
    if canonical.is_empty() {
        return String::new();
    }
    let full = crate::sha256_digest_hex(canonical.as_bytes());
    full[..16.min(full.len())].to_string()
}

/// 拼接哈希对应的磁盘相对路径。
pub fn asset_local_path(hash: &str, ext: &str) -> String {
    let h = hash.trim();
    if h.len() < 2 {
        return String::new();
    }
    let dir = &h[..2];
    let filtered: String = ext
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let truncated = if filtered.len() > 10 {
        filtered[..10].to_string()
    } else {
        filtered
    };
    let final_ext = if truncated.is_empty() {
        "bin".to_string()
    } else {
        truncated
    };
    format!("cache/assets/{}/{}.{}", dir, h, final_ext)
}

/// 从地址后缀或内容类型推断文件扩展名。
fn infer_asset_ext(canonical_url: &str, content_type: &str) -> String {
    let mut base = canonical_url.trim();
    if let Some(end) = base.find(['?', '#']) {
        base = &base[..end];
    }
    if let Some(slash) = base.rfind('/') {
        let tail = &base[slash + 1..];
        if let Some(dot) = tail.rfind('.') {
            let cand = tail[dot + 1..].to_ascii_lowercase();
            match cand.as_str() {
                "png" | "jpg" | "gif" | "webp" | "svg" | "ico" | "avif" | "bmp" => {
                    return cand;
                }
                "jpeg" => return "jpg".to_string(),
                _ => {}
            }
        }
    }
    let ct = content_type
        .trim()
        .to_ascii_lowercase();
    let ct = ct.split(';').next().unwrap_or("").trim();
    match ct {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        _ => "bin",
    }
    .to_string()
}

impl Database {
    /// 按原始地址读取缓存记录。
    pub fn get_asset(&self, url: &str) -> Result<Option<AssetCacheRecord>> {
        let key = clean(url);
        if key.is_empty() {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT url, hash, local_path, content_type, size, etag, last_modified, last_used, expires_at, hits
             FROM asset_cache WHERE url = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(AssetCacheRecord {
                url: row.get(0)?,
                hash: row.get(1)?,
                local_path: row.get(2)?,
                content_type: row.get(3)?,
                size: row.get(4)?,
                etag: row.get(5)?,
                last_modified: row.get(6)?,
                last_used: row.get(7)?,
                expires_at: row.get(8)?,
                hits: row.get(9)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// 写入或更新缓存记录，返回落库后的完整行。
    pub fn save_asset(
        &self,
        url: &str,
        content_type: &str,
        size: i64,
        etag: Option<&str>,
        last_modified: Option<&str>,
        expires_at: i64,
    ) -> Result<AssetCacheRecord> {
        let raw = clean(url).to_string();
        if raw.is_empty() {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "asset_url_empty"),
            )));
        }
        let canonical = canonical_asset_url(&raw);
        let hash = asset_hash_for_url(&raw);
        let ext = infer_asset_ext(&canonical, content_type);
        let local_path = asset_local_path(&hash, &ext);
        let content_type_clean = clean(content_type).to_string();
        let size_clean = size.max(0);
        let etag_clean = etag.map(|s| s.trim()).filter(|s| !s.is_empty());
        let last_modified_clean = last_modified.map(|s| s.trim()).filter(|s| !s.is_empty());
        let now = now_secs();
        self.exec_upsert(
            r#"
            INSERT INTO asset_cache (url, hash, local_path, content_type, size, etag, last_modified, last_used, expires_at, hits)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
            ON CONFLICT(url) DO UPDATE SET
                hash = excluded.hash,
                local_path = excluded.local_path,
                content_type = excluded.content_type,
                size = excluded.size,
                etag = excluded.etag,
                last_modified = excluded.last_modified,
                last_used = excluded.last_used,
                expires_at = excluded.expires_at;
            "#,
            params![
                raw,
                hash,
                local_path,
                content_type_clean,
                size_clean,
                etag_clean,
                last_modified_clean,
                now,
                expires_at,
            ],
        )?;
        let saved = self.get_asset(&raw)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let (max_files, max_bytes) = asset_quota_limits(self);
        if let Ok(stats) = self.asset_usage_stats() {
            if stats.total_entries as u64 > max_files || stats.total_bytes as u64 > max_bytes
            {
                let dir = crate::get_app_data_dir().join("cache").join("assets");
                let _ = self.enforce_asset_quota_lru(&dir);
            }
        }
        Ok(saved)
    }

    /// 刷新缓存命中状态并记录引用关系。
    pub fn touch_asset(&self, hash: &str, app_id: &str) -> Result<()> {
        let h = clean(hash).to_string();
        let a = clean(app_id).to_string();
        if h.is_empty() || a.is_empty() {
            return Ok(());
        }
        self.with_immediate_transaction(|| {
            let now = now_secs();
            self.exec_upsert(
                "UPDATE asset_cache SET last_used = ?1, hits = hits + 1 WHERE hash = ?2",
                params![now, h],
            )?;
            self.exec_upsert(
                r#"
                INSERT INTO asset_refs (hash, app_id, last_seen)
                VALUES (?1, ?2, ?3)
                ON CONFLICT(hash, app_id) DO UPDATE SET last_seen = excluded.last_seen;
                "#,
                params![h, a, now],
            )?;
            Ok(())
        })
    }

    /// 统计缓存条目与占用。
    pub fn asset_usage_stats(&self) -> Result<AssetUsageStats> {
        let mut stmt = self.conn.prepare(
            "SELECT COUNT(*), COALESCE(SUM(size), 0), COALESCE(SUM(hits), 0) FROM asset_cache",
        )?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(AssetUsageStats {
                total_entries: row.get(0)?,
                total_bytes: row.get(1)?,
                total_hits: row.get(2)?,
            })
        } else {
            Ok(AssetUsageStats {
                total_entries: 0,
                total_bytes: 0,
                total_hits: 0,
            })
        }
    }

    /// 条件请求命中刷新：更新使用时间与过期时间并计数。
    pub fn refresh_asset_revalidated(&self, hash: &str, expires_at: i64) -> Result<()> {
        let h = clean(hash).to_string();
        if h.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_upsert(
            "UPDATE asset_cache SET last_used = ?1, expires_at = ?2, hits = hits + 1 WHERE hash = ?3",
            params![now, expires_at, h],
        )?;
        Ok(())
    }

    /// 配额淘汰：按使用时间最旧优先删除直至文件数与总字节双水位线下。
    pub fn enforce_asset_quota_lru(&self, assets_dir: &std::path::Path) -> Result<usize> {
        let (max_files, max_bytes) = asset_quota_limits(self);
        let rows: Vec<(String, String, i64, i64)> = {
            let mut stmt = self.conn.prepare(
                "SELECT hash, local_path, size, last_used FROM asset_cache ORDER BY last_used ASC",
            )?;
            let mapped = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
            })?;
            let mut out = Vec::new();
            for r in mapped {
                out.push(r?);
            }
            out
        };
        let mut db_count = rows.len() as u64;
        let mut db_bytes: u64 = rows.iter().map(|(_, _, s, _)| (*s).max(0) as u64).sum();
        let mut scanned = scan_asset_files(assets_dir);
        let mut fs_count = scanned.len() as u64;
        let mut fs_bytes: u64 = scanned.iter().map(|(_, len, _)| *len).sum();
        if db_count <= max_files
            && db_bytes <= max_bytes
            && fs_count <= max_files
            && fs_bytes <= max_bytes
        {
            return Ok(0);
        }
        let mut removed: usize = 0;
        let mut remaining_hashes: std::collections::HashSet<String> =
            rows.iter().map(|(h, _, _, _)| h.clone()).collect();
        for (hash, local_path, size, _) in &rows {
            if db_count <= max_files
                && db_bytes <= max_bytes
                && fs_count <= max_files
                && fs_bytes <= max_bytes
            {
                break;
            }
            let mut freed_fs: u64 = 0;
            for cand in asset_abs_candidates(assets_dir, local_path) {
                if let Ok(meta) = std::fs::metadata(&cand) {
                    if meta.is_file() {
                        let len = meta.len();
                        if std::fs::remove_file(&cand).is_ok() {
                            freed_fs = freed_fs.saturating_add(len);
                            scanned.retain(|(p, _, _)| p != &cand);
                        }
                    }
                }
            }
            let _ = self.conn.execute("DELETE FROM asset_cache WHERE hash = ?1", params![hash]);
            let _ = self
                .conn
                .execute("DELETE FROM asset_refs WHERE hash = ?1", params![hash]);
            db_count = db_count.saturating_sub(1);
            db_bytes = db_bytes.saturating_sub((*size).max(0) as u64);
            fs_count = fs_count.saturating_sub(if freed_fs > 0 { 1 } else { 0 });
            fs_bytes = fs_bytes.saturating_sub(freed_fs);
            remaining_hashes.remove(hash);
            removed += 1;
        }
        if fs_count <= max_files && fs_bytes <= max_bytes {
            return Ok(removed);
        }
        scanned.sort_by(|a, b| a.2.cmp(&b.2));
        for (path, len, _) in scanned {
            if fs_count <= max_files && fs_bytes <= max_bytes {
                break;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            if remaining_hashes.contains(&stem) {
                continue;
            }
            if std::fs::remove_file(&path).is_ok() {
                fs_count = fs_count.saturating_sub(1);
                fs_bytes = fs_bytes.saturating_sub(len);
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// 清空通用图片磁盘缓存：删除配额目录下全部文件并清空图片缓存表。
    /// 仅处理传入目录与图片缓存两表，不触碰图标目录与详情缓存。
    pub fn clear_asset_cache(&self, assets_dir: &std::path::Path) -> Result<usize> {
        let scanned = scan_asset_files(assets_dir);
        let mut removed: usize = 0;
        for (path, _, _) in scanned {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        self.exec_upsert("DELETE FROM asset_cache", [])?;
        self.exec_upsert("DELETE FROM asset_refs", [])?;
        Ok(removed)
    }

    /// 统计图标磁盘缓存占用：扫描图标目录文件数与总字节。
    pub fn icon_usage_stats(&self, icons_dir: &std::path::Path) -> Result<AssetUsageStats> {
        let scanned = scan_asset_files(icons_dir);
        let total_entries = scanned.len() as i64;
        let total_bytes: i64 = scanned.iter().map(|(_, len, _)| *len as i64).sum();
        Ok(AssetUsageStats {
            total_entries,
            total_bytes,
            total_hits: 0,
        })
    }

    /// 清空图标磁盘缓存：删除图标目录下全部文件并清空图标索引。
    /// 仅处理图标目录与图标两表，保留轮换级别地址，清空文件指向。
    pub fn clear_icon_cache(&self, icons_dir: &std::path::Path) -> Result<usize> {
        let scanned = scan_asset_files(icons_dir);
        let mut removed: usize = 0;
        for (path, _, _) in scanned {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        self.exec_upsert("DELETE FROM icon_cache_meta", [])?;
        let _ = self.exec_upsert("UPDATE app_icon_cycles SET cache_file = ''", []);
        Ok(removed)
    }
}

/// 递归扫描配额目录下全部文件。
fn scan_asset_files(
    dir: &std::path::Path,
) -> Vec<(std::path::PathBuf, u64, std::time::SystemTime)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&current) else {
            continue;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if !p.is_file() {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&p) else {
                continue;
            };
            let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            out.push((p, meta.len(), mtime));
        }
    }
    out
}

/// 解析缓存行对应的磁盘候选路径。
fn asset_abs_candidates(
    assets_dir: &std::path::Path,
    local_path: &str,
) -> Vec<std::path::PathBuf> {
    let trimmed = local_path.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let rel = std::path::Path::new(trimmed);
    if rel.is_absolute() {
        return vec![rel.to_path_buf()];
    }
    let stripped = trimmed
        .strip_prefix("cache/assets/")
        .or_else(|| trimmed.strip_prefix("cache/assets"))
        .unwrap_or(trimmed);
    let mut out = vec![assets_dir.join(stripped)];
    let via_app_dir = crate::get_app_data_dir().join(trimmed);
    if via_app_dir != out[0] {
        out.push(via_app_dir);
    }
    out
}
