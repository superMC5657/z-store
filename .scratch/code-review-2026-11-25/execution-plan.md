# Parallel Remediation Execution Plan (2026-11-25)

All **39 confirmed findings (`F-01`..`F-39`)** and **7 test gaps** are partitioned into **6 strictly disjoint parallel fix tracks**. Each track runs in its own isolated `workspace: "share"` branch, owns an exclusive set of files, commits cleanly, and merges back into the integration branch with zero file conflicts.

---

## 1. Track Matrix & File Ownership

| Track | Agent | Scope Summary | Findings & Test Gaps | Tickets | Exclusive File Ownership |
|---|---|---|---|---|---|
| **Track 1** | `fix-rust-security` | Rust core security, checksums, star lists, proxy, mirror, readme, trends 401 | F-01, F-05, F-07, F-08, F-11, F-14, F-17, F-21, Test Gap #2 | 01, 02, 03 | `src-tauri/src/deeplink.rs`, `src-tauri/src/commands/forge.rs`, `src-tauri/src/commands/network.rs`, `src-tauri/src/github/mod.rs`, `src-tauri/src/github/developer_profile.rs`, `src-tauri/src/github/detail_fetch.rs`, `src-tauri/src/github/detail_assets.rs`, `src-tauri/src/github/readme_fetch.rs`, `src-tauri/src/forge/coord.rs`, `src-tauri/src/oauth/star.rs`, `src-tauri/src/oauth/tests.rs`, `src-tauri/src/proxy/windows.rs`, `src-tauri/src/mirror.rs` |
| **Track 2** | `fix-rust-installer` | Portable uninstall/shortcuts, asset selector, atomic upgrades, tarball strip, scanner | F-03, F-04, F-06, F-09, F-13, F-16, F-22A, Test Gaps #1, #3, #4 | 04, 05 | `src-tauri/src/commands/installer_uninstall.rs`, `src-tauri/src/commands/installer_install.rs`, `src-tauri/src/commands/installer_download.rs`, `src-tauri/src/commands/scanner.rs`, `src-tauri/src/installer/**`, `src-tauri/src/scanner/**` |
| **Track 3** | `fix-rust-storage` | OAuth revoke private isolation, userdata import, singleflight, icon lanes, DB locks | F-02 (BE), F-10, F-12, F-15, F-18, F-22B, Test Gap #6 (BE) | 06, 07, 08 | `src-tauri/src/oauth/mod.rs` *(+ optional `oauth/revoke_tests.rs`)*, `src-tauri/src/db/**`, `src-tauri/src/repositories/**`, `src-tauri/src/userdata/**`, `src-tauri/src/models.rs`, `src-tauri/src/commands/catalog_search.rs`, `src-tauri/src/commands/catalog_detail.rs`, `src-tauri/src/commands/history.rs`, `src-tauri/src/commands/settings.rs`, `src-tauri/src/github/search.rs`, `src-tauri/src/github/asset_fetch.rs`, `src-tauri/src/icons/**` |
| **Track 4** | `fix-fe-services` | Private detail cache, iconStore cycling, trends board param, Demo parity, sanitizer & lockdown | F-02 (FE), F-19, F-20, F-23, F-24, F-25 (utils), Test Gaps #5, #6 (FE), #7 | 06, 09, 10 | `src/services/**`, `src/demo/**`, `src/types/**`, `src/utils/sanitize.ts`, `src/utils/sanitize.test.ts`, `src/utils/browserLockdown.ts`, `src/utils/browserLockdown.test.ts` |
| **Track 5A** | `fix-fe-app-views` | App hooks, views, updates lock/confirm, search/trends filters, state races, view a11y/tokens | F-26, F-27, F-28, F-29, F-30, F-31 (views), F-33, F-34, F-36 (views), F-37 (views), F-38 (views), F-39 (views) | 11, 12 | `src/App.tsx`, `src/main.tsx`, `src/App.*.test.tsx`, `src/app/**`, `src/views/**` |
| **Track 5B** | `fix-fe-components` | AppDetailModal switching & README anchor escape, modal stacking, component a11y/tokens/counts | F-25 (readme), F-31 (components), F-32, F-35, F-36 (components), F-37 (components), F-38 (oauth), F-39 (rules) | 10, 11, 12 | `src/components/**`, `src/styles/components-modal.css` |

---

## 2. Disjointness & Cross-Track Coordination Rules

1. **Strict Ownership Boundary**: No track may modify files outside its exclusive ownership list above. In particular:
   - Track 1 owns `oauth/star.rs` & `oauth/tests.rs`; Track 3 owns `oauth/mod.rs` (and may add a separate `oauth/revoke_tests.rs` module if needed).
   - Track 1 owns `github/{mod,developer_profile,detail_fetch,detail_assets,readme_fetch}.rs`; Track 3 owns `github/{search,asset_fetch}.rs`.
   - Track 5A owns `src/App.tsx`, `src/main.tsx`, `src/app/**`, `src/views/**`; Track 5B owns `src/components/**` and `src/styles/components-modal.css`.
   - Documentation & ticket files under `.scratch/code-review-2026-11-25/**` are owned solely by `spec-writer` / coordinator.
2. **Pre-Agreed Wire Contracts** (detailed in [spec.md](spec.md#2-exact-cross-track-wire-contracts)):
   - **Contract A**: `AppDetail.is_private: bool` (Track 3 Rust `models.rs` + `db/schema.rs` + `repositories/detail_repo.rs`) ↔ `AppDetail.is_private?: boolean` + `upsertRepoCardFromDetail` (Track 4 `src/types/index.ts` + `src/services/repoEnrichCache.ts`).
   - **Contract B**: `ImportUserDataResult.settings_applied: number` (Track 4 `src/types/index.ts` + `src/demo/handlers/settings.ts`, matching Rust `usize`).
   - **Contract C**: `enrich_trend_repos` passes camelCase `{ repos, board, forceRefresh }` (Track 4 `src/services/api/catalog.ts` + `src/services/trends/{board,enrich}.ts`).
   - **Struct Literal Coordination Check**: If adding `is_private: bool` to `AppDetail` in Track 3 affects any `AppDetail { ... }` literal in Track 1 (`detail_fetch.rs`), Track 3 coordinates via the board (`@fix-rust-security` / `@coordinator`) so merge compiles cleanly on first try.

---

## 3. Per-Track Verification Gates

### Rust Tracks (Tracks 1, 2, 3)
1. Run `cargo test` in `src-tauri` — **0 failures**, including new unit/regression tests for every finding and assigned test gap.
2. Run `cargo clippy --all-targets` in `src-tauri` — **0 warnings**.
3. Run `git status` and `git diff --stat` — verify ONLY owned files were touched.
4. Commit cleanly on the track branch:
   - Track 1: `fix(rust-core): harden security, checksums, star lists, proxy, and 401 handling`
   - Track 2: `fix(installer,scanner): atomic upgrades, safe uninstall, asset selector, and scanner matching`
   - Track 3: `fix(storage,oauth,icons): complete OAuth private cache purge, import validation, and singleflight/lock safety`

### Frontend Tracks (Tracks 4, 5A, 5B)
1. Run `pnpm exec tsc --noEmit` — **0 TypeScript errors**.
2. Run `pnpm exec vitest run` — **0 failures** across the full suite (including `countDisplay.test.ts`, `ipcArgsNaming.test.ts`, `noDirectInvoke.test.ts`, `cmdAlignment.test.ts`, and all new regression tests).
3. Run `git status` and `git diff --stat` — verify ONLY owned files were touched.
4. Commit cleanly on the track branch:
   - Track 4: `fix(fe-services): harden sanitizer, fix iconStore cycling, DemoStore parity, and private cache purge`
   - Track 5A: `fix(fe-views): fix uncataloged favorites, update lock/guard, search/trends filters, and state races`
   - Track 5B: `fix(fe-components): fix modal stacking, AppDetailModal switching, a11y, CSS tokens, and counts`

---

## 4. Merge & Final Integration Results (`main`, `ad2911d..555a09e`)

All 6 track branches were cherry-picked cleanly onto `main` with **0 conflicts** (disjoint auto-merges in `src-tauri/src/github/detail_fetch.rs` and `src-tauri/src/oauth/tests.rs` verified, preserving coordinator-approved Track 3 `AppDetail.is_private` / `oauth/tests.rs:355` updates alongside Track 1), followed by one cross-track integration commit (`555a09e`) closing the 2 cross-track gaps found by `verifier`:

| Landed SHA (`main`) | Source Track & Worktree SHA | Files / Diff | Status |
|---|---|---|---|
| `1caf5dc` | Track 4 (`fix-fe-services`, `114e567`) | 21 files (+621/−133) | Landed |
| `8004696` | Track 5B (`fix-fe-components`, `13ec167`) | 27 files (+1114/−126) | Landed |
| `0dd2671` | Track 5A (`fix-fe-app-views`, `711d98f`) | 41 files (+1261/−245) | Landed |
| `65ce95d` | Track 1 (`fix-rust-security`, `00cffa6`) | 13 files (+1916/−226) | Landed |
| `61556c2` | Track 2 (`fix-rust-installer`, `392b49d`) | 13 files (+2563/−390) | Landed |
| `b48b4da` | Track 3 (`fix-rust-storage`, `6183505`) | 32 files (+1437/−203) | Landed |
| `555a09e` | Integration (`integrator`, direct on `main`) | 11 files (+210/−33) | Landed |

### Integrated Verification Gates (Post-Merge on `main`, `verifier` `verdict=PASS`)
- [x] `pnpm exec tsc --noEmit` — **PASS** (0 errors)
- [x] `pnpm exec vitest run` — **PASS** (**142/142 files, 1497/1497 tests**)
- [x] `cargo test` (`src-tauri`) — **PASS** (**875 passed, 0 failed, 3 ignored**)
- [x] `cargo clippy --all-targets` (`src-tauri`) — **PASS** (**0 warnings**)
- [x] Independent final audit (`verifier`) over `ad2911d..555a09e`: **PASS** (39/39 findings + 7/7 test gaps).
- [x] All 12 tickets (`issues/01..12-*.md`) and [report.md](report.md) updated to `resolved` with landed SHAs.

