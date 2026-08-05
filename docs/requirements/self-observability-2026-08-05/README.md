# Self-Observability

Version: 1.0.0

## Purpose

Make the system notice its own failures. Everything in this package is a defect
that ran for days or weeks in production and was found by a person looking, not
by the monitoring that exists — which watches containers, the queue and session
heartbeats, and nothing the bot itself says.

## Status

`spec ready` — four defects, all diagnosed against the running system on
2026-08-05. Three of them (D1–D3) have no code at all.

The fourth, D4 — a send that lands outside its forum topic — has a fix written
and tested in the working tree and **not deployed**: `services/forum-service.ts`
needs a bot rebuild and `channel/telegram.ts` is loaded by the channel
subprocesses on the host, so it reaches production only after a session bounce.

Evidence for each defect is recorded in [prd.md](prd.md) §2 with the file and
line it was read from; no claim here rests on inference.

**Merged, not deployed** (2026-08-05). Every flow in this package is squash-merged
into `main`; none of it is running. The bot container and the channel
subprocesses still carry the pre-programme code, and the status here stays
`spec ready` until a rebuild and a session bounce make it true — the vocabulary
in [`../roadmap.md`](../roadmap.md) reserves `implemented` for deployed code,
and this programme spent a flow (034) on exactly that distinction.

Flows: 027 (D4), 028 (D1), 029 (D3), 030 (D2) — PRs #62, #64, #65, #66.

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, scope |
| [prd.md](prd.md) | Problem, evidence per defect, requirements, success criteria, risks |
| [specification.md](specification.md) | Two new supervisor loops, alert contracts, acceptance criteria |

## Scope

In scope:

- **D1** — `extractFactsFromTranscript` resolves a host path inside the
  container and has therefore never run. 4136 warnings in `logs/bot.log`.
- **D2** — nothing watches the bot's own error stream. Three distinct
  repeating defects accumulated in one day and all three were found by hand.
- **D3** — `collectSystemSnapshot` lists containers with `docker ps`, without
  `-a`, so an exited container is invisible to the health analyst. The status
  broadcast fixed exactly this in flow 004; the second copy was not touched.
- **D4** — a send into a deleted forum topic is accepted by Telegram, lands in
  General, and reported success. Fix written, not deployed.

Out of scope, and why:

- Rewriting the supervisor's existing loops. D2 and D3 add to them; they do not
  restructure them.
- Alert routing, escalation policy and acknowledgement — those exist and work
  (`sendAlertWithButtons`, the 🔕 acknowledge window).
- Log shipping to an external system. The bot already writes structured JSONL
  to `logs/bot.log`; the gap is that nobody reads it, not where it is stored.
- Test coverage of the supervisor — that is
  [io-layer-coverage-2026-08-05](../io-layer-coverage-2026-08-05/README.md).

## Related Modules

| Area | Path | Relevance |
|------|------|-----------|
| Supervisor loops | `scripts/supervisor.ts` | Where the two new loops belong |
| Host daemon | `scripts/admin-daemon.ts` (`startSupervisor`, line 140) | Starts the loops |
| Fact extraction | `memory/summarizer.ts:430` | D1 — the function that never runs |
| Stop hook caller | `mcp/server.ts:670` | D1 — passes the host path |
| Path translation | `utils/transcript-locate.ts:64` (`claudeConfigRoot`) | D1 — the fix already exists as a function |
| Container snapshot | `scripts/supervisor.ts:1116` | D3 — `docker ps` without `-a` |
| Status broadcast | `scripts/supervisor.ts:655` | D3 — the same question answered correctly |
| Channel transport | `channel/telegram.ts` | D4 — every channel send passes through it |
| Bot log | `logs/bot.log` | D2 — the stream to be watched |
