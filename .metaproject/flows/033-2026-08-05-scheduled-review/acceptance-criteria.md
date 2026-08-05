# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `scheduledReviewDecision` refuses the default branch, an empty diff, a hash already reviewed, and a hash that changed since the previous pass; each proved by test.
- AC2: `scheduledReviewDecision` returns run for a hash seen twice in a row and never reviewed; proved by test.
- AC3: The decision is pure — it takes the branch, the diff hash and the stored state as arguments and returns a verdict with a reason; no git, no database, no clock inside it.
- AC4: The stored state round-trips through `bot_config` and survives a restart, so a scheduled review does not repeat after the supervisor restarts; proved by test with a fake sql.
- AC5: A run refused while another review is in flight is refused with a reason, not queued; proved by test.
- AC6: A scheduled run records `trigger: "scheduled"` in its artifact, and a manual one still records `manual`; proved by test.
- AC7: The loop posts one message naming the branch and the artifact path when a review completes; proved by test with a fake sink.
- AC8: Nothing in this flow can block a push, a commit or a container start; verified by reading the change — no hook is installed and no caller waits on the loop.
- AC9: Loop 11 is registered in `startSupervisor` and unref'd like its neighbours.
- AC10: Whole unit suite green and `tsc --noEmit` clean.
- AC11: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC12: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.
