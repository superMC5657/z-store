# Issue 01: Rust Security — Path Traversal, Coordinate & Mirror URL Validation

Status: resolved
Severity: High (F-01 [High], F-07 [High], F-14 [Medium])
Fix Track: Track 1 (`fix-rust-security`)
Findings: F-01, F-07, F-14

## Findings

### F-01 [High]: Unvalidated `developer` path traversal sends OAuth Bearer token to arbitrary GitHub API paths
- **Locations**:
  - `src-tauri/src/deeplink.rs:225-231`
  - `src-tauri/src/commands/forge.rs:7-35`
  - `src-tauri/src/github/mod.rs:69-81`
  - `src-tauri/src/github/developer_profile.rs:129-151, 243-246`
- **Trigger**: External deep link `zstore://developer/..%2Fuser%2Femails` (or IPC `get_developer_profile` with `../user/emails` or `foo?per_page=1#`). `DeepLinkParser::parse` decodes `%2F` to `/`, `commands/forge.rs:13` only trims whitespace, `fetch_developer_profile_with_cache` checks only `!dev.is_empty()`, and `dev_user_endpoint`/`dev_repos_endpoint` interpolate `dev` verbatim into `https://api.github.com/users/{dev}` with `Authorization: Bearer <token>`.
- **Impact**: Untrusted deep links or IPC calls trigger authenticated GET requests against arbitrary GitHub REST API paths and poison `api_etag_cache` under crafted URL keys (violates CONTEXT D2 / ADR-0007).

### F-07 [High]: `ForgeType::matches_host` & `RepositoryUrlParser` accept `@` userinfo in host and `.`/`..` in `owner`/`repo`
- **Locations**:
  - `src-tauri/src/forge/coord.rs:35-40, 95-103`
  - `src-tauri/src/oauth/star.rs:5-11`
- **Trigger**: `valid_host_segment` (`coord.rs:96`) permits `@` (`gitea:attacker@internal:8080/o/r` parses; `ForgeType::GitHub.matches_host("evil@.github.com")` returns `true`). `valid_repo_segment` (`coord.rs:101`) permits `.` and `..`, so `canonical_app_id("../..") == Some("../..")`, which passes `split_github_repo_id` in star commands and reaches `starred_api_url` (`PUT/DELETE/GET https://api.github.com/user/starred/../...`) with a Bearer token.
- **Impact**: Authenticated GitHub API path traversal via `owner`/`repo` = `..`, and host-confusion/userinfo injection in self-hosted forge URLs (violates ADR-0006 / ADR-0010).

### F-14 [Medium]: `test_proxy_latency(Some("ghproxy"))` dials literal `"ghproxy"`; `mirror::url_host` misses `\` delimiter
- **Locations**:
  - `src-tauri/src/mirror.rs:9-19, 39-43, 240-260`
- **Trigger**:
  1. Calling `test_proxy_latency(Some("ghproxy"))` passes `validate_custom_proxy("ghproxy") == Ok(())` (`mirror.rs:41`), sets `test_url = "ghproxy"` (`mirror.rs:251`), and fails `client.head("ghproxy")` with a URL parse error instead of probing `DEFAULT_GH_PROXY`.
  2. `url_host` (`mirror.rs:13`) splits authority on `['/', '?', '#']` without `'\\'`, so external release URL `https://evil.com\@github.com/a/b` passes `is_github_domain` as `github.com` while WHATWG/`reqwest` connects to `evil.com`.
- **Impact**: Builtin `"ghproxy"` latency test always fails from Settings UI; backslash URL confusion bypasses `is_github_domain` host check on external release URLs.

## Acceptance Criteria

- [ ] Validate `developer` strictly (GitHub handle rules: ASCII `[A-Za-z0-9-]`, length `1..=39`, rejecting `/`, `\`, `.`, `..`, `?`, `#`, `%`, `@`, whitespace, and invalid leading/trailing hyphens while preserving valid handles like `foo-bar`, `a`, `foo123`) in `deeplink.rs`, `commands/forge.rs`, and `github/developer_profile.rs` / `github/mod.rs`.
- [ ] Reject `@` userinfo and invalid hostname characters in `valid_host_segment` and `ForgeType::matches_host`; reject `.`, `..`, and control characters in `valid_repo_segment` (`forge/coord.rs`, verified end-to-end with `oauth/star.rs`).
- [ ] Resolve `"ghproxy"` to `DEFAULT_GH_PROXY` in `mirror::test_proxy_latency`.
- [ ] Split authority on `'\\'` (or parse via `reqwest::Url::parse`) in `mirror::url_host` so `https://evil.com\@github.com/...` never matches `is_github_domain`.
- [ ] Unit/regression tests cover every rejected/accepted case for F-01, F-07, and F-14; `cargo test` and `cargo clippy --all-targets` pass with 0 warnings.

## Comments

- **Resolved in `65ce95d`** (Track 1 `fix-rust-security`: `fix(rust-core): harden security, checksums, star lists, proxy, and 401 handling`).
- Hardened `developer` handle validation across `deeplink.rs`, `commands/forge.rs`, `github/mod.rs`, and `github/developer_profile.rs` (F-01); rejected `@` userinfo and `.`/`..`/control chars in `forge/coord.rs` & `oauth/star.rs` (F-07); mapped `"ghproxy"` → `DEFAULT_GH_PROXY` in `test_proxy_latency` and hardened backslash authority splitting in `mirror.rs` (F-14) with unit/regression tests.
- **Integrated verification on `main`**: `cargo test` 875 passed / 3 ignored, `cargo clippy --all-targets` 0 warnings.
