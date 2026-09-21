---
name: review-orchestrator
description: 'Use when: a code review is requested and the user does not name a specialized reviewer — "review", "code review", "review this PR", "review --all". Dispatches the relevant specialized reviewers in parallel and consolidates their findings into one unified report, and owns the fan-out flags "--all", "--project-conventions" and "--legacy-profiles". NOT for: running a single specialized reviewer — invoke it directly by name instead, which is also how a flag that names one domain reaches its reviewer.'
triggers:
  - "review"
  - "ревью"
  - "review code"
  - "full review"
  - "review changes"
  - "review PR"
  - "review --all"
  - "review --project-conventions"
  - "review --legacy-profiles"
metadata:
  author: "MrCipherSmith"
  version: "1.9.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review Orchestrator

Entry point for the entire review domain. This skill is a thin router: it detects scope,
dispatches specialized reviewers in parallel, then consolidates their findings into one
unified report sorted by severity. It does not perform any review logic itself.

---

## Workflow

```
Review Orchestrator Progress:
- [ ] Step 0: On a PR target, collect external comments — `keryx review comments collect`
- [ ] Step 1: Build Review Context Pack — PR metadata AND the PR's own description, scope, rules, context_doc summary, accepted memory, and the cross-repo contracts the diff consumes
- [ ] Step 2: Detect review mode (diff mode vs. path mode)
- [ ] Step 3: Build the bounded scope with `keryx review scope` — never by hand
- [ ] Step 3b: On a deep round, compute scope B with `keryx review blast-radius` — never by browsing — and KEEP the `--json` file; `review ingest --blast-radius <file>` is refused without it
- [ ] Step 4: Parse flags / auto-detect domain from scope
- [ ] Step 5: Ask user to confirm optional convention reviewers (legacy/profile reviewers are flag-only, never prompted)
- [ ] Step 6: Plan sub-agent dispatch and token budgets, and compute each dispatch's model with `keryx review tier` — never by hand
- [ ] Step 7: Stage 1 gate - spec compliance check (if issue/task provided)
- [ ] Step 8: Dispatch selected reviewers in PARALLEL with reviewer-input schema
- [ ] Step 9: Collect reviewer-finding schema results and handle NEEDS_CONTEXT
- [ ] Step 10: Wave C — dispatch `review-verifier` over the consolidated findings
- [ ] Step 11: Sort by severity, deduplicate, emit unified report
- [ ] Step 12: Emit the machine-readable `keryx:findings` block alongside the report
- [ ] Step 13: Report the stage counts: dropped by pre-filter, refuted by the verifier, retained
- [ ] Step 14: MANAGED rounds only (NEVER in `lightweight`, which is report-only), AFTER THE FINAL ROUND, on an OPEN pull request at the head you reviewed — answer every external comment once, `keryx review comments reply --final` — never against a pull request the dispatch named as the caller's
```

Step 0 runs on **every** round. Step 14 runs **once**, after the last one. They are
two commands for that reason: a caller that already runs collection per round
would carry the posting along with it, and the reviewer would get six replies to
one comment.

### Step 6 — the model is computed, not chosen

Before dispatching each reviewer, run `keryx review tier` with the signals you
already hold (`--scope`, `--findings`, `--diff-lines`, `--fix-attempt`,
`--verifier`, `--security`, `--forced-strategy-change`) and paste the `model`
block it prints into that dispatch.

Do NOT assign the tier by reading the table in `rules/core/model-selection.mdc`.
Working it out in your head is exactly the mechanical step that rule moves into
code — and it is the step that was documented as running for a whole release
while nothing called it.

It names a model only if you gave it your session (`--session-provider`/
`--session-model` or `KERYX_SESSION_*`) and discovery found another. Otherwise it prints
`inherit: true` with the tier — **adaptive**: pick your own runtime's model for
that tier (`standard` = your session model; `light`/`deep` = your runtime's
lighter/most capable class if its dispatch tool offers one, else the session
model). Never "fix" it by writing a model id into a dispatch.

---

## Step 12 — the `keryx:findings` block

The prose report is for a human. **`keryx review ingest` reads the fenced block,
not the prose**, and a round that emits only prose cannot be used to build the
next round's input — the reviewer's `confidence`, `evidence`, `impact` and
`suggested_fix` do not survive rendering, and no regex recovers what was never
written down.

So every report ends with one fenced block whose info string carries
`keryx:findings`:

````text
```json keryx:findings
[ { …one object per finding, conforming to review-finding.schema.json… } ]
```
````

Rules:

- **Exactly one block per report.** It is the array the reviewers returned,
  carried through — not re-derived from the prose above it. A second block is a
  hard error naming both offsets: reviewers are consolidated by merging their
  findings into one array, never by concatenating one block each.
- The fence may be indented up to three spaces (CommonMark), which is what
  happens when the block is nested under a list item. Beyond that it is not a
  fence and ingest will not see it.
- Each object conforms to **`review-finding.schema.json`** — the same contract
  `prior_findings[].finding` is validated against, which is why the block
  round-trips. Unknown per-finding properties are **dropped, not rejected**:
  ingest writes exactly the properties that contract names, so anything else you
  put on a finding is silently discarded rather than flagged. Pipeline triage
  fields (`classification`, `flow_relevance`) are not finding properties at all;
  they are the orchestrator's judgement, not the reviewer's, and are recorded in
  `decisions.md`.
- `reviewer` is the reviewer that actually produced the finding. Never the
  orchestrator's own name — that is the field whose loss made round 2
  unconstructible.
- **A block that is present but unusable fails loudly.** Ingest refuses a block
  it cannot parse, and equally refuses one that parses to something other than
  an array of findings (or a single `{ reviewer, findings }` result) — `null`
  included. It never falls back to parsing the prose, because a silent fallback
  would reintroduce exactly the lossy path this replaces while the report still
  visibly carries the structured array.

A report without the block is still readable by a human and still ingestible by
the legacy Markdown path — but it is a **legacy** report. Four fields the prose
does not carry (`impact`, `suggested_fix`, `evidence`, `confidence`) are written
with an explicit `not recorded:` provenance where the report supplies nothing,
and `confidence` is stamped `low` because a regex over prose is a low-confidence
derivation whatever the reviewer believed. Such a round **can** still seed a fix
round — that is the point of keeping the parser — but it seeds one that knows
which of its inputs were recovered and which were never written down.

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `flags` | string[] | no | One or more of: `--frontend`, `--backend`, `--architecture`, `--security`, `--performance`, `--style`, `--clean-code`, `--highload`, `--project-conventions`, `--frontend-conventions`, `--testing-practices`, `--core-boundaries`, `--flow-graph`, `--legacy-profiles`, `--code-ai`, `--learned`, `--code-style`, `--mobx-store`, `--verify`, `--all` |
| `path` | string | no | File or directory path to review (e.g., `src/stores/`, `src/components/UserCard.tsx`). Activates **path mode** — reviews the files at this path directly, not a git diff. |
| `commit_range` | string | no | Explicit commit hash or range (e.g., `abc123..HEAD`). Overrides merge-base detection. Ignored in path mode. |
| `issue_url` | string | no | GitHub issue or task URL. If provided, Stage 1 gate checks spec compliance before dispatching reviewers. |
| `context_doc` | string | no | Path to job context document (e.g., `.metaproject/jobs/<job>/ai/context.md`). |
| `context_mode` | string | no | `none`, `light`, or `full`. Default: `light` for PR review, `none` for small path reviews. `full` may call `context-collector` before dispatch. |
| `token_budget` | object | no | Optional budget controls: `{total, per_reviewer, diff_max_chars, file_max_chars}`. |
| `model_strategy` | string | no | `ask` or `adaptive`. Default: `adaptive`; the model per dispatch is computed by `keryx review tier`, never chosen by hand (see Step 6). |
| `managed_review` | object | no | Optional managed review mode: `{mode, target, target_ref, flow_id, reviewers}` where mode is `lightweight`, `attach-review`, `review-flow`, or `ingest`. |
| `verification_mode` | string | no | `off`, `annotate`, or `filter`. Default `annotate` — verdicts are recorded and nothing is removed. See Wave C. |
| `pr_comments` | object | no | `{enabled, max_replies_total, max_sentences_per_reply}`. Defaults: enabled when a PR exists, `30`, `2`. Collect every round, reply once at the end. See External PR comments. |

---

## Managed Review Feedback Loop

A **first-pass** review is lightweight by default: emit the consolidated report
only and create no Task Manager artifacts. Use managed mode when requested by the
caller or when an unambiguous related flow is detected and the caller accepts
attachment.

**A fix round is managed, not optional.** Before dispatching reviewers on any
round where `is_fix_round: true`, run `keryx review start --target <kind> --ref
<ref>`; after synthesis, run `keryx review ingest --report <path> --ref <ref>`.
A round whose findings were never ingested cannot be cited as a completed round,
because nothing durable records what it found.

The reason is measured, not theoretical: eleven review rounds across flows 127
and 128 ran without this. `.metaproject/data/reviews/` did not exist afterwards.
Every finding lived in a chat transcript and, later, in hand-written journal
prose — so round N+1 had nothing to diff against, `prior_findings` could not be
populated from anything but memory, and `keryx memory ingest --from-review` had
no input. The loop that produced "reviewers keep finding problems in fixes"
starts here.

Runtime CLI surface:

```text
keryx review attach --flow <id> --target <kind> --ref <ref>
keryx review start --target <kind> --ref <ref>
keryx review ingest --report <path> [--flow <id>] --ref <ref>
                    [--verifications <file>] [--verification-mode off|annotate|filter]
                    [--scope <scope.json>] [--blast-radius <blast-radius.json>]
                    [--refuted <file>]
                    # --blast-radius is REQUIRED whenever this round dispatched a
                    # scope-B reviewer (review-regression). See below.
keryx review status <review-id-or-path>
keryx review complete <review-id-or-path>
                      [--finding <id> --disposition <state> --evidence <ref>]...
```

**An unrecognised option is refused, not ignored** — a misspelled flag exits
non-zero rather than printing `status: closed` and writing nothing at all.

`--verifications` takes what `review-verifier` returned. `--scope` takes the
whole `--json` output of `keryx review scope`, so the package records what the
pre-filter dropped, **with a reason per drop**, as well as what the verifier
refuted. Without it — and with no `## Pre-filter scope` block already in the
package — the record says **`not recorded`** for that stage rather than `0`;
"dropped nothing" and "never ran" are different facts.

`--blast-radius` is **not optional on any round that dispatched
`review-regression`** — which is every `recommended` and `full` round, because
`review-regression` is in both profiles. AC3 is enforced in code: an ingest
carrying a scope-B finding with no blast-radius record is **refused**, and the
round is not recordable until the set is supplied. Pass the `--json` output of
`keryx review blast-radius` — the same record you computed at dispatch time to
bound the round.

Two channels, and both work:

- `--blast-radius <file>` — always correct, and the one to use.
- `.metaproject/reviews/blast-radius.json` (or
  `.metaproject/flows/<flow>/reviews/blast-radius.json` for a flow-attached
  round) — the handoff slot, read when no flag is passed. The ingest **consumes**
  it: it is copied into the package it screened and removed from the slot, so a
  later round cannot be screened against a set nobody recomputed.

Do **not** write the record inside the package directory before the ingest. A
round that names no `--review-id` has not allocated that directory yet, and
creating it makes the ingest take the next free name instead.

`--refuted` takes the findings this round **raised and then dismissed**, in the
same finding shape, each carrying `disposition: {state, evidence}` with one of
the `dismissed-*` states. Without it a package keeps only the survivors of an
unlogged triage — which is why precision measured over the recorded corpus
returns 100% whatever the reviewers actually got right.

`review complete --finding <id> --disposition <state> --evidence <ref>` records
what became of a finding when the fix round closes; the triple is repeatable, one
group per finding. States: `unknown`, `acted-on`, `dismissed-incorrect`,
`dismissed-wont-fix`, `dismissed-out-of-scope`, `dismissed-deprioritised`.
Everything except `unknown` must cite where the outcome is written down — the
commit, the test, the decision. A recorded state and its citation cannot be
overwritten by a later close; record a correction as a new round.

**Closing a fix round without dispositions leaves every finding reading
`unknown`.** That is not "the reviewers were right"; it is "nobody wrote down
what happened", and it is the single reason the precision figure cannot be read.

Managed modes:

- `lightweight`: report-only; no flow or managed review artifacts are created, and nothing is posted — no `comments reply`.
- `attach-review`: write under
  `.metaproject/flows/<flow-dir>/reviews/<review-id>/`.
- `review-flow`: write under `.metaproject/reviews/<review-id>/`.
- `ingest`: convert an existing review report into managed findings, decisions,
  and learning handoff, attached to a flow when one is explicit or matched.

Required artifacts for managed modes:

- `manifest.json`
- `scope.md`
- `coverage.md`
- `report.md`
- `findings.json`
- `learning.md`
- `decisions.md`

When attaching to a flow, resolve the flow by explicit `flow_id`, PR URL, issue
URL, or branch metadata. Never mutate `.metaproject/flows/*/flow.json` from
review code; Task Manager state changes remain owned by `keryx flow`.

---

## External PR comments

A human or a bot reviews our pull request. Before this existed, nothing collected
it, nothing fixed it and nothing answered it — silence was the behaviour for every
comment, and to the person who wrote it silence is indistinguishable from
disagreement.

**Collect every round. Answer once, at the end.** Both halves are mechanical and
both live in the CLI; the judgement — is this comment right, what do we say — stays
here.

```text
keryx review comments collect --repo <owner/repo> --pr <n> --sha <head-sha>
                              [--self <login>] [--round <n>] [--out <findings.json>] [--json]
keryx review comments reply   --repo <owner/repo> --pr <n> --outcomes <file|->
                              --review <review-id> --sha <head-sha> --final [--dry-run]
                              [--max-replies <n>] [--max-sentences <n>] [--max-chars <n>]
                              [--flow-link <url>]
```

Add `--fixtures <dir>` to either to run the whole loop against JSON on disk —
no token, no network, nothing posted. Use it to see what a reply pass would say
before it says it.

`--sha` is the pull request's **current head**, and it is required. `collect`
prints the PR's state and head and warns when they disagree; `reply` **refuses** a
closed or merged PR (`--allow-closed-pr` overrides), an unreadable one, and a `--sha`
that is not its head. The completion gate compares the recorded SHA as well; a
record with no SHA reads as "cannot be shown current", never as "fresh".

### What collection does, so you do not do it by hand

- Reads **all three** sources: inline review comments, review submissions and
  their bodies, and PR-level discussion.
- **A bot reviewer is a reviewer.** CodeRabbit, Greptile and Copilot comments go
  down exactly the same path as a human's. The bot flag is recorded so a report
  can say who spoke; nothing filters on it.
- Excludes our own identity, and comments already answered — **unless** the thread
  has a newer reply from somebody else, which makes the comment new again.
- Everything filtered is listed with its reason. A filter that removes silently
  reads as "nobody commented".

### Severity is classified, never invented

A comment on a review whose state is `CHANGES_REQUESTED` starts at **`major`**.
Everything else starts at **`minor`**. There is no third rule and no model call.

When the classifying fact is missing — an inline comment whose parent review was
not returned, or a review state GitHub does not document — the comment is **not
dropped and the severity is not guessed**: it takes the `minor` floor and carries
`basis: unclassified` naming what was missing. A derived `minor` and a defaulted
one are different claims, and a record that cannot tell them apart is the
`dismissed-out-of-scope: 0` failure in a new field.

You may **lower** a severity only by assigning a terminal disposition with a
reason. You may never silently drop an external comment.

### The verifier cannot refute an external comment

An external finding enters the same fix loop as an internal one with one
exception: **a `refuted` verdict does not remove it and does not dismiss it.** A
human asked a question; a machine deciding the question was invalid is not an
answer. `keryx review ingest` turns that verdict into the disposition
`answered-disagree`, keeps the finding, and records the reclaim in `scope.md`.
`answered-disagree` still owes a reply explaining why.

The per-reviewer findings cap does not truncate external comments either, for the
same reason: the cap drops silently, and an external comment may not be dropped
silently.

### Replying — once, at the end, briefly

The reply pass runs **after the final round and before the completion gate**, so
every reply states a settled outcome rather than an intention. `keryx review
comments reply` refuses without `--final`; it is not a reminder you can skip.

| Outcome | Reply is |
|---|---|
| `acted-on` | one sentence naming what changed, plus the commit SHA |
| `answered-disagree` | one or two sentences on why not, and a link to the flow's journal entry |
| `dismissed-out-of-scope` / `dismissed-deprioritised` | one sentence, and where it was recorded instead |

Rules, all of them enforced in code rather than asked for here:

- **At most two sentences per comment.** A longer reply is CUT to two and the
  remainder is replaced by a link — the long version is not reachable from the
  command's output. A truncation with no link to point at is refused outright: the
  conclusion posted and the explanation nowhere is worse than either alternative.
- A fenced code block in a reply is refused. Link, do not paste.
- Replies go **in the thread**. A review submission body and a PR-level comment
  have no thread — GitHub offers no reply endpoint for either — so those become one
  top-level comment that names what it answers.
- **Never resolve or hide a thread we did not open.** Replying is ours; resolving
  is the reviewer's call, and auto-resolving is how a bot silences a human. The
  resolve, hide, minimise and dismiss endpoints are unreachable through the port
  this command uses, GraphQL included.
- Exactly **one** reply per comment, and one disposition. A round that changed
  nothing for a comment still gets a reply saying so, with a terminal disposition
  — `unknown` is refused, because it is what an unanswered comment already reads
  as.
- Capped at **30** replies. Beyond it, one summary comment and a backlog reported
  by id.
- Handling is durable: `.metaproject/reviews/pr-comments/<owner>__<repo>__<n>.json`
  records id, thread, author, url, first-seen round, handled-at, sha, disposition
  and reply url, written after **every** post. A resumed session answers nobody
  twice.

**The trade-off, stated rather than hidden:** a reviewer who comments early waits
until the end. That is deliberate — answering with a work-in-progress state that
later changes is worse. If a comment **blocks** progress rather than reporting a
problem, mark its outcome `escalate: true`: it leaves the reply queue, is reported
to the operator immediately, and the command exits non-zero. Answering a blocking
question at the end answers the wrong question late.

### A round never answers a pull request another skill is answering

`review-pr-feedback` is the entry point for the other direction of this pipe: a
human or a bot has already reviewed pull request `#A`, and someone wants those
comments interpreted, checked against the code, fixed and answered. Under its
`--fix` mode it dispatches `flow-orchestrator`, which opens a **second** pull
request `#B` carrying the fix, based on `#A`'s own head branch, and dispatches
**this** orchestrator on every round against `#B`.

`#B` is its own conversation. Collect and reply on it exactly as always: someone
reviewing the fix deserves an answer from the run that made the fix, and its
record is filed under `#B`'s own number, so nothing about `#A` is touched.

The rule is about the other pull request:

- **Never run a reply pass against a pull request the dispatch named as the
  caller's.** When `constraints` says the caller owns the reply for `#A` — or
  the target resolves onto a pull request another skill declared — collect if the
  round needs the record and stop there. `review-pr-feedback` answers `#A` once,
  after the merge, from the outcomes its own verdicts produced.

  The harm is not a duplicate. `collectPrComments` skips a comment whose record
  carries a `reply_url` as `already-handled`, rescuing it only when somebody else
  posts later in the thread — so a round that answered mid-loop writes that record
  FIRST, and the post-merge reply citing the merge SHA is then skipped as already
  answered. The reviewer keeps the interim answer, which by then has stopped being
  true, and `replies.posted` counts only what went out. A suppressed correction is
  worse than a duplicate, because nothing shows it is missing.
- **Absent such a constraint this orchestrator owns the reply**, as it always
  has. A top-level review of a pull request is the normal case; a caller holding
  the conversation is the exception, and the exception declares itself.
- The reply is the only thing that moves. Collection, severity classification,
  the refusal to let the verifier refute an external comment, and the cap
  exemption are unchanged in both shapes.

---

## Everything written to GitHub is brief

One rule, applied to every outward surface: **PR bodies, PR comments, review
replies, issue comments, and commit messages going to a PR.**

- Lead with the conclusion. No preamble, no restating the question, no apology,
  no summary of the flow.
- Say what changed and where. **Link, do not paste.**
- The reasoning, the evidence, the rejected alternatives and the round history live
  in the flow package — `journal.md`, `context.md`, the review artifacts — which is
  durable, searchable, and costs a reader nothing to skip.
- A GitHub artifact that needs more than a short paragraph is a signal that the
  detail belongs in the flow with a link out, **not** that the paragraph should
  grow.
- No orchestrator-written PR comment or reply exceeds two sentences without
  carrying a link to the artifact holding the detail. The reply pass enforces
  this; for anything else you write outward, hold yourself to it.

This is deliberately asymmetric: **verbose in the flow, terse on GitHub.** The
flow is written for whoever resumes the work; GitHub is read by someone who did
not ask for our reasoning and is reading between other tasks.

## Review Context Pack

Before routing reviewers, build a compact `review_context` object. This is the shared source of truth for all sub-agents and must follow `.metaproject/skills/gdskills/review/review-orchestrator/review-context.schema.json`.

Required content:
- Request: raw user request, flags, review mode, explicit paths or commit range.
- Git/PR metadata: repo, branch, base, head, merge-base, PR number/URL when available.
- Scope summary: changed files grouped by domain, high-risk files, generated/ignored files.
- Requirements: issue URL, linked task docs, acceptance criteria extracted from `context_doc` when available.
- **The PR's own description**, fetched not assumed: `gh pr view <n> --json title,body`, into the typed `pr.body`. See below.
- **Cross-repo contracts the diff depends on**, in the typed `cross_repo`: each pinned to the ref you read it at, and each recording whether the producer has merged. See below.
- Rules: matched repository rules and convention docs by path.
- **Memory: accepted project memory intersecting the changed paths.** See below — this step is required, not best-effort.
- Decisions: why each reviewer was selected or skipped.
- Token policy: effective budget, truncation decisions, files summarized instead of fully inlined.
- Legacy/profile reviewer availability and selection state.

### The PR description is evidence, not decoration

Fetch the body into `review_context.pr.body` and hand it to every reviewer. It is
the author's own statement of what the change does, and it is checkable against
the diff.

**A description that promises an approach the diff does not take is a `minor`
finding** — file it, do not merely mention it. The failure this catches is
specific: over a multi-round review the code moves and the description does not,
so by round three the PR body describes an approach that was deleted in round one.
Whoever reads the merge commit a year later reads the description, not the rounds.

It is `minor` and not `major` because nothing at runtime is wrong. It is a finding
and not a pleasantry because unfiled housekeeping is raised again every round and
fixed in none — three consecutive rounds of "still worth rewriting" is the
recorded outcome of leaving it out of the findings array.

**The Stage 1 gate files it.** Handing the body to every reviewer is what makes
the body available; it is not what makes the comparison happen. A rule addressed
to everyone is owned by no one, and that is the state this finding sat in for
three rounds. The gate already holds the stated intent and the diff side by side,
so the comparison belongs there — see `## Stage 1 Gate — Spec Compliance`.

Same class, same severity: an approach that depends on another repository's change
being deployed first, with no deploy note saying so. Note the boundary — that
`minor` is about the *description*. When the dependency is real and this change
can merge first, the blocker is filed against the call site instead; see
`### A producer that has not merged yet`.

### Cross-repo contracts are read, not assumed

When the diff consumes a contract owned by another service — a payload shape, a
status enum, a timeout, a permission, a default — **read the producer** and pin
the SHA:

```yaml
cross_repo:
  - repo: vantage-backend
    state: merged
    sha: f5219d5d4
    merge_order: independent
    reason: "DQ report payload: which halves are null vs 0"
    facts_pinned_round: 1
    facts:
      - "sqlScore/schemaDriftScore stay null when the half is absent"
      - "sqlWeightPercentage/schemaDriftWeightPercentage init to 0.0 and are set unconditionally"
```

Put the facts in `review_context.cross_repo` so every reviewer shares one reading,
and so a later round can tell a contract that moved from a reviewer that misread
it. The shape is typed in `review-context.schema.json`: `repo`, `reason`, `facts`
and `state` are required, `state: merged` requires the `sha`, and `state: open`
requires the `pr`.

The rule that follows for reviewers, and that belongs in the dispatch prompt:

> **A claim about another service's behaviour, with no `file:line` at a pinned SHA
> behind it, is `info`.** Not `major`, however confident. The two failure modes are
> symmetric and both recorded: a finding asserted from the consuming side that the
> producer disproves, and a defect missed because the producer's actual default was
> assumed rather than read.

If the other repository is not available to you, record it as
`state: unavailable` in `cross_repo` and leave the dependent findings at `info`.
An unavailable producer is a result. Assuming one is not.

A finding whose evidence lives in the producer sets `repo` on the finding itself.
`file` and `line` alone name a path in the repository under review, so without
`repo` a cross-repo claim cannot say where its evidence is — and the `info` rule
above then rests on nothing a later round can check.

### A producer that has not merged yet

`state: merged` is the easy case: the contract is on the producer's base branch,
you pin the SHA, and it stays where you pinned it. A **parallel pull request** —
the backend change your change was written against, still open — is a different
object, and pinning it the same way is wrong in three separate ways.

**Pin the pull request, not just the commit.** An open branch gets rebased and
squashed. A SHA read from it today names a commit that will not exist after the
merge, so `state: open` requires `pr` and the SHA becomes a note about when you
read it rather than an address a later reader can follow.

**Merge order is a `blocker`, not a note.** A missing deploy note in the PR body
is `minor` — that is a documentation finding and it stays where it is. The
operational case is not that one: when an entry is `state: open` with
`merge_order: producer_first`, and this change can merge without the producer,
**production breaks the moment it does**. That is a `blocker` under the existing
enumeration, not a new shape — the consumer calls what is not there, or reads a
default the producer has not changed yet, which is shape 1 or shape 2 in
`### \`blocker\` — merge-blocking, and nothing else`. File it against the consuming
call site rather than the description, and write the fix as what it is: a merge
gate, a flag, or a fallback, never an edit to a diff that may be perfectly
correct. Scope it exactly — both facts have to be recorded, an open producer AND
a producer-first order, and no gate already holding the merge. A
`merge_order: unknown` is a question to resolve, not a blocker to file.

**Re-read an open producer every round.** `facts` pinned in round 1 are a
statement about a branch that is still being written; by round 3 the contract may
have changed under a finding that still cites it. On each round, re-read every
entry with `state: open` and set `revalidated_round`. An entry whose
`revalidated_round` is behind the current round has not been checked this round,
and findings resting on it drop to `info` until it is. This is the same discipline
`prior_findings` already imposes on the local diff, applied to the one input that
is most likely to have moved.

### Memory (required)

Run, once, per review:

```bash
keryx memory search "<changed modules and the concepts they touch>" --status accepted
```

Put the matched entries in `review_context.memory` and in each reviewer's
`metaproject.memory`. Record `query` alongside them so the search is
reproducible, and set `searched: false` **only** when the memory module is
disabled — an empty `entries` with `searched: true` means the search ran and
matched nothing, which is a different fact and must stay distinguishable.

Two rules, both load-bearing:

- **`--status accepted` only.** A draft entry is a hypothesis. Handing one to a
  reviewer as project truth is how a wrong hypothesis becomes a wrong finding.
- **Scope it to the change.** The whole memory index is not context; entries
  whose recorded scope does not intersect the changed files or modules are noise
  that costs budget in every reviewer prompt.

Why this is required rather than advisory: `keryx flow init` already collects
memory automatically for an implementation flow, and the review pipeline
collected none for eleven rounds across flows 127 and 128. A recorded lesson
naming the exact failure those rounds kept repeating existed the whole time and
never reached a reviewer.

Context modes:
- `none`: no additional context collection; use only diff/path and local rules.
- `light`: default for PR review. Read existing `context_doc`, local `AGENTS.md`/`CLAUDE.md`, and matching rule files. Do not browse external docs.
- `full`: for large/high-risk PRs or user request. Invoke `context-collector` first, then pass the resulting context path and summary to reviewers.

High-risk triggers for `full` recommendation:
- Auth, permissions, API contracts, migrations, shared core, state management, graph/flow, security, performance-critical paths.
- More than 20 changed source files or more than 2,000 changed lines.
- Missing or ambiguous linked requirements.

If `full` context would be useful but was not explicitly requested, ask once:

```text
This PR touches high-risk areas. Build full review context before dispatching reviewers?

  A) Yes - collect full context first (recommended)
  B) No - use light context and continue

> pick a letter (default: A)
```

---

## Token and Context Budget Management

The orchestrator owns token budget. Sub-reviewers should receive only the context needed for their domain.

Budget rules:
- Compute a scope digest before dispatch: file list, diff stats, module map, and top risks.
- Send full diffs only for files relevant to each reviewer.
- For large files, send changed hunks plus nearby symbols first; include full file only when path mode or the reviewer requires whole-file context.
- Never send generated files, lockfiles, snapshots, build output, or vendored code unless the reviewer is specifically about that file type.
- Cap each reviewer prompt with `per_reviewer` budget when provided; otherwise use the smallest prompt that preserves evidence.
- Record omitted files and truncation in `review_context.token_policy.omissions`.
- If a reviewer returns `NEEDS_CONTEXT`, provide only the missing targeted context, not the entire repository.

Default budget guidance:

| Review size | Detection | Context mode | Dispatch style |
|---|---|---|---|
| small | <= 5 files and <= 300 changed lines | `light` | full relevant diff to selected reviewers |
| medium | <= 20 files or <= 2,000 changed lines | `light` | per-domain filtered diff |
| large | > 20 files or > 2,000 changed lines | ask `full` | staged waves by domain |
| high-risk | auth/API/core/security/data migrations | ask `full` | staged waves, verifier included |

---

## Model Strategy

The model for each dispatch is computed, not chosen — see Step 6. Before every
reviewer dispatch, run `keryx review tier` with the signals you hold and paste
the `model` block it prints into that dispatch. Do not assign a model class by
reading a table or by hand; that mechanical step is exactly what the command
replaced (see Step 6 above and `job-orchestrator` Step 5, which pins the same
rule: `model_strategy: "current"` is gone).

`model_strategy` now governs only how the *computed* model is surfaced, not
whether it is computed:

| `model_strategy` | Behavior |
|---|---|
| `ask` | Present the `keryx review tier` model plan once before dispatch. |
| `adaptive` (default) | Dispatch on the computed model directly; record the chosen model per reviewer in the final report metadata. |

Rules:
- Never write a model id into a dispatch by hand — paste the `model` block `keryx review tier` printed.
- `inherit: true` is the adaptive answer: dispatch on your runtime's model for the block's `tier` (Step 6). Record `model_assignment: adaptive` and the model you actually chose — not a failure.
- With `model_strategy: ask`, present the model plan once before dispatch, then proceed with the computed model.

---

## Scope Detection

### Step 0: Is this a fix round?

A **fix round** is any review of work produced to answer earlier findings. Set
`is_fix_round: true` on every reviewer input, and populate `prior_findings` with
the earlier findings and the disposition the fix claimed for each.

**Nothing refuses a dispatch that omits them.** `reviewer-input.schema.json`
states the rule and no production TypeScript loads that schema; reviewer
dispatch is an action the host agent takes, not a `keryx` invocation, so there
is no point at which a malformed dispatch could be rejected. `reviewer-input` is
also absent from the `CONTRACTS` registry (`src/gdskills/contracts.ts`), so
`keryx skills contracts validate` cannot be pointed at it either.

So this is a requirement on you, unenforced, and the only evidence it was met is
the `prior_findings` array the reviewer actually receives. A reviewer that cannot
see what the fix was answering cannot tell whether the fix is complete.

Two scope rules apply, and they exist because breaking them is what produced
seven rounds on PR #215 and four on PR #216:

1. **Review `merge-base..HEAD`, never the fix commit alone.** Narrowing to the
   newest commit is the intuitive move and it is wrong: it hides the blast
   radius. A fix that changes a guard, an instruction, a refusal or a helper
   makes every *other* site that names it wrong, and those sites are outside the
   fix commit by construction.

2. **Enumerate what NAMES the thing the fix changed.** For each guard,
   instruction, message, refusal or helper the fix touched, grep for its callers
   and for the text that recommends it, and record the result in
   `review_context.scope.files`. On PR #216 a round corrected one operator
   instruction of four; the correction silently broke the other three, and
   nothing looked for them because nothing was asked to.

Recording the enumeration matters as much as doing it: a round that searched and
found nothing is a different fact from a round that never searched, and only the
recorded list distinguishes them.

#### Every prior finding leaves the round with a disposition

A fix round that reports only new findings is unreadable: the author cannot tell
which of their fixes landed. Close the loop explicitly — one line per prior
finding, in the report, before the new findings:

| Disposition | Meaning |
|---|---|
| `closed` | Checked against the code, not against the commit message, and the defect is gone |
| `open` | The fix does not reach the defect; say what is still true |
| `partial` | One site of the class was fixed and the enumeration named others |
| `regressed` | The fix removed this defect and introduced another — file the new one separately |
| `withdrawn` | The finding was wrong. See below |

**Check the code, not the commit message.** A commit titled *"report an abandoned
sync as abandoned"* is a claim; the disposition is whether the branch it renamed
is reachable and pinned. On a recorded round, two such commits asserted behaviour
on lines no test could reach.

#### A fix is a change, and changes get reviewed

The most expensive class in a multi-round review is **the defect the fix
introduced**. It is systematically under-found, for a structural reason: the fix
arrives framed as the answer to a finding, so it is read as an answer rather than
as new code. It is new code.

So scope A of a fix round includes the fix, reviewed on its own merits, and the
report carries its own section:

```markdown
## Regressions the fixes introduced
<[F-NNN] — the finding it was answering, and the new defect it created>
```

Recorded shapes, all from fixes that correctly closed the finding they answered:
an early return added to stop a fall-through, which then skipped the work the
caller needed; a persistence call added to save expanded state, which then
persisted the broken state on the error path too. Both were closed correctly and
both shipped a new bug in the same commit.

#### Withdrawing your own earlier finding

A finding from a previous round that this round disproves is **withdrawn**,
explicitly, at the top of the report, with the evidence — before any new finding.

This is not a courtesy. An uncorrected wrong finding costs the author a fix they
did not need, and it stays in `prior_findings` steering later rounds. Withdrawal
is also the one self-correction this pipeline permits, and it is permitted because
it is asymmetric: it *deletes* a claim, so it cannot inflate the finding count,
which is the failure mode that removed the re-scoring pass from Wave C.

State what made the original claim wrong, in one sentence, and if the same
reasoning error has now happened twice in one review, say that too. A reviewer
that names its own recurring error is calibrating; one that quietly drops a
finding is hiding a result.

### Step 1: Determine Review Mode

Before anything else, determine whether the request is **diff mode** or **path mode**:

**Path mode** is active when ANY of these is true:
- User explicitly provides a file or directory path (`src/stores/`, `src/components/UserCard.tsx`)
- User names a specific module, component, or store: "review the UserStore", "review the pipelines module", "review src/auth/"
- User says "review [the entire / whole / all of] X" where X is a module name, not a branch name

**Diff mode** (default) is active when:
- No path or target name provided
- User says "review", "review my changes", "review PR", "review this branch"

---

### Diff Mode

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

Run the script to determine `BASE_SHA`, then let the pre-filter build the scope:

```bash
keryx review scope --ref "${BASE_SHA}" --json > scope.json   # KEEP THIS FILE
keryx review scope --ref "${BASE_SHA}" --scoped-diff         # what reviewers get
```

**Keep `scope.json` until the round is ingested, and pass it as `--scope`.** That
file is how the drop list reaches the review record. `--append
"<review-package>/scope.md"` also writes it and is still supported — it now
REPLACES an existing `## Pre-filter scope` block rather than adding a second, and
`review ingest` carries any block it finds forward verbatim rather than
overwriting it — but `--scope scope.json` is the supported path, because it is
the one that does not depend on running two commands against the same file in the
right order.

**Do not run `git diff` yourself, and do not decide what to leave out.** The
pre-filter is deterministic code with no model call: it drops generated,
lockfile, snapshot, vendored and minified paths, drops whitespace-only and
comment-only change blocks, and bounds every retained change to ±20 lines of
context (`--context <n>`) instead of the whole file. Dropping a lockfile needs no
judgement, so it does not get one.

The record carries the retained scope **and every drop with its reason**. Both
halves are required: a scope that shrank without saying so reads afterwards as
"we reviewed everything". Note that `--scope` takes the WHOLE `--json` document —
handing over only its `counts` object is refused, because eight integers carry no
reason for any individual drop.

Use `.files` from `scope.json` for the auto-detection table below. A dropped path
must not select a reviewer, and **neither may a blast-radius path**: scope B is
under regression check, so a `.tsx` file that only appears there must not pull in
`review-frontend`. Reviewer selection is driven by the scope-A file list alone.

Scope is limited to **changes introduced in the current branch since merge-base**.

---

### Scope B — the blast radius (deep rounds)

Everything above is **scope A**: the change, bounded. It answers *is this change
correct?* It does not answer *did this change break something that was working*,
and those are different questions — only the first has ever been asked here.

A deep round dispatches under **both**. Scope B is computed, never browsed:

```bash
keryx review blast-radius --ref "${BASE_SHA}" --json > blast-radius.json   # KEEP THIS FILE
keryx review blast-radius --ref "${BASE_SHA}" --brief                      # what a scope-B reviewer is told
```

**KEEP THIS FILE** is not advice. The ingest at Step 12 is **refused** if a
scope-B finding arrives without it — pass it back as
`review ingest ... --blast-radius blast-radius.json`.

It walks `gdgraph affected` outward from every changed file, ranks by edge
distance, keeps distance ≤ 2, cuts at 40 files closest-first, and adds a changed
file's naming-related tests when the graph did not already reach them. Requires a
built graph — run `keryx gdgraph build` if it refuses.

**Do not pick the files yourself, and do not widen it.** "Review the
functionality so nothing breaks" naively means "review the whole repository every
round", which is unaffordable *and* actively harmful: review quality decays as
context grows — measured F1 0.65 at round 2 falling to 0.29 at round 10. An
unbounded scope B makes later rounds worse than earlier ones.

The bounds are measured on this repository, not guessed: at depth 2 the set is a
median of 19 files (p90 65); depth 3 buys eight more in the median and doubles
the p90. The 40-file cap fires on 25% of commits and removes only hop-2 entries
on all but 2 of 80, so it almost never costs a direct dependent — and when it
does, it says so.

**Record the whole thing.** `--out "<review-package>/blast-radius.md"` writes the
set, the depth, and **every file the cap removed**. A truncation nobody can see
reads afterwards as "we checked everything", which is the claim this pipeline
exists to stop making. An empty radius is reported as `unresolved`, not as clean:
the graph indexes code, so a change to a skill, a rule or a schema has no blast
radius at all and that is a different fact from "nothing depends on it".

#### The scope-B question, and what is rejected

> Does this change break an existing behaviour **at these sites**?

Nothing else. The blast-radius set is **under regression check, not under
review**. A finding about style, naming or architecture in code the change did
not touch is refused **by the orchestrator in code** — not discouraged here —
under three rules, every one of them a fact about the claim rather than about who
made it:

| Rule | Refused because |
|---|---|
| `outside-set` | the file is neither in the computed set nor in the changed set; the reviewer went browsing |
| `non-regression-severity` | below `major`. Under the canonical rubric `minor` states the code behaves correctly and `info` names neither trigger nor outcome; neither can be a claim that something broke |
| `no-link-to-change` | nothing in the finding names a changed file, module or symbol. A regression claim says THE CHANGE broke this site |

Rejections are **recorded, not deleted** — raise the observation under scope A or
as a separate review. Pass `--brief` output verbatim into the scope-B dispatch:
the code rejection is the enforcement, but a reviewer told afterwards has already
spent the round producing findings that will all be refused.

`class_scope` on a scope-B finding names the **caller that breaks**, not the
changed line, because that is the site a human has to look at.

#### When it is recomputed

| Round | Scope A | Scope B |
|---|---|---|
| 1 (first after the draft PR) | yes | yes |
| 2..N | yes | recomputed only if the changed-file set moved |
| final | yes | **yes, always** |

Do not decide this by memory:

```bash
keryx review blast-radius --ref "${BASE_SHA}" --previous blast-radius.json [--final]
```

It prints the decision and the reason, and reuses the previous record when
nothing moved. The final round recomputes whatever the file set did — otherwise a
fix introduced in round 3 gets no regression check at all, and the round that
certifies the flow is the one that checked the least.

---

### Path Mode

When a path or target is named, collect the candidate files:

```bash
# If a directory path is given:
find <path> -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \) | sort

# If a module name is given (e.g. "UserStore", "pipelines module"):
find . -type f -name "*<name>*" \( -name "*.ts" -o -name "*.tsx" \)
# Also check common locations: src/stores/, src/modules/, src/components/
```

Then put the list through the same exclusions before reading anything:

```bash
keryx review scope --path "src/a.ts,src/b.ts" --json > scope.json
```

Pass the full **file contents** of the paths it **retained** to sub-reviewers, and
read none of the ones it dropped. Set `SCOPE_MODE: path`. Path mode has no hunks
and therefore no context window; the drop list is recorded exactly the same way.

**Reviewer behavior in path mode:** reviewers check the entire file content — not just added lines. All findings apply to the current state of the code, not only to changes.

---

### Auto-detection of Reviewers (both modes)

When no flag is provided, infer reviewers from the collected file list:

| File pattern | Domain detected | Reviewers invoked |
|---|---|---|
| `*.tsx`, `*.jsx`, `*.css`, `*.scss`, `*.html` | frontend | `review-logic` + `review-frontend` + `review-style` |
| `*.store.ts`, files containing `makeObservable` | frontend/store | `review-logic` + `review-frontend` + `review-style` |
| `*.ts`, `*.js` in `src/api/`, `src/services/`, `src/controllers/`, `src/modules/` | backend | `review-logic` + `review-backend` + `review-architecture` |
| `*.ts`, `*.js` mixed (both UI and service files) | fullstack | all of the above |
| Migration files, `*.sql`, `prisma/schema.prisma` | backend | `review-backend` + `review-architecture` |
| `*.test.*`, `*.spec.*` | any | append `review-logic` (spec compliance focus) |
| No recognizable extension pattern | fallback | `review-logic` + `review-architecture` |

### Project Convention Auto-Detection

If the repository has local convention docs such as `CLAUDE.md`, `AGENTS.md`,
`.junie/guidelines.md`, or module-level `CLAUDE.md` files, append these reviewers by path:

| File pattern | Reviewers appended |
|---|---|
| `src/**/*.tsx`, `*.stories.tsx`, or a `.ts`/`.js` change in a repo where `package.json` declares `react`/`react-dom`/`mobx`/`mobx-react`/`mobx-react-lite` as a dependency | `review-frontend-conventions` |
| `**/*.test.*`, `**/*.spec.*`, `**/*.integration.test.*`, `**/*.msw.ts`, `src/test/**`, `test/**`, `e2e/**` | `review-testing-practices` |
| `src/core/**`, `core/**`, `shared/**`, `foundation/**` | `review-core-boundaries` |
| `src/core/flow/**`, `src/graph/**`, `src/shared/flow/**` | `review-flow-graph` |
| A `.tsx`/`.jsx`/`.css`/`.scss` hunk that adds or changes a sizing or spacing utility on a rendered element — `w-*`, `min-w-*`, `max-w-*`, `flex-*`, `basis-*`, `grid-cols-*`, `truncate`, `line-clamp-*`, `overflow-*`, `p*`/`m*`/`gap-*` and their logical `ps-*`/`pe-*`/`ms-*`/`me-*` forms, or an inline `style` carrying a dimension | `review-layout` |

These convention reviewers are additive: keep the generic reviewers selected by normal detection,
then add the matching convention pass. Deduplicate reviewer names before dispatch.

### Stack scoping — run it after detection, before dispatch

The tables above select reviewers by **file shape**. A `.ts` file looks the same
whether or not the repository has React in it, so those tables will happily
dispatch a React/MobX conventions reviewer at a Bun CLI with no frontend — which
is exactly what happened here, on every review, for months.

So the selected set is filtered once more, by what the repository actually
declares:

```bash
keryx review stack --json
```

It reads `package.json` and reports, per reviewer, `include` or `exclude` with a
reason. A reviewer carrying `metadata.stack_requires` is dispatched when **any**
tag it names is present — matching what `keryx review stack` actually computes,
and failing toward inclusion rather than away from it.

**Its failure mode is to include, never to skip.** A missing, unparsable or
unexpected manifest sets `uncertain`, and an uncertain detection marks every tag
present, so every reviewer runs. A reviewer that runs needlessly costs tokens; a
reviewer wrongly skipped hides a real defect, and that asymmetry is not close.

Record the exclusions with their reasons alongside the pre-filter drops. A
reviewer silently absent from a report reads as "it had nothing to say".

### Path gate — the second filter, same asymmetry

Stack scoping asks *does this repository have the thing*. The path gate asks *does
this diff*. A reviewer whose path triggers match **no file in scope A** is not
dispatched; it goes to `Skipped reviewers` with reason `no-matching-paths`.

This is worth its own step because `--all` is the common case and it is where the
waste is: a run of sixteen reviewers over a fourteen-file frontend diff dispatched
`review-core-boundaries` and `review-flow-graph` against a diff containing no
`src/core/**` file at all. Two agents, full prompt each, guaranteed empty.

Three bounds keep it from deleting coverage:

- **Only path-triggered reviewers.** A reviewer selected by an explicit flag, or
  one whose scope is the whole change rather than a path set — `review-logic`,
  `review-regression`, `review-verifier` — is never path-gated.
- **Scope A only.** Scope B is the blast radius; it is *supposed* to name files the
  diff never touched.
- **Ambiguity includes.** If you cannot decide whether a path matches, dispatch.
  Same asymmetry as stack scoping: a needless reviewer costs tokens, a missing one
  costs a defect.

Record every gated reviewer with the trigger set that found nothing. "Skipped:
no matching paths" is a result the reader can check; an absent reviewer is not.

### Project-local reviewers — ask, do not assume

The routing table below names the reviewers **keryx ships**. A project may also
define its own, and before this step existed they were invisible to every round:
a team could write a reviewer, register it, and watch nothing dispatch it.

So the reviewer set is asked for, not recited:

```bash
keryx review reviewers --json
```

It returns two halves. `bundled` is the installed gdskills review tree — the set
this project's install profile actually produced, which is not everything keryx
ships. `project` is every project-skill under module `review`, living at
`.metaproject/project-skills/review/<name>/` so that it sits beside
`.metaproject/skills/gdskills/review/<name>/` and needs no other marking.

**Dispatch the project half alongside the bundled one.** A project reviewer is a
reviewer: it returns `REVIEW_RESULT`, its findings merge with everyone else's,
it is bound by the canonical severity rubric and the shared laws, and it is
verified in Wave C like any other. It is not advisory and not a second-class
pass — a team that wrote down how it reviews has said something about this
codebase that no shipped reviewer knows.

Two things it does NOT get:

- **No exemption from the contract.** A project reviewer whose output does not
  conform is handled by the Sub-Agent Report Quality Gate exactly as a bundled
  one would be. Local authorship is not evidence.
- **No self-verification.** The never-self-verify rule is about the actor, not
  the origin.

**Select them with the fields the inventory returns, not by reading prose.**
Each `project` entry carries `flags` (a passed flag selects it explicitly),
`paths` + `pathsSource` (the path gate; `none` → dispatch), `stackRequires`
(stack scoping), `unresolvedRules` (dispatch, name the missing rules once in the
report) and `drift` (dispatch, name it once in the report). What each means and
what to do with it: `SKILL.detail.md` beside this file, section "Project-local
reviewers". A description saying another entry point dispatches it is its
author's routing note, not a restriction.

### Convention Reviewer Confirmation

When convention reviewers are auto-detected and the user did not explicitly pass
`--project-conventions`, `--frontend-conventions`, `--testing-practices`, `--core-boundaries`,
`--flow-graph`, or `--all`, ask before dispatch:

```text
I found local convention reviewers that match this review scope:

  A) Include all detected convention reviewers (recommended)
  B) Choose individually
  C) Skip convention reviewers for this run

Detected:
  - review-frontend-conventions: <why detected, or omit if not detected>
  - review-testing-practices: <why detected, or omit if not detected>
  - review-core-boundaries: <why detected, or omit if not detected>
  - review-flow-graph: <why detected, or omit if not detected>
```

If the user chooses B, list only detected reviewers and ask for names to include/exclude.
If the user does not answer and the review is part of an automated `job-orchestrator` pipeline,
use the job setting `convention_reviewers` (default: `"ask"`; if still unresolved, include all
detected reviewers and record that choice in the review scope).

---

## Legacy/Profile Reviewer Auto-Detection

Legacy/profile reviewers are specialized review profiles that predate the review-domain `review-*` naming. They are still valid and must be shown separately from generic and convention reviewers so the user can opt in deliberately.

| Trigger | Reviewers appended |
|---|---|
| `--legacy-profiles` | `code-ai-review` + `code-learned-review` + `code-style-review` + `code-mobx-store-review` when MobX/store files are present |
| `--code-ai` | `code-ai-review` |
| `--learned` | `code-learned-review` |
| `--code-style` | `code-style-review` |
| `--mobx-store` | `code-mobx-store-review` |
| `*.store.ts`, `makeObservable`, `observable`, `computed`, `action.bound` | suggest `code-mobx-store-review` as optional profile reviewer |

Legacy/profile reviewers are never auto-included and never prompted for — do not ask the user
about them. They are exempt from the finding contract (for example `code-ai-review` emits
free-prose Russian with no per-finding severity field, so its output cannot be normalised into
the unified report), which is why inclusion must be a deliberate, explicit act rather than a
default the user has to opt out of on every review. Dispatch them ONLY when the user passes one
of the flags in the Trigger table above, or when `job-orchestrator` provides `reviewers` /
`conditional_reviewers` automation settings that name them. The `code-mobx-store-review`
auto-suggestion (MobX/store files present) is informational only — list it in the Review Plan
Preview below, but do not dispatch it and do not ask about it without an explicit flag.

Review Plan Preview must include an `Optional legacy/profile reviewers` group and a `Skipped reviewers` group with reasons such as:

```text
Optional legacy/profile reviewers:
  - code-ai-review: available via --code-ai or --legacy-profiles
  - code-learned-review: available via --learned or --legacy-profiles
  - code-style-review: available via --code-style or --legacy-profiles
  - code-mobx-store-review: auto-suggest when *.store.ts or MobX patterns are present; available via --mobx-store or --legacy-profiles

Skipped reviewers:
  - code-ai-review: profile reviewer, not selected unless --code-ai/--legacy-profiles
  - code-learned-review: profile reviewer, not selected unless --learned/--legacy-profiles
  - code-style-review: legacy style profile, not selected unless --code-style/--legacy-profiles
  - code-mobx-store-review: not selected unless --mobx-store/--legacy-profiles or MobX store files are detected
```

## Routing Table

| Flag | Reviewers dispatched |
|------|---------------------|
| `--frontend` | `review-logic` + `review-frontend` + `review-style` |
| `--backend` | `review-logic` + `review-backend` + `review-architecture` |
| `--architecture` | `review-architecture` |
| `--security` | `review-security-code` |
| `--performance` | `review-performance` |
| `--style` | `review-style` |
| `--clean-code` | `review-clean-code` |
| `--highload` | `review-highload` |
| `--project-conventions` | all generic convention reviewers: `review-frontend-conventions` + `review-testing-practices` + `review-core-boundaries` + `review-flow-graph` |
| `--frontend-conventions` | `review-frontend-conventions` |
| `--testing-practices` | `review-testing-practices` |
| `--core-boundaries` | `review-core-boundaries` |
| `--flow-graph` | `review-flow-graph` |
| `--layout` | `review-layout` |
| `--all` | all reviewers above (including `review-clean-code`, `review-highload`, applicable legacy/profile reviewers, and project convention reviewers when local convention docs exist) |
| `--verify` | `review-verifier`, AFTER all others; checks the consolidated findings by running something. Delete-only. |
| (auto) | detected from diff file extensions — see Auto-detection table |

Multiple flags may be combined: `review --backend --security` dispatches `review-logic` + `review-backend` + `review-architecture` + `review-security-code`; `review --frontend --frontend-conventions` dispatches the generic frontend set plus the local frontend conventions reviewer.

This table applies once this skill is running; reaching it is a separate question. The router strips `--`, so `review --style` is the same phrase as `review-style`'s own `style review` trigger and goes straight there — the same destination this table names, and likewise for `--architecture`, `--security` and `--performance`. Only `--all`, `--project-conventions` and `--legacy-profiles` name this orchestrator, which is why they are its triggers.
`--frontend` and `--backend` are the exception: this table fans each out to three reviewers, but a bare `review --frontend` reaches `review-frontend` alone, because `review frontend` and `frontend review` are one phrase to the router and that phrase is the specialist's — two skills may not share a trigger token set (`src/gdskills/catalog-single-source.test.ts`). Ask by name, or use `review --all`, when you want the three-reviewer fan-out; `docs/skills/rejected-skill-changes.md` records the alternatives that were measured and rejected.

---

## Stage 1 Gate — Spec Compliance

**Run this FIRST, before dispatching quality reviewers, whenever the change has a
stated intent — an `issue_url`, a task doc, or a PR body.**

1. Fetch issue or task requirements.
2. Map changed files and functions to acceptance criteria.
3. Identify any criteria that are not addressed by the diff.
4. If there are unimplemented criteria: emit them as `blocker` findings in the final report and note them in `## Blockers`.
5. Continue dispatching the remaining reviewers regardless (spec gaps + quality issues both belong in the report).

### With no issue and no task doc, the PR body is the spec

A pull request with nothing linked is the common case, not the exception, and the
gate used to skip entirely on it — which meant the only written statement of what
the change was for went unchecked precisely when it was the only one there. When
`issue_url` and `context_doc` are both absent, read `pr.body` as the spec and run
steps 2-4 against it. Nothing at all to read — no issue, no task doc, an empty
body — is itself the finding: `minor`, that the change states no intent.

### This gate owns the description-vs-diff comparison

The `minor` for a description that promises an approach the diff does not take
(see the Context Pack) is **filed here**. It was previously stated as a rule for
"every reviewer" and owned by none, which is how it stayed a remark instead of a
finding across three rounds. A domain reviewer reviews its domain; the one step
that already holds intent and diff side by side is this one.

Run it on every round, not only the first. The drift the finding catches is
created BY the rounds: the code moves to answer findings, the body does not, and
whoever reads the merge commit a year later reads the body.

---

## Dispatching Reviewers

Dispatch selected reviewers in parallel when independent. Use waves when token budget is tight or when one reviewer needs another result:

1. Wave A - core correctness/risk reviewers: logic, architecture, security/highload when selected.
2. Wave B - domain reviewers: frontend/backend/testing/convention reviewers filtered to relevant files.
3. Wave C - **verification**: `review-verifier` over the consolidated findings, when blockers/majors
   exist, `--verify` is set, or the PR is high-risk. See below.

**Execution belongs to both B and C, and they execute for opposite reasons.**
Wave C runs a command to *decide the fate of a finding that exists*; it is
delete-only and can produce nothing. Wave B runs commands to *make findings* —
`review-testing-practices` deletes each gate the diff added and records whether
the suite goes red, and `review-layout` measures rendered geometry in a real
engine.

The consequence is directional and easy to get wrong: **a surviving mutation is
not something Wave C can hand you.** If Wave B skips its mutation pass, that
finding class is unreachable for the entire round, and no amount of verification
downstream recovers it. When a testing reviewer returns without a mutation table,
treat it the way you would treat a reviewer that returned without findings *and*
without evidence: ask once, then record that the pass did not run.

### Wave C — verification, and what it replaced

Wave C used to run `review-strict`: a meta-pass that re-read the consolidated
findings and **adjusted their severity with no new evidence**, under an elevation
table biased 3:1 toward escalation. It was **removed, not improved**, and the
reason is measured rather than stylistic:

- **GPT-4 on GSM8K across self-correction rounds: 95.5 → 91.5 → 89.0.**
  **GPT-3.5 on CommonSenseQA: 75.8 → 38.1.** Among the answers that changed,
  correct → incorrect exceeded incorrect → correct (Huang et al., *Large Language
  Models Cannot Self-Correct Reasoning Yet*, ICLR 2024, arXiv:2310.01798).
- **Self-Refine (arXiv:2303.17651): +49.2 on dialogue response generation, +0.2
  on maths.** Self-refinement gains are on subjective tasks and vanish on
  verifiable reasoning. Judging whether a null-guard is missing is verifiable
  reasoning.

Re-scoring a finding by re-reading it is therefore not a rigour pass; it is a
coin flip weighted toward more findings. **Do not restore it because it looks
obviously useful — it looked obviously useful the first time.**

`review-verifier` occupies the slot and differs in exactly one way that matters:
**it runs something.** Verification that executes rejects 85–96% of false reports
against 4–15% unaided while finding 30–44% more true bugs (AnyPoC,
arXiv:2604.11950); Meta's TestGen-LLM funnel discards 75% of its own output
(75% build → 57% build and pass → 25% improve coverage) and the surviving quarter
reaches 73% human acceptance (arXiv:2402.09171).

It also **never votes.** 80+ agents unanimously endorsed a padding-oracle
vulnerability that did not exist, and a single empirical test killed it: consensus
cannot detect a hallucination its members share, so agreement between reviewers is
not evidence and must never be recorded as verification.

That rule is about agreement *standing in for* evidence. It is not a rule that
two verifiers may not both check the same finding: each claim is admitted on its
own — a named non-author, a real method, real evidence, with `reasoning` already
capped — and when two such claims reach the **same** verdict the merge records it,
naming both verifiers and carrying both pieces of evidence. Claims that
**disagree** still cancel, because there the only thing deciding the outcome
would be claim order.

Dispatch rules:

- Pass the consolidated findings, each carrying `global_id` and the **real**
  originating `reviewer`. A finding whose `reviewer` is the orchestrator cannot be
  routed away from its author, so the never-self-verify rule silently stops
  applying — that field was hardcoded to `review-orchestrator` on all 83 recorded
  findings and is fixed only from 0.2.70 onward.
- **A finding is never verified by the reviewer that raised it.** When only one
  reviewer ran, its findings are simply left unverified; verifying them yourself
  is worse than not verifying them. The merge compares the two names after
  normalising case, surrounding whitespace, `_`/`-`, and a trailing `(model)`
  annotation, so `review-logic `, `Review-Logic` and `review-logic (sonnet)` are
  all the same actor. Do not try to route around it by respelling the name — the
  comparison deliberately over-matches, because a refused claim only ever costs a
  verdict while a missed self-verification costs the finding.
- The verifier returns `verification-claim.schema.json`. Merge it with
  `keryx review ingest --verifications <file>`; do not apply verdicts by hand.
- **The verifier can only delete.** If it returns a severity, a new finding, or a
  rewritten finding, the merge discards that whole claim and records the attempt.
  Do not "help" by applying it.

### `verification_mode`

`off` | `annotate` | `filter`. **Default `annotate`, and it stays `annotate` for
one release.**

| Mode | What happens |
|---|---|
| `off` | No verification. Claims are refused rather than silently ignored. |
| `annotate` | Verdicts are recorded on the findings. **Nothing is removed.** A `refuted` finding is still reported, marked refuted. |
| `filter` | An applied `refuted` verdict removes the finding from the reported set and records it as `dismissed-incorrect`, with the verification evidence. |

`annotate` is the default so the drop rate is a **measured number** before it
costs a real finding. The risk is named rather than assumed away: SWE-agent keeps
its equivalent step opt-in because it sometimes rejects correct patches. Do not
switch a project to `filter` on the strength of one round.

### Agent Runtime Compatibility

Before dispatching a reviewer through a platform-native sub-agent mechanism, verify that the exact reviewer name is available as an agent type in the current runtime.

Runtime rules:
- If the exact reviewer agent type exists, dispatch that reviewer directly.
- If the exact reviewer agent type does not exist but `skills/<reviewer>/SKILL.md` exists, dispatch `general-purpose` and include the reviewer name, skill path, bounded review context, and required `REVIEW_RESULT` schema in the prompt.
- If neither the agent type nor the skill file exists, do not silently substitute another reviewer. Mark that reviewer as `BLOCKED`, include the missing agent/skill name, and continue only with independent reviewers.
- Record the chosen runtime per reviewer in `review_context.review_plan.dispatch_plan`.
- The user-facing progress line must be explicit: "Running `<reviewer>` via `general-purpose` fallback because native agent type is unavailable."

Do not use vague fallback messages such as "running through available agent types" without naming which reviewers used fallback and why.

Pass each sub-reviewer a payload matching `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-input.schema.json`:

```yaml
review_context: <bounded context pack>
reviewer: <skill-name>
scope_mode: diff | path
context_doc: <path or empty>
issue_url: <url or empty>
model: <the `model` block `keryx review tier` printed for this dispatch — paste verbatim>
budget:
  max_prompt_tokens: <number or null>
  max_findings: <number>

# If scope_mode = diff:
branch: <branch>
base_sha: <base sha>
diff: <filtered diff relevant to this reviewer>

# If scope_mode = path:
target_path: <resolved path or file list>
file_contents: <bounded file contents relevant to this reviewer>
```

Each reviewer must return a `REVIEW_RESULT` object matching `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, followed by a concise markdown summary. The orchestrator must reject or normalize free-form reports before consolidation.

**Important for path mode:** instruct each reviewer to check the **entire file**, not just changes. The scope report should say "Path: `<TARGET_PATH>`" instead of a branch/merge-base.

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Routing and consolidation | YES | — |
| Logic correctness | NO | `review-logic` |
| Frontend patterns (React, MVVM) | NO | `review-frontend` |
| Architectural violations | NO | `review-architecture` |
| Security vulnerabilities | NO | `review-security-code` |
| Performance anti-patterns | NO | `review-performance` |
| Style / naming / import order | NO | `review-style` |
| Checking whether a reported finding is real | NO | `review-verifier` |
| Clean Code principles + SOLID at code level | NO | `review-clean-code` |
| Concurrency, resource pools, caching, queues, idempotency | NO | `review-highload` |
| Frontend repository conventions | NO | `review-frontend-conventions` |
| Test / e2e conventions | NO | `review-testing-practices` |
| Shared core boundary rules | NO | `review-core-boundaries` |
| Shared flow/graph abstraction contracts | NO | `review-flow-graph` |
| Legacy/profile review profiles | NO | `code-ai-review`, `code-learned-review`, `code-style-review`, `code-mobx-store-review` |

---

## Sub-Agent Report Quality Gate

Before consolidation, validate every reviewer result:
- Required status: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`.
- Required finding fields: id, severity, file, `quote`, problem, impact, suggested_fix, evidence, confidence, reviewer. **`quote`, not `line`:** copy the code the finding is about verbatim out of `file` and do not count lines — `keryx review ingest` locates the quote at the round's head and derives `line` from where it matched, so a number reported here is overwritten. A model is poor at counting lines and good at repeating text it has just read; this asks only for the second. Quote enough to be unambiguous: a snippet appearing twice in the file is recorded `unlocatable` rather than anchored to the first hit. A finding about the round rather than a site carries neither.
- Every blocker must include evidence and a concrete suggested fix.
- Findings without evidence are downgraded to `info` or returned to the reviewer for clarification.
- Duplicate findings are merged by `dedupe_key` or by `(file, quote, problem)`.
- `NEEDS_CONTEXT` triggers one targeted context refill. If still unresolved, keep it as an explicit open question, not as a blocker.
- If a reviewer exceeds `max_findings`, keep blockers/majors first and summarize lower severity findings.

---

## Severity (canonical)

**This is the only severity rubric in the review domain.** Reviewers do not carry
their own. Ten private rubrics feeding one sort produce a ranking that means ten
different things at once, and ranking is what an operator uses to decide what to
read first. A reviewer may state which of *its* conditions land where; it may not
redefine the levels.

### `blocker` — merge-blocking, and nothing else

Exactly four shapes. Nothing outside this list is a `blocker`, however strongly
the reviewer feels about it:

1. **A crash** — the process, request, or render dies on an input the change
   admits.
2. **Data loss or corruption** — something persisted, transmitted, or returned is
   destroyed or silently wrong.
3. **An exploitable vulnerability** — an attacker action with a named entry point
   and a named impact.
4. **An unimplemented acceptance criterion** — the change claims work the diff
   does not contain.

Everything else is at most `major`. "This will definitely cause problems later"
is not one of the four. Neither is "this violates the architecture", "this fails
the linter", or "this is how the last outage started".

**An unshipped dependency is shape 1 or shape 2, and the list stays closed.**
When a producer is recorded `state: open` with `merge_order: producer_first` and
nothing stops this change merging first, ask the enumeration's own question —
what happens at runtime. The consumer calls what is not there (shape 1) or reads
the default the producer has not changed yet (shape 2). That is why it is a
`blocker` without a fifth shape being invented for it. Two things follow from
its being an ordering fault rather than a coding one: file it against the
consuming call site, and say in the fix that the remedy is a merge gate, a flag,
or a fallback — never a change to the diff, which may be entirely correct. A
missing deploy note with no recorded producer state behind it is not this; that
is the `minor` in the Context Pack. See `### A producer that has not merged yet`.

### `major` / `minor` / `info` — the boundary test

Ask one question, and ask it of the **finding**, not of the code:

> **Does it name a trigger, and the observable outcome that trigger produces?**

- **`major`** — it does. There is an input, a call, a render, or a load level, and
  a resulting behaviour a user or a caller would call wrong: a wrong value, a lost
  update, a leak, a hang, a cost stated together with the frequency that makes it
  a cost. Not one of the four shapes above, so not merge-blocking — but the code
  does the wrong thing.
- **`minor`** — it does not, and does not claim to. The code behaves correctly;
  the cost lands on whoever reads or edits it next, and the finding names that
  cost at a named site.
- **`info`** — it names neither. An observation, a preference, or a risk with no
  demonstrated path.

The test is procedural on purpose. It is applied by reading the finding, so
someone who did not write it — and has not read the code — reaches the same
answer: look for the trigger and the outcome. Present → `major`. Absent, but a
concrete maintenance cost is named → `minor`. Neither → `info`.

Two consequences, both previously decided differently in different files:

- A finding that **claims** runtime harm and cannot name the trigger is `info`,
  not `major`. It is not demoted to `minor`: `minor` is for findings that never
  claimed runtime harm at all. The two are different failures and stay
  distinguishable.
- Severity is a property of the demonstrated outcome, never of the reviewer that
  found it. A security reviewer's unproven concern is `info` under the same test
  that puts a style reviewer's unproven concern there.
- **And never of how crisply the finding is worded.** An outcome that costs a
  user, a caller or persisted state nothing is `minor` however precisely its
  trigger is named. Without this clause the test above rates prose quality: a
  cosmetic wording nit stated as "trigger X produces output Y" reads as `major`,
  while a real defect stated tersely reads as `info`. That is not academic — the
  findings cap truncates by severity, so the well-written typo would survive and
  the terse real defect would be cut.

The boundary this rubric does **not** draw is `major` against `major`. Two
findings that both name a trigger and an outcome are the same severity even when
one is obviously worse; the ordering inside a severity is the operator's, and
inventing a fifth level to express it would put us back where we started.

### Shared laws (every reviewer)

1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot
   name the input, call, or condition that reaches the code, you have an
   observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code
   under review. Do not report a safe API because it could be misused, or a
   pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears
   at several sites, report it once and list every site. Ten findings that are one
   finding hide the other nine problems.

`review-security-code` carries a fourth — every security finding states its attack
vector — which does not generalise and stays there.

---

## Finding Format

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

A finding anchored to one `file:line` is a claim about one site. The recorded
history of this repository is that a fix then repairs that site and leaves its
siblings: one writer of five, one operator instruction of four, six readers of
eight. Each was found by the *next* review round, which is why reviews here have
run to seven and four rounds instead of one.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
is a claim that the class has exactly one member — make it deliberately, because
`review-finding.schema.json` accepts it and the next round tests it.

`minor` and `info` may omit it: enumerating the class for every low-severity
observation is theatre, not rigour.

#### Negative enumeration — the empty set is also a class scope

Some of the strongest findings assert that something is **absent**: nothing clears
this state, nothing reads this field, this prop can never fire, no test builds this
shape. Those are claims about a set being empty, and an empty set is exactly as
enumerable as a full one — the same `class_scope` machinery carries it.

```yaml
class_scope:
  sites: []
  enumeration_method: "all 5 clearSubmitExecutionState() call sites are onUnmount,
    setActiveControl, setActiveTemplate, submitActiveControl, resetActiveControlForm;
    none reachable from a check-section edit, and there is no reaction/autorun"
```

The `enumeration_method` is the whole finding here, so it carries more weight than
usual: it must name the complete candidate set and why each member fails to apply.
"I looked and did not find one" is not that. A search that returned nothing, with
the query, is.

This form covers a class of defect nothing else in this pipeline reaches:

- **The inert change.** The diff adds a prop, a guard, a field or a branch that
  nothing can reach — a `disabled` prop on a component its parent unmounts instead
  of disabling; a field added to two type `Pick`s and never read; a `=== undefined`
  guard against a producer that never emits `undefined`. The diff looks like it
  does something and does nothing, and the reviewer that checks whether the change
  is *correct* passes it, because it is.
- **The missing clear.** State is set on one path and no path unsets it.
- **The unreachable branch.** A value the code handles that its producer cannot
  emit.

An inert change is `minor` when it is merely dead, and `major` when its deadness
means the bug it was added to fix is still live — the second is the common case
when the change was written to answer an earlier round's finding.

All findings from all sub-reviewers must be normalized to this format before consolidation:

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Repo**: producer repository — only when the evidence is not in the repository under review
- **Problem**: what is wrong
- **Why it matters**: impact on correctness / safety / maintainability / UX
- **Fix**: concrete suggestion
- **Patch** (optional):
  ```diff
  - old line
  + new line
  ```
```

Severity ordering for sort: `blocker` > `major` > `minor` > `info`.

---

### Model Metadata Rules

`adaptive` is a model-assignment outcome recorded when `keryx review tier` printed `inherit: true` and the host picked the model for the tier, not a model name. Never render it as `model: adaptive` or as the PR comment `Model` value.

When writing review report metadata or a PR comment:
1. Read `review_context.token_policy.model_plan`.
2. Set `Model strategy` from `model_plan.strategy` (`ask` or `adaptive`).
3. Set `Current model` from the first available value: `model_plan.current_model`, detected tool output, current runtime model shown by the platform, or `unknown`.
4. Record the model actually assigned per reviewer — the `tier` and (`provider`+`model` or `inherit`) from the `model` block `keryx review tier` printed for that dispatch — rather than a fixed set of classes; include `complex_model`, `normal_model`, and `simple_model` too when `model_plan` reports them.
5. If the dispatch's `model` block carried `inherit: true`, write `Model assignment: adaptive` and the model the host actually dispatched on for that tier (or `unknown`).
6. If the actual model is unknown, write `unknown`; do not substitute `adaptive` or `inherit`.

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS
```

`DONE` — no blockers or majors found.
`DONE_WITH_CONCERNS` — one or more blocker or major findings present.

```markdown
# Review Report

## Verdict: APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES
<!-- APPROVE: zero blockers/majors. APPROVE_WITH_SUGGESTIONS: minors/info only.
     REQUEST_CHANGES: one or more blocker or major. -->

## Summary
<2-4 sentences: what the change does, overall code health, key concerns.>

## Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Reviewers dispatched: <comma-separated list>
- Changed files: <count>
- Context mode: `<none | light | full>`
- Model strategy: `<ask | adaptive>`
- Current model: `<actual current model id/name, or unknown>`
- Model assignment: `<per-reviewer tier/model from each dispatch's \`model\` block | unsupported>`
- Token budget: `<used/limit if known; omissions count>`

## Stats
- blocker: N
- major: N
- minor: N
- info: N

## Stage counts
<!-- Required. State what each stage REMOVED, and never state it as a precision
     improvement: no precision baseline exists to improve on. The one measured
     from the review packages on disk was 53/53 = 100% — pinned there by
     construction, because nothing in that corpus could record a finding as
     wrong. Copy these from `scope.md`; do not re-count by hand. -->
- dropped by pre-filter: <files>, <blocks>, <changed lines> (or `not recorded` if no scope was built)
- verification mode: `<off | annotate | filter>`
- verdicts: confirmed N, refuted N, unverifiable N, unverified N
- refuted by the verifier: N (removed: N — always 0 outside `filter`)
- retained: N

## Blockers (must fix before merge)
<[F-NNN] findings with severity=blocker, sorted by file>

## Major Issues
<[F-NNN] findings with severity=major>

## Minor & Info
<[F-NNN] findings with severity=minor or info>

## Checked and cleared
<Required whenever a reviewer tested a hypothesis and it did not hold. One line
each: the defect that was looked for, and the evidence that rules it out. Not a
list of virtues — a list of hypotheses that died, so no later round spends a
reviewer re-raising them.>

## Positive Notes
<Optional. Highlight things done well. Keep brief.>
```

### Why `Checked and cleared` is separate from `Positive Notes`

They read alike and do opposite work. "Both entry points read the score from the
same report" is a virtue; it tells a later round nothing, because no round was
going to claim otherwise. "The drift bar cannot contradict the drift badge —
`schema-drift-table.ts:61` always seeds `ddl` and `distributed` is a primitive
boolean that is always serialized, so a backend match implies a `ddlTextDiffers`
match" is a **retired hypothesis**: it names the bug that was hunted and the fact
that kills it.

The cost of omitting them is paid in rounds. A plausible-but-wrong finding that
was investigated and dropped in round 1 is investigated again in round 2 by a
different reviewer, and the author answers it twice. Writing the negative down
once ends that loop; it is also the only artifact that distinguishes *checked and
clean* from *never looked at*, which is the distinction an approving verdict rests
on.

Entries come from the reviewers, not from you: a reviewer that dropped a candidate
returns it with the evidence, and consolidation collects them. A reviewer that
returns zero findings and zero cleared hypotheses has told you nothing about the
code, and should be asked once what it examined.

---

## Skill Learning Handoff

After findings are consolidated, decide whether any of them should re-train a
project-skill (see `rules/core/skill-lifecycle.mdc`). A review is the strongest
learning signal: a finding that a project-skill *should have prevented* means the
skill is stale or incomplete.

1. For each blocker/major finding, `keryx skills route <finding-file>` to
   see if a project-skill covers that module/entity.
2. If a covered skill exists and the finding reflects a rule the skill omits or
   contradicts — especially if the **same class of finding recurs** across files
   or across reviews — flag it for learning.
3. Do not mutate the skill yourself. Emit a `Skill Learning` block in the report
   and hand it to the caller (`job-orchestrator` / `flow-orchestrator`), which
   dispatches `skills learn` as a subagent (cheaper model if available):

```markdown
## Skill Learning
- `<module>/<skill>` ← F-012, F-019 (missing null-guard convention). Suggested:
  keryx skills learn --from-review <report-path> --skill <module>/<skill>
```

If no findings map to a project-skill, write `## Skill Learning\n- none`.
Never run `skills learn apply` from the reviewer — proposal review and apply are
the orchestrator's step.

---

## PR Review Report Publication

When the review target is a GitHub pull request, ask whether to publish the consolidated review report after the report is generated. A PR target is present when the user provided a PR URL/number, `gh pr view` resolves the current branch, or the caller passes `pr_number` / `pr_url`.

Ask before publishing unless `publish_pr_review_report` was explicitly set by automation settings:

```text
Publish this review report to the PR?

  A) Concise PR comment only
  B) Concise PR comment + detailed AI markdown artifact (recommended for follow-up fixes)
  C) Do not publish

> pick a letter (default: C)
```

**Automation values:**
- `publish_pr_review_report: comment` or legacy `true` -> publish the concise PR comment only.
- `publish_pr_review_report: comment-and-ai-artifact` -> publish the concise PR comment and generate the detailed AI markdown artifact.
- `publish_pr_review_report: none` or legacy `false` -> do not publish.

**Default:** do not publish without explicit confirmation. If no PR number can be resolved, skip publication and state that no PR target was available.

### Concise PR Comment

The visible PR comment is for humans. It must be written in English only and stay
concise, under the brevity rule above: **the summary is at most two sentences and
carries a link to the artifact holding the detail.**

The finding rows below are a bounded exception, not a licence: they exist because
a reviewer scanning a PR needs the blockers in front of them. Keep them to the
`blocker` and `major` rows; everything at `minor` or below goes behind the
`<details>` fold or, better, into the AI artifact and is linked. The full findings
set, the round history and the reasoning belong in the flow package — pasting them
here is the failure this rule names.

```markdown
## AI Review Report

**Verdict:** REQUEST_CHANGES
**Summary:** At most two sentences: the overall risk and the main merge blocker. Detail: <link to the AI artifact or the flow package>.

| Severity | Area | Finding | Suggested Fix | Owner |
|---|---|---|---|---|
| blocker | `src/file.ts:42` | What is broken and why it matters. | Concrete fix direction, not a vague instruction. | author |

<details>
<summary>Minor / info findings</summary>

| Severity | Area | Finding | Suggested Fix |
|---|---|---|---|
| minor | `src/other.ts:10` | ... | ... |

</details>

### Meta
| Field | Value |
|---|---|
| Orchestrator | `review-orchestrator` |
| Model | `<actual current model id/name, or unknown; never inherit or unsupported>` |
| Model strategy | `<ask | adaptive>` |
| Model assignment | `<per-reviewer tier/model from each dispatch's \`model\` block | unsupported>` |
| Agents run | `<reviewers actually dispatched, including fallback runtimes when used>` |
| Available reviewers | `<all reviewers considered by the orchestrator for this repository/runtime, grouped briefly as generic/convention/project/legacy when useful>` |
| Skipped reviewers | `<reviewers not dispatched with short reasons, e.g. no matching files, optional group not selected, unavailable native agent, PR number missing>` |
| Selection basis | `<auto-detected scope, explicit flags, user-selected optional groups, and why this reviewer set was chosen>` |
| Fallback/blocked reviewers | `<reviewers run via fallback or blocked because native agent/skill was unavailable, otherwise none>` |
| Scope | `<PR #N, base..head, merge-base>` |
| Commit | `<HEAD sha>` |
| Context | `<job/context path if provided, otherwise none>` |
| AI artifact | `<markdown link or file path to the detailed AI report when generated, otherwise none>` |
| AI artifact description | `<one concise human-readable sentence explaining that the linked markdown file contains detailed findings, fix guidance, patch guidance, regression coverage, validation plan, and follow-up agent context>` |
| Reviewed at | `<UTC timestamp>` |
```

### Detailed AI Markdown Artifact

When the user chooses option B, generate a separate English-only markdown artifact for AI follow-up work. Prefer a repository-local job/review path such as:

```text
jobs/reviews/pr-<number>/review-ai-report.md
```

If the review is running inside `job-orchestrator`, write it under the active job docs, for example:

```text
.metaproject/jobs/<job-name>/ai/review-ai-report.md
```

If the environment provides an external artifact mechanism, attach or upload that markdown file and put the link/path in the concise PR comment `AI artifact` meta row. If no attachment/upload mechanism exists, keep the file path in the comment and in `review_context.review_plan.publication_plan.ai_artifact_path`.

The concise PR comment must also include an `AI artifact description` meta row whenever an AI artifact is generated. The description is for human readers and must explain what was added and what the file contains, for example: `Detailed AI follow-up report with expanded findings, fix guidance, illustrative patch guidance, Gherkin regression coverage, validation plan, and context for follow-up agents.`

The AI artifact must use this structure:

```markdown
---
review_run_id: <stable id, e.g. pr-5462-2026-06-13T10-22-00Z>
orchestrator: review-orchestrator
verdict: <APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES>
context_mode: <none | light | full>
model_strategy: <ask | adaptive>
current_model: <actual current model id/name, or unknown>
model_assignment: <per-reviewer tier/model from each dispatch's `model` block | unsupported>
agents:
  - <reviewer>
scope:
  pr: <number or null>
  base: <base sha/ref>
  head: <head sha/ref>
  files_changed: <count>
generated_at: <UTC timestamp>
---

# AI Review Report

## Executive Summary
<Short machine-readable summary of merge risk and required fix order.>

## Review Context
<Bounded description of diff scope, requirements, omitted context, and assumptions.>

## Findings

### F-NNN: <title>

- Severity: blocker | major | minor | info
- Reviewer: <reviewer>
- File: `path/to/file.ts`
- Lines: <line or range>
- Confidence: high | medium | low
- Status: open

Problem:
<Detailed explanation of what is wrong.>

Why it matters:
<Correctness, safety, maintainability, performance, or UX impact.>

Evidence:
<Specific code references or behavior observed.>

Suggested fix:
<Detailed fix plan with steps.>

Patch guidance:
```diff
<Optional illustrative diff. Keep it minimal and clearly mark if illustrative.>
```

Regression coverage:
```gherkin
Feature: <feature or invariant>

  Scenario: <behavior that should not regress>
    Given <initial state>
    When <action>
    Then <expected result>
```

## Fix Order
1. <Blocker/major fix sequencing with dependencies.>

## Validation Plan
- <Commands or checks to run.>

## Notes For Follow-Up Agents
<Context needed by an implementer agent; no secrets, raw prompts, or unrelated local paths.>
```

Formatting rules for PR comments and AI artifacts:
- English only, regardless of chat language or reviewer output language.
- Keep the visible comment concise: max 10 blocker/major rows before `<details>`.
- Put minor/info findings under `<details>` unless there are no higher severity findings.
- Every blocker/major row must include a concrete suggested fix.
- Include enough metadata to reproduce the review, but do not include internal prompts, raw logs, secrets, or unrelated local paths.
- The PR comment metadata must distinguish `Agents run` from `Available reviewers` and `Skipped reviewers`; never use a single `Agents` row that hides skipped or unavailable reviewers.
- `Skipped reviewers` must include short reasons from `review_context.routing.reasons`, `review_context.review_plan.skipped`, and dispatch/runtime compatibility checks.
- If the list is long, keep `Agents run` complete and summarize `Available reviewers` / `Skipped reviewers` by group with counts plus notable names; put full details in the AI artifact when one is generated.
- When `comment-and-ai-artifact` is selected, the PR comment meta section must include both `AI artifact` and `AI artifact description`; do not rely on the link alone.
- In the metadata table, `Model` must be the actual model id/name. Put `unsupported`, `adaptive`, or `ask` under `Model strategy` / `Model assignment`, not under `Model`.
- If posting via CLI, write the body to a temp file and use `gh pr comment <pr-number> --body-file <file>`; never inline a large heredoc into shell history.

---

## Job Context Awareness

When dispatched by `job-orchestrator` or called with an explicit context path, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document **before** running scope detection.
Use it to understand:
- Intentionally chosen libraries and patterns (do not flag as issues)
- Architectural decisions already agreed upon
- Acceptance criteria to drive the Stage 1 spec compliance gate

If absent, proceed normally — context is optional and non-blocking.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "I'll just run all reviewers for safety" | Over-reviews waste time; auto-detect for relevant scope |
| "Spec compliance can wait until after quality review" | Stage 1 gate exists because unimplemented requirements invalidate quality work |
| "I'll deduplicate findings manually in my head" | Always normalize to [F-NNN] format before consolidation to avoid losing findings |
| "Minor findings from one reviewer cancel out the major from another" | Each finding stands independently; severity is per-finding, not averaged |
| "The reviewer's own severity table said blocker" | There are no reviewer tables. One rubric, in **Severity (canonical)** above; a reviewer that ships one is the defect this replaced |
| "It's a security/architecture finding, so it's a blocker" | Severity is the demonstrated outcome, not the domain that found it. `blocker` is exactly the four shapes |
| "It will definitely break something eventually, so blocker" | Name the trigger and the outcome. Named → `major`. Unnamed → `info`. "Eventually" is neither |
| "A strict re-read of the findings will sharpen them" | That pass existed and was removed: self-correction without new evidence measured 95.5 → 91.5 → 89.0 on GSM8K and 75.8 → 38.1 on CommonSenseQA. Run something instead |
| "Three reviewers agree, so the finding is verified" | Consensus is not evidence. 80+ agents unanimously endorsed a vulnerability that did not exist; one empirical test killed it |
| "The verifier suggested a higher severity, I'll apply it" | It cannot suggest one. A claim carrying a severity is discarded whole and the attempt is recorded |
| "This finding has no `verification`, so it can be dropped" | Absent means nobody checked. All 83 recorded findings are in that state; none of them is thereby wrong |
| "Precision went up after the verifier landed" | There is no precision baseline to have gone up from. State stage counts: dropped, refuted, retained |
| "I'll widen the blast radius, this change looks risky" | It is bounded because review quality decays with context: F1 0.65 at round 2 → 0.29 at round 10. Widening makes the later rounds worse, not safer |
| "The blast radius came back empty, so nothing can break" | Empty and unresolved are different facts. The graph indexes code — a Markdown or JSON change has no radius at all, and the record says which one you got |
| "The changed files are the same as last round, so scope B can be skipped on the final round" | The final round always recomputes. A fix landed in round 3 is the change; skipping means the certifying round checked the least |
| "This scope-B file has an obvious naming problem, I'll report it" | Rejected in code: a naming problem is `minor` at best, and the floor is `major`. The set is under regression check, not under review — raise it under scope A |
| "No flags means no reviewers" | No flags → run auto-detection; never produce an empty review |
| "User named a module so I'll use diff mode" | Named module/component/store → path mode; diff mode is only for branch changes |
| "Path mode should only show lines I'd flag in diff mode" | Path mode reviews the entire file — all findings apply, not just added lines |
