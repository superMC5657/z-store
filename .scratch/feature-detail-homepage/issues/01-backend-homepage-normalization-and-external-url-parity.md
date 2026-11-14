# Issue 01: Backend `homepage` Normalization, Self-Repo Fallback & `open_url` Scheme Parity

Status: resolved
Blocked by: none

## Summary

Harden backend `homepage` resolution and the unified `open_url` external link command so `AppDetail` always delivers clean `http(s)` homepage metadata and opens case-variant `http(s)` URLs consistently across platforms:

1. **Sanitize & normalize `homepage` in detail fetchers (`detail_fetch.rs` & `catalog_detail.rs`)**: Replace the naive case-sensitive `starts_with("http://") / starts_with("https://")` + unconditional `format!("https://{}", trimmed)` logic in `resolve_detail_stats` (which corrupts `"HTTPS://zed.dev"` into `"https://HTTPS://zed.dev"` and turns `"None"` / `"N/A"` / `"javascript:..."` / `"ftp://..."` into `"https://..."`, blocking catalog fallback) with a strict `normalize_http_homepage` helper.
2. **Prevent repo self-links from clobbering curated `CatalogItem.homepage`**: When upstream repository metadata sets `homepage` to the repository's own URL (e.g. `https://github.com/OpenMW/openmw`) while `CatalogItem.homepage` (from `Curated Catalog` or `Local Library`) has a valid distinct external homepage (e.g. `https://gitlab.com/OpenMW/openmw`), preserve the curated external homepage instead of overwriting it with a redundant repo self-link.
3. **Backfill missing `homepage` in `CatalogItem::overlay_detail_core` (`github/models.rs`)**: When `DetailRepository::project_detail` projects a TTL-valid `app_details` row onto a `CatalogItem`, backfill `core.homepage` from `self.homepage` if `core.homepage` is empty/`None` (or is a repo self-link while `self.homepage` is a distinct external URL).
4. **Case-insensitive `http(s)` validation seam in `open_external_url` (`commands/system.rs`)**: Align backend `open_url` with frontend `settings.openUrl` (`/^https?:\/\//i`) via a pure testable `validate_external_http_url(&str) -> Result<String, String>` function using `reqwest::Url::parse`.

## Scope

- Allowed to modify:
  - `src-tauri/src/github/detail_fetch.rs`
  - `src-tauri/src/github/models.rs`
  - `src-tauri/src/commands/catalog_detail.rs`
  - `src-tauri/src/commands/system.rs`
  - `src-tauri/src/repositories/detail_repo.rs` (unit tests if needed)
- Do not modify:
  - `src/**` (frontend files belong to Issues 02 and 03)
  - `src-tauri/src/db/schema.rs` (no schema migration required)

## Implementation Details

### 1. Pure Homepage Normalizer & Repo-Self Comparator (`src-tauri/src/github/detail_fetch.rs`)

Add `pub(crate)` helpers reusable across `github/detail_fetch.rs`, `github/models.rs`, and `commands/catalog_detail.rs`:

- `pub(crate) fn normalize_http_homepage(raw: &str) -> Option<String>`:
  - Trim `raw`; return `None` if empty or if `trimmed.chars().any(char::is_whitespace)`.
  - If `trimmed` has an explicit `http://` or `https://` prefix (ASCII case-insensitive):
    - Normalize the scheme prefix to lowercase (`http://` or `https://`) while keeping the rest of `trimmed` intact.
  - Else if `trimmed` contains `:` or `@` before the first `/` (e.g., `javascript:...`, `mailto:...`, `ftp://...`, `data:...`, `git@github.com:...`):
    - Reject immediately (`None`).
  - Else (scheme-less bare domain entered in repo settings, e.g. `"zed.dev"` or `"www.7-zip.org/download.html"`):
    - Extract the host portion before the first `/`, `?`, or `#`; require that it contains `.` and neither starts nor ends with `.` (rejecting single-word placeholders like `"None"`, `"N/A"`, `"TBD"`), then prepend `"https://"`.
  - Parse the candidate with `reqwest::Url::parse(&candidate).ok()?`:
    - Require `matches!(parsed.scheme(), "http" | "https")`;
    - Require `parsed.username().is_empty() && parsed.password().is_none()`;
    - Require `parsed.host_str()` to be non-empty (`host` stripped of trailing `.` must not start with `.`, and must contain `.`, equal `"localhost"`, or be IPv6 `[...]`).
  - Return `Some(candidate)`.

- `pub(crate) fn is_same_repo_homepage(homepage_url: &str, forge_host: &str, owner: &str, repo: &str) -> bool`:
  - Parse `homepage_url` via `reqwest::Url::parse`.
  - Normalize host: lowercase `host_str`, strip trailing `.`, strip optional single leading `"www."`, and include non-default `:port` (`parsed.port()`, which is `None` for default `http:80` / `https:443`). Compare against normalized `forge_host` (defaulting to `"github.com"` when empty, similarly stripped of trailing `.` and leading `"www."`).
  - Normalize path: percent-decode or compare path segments stripped of leading/trailing `/`, strip optional case-insensitive `.git` suffix on the second segment, and check exact 2-segment case-insensitive match `(seg_owner, seg_repo) == (owner.trim(), repo.trim())`.

### 2. Apply in `resolve_detail_stats`, `fetch_detail_from_forge`, `overlay_detail_core`, and `merge_from_detail`

- In `src-tauri/src/github/detail_fetch.rs`:
  - Update `resolve_detail_stats` (or pass `(owner, repo)` / derive from `repo_info.full_name` / `catalog_item` — passing `owner: &str, repo: &str` into `resolve_detail_stats` is cleanest since both callers at lines 590 and 760 already hold `owner` and `repo`!):
    - Normalize `repo_hp = repo_info.and_then(|r| r.homepage.as_deref()).and_then(normalize_http_homepage)`.
    - Normalize `cat_hp = catalog_item.and_then(|i| i.homepage.as_deref()).and_then(normalize_http_homepage)`.
    - If `repo_hp` is `Some(ref r_url)` and `is_same_repo_homepage(r_url, "github.com", owner, repo)`, and `cat_hp` is `Some(ref c_url)` where `!is_same_repo_homepage(c_url, "github.com", owner, repo)`, select `cat_hp`; otherwise `repo_hp.or(cat_hp)`.
- In `src-tauri/src/commands/catalog_detail.rs` (`fetch_detail_from_forge`, around line 686):
  - Apply the same normalized resolution using `&coord.host`, `&coord.owner`, `&coord.repo` so multi-forge (`Codeberg` / `Gitea` / `GitLab`) details get identical normalization and curated fallback semantics.
- In `src-tauri/src/github/models.rs`:
  - In `CatalogItem::overlay_detail_core(&self, core: &mut AppCore)`:
    - Let `cat_hp = self.homepage.as_deref().and_then(crate::github::detail_fetch::normalize_http_homepage)`.
    - If `cat_hp` is `Some(c_url)`:
      - Backfill `core.homepage = Some(c_url)` when `core.homepage` is `None`/blank, OR when `core.homepage` matches `is_same_repo_homepage(..., forge_host, &core.owner, &core.repo)` while `c_url` does NOT match `is_same_repo_homepage`.
  - In `CatalogItem::merge_from_detail(&mut self, detail: &AppDetail)`:
    - When `detail.core.homepage` is a repo self-link (`is_same_repo_homepage`) and `self.homepage` already holds a valid non-self external homepage, do NOT overwrite `self.homepage` with the repo self-link.

### 3. Case-Insensitive `validate_external_http_url` Seam (`src-tauri/src/commands/system.rs`)

- Extract `pub(crate) fn validate_external_http_url(url: &str) -> Result<String, String>`:
  - Trim `url`; reject empty string or internal whitespace;
  - Normalize case-insensitive `http://` or `https://` prefix to lowercase `http://` / `https://` (rejecting any other scheme with `"仅支持打开 http/https 协议的安全链接"`);
  - Verify `reqwest::Url::parse` succeeds with empty username/password and non-empty `host_str()`.
- Update `open_external_url(url: &str)` to call `let clean = validate_external_http_url(url)?;` and pass `&clean` to the platform opener (`rundll32` / `open` / `xdg-open`).

## Acceptance Criteria

- [x] `normalize_http_homepage` unit tests in `src-tauri/src/github/detail_fetch.rs` verify:
  - Valid `https://zed.dev` and `http://gitup.co` are preserved;
  - Uppercase `  HTTPS://Example.com/docs?x=1#top  ` normalizes scheme to `https://Example.com/docs?x=1#top` (never `https://HTTPS://...`);
  - Bare domain `zed.dev` and `www.7-zip.org/download.html` normalize to `https://zed.dev` and `https://www.7-zip.org/download.html`;
  - Placeholders and non-web schemes (`""`, `"   "`, `"None"`, `"N/A"`, `"TBD"`, `"javascript:alert(1)"`, `"mailto:a@b.com"`, `"ftp://files.example.com"`, `"data:text/html,hi"`, `"https://user:pass@example.com"`, `"https://example.com with space"`) all return `None`.
- [x] `resolve_detail_stats` unit tests verify:
  - Invalid `repo_info.homepage` (e.g. `"N/A"` or `"ftp://..."`) falls back to `catalog_item.homepage`;
  - Repo self-link `repo_info.homepage = Some("https://github.com/OpenMW/openmw")` does NOT overwrite curated `catalog_item.homepage = Some("https://gitlab.com/OpenMW/openmw")`.
- [x] `CatalogItem::overlay_detail_core` and `CatalogItem::merge_from_detail` unit tests in `src-tauri/src/github/models.rs` verify missing/self-link `core.homepage` is healed from `CatalogItem.homepage` and curated external `homepage` is not overwritten by a repo self-link.
- [x] `validate_external_http_url` unit tests in `src-tauri/src/commands/system.rs` verify `HTTPS://example.com/path` and `http://example.com` succeed without spawning an OS browser process, while empty, `ftp://`, `javascript:`, `file://`, and `zstore://` inputs return `Err`.
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml --lib` pass with zero warnings/errors.

## Comments

- 2026-11-15 已实现：`detail_fetch.rs` 新增 `normalize_http_homepage` / `is_same_repo_homepage` / `resolve_homepage`（多路径段通用判重，兼容 GitLab 子组），接入 `resolve_detail_stats`、`fetch_detail_from_forge`、`overlay_detail_core`、`merge_from_detail`；`system.rs` 抽出 `validate_external_http_url`。clippy `-D warnings` 与 `cargo test --lib`（576 passed）通过。
