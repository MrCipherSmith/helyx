# The supervisor is the top hotspot and half of it is untested

Status: formalized
Source: package `docs/requirements/io-layer-coverage-2026-08-05` (C1)

## Problem

`scripts/supervisor.ts` is the highest-risk file in the repository by the
project's own measure — churn × complexity 355 776, first by a wide margin — and
580 of its 1209 instrumented lines are uncovered.

It is also the file this programme has changed most: three new loops in one day,
on top of a module that broke twice in the week before. Every one of those
changes was reviewed, and none of them was covered by a test of the file they
landed in.

The uncovered mass is not spread evenly. Six regions hold 440 of the 580 lines:

| Region | Uncovered |
|---|---|
| `startSupervisor` — the loop registrations | 179 |
| `checkRecovery` | 50 |
| `checkIdleSessions` | 47 |
| `checkGemmaHealth` | 46 |
| `getLlmExplanation` | 39 |
| `formatSnapshotForGemma` | 34 |
| `callGemmaForHealth` | 26 |

`startSupervisor` alone is a third of the deficit, and what it holds is the
inventory: which loops exist, how often each runs, and whether each one holds
the daemon open. A loop that is written and never registered is a failure this
repository has already had — Loop 8's own comment describes the outage nothing
was watching — and nothing today would catch it.

## Expected Outcome

- `scripts/supervisor.ts` at or above 75% of lines.
- The loop inventory is asserted: every loop registered, at its stated interval,
  and unref'd so none of them holds the daemon open.
- The pure rendering that feeds the health analyst is tested against the shape
  the analyst actually receives.
- The two network calls are tested for what they do when the network says no.

## Out of Scope

- Changing the supervisor's behaviour. This flow adds tests; any production
  change it forces is a defect it found, recorded as such.
- `checkIdleSessions`, which reaches `forceSummarize` through a module import
  rather than a parameter. Covering it means either module mocking or a seam,
  and that decision belongs to its own flow rather than to a coverage push.
