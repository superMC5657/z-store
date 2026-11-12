# Issue 05: Deepen Frontend `Draft` / `Local Library` Domain (`services/custom/`)

Status: done
Blocked by: none

## Summary

The frontend **Draft** / **Local Library** (`custom_apps`) domain is split across 5 tiny files in `src/services/custom/` while 360+ lines of draft heuristic construction (`buildCustomDraftItemFromSummary`, `draftForgeGateError`, `guessDraftCategoryKey`, `buildDraftIdentifiers`, etc.) sit misplaced inside the IPC client file `src/services/api/catalog.ts` (L450–815):

- `src/services/custom/status.ts` (11 lines, single function `isCollectedStatus`, plus a single-line re-export in `src/app/selectors.ts`)
- `src/services/custom/iconUrl.ts` (13 lines, single function `resolveRemoteIconUrl`)
- `src/services/custom/draft.ts` (82 lines, single exported function `moveInToDraft`, importing `draftForgeGateError` & `buildCustomDraftItemFromSummary` backwards from `services/api/catalog.ts`)
- `src/services/custom/types.ts` (87 lines)
- `src/services/custom/mappers.ts` (146 lines)

This creates reverse dependencies (`custom/draft.ts` → `api/catalog.ts`), splits trivial single-function files, and mixes pure domain heuristics into the IPC adapter layer.

## Scope

- `src/services/custom/` (`index.ts` or consolidated module replacing `status.ts`, `iconUrl.ts`, `draft.ts`, `mappers.ts`, `types.ts`)
- `src/services/custom/draft.test.ts` & `src/services/custom/mappers.test.ts`
- `src/services/api/catalog.ts` & `src/services/api/catalog.draftIcon.test.ts`
- `src/app/selectors.ts`
- `src/app/hooks/useCustomApps.ts`
- `src/app/hooks/useDetailCacheSync.ts`
- `src/components/AppDetailModal/Header.tsx`
- `src/views/HomeView.tsx`
- `src/views/TrendsView.tsx`
- `src/views/PendingView.tsx`

## Implementation Details

### 1. Consolidate `src/services/custom/` into a single deep module
- Merge `status.ts` (11L), `iconUrl.ts` (13L), `draft.ts` (82L), `mappers.ts` (146L), and `types.ts` (87L) into a cohesive `src/services/custom.ts` (or `src/services/custom/index.ts` with clear internal cohesion instead of 5 micro-files).
- Move `draftForgeGateError`, `buildCustomDraftItemFromSummary`, and all draft heuristic helpers (`normalizeDraftIcon`, `guessDraftPlatformsFromName`, `buildDraftIdentifiers`, `buildDraftInstallDirs`, `buildDraftPublishers`, `buildDraftAliases`, `guessDraftCategoryKey`, `resolveDraftCategory`) from `src/services/api/catalog.ts` (lines ~450–815) into `services/custom`.
- Move `copyTextToClipboard` out of `services/api/catalog.ts` into `src/utils/` (or keep it with DOM/clipboard helpers) so `services/api/catalog.ts` becomes a clean IPC command wrapper again.

### 2. Clean up caller imports and redundant re-exports
- Update `useCustomApps.ts`, `useDetailCacheSync.ts`, `AppDetailModal/Header.tsx`, `HomeView.tsx`, `TrendsView.tsx`, `PendingView.tsx`, and `selectors.ts` to import directly from the consolidated `services/custom` interface.
- Keep `isCollectedStatus` as the single canonical source (CONTEXT.md invariant), without extra pass-through micro-file indirection.
- Preserve `DraftStatus` (`'draft' | 'submitted' | 'collected' | 'local_collected'`), ADR-0010 canonical ID gate, ADR-0017 `is_verified: false` invariant, and `zstore:custom-apps-changed` event behavior.

### 3. Replace-don't-layer tests
- Update `src/services/custom/*.test.ts` and `src/services/api/catalog.draftIcon.test.ts` to test through the deepened `services/custom` interface (in-process, mocking only `tauriApi` at the IPC seam for `moveInToDraft`).

## Acceptance Criteria

- [ ] `status.ts`, `iconUrl.ts`, `draft.ts`, `mappers.ts`, and `types.ts` micro-files are consolidated; `services/api/catalog.ts` contains no draft heuristic builder logic (`buildCustomDraftItemFromSummary` / `guessDraftCategoryKey`).
- [ ] Zero reverse import from `services/custom` into `services/api/catalog`.
- [ ] `pnpm test` and `pnpm build` pass completely.
