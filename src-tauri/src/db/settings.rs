use super::{
    clean, get_or_config, normalize_asset_cache_max_files, normalize_asset_cache_max_mb,
    normalize_detail_cache_ttl, normalize_strict_errors, Database,
};
use rusqlite::{params, Result};
use std::collections::HashMap;

impl Database {
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.query_scalar_opt(
            "SELECT value FROM user_settings WHERE key = ?1",
            params![key],
        )
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.exec_write(
            r#"
            INSERT INTO user_settings (key, value)
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            "#,
            params![key, value],
        )?;
        Ok(())
    }

    pub fn remove_setting(&self, key: &str) -> Result<()> {
        self.exec_write("DELETE FROM user_settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn get_all_settings(&self) -> Result<HashMap<String, String>> {
        let pairs: Vec<(String, String)> =
            self.query_vec("SELECT key, value FROM user_settings", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        Ok(pairs.into_iter().collect())
    }

    /// 读取应用详情缓存保鲜期 TTL（分钟）。
    /// 优先从数据库设置读取（若用户历史自定义）；
    /// 缺省回退 config.toml 项目基线配置（默认 60 分钟）。
    /// 返回 0 表示每次打开均需向远端条件校验（见 get_cached_app_detail 的 ttl == 0 分支）。
    pub fn get_detail_cache_ttl_minutes(&self) -> i64 {
        get_or_config(
            self.get_setting("detail_cache_ttl_minutes").ok().flatten(),
            |s| clean(s).parse::<i64>().ok(),
            normalize_detail_cache_ttl,
            || crate::config::get_project_config().cache.detail_ttl_minutes,
        )
    }

    /// 读取通用图片磁盘缓存配额上限（兆字节）。
    /// 优先从数据库设置读取，缺省回退 config.toml 项目基线配置。
    pub fn get_asset_cache_max_mb(&self) -> u64 {
        get_or_config(
            self.get_setting("asset_cache_max_mb").ok().flatten(),
            |s| clean(s).parse::<u64>().ok(),
            normalize_asset_cache_max_mb,
            || crate::config::get_project_config().cache.asset_max_mb,
        )
    }

    /// 读取通用图片磁盘缓存配额上限（文件数）。
    /// 优先从数据库设置读取，缺省回退 config.toml 项目基线配置。
    pub fn get_asset_cache_max_files(&self) -> usize {
        get_or_config(
            self.get_setting("asset_cache_max_files").ok().flatten(),
            |s| clean(s).parse::<usize>().ok(),
            normalize_asset_cache_max_files,
            || crate::config::get_project_config().cache.asset_max_files,
        )
    }

    /// 读取运行错误策略。
    /// 优先级：用户设置 > config.toml > 构建类型默认值。
    pub fn is_strict_errors(&self) -> bool {
        self.get_setting("strict_errors")
            .ok()
            .flatten()
            .map(|v| normalize_strict_errors(&v))
            .unwrap_or_else(crate::db::default_strict_errors)
    }
}
