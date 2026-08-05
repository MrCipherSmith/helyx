# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A test asserts the full loop inventory registered by `startSupervisor` — the number of repeating loops and each one's interval — so a loop that is written and never registered fails the suite.
- AC2: The same test asserts every registered timer is unref'd, so no loop can hold the daemon open.
- AC3: `formatSnapshotForGemma` is tested for the empty snapshot, a populated one, and that no section is silently dropped when its list is empty; proved by test.
- AC4: `callGemmaForHealth` returns a healthy verdict rather than throwing when the endpoint refuses, times out or answers with something unparseable; proved by test with a stubbed fetch.
- AC5: `getLlmExplanation` degrades the same way and never propagates a network failure into the loop that called it; proved by test.
- AC6: `checkRecovery` is exercised against a fake sql and a stubbed transport, covering both the resolved and the still-failing paths.
- AC7: No production behaviour changes in this flow except a defect it finds, and any such change is named in the CHANGELOG as a defect rather than as a refactor.
- AC8: `scripts/supervisor.ts` line coverage is measured before and after and both figures are recorded; the after figure is at or above 75%, or the shortfall is stated with what remains uncovered.
- AC9: Whole unit suite green and `tsc --noEmit` clean.
- AC10: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC11: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.
