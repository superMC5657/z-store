# Issue 04: Domain Docs Sync & End-to-End Regression Verification

Status: resolved
Blocked by: 01, 02, 03

## Summary

Synchronize the single-context domain model (`CONTEXT.md`) and `docs/adr/0015-unified-icon-fetch-and-search-alignment.md` with the updated icon discovery, level origin tracking, and `BOARD_GEN` stability invariants, and run the full Rust + TypeScript verification suite.

## Scope

- `CONTEXT.md`
- `docs/adr/0015-unified-icon-fetch-and-search-alignment.md`

## Implementation Details

### 1. Update `CONTEXT.md` (Section `D10 · 图标缓存与多级探索`)

Update `D10` in `CONTEXT.md` to accurately reflect what the system does now (per `AGENTS.md`: *"describe what it does now, not change history"*):
- Clarify that `fetch_app_detail` tracks the explicit discovery level (`L2` SimpleIcons, `L3` Repo Tree, `L4` README, `L5` Owner Avatar) and writes both `probed_hit` (`l2_url`/`l3_url`) and `extracted_logo` (`l4_url`) into `app_icon_cycles` when both are found, rather than inferring the level solely from a rewritten `raw.githubusercontent.com` URL.
- Clarify that `icon_probe::verify_image` short-circuits on HTTP `404`/`410` from `HEAD` without falling through to `Range GET` or full `GET`, and `resolve_probe_branches` falls back to `["HEAD"]` when `default_branch` lookup fails or times out.
- Clarify that `enrichTrendReposCore` admits non-empty `Confirmed Icon` payloads (including `data:`) into the M1 `iconStore` buffer (`admitIconHit`) before stripping `data:` from `trendEnrichCache` and L2 `trend_board_cache`.

### 2. Update `docs/adr/0015-unified-icon-fetch-and-search-alignment.md`

Update ADR-0015 sections (§2, §3, §6):
- Document HTTP `404`/`410` terminal short-circuiting in `verify_image` and `"HEAD"` branch fallback in `resolve_probe_branches`.
- Document explicit L2/L3/L4 slot attribution in `fetch_app_detail` / `persist_github_detail` and `AppIconCycle::level_for_known_url`.
- Document per-board attempted-key deduplication in `useTrendEnrichment` so partial `enrich_trend_repos` failures do not bump `BOARD_GEN` and abort `fetch_icons_stream`.

### 3. Run Full Verification Suite

Execute and verify clean passes for:
1. `cargo test --manifest-path src-tauri/Cargo.toml`
2. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
3. `npx tsc --noEmit`
4. `npx vitest run`

## Acceptance Criteria

- [x] `CONTEXT.md` (`D10`) and `docs/adr/0015-unified-icon-fetch-and-search-alignment.md` are updated and consistent with the codebase glossary.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passes with 0 failures.
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` passes with 0 warnings.
- [x] `npx tsc --noEmit` passes with 0 type errors.
- [x] `npx vitest run` passes with 0 test failures (including `ipcArgsNaming.test.ts`, `noDirectInvoke.test.ts`, `enrich.simplify.test.ts`, and `swr-view.test.tsx`).
