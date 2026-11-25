# Issue 03: Rust GitHub Star Lists, Windows Proxy, README Tree & Trends 401

Status: resolved
Severity: High (F-08 [High], F-11 [Medium], F-17 [Medium], F-21 [Medium], Test Gap #2)
Fix Track: Track 1 (`fix-rust-security`)
Findings: F-08, F-11, F-17, F-21, Test Gap #2

## Findings

### F-08 [High]: `add_repo_to_star_list` silently strips repos from user's other GitHub Star Lists
- **Locations**:
  - `src-tauri/src/oauth/star.rs:182-273, 310-355`
- **Trigger**: User stars a repo that already belongs to a Star List with >100 items or beyond the 50th Star List. `add_repo_to_star_list` queries `lists(first: 50) { items(first: 100) }` and passes the truncated `item_list_ids` to `updateUserListsForItem`, which replaces all list memberships of that repository on GitHub.
- **Impact**: Silent remote data loss on the user's GitHub account: ZStore removes the repository from every existing Star List omitted by the truncated GraphQL page.

### F-11 [Medium]: Windows `socks=host:port` and `ftp=` system proxy entries misclassified as `http://`
- **Locations**:
  - `src-tauri/src/proxy/windows.rs:21-51`
- **Trigger**: Windows `ProxyServer` registry value contains `socks=127.0.0.1:1080` (or `ftp=proxy:21`) without `http=`/`https=`. Lines 36-40 discard the scheme name (`other_pick = Some(addr)`) and line 51 passes bare `127.0.0.1:1080` to `normalize_single_proxy_addr`, prepending `http://`.
- **Impact**: Violates CONTEXT D5 / D8 / ADR-0025: SOCKS-only Windows system proxies fail HTTP/TLS requests as `http://...`, and `ftp=` entries get misapplied to HTTPS traffic.

### F-17 [Medium]: `readme_fetch::list_root_paths` fallback omits URL-encoding on `branch` and fetches unbounded `?recursive=1` tree
- **Locations**:
  - `src-tauri/src/github/readme_fetch.rs:210-238`
- **Trigger**: When `/contents?ref=` fails and `list_root_paths` falls back to `git/trees/{branch}?recursive=1`, `owner`/`repo`/`branch` are interpolated raw (breaking slash-named branches like `release/1.0`), and `?recursive=1` fetches the entire recursive tree via unbounded `resp.json::<GitTreeResponse>()` only to keep root entries (`!p.contains('/')`).
- **Impact**: Breaks README discovery on slash-named branches and risks OOM/memory spikes on large monorepos.

### F-21 [Medium]: `fetch_trends_text` omits `check_auth_expired` on `api.github.com` HTTP 401
- **Locations**:
  - `src-tauri/src/commands/network.rs:248-281, 311-352`
  - Reference: `src-tauri/src/lib.rs:451-467`
- **Trigger**: Trends `new` board fetches `https://api.github.com/search/repositories?...` with an expired/revoked GitHub OAuth token. On HTTP 401, lines 345-352 return `Err("trends: upstream status 401")` without calling `crate::check_auth_expired(401, "github.com")`.
- **Impact**: Violates ADR-0026 §2.1: expired OAuth tokens stay active, `zstore://oauth-expired` never fires, private caches remain unrevoked, and the Trends `new` board stays broken instead of triggering expiry/anonymous fallback.

### Test Gap #2: Weak OAuth Star-to-Launchpad test
- **Locations**:
  - `src-tauri/src/oauth/tests.rs:395-403`
- **Issue**: `apply_star_mutation_adjusts_launchpad_only_on_flip` never seeds `launchpad_discussion_cache` and never asserts the Launchpad star delta.

## Acceptance Criteria

- [ ] `add_repo_to_star_list` queries repo-scoped list memberships or paginates `lists` and `items` fully via `pageInfo { hasNextPage endCursor }`, and aborts `updateUserListsForItem` safely with a warning/error if pagination cannot be completed.
- [ ] `proxy/windows.rs` maps `socks=`/`socks5=` to `socks5h://{addr}` and ignores `ftp=` (and other non-HTTP/non-SOCKS protocols).
- [ ] `readme_fetch::list_root_paths` percent-encodes `owner`/`repo`/`branch`, removes `?recursive=1`, and enforces a bounded response byte cap.
- [ ] `commands/network.rs::fetch_trends_text` invokes `crate::check_auth_expired(401, "github.com")` when `is_api && auth.is_some() && status == 401`.
- [ ] `oauth/tests.rs::apply_star_mutation_adjusts_launchpad_only_on_flip` seeds `launchpad_discussion_cache` and asserts exact star delta on flip and no-op on non-flip.
- [ ] Unit/regression tests cover F-08, F-11, F-17, F-21, and Test Gap #2; `cargo test` and `cargo clippy --all-targets` pass.

## Comments

- **Resolved in `65ce95d`** (Track 1 `fix-rust-security`: `fix(rust-core): harden security, checksums, star lists, proxy, and 401 handling`).
- Fixed `add_repo_to_star_list` pagination & safe abort in `oauth/star.rs` (F-08), mapped Windows `socks`/`socks5` → `socks5h://` and ignored `ftp=` in `proxy/windows.rs` (F-11), percent-encoded `owner`/`repo`/`branch` and dropped `?recursive=1` with bounded body cap in `github/readme_fetch.rs` (F-17), hooked `check_auth_expired(401, "github.com")` in `commands/network.rs` (F-21), and strengthened `apply_star_mutation_adjusts_launchpad_only_on_flip` in `oauth/tests.rs` (Test Gap #2).
- **Integrated verification on `main`**: `cargo test` 875 passed / 3 ignored, `cargo clippy --all-targets` 0 warnings.
