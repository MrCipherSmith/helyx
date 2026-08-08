# Flow Journal

- 2026-08-08T12:07:10.495Z - flow created
- 2026-08-08T12:10:33.754Z - frozen: 7 criteria; checksum recorded
- 2026-08-08T12:10:33.842Z - started
- 2026-08-08T12:10:33.927Z - task-done: T1: Collect remaining context
- 2026-08-08T12:10:34.016Z - task-done: T2: Implement per plan
- 2026-08-08T12:10:34.104Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-08T12:10:43.703Z - ac-confirmed: AC1: typecheck 0 errors; lint 0 errors
- 2026-08-08T12:10:43.792Z - ac-confirmed: AC2: tests/unit/summarize-ceiling.test.ts (5 tests); suite 2179 pass / 0 fail
- 2026-08-08T12:10:43.885Z - ac-confirmed: AC3: SUMMARIZE_TIMEOUT_MS / SUMMARIZE_NUM_PREDICT / SUMMARIZE_COLD_LOAD_MS / SUMMARIZE_SLOWEST_TOKENS_PER_SEC exported; docstring records 17.2s cold load and 9.3-12 tok/s
- 2026-08-08T12:10:43.973Z - ac-confirmed: AC4: worstCaseMs() = cold load + num_predict/floor rate; asserts ceiling > it, margin > 5s, and that 30s would have failed
- 2026-08-08T12:10:44.060Z - ac-confirmed: AC5: cold run via real summarizeConversation with SUMMARIZE_MODEL=geekom-model-1: 31638ms of 90000ms, summary string + 5 facts
- 2026-08-08T12:10:44.151Z - ac-confirmed: AC6: cli.ts commented default is now geekom-model-1, was qwen3:1.7b (never installed)
- 2026-08-08T12:10:44.242Z - ac-confirmed: AC7: the CONFIG.SUMMARIZE_MODEL guard and the cloud fallback below it are untouched
- 2026-08-08T12:11:30.993Z - implemented: draft PR: https://github.com/MrCipherSmith/helyx/pull/106 (warning: PR is not a draft)

## Review notes (PR #106 — Claude + DeepSeek)

Both reviewers reported. Claude found two blockers the flow had missed, and both
are fixed rather than deferred:

- **The PreCompact fold is raced against 15s** (`mcp/server.ts:424`) and reaches
  `summarizeConversation`. At 90s the race was decided in advance: every fold
  would log `timeout`, and an abandoned 90s request per chat per compaction would
  stack with nothing counting them. `summarizeConversation` takes a caller
  timeout now; the fold passes 4s and lets the cloud model answer inside its
  budget. `/summarize` — awaited under a "Summarizing…" message — keeps the old
  30s, since the raise was justified by "nobody is watching" and there somebody
  is. The first version of that docstring named only the caller that proved it.
- **The health analyst filed silence as health.** Same model, `num_predict` 300,
  15s cap, every 10 minutes against a 5-minute keep_alive — normally cold, and a
  cold load is 17.2s. It timed out on exactly the runs that had found something
  and wrote `process_health = 'ok'`. Now three states: `asked` distinguishes "no
  verdict" from "clean", surfacing as `'unknown'` and a warning line.

Test-shape findings, all applied: the arithmetic tests only compared constants to
each other, so reverting the call site to a literal 30_000 left them green — the
request body's `num_predict` and the caller's abort are now asserted against a
fake fetch. The `> 0` "not placeholders" test was vacuous (it passes for 1) and
is gone. The 5s headroom was arbitrary and survived `num_predict` 600; it is a
third of the worst case now, so raising the length has to raise the ceiling.

Smaller: the `cli.ts` hint's stated reason was wrong (`geekom-model-1` is as
host-local as `qwen3:1.7b` was — the real reason is that config.ts, .env.example
and the heavy preset already say it); the measurement now names the base model
`gemma4:e4b` rather than the repointable alias, which the CHANGELOG still
remembers as qwen3 14B; CHANGELOG entry added.

DeepSeek reported too — sound on the arithmetic, and its one substantive point
(a single env var serving both a 90s path and 6s/15s paths is a misconfiguration
trap) is the same tension the two fixes above address from the caller side.
Splitting `SUMMARIZE_MODEL` into fast and thorough slots is not done here.

### Left open, deliberately

- `/now` (6s) still cannot survive a cold load. Visible when it fails — the card
  loses two lines — and genuinely latency-bound, unlike the health digest.
- The cold-start hole itself: nothing keeps the model resident between calls.
  A `keep_alive` policy is the real fix and is its own change.
- 2026-08-08T12:23:57.918Z - task-done: T4: Self-review and prepare draft PR
