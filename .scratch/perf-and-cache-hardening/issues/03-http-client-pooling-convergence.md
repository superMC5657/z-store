# Issue 03: HTTP Client Connection Pool Reuse in Affinity Sync & Downloader

Status: resolved
Blocked by: none

## Summary

Enforce `CONTEXT.md` §二.D5 connection-pool reuse in two places that currently construct a brand-new `reqwest::Client` on every invocation:
1. `CatalogService::sync_github_affinity_signals_bg` (`src-tauri/src/github/affinity.rs:129`) calls `super::http::build_api_client()?` on every sync instead of reusing `crate::shared_http_client()`.
2. `download_with_progress` (`src-tauri/src/installer/downloader_http.rs:21-29`) builds a new `reqwest::Client` on every asset download even when `dl_extra` (`proxy_hosts_for(download_url)`) is empty or unchanged.

## Scope

- `src-tauri/src/github/affinity.rs`
- `src-tauri/src/installer/downloader_http.rs`

## Implementation Details

### 1. Reuse `crate::shared_http_client()` in `sync_github_affinity_signals_bg` (`src-tauri/src/github/affinity.rs`)

- Replace `let client = super::http::build_api_client()?;` at line 129 with `let client = crate::shared_http_client();`.
- Check if `super::http::build_api_client` has any remaining callers; if unused outside tests, remove or mark `#[cfg(test)]`.

### 2. Reuse download clients keyed by `dl_extra` (`src-tauri/src/installer/downloader_http.rs`)

- Maintain a bounded `DOWNLOAD_CLIENTS: OnceLock<Mutex<HashMap<String, reqwest::Client>>>` (cap 8) keyed by `dl_extra.join(",")` (`no_proxy` bypass hosts).
- Reuse the cached `reqwest::Client` for repeated downloads to the same host/mirror instead of rebuilding a client on every call, and propagate build errors directly without caching a degraded fallback client.

## Acceptance Criteria

- [x] `sync_github_affinity_signals_bg` uses `crate::shared_http_client()`.
- [x] `download_with_progress` reuses a bounded pool of `reqwest::Client` instances keyed by `dl_extra`.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passes with zero warnings.
