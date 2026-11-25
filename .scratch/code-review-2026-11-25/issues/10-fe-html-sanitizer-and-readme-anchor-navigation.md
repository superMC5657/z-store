# Issue 10: Frontend HTML Sanitizer Hardening & README `#anchor` Navigation

Status: resolved
Severity: High (F-24 [High], F-25 [High])
Fix Track: Track 4 (`fix-fe-services`) + Track 5B (`fix-fe-components` for `useDetailReadme.ts`)
Findings: F-24, F-25

## Findings

### F-24 [High]: `sanitizeHtml` scheme bypass via C0/whitespace chars, inline `style` clickjacking/IP-leak, `asset:`/`tauri:` allowlist & `srcset` bugs
- **Locations**:
  - `src/utils/sanitize.ts:13, 104, 113-185`
  - Callers without `options`: `src/views/InstalledView/ChangelogDrawer.tsx:20`, `src/views/LaunchpadView/discussionFormat.ts:118`
- **Trigger**: Untrusted README, Release changelog, or public Launchpad Discussion Markdown containing `<a href="java&#x09;script:alert(1)">`, `<a href="&#x01;javascript:alert(1)">`, `<div style="position:fixed;inset:0;z-index:999999;background:url(https://attacker/px)">`, `<img src="asset://...">`, or `<a href="tauri://...">`. `attr.value.trim()` does not strip ASCII C0 controls (`\u0001`–`\u001f`) or embedded `\t`/`\n`/`\r`, so `startsWith('javascript:')` and `includes('://')` both miss, and when `options` is omitted the attribute passes verbatim. `style` only rejects substrings `expression`/`javascript:`/`behavior`. `srcset` (`:150-175`) skips `ALLOWED_PROTOCOLS` and splits `data:image/png;base64,...` on commas.
- **Impact**: XSS vector in untrusted changelog/discussion HTML (especially once F-25 removes forced `target="_blank"` on non-external links), full-window UI spoofing/clickjacking over modals/buttons, direct WebView network requests bypassing `assetCache` (IP leak), and untrusted `asset:`/`tauri:` protocol links.

### F-25 [High]: Capture-phase `browserLockdown` + forced `target="_blank"` breaks 100% of README `#anchor` links (+ unguarded `decodeURIComponent`/`querySelector`)
- **Locations**:
  - `src/utils/sanitize.ts:188-191` (Track 4)
  - `src/utils/browserLockdown.ts:212-231` (Track 4)
  - `src/components/AppDetailModal/useDetailReadme.ts:229-248` (Track 5B)
- **Trigger**: Clicking any Table-of-Contents or `#section` anchor link inside `AppDetailModal` README. `sanitizeHtml` unconditionally sets `target="_blank"` on every `<a>` (including `#...`). `initBrowserLockdown` registers a `document` capture-phase click listener that intercepts every `a[target="_blank"]`, calls `e.preventDefault(); e.stopPropagation()`, and forwards `#section` to `tauriApi.openUrl('#section')`, preventing React's bubble-phase `handleReadmeClick` from ever running. Additionally, `useDetailReadme.ts:238-242` calls `decodeURIComponent` without `try/catch` and interpolates `anchorId` into `document.querySelector('[name="${anchorId}"]')` without `CSS.escape()`.
- **Impact**: In-page README anchor/TOC navigation is completely broken in both Tauri and Demo; malformed `%` encodings or quotes throw uncaught exceptions if reached.

## Acceptance Criteria

- [ ] `src/utils/sanitize.ts` strips all ASCII C0 controls and whitespace (`[\u0000-\u0020]`) before protocol checks and enforces a positive protocol allowlist (`http:`, `https:`, `mailto:`, `#`, or safe relative URLs resolved to `http:`/`https:`).
- [ ] `data:image/*` is allowed ONLY on `img[src]`/`srcset`, NEVER on `a[href]`; `asset:` and `tauri:` are removed from allowed protocols.
- [ ] `srcset` candidates are parsed without corrupting `data:image/...;base64,...` commas and each candidate URL is validated against the image allowlist.
- [ ] Unsafe inline `style` attributes are stripped (preventing `position`, `z-index`, `inset`, `url()`, `expression()` clickjacking/IP-leak while keeping existing legitimate markdown rendering tests green).
- [ ] `sanitize.ts` does NOT add `target="_blank"` to `#` fragment links (`href.startsWith('#')`); `browserLockdown.ts` ignores `#` fragment hrefs in capture-phase click interception.
- [ ] `src/components/AppDetailModal/useDetailReadme.ts` wraps `decodeURIComponent` in `try/catch` and escapes `anchorId` with `CSS.escape` (with safe fallback when unavailable in jsdom).
- [ ] Unit/regression tests cover `java&#x09;script:`, C0 prefix, `style` clickjacking/`url()`, `asset:`/`tauri:`, `srcset`, `#anchor` click navigation, malformed `%` encodings, and quote-containing anchor IDs; `tsc` and `vitest` pass.

## Comments

- **Resolved in `1caf5dc`** (Track 4 `fix-fe-services`) and **`8004696`** (Track 5B `fix-fe-components`).
- Hardened `src/utils/sanitize.ts` against C0/whitespace scheme bypasses, unsafe inline `style`, `asset:`/`tauri:` schemes, and `srcset` parsing bugs (F-24, `sanitize.test.ts`); skipped `target="_blank"` on `#` anchors in `sanitize.ts` and ignored `#` anchors in `src/utils/browserLockdown.ts` (`browserLockdown.test.ts`, F-25); wrapped `decodeURIComponent` in `try/catch` and applied `CSS.escape` in `src/components/AppDetailModal/useDetailReadme.ts` (`AppDetailModal.readme.test.tsx`, F-25).
- **Integrated verification on `main`** (`verifier` `verdict=PASS`): `tsc` 0 errors, `vitest` 142/142 files (1497/1497 tests).
