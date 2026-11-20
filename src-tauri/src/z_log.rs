//! 统一日志模块：按 14 天 / 25MB / 单文件 5MB 滚动写入 LogDir（dev 模式附加 Stdout 与 Webview）。

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

/// 级别短标签（等宽 3 字符，方便对齐扫读）。
pub fn short_level(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "ERR",
        log::Level::Warn => "WRN",
        log::Level::Info => "INF",
        log::Level::Debug => "DBG",
        log::Level::Trace => "TRC",
    }
}

/// 将 Webview 前端消息中的已知子标签提取为规范 `(domain_tag, prefix, body)`，
/// 消除 `[LVL][ui] [trends] ...` / `[LVL][ui] [onerror] ...` 重复方括号前缀。
pub fn resolve_webview_tag_and_body(msg: &str) -> (&'static str, &'static str, &str) {
    if let Some(rest) = msg.strip_prefix("[trends] ") {
        return ("trends", "", rest);
    }
    for (bracketed, plain) in [
        ("[onerror] ", "onerror "),
        ("[unhandledrejection] ", "unhandledrejection "),
        ("[ipc-args] ", "ipc-args "),
        ("[demo-mock] ", "demo-mock "),
    ] {
        if let Some(rest) = msg.strip_prefix(bracketed) {
            return ("ui", plain, rest);
        }
    }
    ("ui", "", msg)
}

/// 将 Rust 模块路径与 Webview 目标统一映射为紧凑领域标签。
pub fn domain_tag(target: &str) -> &str {
    if target.starts_with("webview") {
        return "ui";
    }
    let stripped = target
        .strip_prefix("zstore_lib::")
        .or_else(|| target.strip_prefix("z_store::"))
        .unwrap_or(target);

    match stripped {
        "app" | "z_log" | "config" | "db::schema" | "lib" | "" | "commands::history"
        | "commands::system" => "app",
        "catalog"
        | "commands::catalog_sync"
        | "commands::catalog_custom"
        | "github::catalog_service"
        | "db::custom_apps" => "catalog",
        "launchpad" | "commands::launchpad" | "db::launchpad" | "github::discussions" => {
            "launchpad"
        }
        "search" | "commands::catalog_search" | "github::search" => "search",
        "detail"
        | "commands::catalog_detail"
        | "github::detail_fetch"
        | "github::readme_fetch"
        | "github::release_fetch"
        | "github::developer_profile"
        | "github::developer_starred"
        | "github::http" => "detail",
        "trends" => "trends",
        "download"
        | "commands::installer_download"
        | "installer::downloader_http"
        | "installer::downloader_progress" => "download",
        "installer"
        | "commands::installer_install"
        | "commands::installer_uninstall"
        | "commands::installer_query"
        | "installer::selector" => "installer",
        "updater" | "commands::updates_check" => "updater",
        "scanner" | "commands::scanner" => "scanner",
        "oauth" | "commands::oauth" => "oauth",
        "network" | "commands::network" | "mirror" => "network",
        "ui" => "ui",
        other => {
            if other.starts_with("forge::") {
                "detail"
            } else if other.starts_with("installer::executor") {
                "installer"
            } else if other.starts_with("oauth::") {
                "oauth"
            } else if other.starts_with("proxy::") {
                "network"
            } else if other.starts_with("icons::") {
                "detail"
            } else {
                other.rsplit("::").next().unwrap_or(other)
            }
        }
    }
}

/// 运行时是否处于诊断模式（Dev 默认 Debug，或 Release 通过 `ZSTORE_LOG=debug` 开启）。
pub fn is_dev_mode() -> bool {
    log::log_enabled!(log::Level::Debug)
}

/// 初始化日志插件（写盘前统一经 `redact` 脱敏，Release 仅写 LogDir，Dev 附加 Stdout 与 Webview）。
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};

    let format = time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
    let builder = Builder::default()
        .max_file_size(MAX_SINGLE_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(ROTATION_KEEP_COUNT))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .format(move |out, message, record| {
            let now = time::OffsetDateTime::now_local()
                .unwrap_or_else(|_| time::OffsetDateTime::now_utc());
            let clean = redact(&message.to_string());
            let (tag, prefix, body) = if record.target().starts_with("webview") {
                resolve_webview_tag_and_body(&clean)
            } else {
                (domain_tag(record.target()), "", clean.as_str())
            };
            out.finish(format_args!(
                "[{}][{}][{}] {}{}",
                now.format(&format).unwrap_or_default(),
                short_level(record.level()),
                tag,
                prefix,
                body
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

/// 会话 ID：进程级 `OnceLock` 生成一次，仅用于启动横幅。
static SESSION_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static TRACE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 进程级会话 ID：首次调用生成并冻结，后续调用返回同一值。
pub fn new_session_id() -> String {
    SESSION_ID
        .get_or_init(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            format!("s{:x}{:08x}", std::process::id(), nanos & 0xffff_ffff)
        })
        .clone()
}

/// 生成跨 `await` 显式传递的 6 位短链路 ID（无 TLS 串台风险）。
pub fn new_trace_id() -> String {
    use std::sync::atomic::Ordering;
    let n = TRACE_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{:02x}{:04x}", (nanos ^ n) & 0xff, n & 0xffff)
}

/// 宽事件单行构建器：一个业务操作只输出 1 行，Dev 模式在同行末尾追加诊断上下文。
pub struct WideEvent {
    tag: &'static str,
    action: String,
    started: Option<std::time::Instant>,
    core: Vec<(&'static str, String)>,
    dev: Vec<(&'static str, String)>,
    steps: Vec<String>,
    dev_enabled: bool,
}

impl WideEvent {
    pub fn new(tag: &'static str, action: impl Into<String>) -> Self {
        Self {
            tag,
            action: action.into(),
            started: None,
            core: Vec::new(),
            dev: Vec::new(),
            steps: Vec::new(),
            dev_enabled: is_dev_mode(),
        }
    }

    pub fn with_started(mut self, started: std::time::Instant) -> Self {
        self.started = Some(started);
        self
    }

    pub fn field(&mut self, k: &'static str, v: impl std::fmt::Display) -> &mut Self {
        self.core
            .push((k, crate::log_support::format_kv_value(&v.to_string())));
        self
    }

    pub fn field_opt<V: std::fmt::Display>(&mut self, k: &'static str, v: Option<V>) -> &mut Self {
        if let Some(val) = v {
            self.field(k, val);
        }
        self
    }

    pub fn dev(&mut self, k: &'static str, v: impl std::fmt::Display) -> &mut Self {
        if self.dev_enabled {
            self.dev
                .push((k, crate::log_support::format_kv_value(&v.to_string())));
        }
        self
    }

    pub fn dev_opt<V: std::fmt::Display>(&mut self, k: &'static str, v: Option<V>) -> &mut Self {
        if self.dev_enabled {
            if let Some(val) = v {
                self.dev(k, val);
            }
        }
        self
    }

    pub fn dev_url(&mut self, k: &'static str, raw_url: &str) -> &mut Self {
        if self.dev_enabled {
            let safe = crate::log_support::sanitize_url(raw_url);
            self.dev
                .push((k, format!("'{}'", safe.replace('\'', "\""))));
        }
        self
    }

    pub fn step(&mut self, s: impl Into<String>) -> &mut Self {
        if self.dev_enabled {
            let item = s.into();
            if !item.trim().is_empty() {
                self.steps.push(item);
            }
        }
        self
    }

    pub fn build_line(&self) -> String {
        let mut parts: Vec<String> = Vec::with_capacity(2 + self.core.len() + self.dev.len() + 2);
        parts.push(self.action.clone());
        for (k, v) in &self.core {
            parts.push(format!("{}={}", k, v));
        }
        if let Some(started) = self.started {
            parts.push(format!("ms={}", started.elapsed().as_millis()));
        }
        if self.dev_enabled {
            for (k, v) in &self.dev {
                parts.push(format!("{}={}", k, v));
            }
            if !self.steps.is_empty() {
                parts.push(format!("steps={}", self.steps.join(",")));
            }
        }
        parts.join(" ")
    }

    pub fn emit(self, level: log::Level) {
        let line = self.build_line();
        log::log!(target: self.tag, level, "{}", line);
    }

    pub fn info(self) {
        self.emit(log::Level::Info);
    }

    pub fn warn(self) {
        self.emit(log::Level::Warn);
    }

    pub fn error(self) {
        self.emit(log::Level::Error);
    }
}

/// 启动横幅上下文（在 `.plugin(z_log::init())` 之后的 `setup()` 中统一打印）。
pub struct StartupBanner<'a> {
    pub config_source: &'a str,
    pub proxy: &'a str,
    pub mirror: &'a str,
    pub strict_errors: bool,
    pub db_mode: &'a str,
}

/// 日志级别覆盖：`ZSTORE_LOG` 优先，`RUST_LOG` 兜底，均缺失时用编译期默认。
/// 解析大小写不敏感，接受 `debug` 与 `crate=debug` 形态；非法值回退默认。
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

/// 记录新会话启动横幅（包含版本、会话 ID、平台与运行环境摘要）。
pub fn log_startup_banner(banner: &StartupBanner<'_>) {
    let sid = new_session_id();
    let mut ev = WideEvent::new("app", format!("start v{}", env!("CARGO_PKG_VERSION")));
    ev.field("sid", sid)
        .field("os", std::env::consts::OS)
        .field("arch", std::env::consts::ARCH)
        .field("pid", std::process::id())
        .field("proxy", banner.proxy)
        .field("mirror", banner.mirror)
        .field("strict", banner.strict_errors)
        .dev("config", banner.config_source)
        .dev("db", banner.db_mode);
    ev.info();
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

/// 敏感键值脱敏（按键边界匹配，避免误伤路径段内子串如 `vscode`）。
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
            log::error!(target: "app", "panic {} at {}", redact(&payload), location);
            prev(info);
        }));
    });
}

/// 获取 LogDir 路径（前端设置页 / 问题反馈用）。
#[tauri::command]
pub fn zlog_get_dir(app: AppHandle) -> crate::AppResult<String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| crate::AppError::new(e.to_string()))?;
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().to_string())
}

fn write_log_bundle_zip(log_dir: &Path, out_path: &Path) -> Result<String, String> {
    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let out_file = std::fs::File::create(out_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(out_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let entries = std::fs::read_dir(log_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path == out_path {
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

/// 导出日志包：弹出系统保存文件对话框（默认目录指向 `LogDir`），把 `LogDir` 内日志脱敏打成 zip 并返回文件路径；取消时返回 `None`。
#[tauri::command]
pub async fn zlog_export_bundle(app: AppHandle) -> crate::AppResult<Option<String>> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| crate::AppError::new(e.to_string()))?;
    std::fs::create_dir_all(&log_dir)?;
    let stamp = crate::now_secs();
    let default_name = format!("zstore-logs-{}.zip", stamp);

    let res = tokio::task::spawn_blocking(move || {
        let picked = rfd::FileDialog::new()
            .set_directory(&log_dir)
            .set_file_name(&default_name)
            .add_filter("ZIP", &["zip"])
            .save_file();
        let Some(out_path) = picked else {
            return Ok(None);
        };
        write_log_bundle_zip(&log_dir, &out_path).map(Some)
    })
    .await
    .map_err(|e| crate::AppError::new(e.to_string()))?;
    Ok(res?)
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
        let s: String = "汉".repeat(200) + " user@test.com Bearer tok 汉😀";
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
        assert_eq!(
            parse_level_str("Z_STORE_LIB=DEBUG"),
            Some(log::LevelFilter::Debug)
        );
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
    fn test_domain_tags_trace_and_wide_event() {
        assert_eq!(short_level(log::Level::Info), "INF");
        assert_eq!(short_level(log::Level::Warn), "WRN");
        assert_eq!(short_level(log::Level::Error), "ERR");
        assert_eq!(short_level(log::Level::Debug), "DBG");

        assert_eq!(domain_tag("webview:home"), "ui");
        assert_eq!(domain_tag("zstore_lib::commands::catalog_detail"), "detail");
        assert_eq!(domain_tag("zstore_lib::commands::updates_check"), "updater");
        assert_eq!(
            domain_tag("zstore_lib::installer::downloader_http"),
            "download"
        );
        assert_eq!(domain_tag("zstore_lib::mirror"), "network");
        assert_eq!(domain_tag("zstore_lib::config"), "app");

        assert_eq!(
            resolve_webview_tag_and_body("[trends] board=daily error"),
            ("trends", "", "board=daily error")
        );
        assert_eq!(
            resolve_webview_tag_and_body("[onerror] boom @a.ts:1:1"),
            ("ui", "onerror ", "boom @a.ts:1:1")
        );
        assert_eq!(
            resolve_webview_tag_and_body("[unhandledrejection] rejected"),
            ("ui", "unhandledrejection ", "rejected")
        );
        assert_eq!(
            resolve_webview_tag_and_body("[ipc-args] snake_case key"),
            ("ui", "ipc-args ", "snake_case key")
        );
        assert_eq!(
            resolve_webview_tag_and_body("render crash: oops"),
            ("ui", "", "render crash: oops")
        );

        assert_eq!(new_session_id(), new_session_id());
        let t1 = new_trace_id();
        let t2 = new_trace_id();
        assert_eq!(t1.len(), 6);
        assert_ne!(t1, t2);

        let mut release_ev = WideEvent::new("detail", "fetch ok");
        release_ev.dev_enabled = false;
        release_ev
            .field("id", "kong/insomnia")
            .field("via", "network")
            .dev("rate", "56/60")
            .dev_url(
                "url",
                "https://api.github.com/repos/Kong/insomnia/releases/latest?token=abc",
            )
            .step("rel:200(10ms)")
            .step("repo:304(5ms)");
        let rel_line = release_ev.build_line();
        assert_eq!(rel_line, "fetch ok id=kong/insomnia via=network");

        let mut dev_ev = WideEvent::new("detail", "fetch ok");
        dev_ev.dev_enabled = true;
        dev_ev
            .field("id", "kong/insomnia")
            .field("via", "network")
            .dev("rate", "56/60")
            .dev_url(
                "url",
                "https://api.github.com/repos/Kong/insomnia/releases/latest?token=abc",
            )
            .step("rel:200(10ms)")
            .step("repo:304(5ms)");
        let dev_line = dev_ev.build_line();
        assert!(dev_line.contains("fetch ok id=kong/insomnia via=network"));
        assert!(dev_line.contains("rate=56/60"));
        assert!(dev_line.contains(
            "url='https://api.github.com/repos/Kong/insomnia/releases/latest?token=***'"
        ));
        assert!(dev_line.contains("steps=rel:200(10ms),repo:304(5ms)"));
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

    #[test]
    fn test_write_log_bundle_zip_redacts_logs() {
        use std::io::Read as _;
        let dir = std::env::temp_dir().join(format!(
            "zstore-log-bundle-test-{}-{}",
            std::process::id(),
            crate::now_secs()
        ));
        let log_dir = dir.join("logs");
        let out_zip = dir.join("picked").join("logs.zip");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("app.log"),
            b"auth Bearer secret_tok email user@example.com\n",
        )
        .unwrap();
        std::fs::write(log_dir.join("ignored.json"), b"{\"skip\":true}").unwrap();

        let written = write_log_bundle_zip(&log_dir, &out_zip).unwrap();
        assert_eq!(written, out_zip.to_string_lossy());

        let file = std::fs::File::open(&out_zip).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.by_name("ignored.json").is_err());
        assert!(archive.by_name("README.txt").is_ok());
        let mut log_body = String::new();
        archive
            .by_name("app.log")
            .unwrap()
            .read_to_string(&mut log_body)
            .unwrap();
        assert!(log_body.contains("Bearer ***"));
        assert!(log_body.contains("***@***"));
        assert!(!log_body.contains("secret_tok"));
        assert!(!log_body.contains("user@example.com"));
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
