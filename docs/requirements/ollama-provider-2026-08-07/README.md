# A Local Model Claude Code Can Actually Talk To

Version: 1.0.0

## Purpose

Let a project run Claude Code against the local Ollama model the same way it
already runs against GLM, Kimi or DeepSeek — by picking a provider in Telegram,
with nothing changed outside that project's own launch.

## Status

`spec ready` — written 2026-08-07, after an attempt to reach the same goal with
an off-the-shelf router broke every Claude Code session on the host. That
incident is not background colour; it is the constraint this document is built
around.

| Question | Answer | Source |
|---|---|---|
| Is there a custom-provider slot already? | Yes — `custom`, deliberately open-ended | `bot/providers/presets.ts:87-94` |
| How does a provider reach Claude Code? | Per-process env, evaluated at launch | `scripts/resolve-provider-env.ts:46-75`, `scripts/run-cli.sh:58-60` |
| Can Ollama be pointed at directly? | No — Claude Code sends Anthropic `POST /v1/messages`; Ollama has no such route | `bot/providers/presets.ts:75-78` records the same trap for OpenRouter |
| Does the local model support tools? | Yes — `capabilities: ["completion","tools","thinking"]` | `POST /api/show` on `geekom-model-1`, Ollama 0.31.2 |
| How big is its window? | 40 960 tokens (`qwen3.context_length`) | same call |
| Is there a place for a host-side daemon? | Yes — `admin-daemon` is started this way and heartbeats to `process_health` | `cli.ts:1464-1478`, `memory/db.ts:452-467` |

## What went wrong on the first attempt

`claude-code-router` was installed at 16:45 on 2026-08-07. Its installer wrote
into the **global** `~/.claude/settings.json`:

```json
"apiKeyHelper": "~/.claude-code-router/bin/ccr-claude-code-api-key-...",
"env": {
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:3456",
  "ANTHROPIC_API_BASE_URL": "http://127.0.0.1:3456",
  "CLAUDE_AGENT_API_BASE_URL": "http://127.0.0.1:3456",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
}
```

That file is machine-wide. Every Claude Code session on the host — not the one
experimenting — started pointing at a proxy that was not up, and none of them
started. Restoring `settings.json` was not sufficient on its own:
`~/.claude/cache/gateway-models.json` kept a phantom model id
(`anthropic/claude-ccr-<hex>`) and a dead base URL.

The lesson is a requirement, not a caution: **the blast radius of selecting a
provider must stay inside the project that selected it.** helyx's existing
design already has that property, and nothing added here may take it away.

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, established facts, the failed attempt |
| [prd.md](prd.md) | Problem, the translation, the daemon, acceptance, risks |
| [prd-review.md](prd-review.md) | The PRD checked against the code it cites — twelve citations verified, four findings folded back in |
| [code-review.md](code-review.md) | Review of the implementation — five defects, four of them silent, all fixed on the branch |
| [field-trial.md](field-trial.md) | The measured run on real hardware — the translation works, the CPU does not carry it, with the numbers |

## The proposal in one paragraph

Write the translator into this repository as a host-side bun daemon that accepts
Anthropic `POST /v1/messages` on loopback and speaks Ollama's `/api/chat` on the
other side, mapping tool calls in both directions and streaming back in
Anthropic's own SSE event order. Register it as an ordinary row in `providers`,
so a project selects it from `/providers` exactly like DeepSeek and gets it
through the same per-process env. Start it beside `admin-daemon` and let it
heartbeat into `process_health`, so `/monitor` says whether it is up instead of
a session failing with an opaque connection error. Nothing writes to
`~/.claude/settings.json`, ever.
