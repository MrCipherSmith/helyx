# Reviewer Operations — PRD

Version: 1.0.0

## 1. Problem

The reviewers are good and nobody knows whether they are up. Their output is
good and nothing keeps it. Both facts have the same cause: the pipeline is a
command, and a command only exists while someone is typing it.

Three consequences, all observed:

- A dead reviewer announces itself at the worst moment — inside the review you
  just asked for, as `[label] unavailable: …`. On 2026-08-05 the provider
  balances were checked by hand, in a session, because there was no other way
  to know them.
- A report is printed to stdout and ends there. The second review of the same
  branch cannot know what the first one said; a finding dismissed on Monday is
  re-litigated on Thursday; nothing accumulates.
- A review happens only when remembered. The one moment it is most valuable —
  a branch about to be pushed — is exactly the moment attention is elsewhere.

## 2. Evidence

Read from the repository on 2026-08-05.

### G1 — availability is on-demand only

`services/reviewer-service.ts:647`, `getReviewerStatuses()`, probes each
reviewer: for Codex, `npx @openai/codex login status`; for a DeepSeek-backed
provider, `GET /user/balance` with an 8 s timeout, reporting
`balance $<n>` or `no balance`. Providers other than DeepSeek get a
best-effort pass — they are reported available without a probe.

Its only caller is the `/reviewers` Telegram command. No loop calls it. The
supervisor has ten scheduled checks and none of them is this one.

**And the probe it does run is the wrong question for Codex.** Measured on
2026-08-05, mid-review: `codex exec` failed with `You've hit your usage limit …
try again at Aug 11th`, while `codex login status` — the only thing
`getReviewerStatuses` asks — answered `Logged in using ChatGPT`. `/reviewers`
would have shown Codex green for the six days it cannot review. Login state is
not availability, and R1 must not treat it as such.

### G2 — reports are not kept

`scripts/review.ts` is 34 lines: run, print, exit. `runReviewers` returns
`{ mode, reports[] }` where each report carries `label`, `model`, `ok`,
`content` and `error` — a structure that would serialize directly — and the
wrapper renders it to the terminal and drops it.

`keryx memory ingest --from-review <path>` exists and is documented in the
memory module's CLI surface. Nothing in this repository ever produces a file
for it.

### G3 — no trigger but a person

`.git/hooks/pre-push` exists and runs the keryx security guard in advisory
mode. Nothing runs a review. `.github/workflows/` builds and publishes; the
e2e workflow was deleted in `5bab380` and the review pipeline was never in CI
at all.

`REVIEW_TIMEOUT_MS` is 600 000 — ten minutes. That number matters for the
trigger design and is the reason §7 rejects the obvious answer.

## 3. Goal

Know that the reviewers are available before needing them; keep what they say;
let a review start without being asked.

## 4. Users

| User | Need |
|---|---|
| Operator (Telegram) | To be told a reviewer went down, once, when it goes down |
| Maintainer | To read last week's report without having re-run it |
| Agent (Claude session) | A stored report to compare against, and a path to feed accepted findings into project memory |

## 5. Requirements

### R1 — scheduled availability, probed honestly

A supervisor loop calls `getReviewerStatuses()` on a schedule and alerts on
**transitions**, not on state: a reviewer that has been down for a day must not
alert every hour.

The Codex probe must test the ability to run, not the ability to log in — a
quota-exhausted account is logged in and cannot review. The cheapest honest
signal available is the outcome of the last real run, recorded by R2's
artifact; a probe that spends a review to check whether reviews work is not
worth its cost.

A balance below a configurable floor is a transition into unavailable even when
the provider still answers.

Providers without a balance endpoint must not be reported "available" on the
strength of having no probe. They are reported `unprobed`, which is a third
state and is honest.

### R2 — a run produces an artifact

Every `runReviewers` invocation writes one JSON artifact and one Markdown
rendering of the same run. The artifact records: timestamp, git ref and
`merge-base`, the prompt, the diff size actually sent, and per reviewer the
label, model, ok/error, truncation flag and full content.

The Markdown rendering is what a person reads and what
`keryx memory ingest --from-review` consumes.

`scripts/review.ts` keeps printing to stdout — the CLAUDE.md contract, including
the bare `SELF` line, is unchanged. Persistence is additive.

### R3 — retention is defined

Artifacts are pruned by age and count, both configurable, with the current
branch's most recent run never pruned. An unbounded directory of ten-minute
reviews is a defect this package would be creating.

### R4 — a review runs on a trigger

At least one trigger that is not a person typing. The recommended trigger is
in §7; the requirement is that a triggered run is indistinguishable from a
manual one in everything except who started it, and that its artifact records
which trigger fired.

### R5 — a triggered review never blocks work

A trigger may notify, store and annotate. It may not gate a push, a commit or a
container start. See §7.

## 6. Success Criteria

| # | Criterion | How it is verified |
|---|---|---|
| S1 | A reviewer going down produces exactly one alert | flip a reviewer's credentials in a test double; assert one alert across three loop passes |
| S2 | A provider with no balance endpoint reports `unprobed`, not `available` | unit test over `getReviewerStatuses` |
| S3 | Every run leaves a readable artifact | run the pipeline; assert both files exist and parse |
| S4 | `keryx memory ingest --from-review` accepts the Markdown rendering | run it against a produced artifact |
| S5 | Artifacts do not grow without bound | retention test with a fabricated backlog |
| S6 | A triggered review produces the same artifact shape as a manual one | one test, two entry points |

## 7. Risks and the rejected design

| Risk | Consequence | Mitigation |
|---|---|---|
| Review on `pre-push` | A ten-minute timeout on the path of every push; the hook gets disabled within a week | **Rejected.** The trigger runs asynchronously and reports afterwards |
| Scheduled review of an unchanged branch | Cost and noise for nothing | Trigger on `merge-base` diff hash changing, not on the clock alone |
| Artifacts leak diff content | Diffs may contain secrets; artifacts sit on disk | Store under the existing logs directory, same permissions; never send an artifact anywhere the diff itself does not already go |
| Alert on a flapping balance | Noise near the floor | Hysteresis: alert on crossing down, re-arm only above floor + margin |
| Reviewer output stored as truth | A wrong finding gains authority by being written down | The artifact records what a reviewer said, marked as such; ingestion into memory stays a deliberate act |

**Recommended trigger (R4):** a supervisor pass that, when the current branch's
`merge-base` diff hash has changed and has been stable for N minutes, runs the
pipeline in the background and posts a short summary to the supervisor topic
with the artifact path. It observes the work rather than standing in front of
it, which is the only shape §R5 allows.

## 8. Recommendation

R2 first — it is the smallest change and every other requirement is more useful
once reports persist. R1 second, because it is a few dozen lines inside a loop
mechanism that already exists. R4 last, and only after R2 has produced enough
artifacts to show the trigger would have been worth it.
