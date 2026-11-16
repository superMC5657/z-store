# Issue 03: Memory Inverted Index, Word/Path-Boundary Scoring Engine, Fork Disambiguation & Global 1-to-1 Assignment

Status: ready-for-agent
Blocked by: 01, 02

## Summary

Replace the `O(N × M)` substring heuristic loop in `src-tauri/src/scanner/matcher.rs` with a precomputed in-memory inverted index (`CatalogMatchIndex`), boundary-safe multi-signal scoring, fork/variant penalty guards, structured `match_reasons`, global best-first 1-to-1 assignment, and strict post-match import path validation:

1. **Pre-filtering (`match_unmanaged`)**: Exclude already-managed `installed_ids` (`canonical_lookup_id`) and catalog entries whose non-empty `platforms` excludes `CatalogItem::current_platform_key()` *before* indexing, scoring, and filesystem/PE I/O.
2. **In-Memory Inverted Index (`CatalogMatchIndex`)**: Pre-normalize catalog entries once per scan and index them across four inverted lookup maps (`name_token`, `exe_stem`, `dir_segment`, `publisher_token`), eliminating `O(N × M)` string lowercasing and `Vec` cloning.
3. **DisplayName Normalization & Boundary-Safe Multi-Signal Scoring**:
   - Strip version/arch/scope/Inno-Setup suffixes (`"Motrix 1.8.19"` → `"motrix"`, `"Microsoft Visual Studio Code (User)"` → `"microsoft visual studio code"` / `"visual studio code"`);
   - Enforce strict token boundaries on names/publishers and path-component boundaries on `install_location`/`display_icon` (completely removing `s_loc.contains(&c_repo)` and `s_name.contains(alias)`);
   - Gate short names (`len <= 3` such as `min`, `ice`, `mos`, `rio`, `zed`) at `0.38` max name score so they require executable, directory-segment, or publisher corroboration to cross `MIN_QUALIFIED_SCORE = 0.45`;
   - Isolate search-only/competitor aliases (`anydesk`, `1password`, `postman`, `vscode` on VSCodium, `firefox` on Floorp, `ide`, `code`, `*替代`);
   - Apply fork/variant mismatch guard (`-0.35`) so standard `7-Zip` is never hijacked by `mcmilk/7-zip-zstd`;
   - Elevate curated native executable / bundle ID hits (`+0.48`) so localized display names (e.g. `"思源笔记"` + `SiYuan.exe`) match reliably, and gate version bonus (`+0.05`) on non-trivial versions with prior name/executable match.
4. **Global Best-First 1-to-1 Bipartite Assignment & `match_reasons`**: Sort all qualified `(scanned_idx, cat_idx)` pairs globally by `(score, has_curated_exe, has_exact_name, matched_name_len)` descending and assign 1-to-1 without catalog-order bias; populate `AppMatchResult.match_reasons: Vec<String>`.
5. **Strict `ensure_import_path` Gate (`scanner/mod.rs`)**: Prevent global `resolve_installed_app_path` from fabricating a match when `scanned` already pointed to an existing unrelated directory on disk.

## Scope

- Allowed to modify:
  - `src-tauri/src/scanner/matcher.rs`
  - `src-tauri/src/scanner/types.rs` (add `#[serde(default)] pub match_reasons: Vec<String>` to `AppMatchResult`)
  - `src-tauri/src/scanner/mod.rs` (tighten `ensure_import_path`)
  - `src-tauri/src/scanner/tests.rs`
- Do not modify:
  - `src/*` (frontend files — `AppMatchResult.match_reasons` is optional/additive until Issue 04 consumes it)
  - `src-tauri/src/commands/*`

## Implementation Details

### 1. Add `match_reasons` to `AppMatchResult` (`src-tauri/src/scanner/types.rs`)

- Add `#[serde(default)] pub match_reasons: Vec<String>` to `AppMatchResult`.
- Canonical reason codes (stable snake_case strings for frontend i18n mapping):
  - `"exact_name"` — normalized product name / repo / curated English title exact match
  - `"prefix_name"` — word-boundary prefix or full multi-token sequence match
  - `"alias"` — sanitized exact product alias match
  - `"executable"` — native executable filename match on `display_icon` or `install_location`
  - `"bundle_id"` — exact `registry_key` / macOS `CFBundleIdentifier` / Linux `.desktop` stem match
  - `"install_dir"` — path-component match on `install_dirs` or `repo`
  - `"publisher"` — publisher / owner match
  - `"version"` — non-trivial version corroboration

### 2. `normalize_app_title` & Tokenization Helpers (`src-tauri/src/scanner/matcher.rs`)

- `pub fn normalize_app_title(raw: &str) -> String`:
  1. Trim & lowercase.
  2. Repeatedly strip trailing parenthesized metadata tags matching arch/scope/edition/locale tokens: e.g. `(user)`, `(machine)`, `(all users)`, `(system)`, `(msi)`, `(64-bit)`, `(32-bit)`, `(x64)`, `(x86)`, `(arm64)`, `(aarch64)`, or combinations like `(64-bit x64)` / `(x64 zh-cn)` / `(x86 en-us)`.
  3. Strip trailing standalone arch/installer tokens (`x64`, `x86`, `64-bit`, `32-bit`, `win64`, `win32`, `arm64`).
  4. Strip trailing version token (`v?\d+(\.\d+)+([+-][a-z0-9._-]+)?`, e.g. `"vlc media player 3.0.21"` → `"vlc media player"`, `"7-zip 24.08"` → `"7-zip"`, `"motrix 1.8.19"` → `"motrix"`).
  5. Collapse consecutive internal whitespace to single `' '`.
- `pub fn tokenize_words(s: &str) -> Vec<String>`:
  - Split on whitespace and `['-', '_', '/', '\\', '.', ':', '(', ')', '[', ']']`, filter non-empty tokens.
- Vendor-prefix stripping variant: when `scanned.publisher` matches `cat.owner` / `cat.publishers` (e.g. `"microsoft"`), also strip a leading owner word from `s_norm` (`"microsoft visual studio code"` → `"visual studio code"`), and when `cat.description_en` is a concise title (`1..=4` words, `<= 36` chars, no sentence punctuation `.` / `,` / `:` / `—` / `- `, e.g. `"Visual Studio Code"`), include its normalized form in `entry.exact_names`.

### 3. `CatalogMatchIndex` & Safe Alias Filtering (`src-tauri/src/scanner/matcher.rs`)

- Build `CatalogMatchIndex<'a>`:
  - Collect global set of all catalog `name` and `repo` lowercase strings (`all_primary_names`).
  - Maintain `PROPRIETARY_COMPETITOR_BLOCKLIST`: `["anydesk", "teamviewer", "1password", "lastpass", "bitwarden", "postman", "insomnia", "alfred", "raycast", "spotlight", "bartender", "airdrop", "evernote", "notion", "roam", "obsidian", "acrobat", "photoshop", "illustrator", "premiere", "final cut", "vmware", "parallels", "winrar", "bandizip", "xshell", "securecrt", "navicat", "datagrip", "charles", "fiddler", "surge", "docker", "epic", "steam", "gog", "discord", "slack"]` — an entry in `cat.aliases` is **blocked** if:
    1. It equals an entry in `PROPRIETARY_COMPETITOR_BLOCKLIST` (unless `cat.repo.to_lowercase() == alias` or `cat.name.to_lowercase() == alias`, e.g. `bitwarden/clients` itself IS Bitwarden, whereas `keepassxc` having `"1password"` is blocked!);
    2. It equals another catalog item's `name` or `repo` (`all_primary_names`, e.g. `vscodium` having `"vscode"` or `floorp` having `"firefox"` is blocked!);
    3. It contains `"替代"` / `"alternative"` or is in `ALIAS_GENERIC_STOP_WORDS` (`CANDIDATE_STOP_WORDS` union `["ide", "git", "ssh", "sftp", "api", "rest", "graphql", "http", "json", "sql", "pdf", "epub", "mp4", "mkv", "bt", "p2p", "torrent", "proxy", "vpn", "ocr", "tts", "ai", "llm", "cli", "tui", "gtk", "qt", "rust", "golang", "python", "electron", "tauri", "linux", "macos", "windows", "android", "ios", "浏览器", "编辑器", "播放器", "终端", "截图", "截屏", "录屏", "笔记", "下载器", "下载工具", "密码管理", "解压缩", "压缩软件", "模拟器", "启动器", "工具箱", "远程桌面"]`);
    4. Its character count is `< 3` (ASCII) or `< 2` (CJK).
  - Inverted buckets on `CatalogMatchIndex`:
    - `by_token: HashMap<String, Vec<usize>>` (tokens from `name`, `repo`, `safe_aliases`, `registry_key` stems)
    - `by_exe_stem: HashMap<String, Vec<usize>>` (stems from cleaned native `identifiers` + `repo`)
    - `by_dir_seg: HashMap<String, Vec<usize>>` (normalized path segments from `install_dirs` + `repo`)
    - `by_publisher: HashMap<String, Vec<usize>>` (non-stopword tokens from `owner` + `publishers`)
  - Candidate retrieval for a `ScannedRawApp`: union candidate indices from `by_token`, `by_exe_stem`, `by_dir_seg`, and `by_publisher` (deduped via fixed-size bitset/stamp vec), evaluating scoring **only** on retrieved candidates!

### 4. Scoring Rules, Short-Name Gate & Fork Disambiguation (`src-tauri/src/scanner/matcher.rs`)

- Implement exact scoring per `spec.md` §3.2.2:
  1. **Native Executable / Bundle Identifier**:
     - Extract executable filename from `display_icon` (cleaned) and `install_location` (if file) + `registry_key`.
     - Exact match against curated native `identifiers` (`!is_installer_asset_identifier`): **`+0.48`** (`+0.30` if generic stem in `["app", "main", "client", "desktop", "launcher", "player", "editor", "studio", "terminal", "code", "server", "cli"]`) → push `"executable"` (or `"bundle_id"` when matched via `registry_key` / `.app` / reverse-DNS bundle ID).
     - Exact match against derived `repo` executable when curated identifiers didn't hit and `repo.len() >= 4`: **`+0.30`** → push `"executable"`.
  2. **Product Name & Safe Alias**:
     - Exact normalized match (`s_norm` or vendor-stripped `s_norm` or `registry_key` normalized == `c_name_norm` / `c_repo_norm` / curated `description_en` title): **`+0.55`** if matched string `chars().count() >= 4` (or CJK `>= 2`), else **`+0.38`** (short-name gate!) → push `"exact_name"`.
     - Else word-boundary token prefix / contiguous sub-slice match (`matched_phrase.len() >= 4`, full tokens only — e.g. `["vlc", "media", "player"]` starts with `["vlc"]` if `vlc` >= 4? Note: for 3-char `"vlc"` in `"vlc media player"`, `"vlc media player"` normalized is `c_name_norm == "vlc media player"` so `"VLC media player 3.0.21"` hits **exact_name `0.55`** directly! And `"VLC"` alone has `len == 3` → `0.38` + `vlc.exe` `0.48` = `0.86`!): **`+0.42`** (prefix tokens) or **`+0.32`** (interior contiguous tokens, `>= 5` chars) → push `"prefix_name"`.
     - Else exact normalized match against `safe_aliases`: **`+0.38`** → push `"alias"`.
  3. **Fork / Variant Mismatch Penalty (`-0.35`)**:
     - Define variant qualifier tokens (`["zstd", "zstandard", "rev", "nyanpasu", "next", "plus", "pro", "lite", "ce", "community", "fork", "mod", "patched", "portable"]` or extra trailing hyphenated tokens on `c_name`/`c_repo` when `c_name` starts with `s_norm` + `-`/` `):
     - If `cat` has a variant qualifier token (e.g. `7-zip-zstd` has `"zstd"`, `notepad-next` has `"next"`) that appears in **neither** `s_norm`, `registry_key`, `s_loc`, **nor** `s_icon`, subtract **`0.35`** so upstream `7-Zip` (`s_norm = "7-zip"`, `s_loc = "...\7-Zip"`) cannot falsely qualify as `7-zip-zstd`!
  4. **Install Directory Segment (`+0.22` standalone / `+0.10` with executable)**:
     - Split `s_loc` into normalized path components (`/` and `\`); check exact component equality against `install_dirs` segments or `c_repo_lower` (`len >= 4`, non-stopword — never substring `.contains()`!) → push `"install_dir"`.
  5. **Publisher (`+0.22`)**:
     - Strip corporate noise words (`inc`, `llc`, `ltd`, `gmbh`, `corp`, `corporation`, `foundation`, `project`, `team`, `studio`, `software`, `the`) and require exact normalized equality or full-token match (`len >= 3`) against `c_owner` or `cat.publishers` → push `"publisher"`.
  6. **Version Corroboration (`+0.05`)**:
     - Only when `(name_score > 0.0 || exe_score > 0.0)` and `same_version(&scanned.display_version, &cat.default_version)` and version stripped of `v` is not in `["1.0", "1.0.0", "0.1", "0.1.0", "0.0.1"]` → push `"version"`.

### 5. Global 1-to-1 Assignment & `ensure_import_path` Tightening

- Collect all `(score, has_exe, has_exact_name, name_len, s_idx, c_idx, reasons)` with `score >= MIN_QUALIFIED_SCORE (0.45)`, clamp `confidence = score.min(1.0)`, sort descending, and greedily lock both `used_scanned[s_idx]` and `used_cat[c_idx]`.
- In `match_unmanaged`: filter `catalog` upfront by `!managed.contains(&canonical_lookup_id(&cat.id))` and `(cat.platforms.is_empty() || cat.platforms.iter().any(|p| p.eq_ignore_ascii_case(CatalogItem::current_platform_key())))` BEFORE calling `match_apps`.
- In `scanner/mod.rs::ensure_import_path`:
  - Prefer `m.resolved_executable_path` (verified `.exists()`).
  - If `m.resolved_executable_path` is `None`:
    - If `m.scanned.install_location` is `Some(loc)` and `Path::new(unquote_path(&loc)).exists()`: keep `m` (do NOT overwrite with an unrelated drive path).
    - Only call `Self::resolve_installed_app_path(&m.name, &m.catalog_id, Some(&m.repo))` when `m.scanned.install_location` is `None` or no longer exists on disk!

## Acceptance Criteria

- [ ] `CatalogMatchIndex` unit tests verify candidate retrieval runs via inverted buckets without scanning unrelated catalog items, and `match_unmanaged` skips already-managed IDs and incompatible-platform items before disk/PE probes.
- [ ] Unit tests verify `normalize_app_title`:
  - `"Motrix 1.8.19"` → `"motrix"`
  - `"7-Zip 24.08 (x64)"` → `"7-zip"`
  - `"Mozilla Firefox (x64 zh-CN)"` → `"mozilla firefox"`
  - `"Microsoft Visual Studio Code (User)"` → `"microsoft visual studio code"` (and matches `microsoft/vscode` with `high` confidence).
- [ ] Anti-false-positive unit tests verify:
  - `Miniconda3` at `C:\Users\admin\miniconda3` scores `< 0.45` (0 match) against `minbrowser/min`;
  - `WPS Office` at `C:\Program Files\WPS Office` scores `< 0.45` against `jordanbaird/ice`;
  - `Microsoft Visual Studio IDE` (Publisher: `Microsoft Corporation`) does **not** match `microsoft/vscode`;
  - `AnyDesk`, `1Password`, `Postman`, `Mozilla Firefox` do **not** match `rustdesk`, `keepassxc`, API clients, or `floorp`;
  - Official `7-Zip 24.08 (x64)` at `C:\Program Files\7-Zip\7zFM.exe` (Publisher: `Igor Pavlov`) does **not** falsely match `mcmilk/7-zip-zstd`.
- [ ] Recall unit tests verify:
  - `"Motrix 1.8.18"` (older version, no `InstallLocation`, non-matching publisher) matches `agalwood/motrix`;
  - Localized `"思源笔记"` with `DisplayIcon = "D:\\SiYuan\\SiYuan.exe"` matches `siyuan-note/siyuan`;
  - `AppMatchResult.match_reasons` contains accurate reason tags (`"exact_name"`, `"executable"`, `"publisher"`, etc.).
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml` pass cleanly.
