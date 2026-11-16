# AGENTS.md

Guidance for coding agents working in this repository.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Ecosystem Repositories

- **Catalog (`superMC5657/z-store-catalog`)**: Manifest source in `src-tauri/config.toml` (`[catalog].default_source_url`), offline fallback `catalog.json` (ADR-0009).
- **Launchpad (`superMC5657/z-store-launchpad`)**: Manifest source in `src-tauri/config.toml` (`[launchpad].default_source_url`), snapshot in `launchpad_feed_cache`, never written into catalog tables (ADR-0029). Repository scaffold lives in `docs/launchpad-repo-kit/`.
- **Website (`superMC5657/z-store-web`)**: Local repo at `z:\web_workplace\z-store-web`. Live demo build in `vite.demo.config.ts`.

## Rules

- Don't use `find` on Windows; where you would use `find`, use `fd` instead.
- Always pass an explicit path to `rg` (e.g., `rg -n "pattern" .`).
- Docs and comments: describe what it does now, not change history; explain why only when non-obvious.
- Counts in the UI follow `docs/count-display.md`: a number attached to a label is `<CountBadge>`; never `Label ({{count}})` copy or a per-view count class. `countDisplay.test.ts` enforces this.

### IPC Naming Convention

- Frontend request keys MUST be camelCase (`appId`, `forceRefresh`, `perPage`, `cacheKey`, `payloadJson`); backend Rust params stay snake_case bridged by `#[tauri::command(rename_all = "camelCase")]`; single-word params are exempt.
- Response/event struct fields use snake_case on both sides; keep this distinct from the request-key rule.
- Demo mock MUST be camel-only (no snake fallback in `argStr`/`argNum`); `ipcArgsNaming.test.ts` enforces `/^[a-z][a-zA-Z0-9]*$/` on all `tauriInvoke` args, `noDirectInvoke.test.ts` is recursive and bans views importing `api/client`.

## Workflow Overrides
- When executing `/implement` or `/implement-spec`, stop immediately after all tests pass and changes are committed.
- **DO NOT** run the built-in `code-review` phase or spawn review subagents at the end of `/implement`. I will run `/code-review` manually in a fresh session.
