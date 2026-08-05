# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `classifyCodexFailure` returns a limit reason for the exact message the CLI produced on 2026-08-05 — `ERROR: You've hit your usage limit. Visit … or try again at Aug 11th, 2026 5:49 PM.` — proved by a test carrying that string verbatim.
- AC2: The reset time is carried into the reason when the message contains one, and its absence does not break classification; proved by test.
- AC3: The patterns already recognised — cli-usage, model-unsupported, rate limit, auth, empty output, non-zero exit — keep their current answers; the existing tests for `classifyCodexFailure` pass unmodified.
- AC4: `lastOutcomeByReviewer` returns, per reviewer id, the outcome recorded in the most recent artifact, and an empty result when no artifact exists; proved by test against a real temporary directory.
- AC5: `getReviewerStatuses` reports a reviewer whose last recorded run failed as unavailable, with that failure as the detail, even when its login probe succeeds; proved by test.
- AC6: A reviewer with no probe and no recorded run is `probed: false` and is not counted available; proved by test.
- AC7: `checkReviewerHealth` alerts once on a transition into unavailability and not again while it stays down; proved by test.
- AC8: A recovery clears the alert once, and does not re-alert while the reviewer stays up; proved by test.
- AC9: A balance crossing below the floor alerts, and re-arms only above floor plus margin, so a balance at the line does not alternate; proved by test.
- AC10: Loop 10 is registered in `startSupervisor` and unref'd like its neighbours.
- AC11: Whole unit suite green and `tsc --noEmit` clean.
- AC12: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC13: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.
