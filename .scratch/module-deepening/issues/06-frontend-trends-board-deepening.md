# Issue 06: True Consolidation of `services/trends/` & Slimming `useTrendEnrichment`

Status: done
Blocked by: 05

## Summary

Although `src/services/trends/board.ts` (1368 lines) states in its header that `boards.ts + cache.ts + enrich.ts` are sealed behind a single deep module interface, inspection shows a **Large Interface / Shallow Facade** split:

1. `fetchTrendsResultSeam` (`board.ts` L92–96) is a pure pass-through forwarder to `boards.fetchTrendsResult` created only to avoid a barrel re-export naming collision.
2. `useTrendBoard.ts` and `TrendsView.tsx` still bypass `board.ts` to import directly from `boards.ts` (`subscribeBoardHydrated`, `boardGainKey`, `resolveTrendBoard`, `TREND_BOARD_IDS`), `parse.ts` (`normalizeProxyPrefix`), and `enrich.ts` (`formatStars`, `matchCatalogApp`).
3. `src/views/TrendsView/useTrendEnrichment.ts` imports **26 granular step helpers** from `board.ts` (`applyPlatformsHealToMirror`, `applyRichcardHealToMirror`, `boardRepoKeys`, `buildSwrFill`, `cleanupPlatformsHealConfirmed`, `collectEmptyIconKeys`, `collectMissingEnrichRepos`, `flushBoardPersistWithMirror`, `getBoardPersistKey`, `maybePersistBoardNow`, `maybePersistRichcardHeal`, `maybeScheduleBoardPersist`, `mergeDbIconsIntoMirror`, `mergeEnrichFoundMirror`, `mergeSwrConfirmedMirror`, `mergeSwrEnrichedMirror`, `noteBoardReposForPersist`, `putBoardEnrichMemory`, `removeConfirmedForConcrete`, `resolveBoardCacheKey`, `subscribeBoardPersistOnConfirmedChange`, `subscribeTrendHealBus`, `unmarkConcreteKeys`, `unmarkPlatformsHealKeys`, etc.) PLUS `enrichTrendRepos` from `enrich.ts`, manually wiring the entire SWR → DB-icon-backfill → enrich → heal-bus → debounced-L2 persistence pipeline inside the view hook.

## Scope

- `src/services/trends/board.ts`
- `src/services/trends/boards.ts`
- `src/services/trends/cache.ts`
- `src/services/trends/enrich.ts`
- `src/services/trends/parse.ts`
- `src/views/TrendsView/useTrendBoard.ts`
- `src/views/TrendsView/useTrendEnrichment.ts`
- `src/views/TrendsView.tsx`
- `src/views/TrendsView*.test.tsx` & `src/services/trends/*.test.ts`

## Implementation Details

### 1. Make `services/trends` a real deep module (not a 26-helper toolkit)
- Remove the pure forwarder `fetchTrendsResultSeam` by merging `boards.ts` and `board.ts` (or exposing `fetchTrendBoard` cleanly once without naming collision).
- Sink the trend-mirror enrichment orchestrator (SWR fill, DB confirmed-icon backfill, `enrichTrendRepos` batching/dedup, `zstore://icon-ready` write subscription, detail heal bus subscription, and debounced L2 persistence + pagehide/unmount flush) into `services/trends` behind a cohesive controller / store interface (e.g., `createTrendBoardSession` or unified `useTrendBoard` / `services/trends` controller) that emits reconciled `{ enrichedApps, confirmedOtherIds }` state snapshots.
- Stop exporting internal micro-steps (`noteBoardReposForPersist`, `mergeSwrConfirmedMirror`, `unmarkConcreteKeys`, etc.) from the public `trends` interface; keep them module-private (`internal seams`).

### 2. Re-route external shared utilities cleanly
- Keep the few cross-feature exports actually needed outside `TrendsView` (`appSummaryFromDetail`, `isPlaceholderDescription`, `formatStars`, `snapshotTrendEnrichCache`, `persistBoardCacheFromDetailIfPresent`, heal event payloads) on a small, explicit `services/trends` surface so `AppCard.tsx`, `useHomeFeed.ts`, `favoritesUncataloged.ts`, and `useDetailCacheSync.ts` don't reach into `trends` internals.

### 3. Preserve ADR-0011 / ADR-0014 / D9 invariants
- Preserve L1/L2 TTLs (`daily` 1h, others 12h with jitter), 256KB FE pre-check, `BOARD_GEN` / `attemptedEnrichKeysRef` anti-reentrancy, `data:` never hitting disk L2, and `doforce` 12h single-flight + single 429 retry.

### 4. Replace-don't-layer tests
- Update `src/services/trends/*.test.ts` and `src/views/TrendsView*.test.tsx` to assert observable board-fetch, SWR hydration, enrichment, and L2 write-through behavior through the deepened `trends` / `TrendsView` interface rather than calling 26 internal helpers.

## Acceptance Criteria

- [ ] `fetchTrendsResultSeam` forwarder is eliminated; `board.ts` and `boards.ts` no longer duplicate the facade boundary.
- [ ] `useTrendEnrichment.ts` (or its replacement) no longer imports 26 step-by-step merge/persist helpers; orchestration lives inside `services/trends`.
- [ ] `TrendsView.tsx` and `useTrendBoard.ts` consume a single clean `services/trends` interface.
- [ ] `pnpm test` and `pnpm build` pass completely.
