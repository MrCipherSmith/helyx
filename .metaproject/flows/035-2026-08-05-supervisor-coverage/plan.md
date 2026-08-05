# Implementation Plan

Status: formalized

## Approach

Four test groups, chosen by uncovered lines weighted by what a failure would
cost, not by what is easiest to reach.

**1. The loop inventory (`startSupervisor`, 179 lines).** Global `setInterval`
and `setTimeout` are replaced for the duration of the test, and the
registrations are read back: how many loops, at what intervals, and that each
timer is unref'd. This is the one test that would catch a loop written and never
started — a failure this module has had, and the reason Loop 8 exists.

**2. The analyst's view (`formatSnapshotForGemma`, 34).** Pure, and the only
thing standing between a system snapshot and a model's judgement of it. Tested
against the empty case, the populated case and the states that must not be
silently dropped.

**3. What the network says no with (`callGemmaForHealth`, 26;
`getLlmExplanation`, 39).** Both call out and both must degrade rather than
throw: a health analyst that crashes the loop it runs in is worse than one that
says nothing. `fetch` is stubbed; nothing here talks to Ollama.

**4. `checkRecovery` (50).** Drives the alert-resolution path with a fake sql
and a stubbed transport.

`callGemmaForHealth` is not exported today. It is exported for the test, with
the comment saying so — the same pattern `botDownState` already uses in this
file.

### Rejected alternatives

- **Cover `checkIdleSessions` too.** It reaches `forceSummarize` through a
  module import; covering it needs module mocking or a seam in production code,
  and that is a decision, not a coverage chore.
- **Test `startSupervisor` by calling it and waiting.** The intervals are
  minutes long; the test would either sleep or fake time anyway, and faking the
  registration is both faster and a stronger assertion.
- **Extract the loop table into data and test the data.** A worthwhile
  refactor and a different flow: this one must not change behaviour while
  measuring it.

## Steps

1. `tests/unit/supervisor-loops.test.ts` — the inventory.
2. `tests/unit/supervisor-analyst.test.ts` — rendering and the two calls.
3. `tests/unit/supervisor-recovery.test.ts` — `checkRecovery`.
4. Re-measure; record the before and after per file.
5. CHANGELOG entry.

## Risks

- **A test that pins the schedule makes changing it noisier.** Intended: the
  schedule is a contract between eleven loops sharing one database, and the
  offsets exist to spread load.
- **Stubbing globals leaks between tests.** Each group restores what it
  replaced in `afterEach`, and the suite runs in one process — the same
  discipline `fake-telegram` documents.
- **Coverage may land short of 75%.** Then the number is reported as it is and
  the remainder is named, rather than the target being quietly restated.
