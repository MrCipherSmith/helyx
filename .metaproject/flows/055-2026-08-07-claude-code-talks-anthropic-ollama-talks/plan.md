# Implementation Plan

Status: ready

## Approach

Write the translator into this repository as a host-side bun daemon rather than
adopting an off-the-shelf router.

Rejected: `claude-code-router` and LiteLLM. Not because they are bad, but
because their unit of configuration is the machine while helyx's is the process.
That mismatch is what broke every session on this host on 2026-08-07: the
router's installer wrote a base URL into `~/.claude/settings.json`, and a local
experiment became a global outage. An in-repo daemon reached through an ordinary
`providers` row inherits helyx's existing blast radius — one project — and adds
no new selection mechanism.

## Steps

1. `utils/anthropic-ollama.ts` — pure translation: Anthropic request → Ollama
   `/api/chat` body, Ollama chunks → Anthropic SSE events, tool-call id mapping,
   error envelopes. No I/O, so it is unit-testable in both directions.
2. `scripts/ollama-proxy.ts` — the daemon: `Bun.serve` on `127.0.0.1`, routes
   `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, `/health`; model
   resolution with fallback; `num_ctx` from `/api/show`, cached per model;
   `process_health` heartbeat.
3. `config.ts` — `OLLAMA_PROXY_ENABLED`, `OLLAMA_PROXY_PORT`, `OLLAMA_PROXY_MODEL`.
4. `cli.ts` — `ensureOllamaProxy()` beside `ensureAdminDaemon()`, gated.
5. Tests: `tests/unit/anthropic-ollama.test.ts` for the translation,
   `tests/unit/ollama-proxy.test.ts` for routing and model resolution.
6. Docs: CHANGELOG, and the provider docs that list what can be registered.

## Risks

- 40 960-token window against Claude Code's system prompt — mitigated by sending
  the real `num_ctx`, and by scoping this as a fallback rather than a default.
- Tool-call fidelity on a 14B model — the mapping is unit-tested both ways; the
  model's `tools` capability was verified before the PRD was written.
- Streaming event order — asserted in tests, not eyeballed.
- Scope creep back toward a general router — the daemon serves exactly four
  routes and reads no global config.
