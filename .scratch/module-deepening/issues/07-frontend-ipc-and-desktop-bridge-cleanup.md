# Issue 07: Clean Up Shallow IPC Wrappers & Desktop Shell Bridge

Status: done
Blocked by: 05

## Summary

Around the frontend IPC seam (`src/services/api.ts` + `src/services/api/client.ts`), several micro-files exist purely as 1-function pass-throughs or circular-dependency workarounds, and `submitPrefillFlow.ts` duplicates fallback logic already performed inside `openUrl`:

1. **`src/services/api/zlog.ts` (12 lines)**: Contains only two 1-line `tauriInvoke` wrappers (`getLogDir`, `exportLogBundle`), which are then re-wrapped onto `tauriApi` in `services/api.ts`.
2. **`src/services/appProcess.ts` (13 lines)**: Contains only one 1-line wrapper (`restartApp()` calling `tauriInvokePlugin('plugin:process|restart')`), called in production solely by `ClientUpdateRow.tsx`.
3. **`src/utils/fallbackOpener.ts` (24 lines)**: Split out solely to break a `services/api/settings.ts -> utils/browserLockdown.ts -> services/api.ts` import cycle caused by keeping `openUrl` (a desktop-shell browser launcher with native `window.open` fallback) inside `services/api/settings.ts`.
4. **`src/views/pending/submitPrefillFlow.ts` (`openPrefillPage`, lines 29–47)**: Wraps `tauriApi.openUrl(trimmed)` and on catch re-runs the exact same `resolveFallbackOpener()` fallback that `services/api/settings.ts::openUrl` (lines 64–85) already executes.

## Scope

- `src/services/api.ts`
- `src/services/api/zlog.ts` (delete)
- `src/services/api/settings.ts`
- `src/services/appProcess.ts` (delete / merge)
- `src/services/window.ts` (or consolidated `src/services/desktop.ts`)
- `src/utils/fallbackOpener.ts` (merge)
- `src/utils/browserLockdown.ts`
- `src/utils/browserLockdown.test.ts`
- `src/components/ClientUpdateRow.tsx`
- `src/components/ResizeHandles.tsx`
- `src/components/TitleBar.tsx`
- `src/views/pending/submitPrefillFlow.ts`
- `src/views/noDirectInvoke.test.ts`
- `src/services/api/settings.openUrl.test.ts`

## Implementation Details

### 1. Delete `services/api/zlog.ts` and `services/appProcess.ts`
- Inline the 2 tiny `zlogGetDir` / `zlogExportBundle` calls into `services/api/settings.ts` (or directly in `services/api.ts` `tauriApi`) and delete `src/services/api/zlog.ts`.
- Fold `restartApp()` (`plugin:process|restart`) into `src/services/window.ts` (renamed/aliased cleanly or kept as `services/desktop.ts` / `services/window.ts` — verify `noDirectInvoke.test.ts` rules and update `ClientUpdateRow.tsx` + `noDirectInvoke.test.ts` comments accordingly).

### 2. Unify `openUrl` / `resolveFallbackOpener` and break the import cycle properly
- Consolidate `resolveFallbackOpener` back into `utils/browserLockdown.ts` (or keep `openUrl`'s desktop/browser shell handling cleanly decoupled so `browserLockdown.ts` does not need a cycle through `services/api.ts` — e.g. `browserLockdown.ts` accepts `openUrl` callback at init or calls `tauriInvoke` via a leaf shell seam, OR `openUrl` lives in the desktop shell module `services/desktop.ts` while `tauriApi.openUrl` aliases it).
- Delete `src/utils/fallbackOpener.ts` once the cycle is resolved cleanly without breaking `services/api/settings.openUrl.test.ts` or `utils/browserLockdown.test.ts`.
- Delete `openPrefillPage` in `src/views/pending/submitPrefillFlow.ts` and call `tauriApi.openUrl(url)` directly (since `openUrl` already includes native `resolveFallbackOpener` fallback and `popup_blocked` error propagation).

### 3. Respect IPC alignment & anti-bypass gates
- Keep `src/services/api/client.ts` (`tauriInvoke`, `tauriInvokePlugin`, `isTauri`) as the sole raw `invoke` seam, and keep `CMD` and `tauriApi` in `src/services/api.ts` completely intact so `cmdAlignment.test.ts`, `ipcArgsNaming.test.ts`, and `noDirectInvoke.test.ts` pass strictly.

## Acceptance Criteria

- [ ] `src/services/api/zlog.ts`, `src/services/appProcess.ts`, and `src/utils/fallbackOpener.ts` are deleted.
- [ ] `submitPrefillFlow.ts` no longer duplicates `openUrl`'s fallback opener logic.
- [ ] `noDirectInvoke.test.ts`, `cmdAlignment.test.ts`, `ipcArgsNaming.test.ts`, `settings.openUrl.test.ts`, and `browserLockdown.test.ts` all pass.
- [ ] `pnpm test` and `pnpm build` pass completely.
