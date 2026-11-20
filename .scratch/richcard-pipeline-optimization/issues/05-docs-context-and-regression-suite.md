# Issue 05: Domain Docs Sync (`CONTEXT.md` & ADRs) and Full Regression Gate Verification

Status: resolved
Blocked by: 01, 02, 03, 04

## Summary

Synchronize `CONTEXT.md` and affected ADRs (`ADR-0011`, `ADR-0015`) with the finalized behavior of the Online Search, Trending Boards, and GitHub Star rich-card pipelines, and verify every frontend and backend quality gate.

Per `AGENTS.md`:
> Docs and comments: describe what it does now, not change history; explain why only when non-obvious.

## Scope

- `CONTEXT.md`
- `docs/adr/0011-doforce-trends-aggregator-exception.md`
- `docs/adr/0015-unified-icon-fetch-and-search-alignment.md`

## Implementation Details

### 1. Update `CONTEXT.md` to describe current state

- **`搜索列表缓存` (`Search List Cache`) & D10**: Document that `searchListCache.ts` enforces its 50-entry FIFO cap **per namespace** (`search` and `starred` isolated, 30min TTL, 256KB payload guard).
- **D5 (`双池复用`)**: Reflect that `shared_http_client()` and `forge::http::new_api_client()` share the single API `reqwest::Client` pool, physically isolated from the icon CDN pool (`new_icon_client`), manifest sync client (`CatalogService`), and bounded installer download clients (`DOWNLOAD_CLIENTS`).
- **D9 (`趋势与首页`) & `条件请求缓存` (`ETag Cache`)**:
  - Note that `fetch_trends_text` attaches the active GitHub token exclusively for `api.github.com` (`new` board) while keeping `github.com` HTML and `trend.doforce.dpdns.org` strictly unauthenticated;
  - Note that `enrich_trend_repos` serves `api_etag_cache` entries within the 12h soft-TTL window with zero network and revalidates older entries via `If-None-Match` (`304 Not Modified`), benefiting from repo JSON seeded by Online Search and Starred pages;
  - Note that `list_github_starred` uses `api_etag_cache` conditional requests (`304` preserving `has_more`) and falls back to cached `affinity` `/user/starred` pages for own-account offline queries.
- **D10 (`统一图标获取`)**: Describe the reference-counted single `zstore://icon-ready` IPC listener feeding `iconStore.admitIconHit` with orthogonal `search` / `trend` / `starred` generation gates.

### 2. Align ADR-0011 & ADR-0015

- **`docs/adr/0011-doforce-trends-aggregator-exception.md`**:
  - Ensure the trust boundary notes that `fetch_trends_text` never sends credentials to `trend.doforce.dpdns.org` or `github.com`, and only attaches GitHub API auth headers when the allowlisted host is `api.github.com`.
  - Fix the outdated `platforms=["windows"]` mention in §"未收录行 enrichment 复用搜索链路" to match actual behavior (`platforms=[]` empty vector, deduced asynchronously via `get_platforms_lite`).
- **`docs/adr/0015-unified-icon-fetch-and-search-alignment.md`**:
  - Update §4 (`搜缓存`) to reflect per-namespace (`search` / `starred`) 50-entry FIFO isolation.
  - Update §5 (`列表与坐标共享裁决`) to describe the single `onIconReady` subscription and three-way (`search_id` / `board+gen` / `starred` watermark) generation gates in `iconStore.admitIconHit`.

### 3. Run full verification gates

- Backend Rust tests & clippy/compile check:
  - `cargo test --manifest-path src-tauri/Cargo.toml`
- Frontend Vitest suite (including architectural invariant tests):
  - `npx vitest run` (verifying `ipcArgsNaming.test.ts`, `noDirectInvoke.test.ts`, `countDisplay.test.ts`, `cmdAlignment.test.ts`, and all Search / Trends / StarredFeed / IconStore suites).

## Acceptance Criteria

- [x] `CONTEXT.md`, `ADR-0011`, and `ADR-0015` accurately describe current behavior in present tense without changelog prose or outdated `platforms=["windows"]` claims.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passes with 0 failures.
- [x] `npx vitest run` passes with 0 failures across all test files.
