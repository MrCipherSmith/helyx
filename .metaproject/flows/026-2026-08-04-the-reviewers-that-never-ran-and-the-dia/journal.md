# Flow Journal

- 2026-08-04T23:08:08.621Z - flow created
- 2026-08-04T23:10:14.163Z - task-added: T5: share the auth-header rule; honour providers.auth_scheme in review calls
- 2026-08-04T23:10:14.247Z - task-added: T6: classifyCodexFailure: a usage error is not a spent quota
- 2026-08-04T23:10:14.335Z - task-added: T7: callCodexReview: codex exec, injectable spawn, real classification
- 2026-08-04T23:10:14.423Z - task-added: T8: callProviderReview: injectable fetch, budget for reasoning, truncation reported as truncation
- 2026-08-04T23:10:14.508Z - task-added: T9: buildReviewPrompt: the service attaches the bounded diff, not the caller
- 2026-08-04T23:10:14.594Z - task-added: T10: tests over both world-facing calls with fake fetch and fake spawn
- 2026-08-04T23:10:14.680Z - task-added: T11: full gate, then run the reviewers on PR 61 for real
- 2026-08-04T23:10:37.870Z - frozen: 9 criteria; checksum recorded
- 2026-08-04T23:10:37.956Z - started
- 2026-08-04T23:19:41.549Z - task-added: T12: classifier must subtract the prompt: codex echoes it back on stderr
- 2026-08-04T23:19:41.638Z - task-added: T13: review finding: reresolve carried the old session's tokens and lines
- 2026-08-04T23:25:45.262Z - task-added: T14: review timeout sized for a reasoning model, and a body read that cannot escape the guard
- 2026-08-04T23:34:30.866Z - task-added: T15: review findings: surrogate-safe diff cut, and a strip that cannot form a match across the seam
- 2026-08-05T00:01:22.133Z - task-added: T16: classify from the CLI's own error lines, not from whatever it printed while exploring
- 2026-08-05T00:01:22.220Z - task-added: T17: review findings: runSingleReviewer must attach the diff too; tail must notice a same-path replacement
- 2026-08-05T00:08:51.732Z - task-added: T18: review round 2: untracked files, codex timeout, argv byte bound, per-provider budget retry
- 2026-08-05T00:08:51.874Z - task-added: T19: review round 2: stale transcript must not block the tmux fallback; countLines off-by-one
- 2026-08-05T00:21:29.741Z - task-added: T20: review round 3: streaming decode, stale re-resolve, kill that cannot be waited on, per-reviewer budget, stats dedup
- 2026-08-05T00:25:13.030Z - task-done: T1: Collect remaining context
- 2026-08-05T00:25:13.119Z - task-done: T2: Implement per plan
- 2026-08-05T00:25:13.206Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-05T00:25:13.293Z - task-done: T5: share the auth-header rule; honour providers.auth_scheme in review calls
- 2026-08-05T00:25:13.380Z - task-done: T6: classifyCodexFailure: a usage error is not a spent quota
- 2026-08-05T00:25:13.470Z - task-done: T7: callCodexReview: codex exec, injectable spawn, real classification
- 2026-08-05T00:25:13.554Z - task-done: T8: callProviderReview: injectable fetch, budget for reasoning, truncation reported as truncation
- 2026-08-05T00:25:13.640Z - task-done: T9: buildReviewPrompt: the service attaches the bounded diff, not the caller
- 2026-08-05T00:25:13.727Z - task-done: T10: tests over both world-facing calls with fake fetch and fake spawn
- 2026-08-05T00:25:13.813Z - task-done: T11: full gate, then run the reviewers on PR 61 for real
- 2026-08-05T00:25:13.901Z - task-done: T12: classifier must subtract the prompt: codex echoes it back on stderr
- 2026-08-05T00:25:13.991Z - task-done: T13: review finding: reresolve carried the old session's tokens and lines
- 2026-08-05T00:25:14.079Z - task-done: T14: review timeout sized for a reasoning model, and a body read that cannot escape the guard
- 2026-08-05T00:25:14.166Z - task-done: T15: review findings: surrogate-safe diff cut, and a strip that cannot form a match across the seam
- 2026-08-05T00:25:14.251Z - task-done: T16: classify from the CLI's own error lines, not from whatever it printed while exploring
- 2026-08-05T00:25:14.339Z - task-done: T17: review findings: runSingleReviewer must attach the diff too; tail must notice a same-path replacement
- 2026-08-05T00:25:14.428Z - task-done: T18: review round 2: untracked files, codex timeout, argv byte bound, per-provider budget retry
- 2026-08-05T00:25:14.515Z - task-done: T19: review round 2: stale transcript must not block the tmux fallback; countLines off-by-one
- 2026-08-05T00:25:14.602Z - task-done: T20: review round 3: streaming decode, stale re-resolve, kill that cannot be waited on, per-reviewer budget, stats dedup
- 2026-08-05T00:25:33.241Z - ac-confirmed: AC1: codexArgv returns ['npx','@openai/codex','exec','-m',model,prompt]; tests/unit/reviewer-calls.test.ts asserts 'exec' present and '--no-interactive' absent, and callCodexReview's spawned argv is captured and checked
- 2026-08-05T00:25:33.329Z - ac-confirmed: AC2: classifyCodexFailure returns distinct cli-usage / model-unsupported / limit / auth / failed(exit N) / empty output; the two real CLI outputs observed in this flow are pinned verbatim in tests and asserted never to classify as a limit. Proven in production: run 2 reported model-unsupported where run 1 had wrongly said cli-usage
- 2026-08-05T00:25:33.415Z - ac-confirmed: AC3: REVIEW_MAX_TOKENS 32000 with a 4096 retry on a budget rejection; a faked 200 with finish_reason 'length' and empty content yields REVIEW_TRUNCATED, asserted not to be 'empty response'
- 2026-08-05T00:25:33.505Z - ac-confirmed: AC4: providerAuthHeaders extracted into provider-service.ts and used by both fetchProviderModels and callProviderReview; tests cover bearer and api_key on the helper and on the wire via the faked provider
- 2026-08-05T00:25:33.602Z - ac-confirmed: AC5: tests/unit/reviewer-run.test.ts drives runReviewers with a sentence and a fake diff against a real database and a faked provider, then asserts the request body carries both the sentence and the diff content
- 2026-08-05T00:25:33.691Z - ac-confirmed: AC6: buildReviewPrompt cuts to a byte budget and appends '[diff truncated at N bytes of M; ... the rest was not provided]'; tested over an oversized diff and over a cut landing inside a multi-byte character
- 2026-08-05T00:25:33.784Z - ac-confirmed: AC7: callCodexReview takes SpawnCodex, callProviderReview takes fetch and GetProvider, all defaulting to the real ones; the suite uses tests/fixtures/fake-fetch.ts and a fake spawn, and asserts blockedRequests() is unchanged across the provider block
- 2026-08-05T00:25:33.873Z - ac-confirmed: AC8: bun run typecheck clean; bun run lint 206 problems 0 errors, unchanged from the pre-flow baseline; bun test tests/unit/ 1349 pass 0 fail across 65 files, up from 1288 at the start of the flow
- 2026-08-05T00:25:33.964Z - ac-confirmed: AC9: Six real runs against PR 61. Run 1: codex cli-usage (honest), deepseek asked for the diff. Run 3: both ok=true, mode external. Runs 5 and 6 produced substantive reviews from both; every valid finding was fixed and the one architectural item (binding the transcript to a session id) is reported to the operator as an open decision

## Notes

### The reviewers reviewed their own repair

Six real runs, and each one moved the work. This is the record, because the
sequence is the argument for having independent reviewers at all:

| Run | Codex | DeepSeek |
|---|---|---|
| 1 | `cli-usage` — the honest version of a failure that had said "limit" for months | asked to be shown the diff, which is how the blind-review defect surfaced |
| 2 | `model-unsupported` | timed out: the 120s budget was sized for a model answering from a sentence |
| 3 | ok | ok — first time both produced a review |
| 4 | printed a menu, recorded as success | found `reresolve` carrying the previous session's counters |
| 5 | REQUEST_CHANGES, six findings, all valid | surrogate split on truncation; `runSingleReviewer` left blind |
| 6 | REQUEST_CHANGES, six more, all valid | trailing-slash basename; unbounded request |

Fifteen defects found by running the thing, of which four were mine from flow
025 and the rest were in the reviewer pipeline itself.

### Three ways the classifier read its own reflection

Worth writing down together, because each fix looked complete and was not:

1. `codex exec` echoes the prompt on stderr. The prompt is a diff of this
   module, so the classifier matched its own source. Fixed by subtracting the
   prompt.
2. Codex then *explored the repository* and printed file contents, including
   this module again. Subtracting the prompt did nothing for that. Fixed by
   short-circuiting on a successful run and reading only lines the CLI writes
   about itself.
3. A quoted `error:` line inside a diff hunk still starts with `+` or an
   indent, which is what makes rule 2 hold.

The general shape: a classifier that scans text supplied by the thing it is
classifying needs a reason to believe the text is the CLI's own.

### Measured rather than assumed

- `deepseek-v4-pro` spent 4,096 of 4,096 completion tokens on reasoning and
  returned nothing: `finish_reason: length`, `reasoning_tokens: 4096`.
- Inode reuse on this filesystem is immediate — a delete-and-recreate returns
  the same `st_ino` and an identical `st_ctime_ns`. Which is why the tail
  checks the byte before the offset instead of trusting either.
- `git diff <base>` never shows untracked files; verified that the new test
  suites were absent from every review until `untrackedDiff` was added.

### Left for the operator

Binding the transcript to a session identifier rather than to `cwd`. Raised in
two rounds, and correct: two Claude sessions in one repository share a `cwd`,
and the monitor takes the newest. The fix needs `--session-id` at launch, which
costs a restart of every session — the exact cost flow 025 was designed to
avoid. Reported rather than decided here.
- 2026-08-05T00:27:50.959Z - implemented: draft PR: https://github.com/MrCipherSmith/helyx/pull/61
- 2026-08-05T00:27:51.115Z - completing
- 2026-08-05T00:27:52.873Z - done: all gates passed
