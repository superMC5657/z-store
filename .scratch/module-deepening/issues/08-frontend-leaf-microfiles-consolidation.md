# Issue 08: Consolidate Frontend Single-Function / Single-Constant Leaf Micro-files

Status: done
Blocked by: 07

## Summary

A cluster of 10–55 line frontend files each contain a single constant, single pure helper, or thin 2-div wrapper component, spreading tightly coupled concepts across unnecessary modules:

1. [`src/lib/manualOnly.ts`](file:///z:/rust_workplace/z-store/src/lib/manualOnly.ts) (13L): Exports one constant `MANUAL_ONLY_NETWORK = true` used in 2 files.
2. [`src/utils/notify.ts`](file:///z:/rust_workplace/z-store/src/utils/notify.ts) (11L) + [`src/useToasts.ts`](file:///z:/rust_workplace/z-store/src/useToasts.ts) (44L): Split the `zstore:toast` event emitter and listener across two separate folders.
3. [`src/views/useViewFilter.ts`](file:///z:/rust_workplace/z-store/src/views/useViewFilter.ts) (19L): Named `use*` despite not being a React Hook; contains only one 9-line function `matchesAppText`, used solely by `FavoritesView.tsx`.
4. [`src/views/pending/pendingText.ts`](file:///z:/rust_workplace/z-store/src/views/pending/pendingText.ts) (10L) + [`src/views/pending/pendingStyles.ts`](file:///z:/rust_workplace/z-store/src/views/pending/pendingStyles.ts) (31L): Single 1-line `errorText` helper + 3 CSSProperties constants (while CSS classes already live in `components-pending.css`).
5. [`src/components/AppDetailModal/openExternal.ts`](file:///z:/rust_workplace/z-store/src/components/AppDetailModal/openExternal.ts) (9L): Single 3-line `handleOpenExternal` used only in `AppDetailModal/index.tsx` and `Header.tsx`.
6. [`src/views/SettingsView/SettingsSection.tsx`](file:///z:/rust_workplace/z-store/src/views/SettingsView/SettingsSection.tsx) (19L): Thin 2-div wrapper used only by the 5 sections under `SettingsView/sections/`.
7. [`src/components/hostEnv.ts`](file:///z:/rust_workplace/z-store/src/components/hostEnv.ts) (28L): 2 UA detection functions (`detectHostOs`, `detectHostArch`) consumed only by `AppDetailModal/index.tsx` to feed `isInstallableAssetKind` / `sortAssetsByRelevance` in `src/utils/appHelper.ts`.
8. [`src/app/platformStorage.ts`](file:///z:/rust_workplace/z-store/src/app/platformStorage.ts) (54L) + [`src/views/ViewShell.tsx`](file:///z:/rust_workplace/z-store/src/views/ViewShell.tsx#L18-L68): **Bi-dimensional Filter** platform selection storage and reset broadcast are split between `app/platformStorage.ts`, `lib/platformFilter.ts`, and `ViewShell.tsx`.
9. [`src/app/navigation.ts`](file:///z:/rust_workplace/z-store/src/app/navigation.ts) (40L): Holds `VIEW_TYPES` / `ViewType` (causing `src/types/index.ts` to re-export from `app/navigation`) plus a 5-line `createNavigate` wrapper.

## Scope

- `src/lib/{manualOnly.ts, platformFilter.ts}`
- `src/app/{platformStorage.ts, navigation.ts, selectors.ts, favoritesUncataloged.ts, hooks/useAppSubscriptions.ts}` (and `.test.*` files referencing `manualOnly` / `platformStorage`)
- `src/utils/{notify.ts, appHelper.ts}`
- `src/useToasts.ts` (and `App.tsx`, `ClientUpdateRow.tsx`, `DataBackupRow.tsx`, `LogExportRow.tsx`, `OAuthAccountCard.tsx`, `useAppSettings.ts`, `HomeView.tsx`, `TrendsView.tsx`, `AppDetailModal/*`)
- `src/components/{hostEnv.ts, hostEnv.test.ts, AppDetailModal/openExternal.ts, AppDetailModal/index.tsx, AppDetailModal/Header.tsx, AppDetailModal/useDetailStarVerify.ts, Sidebar.tsx, Sidebar.test.tsx}`
- `src/views/{useViewFilter.ts, ViewShell.tsx, FavoritesView.tsx, SettingsView.tsx, SettingsView/SettingsSection.tsx, SettingsView/sections/*.tsx}`
- `src/views/pending/{pendingText.ts, pendingStyles.ts, draftModel.ts, PendingDraftForm.tsx, PendingRichCard.tsx, submitPrefillFlow.ts}` & `src/views/PendingView.tsx`
- `src/styles/components-pending.css`
- `src/types/index.ts`

## Implementation Details

- **Toast Bus Locality**: Merge `src/utils/notify.ts` and `src/useToasts.ts` into one module (e.g. `src/lib/toasts.ts` or `src/useToasts.ts` exporting both `notifyToast` and `useToasts`), so emitting and listening to `zstore:toast` share one file.
- **Platform Filter Consolidation**: Merge `src/app/platformStorage.ts` (`PLATFORM_FILTER_STORAGE_KEY`, `parseSelectedPlatforms`, `loadSelectedPlatforms`) and `broadcastPlatformReset` (currently in `ViewShell.tsx`) into `src/lib/platformFilter.ts`, making `lib/platformFilter.ts` the single module for platform filter rules, persistence, and reset.
- **Host & Asset Matching**: Move `detectHostOs` / `detectHostArch` from `src/components/hostEnv.ts` into `src/utils/appHelper.ts` alongside `isInstallableAssetKind` and `sortAssetsByRelevance` (updating `hostEnv.test.ts` imports or folding into `appHelper.assets.test.ts`).
- **Pending View Cleanup**: Move `errorText` into `src/views/pending/draftModel.ts` (deleting `pendingText.ts`), move the 3 CSS rules in `pendingStyles.ts` into `src/styles/components-pending.css` as CSS classes (deleting `pendingStyles.ts`), and move `ShowToast` type directly to `src/types/index.ts`.
- **Other Micro-files**:
  - Fold `matchesAppText` from `src/views/useViewFilter.ts` into `src/app/selectors.ts` (or `src/utils/appHelper.ts`) and delete `useViewFilter.ts`.
  - Inline `handleOpenExternal` into `src/components/AppDetailModal/index.tsx` / `Header.tsx` (or `utils/appHelper.ts`) and delete `AppDetailModal/openExternal.ts`.
  - Keep `SettingsSection` inside `SettingsView.tsx` (or `SettingsView/sections/`) without a standalone 19-line file, OR fold into `SettingsView.tsx` + `sections/shared.tsx`.
  - Move `VIEW_TYPES` and `ViewType` back into `src/types/index.ts` (eliminating the `types -> app/navigation` reverse export), keeping `isViewType` / `createNavigate` lightweight in `App.tsx` or `types/index.ts`.
  - Remove `src/lib/manualOnly.ts` (keep the comment/invariant in `CONTEXT.md` / `favoritesUncataloged.ts` & `useAppSubscriptions.ts` where DB-only gating actually executes, or consolidate into `app/favoritesUncataloged.ts` if a shared constant is desired).
- Verify `src/components/components.i18n.scan.test.ts` paths and `App.platformFilter.test.tsx` / `App.platformGuard.test.tsx` / `Sidebar.test.tsx` remain green.

## Acceptance Criteria

- [ ] Deleted micro-files: `lib/manualOnly.ts`, `utils/notify.ts`, `views/useViewFilter.ts`, `views/pending/pendingText.ts`, `views/pending/pendingStyles.ts`, `components/AppDetailModal/openExternal.ts`, `components/hostEnv.ts`, `app/platformStorage.ts`, `app/navigation.ts`, `views/SettingsView/SettingsSection.tsx`.
- [ ] `src/types/index.ts` no longer re-exports core types from `src/app/`.
- [ ] `pnpm test` (including `components.i18n.scan.test.ts` and `noDirectInvoke.test.ts`) and `pnpm build` pass completely.
