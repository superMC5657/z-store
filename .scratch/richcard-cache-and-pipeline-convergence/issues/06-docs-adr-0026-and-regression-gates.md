# Issue 06: Record ADR-0026, Sync Domain Docs (`CONTEXT.md` & ADRs), and Pass Full Regression Gates

Status: resolved
Blocked by: 01, 02, 03, 04, 05

## Summary

Record the finalized caching & rich-card convergence architecture in `docs/adr/0026-search-starred-cache-and-enrich-convergence.md`, update cross-referenced ADRs (`ADR-0015`, `ADR-0019`) and `CONTEXT.md` so all domain documentation describes current system behavior in present tense, and run the complete Rust + Frontend + Live Demo verification gates.

Per `AGENTS.md`:
> Docs and comments: describe what it does now, not change history; explain why only when non-obvious.

## Scope

- Allowed to create / modify:
  - `docs/adr/0026-search-starred-cache-and-enrich-convergence.md` (new)
  - `docs/adr/0015-unified-icon-fetch-and-search-alignment.md`
  - `docs/adr/0019-asset-manual-cache-and-non-asset-auto-fetch.md`
  - `CONTEXT.md`
  - `.scratch/richcard-cache-and-pipeline-convergence/spec.md` (update status header to `Implemented`)

## Implementation Details

### 1. Author `docs/adr/0026-search-starred-cache-and-enrich-convergence.md`

Document the architecture concisely in present tense:
- **HTTP ETag Conditional Caching Across Discovery & Starred**:
  - `search_apps_online` (keyword `/search/repositories` and `owner/repo` direct `/repos/{o}/{r}`) and `list_github_starred` (`/user/starred` & `/users/{u}/starred`) route through unified `github::http::get_with_etag_diag` / `get_with_etag_with_link` backed by `api_etag_cache` (`API_ETAG_CACHE_MAX_ROWS = 3000` LRU), enabling zero-quota `304 Not Modified` revalidation, D7 bounded retry, proxy hot-reload, and `304` full-page `has_more` preservation.
  - Trend `new` board attaches active GitHub token on `api.github.com` in `fetch_trends_text` while keeping `github.com` HTML and `trend.doforce.dpdns.org` credential-free.
  - `enrich_trend_repos` runs batch summary fetches with `probe_icons = false`, delegating icon probing once to background `fetch_icons_stream(Trend)`.
- **Three-Pipeline Shared Single-Repo Enrich & Platform Pool**:
  - Frontend `repoEnrichCache` (unified with `trendEnrichCache` / `trendConfirmedOtherCache`, 12h TTL, 600 FIFO, stripping `data:` and runtime catalog annotations) shares deduced concrete `platforms`, real `latest_version`, and `confirmedOther` bidirectionally across Online Search, Trends, and GitHub Star.
  - Backend `backfill_uncataloged_card` synchronously backfills `platforms` and `tag_name` from `app_details` or cached `releases/latest` payloads in `api_etag_cache` across restarts; keyword search projects curated `CatalogService` cards on catalog hits.
  - Online Search `lazyBackfillPlatforms` defaults to `forceRefresh = false` (reusing `app_details` TTL and `releases/latest` ETag), reserving `forceRefresh = true` for explicit retry.
- **Namespace-Isolated `searchListCache` & `starred_feed_cache` L2 Snapshot**:
  - `searchListCache` maintains independent 50-entry FIFO buckets per namespace (`search` vs `starred`), with a 5-minute fresh short-circuit window and 5–30 minute SWR revalidation window.
  - `starred_feed_cache` persists `{ v: 1, rows, pages, hasMore, emptyPages, confirmedOther }` snapshots (up to 3 pages / 60 rows, FE 256KB pre-check, BE 512KiB hard cap, 12h fresh TTL, 7-day retention, max 15 targets) for zero-network cold-start rendering in `StarredFeed`; `oauth::clear_oauth_session` atomically purges `@me:` rows alongside `/user/` ETag entries on logout.

### 2. Sync Existing ADRs & `CONTEXT.md`

- **`docs/adr/0015-unified-icon-fetch-and-search-alignment.md`**:
  - Update §4 (`搜缓存`) to reflect per-namespace 50-entry buckets (`search` / `starred`) and 5m fresh + 30m SWR gating (referencing ADR-0026).
  - Update §5 (`列表与坐标共享裁决`) to reflect that list pagination remains per-view while concrete single-repo rich-card summaries & `confirmedOther` share bidirectionally across Search, Trends, and Starred via `repoEnrichCache` (referencing ADR-0026).
- **`docs/adr/0019-asset-manual-cache-and-non-asset-auto-fetch.md`**:
  - Note `StarredFeed` cold-start L2 snapshot read (`starred_feed_cache`) + manual ETag sync in §2 (referencing ADR-0026).
- **`CONTEXT.md`**:
  - Update glossary entries (`搜索列表缓存 Search List Cache`, `条件请求缓存 ETag Cache`, and add `Star 列表快照缓存 Starred Feed Cache` / `单仓富卡派生缓存 Repo Enrich Cache` if appropriate) and architectural invariants (**D2**, **D9**, **D10**) in clean present tense (`db/schema.rs::init_schema` remains the table SSOT without hardcoding table counts).

### 3. Run All Verification Gates

- Rust backend:
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
  - `cargo test --manifest-path src-tauri/Cargo.toml`
- Frontend & Demo:
  - `npx tsc --noEmit`
  - `npx vitest run` (verifying `cmdAlignment.test.ts`, `ipcArgsNaming.test.ts`, `noDirectInvoke.test.ts`, `countDisplay.test.ts`, `views.i18n.test.tsx`, and all new unit/component suites)
  - `npx vite build --config vite.demo.config.ts`

## Acceptance Criteria

- [ ] `docs/adr/0026-search-starred-cache-and-enrich-convergence.md` is created and `ADR-0015`, `ADR-0019`, and `CONTEXT.md` are aligned in present tense with zero contradictions.
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` passes with 0 warnings.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes with 0 failures.
- [ ] `npx tsc --noEmit`, `npx vitest run`, and `npx vite build --config vite.demo.config.ts` all pass with 0 errors.
