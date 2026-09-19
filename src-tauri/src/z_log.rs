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
///
/// 级别策略（Wave1 契约）：INFO 只记行为摘要（结果 / 计数 / 耗时 / host），
/// DEBUG 才记完整 URL 与细节正文；release 默认 Info，故 DEBUG 的完整 URL
/// 默认不可见（后续任务按需提升）。调用方另用 `log_support::sanitize_url` /
/// `host_of` / `short_reason` 先脱敏再记行。
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
            // 落盘前统一脱敏：禁止 token / code / body 原文落盘。
            let clean = redact(&message.to_string());
            // 会话/请求关联前缀：未供给（空串）时整体省略，行首干净。
            let sid = SESSION_ID.get().cloned().unwrap_or_default();
            let req = REQ_ID.with(|c| c.borrow().clone());
            let prefix = prefix_sid_req(&sid, &req);
            out.finish(format_args!(
                "{}{}[{}][{}] {}",
                now.format(&format).unwrap_or_default(),
                prefix,
                record.level(),
                target,
                clean
            ))
        })
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .level_for("h2", log::LevelFilter::Warn)
        .level_for("rustls", log::LevelFilter::Warn)
        .level_for("tauri_plugin_updater", log::LevelFilter::Warn)
        .level_for("tauri_plugin_log", log::LevelFilter::Warn);

    #[cfg(debug_assertions)]
    {
        builder
            .level(resolve_level(log::LevelFilter::Debug))
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
            .level(resolve_level(log::LevelFilter::Info))
            .targets([Target::new(TargetKind::LogDir { file_name: None })])
            .build()
    }
}

/// 会话 / 请求关联 ID：`sid` 进程级 `OnceLock` 生成一次全局复用；
/// `req` 线程级短 ID，随请求设置、随行输出。
static SESSION_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static REQ_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
thread_local! {
    static REQ_ID: std::cell::RefCell<String> =
        const { std::cell::RefCell::new(String::new()) };
}

/// 进程级会话 ID：首次调用生成并冻结，后续调用返回同一值。
/// 与 `log_session_start` 横幅及每行 `[sid=..]` 共用。
pub fn new_session_id() -> String {
    SESSION_ID
        .get_or_init(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            // 短 ID：`s` + pid(hex) + 时间低 32 位(hex)，无额外依赖。
            format!("s{:x}{:08x}", std::process::id(), nanos & 0xffff_ffff)
        })
        .clone()
}

/// 当前线程请求短 ID（未设置时为空串，由 format 层省略）。
pub fn current_req_id() -> String {
    REQ_ID.with(|c| c.borrow().clone())
}

/// 生成并安装当前线程请求短 ID（8 位 hex），返回该 ID。
pub fn new_req_id() -> String {
    use std::sync::atomic::Ordering;
    let n = REQ_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let id = format!("{:04x}{:04x}", (nanos ^ n) & 0xffff, n & 0xffff);
    REQ_ID.with(|c| *c.borrow_mut() = id.clone());
    id
}

/// 显式设置当前线程请求 ID（为空则后续行省略 `[req=..]`）。
pub fn set_req_id(id: &str) {
    REQ_ID.with(|c| *c.borrow_mut() = id.to_string());
}

/// 清除当前线程请求 ID。
pub fn clear_req_id() {
    REQ_ID.with(|c| c.borrow_mut().clear());
}

/// 纯函数：`[sid=..][req=..]` 前缀合成，两者为空即整体省略（行首干净无多余空格）。
fn prefix_sid_req(sid: &str, req: &str) -> String {
    let mut p = String::new();
    if !sid.is_empty() {
        p.push_str("[sid=");
        p.push_str(sid);
        p.push(']');
    }
    if !req.is_empty() {
        p.push_str("[req=");
        p.push_str(req);
        p.push(']');
    }
    p
}

/// 日志级别覆盖：`ZSTORE_LOG` 优先，`RUST_LOG` 兜底，均缺失时用编译期默认。
/// 解析大小写不敏感，兼容 `debug` 与 `z_store_lib=debug` 形态；非法值回退默认。
pub fn parse_level_str(s: &str) -> Option<log::LevelFilter> {
    let lower = s.trim().to_lowercase();
    // 取 `=` 后段（如 `crate=debug`），再取 `,` 首段。
    let seg = lower.split(',').next().unwrap_or("").trim();
    let seg = seg.rsplit('=').next().unwrap_or("").trim();
    match seg {
        "trace" => Some(log::LevelFilter::Trace),
        "debug" => Some(log::LevelFilter::Debug),
        "info" => Some(log::LevelFilter::Info),
        "warn" | "warning" => Some(log::LevelFilter::Warn),
        "error" => Some(log::LevelFilter::Error),
        "off" => Some(log::LevelFilter::Off),
        _ => None,
    }
}

/// 双 cfg 分支共用：环境覆盖解析。
pub fn resolve_level(default: log::LevelFilter) -> log::LevelFilter {
    for key in ["ZSTORE_LOG", "RUST_LOG"] {
        if let Ok(v) = std::env::var(key) {
            if let Some(lv) = parse_level_str(&v) {
                return lv;
            }
        }
    }
    default
}
/// 记录新会话启动横幅，明确会话生命周期边界（含进程级 `sid` 便于跨行关联）。
pub fn log_session_start() {
    let sid = new_session_id();
    log::info!(
        "=== Z-Store v{} started sid={} (os={} arch={} pid={}) ===",
        env!("CARGO_PKG_VERSION"),
        sid,
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::process::id()
    );
}

/// 脱敏：遮蔽常见 token / Authorization 头 / 邮箱 / code / api_key，避免密钥落盘。
/// 无正则（no-regex），全分支字符边界安全，永不 panic。
pub fn redact(msg: &str) -> String {
    // 通用规则：`Bearer xxx` / `token xxx` 后续 token 打码
    let mut out = redact_after_marker(msg, "Bearer ");
    out = redact_after_marker(&out, "bearer ");
    out = redact_after_marker(&out, "Token ");
    out = redact_after_marker(&out, "token ");
    out = redact_kv_values(&out);
    out = redact_emails(&out);
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

/// ASCII 大小写不敏感查找（仅 ASCII needle，字节下标恒为字符边界，无正则）。
fn find_ci(hay: &str, needle: &str, from: usize) -> Option<usize> {
    let hb = hay.as_bytes();
    let nb = needle.as_bytes();
    if nb.is_empty() || from >= hb.len() {
        return None;
    }
    let first = nb[0].to_ascii_lowercase();
    let mut i = from;
    while i + nb.len() <= hb.len() {
        if hb[i].to_ascii_lowercase() == first {
            let mut ok = true;
            for k in 1..nb.len() {
                if !hb[i + k].eq_ignore_ascii_case(&nb[k]) {
                    ok = false;
                    break;
                }
            }
            if ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// 键值脱敏：`code` / `device_code` / `user_code` / `api_key` 系（大小写不敏感）。
/// 兼容 `=` / `:` / 空格 / 引号分隔的 JSON 与 query 形态；值遇空白/引号/`,;})` 截断。
/// 键边界：命中仅当“前一字节为起始或 `? & ; 空白 \" ' { ,`”且“后一字节为
/// `= : 空白 \" '`”时才视为键值；路径段内子串（如 `vscode`）永不触发。
/// 全分支 ASCII 字节判定，字符边界安全，无正则，永不 panic。
fn redact_kv_values(s: &str) -> String {
    // 长键优先，避免 `code` 先吞掉 `device_code` 的尾部。
    const KEYS: [&str; 6] = [
        "device_code",
        "user_code",
        "api_key",
        "api-key",
        "apikey",
        "code",
    ];
    fn is_kv_pre(b: u8) -> bool {
        matches!(
            b,
            b'?' | b'&' | b';' | b' ' | b'\t' | b'"' | b'\'' | b'{' | b','
        )
    }
    fn is_kv_post(b: u8) -> bool {
        matches!(b, b'=' | b':' | b' ' | b'\t' | b'"' | b'\'')
    }
    let mut out = s.to_string();
    for key in KEYS {
        let mut from = 0;
        while let Some(pos) = find_ci(&out, key, from) {
            // 前边界：起始或分隔符；`vscode` 中的 `code` 前为 `s` 直接跳过。
            // `pos` 恒为 ASCII 起始字节，`pos-1` 字节索引永不 panic、不切分宽字符。
            if pos > 0 && !is_kv_pre(out.as_bytes()[pos - 1]) {
                from = pos + 1;
                continue;
            }
            // 后边界：键后紧跟 `= : 空白 引号` 才视为键值；路径 `/vscode/releases` 后为 `/` 跳过。
            let after = pos + key.len();
            if after >= out.len() || !is_kv_post(out.as_bytes()[after]) {
                from = pos + key.len();
                continue;
            }
            let mut vstart = pos + key.len();
            // 跳过分隔符：空白 / 引号 / `=` / `:`（均为 ASCII，边界安全）。
            let bytes = out.as_bytes();
            while vstart < bytes.len()
                && matches!(bytes[vstart], b' ' | b'\t' | b'"' | b'\'' | b'=' | b':')
            {
                vstart += 1;
            }
            if vstart >= out.len() {
                break;
            }
            let rest = &out[vstart..];
            let vend_rel = rest
                .find(|c: char| {
                    c.is_whitespace()
                        || c == '"'
                        || c == '\''
                        || c == ','
                        || c == ';'
                        || c == '}'
                        || c == ')'
                })
                .unwrap_or(rest.len());
            if vend_rel == 0 {
                from = vstart;
                continue;
            }
            out.replace_range(vstart..vstart + vend_rel, "***");
            from = vstart + 3;
        }
    }
    out
}

fn is_email_local(b: u8) -> bool {
    matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'_' | b'%' | b'+' | b'-')
}

fn is_email_domain(b: u8) -> bool {
    matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'-')
}

/// 邮箱脱敏：`local@domain` 整体替换为 `***@***`（ASCII 扫描，宽字符原文不动）。
fn redact_emails(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let mut l = i;
            while l > 0 && is_email_local(bytes[l - 1]) {
                l -= 1;
            }
            let mut r = i + 1;
            while r < bytes.len() && is_email_domain(bytes[r]) {
                r += 1;
            }
            let domain = &s[i + 1..r];
            if l < i && r > i + 1 && domain.contains('.') && !domain.starts_with('.') {
                out.push_str(&s[last..l]);
                out.push_str("***@***");
                last = r;
                i = r;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&s[last..]);
    out
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
        // 导出前脱敏：文本按 lossy 解码后过 redact，禁 token / code / 邮箱原文出包。
        let clean = redact(&String::from_utf8_lossy(&data));
        zip.write_all(clean.as_bytes()).map_err(|e| e.to_string())?;
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
    fn converged_waterline_locked() {
        // 收敛水位线锁定：保留策略常量达标后锁定，防回退（零 prod 改动）。
        assert_eq!(KEEP_DAYS, 14);
        assert_eq!(MAX_TOTAL_BYTES, 25 * 1024 * 1024);
        assert_eq!(MAX_SINGLE_FILE_BYTES, 5 * 1024 * 1024);
        assert_eq!(ROTATION_KEEP_COUNT, 5);
        // 脱敏基础能力不 panic（字符边界安全，含宽字符）。
        let out = redact("Bearer 汉字token测试 abc");
        assert!(out.contains("***"));
        assert!(!out.contains("汉字token测试"));
    }

    #[test]
    fn test_redact_bearer() {
        let out = redact("call with Bearer abc123xyz ok");
        assert!(out.contains("Bearer ***"));
        assert!(!out.contains("abc123xyz"));
    }

    #[test]
    fn test_redact_email_code_apikey() {
        let out = redact("contact user@example.com code=secret123 ok");
        assert!(out.contains("***@***"));
        assert!(!out.contains("user@example.com"));
        assert!(!out.contains("secret123"));
        let out2 = redact(r#"{"code":"abcd-1234","api_key":"sk-live-999"}"#);
        assert!(!out2.contains("abcd-1234"));
        assert!(!out2.contains("sk-live-999"));
        assert!(out2.contains("code"));
        let out3 = redact("device_code=DC-999 user_code=UC-111 api-key=AK-222");
        assert!(!out3.contains("DC-999"));
        assert!(!out3.contains("UC-111"));
        assert!(!out3.contains("AK-222"));
    }

    #[test]
    fn test_redact_unicode_boundary_safe() {
        // 宽字符 + emoji 混合，截断/替换不断裂，不 panic。
        let s: String = std::iter::repeat('汉').take(200).collect::<String>()
            + " user@test.com Bearer tok 汉😀";
        let out = redact(&s);
        assert!(out.contains("***@***"));
        assert!(out.contains("Bearer ***"));
        assert!(!out.contains("user@test.com"));
        // 切片仍为合法 UTF-8（chars 计数可遍历即不断裂）。
        assert!(out.chars().count() > 0);
    }

    #[test]
    fn test_level_override_parse() {
        // ZSTORE_LOG / RUST_LOG 覆盖解析锁定：双 cfg 分支共用。
        assert_eq!(parse_level_str("debug"), Some(log::LevelFilter::Debug));
        assert_eq!(parse_level_str("Z_STORE_LIB=DEBUG"), Some(log::LevelFilter::Debug));
        assert_eq!(parse_level_str("warn"), Some(log::LevelFilter::Warn));
        assert_eq!(parse_level_str("off"), Some(log::LevelFilter::Off));
        assert_eq!(parse_level_str("nonsense"), None);
        // resolve 在任何环境下不 panic 且恒为合法级别。
        let lv = resolve_level(log::LevelFilter::Info);
        assert!(matches!(
            lv,
            log::LevelFilter::Trace
                | log::LevelFilter::Debug
                | log::LevelFilter::Info
                | log::LevelFilter::Warn
                | log::LevelFilter::Error
                | log::LevelFilter::Off
        ));
    }

    #[test]
    fn test_redact_vscode_url_preserved() {
        // 回归：`vscode` 路径段内的 `code` 子串不得触发键值脱敏。
        let u1 = "https://api.github.com/repos/microsoft/vscode/releases/latest";
        let out1 = redact(u1);
        assert_eq!(out1, u1, "vscode path must stay verbatim");
        assert!(!out1.contains("***"));
        let u2 = "https://update.code.visualstudio.com/api/update/win32-x64/stable/latest";
        let out2 = redact(u2);
        assert_eq!(out2, u2, "visualstudio update path must stay verbatim");
        assert!(!out2.contains("***"));
        // 真正的键值仍需脱敏。
        let out3 = redact("fetch ok code=secret123 done");
        assert!(!out3.contains("secret123"));
        assert!(out3.contains("***"));
    }

    #[test]
    fn test_sid_req_prefix() {
        // 空值整体省略，行首干净。
        assert_eq!(prefix_sid_req("", ""), "");
        assert_eq!(prefix_sid_req("s1", ""), "[sid=s1]");
        assert_eq!(prefix_sid_req("", "a1"), "[req=a1]");
        assert_eq!(prefix_sid_req("s1", "a1"), "[sid=s1][req=a1]");
        // sid 进程级稳定，req 短 ID 非空且互异（线程级隔离天然成立）。
        assert_eq!(new_session_id(), new_session_id());
        let r1 = new_req_id();
        assert_eq!(r1.len(), 8);
        assert_eq!(current_req_id(), r1);
        clear_req_id();
        assert_eq!(current_req_id(), "");
        set_req_id("q9");
        assert_eq!(current_req_id(), "q9");
        clear_req_id();
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
