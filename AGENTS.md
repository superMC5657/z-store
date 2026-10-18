# AGENTS.md

Guidance for coding agents working in this repository.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Rules
Don't use `find` on Windows; where you would use `find`, use `fd` instead.
Docs and comments: describe what it does now, not change history; explain why only when non-obvious.

### IPC Naming Convention

- Frontend request keys MUST be camelCase (`appId`, `forceRefresh`, `perPage`, `cacheKey`, `payloadJson`); backend Rust params stay snake_case bridged by `#[tauri::command(rename_all = "camelCase")]`; single-word params are exempt.
- Response/event struct fields stay snake_case on both sides for now (serde untouched); do NOT mix this with the request-key rule.
- Demo mock MUST be camel-only (no snake fallback in `argStr`/`argNum`); `ipcArgsNaming.test.ts` enforces `/^[a-z][a-zA-Z0-9]*$/` on all `tauriInvoke` args, `noDirectInvoke.test.ts` is recursive and bans views importing `api/client`.
