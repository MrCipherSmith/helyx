# A1: scanning the boundary with the external world

Status: draft
Source: `docs/requirements/keryx-adoption-2026-08-12/` (PRD §A1, specification §A1,
policies §A1, `schemas/external-boundary-policy.schema.json`). Second area in the
package order **A2 → A1 → A3 → A5 → A4**; A2 (flow 062) is done and merged (PR #110).

## Problem

Five places send helyx content to — or receive it from — a service the operator
does not control, and none is scanned today. The operator's own project diff
reaches a third-party reviewer model unexamined; a reviewer report or
auxiliary-model completion is fed back into a live session as untrusted text with
no redaction; the full text of a reply leaves for Yandex/Groq/OpenAI whenever the
configured voice is not local. keryx already ships the control (`keryx security
check-output`); the *scoping* to these five crossings is helyx's own.

The five crossings (specification §A1):

| # | Crossing | Direction | Code |
|---|---|---|---|
| E1 | Remote TTS (Yandex/Groq/OpenAI) | out | `utils/tts.ts:307,329,356` |
| E2 | Groq transcription | out (posture) | `utils/transcribe.ts:46` |
| E3 | Auxiliary LLM (DeepSeek/OpenRouter) | both | `utils/aux-llm-client.ts:28,34` (local Ollama `:31` exempt) |
| E4 | Reviewer models | both | `services/reviewer-service.ts`, `scripts/review.ts` |
| E5 | Session provider | both | `services/provider-service.ts`, `claude/client.ts` |

Two traps in the keryx side, verified against v0.2.16 on 2026-08-12:
- **Exit code is `0` even on `block`.** The integration must parse `--json` and
  branch on `gate`/`action`; the exit code carries no verdict (AC8).
- **`--target` must be `external`.** An unrecognised target silently degrades to
  `unknown`; helyx passes `external` and asserts it reads back (AC9).

## Expected Outcome

- A scan helper spawning `keryx security check-output --json --target external`,
  reading `gate`/`action`, ignoring exit code; a parse/spawn/timeout/missing-binary
  failure all yield one "scan unavailable" result that takes the crossing's fallback.
- Scanning wired into E1, E3, E4, E5 (outbound and, for E3/E4/E5, the inbound
  untrusted-external half); E2 becomes a visible posture, not a payload scan.
- The governing rule holds everywhere: **a finding must never cost the operator a
  message** — every crossing falls back (E1 → local `piper`; E3/E4/E5 → skip that
  external call and say so; E2 → refuse transcription once, told to the operator).
- The operator channel (`channel/tools.ts:376`, `mcp/tools.ts:380`) is provably
  never scanned, enforced by a test written before any scanning code (AC1).
- Config per `schemas/external-boundary-policy.schema.json`; findings surfaced via
  `mcp/dashboard-api.ts`; remote TTS/transcription posture visible from status.
- All of AC1–AC11 confirmed; full suite + tsc + eslint green.

## Out of Scope

- The operator channel — no scan, ever. Explicitly excluded and test-pinned.
- Reworking `perm:always:` into a bounded grant (its own package; A2 note).
- Depending on keryx as a runtime library — this is one more CLI call, not an import.
- Areas A3, A5, A4 — separate flows.

## Deployment note

E1/E2 live in `utils/**`, imported by both the container and the host channel
subprocess. Per `CLAUDE.md`, a change to a channel-imported module is live only
after `bun cli.ts bounce` or a full restart — rebuilding the bot alone leaves
existing sessions on old code. No restart happens without explicit operator go-ahead.
