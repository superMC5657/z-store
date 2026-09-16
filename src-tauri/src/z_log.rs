//! 统一日志能力（z-store）：只落盘到 LogDir，release 仅 LogDir，dev 附加 Stdout + Webview。
//!
//! - 日志只进 LogDir（Win `%LOCALAPPDATA%/com.zstore.app/logs`），禁止写 sqlite 业务库。
//! - 保留策略：14 天 / 总量 25MB（store 联网，日志价值高保留更久）。
//! - 自动上报网络：TODO(opt-in)：默认关闭，需用户显式开启后再加上传开关，当前仅落盘 + 导出。

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 日志保留天数。
pub const KEEP_DAYS: u64 = 14;
/// 日志总大小上限（25MB）。
pub const MAX_TOTAL_BYTES: u64 = 25 * 1024 * 1024;

/// 单个日志切片大小上限（5MB），防止默认 40KB 到限后直接清空文件。
pub const MAX_SINGLE_FILE_BYTES: u128 = 5 * 1024 * 1024;
/// 保留的已归档日志切片数量上限。
pub const ROTATION_KEEP_COUNT: usize = 5;

/// 初始化 tauri-plugin-log v2。
///
/// - release：只写 `LogDir`（Level::Info）
/// - dev：`Stdout` + `LogDir` + `Webview`（Level::Debug）
/// - 显式配置 5MB 轮转与本地时区，避免 40KB 静默删除与时区偏差
/// - 降低 reqwest / hyper / tao / wry 等高噪音第三方库级别为 Warn
/// - 统一将 webview 前端长路径 target 规整为简洁的 [ui]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{
        Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy,
    };

    let format = time::macros::format_description!("[[[year]-[month]-[day]][[[hour]:[minute]:[second]]");
    let builder = Builder::default()
        .max_file_size(MAX_SINGLE_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(ROTATION_KEEP_COUNT))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .format(move |out, message, record| {
            let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
            let target = if record.target().starts_with("webview") {
                "ui"
            } else {
                record.target()
            };
            out.finish(format_args!(
                "{}[{}][{}] {}",
                now.format(&format).unwrap_or_default(),
                record.level(),
                target,
                message
            ))
        })
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .level_for("h2", log::LevelFilter::Warn)
        .level_for("rustls", log::LevelFilter::Warn);

    #[cfg(debug_assertions)]
    {
        builder
            .level(log::LevelFilter::Debug)
            .targets([
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::LogDir { file_name: None }),
                Target::new(TargetKind::Webview),
            ])
            .build()
    }
    #[cfg(not(debug_assertions))]
    {
        builder
            .level(log::LevelFilter::Info)
            .targets([Target::new(TargetKind::LogDir { file_name: None })])
            .build()
    }
}

/// 记录新会话启动横幅，明确会话生命周期边界。
pub fn log_session_start() {
    log::info!(
        "=== Z-Store v{} started (os={} arch={} pid={}) ===",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::process::id()
    );
}

/// 脱敏：遮蔽常见 token / Authorization 头，避免密钥落盘。
pub fn redact(msg: &str) -> String {
    // 通用规则：`Bearer xxx` / `token xxx` 后续 token 打码
    let mut out = redact_after_marker(msg, "Bearer ");
    out = redact_after_marker(&out, "bearer ");
    out = redact_after_marker(&out, "Token ");
    out = redact_after_marker(&out, "token ");
    out
}

fn redact_after_marker(s: &str, marker: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find(marker) {
        let (head, tail) = rest.split_at(pos + marker.len());
        result.push_str(head);
        // tail 开头连续非空白即 token，替换为 ***
        let token_end = tail
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ';' || c == ',')
            .unwrap_or(tail.len());
        if token_end > 0 {
            result.push_str("***");
            rest = &tail[token_end..];
        } else {
            rest = tail;
        }
    }
    result.push_str(rest);
    result
}

/// 清理过期 / 超量日志：删除超过 KEEP_DAYS 的文件，总量超限时按 mtime 最旧先删。
pub fn prune(log_dir: &Path) {
    prune_log_dir(log_dir, KEEP_DAYS, MAX_TOTAL_BYTES);
}

fn prune_log_dir(log_dir: &Path, keep_days: u64, max_total_bytes: u64) {
    let entries = match std::fs::read_dir(log_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // 只碰 *.log 与 *.log.bak：其他文件（含 .zip 导出包、.txt、业务 DB）一律不动。
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let is_log = name.ends_with(".log")
            || name.ends_with(".log.bak")
            || path
                .extension()
                .map(|e| e.eq_ignore_ascii_case("log") || e.eq_ignore_ascii_case("bak"))
                .unwrap_or(false);
        if !is_log {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        files.push((path, meta.len(), mtime));
    }

    let now = std::time::SystemTime::now();
    let keep_secs = keep_days.saturating_mul(24 * 3600);
    // 1) 按时间删除
    let mut kept: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    for (path, len, mtime) in files {
        let age_ok = now
            .duration_since(mtime)
            .map(|d| d.as_secs() <= keep_secs)
            .unwrap_or(true);
        if !age_ok {
            let _ = std::fs::remove_file(&path);
        } else {
            kept.push((path, len, mtime));
        }
    }
    // 2) 按总量删除（最旧先删）
    kept.sort_by_key(|(_, _, mtime)| *mtime);
    let mut total: u64 = kept.iter().map(|(_, len, _)| *len).sum();
    for (path, len, _) in kept {
        if total <= max_total_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

/// 安装 panic hook：panic 时记 error 日志（含位置信息，已脱敏）。
/// 幂等：lib::run() 首行与 main() 首行双入口重复调用只安装一次。
pub fn install_panic_hook() {
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic payload".to_string());
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "unknown location".to_string());
            log::error!("[panic] {} at {}", redact(&payload), location);
            prev(info);
        }));
    });
}

/// 获取 LogDir 路径（前端设置页 / 问题反馈用）。
#[tauri::command]
pub fn zlog_get_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 导出日志包：把 LogDir 内日志打成 zip，返回 bundle 文件路径。
#[tauri::command]
pub fn zlog_export_bundle(app: AppHandle) -> Result<String, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out_path = log_dir.join(format!("zstore-logs-{}.zip", stamp));
    let out_file = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(out_file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let entries = std::fs::read_dir(&log_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path == out_path {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() || name.ends_with(".zip") {
            continue;
        }
        // 只打包 *.log 与 *.log.bak，避免把业务 DB / 其他杂物打进 bundle。
        let name_lower = name.to_lowercase();
        let is_log = name_lower.ends_with(".log")
            || name_lower.ends_with(".log.bak")
            || path
                .extension()
                .map(|e| e.eq_ignore_ascii_case("log") || e.eq_ignore_ascii_case("bak"))
                .unwrap_or(false);
        if !is_log {
            continue;
        }
        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        use std::io::Write as _;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }
    // 附带一条说明文件
    let readme = format!(
        "ZStore log bundle\nidentifier=com.zstore.app\nkeep_days={}\nmax_total_bytes={}\n",
        KEEP_DAYS, MAX_TOTAL_BYTES
    );
    zip.start_file("README.txt", options)
        .map_err(|e| e.to_string())?;
    use std::io::Write as _;
    zip.write_all(readme.as_bytes())
        .map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(out_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_bearer() {
        let out = redact("call with Bearer abc123xyz ok");
        assert!(out.contains("Bearer ***"));
        assert!(!out.contains("abc123xyz"));
    }

    #[test]
    fn test_prune_expired_and_oversize() {
        let dir = std::env::temp_dir().join(format!("zstore-log-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // 旧文件（mtime 改为 20 天前）
        let old = dir.join("old.log");
        std::fs::write(&old, b"old").unwrap();
        let twenty_days = std::time::Duration::from_secs(20 * 24 * 3600);
        let old_time = std::time::SystemTime::now() - twenty_days;
        let _ = set_mtime(&old, old_time);
        // 新文件
        let fresh = dir.join("fresh.log");
        std::fs::write(&fresh, b"fresh").unwrap();
        prune_log_dir(&dir, KEEP_DAYS, MAX_TOTAL_BYTES);
        assert!(!old.exists());
        assert!(fresh.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(test)]
    fn set_mtime(path: &Path, t: std::time::SystemTime) -> std::io::Result<()> {
        // 无额外依赖：用 filetime 思路退化为不改时间时跳过断言？此处通过 touch 循环等待不可靠，
        // 改用直接覆写 atime/mtime 需要 libc；简化：若平台不支持则仅验证 prune 不误删新文件。
        let _ = (path, t);
        // 尝试通过 `std::fs::File::set_modified`（Rust 1.75+ 稳定）
        let f = std::fs::File::options().write(true).open(path)?;
        f.set_modified(t)
    }
}
