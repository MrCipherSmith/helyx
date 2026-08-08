# One Gemma: the summarizer timeout fits the bigger model

Status: formalized
Source: user description (operator, 2026-08-08)

## Problem

Two Gemmas are installed for two jobs: `geekom-model-1` (gemma4:e4b, 9.6 GB) for
chat and tools, `geekom-model-text` (gemma4:e2b, 7.2 GB) for summarization via
`SUMMARIZE_MODEL`. Both sat resident at once — 16 GB of the box's 27. The operator
asked whether the smaller one can go.

Measured against the three call sites that actually read `SUMMARIZE_MODEL`, warm:

| Call site | cap | e2b | e4b |
|---|---|---|---|
| `claude/client.ts` JSON summary, `num_predict` 400 | 30s | 17.2s ✓ | **35.2s ✗** |
| `scripts/supervisor.ts` health digest, `num_predict` 300 | 15s | 1.4s ✓ | 4.9s ✓ |
| `bot/commands/now.ts` session reading, no length cap | 6s | **18–26s ✗** | 2.6–3.7s ✓ |

So the smaller model is not simply the faster one. On `/now` it is the model that
*fails*: it ignores "answer in two lines" and generates 355–469 tokens, blowing a
6s cap every time — that path has been silently dead. e4b obeys the instruction in
25–37 tokens. On the health digest e4b is also the more useful of the two: it
reported the memory pressure and the load average that e2b skipped.

One thing blocks consolidation: the JSON summary's 30s cap, which e4b cannot make.
Cold is worse — a cold call aborted for *both* models, because loading e4b alone
takes 17.2s before a token is generated.

## Expected Outcome

`SUMMARIZE_MODEL` can point at `geekom-model-1` without any path silently giving
up. The JSON summary's ceiling covers a cold load plus a full-length generation at
the slowest rate measured, so the local summarizer is used instead of falling
through to the paid cloud model. The number is a named constant with the
measurement written down next to it, and a test holds the arithmetic.

## Out of Scope

- Switching `.env` and removing `gemma4:e2b` — host state, done after the merge
  once a live run confirms the new ceiling, not in this PR.
- The cold-start hole itself: the first call after an idle period spends 17s on
  the load, so `now.ts` (6s) and the health digest (15s) still cannot survive one.
  Raising *their* caps is a different trade — they are latency-sensitive and the
  JSON summary is not. Filed as follow-up.
- `num_predict` 400 → 250, the other way to fit inside 30s. Rejected: a truncated
  JSON summary is worse than a slow one, and `JSON.parse` failure falls through
  to the cloud model anyway.
