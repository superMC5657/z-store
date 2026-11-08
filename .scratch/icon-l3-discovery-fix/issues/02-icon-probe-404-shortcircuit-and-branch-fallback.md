# Issue 02: `icon_probe` HTTP 404/410 Short-Circuit & `resolve_probe_branches` `"HEAD"` Fallback

Status: resolved
Blocked by: none

## Summary

Fix two backend probing bottlenecks in `src-tauri/src/github/icon_probe.rs` that cause `fetch_icons_stream` to miss L3 icons on Rich Card List views (Trends & Online Search) when the detail modal later succeeds:
1. **3x HTTP amplification on L2 SimpleIcons 404 misses**: `verify_image` issues a `HEAD` request first. When `cdn.simpleicons.org/{slug}` returns `404 Not Found` (which happens for most GitHub repos across 2–4 candidate slugs), `verify_image` does not treat `404`/`410` as a terminal miss. Instead, it falls through to `fetch_range_head` (`GET` with `Range: bytes=0-2047` -> `404`) and then full `GET` (-> `404`), turning every missing slug into **3 sequential HTTP requests** (6–12 wasted requests per repo) inside the `pool = 5` stream.
2. **Empty branch list on `default_branch` timeout skips L3 completely**: `resolve_probe_branches` makes an uncached `GET /repos/{owner}/{repo}` request to look up `default_branch`. Under concurrent首屏 load (`enrich_trend_repos` + `fetch_icons_stream`), if that request fails or hits the timeout, `resolve_probe_branches` returns `Vec::new()`, causing `probe_l3_trees` (`for branch in branches`) to execute zero iterations and skip L3 tree search entirely. In contrast, `detail_fetch.rs` falls back to `"HEAD"`, which GitHub's Git Trees API (`GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1`) and `raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}` resolve natively to the default branch.

> **Constraint**: Do **not** change `config::api_timeout_or` in `src-tauri/src/config.rs`; its semantics are locked by ADR-0015 §2 and unit test `api_timeout_or_returns_configured_secs`.

## Scope

- `src-tauri/src/github/icon_probe.rs`

## Implementation Details

### 1. Short-circuit terminal HTTP misses (`404 Not Found`, `410 Gone`) in `verify_image`

In `src-tauri/src/github/icon_probe.rs`:
- Add a helper function:
  ```rust
  pub(crate) fn is_terminal_http_miss(status: reqwest::StatusCode) -> bool {
      matches!(
          status,
          reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::GONE
      )
  }
  ```
- In `verify_image(client: &reqwest::Client, url: &str) -> bool`:
  - After receiving `Ok(resp)` from the `HEAD` request:
    - If `is_terminal_http_miss(resp.status())`, immediately return `false` without attempting `fetch_range_head` or full `GET`.
  - Keep existing fallback behavior for `403 Forbidden`, `405 Method Not Allowed`, `429`, `5xx`, network errors, or `200 OK` with an inconclusive `Content-Type` (e.g. `application/octet-stream`), where `Range GET` magic-byte sniffing is still needed.
- In `fetch_range_head`:
  - Distinguish between a definitive terminal miss (`404`/`410`) and an unsupported range / transient failure (e.g., by returning an enum `RangeProbeOutcome { Verified(bool), NeedFullGet }` or `Option<bool>` where `Some(false)` means terminal miss/invalid image and `None` means fallback to full `GET` is needed) so a `404`/`410` on `Range GET` also never falls through to full `GET`.

### 2. Fallback to `vec!["HEAD".to_string()]` in `resolve_probe_branches`

In `src-tauri/src/github/icon_probe.rs` (`resolve_probe_branches`, around lines 474–501):
- When `fetch_repo_default_branch(client, owner, repo).await` returns:
  - `Some(b)` where `!b.trim().is_empty()` -> return `vec![b]` (existing behavior).
  - `Some(_)` (empty/whitespace) or `None` (network error, timeout, 403/429 rate-limit) -> log a debug trace and return `vec!["HEAD".to_string()]` instead of `Vec::new()`.
- Verify that `fetch_repo_tree(client, owner, repo, "HEAD")` and `raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}` work seamlessly with `"HEAD"` (matching `detail_fetch.rs:649-654`).

## Acceptance Criteria

- [x] `is_terminal_http_miss` returns `true` for `404 Not Found` and `410 Gone`, and `false` for `200 OK`, `403 Forbidden`, `405 Method Not Allowed`, `500 Internal Server Error`, etc.
- [x] When `HEAD` returns `404` or `410` in `verify_image`, neither `fetch_range_head` nor full `GET` is called.
- [x] When `HEAD` returns `405 Method Not Allowed` or `200 OK` with `application/octet-stream`, `verify_image` still falls back to `Range GET` magic-byte verification.
- [x] When `fetch_repo_default_branch` returns `None` or an empty string, `resolve_probe_branches` returns `vec!["HEAD".to_string()]` rather than `Vec::new()`.
- [x] Unit tests in `src-tauri/src/github/icon_probe.rs` cover `is_terminal_http_miss` and `resolve_probe_branches` fallback semantics, and `cargo test --manifest-path src-tauri/Cargo.toml` passes.
