# Requirements Roadmap

Version: 1.0.0

Index of requirements packages under `docs/requirements/`, the order they are
worked in, and what each one is waiting on. One row per package; a package is
worked as one or more flows through the Task Manager.

Status vocabulary is the package standard's: `draft`, `spec ready`,
`implemented`, `future`. A package is `implemented` only when its acceptance
criteria are met in deployed code, not when its code is written.

## Current programme — observability, review operations, coverage

Opened 2026-08-05 from a survey of monitoring and review gaps. Nine findings,
grouped into four blocks by what they have in common rather than by where they
live in the tree.

| # | Block | Package | Status | Blocked on | Order |
|---|---|---|---|---|---|
| A | Self-observability — the system notices its own failures | [self-observability-2026-08-05](self-observability-2026-08-05/README.md) | `spec ready` | nothing | 1st |
| B | Reviewer operations — availability, persistence, triggers | [reviewer-operations-2026-08-05](reviewer-operations-2026-08-05/README.md) | `spec ready` | nothing | 2nd |
| C | I/O layer coverage — gate from WARN to PASS | [io-layer-coverage-2026-08-05](io-layer-coverage-2026-08-05/README.md) | `spec ready` | A landing first (both touch `scripts/supervisor.ts`) | 3rd |
| D | E2E in CI | none — see below | `future` | a maintainer decision | after C |
| E | Coverage to sixty — close the remaining 3312 lines | [coverage-to-sixty-2026-08-05](coverage-to-sixty-2026-08-05/README.md) | `spec ready` | nothing — §5 answered 2026-08-05: the floor is a minimum, so the order is by risk | after the rebuild |

### Why this order

A first: its four defects are live in production right now, three of them are
small, and one of the three already has code written and undeployed. B second:
it is self-contained and touches nothing A touches. C third: it covers
`scripts/supervisor.ts`, which A is about to grow by two loops, and writing
those tests before A lands means writing them twice.

D is not a package yet on purpose. Writing a PRD for a workflow whose target is
undecided produces a document that has to be rewritten once the decision is
made.

### Findings map

Where each finding from the 2026-08-05 survey went:

| Finding | Block |
|---|---|
| `extractFactsFromTranscript` never runs in the container — 4136 warnings | A (D1) |
| Nothing watches the bot's own error stream | A (D2) |
| `collectSystemSnapshot` uses `docker ps` without `-a` | A (D3) |
| A send into a deleted forum topic is silently misdelivered | A (D4) — code written, not deployed |
| Reviewer availability is checked only on demand | B (G1) |
| Reviewer reports are never persisted | B (G2) |
| No review runs without a person asking | B (G3) |
| Coverage 47.90% against a 60% floor; gate WARN | C |
| E2E workflow deleted, nothing runs the suite | D |

## Block D — the open decision

The e2e suite exists — specs in `tests/e2e/`, config `tests/playwright.config.ts`,
JWT minted without a browser in `tests/global-setup.ts`.
`.github/workflows/e2e.yml` was deleted
in `5bab380`: a self-hosted bot has no public URL for a GitHub runner to reach,
so the workflow could only ever have tested a deployment that happens to be
exposed.

The decision, which belongs to the maintainer and not to a document:

1. **Throwaway stack inside the job** — bot + postgres via compose,
   `TEST_BASE_URL=http://localhost:3847`. Self-contained, no secrets beyond a
   test bot token; costs CI minutes and a compose bring-up per run.
2. **The live deployment** — needs its URL and a bot token as repository
   secrets, and tests whatever happens to be deployed rather than the commit
   under test.

Until one is chosen, D stays here rather than becoming a package. The same item
is recorded in [`docs/ROADMAP.md`](../ROADMAP.md) § Planned.

### Where the programme of 2026-08-05 ended

Sixteen flows, fifteen landed, one (036 `mcp/server.ts`) blocked and then
unblocked by the maintainer and landed too. Coverage 36.25% → 43.30%, tests
1443 → 1661, gate still WARN against a 60% floor. Block E is the answer to
"what would close it", and it argues for changing the method rather than
repeating it.

## Earlier packages

| Package | Status | Note |
|---|---|---|
| [deployment-simplification-2026-07-30](deployment-simplification-2026-07-30/README.md) | `implemented` | Shipped in v1.51.0; measurements revised the original draft |
| [message-delivery-resilience-2026-06-25](message-delivery-resilience-2026-06-25/) | `implemented` | Three language renderings, no core package files |
| [session-context-injection.md](session-context-injection.md) | `implemented` | Shipped in v1.50.0; single document, predates the package standard |
| [session-stability-and-audit-2026-06-26.md](session-stability-and-audit-2026-06-26.md) | `implemented` | Shipped across v1.50.0–v1.53.0; single document |

## How this file is kept

- A new package adds a row before its first flow starts, not after.
- Status changes when the package's acceptance criteria change state, and the
  package README is the source of truth for its own status — this file follows
  it, never the other way round.
- A block that turns out to be blocked records what it is blocked on, by name.
  "Blocked" without a named blocker is not a status.
