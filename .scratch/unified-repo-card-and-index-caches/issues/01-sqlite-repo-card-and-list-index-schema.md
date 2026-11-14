# Issue 01: SQLite `repo_card_cache` & `search_list_cache` Schema, v6 Migration, Non-Destructive Merge, LRU & Logout Purge

Status: resolved
Blocked by: none

## Summary

Build the SQLite persistence foundation for the refactored discovery/sync cache architecture:

1. **Independent Single-Repo Rich-Card Table (`repo_card_cache`)**: Physically isolated from `catalog_apps` and `custom_apps`, storing lightweight rich-card fields (`AppSummary` subset), derived `platforms_json`, `confirmed_other`, `is_private`, `updated_at`, and `last_accessed_at` keyed by canonical `id`.
2. **Non-Destructive Monotonic Merge & Sanitization (`src-tauri/src/db/repo_cards.rs`)**: Enforce at the DAO boundary that catalog annotations never exist in the schema, `data:` / body-image icons are stripped to `""`, empty/placeholder values never overwrite real persisted values, platform state upgrades monotonically (`concrete platforms` > `confirmed_other = 1` > `unknown []`), and `REPO_CARD_CACHE_MAX_ROWS = 2000` is enforced by `last_accessed_at` LRU.
3. **Isomorphic `search_list_cache` Table & Slim List Snapshot Governance (`src-tauri/src/db/cache.rs`)**: Add `search_list_cache` alongside `trend_board_cache` and `starred_feed_cache` with uniform `64 KiB` max payload cap, 7-day retention, and bounded row limits (`30` boards / `15` starred targets / `100` search pages).
4. **Schema v5 → v6 Migration & Logout/Expiry Private Purge (`schema.rs`, `oauth/mod.rs`, `lib.rs`)**: Bump `CURRENT_USER_VERSION` to `6` (purging legacy `v: 1` fat payloads from `trend_board_cache` and `starred_feed_cache`), wire startup pruning in `lib.rs`, and purge `repo_card_cache WHERE is_private = 1` + `search_list_cache WHERE has_private = 1` in `oauth::clear_oauth_session` and the 401 `auth_rx` handler.

## Scope

- Allowed to modify:
  - `src-tauri/src/db/schema.rs`
  - `src-tauri/src/db/repo_cards.rs` (new file)
  - `src-tauri/src/db/cache.rs`
  - `src-tauri/src/db/mod.rs`
  - `src-tauri/src/db/tests.rs`
  - `src-tauri/src/oauth/mod.rs`
  - `src-tauri/src/oauth/tests.rs`
  - `src-tauri/src/lib.rs` (only startup pruning & `auth_rx` private cache cleanup)
- Do not modify:
  - `src/*` (frontend files)
  - `src-tauri/src/commands/*`, `src-tauri/src/github/*`, `src-tauri/src/repositories/*` (belong to Issue 02)

## Implementation Details

### 1. Schema DDL & `v5 → v6` Migration (`src-tauri/src/db/schema.rs`)

- Bump `const CURRENT_USER_VERSION: i64 = 6;` and add `5 => self.migrate_v5_to_v6()?` to `run_migrations`.
- Add idempotent DDL in `init_schema`:
  ```sql
  CREATE TABLE IF NOT EXISTS repo_card_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      description_en TEXT,
      icon TEXT NOT NULL DEFAULT '',
      icon_bg TEXT NOT NULL DEFAULT '',
      stars INTEGER NOT NULL DEFAULT 0,
      forks INTEGER NOT NULL DEFAULT 0,
      license TEXT NOT NULL DEFAULT '',
      latest_version TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'external',
      category_name TEXT NOT NULL DEFAULT '跨平台开源',
      forge TEXT NOT NULL DEFAULT 'github',
      forge_host TEXT NOT NULL DEFAULT 'github.com',
      homepage TEXT,
      platforms_json TEXT NOT NULL DEFAULT '[]',
      confirmed_other INTEGER NOT NULL DEFAULT 0,
      is_private INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_repo_card_cache_lru ON repo_card_cache(last_accessed_at ASC);
  CREATE INDEX IF NOT EXISTS idx_repo_card_cache_private ON repo_card_cache(is_private) WHERE is_private = 1;

  CREATE TABLE IF NOT EXISTS search_list_cache (
      cache_key TEXT PRIMARY KEY,
      norm_query TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL DEFAULT 0,
      has_private INTEGER NOT NULL DEFAULT 0,
      cached_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_search_list_cache_cached_at ON search_list_cache(cached_at DESC);
  CREATE INDEX IF NOT EXISTS idx_search_list_cache_query ON search_list_cache(norm_query);

  CREATE INDEX IF NOT EXISTS idx_trend_board_cache_cached_at ON trend_board_cache(cached_at DESC);
  ```
- Implement `migrate_v5_to_v6(&self) -> Result<()>`:
  ```rust
  self.conn.execute_batch(
      "DELETE FROM trend_board_cache;
       DELETE FROM starred_feed_cache;",
  )
  ```
  so legacy `v: 1` fat-row JSON blobs are immediately reclaimed on upgrade.

### 2. `repo_card_cache` DAO (`src-tauri/src/db/repo_cards.rs` & `src-tauri/src/db/mod.rs`)

- Constants:
  - `pub const REPO_CARD_CACHE_MAX_ROWS: usize = 2000;`
  - `pub const REPO_CARD_FRESH_TTL_SECS: i64 = 12 * 3600;`
- Define write/read models:
  - `pub struct RepoCardUpsert`: carries `summary: AppSummary`, `confirmed_other: bool`, `is_private: Option<bool>`.
  - `pub struct StoredRepoCard`: carries `summary: AppSummary` (with `is_verified = false`, `is_cataloged = None`, `source = None`, `status = None`, `added_at = None`, and empty DB `latest_version` restored to `"latest"`), `confirmed_other: bool`, `is_private: bool`, `updated_at: i64`, `last_accessed_at: i64`.
- Enforce write guards in `upsert_repo_card` / `upsert_repo_cards_batch` (transactional via `with_immediate_transaction`):
  - Normalize `id` via `crate::forge::canonical_app_id(&inc.summary.core.id)`; skip empty/invalid `id`, `owner`, or `repo`.
  - Sanitize `icon`: if `icon.trim()` starts with `"data:"` (ASCII case-insensitive) or matches `crate::icons::is_body_image_url`, strip to `""`.
  - Sanitize placeholders before comparing with existing row (`prev`):
    - `name`: empty or `"加载中..."` → keep `prev.name` if non-empty, else fallback to `repo`.
    - `description` / `description_en`: if empty or `crate::github::detail_fetch::is_placeholder_description`, normalize to `""` / `None` and preserve `prev` if `prev` has a non-empty real string.
    - `license`: `""`, `"..."`, `"unknown"`, `"NOASSERTION"`, or (`"OpenSource"` when `forge != "github"`) → normalize to `""` and preserve `prev.license` if non-empty.
    - `latest_version`: `""`, `"latest"`, `"..."` → normalize to `""` and preserve `prev.latest_version` if non-empty.
    - `category` / `category_name` / `icon_bg`: if incoming `category` is `""` or `"external"` and `prev.category` is non-empty and `!= "external"`, preserve `prev.category`, `prev.category_name`, and `prev.icon_bg`; if incoming `icon_bg` is `""`, preserve `prev.icon_bg`.
    - `homepage`: trim empty to `None`; `None` preserves `prev.homepage`.
    - `icon`: `""` preserves `prev.icon`.
    - `platforms_json` & `confirmed_other`:
      - If `!inc.platforms.is_empty()` → save `inc.platforms`, set `confirmed_other = false`.
      - Else if `inc.confirmed_other` → if `prev` already has non-empty `platforms`, keep `prev.platforms` and `confirmed_other = false`; otherwise set `confirmed_other = true`.
      - Else (`inc.platforms.is_empty() && !inc.confirmed_other`) → keep `prev.platforms` and `prev.confirmed_other` unchanged.
    - `is_private`: `Some(b)` sets `b`; `None` preserves `prev.is_private` (default `false` on new row).
    - Timestamps: `updated_at = now`, `last_accessed_at = now`.
  - Automatically call `self.prune_repo_card_cache(REPO_CARD_CACHE_MAX_ROWS)` at the end of `upsert_repo_cards_batch` / `upsert_repo_card` when row count exceeds `REPO_CARD_CACHE_MAX_ROWS`.
- Additional DAO methods on `Database`:
  - `patch_repo_card_platforms(&self, raw_id: &str, owner: &str, repo: &str, platforms: &[String], latest_version: Option<&str>, confirmed_other: bool) -> Result<()>`:
    - If row exists: apply the monotonic platform/version rules above and bump `last_accessed_at = now` while preserving `updated_at` (so platform-only patches don't fake full metadata freshness if `updated_at == 0`).
    - If row does not exist: insert minimal pre-seed row `(id, name = repo, owner, repo, platforms_json, latest_version, confirmed_other, updated_at = 0, last_accessed_at = now)`.
  - `sync_repo_card_icon(&self, raw_id: &str, new_icon: &str, allow_clear: bool) -> Result<bool>`:
    - Strip `data:` / body-image URLs to `""`; if sanitized icon is `""` and `!allow_clear`, no-op; otherwise update `repo_card_cache.icon` for canonical `id` without changing `updated_at`.
  - `get_repo_card(&self, raw_id: &str) -> Result<Option<StoredRepoCard>>`: returns `Some` only when `updated_at > 0`.
  - `get_repo_cards_batch_and_touch(&self, raw_ids: &[String], now: i64) -> Result<std::collections::HashMap<String, StoredRepoCard>>`:
    - Canonicalizes IDs, queries `WHERE id IN (...) AND updated_at > 0`, updates `last_accessed_at = now` for hit IDs in a single `UPDATE`, and returns a map keyed by canonical `id`.
  - `purge_cataloged_repo_cards(&self) -> Result<usize>`:
    - Deletes rows from `repo_card_cache` whose `id` is in `catalog_apps` OR in `custom_apps` with `archived = 0 AND status IN ('collected', 'local_collected', 'submitted')`.
  - `delete_private_repo_cards(&self) -> Result<usize>`:
    - `DELETE FROM repo_card_cache WHERE is_private = 1`.
  - `prune_repo_card_cache(&self, max_rows: usize) -> Result<usize>`:
    - `DELETE FROM repo_card_cache WHERE id NOT IN (SELECT id FROM repo_card_cache ORDER BY last_accessed_at DESC, id ASC LIMIT ?1)`.

### 3. Slim List Snapshot Caches (`src-tauri/src/db/cache.rs`)

- Update list snapshot limits for slim `v: 2` index envelopes:
  - `pub const TREND_BOARD_CACHE_MAX_BYTES: usize = 64 * 1024;`
  - `pub const TREND_BOARD_CACHE_MAX_ROWS: usize = 30;`
  - `pub const STARRED_FEED_CACHE_MAX_BYTES: usize = 64 * 1024;`
  - `pub const SEARCH_LIST_CACHE_MAX_BYTES: usize = 64 * 1024;`
  - `pub const SEARCH_LIST_CACHE_MAX_ROWS: usize = 100;`
  - `const SEARCH_LIST_CACHE_RETENTION_SECS: i64 = 7 * 86400;`
- Enhance `prune_expired_trend_board_cache(&self, now: i64)` to also cap remaining rows at `TREND_BOARD_CACHE_MAX_ROWS` ordered by `cached_at DESC, cache_key ASC`.
- Add `search_list_cache` DAO methods:
  - `get_search_list_cache(&self, cache_key: &str) -> Result<Option<(String, i64)>>`
  - `save_search_list_cache(&self, cache_key: &str, norm_query: &str, payload: &str, has_private: bool) -> Result<()>` (reject `> SEARCH_LIST_CACHE_MAX_BYTES` with `"search_list_payload_too_large"`, trim empty skip, upsert, and prune overflow beyond `SEARCH_LIST_CACHE_MAX_ROWS`).
  - `prune_search_list_cache(&self, now: i64) -> Result<usize>` (7-day cutoff + `SEARCH_LIST_CACHE_MAX_ROWS` cap).
  - `delete_private_search_list_cache(&self) -> Result<usize>` (`DELETE FROM search_list_cache WHERE has_private = 1`).
- Extend `prune_bounded_caches` (or startup block in `src-tauri/src/lib.rs`) to also run `prune_repo_card_cache(REPO_CARD_CACHE_MAX_ROWS)`, `prune_search_list_cache(now_secs())`, and `purge_cataloged_repo_cards()`.

### 4. Logout & 401 Auth-Expiry Cleanup (`src-tauri/src/oauth/mod.rs` & `src-tauri/src/lib.rs`)

- In `oauth::clear_oauth_session`:
  - Call `let _ = db.delete_private_repo_cards();` and `let _ = db.delete_private_search_list_cache();` alongside `delete_starred_feed_cache_by_scope_prefix("@me:")` and `delete_etags_by_prefix("https://api.github.com/user/")`.
- In `src-tauri/src/lib.rs` `auth_rx` 401 expiry loop (around line 455):
  - When no fallback `github.com` host token is configured, also purge `delete_starred_feed_cache_by_scope_prefix("@me:")`, `delete_private_repo_cards()`, and `delete_private_search_list_cache()`.

## Acceptance Criteria

- [ ] Schema migration test in `db/schema.rs` verifies upgrading a `user_version = 5` DB with rows in `trend_board_cache` and `starred_feed_cache` stamps `user_version = 6`, clears legacy `v: 1` list rows, and creates `repo_card_cache` and `search_list_cache`.
- [ ] Unit tests in `db/repo_cards.rs` verify:
  - `data:` icons and body-image URLs are stripped to `""` on write and never overwrite an existing remote `http(s)` icon;
  - Placeholder descriptions (`"开源软件项目"`, `"GitHub 社区开源项目"`, `"No description available"`), placeholder versions (`"latest"`, `"..."`), placeholder licenses (`"unknown"`), `"external"` category, and empty `homepage` never overwrite existing real values;
  - Concrete `platforms` (`["windows"]`) upgrade `confirmed_other = 1` and clear `confirmed_other` to `0`, while incoming empty `platforms` (both `confirmed_other = false` and `confirmed_other = true`) never downgrade existing concrete `platforms`;
  - Pre-seeded platform rows (`updated_at = 0`) are hidden from `get_repo_card` / `get_repo_cards_batch_and_touch` until full repo metadata arrives, at which point the full upsert inherits the pre-seeded platforms and version;
  - `get_repo_cards_batch_and_touch` updates `last_accessed_at`, and `prune_repo_card_cache` evicts least-recently-accessed rows first while keeping recently touched rows;
  - `purge_cataloged_repo_cards` removes rows matching `catalog_apps` or active local library `custom_apps` (`collected`/`local_collected`/`submitted`, `archived = 0`) while leaving `draft` or uncataloged rows intact.
- [ ] Unit tests in `db/tests.rs` and `oauth/tests.rs` verify `search_list_cache` CRUD/64KiB cap/pruning, updated `64 KiB` caps on `trend_board_cache` & `starred_feed_cache`, and that `clear_oauth_session` purges `is_private = 1` repo cards and `has_private = 1` search list entries while preserving public entries.
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml --lib` pass cleanly.
