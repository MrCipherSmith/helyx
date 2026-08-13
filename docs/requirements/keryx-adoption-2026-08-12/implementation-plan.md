# Implementation Plan: Adopting keryx Patterns into helyx

Version: 1.2.0

## Status

| Area | State | Where |
|---|---|---|
| **A2** action-bound approval | **done** — shipped 2026-08-13 | flow 062, PR #110, merged as `390f7d8` |
| **A1** external boundary | **done** — shipped 2026-08-13 | flow 063, PR #112, merged as `81487ac` |
| A3 compaction record | not started | — |
| A5 perimeter | not started | — |
| A4 engine connector | not started, and blocked | waits on `codex-session-engine-2026-08-09` choosing its path |

### Where A2 ended, and what it cost to get right

Two review rounds, both of which found something the implementation and this
plan had missed.

**Round one found the same mistake this plan had already named, on the other
side of the wall.** The gate was extended from three commands to eight and a
test was written asserting the *consumer* side was exhaustive. Four *producers*
— `/projects` → Stop, `rc:kill`, the monitor's container button, the dashboard —
still enqueued gated commands with no grant, so those features were dead on the
branch. AC19's own sentence, "a control over three of eight entrances is a
control over three entrances", is symmetric, and only one side of it had been
applied. `tests/unit/restart-gate-producer-coverage.test.ts` is the counterpart
that now exists.

Round one also found `authorizeRestart` failing **open**: a gated command whose
payload could not yield a fingerprint was waved through as "nothing to check".

**Round two found a defect the round-one fixes introduced** — `cancel` did not
check who was answering while `go` did, so anyone in the admin chat could cancel
someone else's pending confirmation. Fixed in `40dd721`.

Worth recording for whoever runs the next area: round two had **one reviewer of
four** available (Codex rate-limited, Claude failed, GLM out of balance), so its
verdict is thinner than round one's, and the `cancel` fix was never seen by a
third pass.

### A2's standing-grant mechanism is built and unused

`utils/action-approval-grant.ts` supports `kind: "standing"`, and
`scripts/grant-watchdog-standing.ts` can issue one. **Nothing holds one.** The
mechanism was justified by a claim that turned out to be false — that
`tmux-watchdog` already restarted wedged sessions unattended. It never did; it
alerts, and AC14 pins that it still only alerts. Adding an autonomous actor is a
decision, not an implementation detail, and building the mechanism does not
authorize taking it.

### Decisions already made for A1, before it starts

Recorded so the next session does not re-litigate them:

1. **keryx goes into the bot image** (`Dockerfile`). E3/E4/E5 run in the
   container, which today has only `git curl ca-certificates`. Pin the version
   and check it at startup.
2. **The false-positive measurement is a separate step, before any code.** The
   corpus is git diffs and reviewer reports — the E4 payloads — not reply
   history, because replies are no longer scanned.
3. **Step 0 is the exclusion test**, written before any scanning code exists: a
   test that fails if a scan ever appears on `channel/tools.ts` or
   `mcp/tools.ts` `reply`. The boundary of this area is enforced from the first
   commit rather than after the first mistake.

## Order

**A2 → A1 → A3 → A5 → A4.**

The reasoning is in [prd.md](prd.md) §Recommendation. In one line each: A2
prevents an incident that has already happened twice and costs the operator one
sentence of confirmation text. A1, rescoped to the five external crossings, is
worth doing but is a five-call-site change guarding opt-in paths. A3 is small
and self-contained. A5 is mostly pinning what already works, plus one real gap.
A4 is last because it is `spec`-graded on both sides and because building it
before `codex-session-engine-2026-08-09` has chosen its path would choose that
path by accident.

## Dependencies

Only one hard one exists:

```text
R5.3 ◀──(opaque single-use token)──▶ A2    shared mechanism: whichever lands first builds it
```

A1 no longer depends on A2. In version 1.0.0 it did — a `require-approval`
verdict needed somewhere to hold a message. With the operator channel out of
scope there is nothing conversational to hold: a crossing with a
`require-approval` verdict takes its local fallback or is skipped, and the
operator learns about it where the call was made.

A3 depends on nothing and blocks nothing. A4 depends on
`codex-session-engine-2026-08-09` choosing its path, which is outside this
package.

## A2 — Action-bound approval

**Size:** medium. A grant table, a fingerprint function, three call sites, a
confirmation-text change, and the CLI path.

| Step | Work |
|---|---|
| 1 | Grant storage per [schemas/action-approval-grant.schema.json](schemas/action-approval-grant.schema.json). |
| 2 | `fingerprintOf(action)` — pure, total, and the single place the mapping from a command to `half`/`scope`/`downtime` lives. |
| 3 | Confirmation text states the fingerprint in words before asking, so "да" has a referent. This is the change that would have prevented both recorded incidents on its own. |
| 4 | Gate at `scripts/admin-daemon.ts` :416, :494, :522 — re-derive, compare, then `claimRestart`. Order matters: an unapproved action should not take a lease. |
| 5 | `cli.ts`'s `"bounce"` branch: the path `CLAUDE.md` names as bypassing the lease entirely. Same gate, or an explicit refusal when a restart is in flight. |
| 6 | No approver reachable → deny (P-2.3), **with the standing grant that makes it survivable** (P-2.3a): `scripts/tmux-watchdog.ts` holds `sessions`/`<project path>`/`brief` per project it watches and keeps recovering wedged sessions unattended; anything wider from it is denied. Decided 2026-08-12. |
| 7 | Tests A2.1–A2.10, with A2.1 (wrong half refused) as the one that encodes the incident and A2.9 (watchdog refused anything wider) as the one that keeps the exemption honest. |

**Explicitly out of scope:** reworking `perm:always:` into a bounded grant. It
touches the permission flow on every tool call rather than a family of five
commands, and it deserves its own package.

**Risk to watch:** the standing grant is the one exemption from single-use in
the package. Its safety is entirely in its narrowness, so the review of step 6
is specifically: can the watchdog's grant ever match an action wider than one
project's sessions? If yes, the exemption has become a hole.

## A1 — External boundary scan

**Size:** medium. One helper, five call sites, a config record, a posture
surface, a test file.

| Step | Work |
|---|---|
| 0 | **The exclusion test first.** A test asserting that `reply` on `channel/tools.ts` and `mcp/tools.ts` invokes no scanner. Written before any scanning code exists, so the boundary of this area is enforced from the first commit rather than after the first mistake. |
| 1 | A scan helper: spawn `keryx security check-output --json --target external`, feed the payload on stdin, parse the verdict. Reads `gate` and `action`; ignores the exit code entirely. |
| 2 | A parse failure, a spawn failure, a timeout, and a missing binary all return the same "scan unavailable" result, which takes the crossing's fallback path. |
| 3 | E1 — `utils/tts.ts`: scan before the Yandex (`:307`), Groq (`:329`) and OpenAI (`:356`) calls; on a finding or a failure, fall through to local `piper` (`:8-9`) and record the substitution. |
| 4 | E3 — `utils/aux-llm-client.ts`: scan outbound at `:28`/`:34`; scan the returned completion as untrusted before it reaches a session or memory; skip entirely for the local Ollama URL at `:31`. |
| 5 | E4 — `services/reviewer-service.ts` / `scripts/review.ts`: scan the diff before it goes out and the report before it comes back in. |
| 6 | E5 — `services/provider-service.ts`, `claude/client.ts`: same, for non-local providers only. |
| 7 | E2 — `utils/transcribe.ts`: posture, not payload. Remote transcription becomes an explicit opt-in whose state is visible from a status surface. |
| 8 | Config per [schemas/external-boundary-policy.schema.json](schemas/external-boundary-policy.schema.json); findings surfaced through `mcp/dashboard-api.ts`. |
| 9 | Tests A1.1–A1.11 in [specification.md](specification.md). A1.1/A1.2 (operator channel untouched), A1.8 (exit code) and A1.9 (target) are the four that catch a control that silently does nothing or silently does too much. |

**Deployment note.** E1 and E2 live in `utils/**`, which both the container and
the host channel subprocess import. Per `CLAUDE.md`, code that ships in the
container does not reach a running session: a change to a module the channel
imports is live only after `bun cli.ts bounce` or a full restart. Rebuilding the
bot alone leaves every existing session on the old code — silently.

**Rollout:** enabled from the first commit, with fallbacks in place. There is no
soft-launch question here, because fail-closed on a crossing costs a locally
synthesised voice or a skipped reviewer, not a message to the operator.

**False positives:** measured before merge (M1.3). The corpus is diffs and
reviewer reports — the E4 payloads — because that is where token-shaped strings
in ordinary content actually live. A noisy rule becomes a recorded exception,
never a disabled scanner.

## A3 — Compaction record

**Size:** small. A parser, a status line, an accounting fix.

| Step | Work |
|---|---|
| 1 | Recognise the `compact_boundary` entry in the transcript reader. |
| 2 | Record that a compaction happened, when, and what it named as dropped. |
| 3 | One operator-visible line at the moment it happens. |
| 4 | `utils/context-usage.ts` distinguishes "window shrank because of compaction" from "window filling up" — today they look alike and mean opposite things. |
| 5 | A refusal, with a test, on any path that would rewrite or delete an already-recorded helyx-side entry. |

**Note:** helyx does not own Claude Code's window and this area does not try to.
It owns what it keeps beside it.

## A5 — Perimeter

**Size:** small for the pins, medium for the handoff.

| Step | Work |
|---|---|
| 1 | Pin tests for what already holds: per-sender authorization (`bot/access.ts`), inbound unmapped-topic refusal (`bot/text-handler.ts`). No behaviour change. |
| 2 | Outbound parity: `channel/tools.ts:397-404` refuses instead of sending to General when a project has no topic mapping. |
| 3 | `ALLOW_ALL_USERS` warns at startup naming what it turns off. One line, immediate value. |
| 4 | Opaque single-use expiring callback tokens — shared with A2 step 1. |
| 5 | One-time local secret handoff for provider keys. The largest single piece in A5, and the one with real UX design in it. `utils/hook-token.ts` establishes the local-shared-file pattern to build on. |

Steps 1 and 3 are worth doing on their own in an afternoon, independently of the
rest.

## A4 — Engine connector

**Size:** documentation only, in this package. Implementation belongs to
`codex-session-engine-2026-08-09`.

| Step | Work |
|---|---|
| 1 | That package adopts the terms `provider` and `connector`. |
| 2 | Its engine table adopts [schemas/engine-connector-entry.schema.json](schemas/engine-connector-entry.schema.json), including `limitSignal: null` for Codex. |
| 3 | Its credential handling adopts [policies.md](policies.md) §P-3 and states §P-4 at the point of activation. |
| 4 | Its Phase 0 spike question is updated with the Chat Completions finding — recorded, with its compliance boundary attached, and **not** as a recommendation. |

Nothing in A4 requires a line of helyx code to change.

## What "done" means for this package

This package is complete when the five areas are recorded, graded, and specified
— which is the state at version 1.0.0. It does not become "done" by being
implemented; each area closes in its own flow, against its own acceptance
criteria in [specification.md](specification.md).

A partial outcome is a real outcome here: **A1 alone, shipped, is worth the
package.**
