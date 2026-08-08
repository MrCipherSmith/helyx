# Implementation Plan

Status: formalized

## Approach

Raise the ceiling rather than shorten the answer. The JSON summary is background
memory extraction (`memory/summarizer.ts` → `summarizeConversation`) — nobody is
watching a screen while it runs, so seconds are cheap there in a way they are not
on `/now`. Cutting `num_predict` instead would trade a slow summary for a
truncated one, and a truncated one fails `JSON.parse` and falls through to the
paid model, which is the exact outcome the change exists to prevent.

90s, not 60s. The worst case is a cold load (17.2s measured) plus prompt eval plus
`num_predict` 400 tokens at the slowest rate seen (9.3 tok/s ≈ 43s) — about 62s,
which 60s does not clear. The constants and that arithmetic go into a test, so the
next person to shave the number has to argue with the measurement.

## Steps

1. `SUMMARIZE_TIMEOUT_MS` and `SUMMARIZE_NUM_PREDICT` — exported constants in
   `claude/client.ts`, with the measurements in the docstring.
2. Use them in the Ollama branch of `summarizeConversation`.
3. `tests/unit/summarize-ceiling.test.ts` — the ceiling covers cold load plus a
   full generation at the floor rate, with the measured figures named.
4. `cli.ts`: the commented-out `SUMMARIZE_MODEL` suggestion becomes
   `geekom-model-1`; `qwen3:1.7b` is not installed and never was on this host.
5. Live confirmation from cold against `geekom-model-1` (AC5).

## Risks

- 90s is long enough that a wedged Ollama holds a summarizer slot for a minute
  and a half. Acceptable: the call is already `catch`-all and falls through, and
  the alternative — a cap the model cannot make — fails *every* time rather than
  rarely.
- The cold-start hole stays open for `/now` (6s) and the health digest (15s).
  Deliberate: both are latency-sensitive and a 17s load cannot be waited out
  there. Recorded as follow-up, not silently left.
