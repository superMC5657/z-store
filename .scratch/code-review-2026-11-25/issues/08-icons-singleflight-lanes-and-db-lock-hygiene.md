# Issue 08: Icons Singleflight, Lane Precedence & SQLite Lock Hygiene

Status: resolved
Severity: High (F-12 [High], F-15 [Medium], F-18 [Medium], F-22B [Medium])
Fix Track: Track 3 (`fix-rust-storage`)
Findings: F-12, F-15, F-18, F-22B

## Findings

### F-12 [High]: `FlightGuard::drop` removes in-flight singleflight key on waiter cancel, racing `.part` temp writes
- **Locations**:
  - `src-tauri/src/icons/singleflight.rs:65-75`
  - `src-tauri/src/github/asset_fetch.rs:488-506`
- **Trigger**: Caller A joins `Flights::join(key)` (`ICON_CACHE_FLIGHTS` or `ASSET_FLIGHTS`) and begins downloading; Caller B joins the same `key` (`Arc<OnceCell>` clone) and cancels/drops first. `FlightGuard::drop` observes `Arc::ptr_eq(existing, &self.cell) == true` and removes `key` from the map while Caller A is still in-flight. Caller C then joins `key` and starts a duplicate concurrent download.
- **Impact**: Violates CONTEXT D10 singleflight deduplication. In `asset_fetch.rs:499-504`, Callers A and C write concurrently to the same `cache/tmp/{stem}.part` path and race on `std::fs::rename`, risking truncated/corrupted cached assets or spurious rename failures.

### F-15 [Medium]: `record_stream_hit_with` emits raw probed `(url, level)` instead of merged `(cycle.selected_url, cycle.level)`
- **Locations**:
  - `src-tauri/src/icons/lanes.rs:92-140`
- **Trigger**: An app has `cycle.pinned == true` or a cataloged L1 icon (`keep_cataloged && !cycle.l1_url.is_empty()`), and a background lane probes an L2/L3/L4 icon. `merge_stream_hit` preserves `cycle.selected_url` and line 133 syncs `repo_card_cache` with `cycle.selected_url`, but line 139 emits `icon_ready_payload(job, url, level, via)` with the raw probed `(url, level)`.
- **Impact**: Violates CONTEXT D10 slot precedence: live frontend overwrites user-pinned or cataloged L1 icons with lower-priority probed icons until reload.

### F-18 [Medium]: `icons::get_or_fetch_icon` bypasses `ICON_CACHE_FLIGHTS` singleflight and holds `state.db()` across sync disk writes
- **Locations**:
  - `src-tauri/src/icons/mod.rs:865-990` (exposed by `src-tauri/src/commands/icons.rs:7-12`)
- **Trigger**: Concurrent UI calls to `get_or_fetch_icon` for the same uncached `remote_url` do not join `ICON_CACHE_FLIGHTS` (unlike `cache_icon_url_shared`), causing duplicate downloads, concurrent non-atomic `std::fs::write`/`remove_file` on the same icon file, and holding `state.db()` (line 943) across `write_icon_file` (lines 946, 961).
- **Impact**: Violates CONTEXT D10 ("后端单飞落盘"); risks corrupted icon files and stalls concurrent SQLite commands during disk I/O.

### F-22B [Medium]: `get_similar_apps` holds `state.db()` across sync disk icon reads + base64 encoding
- **Locations**:
  - `src-tauri/src/commands/catalog_detail.rs:184-195`
- **Trigger**: Synchronous command `get_similar_apps` holds `state.db()` across `resolve_confirmed_icon_from_db` disk reads and base64 encoding in a loop, instead of separating DB queries from lock-free filesystem reads.
- **Impact**: Stalls concurrent DB-backed commands while detail modal loads similar apps.

## Acceptance Criteria

- [ ] `FlightGuard::drop` in `icons/singleflight.rs` removes the key from the map ONLY when no other holders remain (e.g., `Arc::strong_count(existing) == 2` inside the map mutex or explicit owner token); `asset_fetch.rs::persist_asset_bytes` writes to a unique `{stem}.{nonce}.part` temp file before atomic rename.
- [ ] `icons/lanes.rs::record_stream_hit_with` captures merged `(cycle.selected_url, cycle.level)` under the DB lock and skips emitting when `was_pinned` or `selected_url` did not change; otherwise emits the merged `(selected_url, selected_level)`.
- [ ] `icons/mod.rs::get_or_fetch_icon` routes uncached icon fetches through `ICON_CACHE_FLIGHTS` singleflight and performs synchronous disk writes outside the `state.db()` lock.
- [ ] `commands/catalog_detail.rs::get_similar_apps` releases `state.db()` before disk icon reads and base64 encoding.
- [ ] Unit/regression tests cover waiter cancellation preserving active flight (F-12), pinned/L1 lane precedence (F-15), `get_or_fetch_icon` singleflight/lock-free writes (F-18), and `get_similar_apps` behavior (F-22B); `cargo test` and `cargo clippy --all-targets` pass.

## Comments

- **Resolved in `b48b4da`** (Track 3 `fix-rust-storage`: `fix(storage,oauth,icons): complete OAuth private cache purge, import validation, and singleflight/lock safety`).
- Fixed `FlightGuard::drop` strong-count check in `icons/singleflight.rs` and unique `.part` temp files in `github/asset_fetch.rs` (F-12); emitted merged `(cycle.selected_url, cycle.level)` and respected pinned/unchanged slots in `icons/lanes.rs` (F-15); routed `icons::get_or_fetch_icon` through `ICON_CACHE_FLIGHTS` with lock-free disk writes in `icons/mod.rs` (F-18); moved disk icon reads/base64 outside `state.db()` in `commands/catalog_detail.rs::get_similar_apps` (F-22B), with unit tests in `icons/tests.rs`.
- **Integrated verification on `main`**: `cargo test` 875 passed / 3 ignored, `cargo clippy --all-targets` 0 warnings.
