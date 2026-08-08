# Flow Journal

- 2026-08-08T09:47:50.755Z - flow created
- 2026-08-08T09:51:58.709Z - frozen: 6 criteria; checksum recorded
- 2026-08-08T09:51:58.876Z - started
- 2026-08-08T09:52:07.715Z - task-done: T1: Collect remaining context
- 2026-08-08T09:52:07.802Z - task-done: T2: Implement per plan
- 2026-08-08T09:52:07.888Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-08T09:52:07.978Z - ac-confirmed: AC1: typecheck 0 errors; lint 0 errors (240 pre-existing warnings)
- 2026-08-08T09:52:08.065Z - ac-confirmed: AC2: tests/unit/reviewer-unknown-kind.test.ts; suite 2111 pass / 0 fail
- 2026-08-08T09:52:08.152Z - ac-confirmed: AC3: runOne switch: codex/claude/provider explicit, default -> unhandledKind; asserted error is 'unknown reviewer kind: mystery', not 'unknown provider'
- 2026-08-08T09:52:08.239Z - ac-confirmed: AC4: unknownKindStatus: available false, probed true, detail names the kind
- 2026-08-08T09:52:08.328Z - ac-confirmed: AC5: callProviderReview with getProvider -> null still returns label provider#404 / 'unknown provider'
- 2026-08-08T09:52:08.415Z - ac-confirmed: AC6: adding a 4th kind 'gemini' produced TS2345 at reviewer-service.ts:1159; reverted
- 2026-08-08T09:52:39.710Z - implemented: draft PR: https://github.com/MrCipherSmith/helyx/pull/104 (warning: PR is not a draft)

## Review notes (PR #104, Claude reviewer)

Two findings applied:

- The status path opted out of the guarantee AC6 buys. `unknownKindStatus` now
  takes its kind as `never` too, so a fourth `ReviewerKind` breaks *both* paths —
  verified: adding `"gemini"` produced TS2345 at reviewer-service.ts:1164 and
  :1332, where before it produced only :1164.
- Two JSDoc blocks had been separated from their functions by the inserted
  helpers — `budgetFor`'s argv-ceiling rationale and `unhandledKind`'s `never`
  rationale had drifted onto the wrong declarations. Both moved back.

Two known gaps, recorded rather than fixed:

- AC4 is confirmed against `unknownKindStatus` as a pure function. It proves the
  row's shape, not that `getReviewerStatuses` reaches it *before* the provider
  lookup — the branch order is not covered, because that function takes no
  injectable `getReviewers`/`lastOutcomeByReviewer`/`getProvider`. Adding DI to
  it is its own change.
- AC4's frozen wording names `reviewerAvailability`; the function is
  `getReviewerStatuses`. Wording drift at freeze time, no effect on the code.
