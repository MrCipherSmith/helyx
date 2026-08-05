# A review runs only when someone remembers to ask for one

Status: formalized
Source: user description → package `docs/requirements/reviewer-operations-2026-08-05` (gap G3)

## Problem

Nothing starts a review. `scripts/review.ts` runs when a person types it, and
`.git/hooks/pre-push` runs the keryx security guard and nothing else. The moment
a review is most valuable — a branch that has stopped changing and is about to
be pushed or merged — is exactly the moment attention has moved on.

Today's evidence: seven flows, every one of them reviewed because the agent
driving them chose to. A branch left alone for an hour is a branch nobody
reviewed.

## Expected Outcome

- A review starts without being asked, when the current branch's diff has
  changed and then stayed still for a while.
- The same branch is not reviewed twice for the same content.
- A scheduled run is indistinguishable from a manual one except in its record:
  the artifact says which trigger fired.
- It never blocks. No hook, no gate, no waiting.

## Out of Scope

- Reviewing the default branch. A merge has already happened; a review of it is
  archaeology, and the interesting moment was before.
- Acting on findings. A stored report is read by a person or an agent.
- Any change to what reviewers are asked or how the diff is budgeted.
