# Consolidated Remediation Specification (2026-11-25 Audit)

This specification consolidates all **39 confirmed findings (`F-01`..`F-39`)** and **7 high-value test gaps (`Test Gaps #1`..`#7`)** from [report.md](report.md) into concrete architectural invariants, cross-track wire contracts, and testable acceptance criteria.

---

## 1. Architectural Invariants Reinforced

| Invariant / ADR | Findings Enforcing It |
|---|---|
| **D2 (Serverless Direct API, Cache Isolation & Command Boundaries)** / **ADR-0006**, **ADR-0010**, **ADR-0026**, **ADR-0027** | F-01, F-02, F-07, F-10, F-21, F-22A, F-22B, F-23, F-30, F-34 |
| **D3 (Zero-Trust Integrity Verification)** / **ADR-0004** | F-05, F-27, Test Gap #3 |
| **D4 (Linear Monochrome Design System & Semantic Tokens)** / **ADR-0008**, `docs/count-display.md` | F-35, F-36, F-37, F-39 |
| **D5 / D7 / D8 (Isolated Pools, System Proxy & Bounded Network Reads)** / **ADR-0012**, **ADR-0025** | F-05, F-11, F-14, F-17 |
| **D6 / D10 (Bounded Concurrency, Singleflight & Icon/Card Pipeline Precedence)** / **ADR-0015**, **ADR-0025**, **ADR-0027** | F-12, F-15, F-18, F-19, F-20 |
| **Installer, Portable & Scanner Safety** / **ADR-0022**, **ADR-0028** | F-03, F-04, F-06, F-09, F-13, F-16, Test Gaps #1, #4 |
| **WebView Defense-in-Depth & Navigation UX** | F-24, F-25, F-26, F-28, F-29, F-31, F-32, F-33, F-38 |

---

## 2. Exact Cross-Track Wire Contracts

Two cross-boundary contracts span parallel fix tracks and MUST match verbatim across Rust, TypeScript types, services, and Demo handlers:

### Contract A: `AppDetail.is_private` (Track 3 `fix-rust-storage` ↔ Track 4 `fix-fe-services`)
- **Rust (`src-tauri/src/models.rs`)**: Add `#[serde(default)] pub is_private: bool` to `AppDetail`.
- **SQLite (`src-tauri/src/db/schema.rs` + `repositories/detail_repo.rs`)**: Persist `is_private` on `app_details` via safe additive schema migration (`ALTER TABLE app_details ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0` guarded for idempotency / `user_version`), populated whenever a detail is fetched from a private repository.
- **Wire JSON (response struct, snake_case per `AGENTS.md`)**: `"is_private": true | false`.
- **Frontend (`src/types/index.ts`)**: Add `is_private?: boolean;` to `AppDetail`.
- **Consumer (`src/services/repoEnrichCache.ts`)**: In `upsertRepoCardFromDetail`, when `detail.is_private === true`, call `recordSharedPrivateRepos([detail.id])` so `clearPrivateSharedRepoCards()` purges detail-loaded private repos on OAuth logout or `zstore://oauth-expired`.

### Contract B: `ImportUserDataResult.settings_applied` (Rust SSOT ↔ Track 4 `fix-fe-services`)
- **Rust (`src-tauri/src/models.rs`)**: Remains `pub settings_applied: usize` (JSON `number`).
- **Frontend (`src/types/index.ts`)**: Change `ImportUserDataCounts.settings_applied` from `boolean` to `number`.
- **Demo (`src/demo/handlers/settings.ts`)**: Return numeric count (e.g., `0` or count of applied settings) for `settings_applied` instead of `false`.

### Contract C: `enrich_trend_repos` `board` Argument (Rust SSOT ↔ Track 4 `fix-fe-services`)
- **Rust (`src-tauri/src/commands/catalog_search.rs`)**: Already accepts `board: Option<String>` via `#[tauri::command(rename_all = "camelCase")]`.
- **Frontend (`src/services/api/catalog.ts`, `src/services/trends/board.ts`, `src/services/trends/enrich.ts`)**: Pass camelCase `{ repos, board, forceRefresh }` so `zstore://icon-ready` events carry the originating board and `iconStore` enforces `stale-board` gating.

---

## 3. Domain Remediation Requirements & Acceptance Criteria

### 3.1 Rust Core Security, URL/Coordinate Validation, Proxy & Network (Tickets 01–03)

1. **Developer Handle & Forge Coordinate Hardening (F-01, F-07, F-14)**
   - `developer` handles MUST be validated strictly (ASCII `[A-Za-z0-9-]`, length `1..=39`, rejecting `/`, `\`, `.`, `..`, `?`, `#`, `%`, `@`, and whitespace) at all entry points: `DeepLinkParser::parse`, `commands/forge.rs::get_developer_profile`, and `github/developer_profile.rs` / `github/mod.rs`.
   - `ForgeType::matches_host` and `valid_host_segment` (`forge/coord.rs`) MUST reject `@` userinfo and invalid hostname characters; `valid_repo_segment` MUST reject `.`, `..`, and control characters so `canonical_app_id("../..") == None` and `starred_api_url` cannot traverse GitHub API paths.
   - `mirror::test_proxy_latency(Some("ghproxy"))` MUST resolve `"ghproxy"` to `DEFAULT_GH_PROXY` instead of dialing literal `"ghproxy"`.
   - `mirror::url_host` MUST treat `\` as an authority delimiter (or parse via `reqwest::Url::parse`) so `https://evil.com\@github.com/...` cannot pass `is_github_domain`.

2. **D3 Checksum Manifest Resolution (F-05)**
   - Candidate filtering in `github/detail_fetch.rs` & `github/detail_assets.rs` MUST exclude binary/archive extensions (`.exe`, `.msi`, `.dmg`, `.deb`, `.rpm`, `.AppImage`, `.zip`, `.tar.*`, `.7z`, `.apk`, etc.) and cap manifest body reads (1 MiB streaming/bounded limit).
   - Platform eligibility MUST follow runtime `cfg!(target_os)` / `cfg!(target_arch)` instead of hardcoded Windows hints.
   - Resolution MUST support both aggregate manifests (`checksums.txt`, `SHA256SUMS`) and per-asset `<asset>.sha256` files without breaking on the first asset.
   - Parser MUST handle 1-token `.sha256` files (inferring asset name from the `.sha256` filename), strip leading `./` or directory prefixes, preserve filenames containing spaces, and validate exactly 64 ASCII hex digits.

3. **GitHub Star Lists, Windows Proxy, README Tree & Trends 401 (F-08, F-11, F-17, F-21, Test Gap #2)**
   - `oauth/star.rs::add_repo_to_star_list` MUST preserve existing Star List memberships across >50 lists and >100 items via full pagination or repo-scoped membership query; if pagination is incomplete, abort list overwrite safely with a warning/error instead of silently stripping memberships.
   - `proxy/windows.rs` MUST map `socks=`/`socks5=` to `socks5h://{addr}` and ignore `ftp=`.
   - `github/readme_fetch.rs::list_root_paths` fallback MUST percent-encode `owner`/`repo`/`branch`, drop `?recursive=1`, and enforce a bounded response byte cap.
   - `commands/network.rs::fetch_trends_text` MUST call `crate::check_auth_expired(401, "github.com")` whenever `is_api && auth.is_some() && status == 401` (ADR-0026 §2.1).
   - `oauth/tests.rs::apply_star_mutation_adjusts_launchpad_only_on_flip` (Test Gap #2) MUST seed `launchpad_discussion_cache` and assert the actual Launchpad star delta.

### 3.2 Rust Installer, Portable Upgrades, Uninstall & Scanner (Tickets 04–05)

4. **Portable Uninstall, Shortcuts, Asset Classifier & Registry Uninstaller Matching (F-03, F-04, F-06, Test Gap #1)**
   - `uninstall_app` MUST handle both `"portable_zip"` and `"portable_tarball"`, resolve custom `portable_dir` (plus default fallback) with path-containment validation before `remove_dir_all`, and remove desktop shortcuts matching both `sanitize_shortcut_name(app_name)` and `sanitize_shortcut_name(app_id)`.
   - `installer/paths.rs::find_desktop_shortcut` MUST sanitize inputs and verify canonical parent containment inside the Desktop directory (eliminating `..` traversal and locating sanitized portable `.lnk` files).
   - `installer/selector.rs::classify_asset` MUST require `name_lower.ends_with(".exe")` for `AssetKind::SetupExe`.
   - `installer/paths.rs::uninstall_display_name_matches` and `resolve_uninstaller_command_in` MUST prioritize `install_path` matching against `InstallLocation`/`DisplayIcon`/`UninstallString` parent directory, and restrict display-name fallback to exact match or word-boundary match with safe minimum length (no bidirectional raw `.contains()`).
   - `installer/tests.rs::test_uninstall_unix_path_never_shells_command_string` (Test Gap #1) MUST inspect `executor_uninstall.rs` instead of `executor.rs`.

5. **Atomic Portable/macOS Upgrades, Tarball Stripping, Scanner Matching & Lock Hygiene (F-09, F-13, F-16, F-22A, Test Gaps #3 & #4)**
   - Portable `.zip`/`.tar.*` upgrades (`executor_portable.rs`) and macOS `.app` upgrades (`executor_macos.rs`) MUST extract/copy into a sibling staging directory and swap atomically (`target` → `.bak`, `staging` → `target`, delete `.bak`, or restore `.bak` on swap failure) so failed upgrades never corrupt or delete a working v1 install.
   - Tarball extraction (`executor_portable.rs`) MUST only strip the leading directory component when all non-empty entries share a single common top-level directory.
   - `scanner/executable.rs::build_tokens` MUST exclude the `owner/` prefix from `app_id` tokenization and enforce word-boundary matching in `registry_scan` / `resolve_app_installed_at`.
   - `commands/scanner.rs::import_matched_apps` MUST pre-validate IDs and run `resolve_app_installed_at` before locking `state.db()`, then commit all DB writes in one `with_immediate_transaction`.
   - Add regression tests for archive path traversal (zip-slip, tar `../`, absolute/Windows prefixes, hardlinks), mid-upgrade v1 rollback (Test Gap #4), and `allow_unverified` gate / download fallback behavior (Test Gap #3).

### 3.3 Rust Storage, OAuth Revoke, Userdata & Icons Singleflight (Tickets 06–08)

6. **Complete OAuth Revoke & Private Repo Isolation (F-02, Test Gap #6)**
   - On `ManualLogout`, `oauth::revoke_oauth_session` MUST unconditionally purge `@me:` starred cache, private `repo_card_cache`, private `search_list_cache`, `user_repo_signals`, and `user_stars` regardless of whether a `github.com` host PAT fallback exists.
   - On both `ManualLogout` and `AuthExpired401`, collect all private repo IDs from `repo_card_cache` AND `app_details`, delete their `app_details` rows, delete their `https://api.github.com/repos/{owner}/{repo}*` ETag rows, and delete `https://api.github.com/search/repositories` ETag rows from `api_etag_cache`.
   - Implement Contract A (`AppDetail.is_private`) across Rust and `src/services/repoEnrichCache.ts`.
   - Add tests verifying OAuth revoke purges private caches end-to-end across Rust and frontend `clearPrivateSharedRepoCards` (Test Gap #6).

7. **Backup Import Validation & Runtime State Sync (F-10)**
   - `userdata::import_backup` MUST validate every allowlisted setting through `validate_setting_value` before persisting.
   - Updating `active_mirror` in either `commands/settings.rs::save_setting` or `commands/history.rs::import_user_data` MUST synchronize in-memory `state.mirror`; importing `launch_on_startup` MUST invoke `sync_launch_on_startup`.
   - `parse_import_payload` MUST validate/normalize app IDs via `canonical_app_id`, gracefully skipping invalid or slash-less IDs instead of aborting the transaction.

8. **Singleflight Correctness, Icon Lane Precedence & DB Lock Hygiene (F-12, F-15, F-18, F-22B)**
   - `icons/singleflight.rs::FlightGuard::drop` MUST only remove the in-flight key when no other holders remain (e.g., `Arc::strong_count(existing) == 2` under the map mutex); `github/asset_fetch.rs::persist_asset_bytes` MUST write to a unique `{stem}.{nonce}.part` temp file before atomic rename.
   - `icons/lanes.rs::record_stream_hit_with` MUST capture `(cycle.selected_url, cycle.level)` under the DB lock and emit the merged result (or skip emitting when `was_pinned` or `selected_url` is unchanged).
   - `icons/mod.rs::get_or_fetch_icon` MUST route uncached fetches through `ICON_CACHE_FLIGHTS` and perform disk writes outside `state.db()`.
   - `commands/catalog_detail.rs::get_similar_apps` MUST release `state.db()` before disk icon reads and base64 encoding.

### 3.4 Frontend Services, Sanitizer, Lockdown & Demo Parity (Tickets 09–10)

9. **IconStore Cycling, Trends Board Gating & Demo/IPC Parity (F-19, F-20, F-23, Test Gaps #5 & #7)**
   - `iconStore.admitIconHit` MUST support a `force?: boolean` option (used by `admitIconCycleResult`) so manual forward cycling (L1→L2→L3→L4) is accepted; `applyBadgeHit` MUST delete `iconById` while calling `rememberIconLevel(t, 5)` so the L5 guard prevents passive overwrites.
   - Thread active `board` through `trends/board.ts` → `trends/enrich.ts` → `api/catalog.ts::enrichTrendRepos` (Contract C).
   - Apply Contract B (`settings_applied: number`), merge all `demoStore().settings` in `handleGetSettings`, persist `mirrorId` in `handleSwitchMirror`, and start Demo icon cycling at `level: 1` wrapping within `1..=total_levels`.
   - Strengthen `src/services/api/cmdAlignment.test.ts` (or companion test) to enforce `CMD` ↔ `src/demo/tauri-mock.ts` parity (Test Gap #5), and eliminate load-sensitive timeout flake in `src/services/trends/swr-view.test.tsx:250` (Test Gap #7).

10. **HTML Sanitizer Hardening & README `#anchor` Navigation (F-24, F-25)**
    - `src/utils/sanitize.ts` MUST strip ASCII C0 controls and whitespace (`[\u0000-\u0020]`) before protocol inspection, enforce a strict scheme allowlist (`http:`, `https:`, `mailto:`, `#`, plus `data:image/*` restricted to `img[src]`/`srcset` only), remove `asset:`/`tauri:`, sanitize `srcset` per candidate without splitting `data:...;base64,...`, and remove unsafe inline `style` attributes (preventing `position`, `z-index`, `url()`, `expression()`).
    - `sanitize.ts` MUST NOT add `target="_blank"` to `#` fragment links; `src/utils/browserLockdown.ts` MUST ignore `#` fragment hrefs in capture-phase click handling.
    - `src/components/AppDetailModal/useDetailReadme.ts` MUST wrap `decodeURIComponent` in `try/catch` and escape `anchorId` via `CSS.escape` (with safe fallback) before `querySelector`.

### 3.5 Frontend App Hooks, Views, Modals, A11y & Tokens (Tickets 11–12)

11. **Core View & Hook Correctness (F-26, F-27, F-28, F-29, F-30, F-31, F-33, F-34, F-38)**
    - `favoritesUncataloged.ts`: replace matching placeholder entry (`prev.map(...)`) instead of returning `prev` unchanged; read `apps` via ref inside `loadUncatalogedDetail` (F-26).
    - `useUpdatesState.ts` & `InstalledView.tsx`: route single and batch updates through `useInstallState`'s `UNVERIFIED_ASSET_MARKER` confirmation flow and `installingRef` lock; lift batch-updating state out of `InstalledView` (F-27).
    - `LaunchpadView`: isolate scroll (60ms) and highlight-clear (4000ms) timers in a separate `useEffect` keyed on `highlightId` (F-28).
    - `App.tsx` Search view: render `FilterEmptyState` with platform reset when `selectedPlatforms.size === 0` or raw search results were non-empty before platform filtering (F-29).
    - `SearchResultsView.tsx`: annotate online results against full catalog IDs and never downgrade `is_cataloged: true` → `false`; `TrendsView.tsx`: gate empty state solely on `displayItems.length === 0` (F-30).
    - Normalize IDs via `normalizeId(id)` across all `.has()`/`.add()`/`.delete()` operations on `favoriteIds`, `watchedIds`, `installingIds`, `uninstallingAppIds` in hooks, views, and components (F-31).
    - `useDetailCacheSync.ts`: add monotonic `detailReqSeqRef` guard in `handleOpenDetail` (F-33).
    - `useAppSubscriptions.ts` & `useCustomApps.ts`: restamp `recentlyViewedApps` via `localAppsRef.current` after initial catalog load; prune/clear `movedInIds` once `reloadCustomApps` resolves (F-34).
    - `useUpdatesState.ts`, `useInstallState.ts`, `FeaturedView.tsx`, `OAuthAccountCard.tsx`: catch rule/unmanage IPC rejections with error toast; render error `EmptyState` + Retry on `featured.failed`; check `pollCancelledRef.current` after `await oauthDeviceStart()` (F-38).

12. **Modals, A11y, CSS Tokens & Count Display (F-32, F-35, F-36, F-37, F-39)**
    - `AppDetailModal`: guard async install/download/icon-cycle/star-verify/readme completions against `currentAppIdRef`, reset `isInstalling`/`showAllAssets` on `app.id` change, include `oauthLogin` in `useDetailStarVerify` deps (F-32).
    - `ModalShell.tsx` / `components-modal.css`: compute dynamic `z-index` from `openModalStack` position so newer `layer="base"` modals always stack visually above older siblings (F-35).
    - `AppCard.tsx`, `FeaturedView.tsx` HeroBanner, `TitleBar.tsx`: check `e.target === e.currentTarget` and `e.preventDefault()` on Space for outer card/banner key handlers; ignore `Ctrl+K`/`Cmd+K` when `[aria-modal="true"]` exists; close search dropdown on `Escape` (F-36).
    - Replace all undefined CSS tokens (`--status-error` → `--status-danger`, `--bg-card-hover` → `--bg-acrylic-hover`, `--bg-primary` → `--bg-canvas`, `--border-primary` → `--border-color`) across components/views/`main.tsx`; track `proxyFeedback` as `{ text: string; isError: boolean } | null` with a clearable timer (F-37).
    - `RulesManagerModal.tsx`: compute tab `<CountBadge>` values from `filterQuery`-filtered items per `docs/count-display.md` (F-39); `LaunchpadSubmitModal.tsx`: use functional `setAppName(prev => prev.trim() ? prev : res.repo_name)` (F-39); `StarredFeed.tsx`: guard batch favorite with busy flag + `{ silent: true }` + single summary toast (F-39).

---

## 4. Global Verification Gates

All remediation branches merged together MUST pass:
1. `cargo test` in `src-tauri` (0 failures)
2. `cargo clippy --all-targets` in `src-tauri` (0 warnings)
3. `pnpm exec tsc --noEmit` (0 errors)
4. `pnpm exec vitest run` (all suites green, including `countDisplay.test.ts`, `ipcArgsNaming.test.ts`, `noDirectInvoke.test.ts`, `cmdAlignment.test.ts`, and all newly added regression tests)
5. `pnpm run build` (clean production bundle)
