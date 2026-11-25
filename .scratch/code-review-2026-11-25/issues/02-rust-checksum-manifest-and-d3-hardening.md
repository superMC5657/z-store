# Issue 02: Rust Checksum Manifest Resolution & D3 Integrity Hardening

Status: resolved
Severity: High (F-05 [High])
Fix Track: Track 1 (`fix-rust-security`)
Findings: F-05

## Findings

### F-05 [High]: Checksum manifest resolution breaks D3 integrity verification
- **Locations**:
  - `src-tauri/src/github/detail_fetch.rs:979-1051`
  - `src-tauri/src/github/detail_assets.rs:241-255`
- **Trigger**:
  1. `detail_fetch.rs:990` matches any release asset containing `"checksum"` or `"sha256"` without excluding binary/archive extensions or bounding `res.text()` (`detail_fetch.rs:1032`), causing assets like `sha256sum-win.exe` or `checksum-cli.zip` to be downloaded unboundedly into RAM as text.
  2. `detail_fetch.rs:996` executes `break` on the first eligible asset. In per-asset `.sha256` releases where `app-darwin.zip.sha256` precedes `app-win.msi.sha256`, `"zip"` hits `WIN_HINTS` first (`detail_assets.rs:242`), fetching only the darwin hash and leaving the Windows `.msi` with `sha256: None`.
  3. `checksum_asset_platform_eligible` (`detail_assets.rs:241-255`) hardcodes Windows hints and rejects `linux`/`mac`/`dmg`/`appimage`/`deb`/`rpm`/`aarch64`/`arm64`/`darwin` regardless of host OS/arch.
  4. The line parser (`detail_fetch.rs:1039-1048`) ignores single-token `.sha256` files (`parts.len() == 1`), fails to strip `./` or subdirectory prefixes (`dist/foo.exe`), splits filenames containing spaces, and omits 64-character `is_ascii_hexdigit()` validation.
- **Impact**: Violates CONTEXT D3 / ADR-0004 ("manifest 有值强校验"): valid official checksums silently degrade to `completed_unverified` across per-asset `.sha256` releases, macOS/Linux/ARM64 hosts, and prefixed/spaced manifests; matching binary assets risk unbounded memory usage.

## Acceptance Criteria

- [ ] Exclude binary/archive extensions (`.exe`, `.msi`, `.dmg`, `.deb`, `.rpm`, `.AppImage`, `.zip`, `.tar.*`, `.7z`, `.apk`, etc.) from checksum manifest candidates.
- [ ] Cap fetched manifest body reads to a safe byte bound (e.g., 1 MiB via streaming/bounded read) instead of unbounded `res.text()`.
- [ ] Determine platform eligibility dynamically from runtime `cfg!(target_os)` and `cfg!(target_arch)` instead of hardcoded Windows hints.
- [ ] Support fetching matching per-asset `<asset>.sha256` files alongside aggregate manifests (`checksums.txt`, `SHA256SUMS`, etc.) without prematurely `break`ing on the first eligible asset.
- [ ] Parse 1-token `.sha256` files by inferring the target asset filename from the `.sha256` asset name; strip leading `./` and directory prefixes; preserve filenames with spaces; validate exactly 64 ASCII hex digits.
- [ ] Comprehensive unit tests cover binary exclusion, size cap, per-asset `.sha256` + aggregate manifests, OS/arch filtering, 1-token files, `./`/subdir prefixes, spaced filenames, and invalid hex rejection; `cargo test` and `cargo clippy --all-targets` pass.

## Comments

- **Resolved in `65ce95d`** (Track 1 `fix-rust-security`: `fix(rust-core): harden security, checksums, star lists, proxy, and 401 handling`).
- Updated `github/detail_fetch.rs` and `github/detail_assets.rs` to exclude binary/archive extensions from manifest candidates, bound manifest reads, filter by runtime `cfg!(target_os)`/`cfg!(target_arch)`, support per-asset `.sha256` alongside aggregate manifests, normalize `./`/subdir prefixes, preserve spaced filenames, parse 1-token `.sha256` files, and validate 64 ASCII hex chars (F-05) with regression tests.
- **Integrated verification on `main`**: `cargo test` 875 passed / 3 ignored, `cargo clippy --all-targets` 0 warnings.
