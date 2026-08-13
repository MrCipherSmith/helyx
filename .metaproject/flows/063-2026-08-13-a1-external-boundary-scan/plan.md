# Implementation Plan

Status: draft
Source: `docs/requirements/keryx-adoption-2026-08-12/implementation-plan.md` §A1,
specification §A1 (integration points, verdict→behaviour mapping, config shape).

## Approach

One scan helper, five call sites, a config record, a posture surface, a test file.
Enabled from the first commit with fallbacks in place — fail-closed here costs a
locally-synthesised voice or one skipped reviewer, never a reply, so there is no
soft-launch question. The exclusion test is written **first**, before any scanning
code, so the boundary of this area is enforced from commit one rather than after
the first mistake.

## Steps

1. **Exclusion test first (AC1/AC2).** Assert `reply` on `channel/tools.ts` and
   `mcp/tools.ts` invokes no scanner; assert an AWS-key-shaped reply still reaches
   Telegram unchanged. Written before scanning code exists.
2. **Scan helper.** Spawn `keryx security check-output --json --target external`,
   feed payload on stdin, parse verdict. Read `gate` and `action`; ignore exit
   code entirely (AC8). Assert returned `target` reads back `external` (AC9).
3. **Failure = "scan unavailable" (AC7).** Parse failure, spawn failure, timeout,
   and missing binary all return one shared "unavailable" result that takes the
   crossing's local fallback. Never withholds a reply.
4. **E1 — `utils/tts.ts`.** Scan before Yandex (`:307`), Groq (`:329`), OpenAI
   (`:356`); on a finding or a failure fall through to local `piper` (`:8-9`) and
   record the substitution (AC3).
5. **E3 — `utils/aux-llm-client.ts`.** Scan outbound at `:28`/`:34`; scan the
   returned completion as `untrusted-external` before it reaches a session or
   memory (AC5); skip entirely for the local Ollama URL at `:31` (AC6).
6. **E4 — `services/reviewer-service.ts` / `scripts/review.ts`.** Scan the diff
   before it goes out (AC4) and the report before it comes back in (AC5).
7. **E5 — `services/provider-service.ts`, `claude/client.ts`.** Same, for
   non-local providers only (Anthropic-direct is still external).
8. **E2 — `utils/transcribe.ts`.** Posture, not payload: remote transcription
   becomes an explicit opt-in whose state is visible from a status surface (AC10).
9. **Config + surface.** Config per `schemas/external-boundary-policy.schema.json`
   (scanning on for every crossing, local fallback preferred, operator channel
   permanently excluded and not configurable); findings surfaced through
   `mcp/dashboard-api.ts`; TTS/transcription posture visible from status (AC10).
10. **Latency (AC11).** Measure added latency on the crossings only; the operator
    path is untouched and unmeasured (M1).

## Verdict → behaviour (specification §A1)

- `allow` → send/accept. `warn` → send/accept + record. `redact` → send/accept
  the redacted form. `require-approval` outbound → downgrade to fallback (never
  hold a conversational path for a human); inbound → treat as `redact`.
- `block` or scan-failed → do not cross; use the local fallback (E1 → piper;
  E3/E4/E5 → refuse that external call and say so at the call site; E2 → refuse
  transcription, tell the operator once). Never costs a reply.

## Risks

- **Silent no-op control.** The exit-code trap (keryx exits `0` on block) means a
  naive `if keryx …; then` integration never fires while looking healthy. Pinned
  by AC8. The `--target` degradation to `unknown` is pinned by AC9.
- **False positives** on E4 payloads (diffs, reviewer reports — where token-shaped
  strings in ordinary content live). Measured before merge (M1.3); a noisy rule
  becomes a recorded exception, never a disabled scanner.
- **Deployment drift.** `utils/**` changes reach existing sessions only after
  `bounce`/restart. Flagged to the operator; no restart without go-ahead.

## Tasks

T1 context · T2 exclusion test + scan helper · T3 wire E1/E3/E4/E5 + E2 posture +
config/surface · T4 tests A1.1–A1.11 green + self-review + PR.
