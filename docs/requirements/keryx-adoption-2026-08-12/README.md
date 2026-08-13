# Adopting keryx Patterns into helyx

Version: 1.1.0

## Purpose

keryx and helyx solve overlapping problems from opposite ends. helyx is a
Telegram-fronted operator harness that drives real Claude Code sessions in tmux;
keryx is a project-context CLI that grew its own agent harness with a policy
engine, a session store, an OS sandbox, and an egress scanner. Each has built
something the other only has as prose.

This package records what helyx takes from keryx, area by area, with the status
of both sides stated honestly, so that the borrowing is a decision with a
rationale rather than a copy that nobody can later justify.

The traffic already runs the other way. keryx's
[agent-connectors package](#sources-in-keryx) names helyx by URL as the
reference for driving a vendor's own client as a subprocess — "a bridge, not a
token theft". This package is the return leg.

## Status

`draft` — written 2026-08-12 from a read of keryx at `af380a6a` (v0.2.16).

No adoption area below is implemented in helyx as an area. Two of A5's four
perimeter rules turned out to hold already, discovered while writing rather than
assumed — they are carried as regression pins, not as work.

On the keryx side: three areas (A1, A2, A3) are backed by code that exists and
runs in keryx; two (A4, A5) are backed by keryx specification documents that
keryx itself has not implemented. The distinction is carried in every document
here and must not be smoothed over: see [prd.md](prd.md) §Evidence Grades.

## The line this package does not cross

**The operator's conversation with their own sessions is never scanned, gated,
or held.** Replies, instructions and permission prompts between the operator and
a session are inside the trust boundary. Version 1.0.0 put a fail-closed scan
exactly there and led with it; version 1.1.0 removes it and says why in
[prd.md](prd.md) §P1. Controls in this package guard the boundary with the
outside world and the actions that can break the operator's machine — not the
channel the operator uses to work.

## Scope

Five adoption areas, in implementation order:

| ID | Area | keryx side | helyx side today |
|---|---|---|---|
| A2 | Approval bound to an action fingerprint, single-use; `ask` with no approver becomes `deny` | implemented (`src/harness/policy/engine.ts`) | a restart mutex (`utils/restart-lease.ts`) and a broad `perm:always:` grant |
| A1 | Scanning the boundary with the external world — the five places helyx content leaves for a service the operator does not control | implemented (`src/security/`, `keryx security check-output`); the *scoping* is helyx's own | absent — a project diff reaches DeepSeek unexamined while the operator's own prompt is scanned |
| A3 | Session split: model window vs append-only archive; compaction that cannot delete evidence | implemented (`src/session/store.ts`, `src/session/compact.ts`) | Claude Code's `compact_boundary` is written and read by nothing |
| A4 | Connector ≠ provider: an engine registry entry with launch command, transport and context strategy | specified, not implemented (`docs/requirements/keryx-agent-connectors/`) | the same seam is felt but unnamed in `codex-session-engine-2026-08-09` |
| A5 | Telegram perimeter: per-sender auth, unmapped topic is a refusal, secrets never travel through Telegram, approval callbacks are opaque and single-use | specified, not implemented (`docs/requirements/keryx-telegram-transport/`) | **two of four already hold** — per-sender auth (`bot/access.ts:19`) and inbound topic refusal (`bot/text-handler.ts:178-184`); secrets and callbacks do not |

## Non-goals

- Depending on keryx as a runtime library. helyx already invokes the `keryx`
  CLI (`keryx ctx rg`, the `security check-input` hook); this package proposes
  one further CLI call (A1) and otherwise borrows designs, not imports.
- Replacing helyx's session engine with keryx's harness. keryx's own harness
  documentation states that no shipped path registers a tool and that
  `keryx harness run` and `keryx serve` are single text turns today. helyx's
  Claude Code sessions run real tools; that is not a trade helyx would win.
- Re-specifying `codex-session-engine-2026-08-09`. A4 is a **delta** against
  that package — vocabulary and credential decisions it lacks — not a rival
  design for the same problem.
- Extracting or replaying subscription OAuth tokens. See
  [policies.md](policies.md) §P-4 for the boundary helyx inherits.
- Any implementation. This package is requirements only; nothing here changes
  behaviour until a flow picks an area up.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This file: purpose, status, scope, non-goals, index. |
| [prd.md](prd.md) | Problem, users, evidence grades, requirements per area, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Per-area design: integration points, data contracts, config shape, acceptance criteria. |
| [policies.md](policies.md) | The policy rules A1, A2 and A5 introduce, stated as enforceable sentences. |
| [implementation-plan.md](implementation-plan.md) | Sequencing, dependencies, and what each area costs. |
| [metrics-and-validation.md](metrics-and-validation.md) | How each area is measured and what evidence closes it. |
| [schemas/external-boundary-policy.schema.json](schemas/external-boundary-policy.schema.json) | Per-crossing config for the external boundary (A1). |
| [schemas/action-approval-grant.schema.json](schemas/action-approval-grant.schema.json) | Fingerprint-bound single-use approval (A2). |
| [schemas/engine-connector-entry.schema.json](schemas/engine-connector-entry.schema.json) | Engine/connector registry entry (A4). |

## Related modules in helyx

- `utils/tts.ts:307` (Yandex), `:329` (Groq), `:356` (OpenAI) and `:8-9` (local
  `piper`) — crossing E1 and its fallback.
- `utils/transcribe.ts:46` — crossing E2, the operator's voice going to Groq.
- `utils/aux-llm-client.ts:28`, `:34`, and `:31` (local Ollama, exempt) —
  crossing E3.
- `services/reviewer-service.ts`, `scripts/review.ts` — crossing E4.
- `services/provider-service.ts`, `claude/client.ts` — crossing E5.
- `channel/tools.ts:376`, `mcp/tools.ts:380` — the operator channel. Named here
  only to record that A1 does **not** touch it, and that a test enforces this.
- `utils/restart-lease.ts`, `scripts/admin-daemon.ts` (`claimRestart` defined
  at :342, called at :416, :494, :522) — the mutex A2 sits above.
- `utils/permission-render.ts:46-48`, `utils/callback-route.ts`,
  `services/permission-service.ts` — the approval surface A2 and A5 change.
- `bot/access.ts` — per-sender authorization, already present; A5 narrows to
  what is missing around it.
- `bot/text-handler.ts:81-84`, `:96-106`, `:178-184` — inbound topic routing;
  already refuses an unmapped topic, pinned rather than changed by A5.
- `channel/tools.ts:397-404`, `services/forum-service.ts` — the outbound half of
  the same rule, which does not yet match.
- `bot/commands/providers.ts`, `services/provider-service.ts`,
  `bot/providers/presets.ts` — the registry A4 extends with an engine axis.
- `docs/requirements/codex-session-engine-2026-08-09/` — the package A4 is a
  delta against.
- `channel/status.ts`, `utils/context-usage.ts` — where A3's compaction record
  would be read.

## Sources in keryx

Read at commit `af380a6a`, `/home/altsay/keryx`:

- `docs/docs/harness.md` — the harness tour: providers, sessions, policy engine,
  sandbox, evidence and redaction, completion gate, record/replay.
- `src/harness/policy/` (`engine.ts`, `profiles.ts`, `ranks.ts`) — A2's source.
- `src/session/` (`store.ts`, `compact.ts`, `paths.ts`) — A3's source.
- `src/security/` (`redact.ts`, `harness-scan.ts`, `service.ts`) and
  `keryx security check-output` — A1's source.
- `docs/requirements/keryx-agent-connectors/` — A4's source, including decisions
  C-01…C-08.
- `docs/requirements/keryx-provider-auth/decisions.md` — decision D-01, the
  compliance boundary A4 inherits.
- `docs/requirements/keryx-telegram-transport/` — A5's source.
- `docs/requirements/keryx-remote-entry/` — the transport-neutral entry
  keryx's Telegram transport is a client of; context for A5.
