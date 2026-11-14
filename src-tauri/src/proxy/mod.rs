//! 出站系统代理：运行期动态快照 + per-client `no_proxy` 豁免 + 按签名热重建连接池。
//!
//! - [`ProxySnapshot`] 描述某一时刻生效的系统代理：启动期捕获的外部 env
//!   （`INITIAL_ENV_PROXY`，只读一次、永不写回进程 env）优先，其次实时读取 OS 配置
//!   （Windows 注册表 / Linux GNOME `gsettings` / macOS `scutil --proxy`）。
//! - [`current_proxy_snapshot`] 带 5 秒采样冷却；传输层连接失败/超时时经
//!   [`invalidate_proxy_snapshot`] / [`refresh_after_transport_error`] 立即重探，
//!   使运行中开启、关闭或切换系统代理无需重启即可生效。
//! - 所有 `reqwest::Client` 经 [`apply_proxy_snapshot`] 挂载代理：直连快照显式
//!   `builder.no_proxy()`（禁止 reqwest 自行回落读取 OS 代理），有代理时逐 scheme
//!   挂载并附加合并 `NoProxy`（env `NO_PROXY` + OS 绕过列表 + 默认豁免 + `extra_hosts`）。
//! - 长生命周期连接池经 [`ClientSlot`] 以「代理签名 + 构建参数」为键缓存：签名不变
//!   100% 复用连接池，签名变化时原子重建。
//! - 默认豁免：`gh-proxy.com`（镜像直连）+ `localhost/127.0.0.1/::1`。调用方（下载器、
//!   测速、趋势直连首跳）经 `extra_hosts` 追加需直连的 host。
//! - 日志只记 host（脱敏），永不记 query/凭证；签名串可能含代理凭证，只作缓存键不落日志。

#[cfg(target_os = "linux")]
pub mod linux;
pub mod macos;
pub mod windows;

use reqwest::{ClientBuilder, NoProxy, Proxy};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 镜像默认 host（直连豁免，见 `mirror::DEFAULT_GH_PROXY`）。
pub const GH_PROXY_HOST: &str = "gh-proxy.com";
/// 趋势 doforce host：直连优先、失败经系统代理回退（见 `commands::network::fetch_trends_text`）。
pub const TREND_HOST: &str = "trend.doforce.dpdns.org";
/// 系统代理快照采样冷却：冷却内高频请求直接命中内存快照，零注册表/子进程开销。
pub const PROXY_CACHE_TTL_MS: u64 = 5_000;

/// 某一时刻生效的系统代理配置（纯数据，可比较）。
/// 系统代理快照的来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProxySource {
    /// 启动期外部终端 env。
    Env,
    /// Windows 注册表 Internet Settings。
    Windows,
    /// Linux GNOME `gsettings`。
    Gnome,
    /// macOS `scutil --proxy`。
    MacOs,
    /// 无代理（直连）。
    #[default]
    None,
}

impl ProxySource {
    /// 日志 / 摘要用短名。
    pub fn as_str(self) -> &'static str {
        match self {
            ProxySource::Env => "env",
            ProxySource::Windows => "win",
            ProxySource::Gnome => "gnome",
            ProxySource::MacOs => "macos",
            ProxySource::None => "none",
        }
    }
}

impl std::fmt::Display for ProxySource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProxySnapshot {
    pub http: Option<String>,
    pub https: Option<String>,
    pub all: Option<String>,
    /// 来源侧绕过列表（env `NO_PROXY` / Windows `ProxyOverride` / GNOME `ignore-hosts` /
    /// macOS `ExceptionsList`），已归一为 `reqwest::NoProxy` 可解析形态。
    pub no_proxy_entries: Vec<String>,
    pub source: ProxySource,
}

impl ProxySnapshot {
    /// 直连快照（无任何代理）。
    pub fn direct() -> Self {
        Self::default()
    }

    /// http scheme 实际生效的代理（`http` 缺省回退 `all`）。
    pub fn http_effective(&self) -> Option<&str> {
        self.http.as_deref().or(self.all.as_deref())
    }

    /// https scheme 实际生效的代理（`https` 缺省回退 `all`）。
    pub fn https_effective(&self) -> Option<&str> {
        self.https.as_deref().or(self.all.as_deref())
    }

    pub fn has_proxy(&self) -> bool {
        self.http_effective().is_some() || self.https_effective().is_some()
    }

    /// 脱敏摘要（启动横幅与变更日志用）：`win(127.0.0.1)` / `none`，只含 host。
    pub fn summary(&self) -> String {
        if !self.has_proxy() {
            return "none".to_string();
        }
        let host = self
            .https_effective()
            .or(self.http_effective())
            .and_then(host_of_url)
            .unwrap_or_else(|| "unknown".to_string());
        format!("{}({})", self.source, host)
    }

    /// 确定性签名：http/https/all 生效值 + 合并后 `no_proxy`。相同签名即可复用同一连接池。
    pub fn signature(&self, extra_hosts: &[String]) -> String {
        format!(
            "http={}|https={}|all={}|np={}",
            self.http.as_deref().unwrap_or(""),
            self.https.as_deref().unwrap_or(""),
            self.all.as_deref().unwrap_or(""),
            merged_no_proxy_for(self, extra_hosts)
        )
    }
}

/// 默认 `no_proxy` 豁免条目（静态部分，不含动态镜像 host）。
pub fn default_no_proxy_entries() -> Vec<String> {
    vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
        GH_PROXY_HOST.to_string(),
    ]
}

/// 单地址代理归一（Windows 注册表 / Linux GNOME / macOS 共用落点）：
/// 接受 `host:port`（含 `user:pass@host:port` 鉴权形态）或自带 scheme；
/// 仅 `http://`、`https://`、`socks5://`、`socks5h://`、`socks4://`、`socks4a://`
/// （大小写不敏感，必须带 `://`）保留原值，其余含 `:` 的补 `http://`；
/// 无 scheme、无 `:` 的裸词（含 `socks4` 前缀但缺 `://` 的垃圾输入）一律拒绝，
/// 返回 `None`（调用方视为未配置，保持直连）。
pub fn normalize_single_proxy_addr(raw: &str) -> Option<String> {
    let addr = raw.trim();
    if addr.is_empty() {
        return None;
    }
    let lower = addr.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
        || lower.starts_with("socks4://")
        || lower.starts_with("socks4a://")
    {
        Some(addr.to_string())
    } else if addr.contains(':') {
        Some(format!("http://{}", addr))
    } else {
        None
    }
}

/// 绕过列表条目归一（Windows `ProxyOverride` / macOS `ExceptionsList` 共用）：
/// `*.corp.local` → `.corp.local`；其余含 `*` 的通配（如 `192.168.*`）`NoProxy` 无法解析，跳过；
/// 单独的 `*` 保留（`NoProxy` 语义为全部直连）。
pub(crate) fn normalize_bypass_entry(raw: &str) -> Option<String> {
    let t = raw.trim().trim_matches('"').trim();
    if t.is_empty() {
        return None;
    }
    if t == "*" {
        return Some("*".to_string());
    }
    let t = t.strip_prefix('*').unwrap_or(t);
    if t.contains('*') || t.is_empty() || t == "." {
        return None;
    }
    Some(t.to_string())
}

/// 取 URL 的 host（小写），失败返回 `None`（不回显完整 URL/query）。
pub fn host_of_url(url: &str) -> Option<String> {
    let h = crate::log_support::host_of(url);
    if h.is_empty() || h == "unknown" {
        None
    } else {
        Some(h)
    }
}

/// host→`extra_hosts` 收敛 helper（单一来源）：URL host 转 per-client `no_proxy` extra。
/// 空/`unknown`/解析失败返回空 `Vec`（调用方不追加豁免），无全局副作用。
pub fn proxy_hosts_for(url: &str) -> Vec<String> {
    match host_of_url(url) {
        Some(h) => vec![h],
        None => Vec::new(),
    }
}

fn split_no_proxy_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn env_non_empty(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// 从进程 env 读取代理（纯读取，不写回）。无任何代理 URL 时 `source = "none"`，
/// 但仍保留 `NO_PROXY` 条目供合并。
fn read_env_proxy() -> ProxySnapshot {
    let http = env_non_empty(&["HTTP_PROXY", "http_proxy"]);
    let https = env_non_empty(&["HTTPS_PROXY", "https_proxy"]);
    let all = env_non_empty(&["ALL_PROXY", "all_proxy"]);
    let mut no_proxy_entries = Vec::new();
    for raw in [
        std::env::var("NO_PROXY").unwrap_or_default(),
        std::env::var("no_proxy").unwrap_or_default(),
    ] {
        no_proxy_entries.extend(split_no_proxy_list(&raw));
    }
    let has_url = http.is_some() || https.is_some() || all.is_some();
    ProxySnapshot {
        http,
        https,
        all,
        no_proxy_entries,
        source: if has_url {
            ProxySource::Env
        } else {
            ProxySource::None
        },
    }
}

static INITIAL_ENV_PROXY: OnceLock<ProxySnapshot> = OnceLock::new();

/// 启动期外部 env 代理（终端显式 export 的 `HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY`）。
/// 首次调用时读取并冻结；进程 env 此后不再参与求值，也从不被本模块写入。
fn initial_env_proxy() -> &'static ProxySnapshot {
    INITIAL_ENV_PROXY.get_or_init(read_env_proxy)
}

/// 在 `setup()` 最早期调用：冻结启动 env 代理，返回首个快照的脱敏摘要（启动横幅用）。
pub fn capture_initial_env_proxy() -> String {
    let _ = initial_env_proxy();
    current_proxy_snapshot().summary()
}

/// OS 实时系统代理读取（不含 env）。
fn probe_os_proxy() -> ProxySnapshot {
    #[cfg(target_os = "windows")]
    {
        windows::read_windows_proxy()
    }
    #[cfg(target_os = "linux")]
    {
        linux::read_linux_proxy()
    }
    #[cfg(target_os = "macos")]
    {
        macos::read_macos_proxy()
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        ProxySnapshot::direct()
    }
}

/// 实时探测：启动 env 有代理 URL 时恒用之（用户显式意图），否则读 OS 系统代理。
pub fn probe_system_proxy() -> ProxySnapshot {
    let env = initial_env_proxy();
    if env.has_proxy() {
        return env.clone();
    }
    probe_os_proxy()
}

struct ProxyCache {
    probed_at: Option<Instant>,
    snap: Option<ProxySnapshot>,
    /// 后台重探在途（同一时刻至多一个探测线程）。
    refreshing: bool,
}

impl ProxyCache {
    const fn empty() -> Self {
        Self {
            probed_at: None,
            snap: None,
            refreshing: false,
        }
    }
}

static PROXY_CACHE: Mutex<ProxyCache> = Mutex::new(ProxyCache::empty());

fn lock_cache(cache: &Mutex<ProxyCache>) -> std::sync::MutexGuard<'_, ProxyCache> {
    match cache.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

enum CacheRead {
    Fresh(ProxySnapshot),
    /// 过期快照照常返回；`spawn_refresh` 为真时由调用方发起后台重探（已置在途标记）。
    Stale {
        snap: ProxySnapshot,
        spawn_refresh: bool,
    },
    Empty,
}

/// 读缓存（只持锁做内存读写，绝不在锁内探测）。
fn read_cache(cache: &Mutex<ProxyCache>, now: Instant) -> CacheRead {
    let mut g = lock_cache(cache);
    let Some(snap) = g.snap.clone() else {
        return CacheRead::Empty;
    };
    let fresh = g
        .probed_at
        .is_some_and(|at| now.duration_since(at) < Duration::from_millis(PROXY_CACHE_TTL_MS));
    if fresh {
        return CacheRead::Fresh(snap);
    }
    let spawn_refresh = !g.refreshing;
    g.refreshing = true;
    CacheRead::Stale {
        snap,
        spawn_refresh,
    }
}

/// 写入探测结果并清在途标记；返回代理签名是否相对上一快照变化（变化时记一行 `proxy changed`）。
fn store_probe(cache: &Mutex<ProxyCache>, fresh: ProxySnapshot) -> bool {
    let mut g = lock_cache(cache);
    let changed = g
        .snap
        .as_ref()
        .is_some_and(|prev| prev.signature(&[]) != fresh.signature(&[]));
    if changed {
        if let Some(prev) = g.snap.as_ref() {
            let mut ev = crate::z_log::WideEvent::new("network", "proxy changed");
            ev.field("from", prev.summary()).field("to", fresh.summary());
            ev.info();
        }
    }
    g.probed_at = Some(Instant::now());
    g.snap = Some(fresh);
    g.refreshing = false;
    changed
}

/// 后台线程重探（注册表 / `gsettings` / `scutil` 均为同步阻塞调用，不占 async 工作线程）。
fn spawn_background_probe() {
    let spawned = std::thread::Builder::new()
        .name("zstore-proxy-probe".to_string())
        .spawn(|| match std::panic::catch_unwind(probe_system_proxy) {
            Ok(fresh) => {
                store_probe(&PROXY_CACHE, fresh);
            }
            Err(_) => lock_cache(&PROXY_CACHE).refreshing = false,
        });
    if spawned.is_err() {
        lock_cache(&PROXY_CACHE).refreshing = false;
    }
}

/// 当前生效的系统代理快照（5 秒采样冷却，过期即返回旧快照并后台重探）。
/// 仅进程内首次调用（`setup()` 内 `capture_initial_env_proxy`）同步探测；签名变化记 `network/proxy changed`。
pub fn current_proxy_snapshot() -> ProxySnapshot {
    match read_cache(&PROXY_CACHE, Instant::now()) {
        CacheRead::Fresh(snap) => snap,
        CacheRead::Stale {
            snap,
            spawn_refresh,
        } => {
            if spawn_refresh {
                spawn_background_probe();
            }
            snap
        }
        CacheRead::Empty => {
            let fresh = probe_system_proxy();
            store_probe(&PROXY_CACHE, fresh.clone());
            fresh
        }
    }
}

/// 失效快照缓存：下一次 [`current_proxy_snapshot`] 触发后台重探。
pub fn invalidate_proxy_snapshot() {
    lock_cache(&PROXY_CACHE).probed_at = None;
}

/// 传输层连接失败/超时后调用：经 `spawn_blocking` 立即重探并写回，返回代理签名是否变化
/// （变化时调用方应改用同一连接池的新 Client 重试，以感知用户刚开启/关闭的系统代理）。
pub async fn refresh_after_transport_error() -> bool {
    match tokio::task::spawn_blocking(probe_system_proxy).await {
        Ok(fresh) => store_probe(&PROXY_CACHE, fresh),
        Err(_) => false,
    }
}

/// 合并 `no_proxy`：启动 env `NO_PROXY` + 快照绕过列表 + 默认豁免 + `extra_hosts`，
/// 大小写不敏感去重，保留首次出现顺序。
pub fn merged_no_proxy_for(snap: &ProxySnapshot, extra_hosts: &[String]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |s: &str| {
        let t = s.trim();
        if t.is_empty() || t.eq_ignore_ascii_case("unknown") {
            return;
        }
        if seen.insert(t.to_ascii_lowercase()) {
            out.push(t.to_string());
        }
    };
    for e in &initial_env_proxy().no_proxy_entries {
        push(e);
    }
    for e in &snap.no_proxy_entries {
        push(e);
    }
    for e in default_no_proxy_entries() {
        push(&e);
    }
    for e in extra_hosts {
        push(e);
    }
    out.join(",")
}

/// 按快照挂载代理。
///
/// - 直连快照：显式 `builder.no_proxy()`，关闭 reqwest 内部系统代理自动读取，
///   确保系统代理关闭后立即回到纯直连；
/// - 有代理：逐 scheme 挂载 `Proxy::http` / `Proxy::https`（缺省回退 `all`），附加合并
///   `NoProxy`；非法代理 URL 记 warn 后跳过该 scheme（该 scheme 直连）。
pub fn apply_proxy_snapshot(
    builder: ClientBuilder,
    snap: &ProxySnapshot,
    extra_hosts: &[String],
) -> ClientBuilder {
    // 先关闭自动系统代理：即便下方某 scheme 代理 URL 非法被跳过，也不回落读取 OS 配置。
    let mut builder = builder.no_proxy();
    if !snap.has_proxy() {
        return builder;
    }
    let no_proxy = NoProxy::from_string(&merged_no_proxy_for(snap, extra_hosts));
    if let Some(url) = snap.http_effective() {
        match Proxy::http(url.trim()) {
            Ok(p) => builder = builder.proxy(p.no_proxy(no_proxy.clone())),
            Err(e) => log::warn!(
                target: "network",
                "proxy http invalid source={} reason={}",
                snap.source,
                crate::log_support::short_reason(&e.to_string())
            ),
        }
    }
    if let Some(url) = snap.https_effective() {
        // http/https 同值时仍需双挂载（`Proxy::http` 只拦截 http，`Proxy::https` 只拦截 https）。
        match Proxy::https(url.trim()) {
            Ok(p) => builder = builder.proxy(p.no_proxy(no_proxy.clone())),
            Err(e) => log::warn!(
                target: "network",
                "proxy https invalid source={} reason={}",
                snap.source,
                crate::log_support::short_reason(&e.to_string())
            ),
        }
    }
    builder
}

/// 以当前快照挂载代理（一次性 Client 构建用；长生命周期连接池请用 [`ClientSlot`]）。
pub fn apply_proxy(builder: ClientBuilder, extra_hosts: &[String]) -> ClientBuilder {
    apply_proxy_snapshot(builder, &current_proxy_snapshot(), extra_hosts)
}

/// 连接池构建失败时的兜底 Client：仍按快照挂载代理（不回落 reqwest 自行读取 OS 代理），
/// 连代理都挂不上时退为显式直连。
pub fn fallback_client(snap: &ProxySnapshot, extra_hosts: &[String]) -> reqwest::Client {
    apply_proxy_snapshot(reqwest::Client::builder(), snap, extra_hosts)
        .build()
        .or_else(|_| reqwest::Client::builder().no_proxy().build())
        .unwrap_or_default()
}

/// 传输层错误记账：连接失败或超时即失效快照，下一次取池时重探系统代理。
pub fn note_transport_error(e: &reqwest::Error) {
    if e.is_connect() || e.is_timeout() {
        invalidate_proxy_snapshot();
    }
}

/// 按键缓存的单 Client 槽位：键（代理签名 + 构建参数）不变时复用连接池，变化时重建。
#[derive(Default)]
pub struct ClientSlot {
    inner: Mutex<Option<(String, reqwest::Client)>>,
    builds: AtomicU64,
}

impl ClientSlot {
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            builds: AtomicU64::new(0),
        }
    }

    /// 键命中即返回缓存 Client；否则调用 `build` 构建并替换。构建失败不污染槽位。
    pub fn get_or_build<F>(&self, key: &str, build: F) -> Result<reqwest::Client, String>
    where
        F: FnOnce() -> Result<reqwest::Client, String>,
    {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some((k, c)) = guard.as_ref() {
            if k == key {
                return Ok(c.clone());
            }
        }
        let client = build()?;
        self.builds.fetch_add(1, Ordering::Relaxed);
        *guard = Some((key.to_string(), client.clone()));
        Ok(client)
    }

    /// 累计构建次数（复用/重建可观测性，测试断言用）。
    pub fn build_count(&self) -> u64 {
        self.builds.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{proxied_snapshot, serve, Reply};

    fn proxied(url: &str) -> ProxySnapshot {
        ProxySnapshot {
            no_proxy_entries: vec![".corp.local".to_string()],
            ..proxied_snapshot(url)
        }
    }

    #[test]
    fn test_merged_no_proxy_contains_defaults() {
        let merged = merged_no_proxy_for(&ProxySnapshot::direct(), &[]);
        let lower = merged.to_ascii_lowercase();
        assert!(lower.contains("gh-proxy.com"), "merged={}", merged);
        assert!(lower.contains("localhost"), "merged={}", merged);
        assert!(lower.contains("127.0.0.1"), "merged={}", merged);
    }

    #[test]
    fn test_default_no_proxy_excludes_trend_host() {
        // 趋势源直连优先、失败经系统代理回退：不得出现在全局默认豁免中。
        assert!(!default_no_proxy_entries()
            .iter()
            .any(|e| e.eq_ignore_ascii_case(TREND_HOST)));
    }

    #[test]
    fn test_merged_no_proxy_extra_snapshot_and_dedup() {
        let extra = vec!["Mirror.Example.COM".to_string(), "gh-proxy.com".to_string()];
        let merged = merged_no_proxy_for(&proxied("http://127.0.0.1:7890"), &extra);
        let lower = merged.to_ascii_lowercase();
        assert!(lower.contains("mirror.example.com"), "merged={}", merged);
        assert!(lower.contains(".corp.local"), "merged={}", merged);
        assert_eq!(lower.matches("gh-proxy.com").count(), 1, "merged={}", merged);
        // 空/unknown 豁免不入列。
        let merged2 = merged_no_proxy_for(
            &ProxySnapshot::direct(),
            &["".to_string(), "unknown".to_string()],
        );
        assert!(!merged2.to_ascii_lowercase().contains("unknown"));
    }

    #[test]
    fn test_snapshot_has_proxy_summary_and_fallback_to_all() {
        let d = ProxySnapshot::direct();
        assert!(!d.has_proxy());
        assert_eq!(d.summary(), "none");

        let s = proxied("http://user:pass@127.0.0.1:7890");
        assert!(s.has_proxy());
        // 摘要只含 host，不含凭证。
        assert_eq!(s.summary(), "win(127.0.0.1)");

        let socks_only = ProxySnapshot {
            all: Some("socks5h://127.0.0.1:7891".to_string()),
            source: ProxySource::MacOs,
            ..ProxySnapshot::default()
        };
        assert_eq!(socks_only.http_effective(), Some("socks5h://127.0.0.1:7891"));
        assert_eq!(socks_only.https_effective(), Some("socks5h://127.0.0.1:7891"));
        assert!(socks_only.has_proxy());
    }

    #[test]
    fn test_signature_is_deterministic_and_sensitive() {
        let a = proxied("http://127.0.0.1:7890");
        let b = proxied("http://127.0.0.1:7890");
        assert_eq!(a.signature(&[]), b.signature(&[]));
        assert_ne!(a.signature(&[]), proxied("http://127.0.0.1:7891").signature(&[]));
        assert_ne!(a.signature(&[]), ProxySnapshot::direct().signature(&[]));
        assert_ne!(
            a.signature(&[]),
            a.signature(&["mirror.example.com".to_string()])
        );
    }

    #[test]
    fn test_normalize_bypass_entry() {
        assert_eq!(normalize_bypass_entry("*.corp.local"), Some(".corp.local".to_string()));
        assert_eq!(normalize_bypass_entry(" example.com "), Some("example.com".to_string()));
        assert_eq!(normalize_bypass_entry("*"), Some("*".to_string()));
        assert_eq!(normalize_bypass_entry("192.168.*"), None);
        assert_eq!(normalize_bypass_entry("10.*.0.1"), None);
        assert_eq!(normalize_bypass_entry(""), None);
        assert_eq!(normalize_bypass_entry("   "), None);
    }

    #[tokio::test]
    async fn test_apply_proxy_snapshot_direct_disables_system_proxy() {
        // 直连快照必须直达目标服务器，不回落系统/env 代理。
        let server = serve(|_| Reply::ok("ok")).await;
        let client = apply_proxy_snapshot(
            reqwest::Client::builder().timeout(Duration::from_secs(5)),
            &ProxySnapshot::direct(),
            &[],
        )
        .build()
        .unwrap();
        let body = client
            .get(format!("{}/", server.base))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "ok");
    }

    #[tokio::test]
    async fn test_apply_proxy_snapshot_routes_through_proxy_except_no_proxy() {
        // 「代理」服务器收到绝对 URI 请求即证明经代理转发；目标 host 不可达。
        let proxy = serve(|req| {
            if req.starts_with("GET http://example.invalid/") {
                Reply::ok("via-proxy")
            } else {
                Reply::ok("unexpected")
            }
        })
        .await;
        let snap = proxied_snapshot(&proxy.base);
        let client = apply_proxy_snapshot(
            reqwest::Client::builder().timeout(Duration::from_secs(5)),
            &snap,
            &[],
        )
        .build()
        .unwrap();
        let body = client
            .get("http://example.invalid/x")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "via-proxy");
    }

    #[test]
    fn test_client_slot_reuses_on_same_key_and_rebuilds_on_change() {
        let slot = ClientSlot::new();
        let build = || Ok(reqwest::Client::new());
        slot.get_or_build("a", build).unwrap();
        slot.get_or_build("a", build).unwrap();
        assert_eq!(slot.build_count(), 1);
        slot.get_or_build("b", build).unwrap();
        assert_eq!(slot.build_count(), 2);
        slot.get_or_build("b", build).unwrap();
        assert_eq!(slot.build_count(), 2);
        // 构建失败不污染槽位。
        assert!(slot.get_or_build("c", || Err("x".to_string())).is_err());
        slot.get_or_build("b", build).unwrap();
        assert_eq!(slot.build_count(), 2);
    }

    #[tokio::test]
    async fn test_current_snapshot_cached_and_invalidated() {
        let a = current_proxy_snapshot();
        let b = current_proxy_snapshot();
        assert_eq!(a, b);
        invalidate_proxy_snapshot();
        // 失效后仍立即返回（旧快照 + 后台重探），不阻塞、不死锁。
        let _ = current_proxy_snapshot();
        // 测试期 OS 配置不变：立即重探签名不变。
        assert!(!refresh_after_transport_error().await);
    }

    #[test]
    fn test_cache_read_is_stale_while_revalidate_and_store_detects_change() {
        let cache = Mutex::new(ProxyCache::empty());
        let t0 = Instant::now();
        assert!(matches!(read_cache(&cache, t0), CacheRead::Empty));

        let proxied = proxied_snapshot("http://127.0.0.1:7890");
        // 首次写入不算变化；同签名不算变化；签名变化才算。
        assert!(!store_probe(&cache, ProxySnapshot::direct()));
        assert!(!store_probe(&cache, ProxySnapshot::direct()));
        assert!(matches!(read_cache(&cache, Instant::now()), CacheRead::Fresh(_)));

        // 过期：返回旧快照，仅第一个读者负责发起后台重探。
        let later = Instant::now() + Duration::from_millis(PROXY_CACHE_TTL_MS + 1);
        match read_cache(&cache, later) {
            CacheRead::Stale { snap, spawn_refresh } => {
                assert_eq!(snap, ProxySnapshot::direct());
                assert!(spawn_refresh);
            }
            _ => panic!("expected stale"),
        }
        assert!(matches!(
            read_cache(&cache, later),
            CacheRead::Stale { spawn_refresh: false, .. }
        ));
        assert!(store_probe(&cache, proxied.clone()));
        match read_cache(&cache, Instant::now()) {
            CacheRead::Fresh(s) => assert_eq!(s, proxied),
            _ => panic!("expected fresh"),
        }
    }

    #[test]
    fn test_host_of_url_masks_query() {
        let h = host_of_url("https://gh-proxy.com/https://github.com/o/r?token=secret");
        assert_eq!(h.as_deref(), Some("gh-proxy.com"));
        assert_eq!(host_of_url(""), None);
    }

    #[test]
    fn test_proxy_hosts_for_single_source() {
        assert_eq!(
            proxy_hosts_for("https://gh-proxy.com/https://github.com/o/r"),
            vec!["gh-proxy.com".to_string()]
        );
        assert!(proxy_hosts_for("").is_empty());
        assert!(proxy_hosts_for("   ").is_empty());
    }

    #[test]
    fn test_normalize_single_proxy_addr_shared() {
        assert_eq!(
            normalize_single_proxy_addr("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_single_proxy_addr("socks5h://127.0.0.1:7890"),
            Some("socks5h://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_single_proxy_addr("user:pass@127.0.0.1:7890"),
            Some("http://user:pass@127.0.0.1:7890".to_string())
        );
        assert_eq!(normalize_single_proxy_addr(""), None);
        assert_eq!(normalize_single_proxy_addr("notaproxy"), None);
        assert_eq!(normalize_single_proxy_addr("socks4junk"), None);
        assert_eq!(
            normalize_single_proxy_addr("socks4a://127.0.0.1:7890"),
            Some("socks4a://127.0.0.1:7890".to_string())
        );
    }
}
