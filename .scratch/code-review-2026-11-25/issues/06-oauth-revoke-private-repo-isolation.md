# Issue 06: OAuth Revoke & Private Repository Isolation (Backend + Frontend)

Status: resolved
Severity: High (F-02 [High], Test Gap #6)
Fix Track: Track 3 (`fix-rust-storage`) + Track 4 (`fix-fe-services`) *(+ Track 5A `fix-fe-app-views` for deep-link E2E test coverage)*
Findings: F-02 (BE + FE), Test Gap #6

## Findings

### F-02 [High]: Incomplete OAuth revoke retains PAT-fallback private caches & resurrects private GitHub repos via `api_etag_cache`, `app_details`, and frontend `cardPool`
- **Locations (Backend — Track 3)**:
  - `src-tauri/src/oauth/mod.rs:396-423`
  - `src-tauri/src/commands/catalog_search.rs:95-138, 342-424`
  - `src-tauri/src/repositories/card_hydrator.rs:369-406, 1022-1037`
  - `src-tauri/src/repositories/detail_service.rs:81-89, 100-115`
  - `src-tauri/src/github/search.rs:248-260`
  - `src-tauri/src/models.rs`, `src-tauri/src/db/schema.rs`, `src-tauri/src/repositories/detail_repo.rs`
- **Locations (Frontend — Track 4)**:
  - `src/types/index.ts`
  - `src/services/repoEnrichCache.ts:664-680, 760-797`
- **Trigger**:
  1. While signed in, searching/starring/viewing a private repo seeds `https://api.github.com/repos/{owner}/{repo}` into `api_etag_cache`, caches `/search/repositories?...` JSON in `api_etag_cache`, and persists `app_details` (+ `/releases/latest` & `/readme` ETags). On logout/401 (`revoke_oauth_session`), Rust only deletes `api_etag_cache` prefix `https://api.github.com/user/`. Post-logout (no token), `direct_github_lookup("org/private-repo")` hits `soft_fresh_payload` (<12h) in `api_etag_cache` and `card_hydrator::write_through` re-inserts the private repo into `repo_card_cache`; `get_app_details`/`get_repo_cards_batch` still serve `app_details`; `search_apps_online` falls back to `api_etag_cache` on network/rate-limit error.
  2. When a `github.com` host PAT exists (e.g., Account B / org token) and the user triggers `ManualLogout` from OAuth Account A, `fallback = stored_host_token(db, "github.com")` is `Some`, causing `revoke_oauth_session` (`oauth/mod.rs:413-418`) to skip deleting `@me:` starred feed cache, private repo cards, and private search list cache.
  3. On the frontend, `upsertRepoCardFromDetail` inserts detail-loaded cards into `cardPool` without calling `recordSharedPrivateRepos` (`AppDetail` lacks `is_private`), so `clearPrivateSharedRepoCards()` misses them on logout / `zstore://oauth-expired`.
- **Impact**: Violates ADR-0026 and ADR-0027 private-data isolation: Account A's private repository metadata, cards, and READMEs persist across logout/account switch and resurrect without an active OAuth token.

### Test Gap #6: OAuth 401 & Deep-link E2E test gaps
- **Locations**:
  - `src-tauri/src/oauth/mod.rs` / `oauth/revoke_tests.rs` (Track 3)
  - `src/services/repoEnrichCache.ts` tests (Track 4)
  - `src/App.deepLinkInstallGuard.test.tsx` (Track 5A)
- **Issue**: No end-to-end test covers `401` → `revoke_oauth_session` → `zstore://oauth-expired` → frontend memory cache purge; `App.deepLinkInstallGuard.test.tsx` mocks `handleDeepLink` and omits `zstore://collection` E2E confirm-guard and unverified-asset `zstore://install/...` flows.

## Cross-Track Contract (`AppDetail.is_private`)

- **Rust (`src-tauri/src/models.rs`)**: `#[serde(default)] pub is_private: bool` on `AppDetail`.
- **SQLite (`db/schema.rs` + `repositories/detail_repo.rs`)**: Safe additive `is_private INTEGER NOT NULL DEFAULT 0` column on `app_details`.
- **TypeScript (`src/types/index.ts`)**: `is_private?: boolean` on `AppDetail`.

## Acceptance Criteria

- [ ] On `ManualLogout`, `revoke_oauth_session` unconditionally clears `@me:` starred cache, private `repo_card_cache`, private `search_list_cache`, `user_repo_signals`, and `user_stars` even when a `github.com` host PAT exists.
- [ ] On both `ManualLogout` and `AuthExpired401`, `revoke_oauth_session` collects all private repo IDs from `repo_card_cache` AND `app_details`, deletes their `app_details` rows, purges their `https://api.github.com/repos/{owner}/{repo}*` ETag rows, and purges `https://api.github.com/search/repositories` ETag rows from `api_etag_cache`.
- [ ] `AppDetail.is_private` is persisted in `app_details`, serialized to the frontend, and typed in `src/types/index.ts`.
- [ ] `src/services/repoEnrichCache.ts::upsertRepoCardFromDetail` calls `recordSharedPrivateRepos([detail.id])` when `detail.is_private === true`, so `clearPrivateSharedRepoCards()` purges detail-loaded private repos on logout / `zstore://oauth-expired`.
- [ ] Regression tests verify (a) backend revoke prevents resurrection via `direct_github_lookup`, `search_apps_online`, and `get_app_details` (including with a fallback PAT present), and (b) frontend `upsertRepoCardFromDetail` + `clearPrivateSharedRepoCards` purges private detail cards on `zstore://oauth-expired`.

## Comments

- **Resolved in `b48b4da`** (Track 3 `fix-rust-storage`), **`1caf5dc`** (Track 4 `fix-fe-services`), and **`555a09e`** (`integrator`: `fix(integration): propagate rule mutation status and purge private RAM caches on OAuth revoke`).
- Backend (`b48b4da`): Added `AppDetail.is_private: bool` (and `GitHubRepoResponse.private`), additive `app_details.is_private` migration (`db/schema.rs`, `db/details.rs`, `repositories/detail_repo.rs`), unconditional private-cache purge on `ManualLogout` regardless of host PAT fallback, and private `app_details` / `/repos/{o}/{r}*` / `/search/repositories` ETag cleanup in `oauth/mod.rs` with comprehensive regression suite in `oauth/revoke_tests.rs`.
- Frontend (`1caf5dc` + `555a09e`): Added `is_private?: boolean` to `AppDetail` (`src/types/index.ts`), registered private details via `recordSharedPrivateRepos` inside `upsertRepoCardFromDetail` (`src/services/repoEnrichCache.ts`), invoked `forgetPrivateStarredQueries()` directly on `zstore://oauth-expired` (`useAppSubscriptions.ts`), treated `oauthUser.is_expired` as logged-out for `noteStarredLogin` (`App.tsx`), and cleared `appDetailMemoryCache` on `zstore:oauth-changed` (`useDetailCacheSync.ts`), with regression tests in `repoEnrichCache.test.ts`, `useAppSubscriptions.test.tsx`, and `useDetailCacheSync.test.tsx` (Test Gap #6).
- **Integrated verification on `main`** (`verifier` `verdict=PASS`): `tsc` 0 errors, `vitest` 142/142 files (1497/1497 tests), `cargo test` 875 passed / 3 ignored, `cargo clippy --all-targets` 0 warnings.
