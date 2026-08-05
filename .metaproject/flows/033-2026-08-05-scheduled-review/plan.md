# Implementation Plan

Status: formalized

## Approach

The supervisor already runs ten loops, already knows how to keep state across
restarts, and — since flow 031 — a review already leaves a record naming its
trigger. So this is one more loop and one piece of remembered state, not new
machinery.

`maybeRunScheduledReview` in `scripts/supervisor.ts`, every 15 minutes:

```text
skip when the branch is the default branch          (nothing left to catch)
skip when the diff is empty                          (nothing to review)
hash the diff
skip when the hash equals the last reviewed hash     (already said)
skip when the hash changed since the previous pass   (still being written)
otherwise run the pipeline with trigger="scheduled"
```

Two passes with the same hash is what "stayed still" means, and at a 15-minute
interval that is a quarter of an hour of quiet — enough that a scheduled review
does not chase a branch mid-edit.

State lives in `bot_config` under `review_state`, because the supervisor
restarts often and in-memory state would re-review on every restart. The
decision itself is a pure function, `scheduledReviewDecision`, so the rules are
testable without a git repository, a database or a reviewer.

### Rejected alternatives

- **`pre-push`.** `REVIEW_TIMEOUT_MS` is ten minutes. A hook that can hold a
  push for that long gets disabled within a week, and then nothing runs at all.
- **On every commit.** A branch is written in bursts; this would review each
  keystroke-sized commit and spend the budget before the branch is finished.
- **On a fixed clock, regardless of change.** Reviews an unchanged branch, costs
  tokens, and teaches the operator to ignore the report.
- **Concurrency by queueing.** A second review while one is running is refused
  rather than queued: by the time the first finishes, the second's diff is
  probably stale anyway.

## Steps

1. `scheduledReviewDecision` — pure, in `services/review-artifacts.ts` beside
   the other review-lifecycle logic.
2. `review_state` read/write helpers on `bot_config`.
3. `maybeRunScheduledReview` + Loop 11 in `scripts/supervisor.ts`, posting a
   short summary and the artifact path to the supervisor topic.
4. Tests for the decision table and for the loop's wiring.
5. CHANGELOG entry.

## Risks

- **A review starts while the operator is mid-flow.** It cannot interrupt
  anything — it writes a file and posts one message.
- **Cost.** One review per branch per settled change, and never on the default
  branch.
- **The hash is of a diff that includes another session's uncommitted work.**
  True today and visible in the artifacts; it makes the hash change more often
  than the branch does, which delays a scheduled review rather than causing a
  spurious one.
