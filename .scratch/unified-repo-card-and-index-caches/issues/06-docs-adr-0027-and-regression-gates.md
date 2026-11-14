# Issue 06: ADR-0027, Domain Documentation Sync & Full-Stack Regression Gates

Status: resolved
Blocked by: 01, 02, 03, 04, 05

## Summary

Record the architectural decision in `docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md`, synchronize `CONTEXT.md` and superseded ADR clauses (`ADR-0014`, `ADR-0015`, `ADR-0026`), mark `.scratch/unified-repo-card-and-index-caches/spec.md` as `Implemented`, and run every backend, frontend, architecture-gate, and live-demo build check to verify zero regressions.

## Scope

- Allowed to modify:
  - `docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md` (new file)
  - `docs/adr/0014-trends-l2-and-governance.md` (status/amendment pointer only)
  - `docs/adr/0015-unified-icon-fetch-and-search-alignment.md` (status/amendment pointer only)
  - `docs/adr/0026-search-starred-cache-and-enrich-convergence.md` (status/amendment pointer only)
  - `CONTEXT.md`
  - `.scratch/unified-repo-card-and-index-caches/spec.md`
- Do not modify:
  - `src/*`, `src-tauri/*` (unless fixing an issue uncovered by full-suite regression gates)

## Implementation Details

### 1. Author `docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md`

Document what the system does now (per `AGENTS.md` — concise present-tense contract, explaining non-obvious *why* only):
- **Context**: Why embedding full `AppSummary` payloads inside `trend_board_cache`, `starred_feed_cache`, and L1 `searchListCache` caused cross-board duplication, read-modify-write amplification on icon/platform/detail updates, loss of uncataloged card shells and `confirmed_other` across restarts, and lack of an online search L2 index.
- **Decision**:
  1. **Physically Isolated `repo_card_cache` Table**: Schema, strict separation from `catalog_apps` & `custom_apps` (curated priority on read, skip on write, `purge_cataloged_repo_cards` on sync/collect), ban on catalog annotations & `data:` icons, monotonic non-destructive merge rules (real fields never overwritten by placeholders; `concrete platforms` > `confirmed_other = 1` > `unknown []`; `updated_at = 0` platform pre-seed guard), `2000`-row `last_accessed_at` LRU, and `is_private = 1` purge on OAuth logout / 401 expiry.
  2. **Three Isomorphic Slim `v: 2` List Index Tables (`trend_board_cache`, `starred_feed_cache`, `search_list_cache`)**: Exact `v: 2` JSON shapes, `64 KiB` backend cap / `32 KiB` frontend precheck, 7-day retention + row caps (`30` / `15` / `100`), `has_private = 1` & `@me:` logout cleanup, `user_version = 6` migration, while `api_etag_cache` remains the sole raw HTTP response & ETag store.
  3. **Unified Batch Hydration (`get_repo_cards_batch` / `hydrateCardsByIds`)**: Single-pass resolution (`CatalogService` curated/local library → M1 `repoEnrichCache` → SQLite `repo_card_cache` + `app_icon_cycles` confirmed `data:`/URL overlay) across Online Search, Trends, and GitHub Star, plus `repo_card_cache` fallback for uncataloged Favorites/Watched & Recently Viewed.
- Add concise amendment notes in the headers of `ADR-0014`, `ADR-0015`, and `ADR-0026` pointing to `ADR-0027` for the superseded envelope/storage sections.

### 2. Update `CONTEXT.md`

- **Domain Glossary**:
  - Update **搜索列表缓存 (`Search List Cache`)**: L1 前端内存瘦分页 `id` 索引（`search` / `starred` 分桶各 50 条 FIFO，5min 新鲜 / 30min TTL）+ L2 SQLite `search_list_cache` 有界分页 `id` 索引快照（`v: 2`，7 天保留，`has_private=1` 登出即清）。
  - Update **单仓富卡派生缓存 (`Repo Enrich Cache` / `repo_card_cache`)**: 前端 M1 内存镜像（`services/repoEnrichCache.ts`）+ 与 `catalog_apps`/`custom_apps` 物理隔离的独立 SQLite `repo_card_cache` 表，按规范应用标识 `id` 共享持久化未收录应用轻量富卡、平台推导与 `confirmed_other` 标记（遵守实值不被空占位覆盖、禁收录标注与 `data:` 图标、按 `last_accessed_at` 有界 LRU 淘汰、`is_private=1` 随登出清除，见 ADR-0027）。
  - Update **Star 列表快照缓存 (`Starred Feed Cache`)**: SQLite `starred_feed_cache` 瘦索引快照（`v: 2` 按页有序 `id` 索引，前 3 页 / 60 个 `id`，12h 新鲜、7 天保留，`@me:` 私有快照登出即清，见 ADR-0027）。
- **Architectural Invariants (D2, D9, D10)**:
  - Update D2, D9, and D10 descriptions so they accurately describe `repo_card_cache`, the `v: 2` slim index contracts of `trend_board_cache` / `starred_feed_cache` / `search_list_cache`, and unified `get_repo_cards_batch` / `hydrateCardsByIds` batch hydration (removing outdated references to 256KB/512KiB `AppSummary` truncation ladders in `trend_board_cache` and unconfirmed-empty-platform rejection in `repoEnrichCache`).

### 3. Full Verification & Regression Gates

Run and verify clean exit codes on all repository gates:
1. `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings`
2. `cargo test --manifest-path src-tauri/Cargo.toml`
3. `npx tsc --noEmit`
4. `npx vitest run` (explicitly confirming `cmdAlignment.test.ts`, `ipcArgsNaming.test.ts`, `noDirectInvoke.test.ts`, and `countDisplay.test.ts` all pass)
5. `npx vite build --config vite.demo.config.ts`

## Acceptance Criteria

- [ ] `docs/adr/0027-isolated-repo-card-cache-and-slim-id-list-indexes.md` is complete, accurate, and cross-linked from `ADR-0014`, `ADR-0015`, `ADR-0026`, `CONTEXT.md`, and `.scratch/unified-repo-card-and-index-caches/spec.md`.
- [ ] `CONTEXT.md` terminology and D2/D9/D10 invariants match the implemented code without stale numbers or change-history narration.
- [ ] All 5 verification commands (`cargo clippy`, `cargo test`, `npx tsc --noEmit`, `npx vitest run`, `npx vite build --config vite.demo.config.ts`) pass with zero warnings and zero errors.
