# Claude Code talks Anthropic, Ollama talks OpenAI — a local model nobody can select

Status: formalized
Source: user description (2026-08-07), after a failed attempt with claude-code-router

## Problem

helyx can put any project on a different backend: `/providers` registers an
Anthropic-compatible endpoint, `/projects → ⚙️` binds it to a path, and
`scripts/resolve-provider-env.ts` turns that into per-process env at launch.
Four backends are registered, all cloud.

The model on this machine cannot be reached that way. Claude Code speaks the
Anthropic Messages API; Ollama has no `/v1/messages` route. Pointing the
`custom` preset at `localhost:11434` yields 404s, not a fallback. Nothing on
this host translates between the two dialects.

An attempt on 2026-08-07 to fill the gap with `claude-code-router` wrote
`ANTHROPIC_BASE_URL` into the machine-wide `~/.claude/settings.json` and stopped
every Claude Code session on the host from starting.

## Expected Outcome

A project can select a local-Ollama provider in Telegram and run Claude Code
against it, with the selection affecting nothing outside that project's own
launch. Specifically: a host-side translating daemon in this repository,
registered as an ordinary `providers` row, off by default, visible in
`/monitor`, and touching no machine-wide Claude Code configuration.

## Out of Scope

- Images and any non-text content block; prompt caching; server-side tools.
- Auth on the proxy (loopback-only by design).
- Making the local model a default for anything, or a daily driver — at ~3-5
  tokens/second an agent step takes minutes.
- Any change to how the four cloud providers work.

Full specification: `docs/requirements/ollama-provider-2026-08-07/`.
