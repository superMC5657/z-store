# Issue 02: Fix Direct Download / Ping `no_proxy` Bypass Bug & Add `doforce` System-Proxy Fallback

Status: resolved
Blocked by: 01

## Summary

Fix two outbound routing defects that break or degrade connectivity for users in mainland China running a system proxy:

1. **Default `direct` mode mistakenly adds `github.com` / `codeberg.org` to `no_proxy` (`src-tauri/src/installer/downloader_http.rs:64` & `src-tauri/src/mirror.rs:218`)**:
   - `download_with_progress` unconditionally computes `dl_extra = proxy_hosts_for(download_url)`. When `MirrorManager` is in its default `"direct"` state, `download_url` is `https://github.com/...` or `https://codeberg.org/...`, putting the upstream forge host itself into `NoProxy` and forcing a bare direct connection that bypasses the user's active system proxy!
   - Similarly, `MirrorManager::test_proxy_latency(None)` (testing the `"direct"` channel in Settings) puts `github.com` into `extra_hosts`, testing bare unproxied reachability instead of the actual system-proxied path.
2. **Hardcoded `no_proxy` on `trend.doforce.dpdns.org` prevents proxy rescue when direct Cloudflare routing is blocked (`src-tauri/src/proxy/mod.rs:31` & `src-tauri/src/commands/network.rs:110`)**:
   - Keep direct-first routing for `trend.doforce.dpdns.org` so normal users do not spend proxy traffic, but automatically fall back to the active system proxy for one retry when the direct attempt times out, fails at the transport layer, or returns `5xx`.

> _Contradicts ADR-0008 §2 & ADR-0011 ("`trend.doforce.dpdns.org` always direct via `no_proxy`"), reopened per spec §2 to allow direct-first with system-proxy fallback on failure while keeping zero credentials attached._

## Scope

- Allowed to modify:
  - `src-tauri/src/proxy/mod.rs` (remove `TREND_HOST` from `default_no_proxy_entries()`, update unit test)
  - `src-tauri/src/mirror.rs`
  - `src-tauri/src/commands/installer_download.rs`
  - `src-tauri/src/installer/downloader_http.rs`
  - `src-tauri/src/commands/network.rs`
- Do not modify:
  - `src/*` (frontend files)
  - `src-tauri/src/github/catalog_service.rs` / `commands/catalog_sync.rs` (belongs to Issue 03)

## Implementation Details

### 1. Only exempt actual mirror hosts from system proxy in downloader & latency test

- In `src-tauri/src/mirror.rs`:
  - Expose a helper method or struct from `MirrorManager`, e.g.:
    ```rust
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ResolvedDownloadUrl {
        pub url: String,
        /// `Some(mirror_host)` ONLY when rewritten through a mirror prefix; `None` when direct.
        pub bypass_proxy_host: Option<String>,
    }
    ```
    - `rewrite_installer_asset_url_resolved(&self, raw_url: &str) -> ResolvedDownloadUrl` (keep `rewrite_installer_asset_url` as a thin wrapper returning `.url` for existing callers/tests).
    - Also provide `wrap_gh_proxy_resolved(raw_url: &str) -> ResolvedDownloadUrl` (when wrapped, `bypass_proxy_host` is `Some("gh-proxy.com".to_string())`; if `raw_url` is non-GitHub and unchanged, `None`).
    - Also expose `active_mirror_prefix(&self) -> Option<String>` (returns `Some("https://...")` when a custom/ghproxy mirror is configured, `None` when `"direct"` — reusable by Issue 03).
  - In `MirrorManager::test_proxy_latency(proxy_url: Option<&str>)`:
    - When `clean_url` is `Some(mirror_prefix)` (testing a mirror node): `extra_hosts = crate::proxy::proxy_hosts_for(&test_url)` so the mirror itself is tested via direct connection without routing through the user's proxy.
    - When `clean_url` is `None` (testing `"direct"` `https://github.com`): pass `&[]` (`extra_hosts` empty) so `ping_client` uses the current `ProxySnapshot` (testing whether GitHub is reachable through the user's active system network / system proxy).
- In `src-tauri/src/installer/downloader_http.rs` & `src-tauri/src/commands/installer_download.rs`:
  - Change `download_with_progress` (or add `bypass_proxy_hosts: &[String]` parameter; keep signature clean across call sites in `installer_download.rs` and tests):
    - When downloading a **direct** URL (`bypass_proxy_host == None`), pass `&[]` to `resolve_download_client` so `github.com`, `objects.githubusercontent.com`, `codeberg.org`, `gitlab.com`, etc. properly route through the active system proxy!
    - When downloading a **mirror-rewritten** URL (either user-configured mirror or the `wrap_gh_proxy` fallback in `download_asset_with_fallback`), pass `&[mirror_host]` so mirror traffic bypasses the system proxy via per-client `NoProxy`.

### 2. Direct-first with system-proxy fallback for `trend.doforce.dpdns.org` (`src-tauri/src/commands/network.rs`)

- In `src-tauri/src/proxy/mod.rs`:
  - Remove `TREND_HOST` from `default_no_proxy_entries()` (keep `GH_PROXY_HOST`, `localhost`, `127.0.0.1`, `::1`; keep `pub const TREND_HOST: &str = "trend.doforce.dpdns.org";` exported for `commands/network.rs`).
- In `src-tauri/src/commands/network.rs`:
  - Build/cache a dedicated lightweight direct client for `TREND_HOST` (via `crate::proxy::apply_proxy(builder, &[crate::proxy::TREND_HOST.to_string()])` keyed or built cleanly with 5s connect timeout and `BROWSER_UA_VALUE`).
  - When `parsed.host_str()` equals `trend.doforce.dpdns.org` (case-insensitive):
    1. **Attempt 1 (Direct)**: Send GET with the `TREND_HOST` `no_proxy` client under a `5s` timeout. If it succeeds (`2xx`) or returns a deterministic client status like `429` / `4xx`, handle response normally without retrying via proxy.
    2. **Attempt 2 (System Proxy Fallback)**: Only if Attempt 1 fails with timeout, transport error, or `5xx` **and** `crate::proxy::current_proxy_snapshot().has_proxy()` is `true`, log a debug/info step and retry once using `crate::shared_http_client()` (which routes `trend.doforce.dpdns.org` through the active system proxy now that `TREND_HOST` is no longer in global `default_no_proxy_entries`) with a `6s` timeout, never attaching any auth headers.
  - For `github.com` and `api.github.com`, keep single-stage `crate::shared_http_client()` with `10s` timeout unchanged.

## Acceptance Criteria

- [x] Unit test in `mirror.rs` / `downloader_http.rs`: in `"direct"` mode, `rewrite_installer_asset_url_resolved("https://github.com/o/r/releases/download/v1/a.msi")` yields `bypass_proxy_host == None` (`dl_extra` is empty, `github.com` is **not** in `merged_no_proxy_string`), whereas `"https://gh-proxy.com"` or `wrap_gh_proxy_resolved` yields `bypass_proxy_host == Some("gh-proxy.com")`.
- [x] Unit test: non-GitHub URLs (`https://codeberg.org/o/r/releases/download/v1/a.AppImage`) never add `codeberg.org` to `no_proxy` under either `"direct"` or `"ghproxy"` mode.
- [x] Unit / local TCP integration test in `commands/network.rs` (or `proxy/mod.rs`): `default_no_proxy_entries()` no longer contains `trend.doforce.dpdns.org`, and the `doforce` fallback helper retries via proxy client on transport error/timeout/5xx when `has_proxy()` is true, while not retrying on `200` or `429`.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` passes with 0 warnings/failures.

## Comments

- 2026-11-14 (agent): 已落地：`mirror::ResolvedDownloadUrl` + `rewrite_installer_asset_url_resolved` / `wrap_gh_proxy_resolved` / `active_mirror_prefix`；`download_with_progress` 新增 `bypass_proxy_hosts` 参数；测速官方直连不豁免；`TREND_HOST` 移出默认 `no_proxy`，`fetch_trends_text` 直连 5s → 系统代理 6s 回退（`send_direct_first`，本地 TCP 单测覆盖 5xx / 传输错误 / 200 / 429 / 无代理）。
