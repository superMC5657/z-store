use super::{clean, now_secs, Database};
use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};

impl Database {
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
        self.exec_write(
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
        self.exec_write(
            "DELETE FROM icon_cache_meta WHERE cache_key = ?1",
            params![clean_key],
        )?;
        Ok(())
    }
}

/// 榜缓存二级落盘单条至多 512 KiB，超限拒绝。
pub const TREND_BOARD_CACHE_MAX_BYTES: usize = 512 * 1024;
pub use super::details::APP_DETAILS_CACHE_MAX_ROWS;
pub use super::etag::API_ETAG_CACHE_MAX_ROWS;

impl Database {
    /// 统一裁剪 `api_etag_cache` 与 `app_details` 容量上限，返回 `(etag_deleted, detail_deleted)`。
    pub fn prune_bounded_caches(
        &self,
        max_etag_rows: usize,
        max_detail_rows: usize,
    ) -> Result<(usize, usize)> {
        let etag_deleted = self.prune_api_etag_cache(max_etag_rows)?;
        let detail_deleted = self.prune_app_details(max_detail_rows)?;
        Ok((etag_deleted, detail_deleted))
    }

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
        self.exec_write(
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

    /// 榜缓存二级落盘清扫（保留 7 天软过期窗口供弱网/离线回退，新鲜度由前端 TTL 控制）。
    pub fn prune_expired_trend_board_cache(&self, now: i64) -> Result<usize> {
        let cutoff = now.saturating_sub(7 * 86400);
        let deleted = self.conn.execute(
            "DELETE FROM trend_board_cache WHERE cached_at <= ?1",
            params![cutoff],
        )?;
        Ok(deleted)
    }
}

/// Star 同步快照单条至多 512 KiB，超限拒绝。
pub const STARRED_FEED_CACHE_MAX_BYTES: usize = 512 * 1024;
/// Star 同步快照最多保留的查询目标数（按 `cached_at DESC`）。
pub const STARRED_FEED_CACHE_MAX_ROWS: usize = 15;
/// Star 同步快照离线保留期：7 天。
const STARRED_FEED_CACHE_RETENTION_SECS: i64 = 7 * 86400;

impl Database {
    /// 读取 Star 同步快照：返回 `(payload_json, cached_at)`。
    pub fn get_starred_feed_cache(&self, cache_key: &str) -> Result<Option<(String, i64)>> {
        let key = clean(cache_key);
        if key.is_empty() {
            return Ok(None);
        }
        let mut stmt = self.conn.prepare(
            "SELECT payload_json, cached_at FROM starred_feed_cache WHERE cache_key = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some((row.get(0)?, row.get(1)?)))
        } else {
            Ok(None)
        }
    }

    /// 写入 Star 同步快照（键/范围/载荷 trim 后为空即跳过，超 512 KiB 拒绝）。
    pub fn save_starred_feed_cache(
        &self,
        cache_key: &str,
        owner_scope: &str,
        payload: &str,
    ) -> Result<()> {
        let key = clean(cache_key);
        let scope = clean(owner_scope);
        let payload = payload.trim();
        if key.is_empty() || scope.is_empty() || payload.is_empty() {
            return Ok(());
        }
        if payload.len() > STARRED_FEED_CACHE_MAX_BYTES {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "starred_feed_payload_too_large",
                ),
            )));
        }
        self.exec_write(
            r#"
            INSERT INTO starred_feed_cache (cache_key, owner_scope, payload_json, payload_bytes, cached_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(cache_key) DO UPDATE SET
                owner_scope = excluded.owner_scope,
                payload_json = excluded.payload_json,
                payload_bytes = excluded.payload_bytes,
                cached_at = excluded.cached_at;
            "#,
            params![key, scope, payload, payload.len() as i64, now_secs()],
        )?;
        Ok(())
    }

    /// 按 `owner_scope` 精确前缀删除快照（登出时清 `@me:` 私有快照），返回删除行数。
    pub fn delete_starred_feed_cache_by_scope_prefix(&self, prefix: &str) -> Result<usize> {
        if prefix.is_empty() {
            return Ok(0);
        }
        let deleted = self.conn.execute(
            "DELETE FROM starred_feed_cache WHERE substr(owner_scope, 1, length(?1)) = ?1",
            params![prefix],
        )?;
        Ok(deleted)
    }

    /// 启动清扫：删除超 7 天的快照，再按 `cached_at DESC` 只保留最近 15 个目标。
    pub fn prune_starred_feed_cache(&self, now: i64) -> Result<usize> {
        let cutoff = now.saturating_sub(STARRED_FEED_CACHE_RETENTION_SECS);
        let expired = self.conn.execute(
            "DELETE FROM starred_feed_cache WHERE cached_at <= ?1",
            params![cutoff],
        )?;
        let overflow = self.conn.execute(
            r#"
            DELETE FROM starred_feed_cache
            WHERE cache_key NOT IN (
                SELECT cache_key FROM starred_feed_cache
                ORDER BY cached_at DESC, cache_key ASC
                LIMIT ?1
            )
            "#,
            params![STARRED_FEED_CACHE_MAX_ROWS as i64],
        )?;
        Ok(expired + overflow)
    }
}

/// 图片磁盘缓存配额上限：2000 文件。
pub const ASSET_CACHE_MAX_FILES: usize = 2000;
/// 图片磁盘缓存配额上限：500MB。
pub const ASSET_CACHE_MAX_BYTES: u64 = 500 * 1024 * 1024;

/// 读取当前生效的图片缓存配额（文件数，字节数）。
/// 经 `get_asset_cache_max_*`（内用 `get_or_config`，DB 设置优先、缺省回退 config 基线）取值；
/// 此处常量回退仅为防御性兜底（config 基线本身为 0 的极端情形）。图标侧共用此口径。
pub(crate) fn asset_quota_limits(db: &Database) -> (u64, u64) {
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

/// 同一资源的缓存键归一：嵌套包装地址取最内层，直链恒等。
pub fn canonical_asset_url(url: &str) -> String {
    let mut current = url.trim().to_string();
    while let Some(scheme_pos) = current.find("://") {
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
        // 落盘扩展名：地址后缀优先命中即用，否则按 content-type 映射，未知回退 `png`。
        let ext = crate::icons::infer_ext_from_url(&canonical)
            .unwrap_or_else(|| crate::icons::mime_to_ext(content_type));
        let local_path = asset_local_path(&hash, ext);
        let content_type_clean = clean(content_type).to_string();
        let size_clean = size.max(0);
        let etag_clean = etag.map(|s| s.trim()).filter(|s| !s.is_empty());
        let last_modified_clean = last_modified.map(|s| s.trim()).filter(|s| !s.is_empty());
        let now = now_secs();
        self.exec_write(
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
        let saved = self
            .get_asset(&raw)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let dir = crate::get_app_data_dir().join("cache").join("assets");
        let _ = self.enforce_asset_quota_lru(&dir);
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
            self.exec_write(
                "UPDATE asset_cache SET last_used = ?1, hits = hits + 1 WHERE hash = ?2",
                params![now, h],
            )?;
            self.exec_write(
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

    /// 条件请求命中刷新：更新使用时间与过期时间并计数。
    pub fn refresh_asset_revalidated(&self, hash: &str, expires_at: i64) -> Result<()> {
        let h = clean(hash).to_string();
        if h.is_empty() {
            return Ok(());
        }
        let now = now_secs();
        self.exec_write(
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
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
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
            let _ = self
                .conn
                .execute("DELETE FROM asset_cache WHERE hash = ?1", params![hash]);
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
        scanned.sort_by_key(|e| e.2);
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
fn asset_abs_candidates(assets_dir: &std::path::Path, local_path: &str) -> Vec<std::path::PathBuf> {
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

#[cfg(test)]
mod cache_quota_tests {
    use super::*;

    #[test]
    fn save_and_touch_asset_increments_hits_and_enforces_lru_quota() {
        let db = Database::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(assets.join("ab")).unwrap();
        std::fs::create_dir_all(assets.join("cd")).unwrap();
        std::fs::write(assets.join("ab").join("x.png"), vec![7u8; 10]).unwrap();
        std::fs::write(assets.join("cd").join("y.png"), vec![7u8; 10]).unwrap();
        let expires = crate::now_secs() + 3600;
        let rec = db
            .save_asset(
                "https://example.com/stale.png",
                "image/png",
                100,
                None,
                None,
                expires,
            )
            .unwrap();
        // 默认配额宽松，不触发淘汰。
        assert_eq!(db.enforce_asset_quota_lru(&assets).unwrap(), 0);
        // touch 后 hits +1。
        db.touch_asset(&rec.hash, "o/r").unwrap();
        let touched = db
            .get_asset("https://example.com/stale.png")
            .unwrap()
            .unwrap();
        assert_eq!(touched.hits, rec.hits + 1);

        // 收紧配额上限为 1，触发 LRU 清理直至磁盘文件数落回水位线内。
        db.set_setting("asset_cache_max_files", "1").unwrap();
        let removed = db.enforce_asset_quota_lru(&assets).unwrap();
        assert!(removed >= 1);
        assert!(scan_asset_files(&assets).len() <= 1);
    }

    #[test]
    fn prune_etag_and_detail_caches_respect_lru_and_protected_assets() {
        let db = Database::open_in_memory().unwrap();
        db.save_etag("https://api.github.com/1", "e1", "{}", 100)
            .unwrap();
        db.save_etag("https://api.github.com/2", "e2", "{}", 200)
            .unwrap();
        db.save_etag("https://api.github.com/3", "e3", "{}", 300)
            .unwrap();

        let deleted_etags = db.prune_api_etag_cache(2).unwrap();
        assert_eq!(deleted_etags, 1);
        assert!(db.get_etag("https://api.github.com/1").unwrap().is_none());
        assert!(db.get_etag("https://api.github.com/2").unwrap().is_some());
        assert!(db.get_etag("https://api.github.com/3").unwrap().is_some());

        let mk_detail = |id: &str| crate::models::AppDetail {
            core: crate::models::AppCore {
                id: id.to_string(),
                name: id.to_string(),
                owner: "o".to_string(),
                repo: id.to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: String::new(),
                description_en: None,
                stars: 1,
                forks: 0,
                license: "MIT".to_string(),
                latest_version: "v1.0.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: vec![],
                added_at: None,
                is_cataloged: Some(false),
                source: None,
                status: None,
            },
            readme_markdown: String::new(),
            readme_variants: None,
            changelog: String::new(),
            releases: vec![],
            is_stale: None,
            cached_at: None,
        };

        db.save_app_detail("o/old-protected", &mk_detail("o/old-protected"))
            .unwrap();
        db.touch_app_detail("o/old-protected", 10).unwrap();
        db.add_favorite("o/old-protected", false).unwrap();

        db.save_app_detail("o/old-evict", &mk_detail("o/old-evict"))
            .unwrap();
        db.touch_app_detail("o/old-evict", 20).unwrap();

        db.save_app_detail("o/newest", &mk_detail("o/newest"))
            .unwrap();
        db.touch_app_detail("o/newest", 30).unwrap();

        let deleted_details = db.prune_app_details(1).unwrap();
        assert_eq!(deleted_details, 1);
        assert!(db
            .get_app_detail("o/old-evict", None)
            .unwrap()
            .is_none());
        assert!(db
            .get_app_detail("o/old-protected", None)
            .unwrap()
            .is_some());
        assert!(db
            .get_app_detail("o/newest", None)
            .unwrap()
            .is_some());
    }
}
