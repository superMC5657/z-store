Status: done
Blocked by: 01, 02, 03, 04, 05

## Goal

Update `CONTEXT.md` and relevant ADRs (`docs/adr/0014-trends-l2-and-governance.md`, `docs/adr/0015-unified-icon-fetch-and-search-alignment.md`) to reflect the unified local-cache-first icon & rich-card architecture and full detail write-through, and run the full Rust + Vitest regression suite + demo build check.

## Context

- Spec: `.scratch/icon-and-cache-local-first/spec.md`
- Key files:
  - `CONTEXT.md`
  - `docs/adr/0014-trends-l2-and-governance.md`
  - `docs/adr/0015-unified-icon-fetch-and-search-alignment.md`
  - `src/api/__tests__/ipcArgsNaming.test.ts`
  - `src/api/__tests__/noDirectInvoke.test.ts`

## Acceptance Criteria

1. **Domain Docs & ADRs Updated**:
   - Update `CONTEXT.md` to document:
     - Unified content-addressed `icons/` disk lookup (`sha256(url)[0:16].{ext}`) shared across cataloged and uncataloged apps, with 7-day soft TTL + stale-while-revalidate fallback on network failure.
     - Frontend `AppIcon` local-first rendering (no direct external `<img src="https://...">` race before checking local cache; reactive `subscribeIconWrites` update).
     - Full persistence of confirmed `data:` icons in `trendEnrichCache` and `trend_board_cache` (with 7-day L2 stale fallback window).
     - End-to-end write-through when `AppDetailModal` receives fresh `AppDetail` across backend (`app_details_cache`, `CatalogService`, `app_icon_cycles`, `icons/`) and frontend (`detailMemoryCache`, `iconDataCache`, `trendEnrichCache`, `trend_board_cache`, `searchListCache`, and active list views).
   - Update `docs/adr/0014-trends-l2-and-governance.md` and `docs/adr/0015-unified-icon-fetch-and-search-alignment.md` so they accurately describe current behavior (per `AGENTS.md`: describe what it does now, not change history).

2. **Full Regression & Architecture Verification**:
   - `cargo test --manifest-path src-tauri/Cargo.toml` passes with 0 failures.
   - `npx vitest run` passes with 0 failures (including `ipcArgsNaming.test.ts` and `noDirectInvoke.test.ts`).
   - `npm run build` (and demo build check if applicable) succeeds cleanly.
