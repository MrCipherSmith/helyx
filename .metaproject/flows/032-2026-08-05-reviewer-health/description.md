# Reviewer availability is asked only when someone opens a menu, and answered by the wrong question

Status: formalized
Source: user description → package `docs/requirements/reviewer-operations-2026-08-05` (gap G1)

## Problem

Three failures of the same thing, all of them live on 2026-08-05 and all of
them measured that day.

**The question is wrong.** `getReviewerStatuses` asks Codex
`codex login status`. Measured mid-review: that answered `Logged in using
ChatGPT` while `codex exec` refused every run with
`ERROR: You've hit your usage limit … try again at Aug 11th, 2026`. `/reviewers`
would have shown a green tick for six days against a reviewer that cannot
review. Login state is not availability.

**Nobody asks it.** The only caller is the `/reviewers` command. The supervisor
runs ten scheduled checks and none of them is this one, so a dead reviewer
announces itself inside the review you just asked for.

**And the failure is misfiled.** `classifyCodexFailure` maps the CLI's own
error lines to a reason, and its limit pattern is `rate limit|quota|too many
requests`. Codex says **usage limit**, which matches none of them, so eleven
review rounds today recorded `failed (exit 1)` — true, and useless. The one
string that would have named the problem was thrown away by the classifier that
exists to name it.

## Expected Outcome

- A reviewer that cannot run reads as unavailable, whatever its login says.
- A transition into unavailability reaches the operator once, without being
  asked, and a recovery clears it.
- A Codex usage limit is reported as a usage limit, with the reset time when
  the CLI gives one.
- A backend with no probe reads as *unprobed*, which is a third state and the
  honest one.

## Out of Scope

- Running a review to find out whether reviews work. A probe that costs ten
  minutes is not a probe.
- Fixing the quota itself, or switching models when one is exhausted.
- The scheduled-review trigger — the third flow of this package.
