# Issue 12: Frontend Modals, A11y, CSS Tokens & Count Display

Status: resolved
Severity: Medium (F-32 [Medium], F-35 [Medium], F-36 [Medium], F-37 [Medium], F-39 [Medium])
Fix Track: Track 5B (`fix-fe-components`) + Track 5A (`fix-fe-app-views` for F-36 `FeaturedView`, F-37 `SettingsView`/`NetworkDataSection`/`main.tsx`, F-39 `LaunchpadSubmitModal`/`StarredFeed`)
Findings: F-32, F-35, F-36, F-37, F-39

## Findings

### F-32 [Medium]: In-place Similar App switch in `AppDetailModal` leaks async state, errors, icon cycle, and star status across apps
- **Locations**:
  - `src/components/AppDetailModal/index.tsx:85-95, 221-290`
  - `src/components/AppDetailModal/Header.tsx:160-191, 214-234`
  - `src/components/AppDetailModal/useDetailStarVerify.ts:25-69`
- **Trigger**: Inside `AppDetailModal` for App A, start download, install, icon cycle, refresh, or star/unstar, then click a Similar App (App B) before the request settles. `AppDetailModal` stays mounted with a new `app.id`: `isInstalling` and `showAllAssets` are not reset on `app.id` change, async completions lack `currentAppIdRef.current === reqAppId` guards, and `useDetailStarVerify` omits `oauthLogin` from its `useEffect` deps.
- **Impact**: App A's `downloadedFile`, `installError`, `isInstalling` spinner, `iconCycle`, `refreshSuccessNotice`, or `isStarred` state silently corrupts App B.

### F-35 [Medium]: Sibling `layer="base"` modals render visually behind older modals while owning Esc & focus trap
- **Locations**:
  - `src/App.tsx:683-745`
  - `src/components/ModalShell.tsx`
  - `src/styles/components-modal.css:9, 362-372`
- **Trigger**: Open `AppDetailModal` (DOM line 700), then open `CollectionPreviewModal` via `zstore://collection` (DOM line 683) — or open `DeveloperProfileModal` (DOM line 733) from `AppDetailModal` and click an app inside it. All three share `layer="base"` (`z-index: 100`), so DOM order determines paint order while `openModalStack` gives Esc and Tab focus trap to the newly opened buried modal.
- **Impact**: Newly opened modal renders visually behind the older modal while trapping keyboard focus and swallowing `Escape`, making the visible modal appear frozen.

### F-36 [Medium]: Keyboard bubbling on `AppCard`/`HeroBanner` nested buttons; `Ctrl+K` escapes open modals & `Esc` leaves search dropdown stuck
- **Locations**:
  - `src/components/AppCard.tsx:267-276, 299-330, 473-487` (Track 5B)
  - `src/components/TitleBar.tsx:76-89, 157` (Track 5B)
  - `src/views/FeaturedView.tsx:421-486` (Track 5A)
- **Trigger**: (A) Pressing `Enter`/`Space` on focused Watch/Favorite/Install buttons inside `AppCard` or `HeroBanner` bubbles to the outer `<div role="button" onKeyDown>` because `e.target === e.currentTarget` is not checked, firing both the nested button action and `onOpenDetail`; `AppCard` also omits `e.preventDefault()` on Space. (B) `Ctrl+K` in `TitleBar` ignores active `[aria-modal="true"]`, escaping the modal focus trap; `Escape` in `TitleBar` blurs the search input without closing `isDropdownOpen`.
- **Impact**: Keyboard users inadvertently open detail modals when activating card buttons, escape modal focus traps on `Ctrl+K`, and get a stuck search dropdown on `Escape`.

### F-37 [Medium]: Undefined CSS variables (`--status-error`, `--bg-card-hover`, `--bg-primary`) & hardcoded green proxy-save error
- **Locations**:
  - Track 5B: `src/components/OAuthAccountCard.tsx:219, 322`, `src/components/ClientUpdateRow.tsx:224`, `src/components/DataBackupRow.tsx:274`, `src/components/CachedAvatar.tsx:85`, `src/components/Sidebar.tsx:344`, `src/components/ErrorBoundary.tsx:41, 50`
  - Track 5A: `src/main.tsx:73`, `src/views/SettingsView/sections/NetworkDataSection.tsx:98`, `src/views/SettingsView.tsx:186-190`
- **Trigger**: Error states in OAuth, client update, and data backup reference undefined `var(--status-error)` (token in `tokens.css` is `--status-danger`); proxy save failure renders in hardcoded green `#10b981` with an uncancelled 3s timeout; light-mode avatar rings and loading/error surfaces reference undefined `--bg-primary` / `--bg-card-hover` falling back to dark hex colors.
- **Impact**: Violates CONTEXT D4 semantic token discipline: error alerts lose danger styling (or display green on proxy failure) and light theme renders dark hardcoded surfaces.

### F-39 [Medium]: `RulesManagerModal` tab counts ignore search filter, `LaunchpadSubmitModal` overwrites user-typed name, `StarredFeed` batch favorite lacks busy guard
- **Locations**:
  - Track 5B: `src/components/RulesManagerModal.tsx:173, 396-445` (`docs/count-display.md:45`)
  - Track 5A: `src/views/LaunchpadView/LaunchpadSubmitModal.tsx:172-174`, `src/views/FavoritesView/StarredFeed.tsx:133-135`
- **Trigger**: (A) Typing a search filter in `RulesManagerModal` leaves tab `<CountBadge>` counts showing unfiltered totals, violating `docs/count-display.md` ("数量与可见内容同源"). (B) Typing a custom app name in `LaunchpadSubmitModal` while async preflight is running gets overwritten by `res.repo_name` via stale closure `!appName.trim()`. (C) Double-clicking "Favorite all cataloged" in `StarredFeed` fires N concurrent `onToggleFavorite` calls without busy guard or `{ silent: true }`, toggling favorites back off and spamming N toasts.
- **Impact**: Misleading rule counts, lost user input in submission wizard, and inverted/noisy batch favorite actions.

## Acceptance Criteria

- [ ] `AppDetailModal` guards all async completions (install, download, icon cycle, refresh, star verify, readme) against `currentAppIdRef`, resets `isInstalling` & `showAllAssets` on `app.id` change, and includes `oauthLogin` in `useDetailStarVerify` deps (F-32).
- [ ] `ModalShell` computes dynamic `z-index` from `openModalStack` position so newer `layer="base"` modals always render visually above older siblings in sync with Esc/focus-trap ordering (F-35).
- [ ] `AppCard` and `FeaturedView` HeroBanner check `e.target === e.currentTarget` and call `e.preventDefault()` on Space; `TitleBar` ignores `Ctrl+K`/`Cmd+K` while `[aria-modal="true"]` exists and closes the search dropdown on `Escape` (F-36).
- [ ] All undefined CSS variables are replaced with valid `tokens.css` variables (`--status-danger`, `--bg-acrylic-hover`, `--bg-canvas`, `--border-color`); `proxyFeedback` tracks `{ text: string; isError: boolean } | null` with a clearable timer and danger styling on error (F-37).
- [ ] `RulesManagerModal` derives tab `<CountBadge>` values from `filterQuery`-filtered items (F-39); `LaunchpadSubmitModal` uses `setAppName(prev => prev.trim() ? prev : res.repo_name)` (F-39); `StarredFeed` guards batch favorite with a busy flag, `{ silent: true }`, and a single summary toast (F-39).
- [ ] Regression tests cover F-32, F-35, F-36, F-37, F-39; `pnpm exec tsc --noEmit` and `pnpm exec vitest run` (including `countDisplay.test.ts`, `ModalShell.test.tsx`, `Sidebar.test.tsx`) pass.

## Comments

- **Resolved in `8004696`** (Track 5B `fix-fe-components`), **`0dd2671`** (Track 5A `fix-fe-app-views`), and **`555a09e`** (`integrator`: `RulesManagerModal` boolean failure propagation across all 7 rule-mutation call sites + regression tests).
- Guarded `AppDetailModal` in-place switching & added `oauthLogin` dep (F-32, `AppDetailModal.switch.test.tsx`, `AppDetailModal.starVerify.test.tsx`); added dynamic `openModalStack` z-index stacking in `ModalShell` / `useModalA11y` (F-35, `ModalShell.test.tsx`); fixed `AppCard`/`HeroBanner` keyboard bubbling and `TitleBar` `Ctrl+K` modal guard / `Esc` dropdown close (F-36, `AppCard.a11y.test.tsx`, `TitleBar.test.tsx`); mapped undefined CSS tokens to `tokens.css` variables (`cssTokens.test.ts`) and typed `proxyFeedback` with error styling + clearable timer (F-37); aligned `RulesManagerModal` filtered tab counts (`RulesManagerModal.test.tsx`), functional updater in `LaunchpadSubmitModal`, and busy guard/silent summary toast in `StarredFeed` (F-39).
- **Integrated verification on `main`** (`verifier` `verdict=PASS`): `tsc` 0 errors, `vitest` 142/142 files (1497/1497 tests).
