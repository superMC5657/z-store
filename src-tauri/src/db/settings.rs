use super::{clean, now_secs, Database};
use rusqlite::{params, Result};
use std::collections::HashMap;

/// 应用详情缓存保鲜期（TTL）默认值（分钟，读取 config.toml）。
pub fn default_detail_cache_ttl_minutes() -> i64 {
    crate::config::get_project_config().cache.detail_ttl_minutes
}
/// 详情缓存 TTL 有效挡位（分钟）：0 表示每次实时校验。
pub const DETAIL_CACHE_TTL_VALID_MINUTES: [i64; 5] = [0, 10, 60, 360, 1440];

/// 通用图片磁盘缓存配额默认值（兆字节，优先读取 config.toml）。
pub fn default_asset_cache_max_mb() -> u64 {
    crate::config::get_project_config().cache.asset_max_mb
}

/// 通用图片磁盘缓存配额默认值（文件数，优先读取 config.toml）。
pub fn default_asset_cache_max_files() -> usize {
    crate::config::get_project_config().cache.asset_max_files
}

/// 将任意输入归一化到图片缓存配额有效值；非法值回退 config.toml 默认值。
pub fn normalize_asset_cache_max_mb(mb: u64) -> u64 {
    if mb > 0 {
        mb
    } else {
        default_asset_cache_max_mb()
    }
}

/// 将任意输入归一化到图片缓存配额有效值；非法值回退 config.toml 默认值。
pub fn normalize_asset_cache_max_files(files: usize) -> usize {
    if files > 0 {
        files
    } else {
        default_asset_cache_max_files()
    }
}

/// 运行错误策略默认值（优先读取 config.toml，缺失按构建类型回退）。
pub fn default_strict_errors() -> bool {
    crate::config::get_project_config().runtime.strict_errors
}

/// 解析严格开关文本：`true`/`1` 为开，`false`/`0` 为关，其余返回 None。
pub fn parse_strict_errors(value: &str) -> Option<bool> {
    match clean(value).to_ascii_lowercase().as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// 将任意输入归一化到严格开关有效值；非法值回退 config.toml 默认值。
pub fn normalize_strict_errors(value: &str) -> bool {
    parse_strict_errors(value).unwrap_or_else(default_strict_errors)
}

/// 关注通知频率默认值（每天至多通知一次）。
pub const WATCH_NOTIFY_FREQUENCY_DEFAULT: &str = "daily";
/// 关注通知频率有效值：`startup`（每次启动检查即通知）/`daily`。
pub const WATCH_NOTIFY_FREQUENCY_VALID: [&str; 2] = ["startup", "daily"];

/// 将任意输入归一化到关注通知频率有效值；非法值回退默认 `daily`。
pub fn normalize_watch_notify_frequency(value: &str) -> String {
    let clean_value = clean(value).to_lowercase();
    if WATCH_NOTIFY_FREQUENCY_VALID.contains(&clean_value.as_str()) {
        clean_value
    } else {
        WATCH_NOTIFY_FREQUENCY_DEFAULT.to_string()
    }
}

/// 将任意输入归一化到 TTL 有效挡位；非法值回退 config.toml 默认值。
pub fn normalize_detail_cache_ttl(minutes: i64) -> i64 {
    if DETAIL_CACHE_TTL_VALID_MINUTES.contains(&minutes) {
        minutes
    } else {
        default_detail_cache_ttl_minutes()
    }
}

/// 设置项写入侧统一清洗：仅对存在有效值集的键归一化，其余原样透传。
pub fn normalize_setting_value(key: &str, value: &str) -> String {
    if key == "detail_cache_ttl_minutes" {
        clean(value)
            .parse::<i64>()
            .map(normalize_detail_cache_ttl)
            .unwrap_or_else(|_| default_detail_cache_ttl_minutes())
            .to_string()
    } else if key == "asset_cache_max_mb" {
        clean(value)
            .parse::<u64>()
            .map(normalize_asset_cache_max_mb)
            .unwrap_or_else(|_| default_asset_cache_max_mb())
            .to_string()
    } else if key == "asset_cache_max_files" {
        clean(value)
            .parse::<usize>()
            .map(normalize_asset_cache_max_files)
            .unwrap_or_else(|_| default_asset_cache_max_files())
            .to_string()
    } else if key == "watch_notify_frequency" {
        normalize_watch_notify_frequency(value)
    } else if key == "strict_errors" {
        normalize_strict_errors(value).to_string()
    } else {
        value.to_string()
    }
}

/// 配置回退泛型（DB 设置优先，解析/归一化失败回退基线）。
pub(crate) fn get_or_config<T>(
    stored: Option<String>,
    parse: impl FnOnce(&str) -> Option<T>,
    normalize: impl FnOnce(T) -> T,
    fallback: impl FnOnce() -> T,
) -> T {
    stored
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .and_then(parse)
        .map(normalize)
        .unwrap_or_else(fallback)
}

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

    /// 读取应用详情缓存保鲜期 TTL（分钟，缺省回退 config.toml）。
    pub fn get_detail_cache_ttl_minutes(&self) -> i64 {
        get_or_config(
            self.get_setting("detail_cache_ttl_minutes").ok().flatten(),
            |s| clean(s).parse::<i64>().ok(),
            normalize_detail_cache_ttl,
            || crate::config::get_project_config().cache.detail_ttl_minutes,
        )
    }

    /// 读取通用图片磁盘缓存配额上限（兆字节）。
    pub fn get_asset_cache_max_mb(&self) -> u64 {
        get_or_config(
            self.get_setting("asset_cache_max_mb").ok().flatten(),
            |s| clean(s).parse::<u64>().ok(),
            normalize_asset_cache_max_mb,
            || crate::config::get_project_config().cache.asset_max_mb,
        )
    }

    /// 读取通用图片磁盘缓存配额上限（文件数）。
    pub fn get_asset_cache_max_files(&self) -> usize {
        get_or_config(
            self.get_setting("asset_cache_max_files").ok().flatten(),
            |s| clean(s).parse::<usize>().ok(),
            normalize_asset_cache_max_files,
            || crate::config::get_project_config().cache.asset_max_files,
        )
    }

    /// 读取运行错误策略（用户设置 > config.toml > 构建类型默认值）。
    pub fn is_strict_errors(&self) -> bool {
        self.get_setting("strict_errors")
            .ok()
            .flatten()
            .map(|v| normalize_strict_errors(&v))
            .unwrap_or_else(default_strict_errors)
    }

    pub fn get_host_token(&self, host: &str) -> Result<Option<String>> {
        let val: Option<String> = self.query_scalar_opt(
            "SELECT token FROM host_tokens WHERE host = ?1",
            params![clean(host).to_lowercase()],
        )?;
        Ok(val.filter(|t| !clean(t).is_empty()))
    }

    pub fn update_host_rate_limit(
        &self,
        host: &str,
        remaining: Option<u32>,
        limit: Option<u32>,
        reset: Option<i64>,
    ) -> Result<()> {
        let now = now_secs();
        self.exec_write(
            r#"
            INSERT INTO host_tokens (host, token, rate_limit_remaining, rate_limit_limit, rate_limit_reset, updated_at)
            VALUES (?1, '', ?2, ?3, ?4, ?5)
            ON CONFLICT(host) DO UPDATE SET
                rate_limit_remaining = excluded.rate_limit_remaining,
                rate_limit_limit = excluded.rate_limit_limit,
                rate_limit_reset = excluded.rate_limit_reset,
                updated_at = excluded.updated_at;
            "#,
            params![clean(host).to_lowercase(), remaining, limit, reset, now],
        )?;
        Ok(())
    }
}
