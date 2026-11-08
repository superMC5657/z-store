# Issue 03: Trends `BOARD_GEN` Stability & M1 `data:` Icon Admission

Status: resolved
Blocked by: none

## Summary

Fix two frontend/SWR coordination defects in the Trends Rich Card List pipeline that cancel background `fetch_icons_stream` tasks and prevent pre-confirmed `data:` icons from rendering:
1. **`useTrendEnrichment` re-entry loop increments `BOARD_GEN` and kills `fetch_icons_stream`**:
   - In `src/views/TrendsView/useTrendEnrichment.ts`, the enrichment `useEffect` depends on `displayItems`.
   - In `src/views/TrendsView.tsx`, `displayItems` is recomputed whenever `enrichedApps` or `combinedConfirmed` changes.
   - If even one repo on the current board fails `fetch_online_repo` on the backend (returning `None`, e.g., a deleted/renamed repo or transient failure), calling `setEnrichedApps` with the remaining repos updates `displayItems` and re-triggers the `useEffect`. Because the failed repo is still absent from `enrichedApps`, `collectMissingEnrichRepos` immediately returns `[failedRepo]` and invokes `enrich_trend_repos` again.
   - Every `enrich_trend_repos` call on the backend (`src-tauri/src/commands/catalog_search.rs:718`) increments `BOARD_GEN`, which causes the running `fetch_icons_stream` from the initial board load to trip `should_stop()` (`BOARD_GEN.load() != gen`) and abort all remaining L3 icon probes and `zstore://icon-ready` events.
2. **Pre-confirmed `data:` icons stripped without admitting to M1 `iconStore`**:
   - When `enrich_trend_repos` finds an existing `Confirmed Icon` on disk (`cache_file`), `resolve_confirmed_icon_from_db` returns `data:image/...;base64,...` in `AppSummary.icon` and skips `fetch_icons_stream` (`pre_confirmed.is_some()`).
   - On the frontend, `enrichTrendReposCore` (`src/services/trends/enrich.ts`) does not call `admitIconHit` for `data:` icons, and then strips `data:` icons to `icon: ''` when persisting to `trendEnrichCache` and `trend_board_cache` (to keep memory/disk caches slim). When the component re-renders from cache or after board reconciliation, `item.icon` is `''` and M1 `iconById` has no entry, leaving the card without its icon.

> **Constraint**: Preserve the existing invariant tested by `src/services/trends/enrich.simplify.test.ts` (`批量 data: 只活当次 out 永不进内存`) and `src/services/trends/swr-view.test.tsx`: `trendEnrichCache` and L2 `trend_board_cache` (`save_trend_board_cache`) must **never** store `data:` strings (`icon` in `trendEnrichCache` and L2 cache stays `''`). Instead, admit `data:` icons into the bounded M1 `iconStore` (`admitIconHit`), which is capped at 256 entries and consulted by `resolveIconWithBuffer` / `AppIcon`.

## Scope

- `src/views/TrendsView/useTrendEnrichment.ts`
- `src/services/trends/enrich.ts`
- `src/services/trends/board.ts`
- `src/services/trends/swr-view.test.tsx`

## Implementation Details

### 1. Track attempted enrichment keys per board cycle in `useTrendEnrichment.ts`

In `src/views/TrendsView/useTrendEnrichment.ts`:
- Add a ref `const attemptedEnrichKeysRef = useRef<Set<string>>(new Set());` (and track the `(trendResult, activeBoard)` identity it belongs to).
- Whenever `trendResult` or `activeBoard` changes, clear `attemptedEnrichKeysRef.current`.
- Before calling `enrichTrendRepos(toEnrich, activeBoard)`:
  - Filter `missing` (`collectMissingEnrichRepos(displayItems, enrichedApps)`) to exclude any repo whose lowercase `fullName.toLowerCase()` is already in `attemptedEnrichKeysRef.current`.
  - If the filtered `toEnrich` is empty, return early without calling `enrichTrendRepos`.
  - Mark every `r.fullName.toLowerCase()` in `toEnrich` as attempted in `attemptedEnrichKeysRef.current` before dispatching `enrichTrendRepos`.
- This guarantees that within a single `(trendResult, activeBoard)` cycle:
  - Each missing repo is requested via `enrich_trend_repos` at most once.
  - A repo that returns `null` from `fetch_online_repo` (or updates to `enrichedApps` / `combinedConfirmed` that recreate `displayItems`) will never trigger a secondary `enrich_trend_repos` call that increments `BOARD_GEN` and kills the active `fetch_icons_stream`.

### 2. Admit `Confirmed Icon` (`data:` or `http(s):`) into M1 `iconStore` during `enrichTrendReposCore`

In `src/services/trends/enrich.ts` (`enrichTrendReposCore`, around lines 473–495):
- Import `admitIconHit` from `../iconStore`.
- When iterating over `valid` summaries returned by `enrichTrendRepos`:
  - If `s.icon && s.icon.trim() !== ''`, call `admitIconHit({ id: key, icon: s.icon, via: 'm2' })` (where `key = s.id.toLowerCase()`).
  - Keep the existing stripping logic for `trendEnrichCache.set(key, { ...s, icon: s.icon?.startsWith('data:') ? '' : s.icon })` and L2 persistence so `trendEnrichCache` and `trend_board_cache` remain 100% free of `data:` payloads.
- Verify that `resolveIconWithBuffer(appId, item.icon, confirmedIcons)` in `src/services/iconStore.ts` returns the M1 `iconById` entry whenever `item.icon` is `''` (after cache strip), so `TrendsView` and `AppIcon` render the pre-confirmed icon immediately and across SWR re-renders.

## Acceptance Criteria

- [x] When a trend board contains a repo that `enrich_trend_repos` fails to resolve (returns fewer `AppSummary` items than requested), `useTrendEnrichment` does **not** re-invoke `enrich_trend_repos` on subsequent renders of the same `(trendResult, activeBoard)`.
- [x] Switching `activeBoard` or receiving a new `trendResult` resets `attemptedEnrichKeysRef` so new missing repos are enriched normally.
- [x] When `enrich_trend_repos` returns a summary with a `data:image/...` icon, `admitIconHit` populates M1 `iconById` for that lowercase `app_id`, while `trendEnrichCache` and L2 `save_trend_board_cache` still store `icon: ''`.
- [x] Existing tests in `src/services/trends/enrich.simplify.test.ts` and `src/services/trends/swr-view.test.tsx` continue to pass, and new regression tests in `src/services/trends/swr-view.test.tsx` verify both single-flight enrichment on partial backend failure and M1 `iconStore` admission for `data:` icons.
