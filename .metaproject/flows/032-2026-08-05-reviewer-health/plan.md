# Implementation Plan

Status: formalized

## Approach

The honest signal already exists as of flow 031: every run leaves an artifact
recording what each reviewer actually did. So availability is answered by
evidence rather than by asking a CLI about itself.

1. **`classifyCodexFailure` learns Codex's own words.** The limit pattern gains
   `usage limit` — captured verbatim from the CLI on 2026-08-05 — and the reset
   time is carried through when the message contains one, because "try again at
   Aug 11th" is the whole of what the operator needs.
2. **`reviewer-service` reads the last run.** `lastOutcomeByReviewer` in
   `services/review-artifacts.ts` returns, per reviewer id, what its most recent
   recorded run did. `getReviewerStatuses` folds that in: a reviewer whose last
   real run failed is not available, whatever a login probe says, and its detail
   is that failure. A reviewer with no probe and no recorded run is `probed:
   false` rather than a green tick.
3. **Loop 10 in the supervisor.** Every 30 minutes, `checkReviewerHealth` reads
   the statuses and alerts on *transitions*: available → unavailable raises one
   alert; unavailable → available clears it. State is in memory, so a daemon
   restart re-announces at most once per reviewer.

Balance keeps its own rule, with hysteresis: alert when it crosses below the
floor, re-arm only above floor + margin, so a balance hovering at the line does
not alternate.

### Rejected alternatives

- **Probe by running a review.** Ten minutes and real tokens to answer a
  question the last run already answered.
- **Trust the login probe and drop the artifact.** That is the defect.
- **Alert on state rather than transitions.** A reviewer down for six days would
  produce 288 alerts.

## Steps

1. `usage limit` in `classifyCodexFailure`, with the reset time carried through.
2. `lastOutcomeByReviewer` in `services/review-artifacts.ts`.
3. `probed` on `ReviewerStatus`; fold the last outcome into
   `getReviewerStatuses`; render the third state in `/reviewers`.
4. `checkReviewerHealth` + Loop 10 in `scripts/supervisor.ts`.
5. Tests for each, including the captured Codex message.
6. CHANGELOG entry.

## Risks

- **A transient failure marks a reviewer unavailable.** It clears on the next
  successful run, and the alert names the failure rather than guessing at it.
- **The artifact directory is empty on a fresh install.** Then there is no
  recorded run, and the status is `probed: false` — which is what a system that
  has never reviewed anything should say.
- **Alert noise on the first enable.** One transition per reviewer, deduplicated
  by the supervisor's existing window.
