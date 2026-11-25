# ZStore Full-Codebase Swarm Audit Report (2026-11-25)

## 1. Executive Summary

- **Audit Date**: 2026-11-25
- **Scope**: Full repository (`src-tauri/src/**`, `src/**`, test suites, and 3-way IPC/Demo contract parity across 106 registered commands).
- **Methodology**: Three read-only parallel deep-audit slices (`audit-rust-core`, `audit-storage-ipc`, `audit-frontend`) plus an independent baseline & test-suite verification pass (`verifier`). Every reported finding was cross-checked directly against source code and deduplicated before remediation dispatch.
- **Standards & Contracts**: `AGENTS.md` (IPC camelCase/snake_case convention, `<CountBadge>` rules), `CONTEXT.md` (Domain Glossary & Invariants D1–D10), `docs/adr/*` (notably ADR-0004, ADR-0006, ADR-0007, ADR-0010, ADR-0012, ADR-0015, ADR-0020, ADR-0025, ADR-0026, ADR-0027, ADR-0028, ADR-0029), and `docs/count-display.md`.
- **Headline Result**: **39 confirmed findings** (**0 Blocker**, **19 High**, **20 Medium**) + **7 high-value test gaps**, partitioned into **12 implementation tickets** across **6 non-overlapping parallel fix tracks**.

---

## 2. Baseline Health (Pre-Fix Snapshot)

| Check | Command | Result | Notes |
|---|---|---|---|
| TypeScript check | `pnpm exec tsc --noEmit` | **PASS** | 0 errors |
| Frontend tests | `pnpm exec vitest run` | **PASS** | 138/138 files, 1446/1446 tests in 23.04s clean run *(under heavy parallel CPU load during `cargo test`, `src/services/trends/swr-view.test.tsx:250` hit 5000ms timeout; passes in 1.23s isolated)* |
| Rust unit/integration tests | `cargo test` (`src-tauri`) | **PASS** | 820 passed, 0 failed, 3 ignored *(host-specific scanner exploratory tests)* |
| Rust lint | `cargo clippy --all-targets` (`src-tauri`) | **PASS** | 0 warnings |
| Non-test `unwrap`/`expect` scan | Rust core production modules | **PASS** | 0 untrusted-input panics found |
| i18n key parity | `zh-CN` / `en-US` locales | **PASS** | 0 missing keys |
| 3-way IPC registration | `lib.rs` vs `services/api/*` vs `demo/handlers/*` | **106 / 106** | 0 missing required request params; 1 dropped optional param (`enrich_trend_repos.board` → F-20), 1 wire-type mismatch (`settings_applied` → F-23), 3 DemoStore behavioral drifts (F-23) |

---

## 3. Deduplication & Calibration Summary

- **Raw auditor claims**: 43 (`audit-rust-core`: 17, `audit-storage-ipc`: 9, `audit-frontend`: 17)
- **Outright false positives**: 0 (every claim verified against source)
- **Cross-boundary duplicate merges (3 pairs → 3 unified High findings)**:
  1. `RC-1` + `SI-9` → **F-01** (unvalidated `developer` path traversal with OAuth Bearer token)
  2. `SI-1` + `RC-10` → **F-02** (incomplete OAuth revoke + private repo resurrection + PAT-fallback retention)
  3. `SI-3` + `RC-12` → **F-03** (portable tarball uninstall failure + custom `portable_dir` orphan + desktop `.lnk` naming mismatch/traversal)
- **Logical split for parallel ownership**:
  - `SI-7` → **F-22A** (`commands/scanner.rs` in Track 2) & **F-22B** (`commands/catalog_detail.rs` in Track 3), counted as one Medium finding (**F-22**) in the 39-finding total.
- **Calibration notes**:
  - **F-14** (`mirror::url_host` missing `\`): `validate_custom_proxy` (`mirror.rs:64`) already rejects `\` for user mirror settings, narrowing backslash impact to `is_github_domain` on external forge release URLs; retained as Medium alongside `test_proxy_latency(Some("ghproxy"))`.
  - **F-23** (`ImportUserDataResult.settings_applied` Rust `usize` vs TS `boolean`): currently masked by a truthy check in `DataBackupRow.tsx:193`; retained as Medium alongside real DemoStore state/level bugs.
  - **F-24** (`sanitizeHtml` `java&#x09;script:`): normal clicks on `a[target="_blank"]` are currently intercepted by `browserLockdown.ts`, but inline `style` clickjacking/IP-leak + `asset:`/`tauri:` execute immediately and `java\tscript:` becomes directly exploitable as soon as **F-25** removes `target="_blank"` on non-external links; retained as **High**.

---

## 4. Severity & Track Breakdown

| Track | Agent | High | Medium | Findings | Test Gaps | Tickets |
|---|---|---:|---:|---|---|---|
| Track 1 | `fix-rust-security` | 4 | 4 | F-01, F-05, F-07, F-08, F-11, F-14, F-17, F-21 | #2 | 01, 02, 03 |
| Track 2 | `fix-rust-installer` | 4 | 3 *(incl. F-22A)* | F-03, F-04, F-06, F-09, F-13, F-16, F-22A | #1, #3, #4 | 04, 05 |
| Track 3 | `fix-rust-storage` | 3 | 3 *(incl. F-22B)* | F-02 (BE), F-10, F-12, F-15, F-18, F-22B | #6 (BE) | 06, 07, 08 |
| Track 4 | `fix-fe-services` | 3 *(+F-02 FE)* | 2 | F-02 (FE), F-19, F-20, F-23, F-24, F-25 (utils) | #5, #6 (FE), #7 | 06, 09, 10 |
| Track 5A | `fix-fe-app-views` | 5 | 7 *(partial splits)* | F-26, F-27, F-28, F-29, F-30, F-31 (views), F-33, F-34, F-36 (views), F-37 (views), F-38 (views), F-39 (views) | #6 (deep-link) | 11, 12 |
| Track 5B | `fix-fe-components` | 0 *(+F-25 readme)* | 7 *(partial splits)* | F-25 (readme), F-31 (components), F-32, F-35, F-36 (components), F-37 (components), F-38 (oauth), F-39 (rules) | — | 10, 11, 12 |
| **Total (unique)** | **6 tracks** | **19** | **20** | **39 findings (F-01..F-39)** | **7 test gaps** | **12 tickets** |

---

## 5. Complete Confirmed Findings Index (F-01 .. F-39)

| ID | Severity | Area / Summary | Primary Locations | Ticket | Track(s) |
|---|---|---|---|---|---|
| **F-01** | High | Unvalidated `developer` path traversal sends OAuth Bearer token to arbitrary GitHub API paths & poisons `api_etag_cache` | `deeplink.rs:226-231`, `commands/forge.rs:13-35`, `github/mod.rs:69-81`, `github/developer_profile.rs:129-151` | 01 | `fix-rust-security` |
| **F-02** | High | Incomplete OAuth revoke retains PAT-fallback private caches & resurrects private repos via `api_etag_cache`, `app_details`, and frontend `cardPool` | `oauth/mod.rs:396-423`, `commands/catalog_search.rs:95-138`, `repositories/card_hydrator.rs:369-406`, `repositories/detail_service.rs:81-115`, `github/search.rs:248-260`, `src/services/repoEnrichCache.ts:664-680,760-797` | 06 | `fix-rust-storage` + `fix-fe-services` |
| **F-03** | High | Portable uninstall fails on `portable_tarball`, orphans custom `portable_dir` directories, and mismatches/traverses desktop `.lnk` shortcuts | `commands/installer_uninstall.rs:68-93,139-145,176-188`, `installer/executor_portable.rs:210,402`, `installer/paths.rs:168-174` | 04 | `fix-rust-installer` |
| **F-04** | High | `classify_asset` bare `contains("install")` misclassifies `.dmg`/`.deb`/`.rpm`/`.AppImage`/`.zip`/`.sh` as Windows `SetupExe` | `installer/selector.rs:28-35` | 04 | `fix-rust-installer` |
| **F-05** | High | Checksum manifest resolution breaks D3 (unbounded binary download, `break` on first per-asset `.sha256`, hardcoded Windows hints, parser gaps) | `github/detail_fetch.rs:979-1051`, `github/detail_assets.rs:241-255` | 02 | `fix-rust-security` |
| **F-06** | High | Bidirectional substring match in `uninstall_display_name_matches` can invoke unrelated Windows app uninstaller | `installer/paths.rs:292-305,366,384` | 04 | `fix-rust-installer` |
| **F-07** | High | `ForgeType::matches_host` & `RepositoryUrlParser` accept `@` userinfo in host and `.`/`..` in `owner`/`repo` | `forge/coord.rs:35-40,95-103`, `oauth/star.rs:5-11` | 01 | `fix-rust-security` |
| **F-08** | High | `add_repo_to_star_list` silently strips repos from user's other GitHub Star Lists (>100 items or >50 lists) | `oauth/star.rs:182-273,310-355` | 03 | `fix-rust-security` |
| **F-09** | High | Portable upgrade overwrites v1 files in-place and rollback deletes them; macOS DMG removes `.app` before `cp -R` | `installer/executor_portable.rs:44-51,135-160,200-206,387-398`, `installer/executor_macos.rs:221-241` | 05 | `fix-rust-installer` |
| **F-10** | High | `import_user_data` bypasses setting security validation, desyncs `AppState.mirror` & startup registry, and aborts on slash-less IDs | `userdata/mod.rs:10-44,89-153`, `commands/history.rs:215-231`, `commands/settings.rs:155-188` | 07 | `fix-rust-storage` |
| **F-11** | Medium | Windows `socks=host:port` / `ftp=` system proxy entries misclassified as `http://` | `proxy/windows.rs:21-51` | 03 | `fix-rust-security` |
| **F-12** | High | `FlightGuard::drop` removes in-flight singleflight key on waiter cancel, racing `.part` temp writes | `icons/singleflight.rs:65-75`, `github/asset_fetch.rs:488-506` | 08 | `fix-rust-storage` |
| **F-13** | Medium | Unconditional `normals[1..]` strip-first-component corrupts flat / multi-root tarballs | `installer/executor_portable.rs:295-314` | 05 | `fix-rust-installer` |
| **F-14** | Medium | `test_proxy_latency(Some("ghproxy"))` dials literal `"ghproxy"`; `mirror::url_host` misses `\` delimiter | `mirror.rs:9-19,39-43,240-260` | 01 | `fix-rust-security` |
| **F-15** | Medium | `record_stream_hit_with` emits raw probed `(url, level)` instead of merged `(cycle.selected_url, cycle.level)` | `icons/lanes.rs:92-140` | 08 | `fix-rust-storage` |
| **F-16** | Medium | `scanner::executable::build_tokens` splits `owner/repo` on `/` and substring-matches unrelated Windows apps by `owner` | `scanner/executable.rs:126-131,261-268,1500-1508` | 05 | `fix-rust-installer` |
| **F-17** | Medium | `readme_fetch::list_root_paths` fallback omits URL-encoding on `branch` and fetches unbounded `?recursive=1` tree | `github/readme_fetch.rs:210-238` | 03 | `fix-rust-security` |
| **F-18** | Medium | `icons::get_or_fetch_icon` bypasses `ICON_CACHE_FLIGHTS` singleflight and holds `state.db()` across sync disk writes | `icons/mod.rs:865-990` | 08 | `fix-rust-storage` |
| **F-19** | High | Manual icon cycling forward (L1→L2→L3→L4) rejected as `level-stale` by `iconStore`; L5 badge level deleted instead of recorded | `src/services/iconStore.ts:200-212,828-851,1120-1129,1165-1170,1200-1216`, `src/components/AppDetailModal/Header.tsx:105-118,160-180` | 09 | `fix-fe-services` |
| **F-20** | Medium | `enrichTrendRepos` frontend wrapper omits `board` param, disabling cross-board `stale-board` icon gating | `src/services/api/catalog.ts:169-179`, `src/services/trends/board.ts:1105-1125`, `src/services/iconStore.ts:359-374,866-875,938-945` | 09 | `fix-fe-services` |
| **F-21** | Medium | `fetch_trends_text` omits `check_auth_expired` on `api.github.com` HTTP 401 (violates ADR-0026 §2.1) | `commands/network.rs:248-281,311-352` | 03 | `fix-rust-security` |
| **F-22A** | Medium | `import_matched_apps` holds global SQLite `Mutex` across slow FS/registry probing and writes non-atomically | `commands/scanner.rs:53-92` | 05 | `fix-rust-installer` |
| **F-22B** | Medium | `get_similar_apps` holds `state.db()` across sync disk icon reads + base64 encoding | `commands/catalog_detail.rs:184-195` | 08 | `fix-rust-storage` |
| **F-23** | Medium | 3-way IPC & DemoStore drift (`settings_applied` type mismatch, Demo settings dropped on reload, invalid Demo icon cycle levels) | `models.rs:403-407`, `src/types/index.ts:559-563`, `src/demo/handlers/settings.ts:11-42,83-89`, `src/demo/handlers/catalog.ts:277-294` | 09 | `fix-fe-services` |
| **F-24** | High | `sanitizeHtml` scheme bypass via C0/whitespace chars, inline `style` clickjacking/IP-leak, `asset:`/`tauri:` allowlist, & `srcset` bugs | `src/utils/sanitize.ts:13,104,113-185` | 10 | `fix-fe-services` |
| **F-25** | High | Capture-phase `browserLockdown` + forced `target="_blank"` breaks 100% of README `#anchor` links (+ unguarded `decodeURIComponent`/`querySelector`) | `src/utils/sanitize.ts:188-191`, `src/utils/browserLockdown.ts:212-231`, `src/components/AppDetailModal/useDetailReadme.ts:229-248` | 10 | `fix-fe-services` + `fix-fe-components` |
| **F-26** | High | "Load info" on uncataloged Favorite/Watched card discards fetched detail & closes over stale `apps = []` | `src/app/favoritesUncataloged.ts:186,189-234,272-287` | 11 | `fix-fe-app-views` |
| **F-27** | High | My Apps Update & Update All bypass `InstallConfirmDialog` (`UNVERIFIED_ASSET_MARKER`) and global install lock | `src/app/hooks/useUpdatesState.ts:169-179,211-238`, `src/views/InstalledView.tsx:194-195,302-320` | 11 | `fix-fe-app-views` |
| **F-28** | High | `zstore://launchpad/{id}` deep link immediately cancels its own 60ms scroll & 4000ms highlight-clear timers | `src/views/LaunchpadView.tsx:114-128` | 11 | `fix-fe-app-views` |
| **F-29** | High | Search view traps user when platform filter is `[]` or filters out all search results | `src/App.tsx:498-533` | 11 | `fix-fe-app-views` |
| **F-30** | High | Online search downgrades `is_cataloged: true` → `false`; `TrendsView` hides valid uncataloged items when `apps.length === 0` | `src/views/SearchResultsView.tsx:86-90`, `src/views/TrendsView.tsx:169,219-228` | 11 | `fix-fe-app-views` |
| **F-31** | Medium | Case-sensitive `.has(app.id)` lookups break favorite/watch/installing indicators & duplicate-install guard on mixed-case IDs | `src/App.tsx:707-710`, `src/app/hooks/useInstallState.ts:65-95,121`, `src/views/TrendsView.tsx:244` & sibling views/components | 11 | `fix-fe-app-views` + `fix-fe-components` |
| **F-32** | Medium | In-place Similar App switch in `AppDetailModal` leaks async state, errors, icon cycle, and star status across apps | `src/components/AppDetailModal/{index.tsx:85-95,221-290, Header.tsx:160-191, useDetailStarVerify.ts:25-69}` | 12 | `fix-fe-components` |
| **F-33** | Medium | `handleOpenDetail` lacks monotonic request generation guard; out-of-order responses/errors overwrite fresher state | `src/app/hooks/useDetailCacheSync.ts:465-469,561-572` | 11 | `fix-fe-app-views` |
| **F-34** | Medium | Cold-startup race stamps `recentlyViewedApps` as `is_cataloged: false`; deleted drafts stay permanently hidden from "Move to catalog" | `src/app/hooks/useAppSubscriptions.ts:111,128-134,185-192`, `src/app/hooks/useCustomApps.ts:55,60-91,110-113` | 11 | `fix-fe-app-views` |
| **F-35** | Medium | Sibling `layer="base"` modals render visually behind older modals while owning Esc & focus trap | `src/App.tsx:683-745`, `src/components/ModalShell.tsx`, `src/styles/components-modal.css:9,362-372` | 12 | `fix-fe-components` |
| **F-36** | Medium | Keyboard bubbling on `AppCard`/`HeroBanner` nested buttons; `Ctrl+K` escapes open modals & `Esc` leaves search dropdown stuck | `src/components/AppCard.tsx:267-276`, `src/views/FeaturedView.tsx:421-486`, `src/components/TitleBar.tsx:76-89,157` | 12 | `fix-fe-components` + `fix-fe-app-views` |
| **F-37** | Medium | Undefined CSS variables (`--status-error`, `--bg-card-hover`, `--bg-primary`) & hardcoded green proxy-save error | `OAuthAccountCard.tsx`, `ClientUpdateRow.tsx`, `DataBackupRow.tsx`, `CachedAvatar.tsx`, `Sidebar.tsx`, `ErrorBoundary.tsx`, `main.tsx`, `NetworkDataSection.tsx`, `SettingsView.tsx` | 12 | `fix-fe-components` + `fix-fe-app-views` |
| **F-38** | Medium | Uncaught rule/unmanage IPC rejections, blank `FeaturedView` on load failure, and post-unmount `OAuthAccountCard` `openUrl`/timer | `useUpdatesState.ts:149-209`, `useInstallState.ts:210-218`, `FeaturedView.tsx:78,294`, `OAuthAccountCard.tsx:117-146` | 11 | `fix-fe-app-views` + `fix-fe-components` |
| **F-39** | Medium | `RulesManagerModal` tab counts ignore `filterQuery`, `LaunchpadSubmitModal` overwrites user-typed name, `StarredFeed` batch favorite lacks busy guard/silent mode | `RulesManagerModal.tsx:173,396-445`, `LaunchpadSubmitModal.tsx:172-174`, `StarredFeed.tsx:133-135` | 12 | `fix-fe-components` + `fix-fe-app-views` |

---

## 6. High-Value Test Gaps & Misleading Tests (Test Gaps #1 .. #7)

| Gap # | Issue | Location | Ticket | Track(s) |
|---|---|---|---|---|
| **#1** | Broken security regression test: `test_uninstall_unix_path_never_shells_command_string` reads `include_str!("executor.rs")`, but Unix uninstall moved to `executor_uninstall.rs` | `src-tauri/src/installer/tests.rs:373-381` | 04 | `fix-rust-installer` |
| **#2** | Weak OAuth Star-to-Launchpad test: `apply_star_mutation_adjusts_launchpad_only_on_flip` never seeds `launchpad_discussion_cache` or asserts Launchpad star delta | `src-tauri/src/oauth/tests.rs:395-403` | 03 | `fix-rust-security` |
| **#3** | Zero integration tests for `install_app` `allow_unverified` gate, `download_asset_with_fallback`, and `download_with_progress` | `commands/installer_install.rs:49`, `commands/installer_download.rs:29`, `installer/downloader_http.rs:135` | 05 | `fix-rust-installer` |
| **#4** | Missing archive path-traversal (zip-slip, tar `../`, absolute/Windows prefixes, hardlinks) & mid-upgrade v1 rollback tests | `src-tauri/src/installer/executor_portable.rs` | 05 | `fix-rust-installer` |
| **#5** | Missing 3-way IPC/Demo parity test covering `CMD` ↔ `src/demo/tauri-mock.ts` and parameter/return-type alignment | `src/services/api/cmdAlignment.test.ts`, `src/services/api/ipcArgsNaming.test.ts` | 09 | `fix-fe-services` |
| **#6** | Deep-link (`zstore://collection`, unverified `zstore://install/...`) & OAuth 401 → `revoke_oauth_session` → `zstore://oauth-expired` → frontend memory cache purge E2E gaps | `src/App.deepLinkInstallGuard.test.tsx`, `src-tauri/src/oauth/mod.rs`, `src/services/repoEnrichCache.ts` | 06 | `fix-rust-storage` + `fix-fe-services` (+ `fix-fe-app-views`) |
| **#7** | Load-sensitive timeout flake at 5000ms under heavy parallel CPU load | `src/services/trends/swr-view.test.tsx:250` | 09 | `fix-fe-services` |

---

## 7. Ticket Index

| # | File | Findings & Gaps | Track(s) | Commit(s) on `main` | Status |
|---|---|---|---|---|---|
| 01 | [01-rust-security-path-traversal-and-url-validation.md](issues/01-rust-security-path-traversal-and-url-validation.md) | F-01, F-07, F-14 | `fix-rust-security` | `65ce95d` | resolved |
| 02 | [02-rust-checksum-manifest-and-d3-hardening.md](issues/02-rust-checksum-manifest-and-d3-hardening.md) | F-05 | `fix-rust-security` | `65ce95d` | resolved |
| 03 | [03-rust-github-star-lists-proxy-readme-and-401.md](issues/03-rust-github-star-lists-proxy-readme-and-401.md) | F-08, F-11, F-17, F-21, Test Gap #2 | `fix-rust-security` | `65ce95d` | resolved |
| 04 | [04-installer-portable-uninstall-shortcuts-and-selector.md](issues/04-installer-portable-uninstall-shortcuts-and-selector.md) | F-03, F-04, F-06, Test Gap #1 | `fix-rust-installer` | `61556c2` | resolved |
| 05 | [05-installer-atomic-upgrade-tarball-and-scanner.md](issues/05-installer-atomic-upgrade-tarball-and-scanner.md) | F-09, F-13, F-16, F-22A, Test Gaps #3 & #4 | `fix-rust-installer` | `61556c2` | resolved |
| 06 | [06-oauth-revoke-private-repo-isolation.md](issues/06-oauth-revoke-private-repo-isolation.md) | F-02 (BE + FE), Test Gap #6 | `fix-rust-storage`, `fix-fe-services`, `integrator` | `b48b4da`, `1caf5dc`, `555a09e` | resolved |
| 07 | [07-userdata-import-validation-and-state-sync.md](issues/07-userdata-import-validation-and-state-sync.md) | F-10 | `fix-rust-storage` | `b48b4da` | resolved |
| 08 | [08-icons-singleflight-lanes-and-db-lock-hygiene.md](issues/08-icons-singleflight-lanes-and-db-lock-hygiene.md) | F-12, F-15, F-18, F-22B | `fix-rust-storage` | `b48b4da` | resolved |
| 09 | [09-fe-iconstore-trends-demo-parity-and-contract-tests.md](issues/09-fe-iconstore-trends-demo-parity-and-contract-tests.md) | F-19, F-20, F-23, Test Gaps #5 & #7 | `fix-fe-services` | `1caf5dc` | resolved |
| 10 | [10-fe-html-sanitizer-and-readme-anchor-navigation.md](issues/10-fe-html-sanitizer-and-readme-anchor-navigation.md) | F-24, F-25 | `fix-fe-services`, `fix-fe-components` | `1caf5dc`, `8004696` | resolved |
| 11 | [11-fe-app-hooks-updates-search-trends-and-state-races.md](issues/11-fe-app-hooks-updates-search-trends-and-state-races.md) | F-26, F-27, F-28, F-29, F-30, F-31, F-33, F-34, F-38 | `fix-fe-app-views`, `fix-fe-components`, `integrator` | `0dd2671`, `8004696`, `555a09e` | resolved |
| 12 | [12-fe-modals-a11y-css-tokens-and-counts.md](issues/12-fe-modals-a11y-css-tokens-and-counts.md) | F-32, F-35, F-36, F-37, F-39 | `fix-fe-components`, `fix-fe-app-views`, `integrator` | `8004696`, `0dd2671`, `555a09e` | resolved |

---

## 8. Landed Commits & Post-Fix Verification (`ad2911d..555a09e` on `main`)

All 6 parallel fix tracks were cherry-picked cleanly onto `main` with **0 conflicts** (disjoint auto-merges in `src-tauri/src/github/detail_fetch.rs` and `src-tauri/src/oauth/tests.rs` verified), followed by one cross-track integration commit (`555a09e`) closing the 2 cross-track gaps caught during independent verification (`verdict=PASS`):

| Order | Commit on `main` | Track | Files / Diff | Summary |
|---:|---|---|---|---|
| 1 | `1caf5dc` | Track 4 (`fix-fe-services`) | 21 files (+621/−133) | `fix(fe-services): harden sanitizer, fix iconStore cycling, DemoStore parity, and private cache purge` |
| 2 | `8004696` | Track 5B (`fix-fe-components`) | 27 files (+1114/−126) | `fix(fe-components): fix modal stacking, AppDetailModal switching, a11y, CSS tokens, and counts` |
| 3 | `0dd2671` | Track 5A (`fix-fe-app-views`) | 41 files (+1261/−245) | `fix(fe-views): fix uncataloged favorites, update lock/guard, search/trends filters, and state races` |
| 4 | `65ce95d` | Track 1 (`fix-rust-security`) | 13 files (+1916/−226) | `fix(rust-core): harden security, checksums, star lists, proxy, and 401 handling` |
| 5 | `61556c2` | Track 2 (`fix-rust-installer`) | 13 files (+2563/−390) | `fix(installer,scanner): atomic upgrades, safe uninstall, asset selector, and scanner matching` |
| 6 | `b48b4da` | Track 3 (`fix-rust-storage`) | 32 files (+1437/−203) | `fix(storage,oauth,icons): complete OAuth private cache purge, import validation, and singleflight/lock safety` |
| 7 | `555a09e` | Integration (`integrator`) | 11 files (+210/−33) | `fix(integration): propagate rule mutation status and purge private RAM caches on OAuth revoke` |

### Integrated Gate Results (Post-Fix, Verified `PASS`)

| Gate | Command | Baseline | Post-Fix | Status |
|---|---|---|---|---|
| TypeScript | `pnpm exec tsc --noEmit` | 0 errors | 0 errors | **PASS** |
| Frontend tests | `pnpm exec vitest run` | 138 files / 1446 tests | **142 files / 1497 tests** (+4 files, +51 tests) | **PASS** |
| Rust tests | `cargo test` (`src-tauri`) | 820 passed / 3 ignored | **875 passed / 0 failed / 3 ignored** (+55 tests) | **PASS** |
| Rust clippy | `cargo clippy --all-targets` (`src-tauri`) | 0 warnings | **0 warnings** | **PASS** |
| Final Audit | Independent `verifier` review of `ad2911d..555a09e` | — | 39/39 findings + 7/7 test gaps verified | **PASS** |

