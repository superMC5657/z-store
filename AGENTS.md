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

### Decision protocol

In case of business logic divergence, major architectural choices, or breaking refactoring, immediately halt all code execution and present structured options for user confirmation. Routine detail development executes autonomously. See `.agents/rules/decision-protocol.md`.

