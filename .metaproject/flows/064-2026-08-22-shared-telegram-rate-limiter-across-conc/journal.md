# Flow Journal

- 2026-08-22T09:33:23.375Z - flow created
- 2026-08-22T09:34:34.055Z - frozen: 5 criteria; checksum recorded
- 2026-08-22T09:46:54.955Z - started
- 2026-08-22T09:47:00Z - flow branch `flow/064-shared-telegram-rate-limiter` created from `fix/telegram-rate-limit-backoff` (not `main`): that branch already carries the three cheap mitigations (typing 429 backoff, typing disabled in forum mode, 8s edit floor) plus the forum-topic-cache fix, both already deployed live to the helyx session. This flow's changes touch the same `channel/telegram.ts` / `utils/typing.ts` call sites, so building on top avoids a guaranteed later conflict. PR for this flow must merge into `fix/telegram-rate-limit-backoff`, not `main` — `fix/telegram-rate-limit-backoff` merges to `main` separately.
- 2026-08-22T09:49:35.899Z - task-done: T1: Collect remaining context
- 2026-08-22T10:03:39.047Z - task-done: T2: Implement per plan
- 2026-08-22T10:03:39.168Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-22T10:12:08.504Z - task-added: T5: Fix: acquireSendSlot() not deadline-bound in telegramRequest, breaks documented MAX_TOTAL_MS contract under sustained budget contention
- 2026-08-22T10:16:57.468Z - task-done: T5: Fix: acquireSendSlot() not deadline-bound in telegramRequest, breaks documented MAX_TOTAL_MS contract under sustained budget contention
- 2026-08-22T10:16:57.555Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-22T10:22:32.999Z - implemented: draft PR: https://github.com/MrCipherSmith/helyx/pull/115 (warning: PR is not a draft)
- 2026-08-22T10:22:50.574Z - ac-confirmed: AC1: channel/telegram.ts:58 telegramRequest() and utils/typing.ts:55 startTypingRaw() both call acquireSendSlot() before every network attempt (incl. 429/5xx retries) — confirmed by direct code read + 2 independent review passes.
- 2026-08-22T10:22:50.662Z - ac-confirmed: AC2: tests/unit/telegram-rate-budget.test.ts: 6 concurrent leaseBudget() calls against a real Postgres instance (pool max:2, tests/fixtures/test-db.ts), asserts sum(granted) <= configured capacity. Atomic UPDATE...FROM(SELECT...FOR UPDATE)...RETURNING confirmed race-safe by code-reviewer pass.
- 2026-08-22T10:22:50.754Z - ac-confirmed: AC4: createLocalAllowance's refreshNow() catches both a rejecting and a hanging DB lease call (withTimeout), always grants a small conservative fail-open allowance and logs a warning rather than blocking. tests/unit/telegram-rate-budget.test.ts cases (d) cover both failure modes.
- 2026-08-22T10:22:50.848Z - ac-confirmed: AC5: bun run typecheck: clean. bun test tests/unit/: 2476 pass, 2 fail (both pre-existing tts-external-boundary.test.ts env-dependent failures, unrelated, present on the base branch before this flow).
- 2026-08-22T10:22:54.266Z - completing
- 2026-08-22T10:22:55.844Z - completion-failed: acceptance-criteria: unconfirmed: AC3 | pull-request: PR checks not green
- 2026-08-22T10:23:20Z - PR #115 merged into fix/telegram-rate-limit-backoff (mergeCommit ce9b9ce, mergedAt 2026-08-22T10:22:17Z, confirmed via `gh pr view --json state,mergedAt,mergeCommit`) and `flow implemented --pr` recorded. Flow left `in-progress` deliberately, not stuck: two gates block `flow complete` and neither is a code defect —
  1. AC3 needs a real ~24h live observation window with multiple projects concurrently active, which cannot exist yet: the code is merged but not deployed to any project's live `channel.ts` session (dormant until a restart picks up this branch). Confirming AC3 now would be evidence-less.
  2. "PR checks not green" is `gh pr checks 115` reporting zero configured CI checks on this repo (no GitHub Actions workflow exists here) — the gate's "not green" reading of "no checks at all" rather than a real CI failure. `bun run typecheck` + `bun test tests/unit/` were run locally instead (AC5) as the de facto substitute; adding CI infrastructure is out of scope for this flow.
  Next resume step: deploy this branch to at least the `helyx` project session, observe `/tmp/channel-helyx.log` for a genuine multi-project-concurrent day (plan.md step 7), then `keryx flow ac confirm 064 AC3` with that evidence and retry `keryx flow complete 064`.
