# Issue 09: Frontend IconStore Cycling, Trends Board Param, Demo Parity & Contract Tests

Status: resolved
Severity: High (F-19 [High], F-20 [Medium], F-23 [Medium], Test Gaps #5 & #7)
Fix Track: Track 4 (`fix-fe-services`)
Findings: F-19, F-20, F-23, Test Gaps #5 & #7

## Findings

### F-19 [High]: Manual icon cycling forward (L1→L2→L3→L4) rejected as `level-stale` by `iconStore`; L5 badge level deleted instead of recorded
- **Locations**:
  - `src/services/iconStore.ts:200-212, 828-851, 1120-1129, 1165-1170, 1200-1216`
  - Consumer reference: `src/components/AppDetailModal/Header.tsx:105-118, 160-180`
- **Trigger**:
  1. Opening `AppDetailModal` on an uncataloged app runs `restoreOrFetchIconCycle` → `admitIconCycleResult` → `admitIconHit`, recording e.g. `iconLevelById.set(id, 2)`. Clicking "Cycle Icon" rotates to L3/L4 and persists `pinned = true` in SQLite `app_icon_cycles`, then calls `admitIconCycleResult`. `admitIconHit:1123-1127` evaluates `compareIconPriority(3, 2) > 0` and rejects the update with `{ accepted: false, reason: 'level-stale' }`, leaving `iconById`, `repoEnrichCache`, and card lists stuck on L2 until restart.
  2. Cycling to L5 (`icon: '', level: 5`) enters `applyBadgeHit` (`iconStore.ts:838`) → `deleteBufferedIcon(t)` calls `iconLevelById.delete(k)` (`iconStore.ts:1169`) instead of `rememberIconLevel(k, 5)`. Consequently `resolveIconWithBuffer`'s L5 guard `iconLevelById.get(...) === 5` (`iconStore.ts:209`) is unreachable dead code, and late `zstore://icon-ready` / hydration overwrites the pinned L5 badge.
- **Impact**: User-pinned icons drift immediately between SQLite `app_icon_cycles` and frontend caches/views; L5 badge pinning is silently overwritten.

### F-20 [Medium]: `enrichTrendRepos` frontend wrapper omits `board` param, disabling cross-board `stale-board` icon gating
- **Locations**:
  - `src/services/api/catalog.ts:169-179`
  - `src/services/trends/board.ts:1105-1125`
  - `src/services/iconStore.ts:359-374, 866-875, 938-945`
  - Backend reference: `src-tauri/src/commands/catalog_search.rs:593-612`
- **Trigger**: Rust `enrich_trend_repos` accepts `board: Option<String>` to tag `zstore://icon-ready` events with `IconFetchCtx::Trend { board, gen }`, but `src/services/api/catalog.ts:176` sends only `{ repos, forceRefresh }`. Backend always emits `board: ""`, making `iconStore.ts:939-941` (`if (ib && eb && ib !== eb) return 'stale-board'`) permanently false. Switching rapidly from board A to board B before board A emits its first event leaves `minGenWatermark === 0`, letting board A's late events overwrite board B's icons.
- **Impact**: Cross-board icon race on rapid initial Trends board switching; dead `board` IPC parameter.

### F-23 [Medium]: 3-way IPC & DemoStore drift (`settings_applied` type mismatch, Demo settings dropped on reload, invalid Demo icon cycle levels)
- **Locations**:
  - `src/types/index.ts:559-563` vs `src-tauri/src/models.rs:403-407`
  - `src/demo/handlers/settings.ts:11-42, 83-89` vs `src-tauri/src/commands/settings.rs:11-83`
  - `src/demo/handlers/catalog.ts:277-294` vs `src/services/iconStore.ts:15-22`
- **Trigger**:
  1. Rust `ImportUserDataResult.settings_applied` serializes as `usize` (number), while TS `ImportUserDataCounts` declares `boolean` and Demo returns `false`.
  2. Demo `handleSaveSetting` persists to `demoStore().settings` and `handleSwitchMirror` is a no-op (`settings.ts:40-42`), yet `handleGetSettings` (`settings.ts:11-28`) ignores `demoStore().settings` and returns only 4 display keys — losing all other persisted settings on reload.
  3. Demo `handleGetAppIconCycle` (`catalog.ts:283-292`) returns `level: 0` on `restore_or_fetch_icon_cycle` (rejected by `iconStore.ts` `isPureLevel` `1..=5`) and increments unboundedly (`1, 2, 3...`) on `cycle_app_icon` while `total_levels: 1`.
- **Impact**: Wire-type mismatch between Rust and TS/Demo; Demo mode silently loses user settings on reload and produces invalid icon levels.

### Test Gaps #5 & #7
- **Test Gap #5** (`src/services/api/cmdAlignment.test.ts`, `src/services/api/ipcArgsNaming.test.ts`): Tests verify `CMD` ↔ `lib.rs` and camelCase regex on `services/api/*`, but do NOT check `CMD` ↔ `src/demo/tauri-mock.ts` coverage (allowing Demo drift to slip through).
- **Test Gap #7** (`src/services/trends/swr-view.test.tsx:250`): Load-sensitive timeout flakes at 5000ms under heavy parallel CPU load.

## Acceptance Criteria

- [ ] `iconStore.admitIconHit` supports `force?: boolean` (used by `admitIconCycleResult`) so manual forward cycling (L1→L2→L3→L4) is accepted without `level-stale` rejection.
- [ ] `applyBadgeHit` removes buffered image from `iconById` while recording `rememberIconLevel(t, 5)` so the L5 guard blocks passive/late overwrites.
- [ ] Active `board` is threaded from `trends/board.ts` → `trends/enrich.ts` → `api/catalog.ts::enrichTrendRepos` → Rust `enrich_trend_repos` (camelCase `board`), updating Demo handler if applicable.
- [ ] `ImportUserDataResult.settings_applied` is typed `number` in `src/types/index.ts` and returned as a number in Demo `settings.ts`.
- [ ] Demo `handleGetSettings` merges all persisted `demoStore().settings` with defaults; `handleSwitchMirror` persists the active mirror; `handleGetAppIconCycle` starts at `level: 1` and wraps cleanly within `1..=total_levels`.
- [ ] `cmdAlignment.test.ts` (or companion test) verifies `CMD` ↔ `src/demo/tauri-mock.ts` coverage (Test Gap #5); `src/services/trends/swr-view.test.tsx:250` is stabilized against parallel CPU load (Test Gap #7).
- [ ] Regression tests cover F-19, F-20, F-23; `pnpm exec tsc --noEmit` and `pnpm exec vitest run` pass.

## Comments

- **Resolved in `1caf5dc`** (Track 4 `fix-fe-services`: `fix(fe-services): harden sanitizer, fix iconStore cycling, DemoStore parity, and private cache purge`).
- Added `force` override on `admitIconHit` and recorded level `5` in `applyBadgeHit` (`src/services/iconStore.ts`, `iconStore.cycle.test.ts`, F-19); threaded `board` through `trends/board.ts` → `trends/enrich.ts` → `api/catalog.ts::enrichTrendRepos` (F-20); aligned `ImportUserDataCounts.settings_applied: number` (`src/types/index.ts`) and fixed Demo `settings.ts` & `catalog.ts` (`statefulHandlers.test.ts`, F-23); strengthened `cmdAlignment.test.ts` for Demo handler parity (Test Gap #5) and stabilized `swr-view.test.tsx` (Test Gap #7).
- **Integrated verification on `main`** (`verifier` `verdict=PASS`): `tsc` 0 errors, `vitest` 142/142 files (1497/1497 tests).
