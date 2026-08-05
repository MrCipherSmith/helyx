# Reviewer Operations — Specification

Version: 1.0.0

## 1. Identity

| Field | Value |
|---|---|
| Package | `reviewer-operations-2026-08-05` |
| Kind | `implementation-plan` over an existing module |
| Owner module | `services/reviewer-service.ts` |
| Also touches | `scripts/review.ts`, `scripts/supervisor.ts`, `bot/commands/reviewers.ts` |
| Runtime | Host — the reviewers spawn `codex` and reach provider endpoints from the host, not the container |

## 2. Storage structure

```text
logs/reviews/
  <YYYY-MM-DD>T<HH-MM-SS>-<branch-slug>/
    run.json          machine-readable record of the run
    report.md         rendering fed to `keryx memory ingest --from-review`
```

Directory is created on first run. It lives under `logs/` because that path is
already outside the image, already gitignored, and already carries data of the
same sensitivity.

## 3. `run.json` contract

```jsonc
{
  "version": 1,
  "startedAt": "2026-08-05T13:40:11.204Z",
  "finishedAt": "2026-08-05T13:48:52.881Z",
  "trigger": "manual" | "scheduled" | "command",
  "git": {
    "branch": "feat/x",
    "head": "<sha>",
    "mergeBase": "<sha>",
    "diffBytesSent": 84213,
    "diffTruncated": false
  },
  "prompt": "<the review request, verbatim>",
  "mode": "external" | "self",
  "reports": [
    {
      "reviewerId": "codex",
      "label": "Codex",
      "model": "gpt-5.6-sol",
      "ok": true,
      "truncated": false,
      "durationMs": 421003,
      "content": "<full report>",
      "error": null
    }
  ]
}
```

`version` is present from the first artifact so the reader never has to guess.
A schema file is not added: the shape is consumed only by this repository, and
`schemas/*.json` would be a contract with nobody.

## 4. `report.md` contract

```markdown
# Review — <branch> @ <short-sha>

Version: 1.0.0
Date: <ISO>
Trigger: <manual|scheduled|command>
Diff: <n> bytes<, truncated>

## <label> (<model>)

<content>

## <label> (<model>)

[unavailable] <error>
```

The `Version` line is the package standard's requirement and is the artifact
format's version, not the review's.

## 5. Module surface

### 5.1 `services/reviewer-service.ts`

```ts
export interface ReviewArtifact { dir: string; runJson: string; reportMd: string }

/** Writes both files. Returns their paths. Never throws into the caller's path. */
export async function persistReviewRun(
  result: ReviewRunResult,
  meta: { trigger: string; prompt: string; git: GitContext },
): Promise<ReviewArtifact | null>

/** Age/count pruning under logs/reviews. Keeps the newest run per branch. */
export async function pruneReviewArtifacts(
  opts?: { maxAgeDays?: number; maxRuns?: number },
): Promise<{ removed: number }>
```

`runReviewers` gains no new responsibility: the caller persists. That keeps the
engine testable without a filesystem.

### 5.2 `getReviewerStatuses` — third state

```ts
export interface ReviewerStatus {
  id: string;
  label: string;
  model: string;
  available: boolean;
  probed: boolean;   // NEW — false when no probe exists for this backend
  detail: string;
}
```

`probed: false` renders as `не проверялся` in `/reviewers` rather than a green
tick. R1's honesty requirement is this one field.

### 5.3 `scripts/review.ts`

Unchanged output contract — reports to stdout, bare `SELF` when all reviewers
are down. Adds: build `GitContext`, call `persistReviewRun`, print the artifact
directory on the last line as `artifact: <path>`, and call
`pruneReviewArtifacts`. A persistence failure prints a warning to stderr and
does not change the exit code — the review is the product, the artifact is a
by-product.

## 6. Loop 10 — reviewer availability

**File:** `scripts/supervisor.ts`, `checkReviewerHealth(sql)`, every 30 min,
offset 50 s.

```text
state         = last known {available, probed} per reviewer id, in memory
alert when    = a reviewer moves available -> unavailable
              | a probed balance crosses below BALANCE_FLOOR_USD (default 2.00)
re-arm when   = available again, or balance >= BALANCE_FLOOR_USD + 1.00
dedup key     = reviewer_down:<id>
```

Alert text names the reviewer, the model and the `detail` string the probe
returned, so `balance $0.31` reaches the operator verbatim.

The loop never runs a review. Probing costs one HTTP call and one `codex login
status`; reviewing costs ten minutes.

**Codex availability is not login state.** Measured 2026-08-05: `codex login
status` answered `Logged in using ChatGPT` while `codex exec` refused with a
usage-limit error valid for six days. The loop therefore combines the login
probe with the outcome of the last recorded run from R2's artifact:

```text
codex available = logged in AND last recorded run did not fail with a
                  quota/usage-limit error
detail          = "logged in" | "not logged in" | "quota exhausted until <date>"
```

A reviewer with no recorded run yet is `probed: false`, not `available: true`.

## 7. Scheduled review (R4)

**File:** `scripts/supervisor.ts`, `maybeRunScheduledReview(sql)`, every 15 min.

```text
if branch is not the default branch
and diff(merge-base..HEAD) hash != last reviewed hash
and that hash has been unchanged for >= 10 min
and no review is currently running
then run the pipeline with trigger="scheduled"
     post a summary + artifact path to the supervisor topic
     record the hash
```

The hash and the running flag live in `bot_config` under key
`review_state` — the supervisor restarts often enough that in-memory state
would re-review on every restart.

Concurrency: one review at a time, process-wide. A manual run while a scheduled
one is in flight is refused with a message naming the running artifact
directory, not queued.

## 8. Integration points

| Point | Contract |
|---|---|
| `CLAUDE.md` § Code Review with Reviewers | The `SELF` line and the per-reviewer `unavailable` line are unchanged; the doc gains the artifact path line |
| `/reviewers` | Renders `probed: false` as a distinct state |
| `keryx memory ingest --from-review` | Consumes `report.md`; ingestion stays a deliberate command, not part of the run |
| Supervisor alerts | Two new dedup keys, existing acknowledge window applies |
| `bot_config` | New key `review_state`; existing key `reviewers` untouched |

## 9. Acceptance criteria

| # | Criterion |
|---|---|
| A1 | A completed run leaves `run.json` and `report.md`; both parse; `run.json` has `version: 1` |
| A2 | A run in which every reviewer fails still writes an artifact, with `mode: "self"` |
| A3 | Persistence failure does not change `scripts/review.ts` exit code or stdout contract |
| A4 | `keryx memory ingest --from-review <report.md>` succeeds on a produced artifact |
| A5 | Pruning keeps the newest run per branch and respects both limits |
| A6 | A reviewer going down alerts once; staying down does not re-alert |
| A7 | A provider with no balance endpoint reports `probed: false` and is not counted available in the alert logic |
| A8 | A scheduled review does not start while another review runs |
| A9 | An unchanged branch produces no scheduled review |
| A10 | Whole suite green, `tsc --noEmit` clean |
