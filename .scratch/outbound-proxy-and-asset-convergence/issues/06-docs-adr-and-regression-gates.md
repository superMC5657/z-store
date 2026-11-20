# Issue 06: Record ADR-0025, Sync Domain Docs (`CONTEXT.md` & ADRs), and Run Full Regression Gates

Status: resolved
Blocked by: 01, 02, 03, 04, 05

## Summary

Record the architectural decisions in `docs/adr/0025-dynamic-system-proxy-and-asset-cache-convergence.md`, update cross-referenced ADRs (`ADR-0002`, `ADR-0008`, `ADR-0011`) and `CONTEXT.md` so all domain documentation reflects current system behavior in present tense, and execute the full Rust + Frontend verification suite.

Per `AGENTS.md`:
> Docs and comments: describe what it does now, not change history; explain why only when non-obvious.

## Scope

- `docs/adr/0025-dynamic-system-proxy-and-asset-cache-convergence.md` (new)
- `docs/adr/0002-direct-github-api-and-mirror-pipeline.md`
- `docs/adr/0008-outbound-proxy-oauth-hardening-and-settings-restructure.md`
- `docs/adr/0011-doforce-trends-aggregator-exception.md`
- `CONTEXT.md`

## Implementation Details

### 1. Author `docs/adr/0025-dynamic-system-proxy-and-asset-cache-convergence.md`

Document the accepted architecture concisely:
- **Dynamic System Proxy Snapshot (`ProxySnapshot`)**: Cross-platform live OS proxy probing (Windows Registry `ProxyEnable` + `ProxyServer` + `ProxyOverride`, Linux GNOME `gsettings` `manual` + `ignore-hosts`, macOS `scutil --proxy` + `ExceptionsList`, preceded by immutable startup external env capture), 5s cache TTL + transport-error invalidation, zero `std::env::set_var` mutation, and signature-keyed hot-reload across isolated API, Icon CDN, Catalog, and Downloader `reqwest::Client` pools.
- **Mirror vs System-Proxy Orthogonality**: `no_proxy` bypasses only actual mirror hosts (`gh-proxy.com` or custom mirror domain), never upstream forge hosts (`github.com`, `codeberg.org`, etc.) when `active_mirror = "direct"`; official default `catalog.json` falls back to active mirror / `gh-proxy.com` on transport/5xx failure with strict JSON & `Canonical App Id` validation, while `Checksum Manifest` (`checksums.txt`) stays strictly direct/system-proxied (6s timeout) to preserve D3 anti-tampering.
- **Trend `doforce` Routing**: Direct-first (5s) with automatic single retry via active system proxy on transport/timeout/5xx failure, zero credentials attached.
- **Frontend Asset & Icon Convergence**: `fetch_or_cache_asset_url` returns `data:<mime>;base64,...` URIs bridging README (including `<= 5 MB` `.gif`) and `ChangelogDrawer` without duplicate WebView pre-requests; `<AppIcon>` uses backend-first single-flight in real Tauri runtime; GitHub user/developer avatars route through `<CachedAvatar>` with local disk caching and initials fallback.

### 2. Update existing ADRs & `CONTEXT.md`

- **`docs/adr/0002-direct-github-api-and-mirror-pipeline.md`**: Update §1 to reflect that official default `catalog.json` supports mirror fallback on direct/proxy failure (referencing ADR-0025), while `checksums.txt`, API, README text, icons, and custom catalog sources remain strictly non-mirrored.
- **`docs/adr/0008-outbound-proxy-oauth-hardening-and-settings-restructure.md`**: Update §1 & §2 to describe live cross-platform `ProxySnapshot` hot-reloading (Windows/Linux/macOS, no `env::set_var`), mirror-only `no_proxy` bypass, and `trend.doforce.dpdns.org` direct-first with proxy fallback (referencing ADR-0025).
- **`docs/adr/0011-doforce-trends-aggregator-exception.md`**: Reflect direct-first + system-proxy fallback on `trend.doforce.dpdns.org` while maintaining the unauthenticated trust boundary.
- **`CONTEXT.md`**:
  - Update **D2**, **D5**, and **D10** (and glossary entries `加速镜像节点` / `下载加速代理` / `清单同步` / `统一图标获取` where applicable) in present tense to match the implemented behavior.

### 3. Execute all verification gates

- Rust backend compilation, clippy, and full test suite:
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
  - `cargo test --manifest-path src-tauri/Cargo.toml`
- Frontend TypeScript check, architectural guard tests, and full Vitest suite:
  - `npx tsc --noEmit`
  - `npx vitest run` (confirming `ipcArgsNaming.test.ts`, `noDirectInvoke.test.ts`, `countDisplay.test.ts`, `cmdAlignment.test.ts`, and Demo build compatibility `npx vite build --config vite.demo.config.ts`).

## Acceptance Criteria

- [x] `docs/adr/0025-dynamic-system-proxy-and-asset-cache-convergence.md` is created and `ADR-0002`, `ADR-0008`, `ADR-0011`, and `CONTEXT.md` are consistent with zero contradictions or changelog-style history prose.
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` passes cleanly.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passes with 0 failures.
- [x] `npx tsc --noEmit`, `npx vitest run`, and `npx vite build --config vite.demo.config.ts` all succeed with 0 errors.

## Comments

- 2026-11-14 (agent): 已落地：新增 ADR-0025；ADR-0002 §1、ADR-0008 §1–§2、ADR-0011 决策 1 与信任边界、CONTEXT.md（词汇表 加速镜像节点 / 清单同步 / 下载加速代理，D2 / D5 / D9 / D10）、README 网络行同步。门禁结果见会话汇报。
