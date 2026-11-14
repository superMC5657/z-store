# Issue 01: Dynamic System Proxy Snapshot & Hot-Reloadable HTTP Client Pools

Status: resolved
Blocked by: none

## Summary

Replace the startup-only environment-mutating proxy initialization and permanently frozen `OnceLock<reqwest::Client>` pools with a thread-safe, cross-platform **Dynamic System Proxy Snapshot** (`ProxySnapshot`) and signature-keyed hot-reloadable client pools.

Currently:
1. `init_windows_system_proxy` (`src-tauri/src/lib.rs:326`) and `init_linux_system_proxy` (`src-tauri/src/proxy/linux.rs:211`) run only once during `setup()` and call `std::env::set_var("http_proxy" / "https_proxy")`. Once written, `std::env::var` stays non-empty forever, locking out any runtime proxy toggle (turning Clash/v2rayN on after launch, turning it off mid-session, or changing ports).
2. macOS has no system proxy reader (`lib.rs:481` returns `"none"`), so `apply_proxy` cannot attach `NoProxy` exemptions on macOS unless terminal env vars were manually exported; Windows also ignores registry `ProxyOverride`.
3. `SHARED_HTTP_CLIENT`, `SHARED_API` (duplicate of `SHARED_HTTP_CLIENT`), `SHARED_ICON`, `CatalogService.client`, and `DOWNLOAD_CLIENTS` are static singletons built once and never refreshed when the OS proxy changes.

## Scope

- Allowed to modify / create:
  - `src-tauri/src/proxy/mod.rs`
  - `src-tauri/src/proxy/linux.rs`
  - `src-tauri/src/proxy/windows.rs` (new, extracted & enhanced from `lib.rs`)
  - `src-tauri/src/proxy/macos.rs` (new, `scutil --proxy` parser)
  - `src-tauri/src/forge/http.rs`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/github/http.rs`
  - `src-tauri/src/github/mod.rs` & `src-tauri/src/github/catalog_service.rs` (client accessor & proxy-aware refresh only)
  - `src-tauri/src/commands/catalog_detail.rs` & `src-tauri/src/commands/updates_check.rs` (if replacing `state.http` with `crate::shared_http_client()` or `state.http_client()`)
  - `src-tauri/src/installer/downloader_http.rs` (keying `DOWNLOAD_CLIENTS` by proxy signature + extra hosts only; do **not** change `proxy_hosts_for(download_url)` call site here — that belongs to Issue 02)
- Do not modify:
  - `src/*` (frontend files)
  - `src-tauri/src/mirror.rs`
  - `src-tauri/src/commands/network.rs`

## Implementation Details

### 1. Cross-platform `ProxySnapshot` without global `env::set_var` (`src-tauri/src/proxy/`)

- Define `ProxySnapshot`:
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq, Default)]
  pub struct ProxySnapshot {
      pub http: Option<String>,
      pub https: Option<String>,
      pub all: Option<String>,
      pub no_proxy_entries: Vec<String>,
      pub source: &'static str, // "env" | "win" | "gnome" | "macos" | "none"
  }
  ```
  - Provide `has_proxy(&self) -> bool`, `summary(&self) -> String` (for startup banner logging, e.g. `env(127.0.0.1)`, `win(127.0.0.1)`, `gnome(127.0.0.1)`, `macos(127.0.0.1)`, `none`), and deterministic `signature(&self, extra_hosts: &[String]) -> String`.
- **Startup external env capture (`capture_initial_env_proxy`)**:
  - Called once in `lib.rs::run` `setup()` before spawning async tasks. Reads `HTTP_PROXY`/`http_proxy`, `HTTPS_PROXY`/`https_proxy`, `ALL_PROXY`/`all_proxy`, `NO_PROXY`/`no_proxy` into `OnceLock<Option<ProxySnapshot>>` (`INITIAL_ENV_PROXY`), **never calling `std::env::set_var` in production code paths**.
- **OS live readers** (used when `INITIAL_ENV_PROXY` has no proxy URLs):
  - **Windows (`proxy/windows.rs`, `#[cfg(target_os = "windows")]` + cross-platform pure parser functions for unit tests)**:
    - Read `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`: `ProxyEnable`, `ProxyServer`, and `ProxyOverride`.
    - Preserve `normalize_windows_proxy_server` (`https` > `http` > other > plain). When `ProxyEnable == 0`, return a `"none"` snapshot so turning off system proxy immediately restores direct mode.
    - Parse `;`-separated `ProxyOverride` entries (pure helper `parse_windows_proxy_override(raw: &str) -> Vec<String>`): map `<local>` to `localhost`, `127.0.0.1`, `::1`; normalize leading `*.` wildcard prefixes (e.g. `*.corp.local` → `.corp.local`) for `reqwest::NoProxy::from_string`; skip bare IP wildcard patterns containing `*` that `NoProxy` cannot parse.
  - **Linux (`proxy/linux.rs`)**:
    - Refactor `init_linux_system_proxy` / `read_gnome_proxy` to return a `ProxySnapshot` without mutating process env vars. When `gsettings` mode is `"none"` or unsupported (`auto`), return a `"none"` snapshot (log the unsupported mode warning at most once per mode change).
  - **macOS (`proxy/macos.rs`, `#[cfg(target_os = "macos")]` + cross-platform pure `parse_scutil_proxy_output(text: &str) -> ProxySnapshot` for unit tests)**:
    - Run `scutil --proxy` and parse key-value pairs (`HTTPEnable` + `HTTPProxy`:`HTTPPort`, `HTTPSEnable` + `HTTPSProxy`:`HTTPSPort`, `SOCKSEnable` + `SOCKSProxy`:`SOCKSPort` normalized as `socks5h://host:port`, and `ExceptionsList { ... }` entries normalized like `*.local` → `.local`).
- **`apply_proxy_snapshot(builder: ClientBuilder, snap: &ProxySnapshot, extra_hosts: &[String]) -> ClientBuilder`**:
  - Merge `INITIAL_ENV_PROXY` `NO_PROXY` + `snap.no_proxy_entries` + `default_no_proxy_entries()` + `extra_hosts` (case-insensitive dedup).
  - If neither `http`/`https`/`all` is active on `snap`, call `builder.no_proxy()` explicitly so `reqwest` / `hyper-util` does **not** fall back to stale OS registry reads behind our back.
  - Otherwise mount `Proxy::http` and `Proxy::https` (with `all` as fallback for each scheme) carrying `.no_proxy(NoProxy::from_string(&merged))`. Keep `apply_proxy(builder, extra_hosts)` delegating to `apply_proxy_snapshot(builder, &current_proxy_snapshot(), extra_hosts)` so existing callers remain ergonomic.

### 2. Bounded 5-second cache & immediate invalidation on transport failure

- Cache `(Instant, ProxySnapshot)` behind a `Mutex` in `proxy/mod.rs` with `PROXY_CACHE_TTL = Duration::from_secs(5)`:
  - `current_proxy_snapshot() -> ProxySnapshot`: returns cached snapshot if `< 5s` old; otherwise re-probes OS settings and updates cache (emitting an `info` wide event `target: "network", "proxy changed"` with masked host summary whenever the active proxy signature changes!).
  - `invalidate_proxy_snapshot()`: clears the cached timestamp so the next `current_proxy_snapshot()` call re-probes immediately.
- In `src-tauri/src/github/http.rs` (`get_with_etag_diag_inner` retry loop on `e.is_timeout() || e.is_connect()`) and `src-tauri/src/forge/http.rs`:
  - Call `crate::proxy::invalidate_proxy_snapshot()` on connect/timeout errors before sleeping for backoff, and obtain a fresh client via `new_api_client(...)` on the retry attempt so toggling a proxy mid-flight heals within the same retry cycle.

### 3. Hot-reloadable isolated client pools (`forge/http.rs`, `lib.rs`, `catalog_service.rs`, `downloader_http.rs`)

- **Unify API pool (`D5`)**:
  - Maintain a `(String /* signature */, reqwest::Client)` slot in `forge/http.rs` for the API pool (`new_api_client(timeout_secs)`) and a separate `(String, reqwest::Client)` slot for the unauthenticated Icon/CDN pool (`new_icon_client(timeout_secs)`).
  - Make `crate::shared_http_client()` delegate to `crate::forge::http::new_api_client(api_timeout_secs)` so there is a single shared API connection pool instead of two duplicate pools.
  - Update `AppState` (`lib.rs`): either replace `state.http` usages (`commands/catalog_detail.rs`, `commands/updates_check.rs`, etc.) with `state.http_client()` / `crate::shared_http_client()` or keep a helper method so commands never hold a stale startup `reqwest::Client`.
- **`CatalogService` third pool (`github/mod.rs` & `github/catalog_service.rs`)**:
  - Replace bare `pub(crate) client: reqwest::Client` with a signature-tracked cached client (`Mutex<(String, reqwest::Client)>` or helper method `self.http_client() -> reqwest::Client`) preserving its dedicated pool settings (`pool_max_idle_per_host(10)`, `connect_timeout(5s)`, `api_timeout_seconds`, token-less).
- **Downloader bounded pool (`installer/downloader_http.rs`)**:
  - Key `DOWNLOAD_CLIENTS` by `format!("{}|{}", snap.signature(dl_extra), dl_extra.join(","))` (cap remains `DOWNLOAD_CLIENT_POOL_CAP = 8`).

## Acceptance Criteria

- [ ] Unit tests cover `parse_windows_proxy_override` (`<local>`, `*.domain.com`, empty/whitespace), `parse_scutil_proxy_output` (HTTP/HTTPS/SOCKS enabled vs disabled, `ExceptionsList` extraction, IPv6 bracket handling), and `apply_proxy_snapshot` direct-mode `.no_proxy()` behavior.
- [ ] Unit test verifies that changing a mocked/injected proxy snapshot signature causes `new_api_client`, `new_icon_client`, and `CatalogService::http_client` to return a rebuilt `reqwest::Client` while identical signatures reuse the same instance.
- [ ] No production code path calls `std::env::set_var` for `http_proxy`, `https_proxy`, `all_proxy`, or `no_proxy`.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` and `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` pass.

## Comments

- 2026-11-14 (agent): 已落地：`proxy::ProxySnapshot` + `capture_initial_env_proxy` / `current_proxy_snapshot`（5s 冷却）/ `invalidate_proxy_snapshot` / `refresh_after_transport_error`；`proxy/windows.rs`（含 `ProxyOverride`）、`proxy/macos.rs`（`scutil`）、`proxy/linux.rs`（无 env 写入）；`proxy::ClientSlot` 驱动 API / 图标 / 清单 / 下载四池按签名热重建；`AppState.http` 移除，命令层改用 `shared_http_client()`（与 API 池同池）。
