# Issue 03: Official Curated Catalog Sync Mirror Fallback & Checksum Timeout Calibration

Status: resolved
Blocked by: 01, 02

## Summary

Enable users in mainland China who **do not** have a system proxy running to still receive incremental updates to the official `Curated Catalog` (`z-store-catalog`), while strictly preserving the D3 `Checksum Verification` zero-trust boundary on `checksums.txt` and calibrating its timeout for cross-border system proxies.

> _Contradicts ADR-0002 §1 ("catalog manifest always connects directly and never retries via download mirror"), reopened per spec §2 exclusively for the official default `catalog.json` source on transport/5xx failure._

## Scope

- Allowed to modify:
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/commands/catalog_sync.rs`
  - `src-tauri/src/github/detail_fetch.rs` (checksum timeout constant & unit tests)
- Do not modify:
  - `src/*` (frontend files)
  - `src-tauri/src/installer/*`

## Implementation Details

### 1. Mirror fallback for official default `catalog.json` (`catalog_service.rs` & `commands/catalog_sync.rs`)

- **Scope gate**: Mirror fallback is permitted **if and only if** `is_default_catalog_source(url)` is `true` (i.e. `https://raw.githubusercontent.com/superMC5657/z-store-catalog/main/catalog.json`). Custom HTTP(S) URLs and `file://` paths in `catalog_source_url` must **never** be rewritten through a mirror.
- **Fallback mirror selection**:
  - Read active mirror from `state.mirror`: if the user configured a valid custom HTTPS mirror (`active_mirror_prefix()`), use that prefix; otherwise fall back to `crate::mirror::DEFAULT_GH_PROXY` (`https://gh-proxy.com`).
- **Two-step fetch in `CatalogService`**:
  1. **Primary attempt**: Request `url` via `CatalogService`'s proxy-aware client (carrying `If-None-Match: etag` when `cached_etag` is `Some`).
     - If `200 OK` or `304 Not Modified`: return immediately (`via = "direct"`).
     - If `4xx` other than `429` (e.g. `404`): do not fallback, return error.
  2. **Mirror fallback attempt** (triggered on transport/timeout error, `429`, or `5xx` when `is_default_catalog_source(url)` is `true`):
     - Build mirrored URL `{mirror_prefix}/{url}` (using `mirror` prefix primitive, avoiding double-prefixing).
     - Build/reuse a token-less client with `extra_hosts = crate::proxy::proxy_hosts_for(&mirrored_url)` so the mirror host connects directly without routing through a dead/absent proxy, and **never** attaches any auth token.
     - Send `GET` (with `If-None-Match` if `cached_etag` is present; if `304`, return `(None, None)`).
- **Strict payload validation before accepting mirror response**:
  - Parse body as `Vec<CatalogItem>`.
  - For `is_default_catalog_source(url)`: reject empty `Vec` (`items.is_empty()`) and verify every item's `id` normalizes cleanly via `crate::forge::canonical_app_id(&item.id).is_some()`, preventing captive portals, HTML error pages, or truncated mirror responses from corrupting `catalog_apps`.
  - Log `via = "mirror"` in `commands/catalog_sync.rs` wide event diagnostics when fallback succeeds.

### 2. Calibrate `Checksum Manifest` fetch timeout while keeping strict non-mirror rule (`detail_fetch.rs`)

- In `src-tauri/src/github/detail_fetch.rs::extract_checksums_map`:
  - Keep `effective_url = asset.browser_download_url.clone()` **strictly direct / system-proxied** (never rewritten via `MirrorManager` or `gh-proxy`, preserving ADR-0004 / D3 anti-tampering guarantees).
  - Increase `checksum_timeout` from `Duration::from_secs(3)` to `Duration::from_secs(6)` (capped by `api_timeout` if configured smaller in tests) so cross-border system proxies following GitHub's `302` redirect to `objects.githubusercontent.com` do not prematurely time out and falsely trigger `unverified-asset-required` dialogs.
  - Ensure `CatalogService::fetch_app_detail` uses the hot-reloadable client from Issue 01 (`self.http_client()`).

## Acceptance Criteria

- [x] Unit / local TCP mock test: when primary `catalog.json` endpoint fails (connection refused / 502) and `is_default_catalog_source` is true, `fetch_remote_catalog` retries via the mirror endpoint, validates `Vec<CatalogItem>`, and succeeds.
- [x] Unit test: when `catalog_source_url` is a custom third-party URL (`https://example.com/catalog.json`), failure does **not** trigger mirror fallback.
- [x] Unit test: when mirror fallback returns an empty JSON array `[]` or invalid `id` entries for the official default source, it is rejected with an error rather than overwriting `catalog_apps`.
- [x] `extract_checksums_map` never rewrites URLs through `gh-proxy.com` and uses the 6s timeout budget; existing `test_checksum_manifest_fetch_via_unified_interface_degrades_to_empty` still passes quickly.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` passes.

## Comments

- 2026-11-14 (agent): 已落地：`CatalogService::fetch_remote_catalog_with_fallback` / `fetch_http_catalog` + `validate_mirrored_catalog`（非空 + `canonical_app_id`）；`sync_catalog` 计算镜像前缀并记 `via`；`CHECKSUM_FETCH_TIMEOUT = 6s`（`min(api_timeout)`），校验清单恒请求原始 URL（单测锁定）。
